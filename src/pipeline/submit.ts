import { BudgetError } from "../errors.ts"
import {
  DEFAULT_RATE_LIMIT,
  formatCost,
  validateCostEstimate,
  type CostUnit,
  type Provider,
} from "../provider.ts"
import { saveLock, upsert } from "../lock.ts"
import { resolveStyleImages, type LoadedManifest } from "../manifest.ts"
import { lockKey, type Lock, type ResolvedSpec, type ResolvedStyleImage } from "../types.ts"
import type { PlanItem } from "./plan.ts"
import { requireRevisionReady } from "./revision.ts"
import { historyAfterReplacing, historyLimit } from "./history.ts"
import { deriveMirror } from "./mirror.ts"

/**
 * Two distinct limits, easy to conflate:
 *   - submissions must be spaced apart (a rate, global across the account)
 *   - background jobs in flight        (a count)
 *
 * Both are the provider's own constraint (PixelLab: >2s apart; Tier 1=8,
 * Tier 2=10, Tier 3=20 in flight) surfaced through `provider.rateLimit()`,
 * not a number this pipeline layer should know on its own; a second
 * provider with different limits must not silently inherit PixelLab's.
 *
 * Submission is fast and job execution is slow, so the correct shape is a
 * serial submit loop with a global spacing gate, which pauses when too many
 * jobs are still running. Parallel workers each sleeping `spacing` would give a
 * global rate of workers/spacing and quietly breach the first limit.
 */
const IN_FLIGHT_POLL_MS = 5000

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

export interface SubmitOptions {
  maxInFlight?: number
  spacingMs?: number
  /** How often to re-check occupied background-job slots. */
  slotPollMs?: number
  /** Stop waiting for an unreadable/stuck slot instead of hanging forever. */
  slotTimeoutMs?: number
  /** Refuse to submit if the run would exceed this much, in the provider's unit. */
  budget?: number
  onProgress?: (msg: string) => void
}

export interface SubmitResult {
  submitted: number
  failed: number
  /** Successful-submission estimates in `unit`. */
  spent: number
  unit: CostUnit
}

