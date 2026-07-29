import { describe, expect, it, beforeEach, afterEach } from "vitest"
import { mkdtemp, mkdir, writeFile, rm, readFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { pngSize, slugify, scanAssets, buildManifest } from "../src/pipeline/init.ts"
import { ManifestSchema, lockKey, type Lock } from "../src/types.ts"
import { buildPlan } from "../src/pipeline/plan.ts"
import { loadManifest, resolveSpecs } from "../src/manifest.ts"
import { upsert } from "../src/lock.ts"

/** Builds a real PNG header for a given size so dimension parsing is exercised. */
function png(width: number, height: number): Buffer {
  const ihdr = Buffer.alloc(25)
  ihdr.writeUInt32BE(13, 0)
  ihdr.write("IHDR", 4)
  ihdr.writeUInt32BE(width, 8)
  ihdr.writeUInt32BE(height, 12)
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  return Buffer.concat([sig, ihdr])
}

let dir: string
beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "pixelkiln-init-"))
})
afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

describe("pngSize", () => {
  it("reads non-square dimensions", () => {
    expect(pngSize(png(32, 96))).toEqual({ width: 32, height: 96 })
  })
  it("returns null for non-PNG data", () => {
    expect(pngSize(Buffer.from("not a png at all, really"))).toBeNull()
  })
  it("returns null for a truncated file", () => {
    expect(pngSize(Buffer.from([0x89, 0x50]))).toBeNull()
  })
})

describe("slugify", () => {
  it("normalises filenames to ids", () => {
    expect(slugify("Pine Tree-Tall.png")).toBe("pine_tree_tall")
    expect(slugify("fence_v_iso.png")).toBe("fence_v_iso")
  })
})

describe("scanAssets", () => {
  it("records category and dimensions from the tree", async () => {
    await mkdir(path.join(dir, "trees"), { recursive: true })
    await writeFile(path.join(dir, "trees", "pine.png"), png(32, 96))
    await writeFile(path.join(dir, "rock.png"), png(32, 36))

    const { assets } = await scanAssets(dir)
    const pine = assets.find((a) => a.id === "pine")!
    expect(pine.category).toBe("trees")
    expect([pine.width, pine.height]).toEqual([32, 96])
    expect(assets.find((a) => a.id === "rock")!.category).toBe("")
  })

  it("honours excludes", async () => {
    await mkdir(path.join(dir, "characters"), { recursive: true })
    await writeFile(path.join(dir, "characters", "hero.png"), png(48, 48))
    await writeFile(path.join(dir, "rock.png"), png(32, 32))

    const { assets } = await scanAssets(dir, { exclude: ["characters"] })
    expect(assets.map((a) => a.id)).toEqual(["rock"])
  })

  // Basenames repeat across category folders in real trees.
  it("disambiguates duplicate basenames instead of dropping one", async () => {
    await mkdir(path.join(dir, "a"), { recursive: true })
    await mkdir(path.join(dir, "b"), { recursive: true })
    await writeFile(path.join(dir, "a", "tree.png"), png(32, 32))
    await writeFile(path.join(dir, "b", "tree.png"), png(32, 32))

    const { assets } = await scanAssets(dir)
    expect(assets).toHaveLength(2)
    expect(new Set(assets.map((a) => a.id)).size).toBe(2)
  })

  it("reports unreadable files rather than silently skipping", async () => {
    await writeFile(path.join(dir, "broken.png"), Buffer.from("nope"))
    const { assets, skipped } = await scanAssets(dir)
    expect(assets).toHaveLength(0)
    expect(skipped).toHaveLength(1)
  })
})

describe("buildManifest", () => {
  it("produces a manifest that validates and keeps per-asset sizes", async () => {
    await mkdir(path.join(dir, "trees"), { recursive: true })
    await writeFile(path.join(dir, "trees", "pine.png"), png(32, 96))
    await writeFile(path.join(dir, "rock.png"), png(32, 36))

    const { assets } = await scanAssets(dir)
    const manifest = buildManifest("game", "base", "map", "assets", assets)

    expect(ManifestSchema.safeParse(manifest).success).toBe(true)
    expect(manifest.assets.pine!.width).toBe(32)
    expect(manifest.assets.pine!.height).toBe(96)
    // Prompts stay empty so `adopt --write-prompts` can recover the real ones.
    expect(manifest.assets.pine!.prompt).toBe("")
  })
})

describe("untracked vs missing", () => {
  it("separates art that exists from art that does not", async () => {
    const outDir = path.join(dir, "out")
    await mkdir(outDir, { recursive: true })
    const manifest = {
      name: "t",
      styles: { base: { generator: "1dir", size: 64, outDir: "out" } },
      assets: { present: { prompt: "a" }, absent: { prompt: "b" } },
    }
    await writeFile(path.join(dir, "m.json"), JSON.stringify(manifest))
    const specs = await resolveSpecs(await loadManifest(path.join(dir, "m.json")))

    const present = specs.find((s) => s.assetId === "present")!
    await writeFile(present.outFile, png(64, 64))

    const plan = await buildPlan(specs, { version: 2, entries: {} })
    expect(plan.items.find((i) => i.spec.assetId === "present")!.state).toBe("untracked")
    expect(plan.items.find((i) => i.spec.assetId === "absent")!.state).toBe("missing")

    // Only the genuinely absent asset is billed; existing art is not regenerated.
    expect(plan.actionable.map((i) => i.spec.assetId)).toEqual(["absent"])
  })

  it("still bills untracked art when --force is given", async () => {
    const outDir = path.join(dir, "out")
    await mkdir(outDir, { recursive: true })
    const manifest = {
      name: "t",
      styles: { base: { generator: "1dir", size: 64, outDir: "out" } },
      assets: { present: { prompt: "a" } },
    }
    await writeFile(path.join(dir, "m.json"), JSON.stringify(manifest))
    const specs = await resolveSpecs(await loadManifest(path.join(dir, "m.json")))
    await writeFile(specs[0]!.outFile, png(64, 64))

    const plan = await buildPlan(specs, { version: 2, entries: {} }, { force: true })
    expect(plan.actionable).toHaveLength(1)
  })
})
