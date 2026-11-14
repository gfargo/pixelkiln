import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { existsSync } from "node:fs"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { PixelLabClient, PixelLabError } from "../src/client.ts"
import { parseArgs } from "../src/cli/args.ts"
import { runAsset } from "../src/cli/commands/asset.ts"
import {
  checkSaveTarget,
  chooseTilesetSheetReading,
  importTileHeights,
  importTilesetFile,
  importTilesFiles,
  saveToAssetFile,
  saveUndoDir,
  tilesetSheetReadings,
} from "../src/pixellab-assets.ts"
import { encodeRgbaPng } from "../src/png.ts"

const png = (width: number, height: number, fill = 90) => encodeRgbaPng(width, height, Buffer.alloc(width * height * 4, fill))
let dir: string
let posts: Array<{ url: string; body: Record<string, unknown> }>
let reply: (url: string, body: Record<string, unknown>) => Response

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "pixelkiln-imports-"))
  posts = []
  reply = () => new Response("not found", { status: 404 })
  vi.stubGlobal("fetch", vi.fn(async (input: string, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>
    posts.push({ url: String(input).replace("https://api.pixellab.ai/v2", ""), body })
    return reply(String(input), body)
  }))
})
afterEach(async () => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  await rm(dir, { recursive: true, force: true })
})

describe("reading a tileset sheet", () => {
  it("finds one reading for most sizes and two for 128, 192 and 256", () => {
    expect(tilesetSheetReadings(64, 64)).toEqual([{ tileSize: 16, layout: "compact" }])
    expect(tilesetSheetReadings(96, 192)).toEqual([{ tileSize: 24, layout: "compact" }])
    expect(tilesetSheetReadings(512, 512)).toEqual([{ tileSize: 64, layout: "native" }])
    expect(tilesetSheetReadings(128, 128).map((r) => r.tileSize)).toEqual([32, 16])
    expect(tilesetSheetReadings(192, 192).map((r) => r.tileSize)).toEqual([48, 24])
    expect(tilesetSheetReadings(256, 512).map((r) => r.tileSize)).toEqual([64, 32])
    expect(tilesetSheetReadings(50, 50)).toEqual([])
    expect(tilesetSheetReadings(64, 96)).toEqual([])
  })

  it("asks which when a sheet reads two ways, and refuses a size the sheet does not hold", () => {
    expect(() => chooseTilesetSheetReading("s.png", 128, 128)).toThrow(/32px tiles \(4 wide\) or 16px tiles \(8 wide\).*--size 32 or --size 16/)
    expect(chooseTilesetSheetReading("s.png", 128, 128, 16)).toEqual({ tileSize: 16, layout: "native" })
    expect(chooseTilesetSheetReading("s.png", 64, 64)).toEqual({ tileSize: 16, layout: "compact" })
    expect(() => chooseTilesetSheetReading("s.png", 64, 64, 32)).toThrow(/not 32px tiles/)
    expect(() => chooseTilesetSheetReading("s.png", 50, 50)).toThrow(/not a PixelLab tileset sheet/)
  })
})

