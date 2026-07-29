import { describe, expect, it, beforeEach, afterEach } from "vitest"
import { mkdtemp, writeFile, mkdir, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { loadManifest, resolveSpecs } from "../src/manifest.ts"
import { buildPlan } from "../src/pipeline/plan.ts"
import { loadLock, saveLock, upsert } from "../src/lock.ts"
import { candidateCount, generationCost, lockKey, parseLock, primaryOutput, type Lock } from "../src/types.ts"
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
  it("charges 1dir by canvas tier, not by candidate count", () => {
    expect(generationCost(32, 32, "1dir")).toBe(20) // 1024px
    expect(generationCost(45, 45, "1dir")).toBe(25) // 2025px
    expect(generationCost(64, 64, "1dir")).toBe(40) // 4096px
  })

  // Measured live: a 32x36 and a 64x96 map object each cost exactly 1
  // generation. Applying the 1dir tiers here overstated map cost by 20-40x.
  it("charges map objects a flat 1 regardless of size", () => {
    expect(generationCost(32, 36, "map")).toBe(1)
    expect(generationCost(64, 96, "map")).toBe(1)
    expect(generationCost(400, 400, "map")).toBe(1)
  })

  it("defaults to 1dir pricing when no generator is given", () => {
    expect(generationCost(64, 64)).toBe(40)
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

describe("plan cost by generator", () => {
  it("prices a map-generator manifest at 1 per asset", async () => {
    const manifest = {
      name: "t",
      styles: { base: { generator: "map", outDir: "out" } },
      assets: {
        tall: { prompt: "a pine", width: 32, height: 96 },
        wide: { prompt: "a bridge", width: 64, height: 48 },
      },
    }
    await writeFile(path.join(dir, "m.json"), JSON.stringify(manifest))
    const specs = await resolveSpecs(await loadManifest(path.join(dir, "m.json")))
    const plan = await buildPlan(specs, { version: 2, entries: {} })
    expect(plan.cost).toBe(2)
    expect(plan.candidates).toBe(2) // map returns exactly one each
  })
})

describe("plan", () => {
  it("reports everything missing against an empty lock, and prices it", async () => {
    const loaded = await writeManifest()
    const specs = await resolveSpecs(loaded)
    const plan = await buildPlan(specs, { version: 2, entries: {} })

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

    const lock: Lock = { version: 2, entries: {} }
    upsert(lock, lockKey(spec.styleId, spec.assetId), {
      specHash: spec.specHash,
      status: "downloaded",
      outputs: [{ path: spec.outFile, sha256: sha256(PNG) }],
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

    const lock: Lock = { version: 2, entries: {} }
    upsert(lock, lockKey(spec.styleId, spec.assetId), {
      specHash: spec.specHash,
      status: "downloaded",
      outputs: [{ path: spec.outFile, sha256: sha256(Buffer.from("something else")) }],
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
    const lock: Lock = { version: 2, entries: {} }
    for (const spec of specs) {
      upsert(lock, lockKey(spec.styleId, spec.assetId), {
        specHash: "stale-hash",
        status: "downloaded",
        outputs: [],
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
    const lock: Lock = { version: 2, entries: {} }
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
        outputs: [],
        submittedAt: null,
        downloadedAt: null,
        cost: 1,
        provider: "pixellab",
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

describe("lock v1 → v2 migration", () => {
  const v1Entry = {
    styleId: "base", assetId: "anvil", specHash: "h", generator: "1dir", prompt: "p",
    width: 64, height: 64, jobId: "j", reviewObjectId: null, objectId: "o",
    candidateIndex: null, status: "downloaded", error: null, sourceUrl: "u",
    submittedAt: null, downloadedAt: null, cost: 40,
  }

  // A committed lockfile is the record of what has been paid for. If a version
  // bump made one unreadable, every tracked asset would present as missing and
  // plan would offer to regenerate the lot.
  it("folds v1's single file into outputs[]", () => {
    const lock = parseLock({
      version: 1,
      entries: { "base/anvil": { ...v1Entry, file: "/out/anvil.png", fileSha256: "abc" } },
    })
    expect(lock.version).toBe(2)
    expect(lock.entries["base/anvil"]!.outputs).toEqual([{ path: "/out/anvil.png", sha256: "abc" }])
  })

  it("preserves everything else about the entry", () => {
    const lock = parseLock({
      version: 1,
      entries: { "base/anvil": { ...v1Entry, file: "/out/anvil.png", fileSha256: "abc" } },
    })
    const e = lock.entries["base/anvil"]!
    expect(e.objectId).toBe("o")
    expect(e.cost).toBe(40)
    expect(e.status).toBe("downloaded")
    expect(e.provider).toBe("pixellab") // defaulted for pre-provider entries
  })

  // Without a hash the file cannot be integrity-checked, so carrying it over
  // would mean silently trusting bytes we never verified.
  it("drops a v1 file that has no recorded hash", () => {
    const lock = parseLock({
      version: 1,
      entries: { "base/anvil": { ...v1Entry, file: "/out/anvil.png", fileSha256: null } },
    })
    expect(lock.entries["base/anvil"]!.outputs).toEqual([])
  })

  it("passes a v2 lockfile through untouched", () => {
    const outputs = [
      { path: "/a.png", sha256: "1" },
      { path: "/b.tres", sha256: "2", role: "spriteframes" },
    ]
    const lock = parseLock({ version: 2, entries: { "base/hero": { ...v1Entry, outputs } } })
    expect(lock.entries["base/hero"]!.outputs).toEqual(outputs)
  })

  it("rejects something that is neither version", () => {
    expect(() => parseLock({ version: 7, entries: {} })).toThrow(/neither v2 nor v1/)
  })

  it("supports multi-output entries, which is the point of v2", () => {
    const lock = parseLock({
      version: 2,
      entries: {
        "base/hero": {
          ...v1Entry,
          outputs: [
            { path: "/idle_s.png", sha256: "1" },
            { path: "/walk_s.png", sha256: "2" },
            { path: "/hero.frames.tres", sha256: "3", role: "spriteframes" },
            { path: "/portrait.png", sha256: "4", role: "portrait" },
          ],
        },
      },
    })
    const e = lock.entries["base/hero"]!
    expect(e.outputs).toHaveLength(4)
    expect(primaryOutput(e)!.path).toBe("/idle_s.png")
    expect(e.outputs.filter((o) => o.role)).toHaveLength(2)
  })
})
