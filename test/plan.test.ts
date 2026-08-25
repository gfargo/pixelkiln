import { describe, expect, it, beforeEach, afterEach } from "vitest"
import { mkdtemp, writeFile, mkdir, rm, readFile } from "node:fs/promises"
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

  // The default is `map` because it is the right choice for any asset that is
  // not going to be rotated or animated, and 20-40x cheaper.
  it("defaults to map pricing when no generator is given", () => {
    expect(generationCost(64, 64)).toBe(1)
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
  it("uses map when a style does not name a generator", async () => {
    const manifest = {
      name: "t",
      styles: { base: { outDir: "out" } },
      assets: { a: { prompt: "an anvil" } },
    }
    await writeFile(path.join(dir, "m.json"), JSON.stringify(manifest))
    const specs = await resolveSpecs(await loadManifest(path.join(dir, "m.json")))
    expect(specs[0]!.generator).toBe("map")
    expect(specs[0]!.cost).toBe(1)
  })

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

  it("rejects asset references to an unknown style", async () => {
    const p = path.join(dir, "m.json")
    await writeFile(
      p,
      JSON.stringify({
        name: "t",
        styles: { base: { outDir: "out" } },
        assets: { anvil: { prompt: "an anvil", styles: ["typo"] } },
      }),
    )
    await expect(loadManifest(p)).rejects.toThrow(/unknown style "typo"/)
  })

  it("validates palette colours while planning is still offline", async () => {
    await expect(writeManifest({ generator: "pixflux", palette: ["not-a-colour"] })).rejects.toThrow(
      /hex colour/,
    )
  })

  it("rejects a combined tag set over the provider limit", async () => {
    const loaded = await writeManifest({ tags: Array.from({ length: 18 }, (_, i) => `tag-${i}`) })
    await expect(resolveSpecs(loaded)).rejects.toThrow(/at most 20/)
  })
})

describe("lockfile schema", () => {
  const entry = {
    styleId: "base", assetId: "anvil", specHash: "h", generator: "1dir", prompt: "p",
    width: 64, height: 64, jobId: "j", reviewObjectId: null, objectId: "o",
    candidateIndex: null, status: "downloaded", error: null, sourceUrl: "u",
    submittedAt: null, downloadedAt: null, cost: 40,
  }

  // v2 is the only schema. A v1 file would mean corruption or a hand-edit,
  // not a legacy artifact, so it should fail rather than be reinterpreted.
  it("rejects a v1 lockfile instead of silently migrating it", () => {
    expect(() =>
      parseLock({ version: 1, entries: { "base/anvil": { ...entry, file: "/a.png", fileSha256: "x" } } }),
    ).toThrow(/not valid v2/)
  })

  it("rejects an unknown version", () => {
    expect(() => parseLock({ version: 7, entries: {} })).toThrow(/not valid v2/)
  })

  it("supports multi-output entries, which is the point of v2", () => {
    const lock = parseLock({
      version: 2,
      entries: {
        "base/hero": {
          ...entry,
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

  it("defaults provider so an entry written before providers still loads", () => {
    const lock = parseLock({ version: 2, entries: { "base/anvil": { ...entry, outputs: [] } } })
    expect(lock.entries["base/anvil"]!.provider).toBe("pixellab")
  })
})

describe("per-style prompt overrides", () => {
  async function withOverride() {
    const manifest = {
      name: "t",
      styles: {
        colour: { generator: "1dir", size: 64, outDir: "out/colour", promptSuffix: "vivid" },
        mono: { generator: "1dir", size: 64, outDir: "out/mono", promptSuffix: "monochrome" },
      },
      assets: {
        leaves: {
          prompt: "three leaves, green purple gold",
          promptByStyle: { mono: "three leaves, varied shapes" },
        },
        plain: { prompt: "an anvil" },
      },
    }
    await writeFile(path.join(dir, "m.json"), JSON.stringify(manifest))
    return resolveSpecs(await loadManifest(path.join(dir, "m.json")))
  }

  // The whole point: a monochrome style needs the colour words gone, while the
  // colour style needs them kept.
  it("substitutes the subject for the matching style only", async () => {
    const specs = await withOverride()
    const mono = specs.find((s) => s.styleId === "mono" && s.assetId === "leaves")!
    const colour = specs.find((s) => s.styleId === "colour" && s.assetId === "leaves")!
    expect(mono.prompt).toContain("varied shapes")
    expect(mono.prompt).not.toContain("green purple gold")
    expect(colour.prompt).toContain("green purple gold")
  })

  it("still applies the style's own prefix and suffix", async () => {
    const specs = await withOverride()
    const mono = specs.find((s) => s.styleId === "mono" && s.assetId === "leaves")!
    expect(mono.prompt).toContain("monochrome")
  })

  it("leaves assets without an override untouched", async () => {
    const specs = await withOverride()
    for (const s of specs.filter((x) => x.assetId === "plain")) {
      expect(s.prompt).toContain("an anvil")
    }
  })

  // Overriding must invalidate only the style it applies to, so the other
  // style's already-paid-for art is not marked stale.
  it("changes the spec hash for the overridden style alone", async () => {
    const before = await withOverride()
    const manifest = JSON.parse(await readFile(path.join(dir, "m.json"), "utf8"))
    manifest.assets.leaves.promptByStyle.mono = "three leaves, different silhouettes"
    await writeFile(path.join(dir, "m.json"), JSON.stringify(manifest))
    const after = await resolveSpecs(await loadManifest(path.join(dir, "m.json")))

    const hash = (specs: typeof before, style: string) =>
      specs.find((s) => s.styleId === style && s.assetId === "leaves")!.specHash
    expect(hash(after, "mono")).not.toBe(hash(before, "mono"))
    expect(hash(after, "colour")).toBe(hash(before, "colour"))
  })
})
