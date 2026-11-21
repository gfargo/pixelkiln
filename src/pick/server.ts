import { existsSync } from "node:fs"
import { readFile } from "node:fs/promises"
import { requireSelectCandidate, type Provider } from "../provider.ts"
import { saveLock, upsert } from "../lock.ts"
import { detectMediaType, mediaTypeFromExtension } from "../media.ts"
import { resolveOutputPath } from "../outputs.ts"
import { pngSize } from "../pipeline/init.ts"
import { lockKey, primaryOutput, type LockEntry, type Lock, type ResolvedSpec } from "../types.ts"
import {
  cacheReviewCandidates,
  cachedCandidatePath,
  candidateCacheDirFor,
  ensureCandidatesCached,
  fullyCached,
  loadReviewState,
  reviewStatePathFor,
  updateReviewAsset,
  type ReviewAsset,
} from "./candidates.ts"
import type { JobState } from "../provider.ts"
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
  /**
   * Exact local media routes the sheet references: revision sources, the art
   * a regeneration replaces, and any frame or candidate the provider cached
   * on local disk.
   */
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
  /**
   * The lockfile the review belongs to. With it, every candidate is served
   * from the local candidate cache beside it, and a job the provider has
   * since dropped is still reviewable and appliable from that cache.
   */
  lockPath?: string
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

/**
 * The local file behind a provider's `file://` frame or candidate URL, or
 * null for a hosted one.
 *
 * A provider that decodes inline results to a local cache (PixelLab's
 * animate revisions, `imagePro`, `uiElement`) reports them as `file://`
 * URLs, which `fetch` reads straight from disk. A sheet served from
 * `http://127.0.0.1` is not allowed to load a `file://` image, so handing it
 * those URLs drew every frame broken; the sheet gets each file on its own
 * review route instead, the way it gets a revision source. The path is
 * everything after the scheme, unencoded, which is how the provider writes
 * the URL and how its own `download` reads it back.
 */
