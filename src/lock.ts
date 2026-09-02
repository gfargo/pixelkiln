import { readFile, writeFile, rename, mkdir, rmdir, rm, stat } from "node:fs/promises"
import { existsSync } from "node:fs"
import path from "node:path"
import { parseLock, type Lock, type LockEntry } from "./types.ts"
import type { CostUnit } from "./provider.ts"

/**
 * The lockfile is the record that maps a spec to the PixelLab object that
 * satisfies it and the file on disk that came from it. It is written after
 * every state transition — including immediately after submitting, before the
 * job is awaited — so an interrupted run never loses track of paid-for work.
 */
export async function loadLock(lockPath: string): Promise<Lock> {
  if (!existsSync(lockPath)) return { version: 2, entries: {} }
  try {
    return parseLock(JSON.parse(await readFile(lockPath, "utf8")))
  } catch (err) {
    throw new Error(
      `Lockfile at ${lockPath} is malformed:\n${err instanceof Error ? err.message : String(err)}`,
    )
  }
}

/**
 * Serializes saves per path.
 *
 * Concurrent stages (parallel downloads in `fetch`) each save after their own
 * upsert. Without this they race on the shared `<path>.tmp`: one worker's
 * rename moves the file out from under another's, which fails with ENOENT and
 * loses that write. Queuing keeps the atomic write-then-rename intact and
 * guarantees the last save reflects the latest in-memory state.
 */
const saveQueues = new Map<string, Promise<void>>()
const dirtyPatches = new WeakMap<Lock, Map<string, Partial<LockEntry>>>()
const dirtyDeletes = new WeakMap<Lock, Set<string>>()

/** Atomic write — a crash mid-save must not leave a truncated lockfile. */
export function saveLock(lockPath: string, lock: Lock): Promise<void> {
  const queueKey = path.resolve(lockPath)
  const previous = saveQueues.get(queueKey) ?? Promise.resolve()
  const next = previous
    .catch(() => {}) // one failed save must not poison every later one
    .then(() => writeLockNow(lockPath, lock))
  saveQueues.set(queueKey, next)
  // Drop the queue entry once drained so long-lived processes don't retain it.
  const cleanup = () => {
    if (saveQueues.get(queueKey) === next) saveQueues.delete(queueKey)
  }
  // Using `finally()` here would create a second rejected promise when a save
  // fails. If nobody observes that derived promise Node reports an unhandled
  // rejection even when the caller correctly handles `next`.
  void next.then(cleanup, cleanup)
  return next
}

async function writeLockNow(lockPath: string, lock: Lock): Promise<void> {
  await mkdir(path.dirname(path.resolve(lockPath)), { recursive: true })
  const release = await acquireFileLock(lockPath)
  try {
    await writeLockWhileHeld(lockPath, lock)
  } finally {
    await release()
  }
}

async function writeLockWhileHeld(file: string, lock: Lock): Promise<void> {
  let disk: Lock = { version: 2, entries: {} }
  if (existsSync(file)) {
    try {
      disk = parseLock(JSON.parse(await readFile(file, "utf8")))
    } catch (err) {
      throw new Error(
        `Refusing to overwrite malformed lockfile at ${file}: ` +
          `${err instanceof Error ? err.message : String(err)}`,
      )
    }
  }

  const dirty = dirtyPatches.get(lock) ?? new Map<string, Partial<LockEntry>>()
  const snapshot = new Map<string, Partial<LockEntry>>()
  for (const [key, patch] of dirty) snapshot.set(key, { ...patch })

  const merged: Lock["entries"] = { ...disk.entries }
  for (const [key, patch] of snapshot) {
    const local = lock.entries[key]
    if (!local) continue
    merged[key] = merged[key] ? ({ ...merged[key], ...patch } as LockEntry) : local
  }
  // Preserve entries inserted directly by library callers. Production code
  // uses `upsert`, which additionally gives us field-level merge precision.
  for (const [key, entry] of Object.entries(lock.entries)) {
    if (!merged[key]) merged[key] = entry
  }

  // Removals are intents, recorded by `remove`, and are applied last. Merging
  // starts from the disk view so a concurrent writer's entries survive, which
  // means a key deleted only from `lock.entries` is read straight back off
  // disk and silently resurrected. Applying deletions after both merge passes
  // is what makes a removal actually stick.
  const deletes = dirtyDeletes.get(lock)
  const deleteSnapshot = deletes ? new Set(deletes) : new Set<string>()
  for (const key of deleteSnapshot) delete merged[key]

  const sorted: Lock["entries"] = {}
  for (const key of Object.keys(merged).sort()) {
    sorted[key] = merged[key]!
  }
  const tmp = `${file}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`
  try {
    await writeFile(tmp, JSON.stringify({ version: 2, entries: sorted }, null, 2) + "\n")
    await rename(tmp, file)
  } finally {
    await rm(tmp, { force: true })
  }

  // Clear only fields included in this snapshot. Mutations made while the
  // write awaited I/O remain dirty and are reapplied to the merged disk view.
  const currentDirty = dirtyPatches.get(lock)
  if (currentDirty) {
    for (const [key, patch] of snapshot) {
      const current = currentDirty.get(key)
      if (!current) continue
      for (const [field, value] of Object.entries(patch)) {
        if (Object.is(current[field as keyof LockEntry], value)) {
          delete current[field as keyof LockEntry]
        }
      }
      if (Object.keys(current).length === 0) currentDirty.delete(key)
    }
  }

  const stillDirty = dirtyDeletes.get(lock)
  if (stillDirty) {
    for (const key of deleteSnapshot) stillDirty.delete(key)
    if (stillDirty.size === 0) dirtyDeletes.delete(lock)
  }

  const localAfterWrite = lock.entries
  lock.entries = { ...merged }
  for (const [key, patch] of currentDirty ?? []) {
    const base = lock.entries[key] ?? localAfterWrite[key]
    if (base) lock.entries[key] = { ...base, ...patch } as LockEntry
  }
}

