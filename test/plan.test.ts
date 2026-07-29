import { describe, expect, it, beforeEach, afterEach } from "vitest"
import { mkdtemp, writeFile, mkdir, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { loadManifest, resolveSpecs } from "../src/manifest.ts"
import { buildPlan } from "../src/pipeline/plan.ts"
import { loadLock, saveLock, upsert } from "../src/lock.ts"
import { candidateCount, generationCost, lockKey, type Lock } from "../src/types.ts"
import { sha256 } from "../src/hash.ts"

// A 1x1 transparent PNG — enough to exist on disk and be hashed.
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
  "base64",
)

let dir: string

async function writeManifest(extra: Record<string, unknown> = {}) {
  const manifest = {
    name: "test",
    styles: {
      base: { generator: "1dir", size: 64, outDir: "out", promptSuffix: "clean", ...extra },
    },
    assets: {
      alpha: { prompt: "an anvil", category: "tools" },
      beta: { prompt: "a hammer", category: "tools" },
    },
  }
  await writeFile(path.join(dir, "m.json"), JSON.stringify(manifest))
  return loadManifest(path.join(dir, "m.json"))
}

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "pixelkiln-"))
})
afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

describe("cost model", () => {
  it("charges by canvas tier, not by candidate count", () => {
    expect(generationCost(32, 32)).toBe(20) // 1024px
    expect(generationCost(45, 45)).toBe(25) // 2025px
    expect(generationCost(64, 64)).toBe(40) // 4096px
  })

  it("returns more candidates the smaller the canvas", () => {
    expect(candidateCount(32)).toBe(64)
    expect(candidateCount(42)).toBe(64)
    expect(candidateCount(64)).toBe(16)
    expect(candidateCount(85)).toBe(16)
    expect(candidateCount(128)).toBe(4)
    expect(candidateCount(256)).toBe(1)
  })
})

describe("plan", () => {
  it("reports everything missing against an empty lock, and prices it", async () => {
    const loaded = await writeManifest()
    const specs = await resolveSpecs(loaded)
    const plan = await buildPlan(specs, { version: 1, entries: {} })

    expect(plan.items).toHaveLength(2)
    expect(plan.items.every((i) => i.state === "missing")).toBe(true)
    expect(plan.cost).toBe(80) // 2 assets x 40
    expect(plan.candidates).toBe(32) // 2 x 16
  })

  it("reports ok when the lock matches and the file is untouched", async () => {
    const loaded = await writeManifest()
    const specs = await resolveSpecs(loaded)
    const spec = specs.find((s) => s.assetId === "alpha")!

    await mkdir(path.dirname(spec.outFile), { recursive: true })
    await writeFile(spec.outFile, PNG)

    const lock: Lock = { version: 1, entries: {} }
    upsert(lock, lockKey(spec.styleId, spec.assetId), {
      specHash: spec.specHash,
      status: "downloaded",
      file: spec.outFile,
      fileSha256: sha256(PNG),
    } as never)

    const plan = await buildPlan(specs, lock)
    expect(plan.items.find((i) => i.spec.assetId === "alpha")!.state).toBe("ok")
    // The unrelated asset is untouched by alpha's state.
    expect(plan.items.find((i) => i.spec.assetId === "beta")!.state).toBe("missing")
  })

  it("detects a hand-edited file rather than silently overwriting it", async () => {
    const loaded = await writeManifest()
    const specs = await resolveSpecs(loaded)
    const spec = specs.find((s) => s.assetId === "alpha")!

    await mkdir(path.dirname(spec.outFile), { recursive: true })
    await writeFile(spec.outFile, PNG)

    const lock: Lock = { version: 1, entries: {} }
    upsert(lock, lockKey(spec.styleId, spec.assetId), {
      specHash: spec.specHash,
      status: "downloaded",
      file: spec.outFile,
      fileSha256: sha256(Buffer.from("something else")),
    } as never)

    const plan = await buildPlan(specs, lock)
    const item = plan.items.find((i) => i.spec.assetId === "alpha")!
    expect(item.state).toBe("orphaned")
    // Orphaned work is not re-billed; the object may still be downloadable.
    expect(plan.actionable).not.toContain(item)
  })

  it("marks entries stale when the prompt changes, and prices only those", async () => {
    const loaded = await writeManifest()
    const specs = await resolveSpecs(loaded)
    const lock: Lock = { version: 1, entries: {} }
    for (const spec of specs) {
      upsert(lock, lockKey(spec.styleId, spec.assetId), {
        specHash: "stale-hash",
        status: "downloaded",
        file: spec.outFile,
        fileSha256: null,
      } as never)
    }
    const plan = await buildPlan(specs, lock)
    expect(plan.items.every((i) => i.state === "stale")).toBe(true)
    expect(plan.cost).toBe(80)
  })
})

