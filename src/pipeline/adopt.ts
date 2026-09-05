import { existsSync } from "node:fs"
import { readFile, writeFile } from "node:fs/promises"
import path from "node:path"
import { requireList, validateCostEstimate, type Provider, type RemoteAsset } from "../provider.ts"
import { sha256 } from "../hash.ts"
import { loadCache, saveCache, pruneCache, cachePathFor, type HashCache } from "../cache.ts"
import { saveLock, upsert } from "../lock.ts"
import { portableOutputPath } from "../outputs.ts"
import { decodePng } from "../png.ts"
import { shouldPersistSourceUrl } from "../source-url.ts"
import { lockKey, type Lock, type ResolvedSpec } from "../types.ts"

export interface AdoptResult {
  scanned: number
  matched: number
  unmatchedLocal: string[]
  /** Objects on the account that correspond to no local file — safe to delete. */
  unmatchedRemote: RemoteAsset[]
  ambiguous: string[]
}

/**
 * Reconciles an account full of previously generated objects against the files
 * already committed in the repo, and writes the mapping into the lockfile.
 *
 * Matching is by exact SHA-256 of the image bytes. That was verified to hold:
 * a file downloaded from PixelLab storage is byte-identical to the copy sitting
 * in the repo, so a hash match is proof of provenance rather than a guess. No
 * fuzzy prompt matching is involved and nothing is regenerated.
 */
export async function adopt(
  provider: Provider,
  specs: ResolvedSpec[],
  lock: Lock,
  lockPath: string,
  opts: { onProgress?: (msg: string) => void; concurrency?: number; noCache?: boolean } = {},
): Promise<AdoptResult> {
  const log = opts.onProgress ?? (() => {})
  const concurrency = opts.concurrency ?? 8
  // Generated objects are immutable, so a hash computed once stays valid.
  const cachePath = cachePathFor(lockPath)
  const cache: HashCache = opts.noCache ? { version: 1, hashes: {} } : await loadCache(cachePath)
  let cacheHits = 0

  // 1. Hash every local file the manifest expects to exist.
  const localByHash = new Map<string, ResolvedSpec[]>()
  const unmatchedLocal: string[] = []
  for (const spec of specs) {
    if (!existsSync(spec.outFile)) {
      unmatchedLocal.push(`${spec.styleId}/${spec.assetId} (no file at ${spec.outFile})`)
      continue
    }
    const bytes = await readFile(spec.outFile)
    try {
      decodePng(bytes)
    } catch (err) {
      unmatchedLocal.push(
        `${spec.styleId}/${spec.assetId} (invalid PNG: ` +
          `${err instanceof Error ? err.message : String(err)})`,
      )
      continue
    }
    const hash = sha256(bytes)
    const bucket = localByHash.get(hash) ?? []
    bucket.push(spec)
    localByHash.set(hash, bucket)
  }
  log(`  hashed ${localByHash.size} distinct local image(s)`)

  // 2. Walk the account and hash every remote object's image.
  const remote: RemoteAsset[] = []
  for await (const obj of requireList(provider)()) remote.push(obj)
  log(`  found ${remote.length} object(s) on the account`)

  const matchedRemote = new Set<string>()
  const ambiguous: string[] = []
  let matched = 0
  let cursor = 0

  async function worker() {
    for (;;) {
      const obj = remote[cursor++]
      if (!obj) return
      const url = obj.previewUrl
      if (!url || obj.status !== "completed") continue

      let hash: string | undefined = cache.hashes[obj.id]
      if (hash) {
        cacheHits++
      } else {
        try {
          const bytes = await provider.download(url)
          decodePng(bytes)
          hash = sha256(bytes)
        } catch {
          continue
        }
        cache.hashes[obj.id] = hash
      }

      const hits = localByHash.get(hash)
      if (!hits?.length) continue

      matchedRemote.add(obj.id)
      for (const spec of hits) {
        const key = lockKey(spec.styleId, spec.assetId)
        const existing = lock.entries[key]
        if (existing?.objectId && existing.objectId !== obj.id) {
          // Two account objects produced identical bytes. Harmless, but the
          // first wins so re-running adopt stays deterministic.
          ambiguous.push(`${key}: already mapped to ${existing.objectId}, also matches ${obj.id}`)
          continue
        }
        const durableSource = shouldPersistSourceUrl(url) ? url : null
        upsert(lock, key, {
          styleId: spec.styleId,
          assetId: spec.assetId,
          // Deliberately the CURRENT spec hash: adoption declares "the file on
          // disk satisfies today's spec", so plan reports it as ok, not stale.
          specHash: spec.specHash,
          generator: spec.generator,
          prompt: obj.prompt || spec.prompt,
          width: obj.width,
          height: obj.height,
          jobId: obj.id,
          objectId: obj.id,
          reviewObjectId: null,
          candidateIndex: null,
          status: "downloaded",
          error: null,
          sourceUrl: durableSource,
          sourceUrls: durableSource ? [{ url: durableSource }] : [],
          outputs: [{ path: portableOutputPath(spec.outFile, spec.root), sha256: hash }],
          submittedAt: obj.createdAt,
          downloadedAt: new Date().toISOString(),
          cost: 0, // already paid for, in a previous billing period
          costUnit: validateCostEstimate(provider.id, provider.estimate(spec)).unit,
          provider: provider.id,
        })
        matched++
        log(`  adopted ${key} ← ${obj.id}`)
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, remote.length || 1) }, worker))
  await saveLock(lockPath, lock)

  if (!opts.noCache) {
    pruneCache(cache, new Set(remote.map((o) => o.id)))
    await saveCache(cachePath, cache)
    if (cacheHits) log(`  reused ${cacheHits} cached hash(es); downloaded ${remote.length - cacheHits}`)
  }

  return {
    scanned: remote.length,
    matched,
    unmatchedLocal,
    unmatchedRemote: remote.filter((o) => !matchedRemote.has(o.id)),
    ambiguous,
  }
}

