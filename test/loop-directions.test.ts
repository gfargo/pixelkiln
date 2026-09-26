import path from "node:path"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { sha256File } from "../src/hash.ts"
import { expandAssetFilter, expandLoopDirections, loopShorthandOf } from "../src/loop-directions.ts"
import { applyManifestEdit } from "../src/manifest-edit.ts"
import { loadManifest, resolveSpecs } from "../src/manifest.ts"
import { CharacterAnimationSchema } from "../src/types.ts"

const base = { prompt: "a knight" }
const shorthand = {
  prompt: "walking",
  category: "walks",
  tags: ["loop"],
  animation: { of: "hero", frames: 8, fps: 12, directions: ["south", "west", "north", "south-west", "north-west"] },
}

describe("expandLoopDirections", () => {
  it("expands one loop per named direction and a mirror for each unnamed flip, in place", () => {
    const { raw, families, issues } = expandLoopDirections({
      name: "t",
      styles: {},
      assets: { hero: base, "hero.walk": shorthand, after: { prompt: "x" } },
    })
    expect(issues).toEqual([])
    const assets = (raw as { assets: Record<string, Record<string, unknown>> }).assets
    expect(Object.keys(assets)).toEqual([
      "hero",
      "hero.walk.south", "hero.walk.west", "hero.walk.north", "hero.walk.south-west", "hero.walk.north-west",
      "hero.walk.east", "hero.walk.south-east", "hero.walk.north-east",
      "after",
    ])
    expect(assets["hero.walk.west"]).toEqual({
      prompt: "walking",
      category: "walks",
      tags: ["loop"],
      animation: { of: "hero", frames: 8, fps: 12, direction: "west" },
    })
    // A mirror flips its source's own files, so it inherits only where it lands.
    expect(assets["hero.walk.east"]).toEqual({ mirror: "hero.walk.west", category: "walks", tags: ["loop"] })
    expect(assets["hero.walk.south-east"]).toEqual({ mirror: "hero.walk.south-west", category: "walks", tags: ["loop"] })
    expect(families["hero.walk"]).toHaveLength(8)
    expect(loopShorthandOf("hero.walk.east", families)).toBe("hero.walk")
    expect(loopShorthandOf("hero", families)).toBeUndefined()
    expect(expandAssetFilter(["hero.walk", "hero"], families)).toEqual([...families["hero.walk"]!, "hero"])
  })

  it("adds no mirror when both sides are named, or for south and north", () => {
    const { raw } = expandLoopDirections({
      assets: { hero: base, "hero.idle": { prompt: "idle", animation: { of: "hero", directions: ["south", "east", "west"] } } },
    })
    expect(Object.keys((raw as { assets: object }).assets)).toEqual(["hero", "hero.idle.south", "hero.idle.east", "hero.idle.west"])
  })

  it("leaves a manifest without the shorthand untouched", () => {
    const manifest = { name: "t", assets: { hero: base } }
    expect(expandLoopDirections(manifest).raw).toBe(manifest)
  })

  it("reports every way the shorthand can be wrong", () => {
    const issues = (animation: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
      expandLoopDirections({ assets: { hero: base, "hero.walk": { prompt: "w", animation: { of: "hero", ...animation }, ...extra } } }).issues
    expect(issues({ directions: [] })[0]).toMatch(/non-empty list of directions/)
    expect(issues({ directions: ["up"] })[0]).toMatch(/non-empty list of directions/)
    expect(issues({ directions: ["west", "west"] })[0]).toMatch(/"west" is listed twice/)
    expect(issues({ directions: ["west"], direction: "west" })[0]).toMatch(/direction and directions are mutually exclusive/)
    expect(issues({ directions: ["west"] }, { file: "walk.png", cell: [0, 0] })[0]).toMatch(/file, cell name one output/)
    const collision = expandLoopDirections({
      assets: { hero: base, "hero.walk.east": { prompt: "x" }, "hero.walk": { prompt: "w", animation: { of: "hero", directions: ["west"] } } },
    }).issues
    expect(collision[0]).toMatch(/expands to "hero.walk.east", which is already declared/)
  })

  it("is refused by the schema if it ever reaches validation unexpanded", () => {
    expect(CharacterAnimationSchema.safeParse({ of: "hero", directions: ["west"] }).success).toBe(false)
  })
})

describe("loading a manifest with loop directions", () => {
  let dir: string
  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "pixelkiln-loop-directions-"))
  })
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  async function write(name: string, assets: Record<string, unknown>) {
    const file = path.join(dir, name)
    await writeFile(file, JSON.stringify({
      name: "loops",
      provider: "pixellab",
      styles: { chars: { generator: "character", size: 48, outDir: "art" } },
      assets,
    }, null, 2) + "\n")
    return file
  }

  it("resolves to exactly the specs the hand-written form does", async () => {
    const short = await loadManifest(await write("short.json", { hero: base, "hero.walk": shorthand }))
    const long = await loadManifest(await write("long.json", expandLoopDirections({ assets: { hero: base, "hero.walk": shorthand } }).raw.assets as never))
    const hashes = async (loaded: typeof short) =>
      Object.fromEntries((await resolveSpecs(loaded)).map((spec) => [spec.assetId, spec.specHash]))
    expect(await hashes(short)).toEqual(await hashes(long))
    expect(short.loopFamilies).toEqual({ "hero.walk": expect.any(Array) })
    expect(long.loopFamilies).toBeUndefined()
  })

  it("selects the whole family with --only <shorthand>, and refuses a bad shorthand at load", async () => {
    const loaded = await loadManifest(await write("m.json", { hero: base, "hero.walk": shorthand }))
    const specs = await resolveSpecs(loaded, { assets: ["hero.walk"] })
    expect(specs.map((spec) => spec.assetId).sort()).toEqual([...loaded.loopFamilies!["hero.walk"]!].sort())
    const east = specs.find((spec) => spec.assetId === "hero.walk.east")!
    expect(east.mirror?.sourceAssetId).toBe("hero.walk.west")
    expect(east.character?.animation?.direction).toBe("east")

    await expect(loadManifest(await write("bad.json", {
      hero: base,
      "hero.walk": { prompt: "w", animation: { of: "hero", directions: ["west"], direction: "east" } },
    }))).rejects.toThrow(/assets\.hero\.walk\.animation: direction and directions are mutually exclusive/)
  })

  it("points a gallery edit of an expanded loop at its shorthand, and accepts a revision of one", async () => {
    const file = await write("m.json", { hero: base, "hero.walk": shorthand })
    await expect(applyManifestEdit(file, {
      action: "patch-asset",
      assetId: "hero.walk.west",
      expectedSha256: await sha256File(file),
      patch: { prompt: "strolling" },
    })).rejects.toThrow(/expanded from "hero\.walk"'s animation\.directions; edit "hero\.walk"/)

    const added = await applyManifestEdit(file, {
      action: "add-asset",
      assetId: "hero.walk.west.caped",
      expectedSha256: await sha256File(file),
      asset: { prompt: "add a cape", revision: { mode: "image-to-image", from: "hero.walk.west" } },
    })
    expect(added.changed).toBe(true)
    const written = JSON.parse(await readFile(file, "utf8")) as { assets: Record<string, unknown> }
    // The shorthand stays a shorthand; only the new asset is added.
    expect(Object.keys(written.assets)).toEqual(["hero", "hero.walk", "hero.walk.west.caped"])
  })
})
