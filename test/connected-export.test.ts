import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { parseArgs } from "../src/cli/args.ts"
import { runExport } from "../src/cli/commands/pack.ts"
import { loadManifest, resolveSpecs } from "../src/manifest.ts"
import { memberPath } from "../src/outputs.ts"
import { encodeRgbaPng } from "../src/png.ts"
import { connectedGroup } from "../src/pipeline/connected-sets.ts"
import { resolveLdtkTiles, type LdtkRule } from "../src/pipeline/ldtk-export.ts"
import type { Lock } from "../src/types.ts"

let dir: string
let quiet: ReturnType<typeof vi.spyOn>

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "pixelkiln-connected-"))
  quiet = vi.spyOn(console, "log").mockImplementation(() => {})
})
afterEach(async () => {
  quiet.mockRestore()
  await rm(dir, { recursive: true, force: true })
})

/**
 * Three connected terrain sets in one style, the way a coast is built up: the
 * coast draws ocean against sand, the meadow sand against grass, the forest
 * grass against forest floor. Each is a full 16-tile set, as PixelLab returns
 * it: `terrainTypes` is `["lower", "upper"]` and each corner names one of them.
 */
async function connectedProject(options: { skip?: string[]; pond?: boolean } = {}) {
  const manifestPath = path.join(dir, "pixelkiln.manifest.json")
  await writeFile(manifestPath, JSON.stringify({
    name: "test",
    styles: { ground: { outDir: "out", generator: "terrain" } },
    assets: {
      coast: { prompt: "1). deep ocean water, small waves 2). golden sand" },
      meadow: { prompt: "1). golden sand 2). green grass", connect: { lower: { of: "coast", terrain: "upper" } } },
      forest: { prompt: "1). green grass 2). dark forest floor", connect: { lower: { of: "meadow", terrain: "upper" } } },
      ...(options.pond ? { pond: { prompt: "1). pond water 2). reeds" } } : {}),
    },
  }))
  const loaded = await loadManifest(manifestPath)
  const specs = await resolveSpecs(loaded)
  const entries: Record<string, unknown> = {}
  for (const spec of specs) {
    if (options.skip?.includes(spec.assetId)) continue
    await mkdir(path.dirname(spec.outFile), { recursive: true })
    // Tile `mask` has a corner on its first terrain ("lower") where the bit is set: NW, NE, SW, SE = bits 3, 2, 1, 0.
    const side = (mask: number, bit: number) => ((mask & (1 << bit)) !== 0 ? "lower" : "upper")
    const terrainTiles = Array.from({ length: 16 }, (_, mask) => ({
      role: `tile-${String(mask).padStart(2, "0")}-m${mask}`,
      corners: { NW: side(mask, 3), NE: side(mask, 2), SW: side(mask, 1), SE: side(mask, 0) },
    }))
    const outputs = []
    for (const [index, tile] of terrainTiles.entries()) {
      const pixels = Buffer.alloc(4 * 4 * 4, 10 + index * 9)
      for (let i = 3; i < pixels.length; i += 4) pixels[i] = 255
      const file = memberPath(spec.outFile, tile.role, index, terrainTiles.length)
      await writeFile(file, encodeRgbaPng(4, 4, pixels))
      outputs.push({ path: file, sha256: `${spec.assetId}${index}`, role: tile.role })
    }
    entries[`ground/${spec.assetId}`] = {
      styleId: "ground",
      assetId: spec.assetId,
      specHash: spec.specHash,
      generator: "terrain",
      prompt: spec.prompt,
      width: spec.width,
      height: spec.height,
      status: "downloaded",
      outputs,
      provider: "pixellab",
      providerMetadata: { pixellab: { terrainTypes: ["lower", "upper"], terrainTiles } },
    }
  }
  const lock = { version: 2, entries } as unknown as Lock
  const lockPath = path.join(dir, "pixelkiln.lock.json")
  await writeFile(lockPath, JSON.stringify(lock))
  return { manifestPath, lockPath, specs }
}

