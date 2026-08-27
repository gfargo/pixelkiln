import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import path from "node:path"
import { tmpdir } from "node:os"
import { encodeRgbaPng, decodePng } from "../src/png.ts"
import { exportTileset, normalizeTileRules } from "../src/pipeline/tileset-export.ts"
import type { LockEntry, ResolvedSpec } from "../src/types.ts"

const fixtures = path.resolve("test/fixtures/tileset")
let dir: string

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "pixelkiln-tileset-export-"))
})
afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

async function setup() {
  const rules = JSON.parse(await readFile(path.join(fixtures, "tile-rules.json"), "utf8"))
  const outputs: LockEntry["outputs"] = []
  for (let index = 0; index < 4; index++) {
    const pixels = Buffer.alloc(4 * 4 * 4, index * 40)
    for (let i = 3; i < pixels.length; i += 4) pixels[i] = 255
    const file = path.join(dir, `terrain-tile-0${index}.png`)
    await writeFile(file, encodeRgbaPng(4, 4, pixels))
    outputs.push({ path: file, sha256: String(index), role: `tile-0${index}` })
  }
  const entry = {
    outputs,
    provider: "pixellab",
    providerMetadata: { pixellab: { tileKind: "tileset", tileRules: rules } },
  } as LockEntry
  const spec = {
    root: dir,
    styleId: "ground",
    assetId: "terrain",
    generator: "tiles",
    outFile: path.join(dir, "terrain.png"),
    tileType: "square_topdown",
  } as ResolvedSpec
  return { entry, spec, rules }
}

describe("normalizeTileRules", () => {
  it("accepts direct and wrapped bitmasks from the provider's open schema", async () => {
    const { rules } = await setup()
    expect(normalizeTileRules(rules)).toMatchObject({
      ruleType: "corner",
      arity: 4,
      connectivity: "other",
      terrains: ["grass", "water"],
      masks: { 0: 0, 1: 1, 2: 8, 3: 15 },
    })
  })

  it("does not invent semantics for an unknown rule shape", () => {
    expect(normalizeTileRules({ rule_type: "mystery", arity: 9 })).toBeNull()
  })
})

describe("exportTileset", () => {
  it("builds a provider-ordered generic atlas and retains raw rules", async () => {
    const { entry, spec, rules } = await setup()
    const result = exportTileset(entry, spec, {
      format: "generic",
      manifestDir: dir,
      imageName: "terrain.png",
      columns: 2,
    })
    expect(result.generic.tiles.map((tile) => [tile.role, tile.bitmask])).toEqual([
      ["tile-00", 0], ["tile-01", 1], ["tile-02", 8], ["tile-03", 15],
    ])
    expect(result.generic.rules?.raw).toEqual(rules)
    expect(result.generic.providerRules).toEqual(rules)
    expect(decodePng(result.png)).toMatchObject({ width: 8, height: 8 })
  })

  it("maps rules by original provider index when output roles contain gaps", async () => {
    const { entry, spec } = await setup()
    await writeFile(
      path.join(dir, "terrain-tile-07.png"),
      await readFile(entry.outputs[1]!.path),
    )
    entry.outputs = [
      { ...entry.outputs[0]!, role: "tile-02" },
      { ...entry.outputs[1]!, role: "tile-07" },
    ]
    entry.providerMetadata.pixellab!.tileRules = {
      rule_type: "corner",
      arity: 4,
      terrains: ["grass", "water"],
      tiles: { tile_2: 8, tile_7: 15 },
    }

    const result = exportTileset(entry, spec, {
      format: "generic", manifestDir: dir, imageName: "terrain.png",
    })

    expect(result.generic.tiles.map((tile) => [tile.id, tile.sourceIndex, tile.bitmask]))
      .toEqual([[0, 2, 8], [1, 7, 15]])
  })

  it("matches the Tiled Wang-set fixture", async () => {
    const { entry, spec } = await setup()
    const result = exportTileset(entry, spec, {
      format: "tiled", manifestDir: dir, imageName: "terrain.png", columns: 2,
    })
    expect(result.document).toBe(await readFile(path.join(fixtures, "expected.tsj"), "utf8"))
  })

  it("matches the Godot 4 TileSet fixture", async () => {
    const { entry, spec } = await setup()
    const result = exportTileset(entry, spec, {
      format: "godot", manifestDir: dir, imageName: "terrain.png", columns: 2,
    })
    expect(result.document).toBe(await readFile(path.join(fixtures, "expected.tres"), "utf8"))
  })

  it("rejects engine-specific six-edge masks without losing the generic export", async () => {
    const { entry, spec } = await setup()
    entry.providerMetadata.pixellab!.tileRules = {
      rule_type: "edge", arity: 6, terrains: ["coast", "water"], tiles: { tile_0: 0 },
    }
    expect(() => exportTileset(entry, spec, {
      format: "tiled", manifestDir: dir, imageName: "terrain.png",
    })).toThrow(/six-edge hex masks.*generic/)
    expect(() => exportTileset(entry, spec, {
      format: "generic", manifestDir: dir, imageName: "terrain.png",
    })).not.toThrow()
  })

  it("retains an unknown provider rule family generically and blocks lossy engine output", async () => {
    const { entry, spec } = await setup()
    const unknown = { rule_type: "future-grid", arity: 9, tiles: { tile_0: 123 } }
    entry.providerMetadata.pixellab!.tileRules = unknown

    const generic = exportTileset(entry, spec, {
      format: "generic", manifestDir: dir, imageName: "terrain.png",
    })
    expect(generic.generic.providerRules).toEqual(unknown)
    expect(generic.generic.rules).toBeNull()
    expect(() => exportTileset(entry, spec, {
      format: "godot", manifestDir: dir, imageName: "terrain.png",
    })).toThrow(/recognized adjacency rules.*generic/)
  })
})