describe("asset import --kind tileset", () => {
  it("sends the sheet with its tile size as an object, and the terrain descriptions", async () => {
    reply = () => new Response(JSON.stringify({ tileset_id: "ts1", status: "completed", usage: null }), { status: 201 })
    await writeFile(path.join(dir, "sheet.png"), png(128, 128))
    const res = await importTilesetFile(new PixelLabClient("key"), path.join(dir, "sheet.png"), { tileSize: 16, lowerDescription: "grass", upperDescription: "stone", name: "meadow" })
    expect(res).toEqual({ tilesetId: "ts1", mode: "topdown", tileSize: 16, layout: "native" })
    expect(posts[0]!.url).toBe("/tilesets/import")
    expect(posts[0]!.body).toMatchObject({
      tileset_mode: "topdown",
      tile_size: { width: 16, height: 16 },
      lower_description: "grass",
      upper_description: "stone",
      name: "meadow",
      spritesheet: { type: "base64", format: "png" },
    })
  })

  it("leaves the tile size out for a 48px sheet, which PixelLab cannot be told, and refuses an upper terrain on a sidescroller", async () => {
    reply = () => new Response(JSON.stringify({ tileset_id: "ts2" }), { status: 201 })
    await writeFile(path.join(dir, "sheet.png"), png(192, 192))
    await importTilesetFile(new PixelLabClient("key"), path.join(dir, "sheet.png"), { tileSize: 48, mode: "sidescroller", lowerDescription: "bricks" })
    expect(posts[0]!.body).not.toHaveProperty("tile_size")
    expect(posts[0]!.body).toMatchObject({ tileset_mode: "sidescroller" })
    await expect(importTilesetFile(new PixelLabClient("key"), path.join(dir, "sheet.png"), { tileSize: 24, mode: "sidescroller", upperDescription: "sky" }))
      .rejects.toThrow(/one terrain/)
  })

  it("stops at the command for an ambiguous sheet, before anything is sent", async () => {
    await writeFile(path.join(dir, "sheet.png"), png(128, 128))
    await expect(runAsset(parseArgs(["asset", "import", "--kind", "tileset", "--from", path.join(dir, "sheet.png"), "--dry-run"]))).rejects.toThrow(/say which with --size/)
    const lines: string[] = []
    vi.spyOn(console, "log").mockImplementation((line: string) => void lines.push(line))
    await runAsset(parseArgs(["asset", "import", "--kind", "tileset", "--from", path.join(dir, "sheet.png"), "--size", "16", "--mode", "sidescroller", "--dry-run"]))
    expect(lines.join("\n")).toMatch(/sidescroller tileset of 16px tiles \(8 wide\); nothing sent/)
    await expect(runAsset(parseArgs(["asset", "import", "--kind", "tileset", "--from", path.join(dir, "sheet.png"), "--size", "16", "--mode", "iso", "--dry-run"]))).rejects.toThrow(/--mode must be/)
    await expect(runAsset(parseArgs(["asset", "import", "--kind", "tileset", "--from", path.join(dir, "sheet.png"), "--size", "16x16", "--dry-run"]))).rejects.toThrow(/tile size in pixels/)
    await expect(runAsset(parseArgs(["asset", "import", "--kind", "map", "--from", path.join(dir, "sheet.png")]))).rejects.toThrow(/object \(the default\), tileset or tiles/)
    expect(posts).toHaveLength(0)
  })
})

describe("asset import --kind tiles", () => {
  it("knows each tile type's height range", () => {
    expect(importTileHeights("square_topdown", 32)).toEqual({ min: 32, max: 32 })
    expect(importTileHeights("isometric", 32)).toEqual({ min: 16, max: 64 })
    expect(importTileHeights("oblique", 32)).toEqual({ min: 32, max: 64 })
  })

  it("sends a directory's PNGs in natural name order as one group", async () => {
    reply = () => new Response(JSON.stringify({ tile_id: "tg1", status: "completed" }), { status: 201 })
    await mkdir(path.join(dir, "tiles"))
    for (const [name, fill] of [["tile-10.png", 10], ["tile-2.png", 2], ["tile-1.png", 1]] as const) await writeFile(path.join(dir, "tiles", name), png(16, 16, fill))
    await writeFile(path.join(dir, "tiles", "notes.txt"), "not a tile")
    const res = await importTilesFiles(new PixelLabClient("key"), path.join(dir, "tiles"), { tileType: "square_topdown", tileSize: 16, description: "meadow floor" })
    expect(res).toMatchObject({ tileId: "tg1", tiles: 3 })
    expect(res.files.map((file) => path.basename(file))).toEqual(["tile-1.png", "tile-2.png", "tile-10.png"])
    expect(posts[0]!.body).toMatchObject({ tile_type: "square_topdown", tile_size: 16, description: "meadow floor" })
    expect((posts[0]!.body.frames as unknown[]).length).toBe(3)
  })

  it("refuses a tile of the wrong size, too many tiles, or a missing flag, before sending", async () => {
    await writeFile(path.join(dir, "t.png"), png(16, 16))
    const client = new PixelLabClient("key")
    await expect(importTilesFiles(client, path.join(dir, "t.png"), { tileType: "square_topdown", tileSize: 32 })).rejects.toThrow(/is 16x16; a 32px square_topdown tile is 32 wide and 32 tall/)
    await expect(importTilesFiles(client, path.join(dir, "t.png"), { tileType: "isometric", tileSize: 64 })).rejects.toThrow(/64 wide and 32 to 128 tall/)
    await mkdir(path.join(dir, "many"))
    for (let i = 0; i < 33; i++) await writeFile(path.join(dir, "many", `t${i}.png`), png(16, 16))
    await expect(importTilesFiles(client, path.join(dir, "many"), { tileType: "square_topdown", tileSize: 16 })).rejects.toThrow(/at most 32 tiles/)
    const base = ["asset", "import", "--kind", "tiles", "--from", path.join(dir, "t.png")]
    await expect(runAsset(parseArgs(base))).rejects.toThrow(/needs --tile-type/)
    await expect(runAsset(parseArgs([...base, "--tile-type", "square_topdown"]))).rejects.toThrow(/needs --size/)
    await expect(runAsset(parseArgs([...base, "--tile-type", "square_topdown", "--size", "16", "--lower", "grass"]))).rejects.toThrow(/describe a tileset/)
    expect(posts.filter((post) => post.url === "/tiles-pro/import" && (post.body.tile_type === "square_topdown"))).toHaveLength(0)
  })
})

