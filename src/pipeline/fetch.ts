import { mkdir, writeFile } from "node:fs/promises"
import path from "node:path"
import type { Provider } from "../provider.ts"
import { sha256 } from "../hash.ts"
import { saveLock, upsert } from "../lock.ts"
import { lockKey, type Lock, type ResolvedSpec } from "../types.ts"

/** PNG magic number — guards against writing an error page as a .png. */
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

export interface FetchResult {
  downloaded: number
  skipped: number
  failed: number
}

/**
 * Downloads every selected object to its manifest-defined path and records the
 * file hash. The hash is what lets `plan` tell "untouched" from "edited by
 * hand" on later runs, so a manual retouch is never silently clobbered.
 */
export async function fetchAssets(
  provider: Provider,
  specs: ResolvedSpec[],
  lock: Lock,
  lockPath: string,
  opts: { onProgress?: (msg: string) => void; concurrency?: number } = {},
): Promise<FetchResult> {
  const log = opts.onProgress ?? (() => {})
  const result: FetchResult = { downloaded: 0, skipped: 0, failed: 0 }
  const specByKey = new Map(specs.map((s) => [lockKey(s.styleId, s.assetId), s]))

  // Downloads are independent and IO-bound, so they run concurrently. The
  // lockfile is still written after each one, keeping an interrupted run
  // recoverable.
  const pending = Object.entries(lock.entries).filter(([, e]) => e.status === "selected")
  const concurrency = Math.min(opts.concurrency ?? 8, Math.max(1, pending.length))
  let cursor = 0

  async function worker(): Promise<void> {
    for (;;) {
      const next = pending[cursor++]
      if (!next) return
      const [key, entry] = next

      const spec = specByKey.get(key)
      if (!spec) {
        // In the lockfile but no longer in the manifest — the asset was removed.
        log(`  skip    ${key} (not in current manifest)`)
        result.skipped++
        continue
      }
      if (!entry.sourceUrl) {
        upsert(lock, key, { status: "failed", error: "no source URL to download" })
        result.failed++
        continue
      }

      try {
        const buf = await provider.download(entry.sourceUrl)
        if (!buf.subarray(0, 8).equals(PNG_SIGNATURE)) {
          throw new Error(`response was not a PNG (${buf.length} bytes)`)
        }
        await mkdir(path.dirname(spec.outFile), { recursive: true })
        await writeFile(spec.outFile, buf)
        upsert(lock, key, {
          status: "downloaded",
          provider: provider.id,
          outputs: [{ path: spec.outFile, sha256: sha256(buf) }],
          downloadedAt: new Date().toISOString(),
        })
        result.downloaded++
        log(`  wrote   ${path.relative(process.cwd(), spec.outFile)}`)
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        upsert(lock, key, { status: "failed", error: `download failed: ${message}` })
        result.failed++
        log(`  FAILED  ${key}: ${message}`)
      }
      await saveLock(lockPath, lock)
    }
  }

  await Promise.all(Array.from({ length: concurrency }, worker))
  await saveLock(lockPath, lock)
  return result
}

/**
 * Applies the manifest's tags to each generated object upstream. Tagging is
 * free and synchronous, and it makes the account itself queryable — the thing
 * that was missing when 350 objects accumulated with no way to tell which 65
 * were the keepers.
 */
export async function pushTags(
  provider: Provider,
  specs: ResolvedSpec[],
  lock: Lock,
  opts: { onProgress?: (msg: string) => void } = {},
): Promise<number> {
  const log = opts.onProgress ?? (() => {})
  const specByKey = new Map(specs.map((s) => [lockKey(s.styleId, s.assetId), s]))
  let tagged = 0

  for (const [key, entry] of Object.entries(lock.entries)) {
    const spec = specByKey.get(key)
    if (!spec || !entry.objectId) continue
    if (!provider.setTags) return tagged // capability absent; nothing to do
    try {
      await provider.setTags(entry.objectId, spec.tags)
      tagged++
    } catch (err) {
      log(`  tag failed ${key}: ${err instanceof Error ? err.message : String(err)}`)
    }
  }
  return tagged
}
