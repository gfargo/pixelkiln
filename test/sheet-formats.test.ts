import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { execFile } from "node:child_process"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { promisify } from "node:util"
import { packStyle } from "../src/pipeline/pack.ts"
import { renderAsepriteSheet, renderGodotSpriteFrames, renderSheetDocument, type SheetAtlas } from "../src/pipeline/sheet-formats.ts"
import { encodeRgbaPng } from "../src/png.ts"
import { parseArgs } from "../src/cli/args.ts"
import type { Lock } from "../src/types.ts"

const execFileAsync = promisify(execFile)

const atlas: SheetAtlas = {
  style: "hero",
  sheet: { width: 96, height: 64 },
  cell: { width: 32, height: 32 },
  frames: [
    { id: "anvil", x: 0, y: 0, width: 32, height: 32 },
    { id: "dancer/frame-00", x: 32, y: 0, width: 32, height: 32 },
    { id: "dancer/frame-01", x: 64, y: 0, width: 32, height: 32 },
    { id: "dancer/frame-02", x: 0, y: 32, width: 32, height: 32 },
    { id: "ground/tile-00", x: 32, y: 32, width: 16, height: 16 },
    { id: "ground/tile-01", x: 64, y: 32, width: 16, height: 16 },
  ],
  sets: [
    { id: "dancer", kind: "frames", fps: 8, frames: ["dancer/frame-00", "dancer/frame-01", "dancer/frame-02"] },
    { id: "ground", kind: "members", frames: ["ground/tile-00", "ground/tile-01"] },
  ],
}

describe("Aseprite sheet JSON", () => {
  const doc = JSON.parse(renderAsepriteSheet(atlas, { imageName: "hero-sheet.png", version: "0.38.0" }))

  it("keys frames by id in atlas order with their rectangles", () => {
    expect(Object.keys(doc.frames)).toEqual(atlas.frames.map((f) => f.id))
    expect(doc.frames["dancer/frame-02"]).toEqual({
      frame: { x: 0, y: 32, w: 32, h: 32 },
      rotated: false,
      trimmed: false,
      spriteSourceSize: { x: 0, y: 0, w: 32, h: 32 },
      sourceSize: { w: 32, h: 32 },
      duration: 125,
    })
    expect(doc.frames.anvil.duration).toBe(100)
    expect(doc.frames["ground/tile-00"].duration).toBe(100)
  })

  it("tags each set over its frame span and names the image", () => {
    expect(doc.meta.frameTags).toEqual([
      { name: "dancer", from: 1, to: 3, direction: "forward" },
      { name: "ground", from: 4, to: 5, direction: "forward" },
    ])
    expect(doc.meta).toMatchObject({ image: "hero-sheet.png", size: { w: 96, h: 64 }, format: "RGBA8888", version: "0.38.0" })
    expect(doc.meta.layers).toEqual([{ name: "hero", opacity: 255, blendMode: "normal" }])
  })

  it("is byte-stable", () => {
    expect(renderAsepriteSheet(atlas, { imageName: "a.png" })).toBe(renderAsepriteSheet(atlas, { imageName: "a.png" }))
  })

  it("records a bottom-centred character frame as a genuine trim against the cell", () => {
    // A crouch loop's rotation-sized frame (92x92), bottom-centred in a
    // 92x104 cell by a v3 endFrame's taller canvas (issue #146).
    const pivoted: SheetAtlas = {
      style: "hero",
      sheet: { width: 92, height: 104 },
      cell: { width: 92, height: 104 },
      frames: [{ id: "hero.crouch.south/frame-00", x: 0, y: 12, width: 92, height: 92, offsetX: 0, offsetY: 12 }],
    }
    const doc = JSON.parse(renderAsepriteSheet(pivoted, { imageName: "hero-sheet.png" }))
    expect(doc.frames["hero.crouch.south/frame-00"]).toEqual({
      frame: { x: 0, y: 12, w: 92, h: 92 },
      rotated: false,
      trimmed: true,
      spriteSourceSize: { x: 0, y: 12, w: 92, h: 92 },
      sourceSize: { w: 92, h: 104 },
      duration: 100,
    })
  })
})

