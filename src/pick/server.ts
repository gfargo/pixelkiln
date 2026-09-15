import { existsSync } from "node:fs"
import { readFile } from "node:fs/promises"
import { requireSelectCandidate, type Provider } from "../provider.ts"
import { saveLock, upsert } from "../lock.ts"
import { mediaTypeFromExtension } from "../media.ts"
import { resolveOutputPath } from "../outputs.ts"
import { pngSize } from "../pipeline/init.ts"
import { lockKey, primaryOutput, type LockEntry, type Lock, type ResolvedSpec } from "../types.ts"
import { renderSheet, type RenderSheetOptions, type SheetGroup } from "./sheet.ts"
import { serveReviewPage } from "./review-server.ts"

export interface PickResult {
  selected: number
  skipped: number
}

export interface ReviewReadyInfo {
  url: string
  keys: string[]
}

/**
 * Everything a review needs except the HTTP server: the candidate groups to
 * show, the local files the sheet may load, and the apply step. `runPicker`
 * wraps this in the one-shot review server; the gallery hosts the same sheet
 * inside its own long-lived server instead.
 */
export interface ReviewSession {
  groups: SheetGroup[]
  /** Exact local media routes the sheet references (revision sources). */
  assets: ReadonlyMap<string, { path: string; contentType: string }>
  /** Render the sheet, optionally addressed for an embedding host. */
  html(options?: RenderSheetOptions): string
  /**
   * Commit the posted selections through the provider and write the lockfile.
   * Selections are persisted before the caller responds, so a closed tab never
   * loses a choice. Throws (leaving the sheet free to retry) on a provider error.
   */
  apply(body: unknown, lockPath: string): Promise<PickResult>
}

export interface PrepareReviewOptions {
  onProgress?: (msg: string) => void
  /** Optional lock-key selection for a filtered or mixed-provider run. */
  keys?: Iterable<string>
  /** Resolved intent supplies immutable revision context for comparison. */
  specs?: ResolvedSpec[]
  /** Prefix for the sheet's local media routes when hosted under a sub-path. */
  routePrefix?: string
}

/**
 * The art a regeneration is about to replace, while it is still on disk.
 *
 * `submit` keeps the previous outputs as `supersededOutputs` until `fetch`
 * swaps the file, so during review the old bytes are still there. Showing
 * them beside the new candidates turns "is this good?" into "is this
 * better?", which is the question a regeneration actually asks.
 */
async function currentArt(
  entry: LockEntry,
  spec: ResolvedSpec | undefined,
): Promise<{ path: string; contentType: string; width: number; height: number } | null> {
  if (!spec || !entry.supersededOutputs?.length) return null
  const previous = primaryOutput({ ...entry, outputs: entry.supersededOutputs })
  if (!previous) return null
  const file = resolveOutputPath(previous.path, spec.root)
  if (!existsSync(file)) return null
  const contentType = previous.mediaType ?? mediaTypeFromExtension(file)
  if (!contentType) return null
  let width = entry.width
  let height = entry.height
  if (contentType === "image/png") {
    const size = pngSize(await readFile(file))
    if (size) ({ width, height } = size)
  }
  return { path: file, contentType, width, height }
}

