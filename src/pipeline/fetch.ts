import { existsSync } from "node:fs"
import { mkdir, rename, writeFile } from "node:fs/promises"
import path from "node:path"
import type { Provider } from "../provider.ts"
import { sha256, sha256File } from "../hash.ts"
import { saveLock, upsert } from "../lock.ts"
import { lockKey, type Lock, type LockOutput, type ResolvedSpec } from "../types.ts"

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
  opts: { onProgress?: (msg: string) => void; concurrency?: number; repair?: boolean } = {},
): Promise<FetchResult> {
  const log = opts.onProgress ?? (() => {})
  const result: FetchResult = { downloaded: 0, skipped: 0, failed: 0 }
  const specByKey = new Map(specs.map((s) => [lockKey(s.styleId, s.assetId), s]))

  // Downloads are independent and IO-bound, so they run concurrently. The
  // lockfile is still written after each one, keeping an interrupted run
  // recoverable.
  const pending = Object.entries(lock.entries).filter(([, e]) => {
    if (e.status === "selected" || e.status === "download-failed") return true
    if (!opts.repair || e.status !== "downloaded") return false
    return e.outputs.length === 0 || e.outputs.some((o) => !existsSync(o.path))
  })
  const concurrency = Math.min(Math.max(1, opts.concurrency ?? 8), Math.max(1, pending.length))
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
      if (entry.specHash !== spec.specHash) {
        log(`  skip    ${key} (source belongs to a stale spec)`)
        result.skipped++
        continue
      }
      const sources = entry.sourceUrls?.length
        ? entry.sourceUrls
        : entry.sourceUrl
          ? [{ url: entry.sourceUrl }]
          : []
      if (!sources.length) {
        upsert(lock, key, {
          status: "download-failed",
          error: "no persisted source URL to download; poll the job again if it still exists upstream",
        })
        result.failed++
        continue
      }

      const outputs: LockOutput[] = []
      try {
        for (let index = 0; index < sources.length; index++) {
          const source = sources[index]!
          const target = outputPath(spec, source.role, index, sources.length)
          const recorded = entry.outputs.find((o) =>
            source.role ? o.role === source.role : o.path === target || (!o.role && sources.length === 1),
          )

          if (existsSync(target)) {
            if (!recorded) {
              throw new Error(`refusing to overwrite untracked output ${target}`)
            }
            if ((await sha256File(target)) !== recorded.sha256) {
              throw new Error(`refusing to overwrite modified output ${target}`)
            }
            outputs.push(recorded)
            continue
          }

          const buf = await provider.download(source.url)
          if (!buf.subarray(0, 8).equals(PNG_SIGNATURE)) {
            throw new Error(`response for ${source.role ?? "asset"} was not a PNG (${buf.length} bytes)`)
          }
          await mkdir(path.dirname(target), { recursive: true })
          const tmp = `${target}.pixelkiln.tmp`
          await writeFile(tmp, buf)
          outputs.push({ path: target, sha256: sha256(buf), ...(source.role ? { role: source.role } : {}) })
          // Record the intended rename before performing it. If the process
          // dies in either half of this two-step commit, the next repair sees
          // a missing recorded output and safely downloads it again; it never
          // sees an untracked final file and gets stuck refusing to overwrite.
          upsert(lock, key, { outputs: mergeOutputs(entry.outputs, outputs) })
          await saveLock(lockPath, lock)
          await rename(tmp, target)
          log(`  wrote   ${path.relative(process.cwd(), target)}`)
        }
        upsert(lock, key, {
          status: "downloaded",
          provider: provider.id,
          outputs,
          downloadedAt: new Date().toISOString(),
          error: null,
        })
        result.downloaded++
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        upsert(lock, key, {
          status: "download-failed",
          outputs: mergeOutputs(entry.outputs, outputs),
          error: `download failed: ${message}`,
        })
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

/** A set declared as `terrain.png` becomes `terrain-tile-00.png`, etc. */
function outputPath(spec: ResolvedSpec, role: string | undefined, index: number, total: number): string {
  if (total === 1) return spec.outFile
  const originalExt = path.extname(spec.outFile)
  const ext = originalExt || ".png"
  const stem = originalExt ? spec.outFile.slice(0, -originalExt.length) : spec.outFile
  const safeRole = (role ?? `output-${String(index).padStart(2, "0")}`)
    .replace(/[^a-zA-Z0-9_-]+/g, "-")
  return `${stem}-${safeRole}${ext}`
}

function mergeOutputs(previous: LockOutput[], current: LockOutput[]): LockOutput[] {
  const merged = new Map<string, LockOutput>()
  for (const output of [...previous, ...current]) {
    merged.set(output.role ? `role:${output.role}` : `path:${output.path}`, output)
  }
  return [...merged.values()]
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
    // pixflux results are local files with a synthetic id, not account
    // objects — tagging one would 404.
    if (entry.generator === "pixflux") continue
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
