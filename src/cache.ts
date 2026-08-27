import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises"
import { existsSync } from "node:fs"
import pathModule from "node:path"
import { z } from "zod"

export const HashCacheSchema = z.object({
  version: z.literal(1),
  /** objectId → sha256 of that object's image bytes. */
  hashes: z.record(z.string()),
})

export type HashCache = z.infer<typeof HashCacheSchema>
const SHA256_HEX = /^[a-f0-9]{64}$/

export function isSha256Hash(value: string): boolean {
  return SHA256_HEX.test(value)
}

/** Strict parser for diagnostics; ordinary cache loading remains self-healing. */
export function parseCache(value: unknown): HashCache {
  return HashCacheSchema.parse(value)
}

/**
 * Remembers the hash of every remote object already downloaded.
 *
 * `adopt` and `salvage` work by hashing image bytes, which means downloading
 * every object on the account on every run — measured at 363 downloads and
 * ~4.5s for one project, and it grows with the account rather than with the
 * work. Generated objects are immutable, so a hash only ever needs computing
 * once.
 *
 * Purely derived state: deleting the file costs one slow run and nothing else.
 * It belongs in .gitignore.
 */
export async function loadCache(path: string): Promise<HashCache> {
  if (!existsSync(path)) return { version: 1, hashes: {} }
  try {
    const parsed = HashCacheSchema.safeParse(JSON.parse(await readFile(path, "utf8")))
    if (!parsed.success) return { version: 1, hashes: {} }
    // Never trust malformed derived data during adoption. Dropping one cache
    // entry costs one download; trusting it can hide a real provenance match.
    return {
      version: 1,
      hashes: Object.fromEntries(
        Object.entries(parsed.data.hashes).filter(([, hash]) => isSha256Hash(hash)),
      ),
    }
  } catch {
    // A corrupt cache is not worth failing a run over — rebuild it.
    return { version: 1, hashes: {} }
  }
}

export async function saveCache(path: string, cache: HashCache): Promise<void> {
  const sorted: Record<string, string> = {}
  for (const key of Object.keys(cache.hashes).sort()) {
    const hash = cache.hashes[key]!
    if (!isSha256Hash(hash)) throw new Error(`Refusing to cache invalid SHA-256 for ${key}`)
    sorted[key] = hash
  }
  await mkdir(pathModule.dirname(pathModule.resolve(path)), { recursive: true })
  const tmp = `${path}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`
  try {
    await writeFile(tmp, JSON.stringify({ version: 1, hashes: sorted }, null, 2) + "\n")
    await rename(tmp, path)
  } finally {
    await rm(tmp, { force: true })
  }
}

/** Drop entries for objects that no longer exist, so the file cannot grow forever. */
export function pruneCache(cache: HashCache, liveIds: Set<string>): number {
  let removed = 0
  for (const id of Object.keys(cache.hashes)) {
    if (!liveIds.has(id)) {
      delete cache.hashes[id]
      removed++
    }
  }
  return removed
}

/**
 * A lockfile named exactly `*.lock.json` gets the conventional
 * `*.cache.json` sibling. Anything else — a custom `--lock` name, which
 * projects in this monorepo already use for variant lockfiles — falls back
 * to appending `.cache.json` to the whole path instead of returning it
 * unchanged. Returning the input unchanged here used to mean the cache,
 * which is a completely different schema, got written straight over the
 * real lockfile on the very first `adopt`.
 */
export function cachePathFor(lockPath: string): string {
  if (lockPath.endsWith(".lock.json")) return lockPath.replace(/\.lock\.json$/, ".cache.json")
  return `${lockPath}.cache.json`
}
