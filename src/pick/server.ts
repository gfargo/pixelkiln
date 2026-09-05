import { requireSelectCandidate, type Provider } from "../provider.ts"
import { saveLock, upsert } from "../lock.ts"
import { lockKey, type Lock, type ResolvedSpec } from "../types.ts"
import { renderSheet, type SheetGroup } from "./sheet.ts"
import { serveReviewPage } from "./review-server.ts"

export interface PickResult {
  selected: number
  skipped: number
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
  } = {},
): Promise<PickResult> {
  const log = opts.onProgress ?? (() => {})
  const selectedKeys = opts.keys ? new Set(opts.keys) : null
  const specByKey = new Map(
    (opts.specs ?? []).map((spec) => [lockKey(spec.styleId, spec.assetId), spec]),
  )
  const reviewAssets = new Map<string, { path: string; contentType: string }>()

  const groups: SheetGroup[] = []
  for (const [key, entry] of Object.entries(lock.entries)) {
    if (entry.provider !== provider.id || (selectedKeys && !selectedKeys.has(key))) continue
    if (entry.status !== "review" || !entry.reviewObjectId) continue
    try {
      const spec = specByKey.get(key)
      const state = await provider.poll(entry.reviewObjectId, entry.generator, { spec })
      if (state.status !== "review" || !state.candidateUrls.length) continue
      const sourceRoute = spec?.revision
        ? `/revision-source/${encodeURIComponent(String(groups.length))}`
        : null
      if (sourceRoute && spec?.revision) {
        reviewAssets.set(sourceRoute, {
          path: spec.revision.sourceFile,
          contentType: spec.revision.sourceFormat === "jpeg" ? "image/jpeg" : "image/png",
        })
      }
      groups.push({
        key,
        assetId: entry.assetId,
        styleId: entry.styleId,
        prompt: entry.prompt,
        reviewObjectId: entry.reviewObjectId,
        frameUrls: state.candidateUrls,
        width: entry.width,
        height: entry.height,
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
      })
    } catch (err) {
      log(`  could not load candidates for ${key}: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  if (groups.length === 0) return { selected: 0, skipped: 0 }

  const html = renderSheet(groups)
  const byKey = new Map(groups.map((g) => [g.key, g]))

  return serveReviewPage<PickResult>({
    html,
    port: opts.port,
    open: opts.open,
    onProgress: log,
    assets: reviewAssets,
    onReady: (url) => {
      log(`\n  ${groups.length} asset(s) awaiting selection: ${url}`)
      log(`  (leave this running; it exits once you apply)\n`)
    },
    handleApply: async (body) => {
      const { selections } = body as { selections: { key: string; index: number }[] }

      let selected = 0
      for (const { key, index } of selections) {
        const group = byKey.get(key)
        const entry = lock.entries[key]
        if (!group || !entry?.reviewObjectId) continue
        if (!Number.isInteger(index) || index < 0 || index >= group.frameUrls.length) continue

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
  })
}
