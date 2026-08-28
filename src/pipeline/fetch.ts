import { existsSync } from "node:fs"
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises"
import path from "node:path"
import type { Provider } from "../provider.ts"
import { sha256, sha256File } from "../hash.ts"
import { saveLock, upsert } from "../lock.ts"
import {
  expectedOutputPath,
  normalizeLockOutputPaths,
  portableOutputPath,
  resolveOutputPath,
} from "../outputs.ts"
import { lockKey, type Lock, type LockOutput, type ResolvedSpec } from "../types.ts"
import { decodePng } from "../png.ts"

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
 * hand" on later runs, so a manual retouch is never silently clobbered. The
 * same hash keys a local content cache, allowing `restore` to outlive a
 * provider's temporary storage URL.
 */
export async function fetchAssets(
  provider: Provider,
  specs: ResolvedSpec[],
  lock: Lock,
  lockPath: string,
  opts: {
    onProgress?: (msg: string) => void
    concurrency?: number
    repair?: boolean
    /** Content-addressed PNG cache. Defaults beside the lockfile; false disables it. */
    cacheDir?: string | false
  } = {},
): Promise<FetchResult> {
  const log = opts.onProgress ?? (() => {})
  const result: FetchResult = { downloaded: 0, skipped: 0, failed: 0 }
  const specByKey = new Map(specs.map((s) => [lockKey(s.styleId, s.assetId), s]))
  normalizeLockOutputPaths(lock, specs)
  const cacheDir =
    opts.cacheDir === false
      ? null
      : path.resolve(opts.cacheDir ?? path.join(path.dirname(lockPath), ".pixelkiln", "cache"))

  // Downloads are independent and IO-bound, so they run concurrently. The
  // lockfile is still written after each one, keeping an interrupted run
  // recoverable.
  const pending = Object.entries(lock.entries).filter(([key, e]) => {
    if (e.status === "selected" || e.status === "download-failed") return true
    if (!opts.repair || e.status !== "downloaded") return false
    const spec = specByKey.get(key)
    return e.outputs.length === 0 || !spec ||
      e.outputs.some((output) => !existsSync(resolveOutputPath(output.path, spec.root)))
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
          : opts.repair && entry.outputs.length
            ? entry.outputs.map((o) => ({ url: "", role: o.role }))
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
          const recorded = entry.outputs.find((o) =>
            source.role ? o.role === source.role : !o.role && sources.length === 1,
          )
          const target = recorded
            ? resolveOutputPath(recorded.path, spec.root)
            : expectedOutputPath(spec, source.role, index, sources.length)

          if (existsSync(target)) {
            if (!recorded) {
              throw new Error(`refusing to overwrite untracked output ${target}`)
            }
            if ((await sha256File(target)) !== recorded.sha256) {
              throw new Error(`refusing to overwrite modified output ${target}`)
            }
            if (cacheDir) await cachePng(cacheDir, await readFile(target), recorded.sha256)
            outputs.push({ ...recorded, path: portableOutputPath(target, spec.root) })
            continue
          }

          let buf = recorded && cacheDir ? await readCachedPng(cacheDir, recorded.sha256) : null
          if (buf) {
            log(`  cached  ${path.relative(process.cwd(), target)}`)
          } else {
            if (!source.url) {
              throw new Error(`no source URL or cached bytes remain for ${source.role ?? "asset"}`)
            }
            buf = await provider.download(source.url)
          }
          if (!buf.subarray(0, 8).equals(PNG_SIGNATURE)) {
            throw new Error(`response for ${source.role ?? "asset"} was not a PNG (${buf.length} bytes)`)
          }
          try {
            decodePng(buf)
          } catch (err) {
            throw new Error(
              `response for ${source.role ?? "asset"} was not a valid PNG: ` +
                `${err instanceof Error ? err.message : String(err)}`,
            )
          }
          if (cacheDir) await cachePng(cacheDir, buf)
          await mkdir(path.dirname(target), { recursive: true })
          const tmp = `${target}.pixelkiln.tmp`
          await writeFile(tmp, buf)
          outputs.push({
            path: portableOutputPath(target, spec.root),
            sha256: sha256(buf),
            ...(source.role ? { role: source.role } : {}),
          })
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
          // Inline providers can hand the pipeline a machine-local temp file.
          // Once its bytes are in the durable content cache, retaining that
          // path makes a committed lockfile non-portable and falsely suggests
          // the source still exists on another checkout.
          ...(cacheDir && sources.every((source) => source.url.startsWith("file://"))
            ? { sourceUrl: null, sourceUrls: [] }
            : {}),
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

async function readCachedPng(cacheDir: string, hash: string): Promise<Buffer | null> {
  const file = path.join(cacheDir, `${hash}.png`)
  if (!existsSync(file)) return null
  try {
    const buf = await readFile(file)
    if (!buf.subarray(0, 8).equals(PNG_SIGNATURE) || sha256(buf) !== hash) return null
    decodePng(buf)
    return buf
  } catch {
    return null
  }
}

async function cachePng(cacheDir: string, buf: Buffer, knownHash?: string): Promise<void> {
  const hash = knownHash ?? sha256(buf)
  const file = path.join(cacheDir, `${hash}.png`)
  if (await readCachedPng(cacheDir, hash)) return
  await mkdir(cacheDir, { recursive: true })
  const tmp = `${file}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`
  await writeFile(tmp, buf)
  try {
    await rename(tmp, file)
  } catch (err) {
    // Two workers can discover the same content concurrently. If the other
    // one won the rename race, the cache is already complete.
    if (!existsSync(file)) throw err
  } finally {
    await rm(tmp, { force: true })
  }
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
