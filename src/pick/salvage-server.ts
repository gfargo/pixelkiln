import { mkdir, writeFile, readFile } from "node:fs/promises"
import path from "node:path"
import type { Provider } from "../provider.ts"
import { sha256 } from "../hash.ts"
import { saveLock, upsert } from "../lock.ts"
import { lockKey, type Lock, type Manifest } from "../types.ts"
import {
  applyTags,
  idFromPrompt,
  SALVAGED_SPEC_HASH,
  type Orphan,
  type SalvageDecision,
} from "../pipeline/salvage.ts"
import { renderSalvageSheet } from "./salvage-sheet.ts"
import { serveReviewPage } from "./review-server.ts"

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

export interface SalvageResult {
  imported: number
  kept: number
  discarded: number
  failed: number
}

/**
 * Serves the triage sheet and applies decisions.
 *
 * `import` is the only action that touches local state: it downloads the image,
 * writes a manifest asset and a lock entry, so a recovered sprite becomes a
 * first-class tracked asset rather than a loose file. `keep` and `discard` only
 * write tags upstream — no object is ever deleted here.
 */
export async function runSalvage(
  provider: Provider,
  orphans: Orphan[],
  ctx: {
    manifestPath: string
    manifest: Manifest
    styleId: string
    importDir: string
    lock: Lock
    lockPath: string
  },
  opts: { port?: number; open?: boolean; onProgress?: (msg: string) => void } = {},
): Promise<SalvageResult> {
  const log = opts.onProgress ?? (() => {})
  const html = renderSalvageSheet(orphans, {
    styleId: ctx.styleId,
    importDir: path.relative(process.cwd(), ctx.importDir) || ".",
  })
  const byId = new Map(orphans.map((o) => [o.id, o]))
  const existingTags = new Map(orphans.map((o) => [o.id, o.tags]))

  return serveReviewPage<SalvageResult>({
    html,
    port: opts.port,
    open: opts.open,
    onProgress: log,
    onReady: (url) => {
      log(`\n  ${orphans.length} unclaimed object(s) to triage: ${url}`)
      log(`  (nothing is deleted here — discard only tags)\n`)
    },
    handleApply: async (body) => {
      const { decisions } = body as { decisions: SalvageDecision[] }

      const result: SalvageResult = { imported: 0, kept: 0, discarded: 0, failed: 0 }
      const taken = new Set(Object.keys(ctx.manifest.assets))
      const importedAssetIds: string[] = []

      for (const decision of decisions) {
        const orphan = byId.get(decision.id)
        if (!orphan) continue

        if (decision.action === "import") {
          try {
            const buf = await provider.download(orphan.previewUrl)
            if (!buf.subarray(0, 8).equals(PNG_SIGNATURE)) throw new Error("not a PNG")

            const assetId = idFromPrompt(orphan.prompt, taken)
            const rel = path.join("_salvaged", `${assetId}.png`)
            const outFile = path.resolve(ctx.importDir, rel)
            await mkdir(path.dirname(outFile), { recursive: true })
            await writeFile(outFile, buf)

            ctx.manifest.assets[assetId] = {
              prompt: orphan.prompt,
              promptByStyle: {},
              category: "_salvaged",
              file: rel,
              tags: ["salvaged"],
              styles: [ctx.styleId],
              ...(orphan.width === orphan.height
                ? { size: orphan.width }
                : { width: orphan.width, height: orphan.height }),
            }

            upsert(ctx.lock, lockKey(ctx.styleId, assetId), {
              styleId: ctx.styleId,
              assetId,
              specHash: SALVAGED_SPEC_HASH,
              generator: orphan.width === orphan.height ? "1dir" : "map",
              prompt: orphan.prompt,
              width: orphan.width,
              height: orphan.height,
              jobId: orphan.id,
              reviewObjectId: null,
              objectId: orphan.id,
              candidateIndex: null,
              status: "downloaded",
              error: null,
              sourceUrl: orphan.previewUrl,
              outputs: [{ path: outFile, sha256: sha256(buf) }],
              submittedAt: orphan.createdAt,
              downloadedAt: new Date().toISOString(),
              cost: 0, // already paid for, in an earlier period
              provider: provider.id,
            })
            importedAssetIds.push(assetId)
            result.imported++
            log(`  imported ${assetId} ← ${orphan.id}`)
          } catch (err) {
            result.failed++
            log(`  import failed ${orphan.id}: ${err instanceof Error ? err.message : String(err)}`)
          }
        } else if (decision.action === "keep") {
          result.kept++
        } else {
          result.discarded++
        }
      }

      await applyTags(provider, decisions, existingTags, { onProgress: log })

      // Persist the manifest additions and the lock together. Only the
      // newly imported entries are written back — re-merging the whole
      // in-memory manifest would overwrite every pre-existing asset with
      // its loadManifest()-normalized copy, turning a one-asset import
      // into a diff touching the entire file.
      const raw = JSON.parse(await readFile(ctx.manifestPath, "utf8")) as Manifest
      for (const id of importedAssetIds) raw.assets[id] = ctx.manifest.assets[id]!
      await writeFile(ctx.manifestPath, JSON.stringify(raw, null, 2) + "\n")
      await saveLock(ctx.lockPath, ctx.lock)

      return result
    },
  })
}
