import { describe, expect, it, beforeEach, afterEach } from "vitest"
import { mkdtemp, writeFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { loadCache, saveCache, pruneCache, cachePathFor } from "../src/cache.ts"

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
    await saveCache(p, { version: 1, hashes: { "obj-1": "abc", "obj-2": "def" } })
    const loaded = await loadCache(p)
    expect(loaded.hashes).toEqual({ "obj-1": "abc", "obj-2": "def" })
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
})

describe("pruneCache", () => {
  it("drops entries for ids no longer on the account", () => {
    const cache = { version: 1 as const, hashes: { a: "1", b: "2", c: "3" } }
    const removed = pruneCache(cache, new Set(["a", "c"]))
    expect(removed).toBe(1)
    expect(cache.hashes).toEqual({ a: "1", c: "3" })
  })
})
