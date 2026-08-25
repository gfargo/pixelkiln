import { DEFAULT_RATE_LIMIT, type Provider } from "../provider.ts"
import { saveLock, upsert } from "../lock.ts"
import { resolveStyleImages, type LoadedManifest } from "../manifest.ts"
import type { Lock, ResolvedSpec, ResolvedStyleImage } from "../types.ts"
import type { PlanItem } from "./plan.ts"

/**
 * Two distinct limits, easy to conflate:
 *   - submissions must be spaced apart (a rate, global across the account)
 *   - background jobs in flight        (a count)
 *
 * Both are the provider's own constraint (PixelLab: >2s apart; Tier 1=8,
 * Tier 2=10, Tier 3=20 in flight) surfaced through `provider.rateLimit()`,
 * not a number this pipeline layer should know on its own — a second
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
  /** Refuse to submit if the run would exceed this much, in the provider's unit. */
  budget?: number
  onProgress?: (msg: string) => void
}

export interface SubmitResult {
  submitted: number
  failed: number
  spent: number
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
  const log = opts.onProgress ?? (() => {})

  if (opts.budget != null) {
    const cost = items.reduce((s, i) => s + i.spec.cost, 0)
    if (cost > opts.budget) {
      throw new Error(
        `This run would spend ${cost} generations but the budget is ${opts.budget}. ` +
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
  const inFlight = new Map<string, ResolvedSpec["generator"]>()

  async function pruneInFlight(): Promise<void> {
    for (const [id, generator] of [...inFlight]) {
      try {
        const state = await provider.poll(id, generator)
        if (state.status !== "processing") inFlight.delete(id)
      } catch {
        // Treat an unreadable job as settled rather than blocking the queue
        // forever; `poll` will resolve its true state later.
        inFlight.delete(id)
      }
    }
  }

  async function waitForSlot(): Promise<void> {
    while (inFlight.size >= maxInFlight) {
      await sleep(IN_FLIGHT_POLL_MS)
      await pruneInFlight()
    }
  }

  for (const { spec, key } of items) {
    await waitForSlot()

    const since = Date.now() - lastSubmitAt
    if (since < spacing) await sleep(spacing - since)

    // Record intent before spending, so an interrupted run stays diagnosable.
    upsert(lock, key, {
      styleId: spec.styleId,
      assetId: spec.assetId,
      specHash: spec.specHash,
      generator: spec.generator,
      prompt: spec.prompt,
      width: spec.width,
      height: spec.height,
      status: "pending",
      jobId: null,
      objectId: null,
      reviewObjectId: null,
      candidateIndex: null,
      error: null,
      outputs: [],
      sourceUrl: null,
      submittedAt: new Date().toISOString(),
      cost: spec.cost,
      downloadedAt: null,
    })
    await saveLock(lockPath, lock)

    lastSubmitAt = Date.now()
    try {
      const refs =
        spec.generator === "1dir" || spec.generator === "tiles"
          ? (styleImages.get(spec.styleId) ?? [])
          : []
      const { jobId } = await provider.submit(spec, refs)
      upsert(lock, key, {
        jobId,
        // A multi-candidate generator routes through review; record the parent
        // so `pick` knows where to look.
        reviewObjectId: spec.candidates > 1 ? jobId : null,
        status: "processing",
        provider: provider.id,
      })
      inFlight.set(jobId, spec.generator)
      submitted++
      spent += spec.cost
      log(
        `  ${key} → ${jobId}  (${spec.width}x${spec.height}` +
          (spec.candidates > 1 ? `, ${spec.candidates} candidates` : "") +
          `, ${spec.cost})`,
      )
    } catch (err) {
      failed++
      const message = err instanceof Error ? err.message : String(err)
      // A rejected request is not billed, so cost is cleared rather than kept.
      upsert(lock, key, { status: "failed", error: message, cost: 0 })
      log(`  FAILED ${key}: ${message}`)
    }
    await saveLock(lockPath, lock)
  }

  return { submitted, failed, spent }
}
