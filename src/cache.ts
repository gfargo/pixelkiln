import { readFile, writeFile, rename } from "node:fs/promises"
import { existsSync } from "node:fs"
import { z } from "zod"

const CacheSchema = z.object({
  version: z.literal(1),
  /** objectId → sha256 of that object's image bytes. */
  hashes: z.record(z.string()),
})

export type HashCache = z.infer<typeof CacheSchema>

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
    const parsed = CacheSchema.safeParse(JSON.parse(await readFile(path, "utf8")))
    return parsed.success ? parsed.data : { version: 1, hashes: {} }
  } catch {
    // A corrupt cache is not worth failing a run over — rebuild it.
    return { version: 1, hashes: {} }
  }
}

export async function saveCache(path: string, cache: HashCache): Promise<void> {
  const sorted: Record<string, string> = {}
  for (const key of Object.keys(cache.hashes).sort()) sorted[key] = cache.hashes[key]!
  const tmp = `${path}.tmp`
  await writeFile(tmp, JSON.stringify({ version: 1, hashes: sorted }, null, 2) + "\n")
  await rename(tmp, path)
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

export function cachePathFor(lockPath: string): string {
  return lockPath.replace(/\.lock\.json$/, ".cache.json")
}