describe("specHash", () => {
  it("changes when the style prose changes", async () => {
    const a = await resolveSpecs(await writeManifest({ promptSuffix: "one" }))
    const b = await resolveSpecs(await writeManifest({ promptSuffix: "two" }))
    expect(a[0]!.specHash).not.toBe(b[0]!.specHash)
  })

  it("is stable across runs for identical input", async () => {
    const a = await resolveSpecs(await writeManifest())
    const b = await resolveSpecs(await writeManifest())
    expect(a[0]!.specHash).toBe(b[0]!.specHash)
  })

  it("ignores output path, so renaming a destination does not force a regen", async () => {
    const a = await resolveSpecs(await writeManifest({ outDir: "out" }))
    const b = await resolveSpecs(await writeManifest({ outDir: "elsewhere" }))
    expect(a[0]!.specHash).toBe(b[0]!.specHash)
  })
})

describe("styles as namespaces", () => {
  it("keeps two styles of the same asset in separate keys and directories", async () => {
    const manifest = {
      name: "test",
      styles: {
        base: { generator: "1dir", size: 64, outDir: "out/base" },
        neon: { generator: "1dir", size: 64, outDir: "out/neon" },
      },
      assets: { alpha: { prompt: "an anvil" } },
    }
    await writeFile(path.join(dir, "m.json"), JSON.stringify(manifest))
    const specs = await resolveSpecs(await loadManifest(path.join(dir, "m.json")))

    expect(specs).toHaveLength(2)
    const keys = specs.map((s) => lockKey(s.styleId, s.assetId)).sort()
    expect(keys).toEqual(["base/alpha", "neon/alpha"])
    expect(new Set(specs.map((s) => s.outFile)).size).toBe(2)
  })

  it("honours a per-asset style allowlist", async () => {
    const manifest = {
      name: "test",
      styles: {
        base: { generator: "1dir", outDir: "out/base" },
        neon: { generator: "1dir", outDir: "out/neon" },
      },
      assets: {
        everywhere: { prompt: "a" },
        baseOnly: { prompt: "b", styles: ["base"] },
      },
    }
    await writeFile(path.join(dir, "m.json"), JSON.stringify(manifest))
    const specs = await resolveSpecs(await loadManifest(path.join(dir, "m.json")))
    expect(specs.filter((s) => s.assetId === "baseOnly").map((s) => s.styleId)).toEqual(["base"])
    expect(specs.filter((s) => s.assetId === "everywhere")).toHaveLength(2)
  })
})

describe("lockfile", () => {
  it("round-trips and sorts keys for a stable diff", async () => {
    const p = path.join(dir, "lock.json")
    const lock: Lock = { version: 1, entries: {} }
    for (const key of ["z/a", "a/z", "m/m"]) {
      const [styleId, assetId] = key.split("/") as [string, string]
      upsert(lock, key, {
        styleId,
        assetId,
        specHash: "h",
        generator: "1dir",
        prompt: "p",
        width: 64,
        height: 64,
        jobId: null,
        reviewObjectId: null,
        objectId: null,
        candidateIndex: null,
        status: "pending",
        error: null,
        sourceUrl: null,
        file: null,
        fileSha256: null,
        submittedAt: null,
        downloadedAt: null,
        cost: 1,
      })
    }
    await saveLock(p, lock)
    const reloaded = await loadLock(p)
    expect(Object.keys(reloaded.entries)).toEqual(["a/z", "m/m", "z/a"])
  })

  it("returns an empty lock when the file does not exist", async () => {
    const lock = await loadLock(path.join(dir, "nope.json"))
    expect(lock.entries).toEqual({})
  })

  it("rejects a malformed lockfile instead of silently starting over", async () => {
    const p = path.join(dir, "bad.json")
    await writeFile(p, JSON.stringify({ version: 99, entries: "not an object" }))
    await expect(loadLock(p)).rejects.toThrow(/malformed/i)
  })
})

describe("manifest validation", () => {
  it("rejects an unknown style filter rather than silently generating everything", async () => {
    const loaded = await writeManifest()
    await expect(resolveSpecs(loaded, { styles: ["nope"] })).rejects.toThrow(/Unknown style/)
  })

  it("rejects unknown keys so typos surface", async () => {
    await writeFile(
      path.join(dir, "m.json"),
      JSON.stringify({
        name: "t",
        styles: { base: { generator: "1dir", outDir: "o", promtSuffix: "typo" } },
        assets: {},
      }),
    )
    await expect(loadManifest(path.join(dir, "m.json"))).rejects.toThrow(/invalid/i)
  })
})
