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
import {
  cacheFileName,
  detectMediaType,
  MediaType,
  validateMedia,
  type MediaType as MediaKind,
} from "../media.ts"

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
    /** Content-addressed media cache. Defaults beside the lockfile; false disables it. */
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
            ? entry.outputs.map((o) => ({ url: "", role: o.role, mediaType: o.mediaType }))
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
            : expectedOutputPath(spec, source.role, index, sources.length, source.mediaType)

          if (existsSync(target)) {
            if (!recorded) {
              throw new Error(`refusing to overwrite untracked output ${target}`)
            }
            if ((await sha256File(target)) !== recorded.sha256) {
              throw new Error(`refusing to overwrite modified output ${target}`)
            }
            if (cacheDir) {
              await cacheMedia(
                cacheDir,
                await readFile(target),
                recorded.mediaType ?? MediaType.PNG,
                recorded.sha256,
              )
            }
            outputs.push({ ...recorded, path: portableOutputPath(target, spec.root) })
            continue
          }

          const expectedMediaType = source.mediaType ?? recorded?.mediaType ?? MediaType.PNG
          let buf = recorded && cacheDir
            ? await readCachedMedia(cacheDir, recorded.sha256, expectedMediaType)
            : null
          if (buf) {
            log(`  cached  ${path.relative(process.cwd(), target)}`)
          } else {
            if (!source.url) {
              throw new Error(`no source URL or cached bytes remain for ${source.role ?? "asset"}`)
            }
            buf = await provider.download(source.url)
          }
          let mediaType: MediaKind
          try {
            mediaType = validateMedia(buf, expectedMediaType)
          } catch (err) {
            const label = expectedMediaType === MediaType.GIF ? "GIF" : "PNG"
            const mismatch = detectMediaType(buf) !== expectedMediaType
            throw new Error(
              `response for ${source.role ?? "asset"} was not ${mismatch ? "a" : "a valid"} ${label}` +
                (mismatch ? ` (${buf.length} bytes)` : `: ${err instanceof Error ? err.message : String(err)}`),
            )
          }
          if (cacheDir) await cacheMedia(cacheDir, buf, mediaType)
          await mkdir(path.dirname(target), { recursive: true })
          const tmp = `${target}.pixelkiln.tmp`
          await writeFile(tmp, buf)
          outputs.push({
            path: portableOutputPath(target, spec.root),
            sha256: sha256(buf),
            ...(source.role ? { role: source.role } : {}),
            mediaType,
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

async function readCachedMedia(
  cacheDir: string,
  hash: string,
  mediaType: MediaKind,
): Promise<Buffer | null> {
  const file = path.join(cacheDir, cacheFileName(hash, mediaType))
  if (!existsSync(file)) return null
  try {
    const buf = await readFile(file)
    if (sha256(buf) !== hash) return null
    validateMedia(buf, mediaType)
    return buf
  } catch {
    return null
  }
}

async function cacheMedia(
  cacheDir: string,
  buf: Buffer,
  mediaType: MediaKind,
  knownHash?: string,
): Promise<void> {
  const hash = knownHash ?? sha256(buf)
  validateMedia(buf, mediaType)
  const file = path.join(cacheDir, cacheFileName(hash, mediaType))
  if (await readCachedMedia(cacheDir, hash, mediaType)) return
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
