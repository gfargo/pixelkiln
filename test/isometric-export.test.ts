import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import path from "node:path"
import { tmpdir } from "node:os"
import { encodeRgbaPng } from "../src/png.ts"
import { exportTileset, isometricFootprint } from "../src/pipeline/tileset-export.ts"
import type { LockEntry, ResolvedSpec } from "../src/types.ts"

let dir: string
beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "pixelkiln-iso-"))
})
afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

/**
 * A tile as PixelLab draws an isometric one: a 2:1 diamond `width` wide with
 * its apex `top` rows down, and the sides of the block hanging `thickness`
 * rows below it, in an image `height` tall.
 */
function diamondTile(width: number, height: number, top: number, thickness: number, shade = 200) {
  const rgba = Buffer.alloc(width * height * 4, 0)
  const rows = width / 2
  const bottom: number[] = []
  for (let y = 0; y < rows; y++) {
    const rowWidth = y < rows / 2 ? (width / (rows / 2)) * (y + 1) : (width / (rows / 2)) * (rows - y)
    for (let x = width / 2 - rowWidth / 2; x < width / 2 + rowWidth / 2; x++) {
      rgba.set([shade, 0, 0, 255], ((top + y) * width + x) * 4)
      bottom[x] = Math.max(bottom[x] ?? 0, y)
    }
  }
  bottom.forEach((b, x) => {
    for (let y = b + 1; y <= b + thickness && top + y < height; y++) rgba.set([60, 60, 60, 255], ((top + y) * width + x) * 4)
  })
  return encodeRgbaPng(width, height, rgba)
}

const filled = (width: number, height: number) => {
  const rgba = Buffer.alloc(width * height * 4, 150)
  for (let i = 3; i < rgba.length; i += 4) rgba[i] = 255
  return encodeRgbaPng(width, height, rgba)
}

async function set(tileType: string, image: () => Buffer) {
  const outputs: LockEntry["outputs"] = []
  const tiles: Record<string, number> = {}
  for (let index = 0; index < 4; index++) {
    const role = `tile-0${index}`
    const file = path.join(dir, `iso-${role}.png`)
    await writeFile(file, image())
    outputs.push({ path: file, sha256: String(index), role })
    tiles[`tile_${index}`] = [0, 1, 8, 15][index]!
  }
  const entry = {
    outputs,
    provider: "pixellab",
    providerMetadata: { pixellab: { tileKind: "tileset", tileRules: { rule_type: "corner", arity: 4, terrains: ["grass", "water"], tiles } } },
  } as LockEntry
  const spec = { root: dir, styleId: "g", assetId: "iso", generator: "tiles", outFile: path.join(dir, "iso.png"), tileType } as ResolvedSpec
  const run = (format: "generic" | "godot" | "tiled") => exportTileset(entry, spec, { format, manifestDir: dir, imageName: "iso.png", columns: 2 })
  return { run }
}

describe("isometricFootprint", () => {
  it("finds the 32x16 diamond at the top of a 32x24 tile", () => {
    expect(isometricFootprint(diamondTile(32, 24, 0, 8), [{ x: 0, y: 0, width: 32, height: 24 }])).toEqual({ x: 0, y: 0, width: 32, height: 16 })
  })

  it("finds a diamond that does not start on the first row", () => {
    const image = diamondTile(32, 32, 8, 0)
    expect(isometricFootprint(image, [{ x: 0, y: 0, width: 32, height: 32 }])).toEqual({ x: 0, y: 8, width: 32, height: 16 })
  })

  it("finds the diamond in real PixelLab tiles of two shapes", async () => {
    // Generated 18 November 2026 (docs/ENDPOINTS.md, "Isometric tiles, measured").
    // A 32px ground tile is a 2:1 diamond at the top of the image; a 48px road
    // tile is a flatter 3:1 diamond that starts on row 12.
    const ground = await readFile(path.resolve("test/fixtures/isometric/ground-32x24.png"))
    const road = await readFile(path.resolve("test/fixtures/isometric/road-48x48.png"))
    expect(isometricFootprint(ground, [{ x: 0, y: 0, width: 32, height: 24 }])).toEqual({ x: 0, y: 0, width: 32, height: 16 })
    expect(isometricFootprint(road, [{ x: 0, y: 0, width: 48, height: 48 }])).toEqual({ x: 0, y: 12, width: 48, height: 16 })
  })

  it("finds nothing in a filled square", () => {
    expect(isometricFootprint(filled(32, 32), [{ x: 0, y: 0, width: 32, height: 32 }])).toBeNull()
  })
})

describe("isometric export geometry", () => {
  it("records the diamond in the generic file", async () => {
    const { run } = await set("isometric", () => diamondTile(32, 24, 0, 8))
    expect(run("generic").generic.footprint).toEqual({ x: 0, y: 0, width: 32, height: 16 })
  })

  it("gives Godot the diamond as its cell, the image moved onto it, and a diamond layout", async () => {
    const { run } = await set("isometric", () => diamondTile(32, 24, 0, 8))
    const tres = run("godot").document
    expect(tres).toContain("texture_region_size = Vector2i(32, 24)")
    expect(tres).toContain("tile_size = Vector2i(32, 16)")
    expect(tres).toContain("tile_shape = 1")
    expect(tres).toContain("tile_layout = 5")
    // The diamond's centre is 4px above the image's, so the image moves up 4.
    for (const cell of ["0:0", "1:0", "0:1", "1:1"]) expect(tres).toContain(`${cell}/0/texture_origin = Vector2i(0, -4)`)
  })

  it("leaves the image alone when its diamond is already centred", async () => {
    const { run } = await set("isometric", () => diamondTile(32, 32, 8, 0))
    const tres = run("godot").document
    expect(tres).toContain("tile_size = Vector2i(32, 16)")
    expect(tres).not.toContain("texture_origin")
  })

  it("gives Tiled an isometric grid and the offset that lowers the diamond onto its cell", async () => {
    const { run } = await set("isometric", () => diamondTile(32, 24, 0, 8))
    const tiled = JSON.parse(run("tiled").document)
    expect(tiled.grid).toEqual({ orientation: "isometric", width: 32, height: 16 })
    expect(tiled.tileoffset).toEqual({ x: 0, y: 8 })
    expect(tiled.tilewidth).toBe(32)
    expect(tiled.tileheight).toBe(24)
  })

  it("writes no geometry for tiles that are filled squares, but still lays Godot out as a diamond", async () => {
    const { run } = await set("isometric", () => filled(16, 16))
    expect(run("generic").generic.footprint).toBeUndefined()
    const tres = run("godot").document
    expect(tres).toContain("tile_size = Vector2i(16, 16)")
    expect(tres).toContain("tile_layout = 5")
    expect(tres).not.toContain("texture_origin")
    expect(JSON.parse(run("tiled").document).grid).toBeUndefined()
  })

  it("leaves a square top-down set exactly as it was", async () => {
    const { run } = await set("square_topdown", () => filled(16, 16))
    const tres = run("godot").document
    expect(tres).not.toContain("tile_layout")
    expect(tres).not.toContain("texture_origin")
    expect(tres).not.toContain("tile_shape")
    const tiled = JSON.parse(run("tiled").document)
    expect(tiled.grid).toBeUndefined()
    expect(tiled.tileoffset).toBeUndefined()
  })

  it("finds no diamond on an oblique set", async () => {
    const { run } = await set("oblique", () => diamondTile(32, 24, 0, 8))
    expect(run("generic").generic.footprint).toBeUndefined()
  })
})
