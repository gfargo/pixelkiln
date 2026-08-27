import { describe, expect, it, beforeEach, afterEach } from "vitest"
import { mkdir, mkdtemp, writeFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { loadCache, saveCache, pruneCache, cachePathFor } from "../src/cache.ts"
import { sha256 } from "../src/hash.ts"
import { inspectCaches } from "../src/pipeline/cache-health.ts"
import type { Lock } from "../src/types.ts"

let dir: string
beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "pixelkiln-cache-"))
})
afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

describe("cachePathFor", () => {
  it("derives the conventional sibling for the default lockfile name", () => {
    expect(cachePathFor("pixelkiln.lock.json")).toBe("pixelkiln.cache.json")
  })

  it("derives the conventional sibling for a custom name that still ends in .lock.json", () => {
    // The real pattern this project uses for a variant lockfile.
    expect(cachePathFor("pixelkiln.vibe.lock.json")).toBe("pixelkiln.vibe.cache.json")
  })

  // Regression: a lock name that doesn't end in exactly ".lock.json" used to
  // come back unchanged, so `adopt` would load and save the cache — a
  // completely different schema — at the real lockfile's own path,
  // overwriting every entry on the first run.
  it("never returns the same path it was given, for any input", () => {
    for (const name of ["mylock.json", "custom.json", "lock.json", "pixelkiln.lock", "pixelkiln.lock.json.bak"]) {
      expect(cachePathFor(name)).not.toBe(name)
    }
  })

  it("falls back to appending .cache.json when the name doesn't match the convention", () => {
    expect(cachePathFor("mylock.json")).toBe("mylock.json.cache.json")
  })
})

describe("loadCache / saveCache", () => {
  it("round-trips hashes", async () => {
    const p = path.join(dir, "pixelkiln.cache.json")
    const a = "a".repeat(64)
    const b = "b".repeat(64)
    await saveCache(p, { version: 1, hashes: { "obj-1": a, "obj-2": b } })
    const loaded = await loadCache(p)
    expect(loaded.hashes).toEqual({ "obj-1": a, "obj-2": b })
  })

  it("returns an empty cache when the file does not exist", async () => {
    const loaded = await loadCache(path.join(dir, "missing.cache.json"))
    expect(loaded).toEqual({ version: 1, hashes: {} })
  })

  it("rebuilds rather than throwing on a corrupt file", async () => {
    const p = path.join(dir, "bad.cache.json")
    await writeFile(p, "{not json")
    await expect(loadCache(p)).resolves.toEqual({ version: 1, hashes: {} })
  })

  it("rebuilds rather than throwing on a schema mismatch", async () => {
    // The exact shape a real lockfile would have if cachePathFor ever
    // collided with it again — must not be mistaken for a valid cache.
    const p = path.join(dir, "wrong-shape.cache.json")
    await writeFile(p, JSON.stringify({ version: 2, entries: { "a/b": {} } }))
    await expect(loadCache(p)).resolves.toEqual({ version: 1, hashes: {} })
  })

  it("drops invalid cached hashes instead of trusting them during adoption", async () => {
    const p = path.join(dir, "bad-hash.cache.json")
    await writeFile(p, JSON.stringify({
      version: 1,
      hashes: { good: "a".repeat(64), bad: "not-a-sha" },
    }))
    await expect(loadCache(p)).resolves.toEqual({
      version: 1,
      hashes: { good: "a".repeat(64) },
    })
    await expect(saveCache(p, { version: 1, hashes: { bad: "not-a-sha" } }))
      .rejects.toThrow(/invalid SHA-256/)
  })
})

describe("pruneCache", () => {
  it("drops entries for ids no longer on the account", () => {
    const cache = { version: 1 as const, hashes: { a: "1", b: "2", c: "3" } }
    const removed = pruneCache(cache, new Set(["a", "c"]))
    expect(removed).toBe(1)
    expect(cache.hashes).toEqual({ a: "1", c: "3" })
  })
})

describe("inspectCaches", () => {
  const png = (suffix: string) => Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    Buffer.from(suffix),
  ])
  const lockWithHash = (hash: string): Lock => ({
    version: 2,
    entries: {
      "s/a": { outputs: [{ path: "out/a.png", sha256: hash }] },
    },
  } as unknown as Lock)

  it("separates valid referenced content from safe-to-prune orphaned bytes", async () => {
    const lockPath = path.join(dir, "pixelkiln.lock.json")
    const cacheDir = path.join(dir, ".pixelkiln", "cache")
    await mkdir(cacheDir, { recursive: true })
    const kept = png("kept")
    const orphan = png("orphan")
    await writeFile(path.join(cacheDir, `${sha256(kept)}.png`), kept)
    await writeFile(path.join(cacheDir, `${sha256(orphan)}.png`), orphan)

    const report = await inspectCaches(lockWithHash(sha256(kept)), lockPath)
    expect(report.safe).toBe(true)
    expect(report.content).toMatchObject({ valid: 2, referenced: 1 })
    expect(report.content.unreferenced).toEqual([`${sha256(orphan)}.png`])
  })

  it("verifies and prunes invalid content and remote hash entries", async () => {
    const lockPath = path.join(dir, "pixelkiln.lock.json")
    await writeFile(lockPath, JSON.stringify({ version: 2, entries: {} }))
    const cacheDir = path.join(dir, ".pixelkiln", "cache")
    await mkdir(cacheDir, { recursive: true })
    const kept = png("kept")
    const orphan = png("orphan")
    await writeFile(path.join(cacheDir, `${sha256(kept)}.png`), kept)
    await writeFile(path.join(cacheDir, `${sha256(orphan)}.png`), orphan)
    await writeFile(path.join(cacheDir, `${"0".repeat(64)}.png`), png("wrong hash"))
    await writeFile(path.join(cacheDir, "stale.tmp"), "partial")
    await writeFile(cachePathFor(lockPath), JSON.stringify({
      version: 1,
      hashes: { good: sha256(kept), bad: "not-a-sha" },
    }))

    expect((await inspectCaches(lockWithHash(sha256(kept)), lockPath)).safe).toBe(false)
    const pruned = await inspectCaches(lockWithHash(sha256(kept)), lockPath, { prune: true })
    expect(pruned.safe).toBe(true)
    expect(pruned.removed).toMatchObject({ contentFiles: 3, remoteHashEntries: 1 })
    expect(pruned.content).toMatchObject({ valid: 1, referenced: 1, unreferenced: [] })
    expect(pruned.remoteHashes).toMatchObject({ entries: 1, valid: 1, invalidIds: [] })
  })

  it("can rebuild a malformed disposable object-hash cache", async () => {
    const lockPath = path.join(dir, "pixelkiln.lock.json")
    await writeFile(lockPath, JSON.stringify({ version: 2, entries: {} }))
    await writeFile(cachePathFor(lockPath), "{broken")
    const report = await inspectCaches({ version: 2, entries: {} }, lockPath, { prune: true })
    expect(report.safe).toBe(true)
    expect(report.removed.resetRemoteHashCache).toBe(true)
    await expect(loadCache(cachePathFor(lockPath))).resolves.toEqual({ version: 1, hashes: {} })
  })

  it("refuses to prune when a mistyped lock path would make every PNG look unreferenced", async () => {
    const lockPath = path.join(dir, "missing.lock.json")
    await expect(inspectCaches({ version: 2, entries: {} }, lockPath, { prune: true }))
      .rejects.toThrow(/without an existing lockfile/)
  })
})
