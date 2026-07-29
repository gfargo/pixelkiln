import { readFile, writeFile, rename } from "node:fs/promises"
import { existsSync } from "node:fs"
import { parseLock, type Lock, type LockEntry } from "./types.ts"

/**
 * The lockfile is the record that maps a spec to the PixelLab object that
 * satisfies it and the file on disk that came from it. It is written after
 * every state transition — including immediately after submitting, before the
 * job is awaited — so an interrupted run never loses track of paid-for work.
 */
export async function loadLock(path: string): Promise<Lock> {
  if (!existsSync(path)) return { version: 2, entries: {} }
  try {
    return parseLock(JSON.parse(await readFile(path, "utf8")))
  } catch (err) {
    throw new Error(
      `Lockfile at ${path} is malformed:\n${err instanceof Error ? err.message : String(err)}`,
    )
  }
}

/** Atomic write — a crash mid-save must not leave a truncated lockfile. */
export async function saveLock(path: string, lock: Lock): Promise<void> {
  const sorted: Lock["entries"] = {}
  for (const key of Object.keys(lock.entries).sort()) {
    sorted[key] = lock.entries[key]!
  }
  const tmp = `${path}.tmp`
  await writeFile(tmp, JSON.stringify({ version: 2, entries: sorted }, null, 2) + "\n")
  await rename(tmp, path)
}

export function upsert(lock: Lock, key: string, patch: Partial<LockEntry>): LockEntry {
  const existing = lock.entries[key]
  const next = { ...existing, ...patch } as LockEntry
  lock.entries[key] = next
  return next
}

/** Total generations recorded as spent, so spend is reported rather than guessed. */
export function totalSpend(lock: Lock): number {
  return Object.values(lock.entries).reduce((sum, e) => sum + (e.cost ?? 0), 0)
}
