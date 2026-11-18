import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import path from "node:path"
import { tmpdir } from "node:os"
import { encodeRgbaPng } from "../src/png.ts"
import { ldtkPattern, ldtkRuleMatches, resolveLdtkTiles, type LdtkRule } from "../src/pipeline/ldtk-export.ts"
import { exportTileset } from "../src/pipeline/tileset-export.ts"
import type { LockEntry, ResolvedSpec } from "../src/types.ts"

let dir: string
beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "pixelkiln-ldtk-"))
})
afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

/** A corner terrain set (the `terrain` generator's shape) with one 4x4 tile per mask, plus any repeated masks. */
async function cornerSet(masks: number[], tileType = "square_topdown", size = 4) {
  const corner = (mask: number, bit: number) => ((mask & (1 << bit)) !== 0 ? "grass" : "water")
  const terrainTiles = masks.map((mask, index) => ({
    role: `tile-${String(index).padStart(2, "0")}-m${mask}`,
    corners: { NW: corner(mask, 3), NE: corner(mask, 2), SW: corner(mask, 1), SE: corner(mask, 0) },
  }))
  const outputs: LockEntry["outputs"] = []
  for (const [index, tile] of terrainTiles.entries()) {
    const pixels = Buffer.alloc(size * size * 4, 20 + index * 7)
    for (let i = 3; i < pixels.length; i += 4) pixels[i] = 255
    // exportTileset resolves paths as `<stem>-<role>.png` from the spec's outFile.
    const file = path.join(dir, `terrain-${tile.role}.png`)
    await writeFile(file, encodeRgbaPng(size, size, pixels))
    outputs.push({ path: file, sha256: String(index), role: tile.role })
  }
  const entry = {
    outputs,
    provider: "pixellab",
    generator: "terrain",
    providerMetadata: { pixellab: { terrainTypes: ["grass", "water"], terrainTiles } },
  } as LockEntry
  const spec = { root: dir, styleId: "ground", assetId: "terrain", generator: "terrain", outFile: path.join(dir, "terrain.png"), tileType } as ResolvedSpec
  return { entry, spec }
}

/** An edge-rule set (`tileRules`, as `tiles` returns), one tile per mask. */
async function edgeSet(masks: number[], tileType = "square_topdown") {
  const outputs: LockEntry["outputs"] = []
  const tiles: Record<string, number> = {}
  for (const [index, mask] of masks.entries()) {
    const role = `tile-${String(index).padStart(2, "0")}`
    const pixels = Buffer.alloc(4 * 4 * 4, 30 + index * 5)
    for (let i = 3; i < pixels.length; i += 4) pixels[i] = 255
    const file = path.join(dir, `roads-${role}.png`)
    await writeFile(file, encodeRgbaPng(4, 4, pixels))
    outputs.push({ path: file, sha256: String(index), role })
    tiles[`tile_${index}`] = mask
  }
  const entry = {
    outputs,
    provider: "pixellab",
    providerMetadata: { pixellab: { tileKind: "tileset", tileRules: { rule_type: "edge", arity: 4, terrains: ["road", "grass"], tiles } } },
  } as LockEntry
  const spec = { root: dir, styleId: "ground", assetId: "roads", generator: "tiles", outFile: path.join(dir, "roads.png"), tileType } as ResolvedSpec
  return { entry, spec }
}

const options = { format: "ldtk" as const, manifestDir: dir, imageName: "terrain-tileset.png" }
const all16 = Array.from({ length: 16 }, (_, mask) => mask)
const exported = async (set: { entry: LockEntry; spec: ResolvedSpec }) =>
  JSON.parse(exportTileset(set.entry, set.spec, { ...options, manifestDir: dir }).document) as Record<string, any> // eslint-disable-line @typescript-eslint/no-explicit-any

const keys = (value: object) => Object.keys(value).sort()