describe("Godot SpriteFrames", () => {
  const tres = renderGodotSpriteFrames(atlas, { imageName: "hero-sheet.png" })

  it("declares one atlas texture per frame over the sheet", () => {
    expect(tres).toContain('[gd_resource type="SpriteFrames" load_steps=8 format=3]')
    expect(tres).toContain('[ext_resource type="Texture2D" path="./hero-sheet.png" id="1_texture"]')
    expect(tres.match(/\[sub_resource type="AtlasTexture"/g)).toHaveLength(6)
    expect(tres).toContain('region = Rect2(0, 32, 32, 32)')
  })

  it("plays a frame set as one looping animation at its fps and everything else as a still", () => {
    const dancer = tres.match(/\{\n"frames": \[[^\]]*\],\n"loop": true,\n"name": &"dancer",\n"speed": 8\.0\n\}/)
    expect(dancer).not.toBeNull()
    expect(dancer![0].match(/SubResource\("AtlasTexture_(\d)"\)/g)).toEqual(['SubResource("AtlasTexture_2")', 'SubResource("AtlasTexture_3")', 'SubResource("AtlasTexture_4")'])
    expect(tres).toContain('"name": &"anvil",\n"speed": 5.0')
    expect(tres).toContain('"name": &"ground/tile-01",\n"speed": 5.0')
    expect(tres).not.toContain('"name": &"ground",')
    expect(tres.match(/"name": &/g)).toHaveLength(4)
  })
})

describe("renderSheetDocument", () => {
  it("chooses the extension and body by format", () => {
    expect(renderSheetDocument("generic", atlas as SheetAtlas & Record<string, unknown>, { imageName: "a.png" })).toMatchObject({ extension: ".json" })
    expect(JSON.parse(renderSheetDocument("generic", atlas as SheetAtlas & Record<string, unknown>, { imageName: "a.png" }).document).sets).toHaveLength(2)
    expect(renderSheetDocument("aseprite", atlas as SheetAtlas & Record<string, unknown>, { imageName: "a.png" }).extension).toBe(".json")
    expect(renderSheetDocument("godot", atlas as SheetAtlas & Record<string, unknown>, { imageName: "a.png" }).extension).toBe(".tres")
  })
})