async function cachedFrame(url: string): Promise<{ path: string; contentType: string } | null> {
  if (!url.startsWith("file://")) return null
  const file = url.slice("file://".length)
  const contentType =
    mediaTypeFromExtension(file) ??
    detectMediaType(await readFile(file).catch(() => Buffer.alloc(0))) ??
    "application/octet-stream"
  return { path: file, contentType }
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
  // What the provider called each frame, by key. The sheet's `frameUrls` may
  // be review routes instead, and a route must never reach the lockfile.
  const providerUrls = new Map<string, string[]>()

  const store = opts.lockPath
    ? { cacheDir: candidateCacheDirFor(opts.lockPath), statePath: reviewStatePathFor(opts.lockPath) }
    : null
  const records = new Map<string, ReviewAsset>()

  const groups: SheetGroup[] = []
  for (const [key, entry] of Object.entries(lock.entries)) {
    if (entry.provider !== provider.id || (selectedKeys && !selectedKeys.has(key))) continue
    if (entry.status !== "review" || !entry.reviewObjectId) continue
    try {
      const spec = specByKey.get(key)
      const jobId = entry.reviewObjectId
      let polled: JobState | null = null
      let pollError: unknown = null
      try {
        polled = await provider.poll(jobId, entry.generator, { spec, metadata: entry.providerMetadata?.[provider.id] })
      } catch (err) {
        pollError = err
      }
      const live =
        polled &&
        ((polled.status === "review" && polled.candidateUrls.length) ||
          (polled.status === "review-set" && polled.frameUrls.length))
          ? (polled as Extract<JobState, { status: "review" | "review-set" }>)
          : null

      // The local copy of the candidates: refreshed from a live job, or the
      // only copy left once the provider has dropped it.
      let record: ReviewAsset | null = null
      if (store) {
        if (live) {
          const cached = await cacheReviewCandidates(provider, key, jobId, live, { ...store, generator: entry.generator })
          for (const message of cached.failed) log(`  could not cache ${message}`)
          record = cached.asset
        } else {
          const saved = (await loadReviewState(store.statePath)).assets[key]
          if (saved && saved.jobId === jobId && saved.provider === provider.id) {
            record = fullyCached(store.cacheDir, saved) ? saved : await ensureCandidatesCached(provider, key, store)
            const why = pollError instanceof Error ? pollError.message : polled ? `job is ${polled.status}` : String(pollError)
            log(`  ${key}: job no longer available upstream (${why}); using the cached candidates`)
          }
        }
      }
      if (!live && !record) {
        if (pollError) throw pollError
        continue
      }
      if (record) records.set(key, record)
      const urls = live
        ? live.status === "review" ? live.candidateUrls : live.frameUrls
        : record!.candidates.map((c) => c.sourceUrl ?? `file://${cachedCandidatePath(store!.cacheDir, c)}`)
      const frameUrls: string[] = []
      const frameAssets: [string, { path: string; contentType: string }][] = []
      const frameSizes: ({ width: number; height: number } | null)[] = []
      for (const [index, url] of urls.entries()) {
        const local = record?.candidates[index] && store ? cachedCandidatePath(store.cacheDir, record.candidates[index]!) : null
        const cached = local
          ? { path: local, contentType: record!.candidates[index]!.mediaType ?? "application/octet-stream" }
          : await cachedFrame(url)
        if (!cached) {
          frameUrls.push(url)
          frameSizes.push(null)
          continue
        }
        frameSizes.push(cached.contentType === "image/png" ? pngSize(await readFile(cached.path).catch(() => Buffer.alloc(0))) : null)
        const route = `${prefix}/review-frame/${encodeURIComponent(String(groups.length))}/${index}`
        frameAssets.push([route, cached])
        frameUrls.push(route)
      }
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
      for (const [route, asset] of frameAssets) reviewAssets.set(route, asset)
      providerUrls.set(key, urls)
      groups.push({
        key,
        assetId: entry.assetId,
        styleId: entry.styleId,
        prompt: entry.prompt,
        reviewObjectId: entry.reviewObjectId,
        frameUrls,
        ...(frameSizes.some(Boolean) ? { frameSizes } : {}),
        width: entry.width,
        height: entry.height,
        ...(live?.status === "review-set"
          ? {
              mode: "frame-set" as const,
              frameLabels: live.sources.map((source, index) => source.role ?? `frame-${index}`),
              fps: live.fps,
            }
          : !live && record?.mode === "frame-set"
          ? {
              mode: "frame-set" as const,
              frameLabels: record.candidates.map((c, index) => c.role ?? `frame-${index}`),
              fps: record.fps ?? 12,
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
        // A batch member's declared slot in the shared candidate set — the
        // leader's own slot 0 is already the sheet's ordinary default, so
        // only a member (whose slot is 1+) needs to say so explicitly.
        ...(entry.batch?.index != null ? { recommendedIndex: entry.batch.index } : {}),
      })
    } catch (err) {
      log(`  could not load candidates for ${key}: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  if (groups.length === 0) return null

  const byKey = new Map(groups.map((g) => [g.key, g]))

  /** `file://` URL of a cached candidate for this exact job, or null. */
  const localCandidate = (key: string, jobId: string, index: number): string | null => {
    const record = records.get(key)
    const candidate = record?.jobId === jobId ? record.candidates[index] : undefined
    const file = store && candidate ? cachedCandidatePath(store.cacheDir, candidate) : null
    return file ? `file://${file}` : null
  }
  /** A frame set rebuilt from the cache, when every frame is there. */
  const localFrameSet = (key: string, jobId: string) => {
    const record = records.get(key)
    if (!record || record.jobId !== jobId || record.mode !== "frame-set" || !store || !fullyCached(store.cacheDir, record)) return null
    const sources = record.candidates.map((c) => ({
      url: `file://${cachedCandidatePath(store.cacheDir, c)}`,
      ...(c.role ? { role: c.role } : {}),
    }))
    return {
      status: "review-set" as const,
      objectId: record.objectId ?? jobId,
      sources,
      metadata: undefined as Record<string, unknown> | undefined,
    }
  }
  const markApplied = async (key: string, index: number) => {
    if (!store || !records.has(key)) return
    await updateReviewAsset(store.statePath, key, (asset) => ({ ...asset, status: "applied", chosen: index }))
  }

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
          const live = await provider
            .poll(entry.reviewObjectId, entry.generator, { spec, metadata: entry.providerMetadata?.[provider.id] })
            .catch(() => null)
          const state = live?.status === "review-set" ? live : localFrameSet(key, entry.reviewObjectId)
          if (!state) {
            throw new Error(`Frame set ${key} is no longer ready for review and has no cached frames`)
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
          await markApplied(key, index)
          log(`  accepted ${key} → ${state.sources.length} ordered frames${live?.status === "review-set" ? "" : " (from the local cache)"}`)
          continue
        }

        // Promote the chosen candidate; the review parent is removed upstream
        // once nothing is left in it.
        let selection: { objectId: string; sourceUrl: string | null; metadata?: Record<string, unknown> }
        let fromCache = false
        try {
          selection = await requireSelectCandidate(provider)(
            entry.reviewObjectId,
            index,
            `asset:${entry.assetId}`,
            entry.generator,
          )
        } catch (err) {
          // The provider dropped the job. The candidate's bytes are in the
          // local cache, so the choice still lands; there is just no
          // promoted account object to name.
          const local = localCandidate(key, entry.reviewObjectId, index)
          if (!local) throw err
          log(`  ${key}: promotion failed upstream (${err instanceof Error ? err.message : String(err)}); using the cached candidate`)
          selection = { objectId: `${entry.reviewObjectId}#${index}`, sourceUrl: local }
          fromCache = true
        }
        const { objectId, metadata } = selection
        const sourceUrl = fromCache ? selection.sourceUrl : selection.sourceUrl ?? localCandidate(key, entry.reviewObjectId, index)

        upsert(lock, key, {
          status: "selected",
          objectId,
          candidateIndex: index,
          sourceUrl: sourceUrl ?? providerUrls.get(key)?.[index] ?? null,
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
        await markApplied(key, index)
        log(`  picked  ${key} → candidate ${index + 1}${fromCache ? " (from the local cache)" : ""}`)
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
    /**
     * Apply, as if `index: 0` were posted, every asset whose only option is
     * one candidate or one ordered frame set, and serve the page only for
     * the rest. `gen --yes` sets this so an unattended run cannot block.
     */
    autoAcceptSingle?: boolean
  } = {},
): Promise<PickResult> {
  const log = opts.onProgress ?? (() => {})
  let session = await prepareReview(provider, lock, {
    onProgress: log,
    keys: opts.keys,
    specs: opts.specs,
    lockPath,
  })
  if (!session) return { selected: 0, skipped: 0 }
  let autoSelected = 0
  if (opts.autoAcceptSingle) {
    const singles = session.groups.filter((g) => g.mode === "frame-set" || g.frameUrls.length === 1)
    if (singles.length) {
      const res = await session.apply({ selections: singles.map((g) => ({ key: g.key, index: 0 })) }, lockPath)
      autoSelected = res.selected
      log(`  --yes: accepted ${res.selected} single-candidate asset(s)`)
      const rest = session.groups.filter((g) => !singles.includes(g)).map((g) => g.key)
      session = rest.length
        ? await prepareReview(provider, lock, { onProgress: log, keys: rest, specs: opts.specs })
        : null
      if (!session) return { selected: autoSelected, skipped: 0 }
    }
  }
  const live = session
  const groups = live.groups

  const served = await serveReviewPage<PickResult>({
    html: live.html(),
    port: opts.port,
    open: opts.open,
    onProgress: log,
    assets: live.assets,
    onReady: (url) => {
      const info = { url, keys: groups.map((group) => group.key) }
      if (opts.onReady) {
        opts.onReady(info)
      } else {
        log(`\n  ${groups.length} asset(s) awaiting selection: ${url}`)
        log(`  (leave this running; it exits once you apply)\n`)
      }
    },
    handleApply: (body) => live.apply(body, lockPath),
  })
  return { selected: served.selected + autoSelected, skipped: served.skipped }
}
