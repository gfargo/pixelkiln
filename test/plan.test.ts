import { describe, expect, it, beforeEach, afterEach } from "vitest"
import { mkdtemp, writeFile, mkdir, rm, readFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { pathToFileURL } from "node:url"
import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { loadManifest, resolveSpecs } from "../src/manifest.ts"
import { buildPlan, resumeActions } from "../src/pipeline/plan.ts"
import { loadLock, remove, saveLock, upsert } from "../src/lock.ts"
import { candidateCount, generationCost, lockKey, parseLock, primaryOutput, type Lock } from "../src/types.ts"
import { sha256 } from "../src/hash.ts"
import { normalizeLockOutputPaths } from "../src/outputs.ts"

// A 1x1 transparent PNG — enough to exist on disk and be hashed.
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
  "base64",
)
const execFileAsync = promisify(execFile)

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

  it("resolves style providers and keeps their plan totals separate", async () => {
    await writeFile(path.join(dir, "m.json"), JSON.stringify({
      name: "mixed",
      provider: "pixellab",
      styles: {
        world: { generator: "map", outDir: "out/world" },
        portraits: {
          provider: "retrodiffusion",
          generator: "map",
          outDir: "out/portraits",
          providerOptions: {
            retrodiffusion: { promptStyle: "rd_fast__default" },
          },
        },
      },
      assets: {
        mountain: { prompt: "a mountain", styles: ["world"] },
        hero: { prompt: "a hero", styles: ["portraits"] },
      },
    }))

    const specs = await resolveSpecs(await loadManifest(path.join(dir, "m.json")))
    expect(specs.map((spec) => [spec.styleId, spec.provider])).toEqual([
      ["world", "pixellab"],
      ["portraits", "retrodiffusion"],
    ])

    const plan = await buildPlan(specs, { version: 2, entries: {} })
    expect(plan.groups).toHaveLength(2)
    expect(plan.groups.map((group) => [group.provider, group.costUnit])).toEqual([
      ["pixellab", "generations"],
      ["retrodiffusion", "usd"],
    ])
    expect(plan.cost).toBeNull()
    expect(plan.costUnit).toBeNull()
    expect(plan.actionable).toHaveLength(2)
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

  // AssetSchema.source documents that a source-backed asset needs no lock entry
  // at all — it is committed art that `mount` places, not something pixelkiln
  // generates. `plan` never read the field, so a whole terrain style landed in
  // the actionable list and was quoted a generation cost it can never incur.
  it("counts a source-backed asset as ok, not as work to generate", async () => {
    await mkdir(path.join(dir, "cells"), { recursive: true })
    await writeFile(path.join(dir, "cells", "tile_0.png"), PNG)
    await writeFile(path.join(dir, "m.json"), JSON.stringify({
      name: "t",
      styles: { base: { generator: "map", outDir: "out" } },
      assets: {
        alpha: { prompt: "grass", cell: [0, 0], source: "cells/tile_0.png" },
      },
    }))
    const specs = await resolveSpecs(await loadManifest(path.join(dir, "m.json")))
    const plan = await buildPlan(specs, { version: 2, entries: {} })

    expect(plan.items[0]!.state).toBe("ok")
    expect(plan.items[0]!.reason).toContain("cells/tile_0.png")
    expect(plan.actionable).toHaveLength(0)
    expect(plan.cost).toBe(0)
  })

  it("reports a source-backed asset whose source is gone as orphaned, not missing", async () => {
    await writeFile(path.join(dir, "m.json"), JSON.stringify({
      name: "t",
      styles: { base: { generator: "map", outDir: "out" } },
      assets: { alpha: { prompt: "grass", cell: [0, 0], source: "cells/gone.png" } },
    }))
    const specs = await resolveSpecs(await loadManifest(path.join(dir, "m.json")))
    const plan = await buildPlan(specs, { version: 2, entries: {} })

    // Orphaned, not missing: regenerating cannot produce art pixelkiln never
    // made, so this must not reach the actionable list or carry a cost.
    expect(plan.items[0]!.state).toBe("orphaned")
    expect(plan.items[0]!.reason).toContain("cells/gone.png")
    expect(plan.actionable).toHaveLength(0)
    expect(plan.cost).toBe(0)
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

  it("resolves a committed relative output from the manifest directory", async () => {
    const loaded = await writeManifest()
    const specs = await resolveSpecs(loaded)
    const spec = specs.find((candidate) => candidate.assetId === "alpha")!
    await mkdir(path.dirname(spec.outFile), { recursive: true })
    await writeFile(spec.outFile, PNG)

    const lock: Lock = { version: 2, entries: {} }
    upsert(lock, lockKey(spec.styleId, spec.assetId), {
      specHash: spec.specHash,
      status: "downloaded",
      outputs: [{ path: path.relative(spec.root, spec.outFile), sha256: sha256(PNG) }],
    } as never)

    const plan = await buildPlan(specs, lock)
    expect(plan.items.find((item) => item.spec.assetId === "alpha")!.state).toBe("ok")
  })

  it("rebases an absolute v2 path when the project moves and the old checkout still exists", async () => {
    const manifest = {
      name: "t",
      styles: { base: { generator: "map", outDir: "out" } },
      assets: { alpha: { prompt: "an anvil" } },
    }
    const oldRoot = path.join(dir, "old")
    const newRoot = path.join(dir, "new")
    await mkdir(oldRoot, { recursive: true })
    await mkdir(newRoot, { recursive: true })
    await writeFile(path.join(oldRoot, "m.json"), JSON.stringify(manifest))
    await writeFile(path.join(newRoot, "m.json"), JSON.stringify(manifest))
    const oldSpec = (await resolveSpecs(await loadManifest(path.join(oldRoot, "m.json"))))[0]!
    const newSpec = (await resolveSpecs(await loadManifest(path.join(newRoot, "m.json"))))[0]!
    await mkdir(path.dirname(oldSpec.outFile), { recursive: true })
    await mkdir(path.dirname(newSpec.outFile), { recursive: true })
    await writeFile(oldSpec.outFile, Buffer.from("old checkout changed independently"))
    await writeFile(newSpec.outFile, PNG)

    const lock: Lock = { version: 2, entries: {} }
    upsert(lock, lockKey(newSpec.styleId, newSpec.assetId), {
      specHash: newSpec.specHash,
      status: "downloaded",
      outputs: [{ path: oldSpec.outFile, sha256: sha256(PNG) }],
    } as never)

    expect((await buildPlan([newSpec], lock)).items[0]!.state).toBe("ok")
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

  it("maps paid workflow states to their exact zero-cost resume commands", async () => {
    const specs = await resolveSpecs(await writeManifest())
    const lock: Lock = { version: 2, entries: {} }
    const [alpha, beta] = specs
    upsert(lock, lockKey(alpha!.styleId, alpha!.assetId), {
      specHash: alpha!.specHash,
      status: "processing",
      jobId: "job-alpha",
      outputs: [],
    } as never)
    upsert(lock, lockKey(beta!.styleId, beta!.assetId), {
      specHash: beta!.specHash,
      status: "selected",
      objectId: "object-beta",
      sourceUrl: "https://example.test/beta.png",
      outputs: [],
    } as never)

    const processing = await buildPlan(specs, lock)
    expect(processing.items.find((item) => item.spec.assetId === "alpha")).toMatchObject({
      state: "in-flight",
      reason: "awaiting processing; run pixelkiln poll",
    })
    expect(processing.items.find((item) => item.spec.assetId === "beta")).toMatchObject({
      state: "recoverable",
      reason: "provider output is selected; run pixelkiln fetch (no generation cost)",
    })
    expect(resumeActions(specs, lock)).toEqual([
      { command: "poll", keys: ["base/alpha"] },
      { command: "fetch", keys: ["base/beta"] },
    ])

    upsert(lock, "base/alpha", { status: "review", reviewObjectId: "review-alpha" })
    expect((await buildPlan(specs, lock)).items.find((item) => item.spec.assetId === "alpha"))
      .toMatchObject({ state: "in-flight", reason: "awaiting review; run pixelkiln pick" })
    expect(resumeActions(specs, lock)).toEqual([
      { command: "pick", keys: ["base/alpha"] },
      { command: "fetch", keys: ["base/beta"] },
    ])
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

  it("is stable when the same project moves to another checkout", async () => {
    const manifest = {
      name: "t",
      styles: { base: { generator: "map", outDir: "out" } },
      assets: { alpha: { prompt: "an anvil" } },
    }
    const first = path.join(dir, "first")
    const second = path.join(dir, "second")
    await mkdir(first, { recursive: true })
    await mkdir(second, { recursive: true })
    await writeFile(path.join(first, "m.json"), JSON.stringify(manifest))
    await writeFile(path.join(second, "m.json"), JSON.stringify(manifest))

    const a = await resolveSpecs(await loadManifest(path.join(first, "m.json")))
    const b = await resolveSpecs(await loadManifest(path.join(second, "m.json")))
    expect(a[0]!.root).not.toBe(b[0]!.root)
    expect(a[0]!.specHash).toBe(b[0]!.specHash)
  })

  it("ignores output path, so renaming a destination does not force a regen", async () => {
    const a = await resolveSpecs(await writeManifest({ outDir: "out" }))
    const b = await resolveSpecs(await writeManifest({ outDir: "elsewhere" }))
    expect(a[0]!.specHash).toBe(b[0]!.specHash)
  })

  it("ignores `source`, so swapping the art a mount places does not force a regen", async () => {
    const manifest = (source: string) => ({
      name: "t",
      styles: { base: { generator: "map", outDir: "out" } },
      assets: { alpha: { prompt: "an anvil", cell: [0, 0], source } },
    })
    await writeFile(path.join(dir, "a.json"), JSON.stringify(manifest("cells/one.png")))
    await writeFile(path.join(dir, "b.json"), JSON.stringify(manifest("cells/two.png")))
    const a = await resolveSpecs(await loadManifest(path.join(dir, "a.json")))
    const b = await resolveSpecs(await loadManifest(path.join(dir, "b.json")))
    expect(a[0]!.source).toBe("cells/one.png")
    expect(a[0]!.specHash).toBe(b[0]!.specHash)
  })

  // Every tile parameter below changes the image the endpoint draws, and none
  // of them was hashed — so flipping `outlineMode` on a generated set left it
  // reporting `ok`. Measured on a real fairway set, outline vs segmentation was
  // the difference between borders that read as quilting and a seamless tiling.
  it.each([
    ["outlineMode", { outlineMode: "outline" }, { outlineMode: "segmentation" }],
    ["tileFeature", { tileFeature: "tileset" }, { tileFeature: "roads" }],
    ["tileType", { tileType: "isometric" }, { tileType: "square_topdown" }],
    ["tileView", { tileView: "low top-down" }, { tileView: "side" }],
  ])("changes when a tiles style's %s changes", async (_name, one, two) => {
    const tiles = (extra: Record<string, unknown>) => ({
      generator: "tiles", tileSize: 32, outDir: "out", ...extra,
    })
    await writeFile(path.join(dir, "a.json"), JSON.stringify({
      name: "t", styles: { base: tiles(one) }, assets: { alpha: { prompt: "grass" } },
    }))
    await writeFile(path.join(dir, "b.json"), JSON.stringify({
      name: "t", styles: { base: tiles(two) }, assets: { alpha: { prompt: "grass" } },
    }))
    const a = await resolveSpecs(await loadManifest(path.join(dir, "a.json")))
    const b = await resolveSpecs(await loadManifest(path.join(dir, "b.json")))
    expect(a[0]!.specHash).not.toBe(b[0]!.specHash)
  })

  it("changes when pixflux is told to keep its background", async () => {
    const style = (noBackground: boolean) => ({
      name: "t",
      styles: { base: { generator: "pixflux", size: 32, outDir: "out", noBackground } },
      assets: { alpha: { prompt: "a banner" } },
    })
    await writeFile(path.join(dir, "a.json"), JSON.stringify(style(true)))
    await writeFile(path.join(dir, "b.json"), JSON.stringify(style(false)))
    const a = await resolveSpecs(await loadManifest(path.join(dir, "a.json")))
    const b = await resolveSpecs(await loadManifest(path.join(dir, "b.json")))
    expect(a[0]!.specHash).not.toBe(b[0]!.specHash)
  })

  // The guard for the whole scheme. `palette` was once added to the hash
  // unconditionally; every lock entry written before that commit then reported
  // `stale`, and one project was offered a 1612-generation regeneration of art
  // that had not changed. A generator-specific field must stay `undefined` for
  // the generators it does not reach, so JSON.stringify drops the key and the
  // serialized form is untouched. If this pin moves, every existing lockfile
  // in every consuming project goes stale on upgrade — that is the cost.
  it("pins the hash of a plain map spec against accidental schema churn", async () => {
    await writeFile(path.join(dir, "m.json"), JSON.stringify({
      name: "t",
      styles: { base: { generator: "map", size: 32, outDir: "out" } },
      assets: { alpha: { prompt: "an anvil" } },
    }))
    const specs = await resolveSpecs(await loadManifest(path.join(dir, "m.json")))
    expect(specs[0]!.specHash).toBe(
      "e5606b8167a58effd327a2ed2ef385008413fa48e4d4c2c0fe8cfd7d7a6d2a1a",
    )
  })
})

describe("styles as namespaces", () => {
  it("inherits style fields while keeping child outputs and focused overrides explicit", async () => {
    const manifest = {
      name: "test",
      styles: {
        base: {
          generator: "map",
          size: 96,
          outDir: "out/base",
          promptPrefix: "pixel art",
          promptSuffix: "three-quarter view",
          quality: {
            outDir: "final/base",
            palette: ["#111111", "#eeeeee"],
            minGridConfidence: "medium",
            minTransparency: 0.25,
          },
          providerOptions: {
            custom: {
              model: "model-a",
              strength: 0.5,
              nested: { keep: true, replace: true },
            },
            spare: { mode: "parent" },
          },
        },
        explicit: {
          extends: "base",
          outDir: "out/explicit",
          promptPrefix: "pixel art, rating_explicit",
          seed: 24001,
          quality: {
            outDir: "final/explicit",
            minGridConfidence: "high",
          },
          providerOptions: {
            custom: {
              strength: 0.75,
              nested: { replace: false },
            },
          },
        },
      },
      assets: { alpha: { prompt: "a performer" } },
    }
    await writeFile(path.join(dir, "m.json"), JSON.stringify(manifest))
    const loaded = await loadManifest(path.join(dir, "m.json"))

    expect(Object.keys(loaded.manifest.styles)).toEqual(["base", "explicit"])
    expect(loaded.manifest.styles.explicit).toMatchObject({
      generator: "map",
      size: 96,
      outDir: "out/explicit",
      promptPrefix: "pixel art, rating_explicit",
      promptSuffix: "three-quarter view",
      seed: 24001,
      quality: {
        outDir: "final/explicit",
        palette: ["#111111", "#eeeeee"],
        minGridConfidence: "high",
        minTransparency: 0.25,
      },
      providerOptions: {
        custom: {
          model: "model-a",
          strength: 0.75,
          nested: { replace: false },
        },
        spare: { mode: "parent" },
      },
    })
    expect(loaded.manifest.styles.base.promptPrefix).toBe("pixel art")
    expect("extends" in loaded.manifest.styles.explicit!).toBe(false)
  })

  it("supports inheritance chains and hashes the fully resolved child", async () => {
    const manifest = {
      name: "test",
      styles: {
        front: { extends: "rated", outDir: "out/front", view: "side" },
        rated: { extends: "base", outDir: "out/rated", promptPrefix: "rating_safe" },
        base: { generator: "map", outDir: "out/base", promptSuffix: "clean clusters" },
      },
      assets: { alpha: { prompt: "a wall fixture" } },
    }
    const manifestPath = path.join(dir, "m.json")
    await writeFile(manifestPath, JSON.stringify(manifest))
    const loaded = await loadManifest(manifestPath)
    expect(Object.keys(loaded.manifest.styles)).toEqual(["front", "rated", "base"])
    const first = await resolveSpecs(loaded, { styles: ["front"] })
    expect(first[0]).toMatchObject({
      prompt: "rating_safe, a wall fixture, clean clusters",
      view: "side",
    })

    manifest.styles.base.promptSuffix = "clean clusters, cool lighting"
    await writeFile(manifestPath, JSON.stringify(manifest))
    const changed = await resolveSpecs(await loadManifest(manifestPath), { styles: ["front"] })
    expect(changed[0]!.specHash).not.toBe(first[0]!.specHash)
  })

  it("rejects missing child outputs, unknown parents, and inheritance cycles", async () => {
    const manifestPath = path.join(dir, "m.json")
    const writeStyles = async (styles: Record<string, unknown>) => {
      await writeFile(manifestPath, JSON.stringify({
        name: "test",
        styles,
        assets: { alpha: { prompt: "an anvil" } },
      }))
      return loadManifest(manifestPath)
    }

    await expect(writeStyles({
      base: { outDir: "out/base" },
      child: { extends: "base" },
    })).rejects.toThrow(/styles\.child.*outDir/i)

    await expect(writeStyles({
      child: { extends: "missing", outDir: "out/child" },
    })).rejects.toThrow(/styles\.child\.extends: unknown style "missing"/)

    await expect(writeStyles({
      first: { extends: "second", outDir: "out/first" },
      second: { extends: "first", outDir: "out/second" },
    })).rejects.toThrow(/inheritance cycle first -> second -> first/)
  })

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

  it("rejects two manifest entries that would overwrite the same output", async () => {
    const manifest = {
      name: "test",
      styles: { base: { outDir: "out" } },
      assets: {
        alpha: { prompt: "a", file: "same.png" },
        beta: { prompt: "b", file: "same.png" },
      },
    }
    await writeFile(path.join(dir, "m.json"), JSON.stringify(manifest))
    await expect(resolveSpecs(await loadManifest(path.join(dir, "m.json")))).rejects.toThrow(
      /Output collision/,
    )
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

  it("persists legacy absolute-path migration on the next save", async () => {
    const loaded = await writeManifest()
    const spec = (await resolveSpecs(loaded))[0]!
    const p = path.join(dir, "portable-lock.json")
    const initial: Lock = { version: 2, entries: {} }
    upsert(initial, lockKey(spec.styleId, spec.assetId), {
      styleId: spec.styleId,
      assetId: spec.assetId,
      specHash: spec.specHash,
      generator: spec.generator,
      prompt: spec.prompt,
      width: spec.width,
      height: spec.height,
      jobId: "job",
      reviewObjectId: null,
      objectId: "object",
      candidateIndex: null,
      status: "downloaded",
      error: null,
      sourceUrl: null,
      outputs: [{ path: "/old-checkout/out/tools/alpha.png", sha256: "a" }],
      submittedAt: null,
      downloadedAt: null,
      cost: 1,
      provider: "pixellab",
    } as never)
    await saveLock(p, initial)

    const migrated = await loadLock(p)
    expect(normalizeLockOutputPaths(migrated, [spec])).toBe(1)
    await saveLock(p, migrated)

    expect((await loadLock(p)).entries[lockKey(spec.styleId, spec.assetId)]!.outputs[0]!.path)
      .toBe("out/tools/alpha.png")
  })

  it("rejects a malformed lockfile instead of silently starting over", async () => {
    const p = path.join(dir, "bad.json")
    await writeFile(p, JSON.stringify({ version: 99, entries: "not an object" }))
    await expect(loadLock(p)).rejects.toThrow(/malformed/i)
  })

  it("merges changes from two processes that loaded the same lock", async () => {
    const p = path.join(dir, "shared-lock.json")
    const initial: Lock = { version: 2, entries: {} }
    await saveLock(p, initial)
    const left = await loadLock(p)
    const right = await loadLock(p)
    const entry = (assetId: string) => ({
      styleId: "base", assetId, specHash: "h", generator: "map" as const,
      prompt: assetId, width: 32, height: 32, status: "pending" as const,
    })
    upsert(left, "base/alpha", entry("alpha") as never)
    upsert(right, "base/beta", entry("beta") as never)

    await Promise.all([saveLock(p, left), saveLock(p, right)])

    expect(Object.keys((await loadLock(p)).entries).sort()).toEqual(["base/alpha", "base/beta"])
  })

  it("field-merges concurrent updates to the same entry", async () => {
    const p = path.join(dir, "shared-fields.json")
    const initial: Lock = { version: 2, entries: {} }
    upsert(initial, "base/alpha", {
      styleId: "base", assetId: "alpha", specHash: "h", generator: "map", prompt: "p",
      width: 32, height: 32, status: "processing", jobId: "job", sourceUrl: null,
      outputs: [],
    } as never)
    await saveLock(p, initial)
    const left = await loadLock(p)
    const right = await loadLock(p)
    upsert(left, "base/alpha", { status: "selected" })
    upsert(right, "base/alpha", { sourceUrl: "https://x/result.png" })

    await Promise.all([saveLock(p, left), saveLock(p, right)])

    const entry = (await loadLock(p)).entries["base/alpha"]!
    expect(entry.status).toBe("selected")
    expect(entry.sourceUrl).toBe("https://x/result.png")
  })

  it("preserves independent writes from genuinely separate Node processes", async () => {
    const p = path.join(dir, "cross-process.json")
    await saveLock(p, { version: 2, entries: {} })
    const worker = path.join(dir, "lock-worker.mjs")
    const lockModule = pathToFileURL(path.resolve("src/lock.ts")).href
    await writeFile(
      worker,
      `import { loadLock, saveLock, upsert } from ${JSON.stringify(lockModule)};\n` +
        `const [file, asset] = process.argv.slice(2);\n` +
        `const lock = await loadLock(file);\n` +
        `upsert(lock, 'base/' + asset, { styleId: 'base', assetId: asset, specHash: 'h', ` +
        `generator: 'map', prompt: asset, width: 32, height: 32, status: 'pending' });\n` +
        `await new Promise(r => setTimeout(r, 75));\n` +
        `await saveLock(file, lock);\n`,
    )

    await Promise.all([
      execFileAsync(process.execPath, ["--import", "tsx", worker, p, "alpha"]),
      execFileAsync(process.execPath, ["--import", "tsx", worker, p, "beta"]),
    ])

    expect(Object.keys((await loadLock(p)).entries).sort()).toEqual(["base/alpha", "base/beta"])
  })
})

describe("lock removal", () => {
  const entry = (assetId: string) =>
    ({
      styleId: "base", assetId, specHash: "h", generator: "map", prompt: "p",
      width: 32, height: 32, status: "downloaded", jobId: null, sourceUrl: null,
      outputs: [],
    }) as never

  // The reason `remove` has to exist. saveLock merges onto whatever is on disk
  // so a concurrent writer's entries survive, which means deleting a key from
  // lock.entries and saving is a silent no-op: the entry is read straight back
  // off disk. Before this, clearing an entry meant hand-editing the lockfile.
  it("persists a removal instead of reading the entry back off disk", async () => {
    const file = path.join(dir, "lock.json")
    const lock = await loadLock(file)
    upsert(lock, "base/alpha", entry("alpha"))
    upsert(lock, "base/beta", entry("beta"))
    await saveLock(file, lock)
    expect(Object.keys((await loadLock(file)).entries).sort()).toEqual(["base/alpha", "base/beta"])

    expect(remove(lock, "base/alpha")).toBe(true)
    await saveLock(file, lock)

    expect(Object.keys((await loadLock(file)).entries)).toEqual(["base/beta"])
    expect(Object.keys(lock.entries)).toEqual(["base/beta"])
  })

  it("reports whether the key was actually there", async () => {
    const file = path.join(dir, "lock.json")
    const lock = await loadLock(file)
    upsert(lock, "base/alpha", entry("alpha"))
    expect(remove(lock, "base/nope")).toBe(false)
    expect(remove(lock, "base/alpha")).toBe(true)
    await saveLock(file, lock)
    expect(Object.keys((await loadLock(file)).entries)).toEqual([])
  })

  // A removal must not become a licence to clobber. The merge exists so a
  // second process writing a different entry does not lose it.
  it("removes only the named key and keeps an entry another writer added", async () => {
    const file = path.join(dir, "lock.json")
    const lock = await loadLock(file)
    upsert(lock, "base/alpha", entry("alpha"))
    await saveLock(file, lock)

    // Another process appends while we hold a stale in-memory view.
    const other = await loadLock(file)
    upsert(other, "base/gamma", entry("gamma"))
    await saveLock(file, other)

    remove(lock, "base/alpha")
    await saveLock(file, lock)

    // alpha is gone because we asked; gamma survives because we did not.
    expect(Object.keys((await loadLock(file)).entries)).toEqual(["base/gamma"])
  })

  it("cancels a pending removal when the same key is written again", async () => {
    const file = path.join(dir, "lock.json")
    const lock = await loadLock(file)
    upsert(lock, "base/alpha", entry("alpha"))
    await saveLock(file, lock)

    remove(lock, "base/alpha")
    upsert(lock, "base/alpha", { ...(entry("alpha") as object), status: "selected" } as never)
    await saveLock(file, lock)

    const reloaded = await loadLock(file)
    expect(Object.keys(reloaded.entries)).toEqual(["base/alpha"])
    // The re-add wins, and it is the re-added value that landed — not the
    // pre-removal one surviving because the delete quietly did nothing.
    expect(reloaded.entries["base/alpha"]!.status).toBe("selected")
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
    expect(lock.entries["base/anvil"]!.providerMetadata).toEqual({})
    expect(lock.entries["base/anvil"]!.costUnit).toBe("generations")
  })

  it("preserves fractional provider costs and their unit", () => {
    const lock = parseLock({
      version: 2,
      entries: {
        "base/anvil": { ...entry, outputs: [], cost: 0.125, costUnit: "usd" },
      },
    })
    expect(lock.entries["base/anvil"]).toMatchObject({ cost: 0.125, costUnit: "usd" })
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