describe("LDtk export", () => {
  it("writes an .ldtk document beside the same atlas as the other formats", async () => {
    const set = await cornerSet(all16)
    const ldtk = exportTileset(set.entry, set.spec, { ...options, manifestDir: dir })
    const generic = exportTileset(set.entry, set.spec, { ...options, manifestDir: dir, format: "generic" })
    expect(ldtk.extension).toBe(".ldtk")
    expect(ldtk.png.equals(generic.png)).toBe(true)
    expect(ldtk.document.endsWith("\n")).toBe(true)
    expect(ldtk.document).toBe(exportTileset(set.entry, set.spec, { ...options, manifestDir: dir }).document)
  })

  it("writes exactly the keys LDtk's own sample projects have", async () => {
    const sample = JSON.parse(await readFile(path.resolve("test/fixtures/ldtk/sample-keys.json"), "utf8")) as Record<string, string[]>
    const project = await exported(await cornerSet(all16))
    const [autoLayer, sourceLayer] = project.defs.layers
    const level = project.levels[0]
    expect(keys(project)).toEqual(sample.root)
    expect(keys(project.__header__)).toEqual(sample.header)
    expect(keys(project.defs)).toEqual(sample.defs)
    expect(keys(sourceLayer)).toEqual(sample.intGridLayerDef)
    expect(keys(autoLayer)).toEqual(sample.autoLayerDef)
    expect(keys(autoLayer.autoRuleGroups[0])).toEqual(sample.ruleGroup)
    expect(keys(autoLayer.autoRuleGroups[0].rules[0])).toEqual(sample.rule)
    expect(keys(sourceLayer.intGridValues[0])).toEqual(sample.intGridValue)
    expect(keys(project.defs.tilesets[0])).toEqual(sample.tilesetDef)
    expect(keys(level)).toEqual(sample.level)
    for (const instance of level.layerInstances) expect(keys(instance)).toEqual(sample.layerInstance)
    expect(keys(level.layerInstances[0].autoLayerTiles[0])).toEqual(sample.autoLayerTile)
    expect(project.jsonVersion).toBe("1.5.3")
  })

  it("describes the atlas as a tileset and keeps every tile's mask", async () => {
    const project = await exported(await cornerSet(all16))
    const tileset = project.defs.tilesets[0]
    // 16 tiles of 4px, packed four across.
    expect(tileset).toMatchObject({ uid: 1, tileGridSize: 4, relPath: "terrain-tileset.png", pxWid: 16, pxHei: 16, __cWid: 4, __cHei: 4, spacing: 0, padding: 0 })
    expect(tileset.customData).toHaveLength(16)
    expect(tileset.customData[5]).toEqual({ tileId: 5, data: "mask=5" })
    expect(project.defs.layers[0].tilesetDefUid).toBe(1)
  })

  it("makes a corner set a dual grid: values on vertices, half a tile up and left", async () => {
    const project = await exported(await cornerSet(all16))
    const [autoLayer, sourceLayer] = project.defs.layers
    expect(sourceLayer).toMatchObject({ __type: "IntGrid", pxOffsetX: -2, pxOffsetY: -2, autoSourceLayerDefUid: null })
    expect(autoLayer).toMatchObject({ __type: "AutoLayer", pxOffsetX: 0, pxOffsetY: 0, autoSourceLayerDefUid: sourceLayer.uid })
    expect(sourceLayer.intGridValues.map((value: { value: number; identifier: string }) => [value.value, value.identifier])).toEqual([[1, "grass"], [2, "water"]])
    // The tile whose NW corner alone is grass reads the cell, then right, below and below-right.
    const rules: LdtkRule[] = autoLayer.autoRuleGroups[0].rules
    const nwOnly = rules.find((rule) => rule.tileRectsIds[0]![0] === 8)!
    expect(nwOnly.pattern).toEqual([0, 0, 0, 0, 1, 2, 0, 2, 2])
    const seOnly = rules.find((rule) => rule.tileRectsIds[0]![0] === 1)!
    expect(seOnly.pattern).toEqual([0, 0, 0, 0, 2, 2, 0, 2, 1])
    expect(ldtkPattern({ ruleType: "corner" }, 15)).toEqual([0, 0, 0, 0, 1, 1, 0, 1, 1])
  })

  it("picks the tile LDtk would for a painted vertex, and for the tile diagonally up-left of it", async () => {
    const project = await exported(await cornerSet(all16))
    const rules: LdtkRule[] = project.defs.layers[0].autoRuleGroups[0].rules
    const cells = new Array<number>(5 * 5).fill(2)
    cells[2 * 5 + 2] = 1 // one grass vertex at (2, 2)
    const hits = resolveLdtkTiles(rules, { width: 5, height: 5, cells })
    const tileAt = (cx: number, cy: number) => hits.find((hit) => hit.cx === cx && hit.cy === cy)!.tile
    expect(tileAt(2, 2)).toBe(8) // the vertex is that tile's NW corner
    expect(tileAt(1, 2)).toBe(4) // its NE corner
    expect(tileAt(2, 1)).toBe(2) // its SW corner
    expect(tileAt(1, 1)).toBe(1) // its SE corner
    expect(tileAt(4, 4)).toBe(0) // far from it, all water
  })

  it("writes a preview level whose tiles are the ones the written rules choose, using every rule", async () => {
    const project = await exported(await cornerSet(all16))
    const level = project.levels[0]
    const [autoInstance, sourceInstance] = level.layerInstances
    const rules: LdtkRule[] = project.defs.layers[0].autoRuleGroups[0].rules
    const grid = { width: level.pxWid / 4, height: level.pxHei / 4, cells: sourceInstance.intGridCsv as number[] }
    expect(grid.cells).toHaveLength(grid.width * grid.height)
    expect(grid.cells.every((value) => value === 1 || value === 2)).toBe(true)
    const resolved = resolveLdtkTiles(JSON.parse(JSON.stringify(rules)), grid)
    expect(autoInstance.autoLayerTiles).toHaveLength(resolved.length)
    expect(resolved).toHaveLength(grid.width * grid.height)
    resolved.forEach((hit, index) => {
      expect(autoInstance.autoLayerTiles[index]).toMatchObject({
        px: [hit.cx * 4, hit.cy * 4],
        t: hit.tile,
        d: [hit.rule.uid, hit.cy * grid.width + hit.cx],
        src: [(hit.tile % 4) * 4, Math.floor(hit.tile / 4) * 4],
      })
    })
    expect(new Set(resolved.map((hit) => hit.rule.uid)).size).toBe(16)
    expect(sourceInstance.__pxTotalOffsetX).toBe(-2)
  })

  it("lists tiles that share a mask as alternatives in one rule", async () => {
    // 16 masks plus two repeats of mask 15 and one of 0, as the 25-tile cliff set has.
    const project = await exported(await cornerSet([...all16, 15, 15, 0]))
    const rules: LdtkRule[] = project.defs.layers[0].autoRuleGroups[0].rules
    expect(rules).toHaveLength(16)
    expect(rules.find((rule) => rule.tileRectsIds.length === 3)!.pattern).toEqual(ldtkPattern({ ruleType: "corner" }, 15))
    expect(rules.find((rule) => rule.tileRectsIds.length === 2)!.tileRectsIds).toEqual([[0], [18]])
    // 19 tiles pack five across and four down; every tile id still fits the grid.
    const tileset = project.defs.tilesets[0]
    expect(tileset.__cWid * tileset.__cHei).toBeGreaterThanOrEqual(19)
    expect(tileset.customData).toHaveLength(19)
  })

  it("reads an edge set by the tile's own cell and its four neighbours, with no shift", async () => {
    const project = await exported(await edgeSet(all16))
    const [autoLayer, sourceLayer] = project.defs.layers
    expect(sourceLayer).toMatchObject({ pxOffsetX: 0, pxOffsetY: 0, identifier: "ground_roads_cells" })
    const rules: LdtkRule[] = autoLayer.autoRuleGroups[0].rules
    // Mask 0b0101: N and S are the first terrain, E and W the second; two of four, so the cell itself counts as first.
    expect(rules.find((rule) => rule.tileRectsIds[0]![0] === 5)!.pattern).toEqual([0, 1, 0, 2, 1, 2, 0, 1, 0])
    // Mask 0b0010: only E; the cell itself is the second terrain.
    expect(rules.find((rule) => rule.tileRectsIds[0]![0] === 2)!.pattern).toEqual([0, 2, 0, 2, 2, 1, 0, 2, 0])
    expect(ldtkPattern({ ruleType: "edge" }, 15)).toEqual([0, 1, 0, 1, 1, 1, 0, 1, 0])
  })

  it("matches patterns the way LDtk does: zero ignored, positive equal, negative not equal, outside the level a set value", () => {
    const grid = { width: 3, height: 3, cells: [1, 2, 1, 2, 1, 2, 1, 2, 1] }
    const rule = (pattern: number[]) => ({ size: 3 as const, pattern, outOfBoundsValue: 2 })
    expect(ldtkRuleMatches(rule([0, 0, 0, 0, 1, 0, 0, 0, 0]), grid, 1, 1)).toBe(true)
    expect(ldtkRuleMatches(rule([0, 0, 0, 0, 2, 0, 0, 0, 0]), grid, 1, 1)).toBe(false)
    expect(ldtkRuleMatches(rule([0, -1, 0, 0, 0, 0, 0, 0, 0]), grid, 1, 1)).toBe(true)
    expect(ldtkRuleMatches(rule([0, -2, 0, 0, 0, 0, 0, 0, 0]), grid, 1, 1)).toBe(false)
    // Cell (0, 0)'s upper-left neighbour is outside and reads as 2.
    expect(ldtkRuleMatches(rule([2, 0, 0, 0, 0, 0, 0, 0, 0]), grid, 0, 0)).toBe(true)
    expect(ldtkRuleMatches(rule([1, 0, 0, 0, 0, 0, 0, 0, 0]), grid, 0, 0)).toBe(false)
  })

  it("is deterministic and carries no timestamp", async () => {
    const first = exportTileset(...(await pair(cornerSet(all16))))
    const second = exportTileset(...(await pair(cornerSet(all16))))
    expect(second.document).toBe(first.document)
    expect(first.document).not.toMatch(/\d{4}-\d{2}-\d{2}T/)
  })

  it("refuses what LDtk cannot hold, and says what to use instead", async () => {
    const run = async (set: { entry: LockEntry; spec: ResolvedSpec }) => exportTileset(set.entry, set.spec, { ...options, manifestDir: dir })
    await expect(run(await cornerSet(all16, "isometric"))).rejects.toThrow(/square tiles on an orthogonal grid.*generic or --format tiled/s)
    const unknown = await cornerSet(all16)
    delete (unknown.spec as { tileType?: string }).tileType
    await expect(run(unknown)).rejects.toThrow(/this set is isometric/)
    const hex = await edgeSet(all16)
    ;(hex.entry.providerMetadata!.pixellab as { tileRules: { arity: number } }).tileRules.arity = 6
    await expect(run(hex)).rejects.toThrow(/six-edge hex/)
    const outline = await edgeSet(all16)
    ;(outline.entry.providerMetadata!.pixellab as { tileRules: { rule_type: string } }).tileRules.rule_type = "outline"
    await expect(run(outline)).rejects.toThrow(/outline/)
  })
})

/** The arguments exportTileset takes, from a freshly built set. */
async function pair(setPromise: Promise<{ entry: LockEntry; spec: ResolvedSpec }>): Promise<[LockEntry, ResolvedSpec, typeof options]> {
  const set = await setPromise
  return [set.entry, set.spec, { ...options, manifestDir: dir }]
}