async function exportMerged(format: string, extra: string[] = []) {
  const { manifestPath, lockPath } = await connectedProject()
  const out = path.join(dir, "merged")
  await runExport(parseArgs([
    "export", "--manifest", manifestPath, "--lock", lockPath, "--style", "ground",
    "--format", format, "--merge-connected", "--out", out, ...extra,
  ]))
  return out
}

describe("connectedGroup", () => {
  it("collects every set linked either way, each after the sets it connects to", async () => {
    const { specs } = await connectedProject()
    const byName = (id: string) => specs.find((spec) => spec.assetId === id)!
    for (const start of ["coast", "meadow", "forest"]) {
      expect(connectedGroup(byName(start), specs).map((spec) => spec.assetId)).toEqual(["coast", "meadow", "forest"])
    }
  })

  it("leaves a set with no links alone", async () => {
    const { specs } = await connectedProject({ pond: true })
    expect(connectedGroup(specs.find((spec) => spec.assetId === "pond")!, specs).map((spec) => spec.assetId)).toEqual(["pond"])
  })
})

describe("export --merge-connected", () => {
  it("writes one generic tileset naming every terrain once, from the set that describes it", async () => {
    const out = await exportMerged("generic")
    const generic = JSON.parse(await readFile(`${out}.json`, "utf8"))
    expect(generic.sets).toEqual(["coast", "meadow", "forest"])
    expect(generic.rules.terrains).toEqual(["deep ocean water", "golden sand", "green grass", "dark forest floor"])
    expect(generic.tiles).toHaveLength(48)
    expect(new Set(generic.tiles.map((tile: { role: string }) => tile.role)).size).toBe(48)
    const corners = (role: string) => generic.tiles.find((tile: { role: string }) => tile.role === role).corners
    expect(corners("coast/tile-15-m15")).toEqual([0, 0, 0, 0]) // all ocean
    expect(corners("coast/tile-00-m0")).toEqual([1, 1, 1, 1]) // all sand
    expect(corners("meadow/tile-15-m15")).toEqual([1, 1, 1, 1]) // the same sand
    expect(corners("meadow/tile-08-m8")).toEqual([1, 2, 2, 2]) // sand at NW, grass elsewhere
    expect(corners("forest/tile-00-m0")).toEqual([3, 3, 3, 3])
    expect(generic.tiles.every((tile: { stampOnly: boolean }) => !tile.stampOnly)).toBe(true)
  })

  it("is written as the tiles' own file with a record naming the sets", async () => {
    const out = await exportMerged("tiled")
    const record = JSON.parse(await readFile(`${out}.pixelkiln.json`, "utf8"))
    expect(record.kind).toBe("tileset")
    expect(record.options).toMatchObject({ asset: "coast+meadow+forest", sets: ["coast", "meadow", "forest"], format: "tiled" })
    expect((await readFile(`${out}.png`)).length).toBeGreaterThan(0)
  })

  it("makes a Tiled Wang set with a color for each terrain", async () => {
    const out = await exportMerged("tiled")
    const tileset = JSON.parse(await readFile(`${out}.tsj`, "utf8"))
    const [wang] = tileset.wangsets
    expect(wang.colors.map((color: { name: string }) => color.name)).toEqual(["deep ocean water", "golden sand", "green grass", "dark forest floor"])
    expect(new Set(wang.colors.map((color: { color: string }) => color.color)).size).toBe(4)
    expect(wang.colors.every((color: { tile: number }) => color.tile >= 0)).toBe(true)
    expect(wang.wangtiles).toHaveLength(48)
    // meadow/tile-08: NW sand (color 2), the other corners grass (color 3). Tiled's order: top, NE, right, SE, bottom, SW, left, NW.
    const meadow8 = tileset.tilecount && wang.wangtiles[16 + 8]
    expect(meadow8.wangid).toEqual([0, 3, 0, 3, 0, 3, 0, 2])
    expect(tileset.tilecount).toBe(48)
  })

  it("makes a Godot terrain set with four terrains and peering bits that name them", async () => {
    const out = await exportMerged("godot")
    const tres = await readFile(`${out}.tres`, "utf8")
    expect(tres).toMatch(/terrain_set_0\/mode = 1/)
    for (const [index, name] of ["deep ocean water", "golden sand", "green grass", "dark forest floor"].entries()) {
      expect(tres).toContain(`terrain_set_0/terrain_${index}/name = "${name}"`)
    }
    expect(tres).toMatch(/terrain_set_0\/terrain_3\/color = Color\(/)
    // Tile 16 + 8 is the meadow tile with sand at NW: terrain 1 there, terrain 2 at the rest.
    const atlas = tres.split("\n").filter((line) => /^\d+:\d+\/0\//.test(line))
    const columns = 7 // 48 tiles pack into a near-square 7 across
    const cell = `${(16 + 8) % columns}:${Math.floor((16 + 8) / columns)}/0`
    expect(atlas).toContain(`${cell}/terrains_peering_bit/top_left_corner = 1`)
    expect(atlas).toContain(`${cell}/terrains_peering_bit/bottom_right_corner = 2`)
    expect(atlas).toContain(`${cell}/terrain = 2`)
  })

  it("makes an LDtk project with a value per terrain and a rule for each way two meet", async () => {
    const out = await exportMerged("ldtk")
    const project = JSON.parse(await readFile(`${out}.ldtk`, "utf8"))
    const [autoLayer, sourceLayer] = project.defs.layers
    expect(sourceLayer.intGridValues.map((value: { value: number; identifier: string }) => [value.value, value.identifier])).toEqual([
      [1, "deep_ocean_water"], [2, "golden_sand"], [3, "green_grass"], [4, "dark_forest_floor"],
    ])
    expect(sourceLayer.intGridValues.every((value: { tile: unknown }) => value.tile !== null)).toBe(true)
    const rules: LdtkRule[] = autoLayer.autoRuleGroups[0].rules
    // 48 tiles, but sand-all and grass-all are drawn by two sets each, so those share a rule.
    expect(rules).toHaveLength(46)
    expect(rules.filter((rule) => rule.tileRectsIds.length === 2)).toHaveLength(2)
    expect(rules.every((rule) => rule.outOfBoundsValue === 1)).toBe(true)
    // A tile with sand at NW and grass around it reads value 2 at the cell and 3 on the three it meets.
    const meadow8 = rules.find((rule) => rule.tileRectsIds[0]![0] === 16 + 8)!
    expect(meadow8.pattern).toEqual([0, 0, 0, 0, 2, 3, 0, 3, 3])
  })

  it("paints a preview that only joins terrains a set joins, and that LDtk would draw as written", async () => {
    const out = await exportMerged("ldtk")
    const project = JSON.parse(await readFile(`${out}.ldtk`, "utf8"))
    const level = project.levels[0]
    const [autoInstance, sourceInstance] = level.layerInstances
    const rules: LdtkRule[] = project.defs.layers[0].autoRuleGroups[0].rules
    const width = level.pxWid / 4
    const height = level.pxHei / 4
    const grid = { width, height, cells: sourceInstance.intGridCsv as number[] }
    expect(grid.cells.every((value) => value >= 1 && value <= 4)).toBe(true)
    const resolved = resolveLdtkTiles(JSON.parse(JSON.stringify(rules)), grid)
    // Every cell has a tile: no two terrains meet that no tile joins, even at the level's edge.
    expect(resolved).toHaveLength(width * height)
    expect(autoInstance.autoLayerTiles).toHaveLength(resolved.length)
    resolved.forEach((hit, index) => {
      expect(autoInstance.autoLayerTiles[index]).toMatchObject({ px: [hit.cx * 4, hit.cy * 4], t: hit.tile, d: [hit.rule.uid, hit.cy * width + hit.cx] })
    })
    // And it shows all four terrains and every rule.
    expect(new Set(grid.cells).size).toBe(4)
    expect(new Set(resolved.map((hit) => hit.rule.uid)).size).toBeGreaterThanOrEqual(46)
  })

  it("is deterministic", async () => {
    const first = await readFile(`${await exportMerged("ldtk")}.ldtk`, "utf8")
    await rm(dir, { recursive: true, force: true })
    await mkdir(dir, { recursive: true })
    const second = await readFile(`${await exportMerged("ldtk")}.ldtk`, "utf8")
    expect(second).toBe(first)
  })

  it("warns, naming the set and tile, when a tile's role is not in its set's terrainTiles", async () => {
    const { manifestPath, lockPath } = await connectedProject()
    const lock = JSON.parse(await readFile(lockPath, "utf8"))
    lock.entries["ground/meadow"].providerMetadata.pixellab.terrainTiles[5].role = "tile-05-renamed"
    await writeFile(lockPath, JSON.stringify(lock))
    await runExport(parseArgs([
      "export", "--manifest", manifestPath, "--lock", lockPath, "--style", "ground",
      "--format", "godot", "--merge-connected", "--out", path.join(dir, "merged"),
    ]))
    const printed = quiet.mock.calls.map((call) => String(call[0]))
    expect(printed.filter((line) => line.includes("warning:"))).toEqual([
      expect.stringMatching(/warning: ground\/meadow: 1 tile\(s\) have a role that is not in the lock's terrainTiles \(tile-05-m5\)/),
    ])
  })

  it("prints no warning when every role is found", async () => {
    await exportMerged("godot")
    expect(quiet.mock.calls.some((call) => String(call[0]).includes("warning:"))).toBe(false)
  })

  it("pulls in the whole group when only one set is named, under a name made of all of them", async () => {
    const { manifestPath, lockPath } = await connectedProject()
    await runExport(parseArgs([
      "export", "--manifest", manifestPath, "--lock", lockPath, "--only", "meadow", "--format", "generic", "--merge-connected",
    ]))
    const generic = JSON.parse(await readFile(path.join(dir, "out", "coast-meadow-forest-tileset.json"), "utf8"))
    expect(generic.sets).toEqual(["coast", "meadow", "forest"])
  })

  it("still writes one tileset per set without the flag", async () => {
    const { manifestPath, lockPath } = await connectedProject()
    await runExport(parseArgs(["export", "--manifest", manifestPath, "--lock", lockPath, "--style", "ground", "--format", "generic"]))
    for (const id of ["coast", "meadow", "forest"]) {
      const generic = JSON.parse(await readFile(path.join(dir, "out", `${id}-tileset.json`), "utf8"))
      expect(generic.sets).toBeUndefined()
      expect(generic.tiles).toHaveLength(16)
    }
  })

  it("stops, naming the set, when a connected set has not been generated", async () => {
    const { manifestPath, lockPath } = await connectedProject({ skip: ["forest"] })
    await expect(runExport(parseArgs([
      "export", "--manifest", manifestPath, "--lock", lockPath, "--only", "coast", "--format", "generic", "--merge-connected",
    ]))).rejects.toThrow(/connected to forest, which has not been generated/)
  })

  it("keeps --out to one tileset", async () => {
    const { manifestPath, lockPath } = await connectedProject()
    // The group is one tileset, so --out is fine for it; two unrelated sets would not be.
    await runExport(parseArgs([
      "export", "--manifest", manifestPath, "--lock", lockPath, "--style", "ground", "--format", "generic", "--merge-connected", "--out", path.join(dir, "one"),
    ]))
    expect((await readFile(path.join(dir, "one.json"), "utf8")).length).toBeGreaterThan(0)
  })
})
