import { existsSync, readFileSync } from "node:fs"
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises"
import path from "node:path"
import type { Provider } from "../provider.ts"
import { sha256, sha256File } from "../hash.ts"
import { saveLock, upsert } from "../lock.ts"
import {
  expectedOutputPath,
  currentOutputPath,
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
import { shouldPersistSourceUrl } from "../source-url.ts"
import { applyPostprocess, postprocessCurrent, postprocessFor } from "./postprocess.ts"

export interface FetchResult {
  downloaded: number
  skipped: number
  failed: number
  /** `refresh` only: outputs re-downloaded and found byte-identical upstream. */
  unchanged?: number
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
    /** Replace an existing untracked or modified destination. Explicit ownership override. */
    force?: boolean
    /**
     * Re-download `downloaded` outputs from their durable provider reference
     * and replace the local file when the upstream bytes changed — an object
     * edited in the provider's own editor, say. Unchanged objects are left
     * alone; a locally modified file is still refused without `force`.
     */
    refresh?: boolean
    /** Content-addressed media cache. Defaults beside the lockfile; false disables it. */
    cacheDir?: string | false
  } = {},
): Promise<FetchResult> {
  const log = opts.onProgress ?? (() => {})
  const result: FetchResult = { downloaded: 0, skipped: 0, failed: 0, ...(opts.refresh ? { unchanged: 0 } : {}) }
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
    if (e.provider !== provider.id || !specByKey.has(key)) return false
    if (e.status === "selected" || e.status === "download-failed") return true
    if (e.status !== "downloaded") return false
    if (opts.refresh) return e.outputs.length > 0 && Boolean(e.sourceUrls?.length || e.sourceUrl)
    const spec = specByKey.get(key)
    // The manifest asks for different post-processing than the files got.
    // Re-applying it needs no provider, only the raw bytes, and replaces a
    // file PixelKiln wrote; a hand-changed one is left for --force.
    if (spec && e.specHash === spec.specHash && e.outputs.length && !postprocessCurrent(e, spec)) {
      return Boolean(opts.force) || e.outputs.every((output) => {
        const file = resolveOutputPath(output.path, spec.root)
        return existsSync(file) && sha256(readFileSync(file)) === output.sha256
      })
    }
    if (!opts.repair) return false
    if (e.outputs.length === 0 || !spec) return true
    return e.outputs.some((output) => {
      const file = resolveOutputPath(output.path, spec.root)
      if (!existsSync(file)) return true
      const current = sha256(readFileSync(file))
      if (current === output.sha256) return false
      // A file holding an outgoing generation's bytes (a revert in progress)
      // is PixelKiln's to replace; `restore --force` also puts the recorded
      // bytes back over a file that was changed after download.
      return Boolean(opts.force) || (e.supersededOutputs ?? []).some((old) => old.sha256 === current)
    })
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
      let wrote = false
      const wanted = postprocessFor(spec)
      const reapply = entry.status === "downloaded" && !postprocessCurrent(entry, spec)
      try {
        for (let index = 0; index < sources.length; index++) {
          const source = sources[index]!
          const recorded = entry.outputs.find((o) =>
            source.role ? o.role === source.role : !o.role && sources.length === 1,
          )
          const target = recorded
            ? resolveOutputPath(recorded.path, spec.root)
            : expectedOutputPath(spec, source.role, index, sources.length, source.mediaType)
          const expectedMediaType = source.mediaType ?? recorded?.mediaType ?? MediaType.PNG
          // The provider's bytes before post-processing; what a refresh
          // compares against and what a re-application starts from.
          const recordedRaw = recorded?.raw ?? recorded?.sha256

          // A refresh asks the provider first: only a changed object touches
          // disk, and the ownership rules below still apply to that write.
          let fresh: Buffer | null = null
          if (opts.refresh) {
            if (!source.url) throw new Error(`no durable source URL to refresh ${source.role ?? "asset"} from`)
            fresh = await provider.download(source.url)
            if (recorded && sha256(fresh) === recordedRaw && !reapply) {
              log(`  current ${path.relative(process.cwd(), target)}`)
              outputs.push({ ...recorded, path: portableOutputPath(target, spec.root) })
              continue
            }
          }

          // Raw bytes on hand without asking the provider: the file itself
          // when it holds the provider's bytes, or the cache.
          let raw: Buffer | null = null
          // Bytes already post-processed the way the record says, so they
          // are written as they are.
          let final: Buffer | null = null

          if (existsSync(target)) {
            const currentHash = await sha256File(target)
            if (recorded && currentHash === recorded.sha256) {
              if (!fresh && !reapply) {
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
              if (reapply && !fresh) {
                if (!recorded.raw) raw = await readFile(target)
                log(`  reapply ${path.relative(process.cwd(), target)}`)
              } else {
                // The local file is exactly what PixelKiln wrote; the object
                // changed upstream, so replacing it takes nothing from anyone.
                log(`  changed ${path.relative(process.cwd(), target)} (upstream)`)
              }
            } else {
              const superseded = (entry.supersededOutputs ?? []).find((output, oldIndex, all) =>
                currentOutputPath(output, spec, oldIndex, all.length) === target,
              )
              if (!opts.force) {
                if (superseded && currentHash === superseded.sha256) {
                  // A stale spec was intentionally regenerated, or an older
                  // generation is being brought back. The bytes on disk are
                  // still exactly the ones PixelKiln wrote, so replacing them
                  // does not take ownership of a manual edit.
                } else if (recorded || superseded) {
                  throw new Error(
                    `refusing to overwrite modified output ${target}; pass --force to replace it`,
                  )
                } else {
                  throw new Error(
                    `refusing to overwrite untracked output ${target}; pass --force to replace it`,
                  )
                }
              }
              log(
                `  replace ${path.relative(process.cwd(), target)}` +
                  (opts.force ? " (--force)" : " (previous tracked generation)"),
              )
            }
          }

          if (fresh) {
            raw = fresh
          } else if (!raw && recorded && cacheDir) {
            // The recorded output is the finished article; the raw bytes are
            // the way back to it when the manifest now asks for something else.
            if (!reapply) final = await readCachedMedia(cacheDir, recorded.sha256, expectedMediaType)
            if (!final && recordedRaw) raw = await readCachedMedia(cacheDir, recordedRaw, expectedMediaType)
            if (final || raw) log(`  cached  ${path.relative(process.cwd(), target)}`)
          }
          if (!final && !raw) {
            if (!source.url) {
              throw new Error(`no source URL or cached bytes remain for ${source.role ?? "asset"}`)
            }
            raw = await provider.download(source.url)
          }

          let mediaType: MediaKind
          const bytes = final ?? raw!
          try {
            mediaType = validateMedia(bytes, expectedMediaType)
          } catch (err) {
            const label = expectedMediaType === MediaType.GIF ? "GIF" : "PNG"
            const mismatch = detectMediaType(bytes) !== expectedMediaType
            throw new Error(
              `response for ${source.role ?? "asset"} was not ${mismatch ? "a" : "a valid"} ${label}` +
                (mismatch ? ` (${bytes.length} bytes)` : `: ${err instanceof Error ? err.message : String(err)}`),
            )
          }
          // Finished bytes from the cache keep the raw hash they were made from.
          let rawHash: string | undefined = final ? recorded?.raw : undefined
          let buf = bytes
          if (!final) {
            // The provider's bytes are cached under their own hash so the
            // post-processing can be undone or redone later without a download.
            if (cacheDir) await cacheMedia(cacheDir, raw!, mediaType)
            const processed = applyPostprocess(raw!, mediaType, wanted)
            buf = processed.bytes
            if (processed.changed) {
              rawHash = sha256(raw!)
              log(`  snapped ${path.relative(process.cwd(), target)} to ${wanted!.palette!.colors.length} colours`)
            }
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
            ...(rawHash ? { raw: rawHash } : {}),
          })
          // Record the intended rename before performing it. If the process
          // dies in either half of this two-step commit, the next repair sees
          // a missing recorded output and safely downloads it again; it never
          // sees an untracked final file and gets stuck refusing to overwrite.
          upsert(lock, key, { outputs: mergeOutputs(entry.outputs, outputs) })
          await saveLock(lockPath, lock)
          await rename(tmp, target)
          wrote = true
          log(`  wrote   ${path.relative(process.cwd(), target)}`)
        }
        if (opts.refresh && !wrote) {
          // Every object is still what the record says; there is nothing to
          // write and no reason to touch the entry's download time.
          result.unchanged = (result.unchanged ?? 0) + 1
          continue
        }
        const persistentSources = sources.filter((source) => shouldPersistSourceUrl(source.url))
        upsert(lock, key, {
          status: "downloaded",
          provider: provider.id,
          outputs,
          // A finished lock may be committed. Inline bytes, machine-local
          // paths, and credential-bearing signed URLs are useful while a
          // download is retryable but must not survive successful ingestion.
          sourceUrl: persistentSources[0]?.url ?? null,
          sourceUrls: persistentSources,
          downloadedAt: new Date().toISOString(),
          error: null,
          supersededOutputs: [],
          postprocess: wanted,
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
    if (!spec || entry.provider !== provider.id || !entry.objectId) continue
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