/** Applies manifest tags to every adopted object so the account becomes filterable. */
export async function tagAdopted(
  provider: Provider,
  specs: ResolvedSpec[],
  lock: Lock,
  opts: { onProgress?: (msg: string) => void } = {},
): Promise<number> {
  const log = opts.onProgress ?? (() => {})
  const specByKey = new Map(specs.map((s) => [lockKey(s.styleId, s.assetId), s]))
  let count = 0
  for (const [key, entry] of Object.entries(lock.entries)) {
    const spec = specByKey.get(key)
    if (!spec || !entry.objectId) continue
    if (!provider.setTags) return count // capability absent
    try {
      await provider.setTags(entry.objectId, spec.tags)
      count++
    } catch (err) {
      log(`  tag failed ${key}: ${err instanceof Error ? err.message : String(err)}`)
    }
  }
  return count
}

/**
 * Backfills empty manifest prompts from the prompts recorded on adopted objects.
 *
 * For a project onboarded with `init`, this is how the manifest becomes real:
 * the prompts that actually produced the shipped art are recovered from the
 * account rather than reconstructed by guesswork. Only empty prompts are
 * touched, so hand-authored text is never overwritten.
 */
export async function writePromptsBack(
  manifestPath: string,
  lock: Lock,
  opts: {
    onProgress?: (msg: string) => void
    /** Restrict recovered prompts to lock entries from one provider. */
    provider?: string
    /** Restrict manifest writes and missing reports to these asset ids. */
    assetIds?: Iterable<string>
  } = {},
): Promise<{ filled: number; stillEmpty: string[] }> {
  const log = opts.onProgress ?? (() => {})
  const selectedAssets = opts.assetIds ? new Set(opts.assetIds) : null
  const raw = JSON.parse(await readFile(manifestPath, "utf8")) as {
    assets: Record<string, { prompt?: string }>
  }

  // An asset can be adopted under several styles; prefer the longest recovered
  // prompt, which is the most complete description of what was generated.
  const best = new Map<string, string>()
  for (const entry of Object.values(lock.entries)) {
    if (opts.provider && entry.provider !== opts.provider) continue
    if (selectedAssets && !selectedAssets.has(entry.assetId)) continue
    if (!entry.objectId || !entry.prompt) continue
    const current = best.get(entry.assetId)
    if (!current || entry.prompt.length > current.length) best.set(entry.assetId, entry.prompt)
  }

  let filled = 0
  const stillEmpty: string[] = []
  for (const [id, asset] of Object.entries(raw.assets)) {
    if (selectedAssets && !selectedAssets.has(id)) continue
    if (asset.prompt && asset.prompt.trim()) continue
    const recovered = best.get(id)
    if (recovered) {
      asset.prompt = recovered
      filled++
    } else {
      stillEmpty.push(id)
    }
  }

  await writeFile(manifestPath, JSON.stringify(raw, null, 2) + "\n")
  log(`  filled ${filled} prompt(s) from adopted objects`)
  return { filled, stillEmpty }
}

export function formatUnmatchedRemote(objects: RemoteAsset[], limit = 15): string {
  const lines = objects
    .slice(0, limit)
    .map((o) => `    ${o.id}  ${o.createdAt.slice(0, 10)}  ${(o.prompt || "").slice(0, 60)}`)
  if (objects.length > limit) lines.push(`    … and ${objects.length - limit} more`)
  return lines.join("\n")
}

export function relativeToCwd(p: string): string {
  return path.relative(process.cwd(), p) || p
}