export function upsert(lock: Lock, key: string, patch: Partial<LockEntry>): LockEntry {
  // Re-adding a key cancels any pending removal, or the save would delete the
  // entry that was just written.
  dirtyDeletes.get(lock)?.delete(key)
  const existing = lock.entries[key]
  const next = { ...existing, ...patch } as LockEntry
  lock.entries[key] = next
  let dirty = dirtyPatches.get(lock)
  if (!dirty) {
    dirty = new Map()
    dirtyPatches.set(lock, dirty)
  }
  dirty.set(key, { ...(dirty.get(key) ?? {}), ...patch })
  return next
}

/**
 * Drop a lock entry, and record the removal so the next save honours it.
 *
 * Deleting from `lock.entries` alone does nothing: `writeLockWhileHeld` merges
 * onto whatever is on disk, so the entry is read back and restored. Callers
 * that need an entry gone must come through here. Returns false when the key
 * was not present, so a caller can tell a no-op from a removal.
 */
export function remove(lock: Lock, key: string): boolean {
  if (!lock.entries[key]) return false
  delete lock.entries[key]
  const patches = dirtyPatches.get(lock)
  if (patches) {
    patches.delete(key)
    if (patches.size === 0) dirtyPatches.delete(lock)
  }
  let deletes = dirtyDeletes.get(lock)
  if (!deletes) {
    deletes = new Set()
    dirtyDeletes.set(lock, deletes)
  }
  deletes.add(key)
  return true
}

const FILE_LOCK_TIMEOUT_MS = 10_000
const STALE_FILE_LOCK_MS = 2 * 60 * 1000

async function acquireFileLock(file: string): Promise<() => Promise<void>> {
  const lockDir = `${file}.lock`
  const deadline = Date.now() + FILE_LOCK_TIMEOUT_MS
  for (;;) {
    try {
      await mkdir(lockDir)
      return async () => {
        await rmdir(lockDir).catch(() => {})
      }
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code
      if (code !== "EEXIST") throw err
      try {
        const age = Date.now() - (await stat(lockDir)).mtimeMs
        if (age > STALE_FILE_LOCK_MS) {
          await rmdir(lockDir)
          continue
        }
      } catch (lockErr) {
        if ((lockErr as NodeJS.ErrnoException).code === "ENOENT") continue
      }
      if (Date.now() >= deadline) {
        throw new Error(`Timed out waiting for lockfile writer ${lockDir}`)
      }
      await new Promise((resolve) => setTimeout(resolve, 25 + Math.floor(Math.random() * 25)))
    }
  }
}

/** Recorded successful-submission estimates, kept separate by provider unit. */
export function spendByUnit(lock: Lock): Record<CostUnit, number> {
  const totals: Record<CostUnit, number> = { generations: 0, usd: 0, free: 0 }
  for (const entry of Object.values(lock.entries)) {
    const unit = entry.costUnit ?? "generations"
    totals[unit] = (totals[unit] ?? 0) + (entry.cost ?? 0)
  }
  return totals
}

/** @deprecated Prefer spendByUnit; summing unlike provider units is unsafe. */
export function totalSpend(lock: Lock, unit: CostUnit = "generations"): number {
  return spendByUnit(lock)[unit] ?? 0
}
