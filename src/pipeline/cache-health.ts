import { existsSync } from "node:fs"
import { readFile, readdir, rm } from "node:fs/promises"
import path from "node:path"
import {
  cachePathFor,
  isSha256Hash,
  parseCache,
  saveCache,
  type HashCache,
} from "../cache.ts"
import { sha256 } from "../hash.ts"
import type { Lock } from "../types.ts"

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

export interface ContentCacheIssue {
  name: string
  reason: string
}

export interface ContentCacheHealth {
  path: string
  exists: boolean
  files: number
  bytes: number
  valid: number
  referenced: number
  unreferenced: string[]
  missingReferenced: string[]
  invalid: ContentCacheIssue[]
}

export interface RemoteHashCacheHealth {
  path: string
  exists: boolean
  entries: number
  valid: number
  invalidIds: string[]
  error: string | null
}

export interface CacheHealthReport {
  safe: boolean
  content: ContentCacheHealth
  remoteHashes: RemoteHashCacheHealth
  removed: {
    contentFiles: number
    remoteHashEntries: number
    resetRemoteHashCache: boolean
  }
}

export interface CacheHealthOptions {
  /** Remove invalid and unreferenced content, plus invalid remote hash entries. */
  prune?: boolean
}

/**
 * Inspect both local caches without contacting the provider.
 *
 * Content PNGs are project-local and keyed by lockfile SHA, so orphaned bytes
 * can be removed safely. The object-hash cache is account-wide: this function
 * validates its schema and hashes but never removes an object merely because
 * the current project does not reference it. `adopt` owns that live-ID prune,
 * because only it has walked the complete provider account.
 */
export async function inspectCaches(
  lock: Lock,
  lockPath: string,
  options: CacheHealthOptions = {},
): Promise<CacheHealthReport> {
  if (options.prune && !existsSync(lockPath)) {
    throw new Error(`Refusing to prune without an existing lockfile at ${path.resolve(lockPath)}`)
  }
  const contentDir = path.resolve(path.dirname(lockPath), ".pixelkiln", "cache")
  const remotePath = path.resolve(cachePathFor(lockPath))
  const referenced = new Set(
    Object.values(lock.entries).flatMap((entry) => entry.outputs.map((output) => output.sha256)),
  )

  let content = await inspectContentCache(contentDir, referenced)
  let remoteHashes = await inspectRemoteHashCache(remotePath)
  const removed = { contentFiles: 0, remoteHashEntries: 0, resetRemoteHashCache: false }

  if (options.prune) {
    const names = new Set([
      ...content.unreferenced,
      ...content.invalid.map((issue) => issue.name),
    ])
    for (const name of names) {
      // Every name came directly from a non-recursive readdir of contentDir;
      // removing this explicit child cannot escape through path traversal.
      try {
        await rm(path.join(contentDir, name), { force: true })
        removed.contentFiles++
      } catch {
        // Directories and permission failures remain in the follow-up report.
      }
    }

    if (remoteHashes.error) {
      await saveCache(remotePath, { version: 1, hashes: {} })
      removed.resetRemoteHashCache = true
    } else if (remoteHashes.invalidIds.length) {
      const cache = parseCache(JSON.parse(await readFile(remotePath, "utf8")))
      for (const id of remoteHashes.invalidIds) delete cache.hashes[id]
      removed.remoteHashEntries = remoteHashes.invalidIds.length
      await saveCache(remotePath, cache)
    }

    content = await inspectContentCache(contentDir, referenced)
    remoteHashes = await inspectRemoteHashCache(remotePath)
  }

  return {
    safe: content.invalid.length === 0 && !remoteHashes.error && remoteHashes.invalidIds.length === 0,
    content,
    remoteHashes,
    removed,
  }
}

async function inspectContentCache(
  contentDir: string,
  referenced: Set<string>,
): Promise<ContentCacheHealth> {
  const report: ContentCacheHealth = {
    path: contentDir,
    exists: existsSync(contentDir),
    files: 0,
    bytes: 0,
    valid: 0,
    referenced: 0,
    unreferenced: [],
    missingReferenced: [],
    invalid: [],
  }
  if (!report.exists) {
    report.missingReferenced = [...referenced].sort()
    return report
  }

  const present = new Set<string>()
  const entries = await readdir(contentDir, { withFileTypes: true })
  for (const entry of entries) {
    if (!entry.isFile()) {
      report.invalid.push({ name: entry.name, reason: "not a regular file" })
      continue
    }
    report.files++
    const file = path.join(contentDir, entry.name)
    const expected = entry.name.endsWith(".png") ? entry.name.slice(0, -4) : ""
    let bytes: Buffer
    try {
      bytes = await readFile(file)
      report.bytes += bytes.length
    } catch (err) {
      report.invalid.push({
        name: entry.name,
        reason: `unreadable: ${err instanceof Error ? err.message : String(err)}`,
      })
      continue
    }
    if (!isSha256Hash(expected)) {
      report.invalid.push({ name: entry.name, reason: "filename is not <sha256>.png" })
      continue
    }
    if (!bytes.subarray(0, 8).equals(PNG_SIGNATURE)) {
      report.invalid.push({ name: entry.name, reason: "not a PNG" })
      continue
    }
    if (sha256(bytes) !== expected) {
      report.invalid.push({ name: entry.name, reason: "bytes do not match filename hash" })
      continue
    }
    present.add(expected)
    report.valid++
    if (referenced.has(expected)) report.referenced++
    else report.unreferenced.push(entry.name)
  }
  report.unreferenced.sort()
  report.missingReferenced = [...referenced].filter((hash) => !present.has(hash)).sort()
  return report
}

async function inspectRemoteHashCache(remotePath: string): Promise<RemoteHashCacheHealth> {
  const report: RemoteHashCacheHealth = {
    path: remotePath,
    exists: existsSync(remotePath),
    entries: 0,
    valid: 0,
    invalidIds: [],
    error: null,
  }
  if (!report.exists) return report
  let cache: HashCache
  try {
    cache = parseCache(JSON.parse(await readFile(remotePath, "utf8")))
  } catch (err) {
    report.error = err instanceof Error ? err.message : String(err)
    return report
  }
  report.entries = Object.keys(cache.hashes).length
  for (const [id, hash] of Object.entries(cache.hashes)) {
    if (isSha256Hash(hash)) report.valid++
    else report.invalidIds.push(id)
  }
  report.invalidIds.sort()
  return report
}