/** Gather every entry in review for this provider. Null when nothing is waiting. */
export async function prepareReview(
  provider: Provider,
  lock: Lock,
  opts: PrepareReviewOptions = {},
): Promise<ReviewSession | null> {
  const log = opts.onProgress ?? (() => {})
  const selectedKeys = opts.keys ? new Set(opts.keys) : null
  const specByKey = new Map(
    (opts.specs ?? []).map((spec) => [lockKey(spec.styleId, spec.assetId), spec]),
  )
  const reviewAssets = new Map<string, { path: string; contentType: string }>()
  const prefix = opts.routePrefix ?? ""

  const groups: SheetGroup[] = []
  for (const [key, entry] of Object.entries(lock.entries)) {
    if (entry.provider !== provider.id || (selectedKeys && !selectedKeys.has(key))) continue
    if (entry.status !== "review" || !entry.reviewObjectId) continue
    try {
      const spec = specByKey.get(key)
      const state = await provider.poll(entry.reviewObjectId, entry.generator, { spec, metadata: entry.providerMetadata?.[provider.id] })
      if (
        (state.status !== "review" && state.status !== "review-set") ||
        (state.status === "review" ? !state.candidateUrls.length : !state.frameUrls.length)
      ) continue
      const frameUrls = state.status === "review" ? state.candidateUrls : state.frameUrls
      const sourceRoute = spec?.revision
        ? `${prefix}/revision-source/${encodeURIComponent(String(groups.length))}`
        : null
      if (sourceRoute && spec?.revision) {
        reviewAssets.set(sourceRoute, {
          path: spec.revision.sourceFile,
          contentType: spec.revision.sourceFormat === "jpeg" ? "image/jpeg" : "image/png",
        })
      }
      const current = await currentArt(entry, spec)
      const currentRoute = current
        ? `${prefix}/current-art/${encodeURIComponent(String(groups.length))}`
        : null
      if (current && currentRoute) {
        reviewAssets.set(currentRoute, { path: current.path, contentType: current.contentType })
      }
      groups.push({
        key,
        assetId: entry.assetId,
        styleId: entry.styleId,
        prompt: entry.prompt,
        reviewObjectId: entry.reviewObjectId,
        frameUrls,
        width: entry.width,
        height: entry.height,
        ...(state.status === "review-set"
          ? {
              mode: "frame-set" as const,
              frameLabels: state.sources.map((source, index) => source.role ?? `frame-${index}`),
              fps: state.fps,
            }
          : { mode: "candidates" as const }),
        ...(sourceRoute && spec?.revision && spec.revision.sourceWidth && spec.revision.sourceHeight
          ? {
              revision: {
                mode: spec.revision.mode,
                sourceAssetId: spec.revision.sourceAssetId,
                sourceUrl: sourceRoute,
                width: spec.revision.sourceWidth,
                height: spec.revision.sourceHeight,
              },
            }
          : {}),
        ...(current && currentRoute
          ? { current: { url: currentRoute, width: current.width, height: current.height } }
          : {}),
      })
    } catch (err) {
      log(`  could not load candidates for ${key}: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  if (groups.length === 0) return null

  const byKey = new Map(groups.map((g) => [g.key, g]))

  return {
    groups,
    assets: reviewAssets,
    html: (options) => renderSheet(groups, options),
    apply: async (body, lockPath) => {
      const { selections } = body as { selections: { key: string; index: number }[] }

      let selected = 0
      for (const { key, index } of selections) {
        const group = byKey.get(key)
        const entry = lock.entries[key]
        if (!group || !entry?.reviewObjectId) continue
        if (!Number.isInteger(index) || index < 0 || index >= group.frameUrls.length) continue

        if (group.mode === "frame-set") {
          const spec = specByKey.get(key)
          const state = await provider.poll(entry.reviewObjectId, entry.generator, { spec, metadata: entry.providerMetadata?.[provider.id] })
          if (state.status !== "review-set") {
            throw new Error(`Frame set ${key} is no longer ready for review`)
          }
          upsert(lock, key, {
            status: "selected",
            objectId: state.objectId,
            candidateIndex: null,
            sourceUrl: state.sources[0]?.url ?? null,
            sourceUrls: state.sources,
            provider: provider.id,
            providerMetadata: state.metadata
              ? {
                  ...entry.providerMetadata,
                  [provider.id]: {
                    ...entry.providerMetadata[provider.id],
                    ...state.metadata,
                  },
                }
              : entry.providerMetadata,
          })
          selected++
          log(`  accepted ${key} → ${state.sources.length} ordered frames`)
          continue
        }

        // Promote the chosen candidate; the review parent is removed upstream
        // once nothing is left in it.
        const { objectId, sourceUrl, metadata } = await requireSelectCandidate(provider)(
          entry.reviewObjectId,
          index,
          `asset:${entry.assetId}`,
          entry.generator,
        )

        upsert(lock, key, {
          status: "selected",
          objectId,
          candidateIndex: index,
          sourceUrl: sourceUrl ?? group.frameUrls[index] ?? null,
          sourceUrls: [],
          provider: provider.id,
          providerMetadata: metadata
            ? {
                ...entry.providerMetadata,
                [provider.id]: {
                  ...entry.providerMetadata[provider.id],
                  ...metadata,
                },
              }
            : entry.providerMetadata,
        })
        selected++
        log(`  picked  ${key} → candidate ${index + 1}`)
      }

      await saveLock(lockPath, lock)
      return { selected, skipped: groups.length - selected }
    },
  }
}

/**
 * Serves the contact sheet on localhost, waits for the selections to be
 * applied, then shuts down.
 *
 * Selections are committed through the provider (`select-frames` promotes the chosen
 * candidate to its own object and drops the rest) and written to the lockfile
 * before the browser gets its response, so a closed tab never loses a choice.
 */
export async function runPicker(
  provider: Provider,
  lock: Lock,
  lockPath: string,
  opts: {
    port?: number
    open?: boolean
    onProgress?: (msg: string) => void
    /** Optional lock-key selection for a filtered or mixed-provider run. */
    keys?: Iterable<string>
    /** Resolved intent supplies immutable revision context for comparison. */
    specs?: ResolvedSpec[]
    /** Receives the live URL as soon as the server listens. */
    onReady?: (info: ReviewReadyInfo) => void
  } = {},
): Promise<PickResult> {
  const log = opts.onProgress ?? (() => {})
  const session = await prepareReview(provider, lock, {
    onProgress: log,
    keys: opts.keys,
    specs: opts.specs,
  })
  if (!session) return { selected: 0, skipped: 0 }
  const groups = session.groups

  return serveReviewPage<PickResult>({
    html: session.html(),
    port: opts.port,
    open: opts.open,
    onProgress: log,
    assets: session.assets,
    onReady: (url) => {
      const info = { url, keys: groups.map((group) => group.key) }
      if (opts.onReady) {
        opts.onReady(info)
      } else {
        log(`\n  ${groups.length} asset(s) awaiting selection: ${url}`)
        log(`  (leave this running; it exits once you apply)\n`)
      }
    },
    handleApply: (body) => session.apply(body, lockPath),
  })
}