describe("packStyle records sets", () => {
  let dir: string
  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "pk-sets-"))
  })
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  const px = (n: number) => encodeRgbaPng(n, n, Buffer.alloc(n * n * 4, 200))

  it("groups a frame set with its recorded fps and a tile set as members", async () => {
    for (const name of ["anvil", "dancer-frame-00", "dancer-frame-01", "ground-tile-00", "ground-tile-01"]) {
      await writeFile(path.join(dir, `${name}.png`), px(8))
    }
    const lock = { version: 2, entries: {
      "s/anvil": { status: "downloaded", generator: "map", provider: "fake", outputs: [{ path: "anvil.png", sha256: "x" }] },
      "s/dancer": { status: "downloaded", generator: "frames", provider: "comfyui", outputs: [
        { path: "dancer-frame-00.png", sha256: "x", role: "frame-00" },
        { path: "dancer-frame-01.png", sha256: "x", role: "frame-01" },
      ], providerMetadata: { comfyui: { frameSet: { fps: 6, count: 2 } } } },
      "s/ground": { status: "downloaded", generator: "tiles", provider: "fake", outputs: [
        { path: "ground-tile-00.png", sha256: "x", role: "tile-00" },
        { path: "ground-tile-01.png", sha256: "x", role: "tile-01" },
      ] },
    } } as unknown as Lock
    const { atlas } = packStyle(lock, "s", dir)
    expect(atlas.frames.map((f) => f.id)).toEqual(["anvil", "dancer/frame-00", "dancer/frame-01", "ground/tile-00", "ground/tile-01"])
    expect(atlas.sets).toEqual([
      { id: "dancer", kind: "frames", fps: 6, frames: ["dancer/frame-00", "dancer/frame-01"] },
      { id: "ground", kind: "members", frames: ["ground/tile-00", "ground/tile-01"] },
    ])
  })

  it("defaults a frame set with no recorded rate to 12 fps and drops members that did not pack", async () => {
    await writeFile(path.join(dir, "a.png"), px(8))
    const lock = { version: 2, entries: {
      "s/walk": { status: "downloaded", generator: "frames", provider: "fake", outputs: [
        { path: "a.png", sha256: "x", role: "frame-00" },
        { path: "missing.png", sha256: "x", role: "frame-01" },
      ] },
    } } as unknown as Lock
    const { atlas, skipped } = packStyle(lock, "s", dir)
    expect(skipped.map((s) => s.id)).toEqual(["walk/frame-01"])
    expect(atlas.sets).toEqual([{ id: "walk", kind: "frames", fps: 12, frames: ["walk/frame-00"] }])
  })

  it("has no sets on a sheet of singles", async () => {
    await writeFile(path.join(dir, "a.png"), px(8))
    const lock = { version: 2, entries: {
      "s/a": { status: "downloaded", generator: "map", provider: "fake", outputs: [{ path: "a.png", sha256: "x" }] },
    } } as unknown as Lock
    expect(packStyle(lock, "s", dir).atlas).not.toHaveProperty("sets")
  })
})

describe("--format on the CLI", () => {
  it("accepts sheet formats for pack and mount, tileset formats for export", () => {
    expect(parseArgs(["pack", "--format", "aseprite"]).format).toBe("aseprite")
    expect(parseArgs(["mount", "--format", "godot"]).format).toBe("godot")
    expect(parseArgs(["export", "--format", "tiled"]).format).toBe("tiled")
    expect(() => parseArgs(["pack", "--format", "tiled"])).toThrow(/generic, aseprite, or godot/)
    expect(() => parseArgs(["export", "--format", "aseprite"])).toThrow(/generic, tiled, or godot/)
  })

  it("pack --inputs writes the Aseprite JSON or the Godot resource beside the sheet", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "pk-format-cli-"))
    try {
      await writeFile(path.join(dir, "a.png"), encodeRgbaPng(4, 4, Buffer.alloc(64, 255)))
      await writeFile(path.join(dir, "b.png"), encodeRgbaPng(4, 4, Buffer.alloc(64, 128)))
      await writeFile(path.join(dir, "inputs.json"), JSON.stringify([{ id: "a", path: "a.png" }, { id: "b", path: "b.png" }]))
      const tsx = path.resolve("node_modules/.bin/tsx")
      const cli = path.resolve("src/cli.ts")

      await execFileAsync(tsx, [cli, "pack", "--inputs", "inputs.json", "--out", "ase/sheet", "--format", "aseprite"], { cwd: dir })
      const ase = JSON.parse(await readFile(path.join(dir, "ase", "sheet.json"), "utf8"))
      expect(Object.keys(ase.frames)).toEqual(["a", "b"])
      expect(ase.meta.image).toBe("sheet.png")
      const bundle = JSON.parse(await readFile(path.join(dir, "ase", "sheet.pixelkiln.json"), "utf8"))
      expect(bundle.options.format).toBe("aseprite")

      await execFileAsync(tsx, [cli, "pack", "--inputs", "inputs.json", "--out", "gd/sheet.png", "--format", "godot"], { cwd: dir })
      const tres = await readFile(path.join(dir, "gd", "sheet.tres"), "utf8")
      expect(tres).toContain('type="SpriteFrames"')
      expect(tres).toContain('path="./sheet.png"')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  }, 30_000)
})