describe("asset save", () => {
  const saved = (overrides: Record<string, unknown> = {}) => ({
    action: "saved", target: "object:o1:south", kind: "rotation", width: 8, height: 8, frame_count: 1, changed_pixels: 12,
    previous_frames: [{ type: "base64", base64: png(8, 8, 33).toString("base64"), format: "png" }],
    ...overrides,
  })

  it("accepts PixelLab's target forms and refuses anything else", () => {
    for (const target of ["character:c1:south", "character:c1:south:g1", "object:o1", "object:o1:east", "object:o1:east:g1", "gallery:g9", "gallery:new", "tileset:t1"]) {
      expect(() => checkSaveTarget(target)).not.toThrow()
    }
    for (const target of ["character:c1", "o1", "map:m1", "gallery:", "object:o1:east:g1:extra"]) expect(() => checkSaveTarget(target)).toThrow(/not a place PixelLab can save to/)
    expect(saveUndoDir("object:o1:south", new Date("2026-11-14T19:45:36.123Z"))).toMatch(/pixelkiln-undo[/\\]object_o1_south-20261114T194536Z$/)
  })

  it("saves one PNG and writes what it replaced, so the save can be undone", async () => {
    reply = () => new Response(JSON.stringify(saved()), { status: 200 })
    await writeFile(path.join(dir, "edit.png"), png(8, 8))
    const res = await saveToAssetFile(new PixelLabClient("key"), "object:o1:south", path.join(dir, "edit.png"), { undoDir: path.join(dir, "undo") })
    expect(res).toMatchObject({ action: "saved", changedPixels: 12, frames: 1 })
    expect(posts[0]!.body).toMatchObject({ target: "object:o1:south", image: { type: "base64", format: "png" } })
    expect(posts[0]!.body).not.toHaveProperty("frames")
    expect(res.undo).toEqual([path.join(dir, "undo", "previous.png")])
    expect((await readFile(res.undo[0]!)).equals(png(8, 8, 33))).toBe(true)
  })

  it("sends a directory as ordered frames, a GIF as one image, and keeps no undo for a new or unchanged image", async () => {
    await mkdir(path.join(dir, "walk"))
    for (const name of ["f2.png", "f1.png"]) await writeFile(path.join(dir, "walk", name), png(8, 8, name === "f1.png" ? 1 : 2))
    reply = () => new Response(JSON.stringify(saved({ kind: "animation", frame_count: 2, previous_frames: [0, 1].map(() => ({ base64: png(8, 8).toString("base64") })) })), { status: 200 })
    const walk = await saveToAssetFile(new PixelLabClient("key"), "character:c1:south:g1", path.join(dir, "walk"), { undoDir: path.join(dir, "u") })
    const frames = posts[0]!.body.frames as Array<{ base64: string }>
    expect(frames.map((frame) => Buffer.from(frame.base64, "base64").equals(png(8, 8, 1)))).toEqual([true, false])
    expect(walk.undo.map((file) => path.basename(file))).toEqual(["previous-00.png", "previous-01.png"])

    await writeFile(path.join(dir, "walk.gif"), Buffer.concat([Buffer.from("GIF89a"), Buffer.alloc(20)]))
    reply = () => new Response(JSON.stringify(saved({ action: "unchanged", changed_pixels: 0, previous_frames: null })), { status: 200 })
    const same = await saveToAssetFile(new PixelLabClient("key"), "character:c1:south:g1", path.join(dir, "walk.gif"), { undoDir: path.join(dir, "u2") })
    expect(posts[1]!.body.image).toMatchObject({ format: "gif" })
    expect(same.undo).toEqual([])
    expect(existsSync(path.join(dir, "u2"))).toBe(false)

    reply = () => new Response(JSON.stringify(saved({ action: "added", target: "gallery:g7", kind: "image", previous_frames: null })), { status: 200 })
    await writeFile(path.join(dir, "new.png"), png(8, 8))
    const added = await saveToAssetFile(new PixelLabClient("key"), "gallery:new", path.join(dir, "new.png"), { name: "kiln", description: "a small kiln" })
    expect(posts[2]!.body).toMatchObject({ target: "gallery:new", name: "kiln", description: "a small kiln" })
    expect(added).toMatchObject({ action: "added", target: "gallery:g7", undo: [] })
  })

  it("refuses mixed frame sizes and a name on anything but a new gallery image", async () => {
    await mkdir(path.join(dir, "mixed"))
    await writeFile(path.join(dir, "mixed", "a.png"), png(8, 8))
    await writeFile(path.join(dir, "mixed", "b.png"), png(16, 8))
    await expect(saveToAssetFile(new PixelLabClient("key"), "object:o1:south:g1", path.join(dir, "mixed"))).rejects.toThrow(/share one size/)
    await expect(saveToAssetFile(new PixelLabClient("key"), "object:o1", path.join(dir, "mixed", "a.png"), { name: "x" })).rejects.toThrow(/gallery:new/)
    expect(posts).toHaveLength(0)
  })

  it("keeps the old pixels when PixelLab fails partway", async () => {
    await writeFile(path.join(dir, "edit.png"), png(8, 8))
    const client = {
      saveToAsset: async () => {
        throw new PixelLabError("POST /save-to-asset → 500", 500, JSON.stringify({ detail: { previous_frames: [{ base64: png(8, 8, 77).toString("base64") }] } }))
      },
    } as never
    await expect(saveToAssetFile(client, "object:o1:south", path.join(dir, "edit.png"), { undoDir: path.join(dir, "rescue") }))
      .rejects.toThrow(/failed partway; what was stored before is in .*rescue/)
    expect((await readFile(path.join(dir, "rescue", "previous.png"))).equals(png(8, 8, 77))).toBe(true)
  })

  it("says what it will replace and where the undo goes, and a dry run sends nothing", async () => {
    await writeFile(path.join(dir, "edit.png"), png(8, 8))
    const lines: string[] = []
    vi.spyOn(console, "log").mockImplementation((line: string) => void lines.push(line))
    await runAsset(parseArgs(["asset", "save", "--target", "object:o1:south", "--from", path.join(dir, "edit.png"), "--out", path.join(dir, "undo"), "--dry-run"]))
    expect(lines.join("\n")).toMatch(/save .*edit\.png over object:o1:south[\s\S]*written to .*undo[\s\S]*nothing sent/)
    await expect(runAsset(parseArgs(["asset", "save", "--from", path.join(dir, "edit.png")]))).rejects.toThrow(/needs --target/)
    await expect(runAsset(parseArgs(["asset", "save", "--target", "gallery:new"]))).rejects.toThrow(/needs --from/)
    await expect(runAsset(parseArgs(["asset", "save", "--target", "map:1", "--from", path.join(dir, "edit.png")]))).rejects.toThrow(/not a place/)
    expect(posts).toHaveLength(0)
  })
})