export async function submit(
  provider: Provider,
  loaded: LoadedManifest,
  items: PlanItem[],
  lock: Lock,
  lockPath: string,
  opts: SubmitOptions = {},
): Promise<SubmitResult> {
  const limits = provider.rateLimit?.() ?? DEFAULT_RATE_LIMIT
  const maxInFlight = opts.maxInFlight ?? limits.maxInFlight
  const spacing = opts.spacingMs ?? limits.spacingMs
  const slotPollMs = opts.slotPollMs ?? IN_FLIGHT_POLL_MS
  const slotTimeoutMs = opts.slotTimeoutMs ?? 15 * 60 * 1000
  const log = opts.onProgress ?? (() => {})

  // A mirror is flipped locally; the provider never sees it and it costs
  // nothing, in whatever unit the rest of the batch is priced in.
  const estimates = new Map(items.map((item) => [
    item.key,
    item.spec.mirror
      ? { amount: 0, unit: item.spec.costUnit, candidates: 1 }
      : validateCostEstimate(provider.id, provider.estimate(item.spec)),
  ]))
  const units = new Set([...estimates.values()].map((estimate) => estimate.unit))
  if (units.size > 1) {
    throw new Error(`Provider "${provider.id}" returned mixed cost units for one submission batch`)
  }
  const unit = units.values().next().value ?? "free"

  if (opts.budget != null) {
    const cost = [...estimates.values()].reduce((sum, estimate) => sum + estimate.amount, 0)
    if (cost > opts.budget) {
      throw new BudgetError(
        `This run would spend ${formatCost(unit, cost)} but the budget is ` +
          `${formatCost(unit, opts.budget)}. ` +
          `Narrow it with --only/--style, or raise --budget.`,
      )
    }
  }

  const styleImages = new Map<string, ResolvedStyleImage[]>()
  for (const styleId of new Set(items.map((i) => i.spec.styleId))) {
    styleImages.set(styleId, await resolveStyleImages(loaded, styleId))
  }

  let submitted = 0
  let failed = 0
  let spent = 0
  let lastSubmitAt = 0

  /** Jobs submitted this run not yet observed as settled, with their generator. */
  const inFlight = new Map<string, ResolvedSpec>()
  let lastSlotError: string | null = null

  async function pruneInFlight(): Promise<void> {
    for (const [id, spec] of [...inFlight]) {
      try {
        const state = await provider.poll(id, spec.generator, { spec, tileFeature: spec.tileFeature })
        if (state.status !== "processing") inFlight.delete(id)
        lastSlotError = null
      } catch (err) {
        // A transient provider/network error is not evidence that a paid job
        // settled. Keep the slot occupied so we never exceed the upstream cap.
        lastSlotError = err instanceof Error ? err.message : String(err)
      }
    }
  }

  async function waitForSlot(): Promise<void> {
    const started = Date.now()
    while (inFlight.size >= maxInFlight) {
      if (Date.now() - started >= slotTimeoutMs) {
        throw new Error(
          `Timed out waiting for a generation slot` +
            (lastSlotError ? `; last poll error: ${lastSlotError}` : ""),
        )
      }
      await sleep(slotPollMs)
      await pruneInFlight()
    }
  }

  for (const { spec, key } of items) {
    const estimate = estimates.get(key)!
    if (spec.mirror) {
      try {
        await requireRevisionReady(spec, lock)
        await deriveMirror(spec, lock, lockPath, { onProgress: log })
        submitted++
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        failed++
        upsert(lock, key, {
          styleId: spec.styleId,
          assetId: spec.assetId,
          specHash: spec.specHash,
          generator: spec.generator,
          prompt: "",
          width: spec.width,
          height: spec.height,
          status: "failed",
          error: message,
          outputs: lock.entries[key]?.outputs ?? [],
          cost: 0,
          costUnit: spec.costUnit,
          provider: provider.id,
        })
        await saveLock(lockPath, lock)
        log(`  FAILED ${key}: ${message}`)
      }
      continue
    }
    await waitForSlot()

    const since = Date.now() - lastSubmitAt
    if (since < spacing) await sleep(spacing - since)

    // Planning already checked this dependency, but inputs can change while a
    // long batch waits for a provider slot. Recheck at the spending boundary.
    await requireRevisionReady(spec, lock)

    const previousEntry = lock.entries[key]
    const resumesCheckpoint = Boolean(
      previousEntry?.specHash === spec.specHash &&
      previousEntry.provider === provider.id &&
      previousEntry.generator === spec.generator &&
      previousEntry.submissionComplete === false &&
      previousEntry.jobId,
    )
    const previousJobId = resumesCheckpoint ? previousEntry!.jobId! : undefined
    const previousMetadata = resumesCheckpoint
      ? previousEntry!.providerMetadata[provider.id]
      : undefined
    const supersededOutputs = previousEntry?.outputs.length
      ? previousEntry.outputs
      : previousEntry?.supersededOutputs ?? []
    const submittedAt = resumesCheckpoint ? previousEntry!.submittedAt : new Date().toISOString()
    // The generation being replaced is kept, not forgotten, so it can come back.
    const history = historyAfterReplacing(previousEntry, historyLimit(loaded.manifest), submittedAt ?? new Date().toISOString())

    // Record intent before spending, so an interrupted run stays diagnosable.
    upsert(lock, key, {
      styleId: spec.styleId,
      assetId: spec.assetId,
      specHash: spec.specHash,
      generator: spec.generator,
      tileFeature: spec.tileFeature ?? null,
      prompt: spec.prompt,
      width: spec.width,
      height: spec.height,
      revision: spec.revision
        ? {
            mode: spec.revision.mode,
            sourceAssetId: spec.revision.sourceAssetId,
            sourceSha256: spec.revision.sourceSha256!,
            ...(spec.revision.maskSha256 ? { maskSha256: spec.revision.maskSha256 } : {}),
            ...(spec.revision.strength == null ? {} : { strength: spec.revision.strength }),
            ...(spec.revision.numColors == null ? {} : { numColors: spec.revision.numColors }),
            ...(spec.revision.paletteImageSha256 ? { paletteImageSha256: spec.revision.paletteImageSha256 } : {}),
            ...(spec.revision.dithering ? { dithering: spec.revision.dithering } : {}),
            ...(spec.revision.ditheringStrength == null ? {} : { ditheringStrength: spec.revision.ditheringStrength }),
            ...(spec.revision.frames == null ? {} : { frames: spec.revision.frames }),
            ...(spec.revision.fps == null ? {} : { fps: spec.revision.fps }),
            ...(spec.revision.lastFrameSha256 ? { lastFrameSha256: spec.revision.lastFrameSha256 } : {}),
            ...(spec.revision.direction ? { direction: spec.revision.direction } : {}),
            ...(spec.revision.enhancePrompt == null ? {} : { enhancePrompt: spec.revision.enhancePrompt }),
          }
        : null,
      status: "pending",
      jobId: previousJobId ?? null,
      ...(previousJobId ? { submissionComplete: false } : { submissionComplete: undefined }),
      objectId: null,
      reviewObjectId: null,
      candidateIndex: null,
      error: null,
      outputs: [],
      // Keep the old ownership proof while new bytes are pending. Fetch may
      // replace that file only while its hash still matches this record.
      supersededOutputs,
      providerMetadata: resumesCheckpoint ? previousEntry!.providerMetadata : {},
      sourceUrl: null,
      sourceUrls: [],
      submittedAt,
      history,
      cost: estimate.amount,
      costUnit: estimate.unit,
      // Persist routing before the request starts. If the process stops while
      // the provider is accepting work, a resumed run must not fall back to
      // PixelLab (the legacy lock default) for another provider's entry.
      provider: provider.id,
      downloadedAt: null,
    })
    await saveLock(lockPath, lock)

    lastSubmitAt = Date.now()
    try {
      // The adapter decides whether references are meaningful for this
      // generator. Keeping that policy here used to silently discard valid
      // references for non-PixelLab still providers.
      const refs = styleImages.get(spec.styleId) ?? []
      const parentSpec = spec.character?.parentSpec ?? spec.objectPro?.parentSpec
      const parentEntry = parentSpec ? lock.entries[lockKey(parentSpec.styleId, parentSpec.assetId)] : undefined
      const anchor = spec.character?.styleAnchor
      const anchorEntry = anchor ? lock.entries[lockKey(anchor.spec.styleId, anchor.spec.assetId)] : undefined
      const replacedMetadata = previousEntry?.providerMetadata?.[provider.id]
      const { jobId, metadata } = await provider.submit(spec, refs, {
        ...(previousJobId ? { previousJobId } : {}),
        ...(parentEntry?.objectId ? { parentObjectId: parentEntry.objectId } : {}),
        ...(anchorEntry?.objectId ? { styleObjectId: anchorEntry.objectId } : {}),
        ...(replacedMetadata ? { replacedMetadata } : {}),
        ...(previousMetadata ? { previousMetadata } : {}),
        checkpoint: async (checkpoint) => {
          if (!checkpoint.jobId) throw new Error("Provider checkpoint returned an empty job id")
          const entry = lock.entries[key]!
          upsert(lock, key, {
            jobId: checkpoint.jobId,
            submissionComplete: checkpoint.complete,
            reviewObjectId:
              checkpoint.complete &&
              (spec.generator === "frames" || (estimate.candidates > 1 && !spec.tileFeature))
                ? checkpoint.jobId
                : null,
            status: checkpoint.complete ? "processing" : "pending",
            error: null,
            providerMetadata: checkpoint.metadata
              ? {
                  ...entry.providerMetadata,
                  [provider.id]: {
                    ...entry.providerMetadata[provider.id],
                    ...checkpoint.metadata,
                  },
                }
              : entry.providerMetadata,
          })
          await saveLock(lockPath, lock)
        },
      })
      upsert(lock, key, {
        jobId,
        submissionComplete: true,
        // A multi-candidate generator routes through review; record the parent
        // so `pick` knows where to look.
        reviewObjectId:
          spec.generator === "frames" || (estimate.candidates > 1 && !spec.tileFeature)
            ? jobId
            : null,
        status: "processing",
        providerMetadata: metadata
          ? { ...lock.entries[key]!.providerMetadata, [provider.id]: metadata }
          : lock.entries[key]!.providerMetadata,
      })
      inFlight.set(jobId, spec)
      submitted++
      spent += estimate.amount
      log(
        `  ${key} → ${jobId}  (${spec.width}x${spec.height}` +
          (estimate.candidates > 1
            ? `, ${estimate.candidates} ${spec.tileFeature ? "outputs" : "candidates"}`
            : "") +
          `, ${estimate.amount})`,
      )
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      const entry = lock.entries[key]!
      if (entry.jobId && entry.submissionComplete === true) {
        // A completed checkpoint is authoritative even if the adapter is
        // interrupted before returning the same job id to this stack frame.
        upsert(lock, key, { status: "processing", error: null })
        inFlight.set(entry.jobId, spec)
        submitted++
        spent += estimate.amount
        log(`  ${key} → ${entry.jobId}  (recovered from completed checkpoint)`)
      } else {
        failed++
        // A request with no checkpoint was rejected before any remote identity
        // was accepted. Partial submissions keep their estimate and every id.
        upsert(lock, key, {
          status: "failed",
          error: message,
          cost: entry.jobId ? estimate.amount : 0,
        })
        log(`  FAILED ${key}: ${message}`)
      }
    }
    await saveLock(lockPath, lock)
  }

  return { submitted, failed, spent, unit }
}
