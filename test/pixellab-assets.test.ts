import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { existsSync } from "node:fs"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import {
  checkExportBytes,
  expandObject,
  exportAssetFile,
  exportOutPath,
  importObjectFile,
  parseCanvasSize,
  pullExpansionReview,
} from "../src/pixellab-assets.ts"
import { pixelateFile } from "../src/pixellab-utils.ts"
import { PixelLabClient } from "../src/client.ts"
import { parseArgs } from "../src/cli/args.ts"
import { encodeRgbaPng } from "../src/png.ts"

const PNG = encodeRgbaPng(8, 8, Buffer.alloc(8 * 8 * 4, 180))
const ZIP = Buffer.concat([Buffer.from("PK\x03\x04"), Buffer.alloc(20)])
const GIF = Buffer.concat([Buffer.from("GIF89a"), Buffer.alloc(20)])
const ASE = (() => { const b = Buffer.alloc(32); b.writeUInt16LE(0xa5e0, 4); return b })()
let dir: string

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "pixelkiln-assets-"))
})
afterEach(async () => {
  vi.unstubAllGlobals()
  await rm(dir, { recursive: true, force: true })
})

describe("asset argument forms", () => {
  it("reads a canvas size within each kind's limits", () => {
    expect(parseCanvasSize("48x64", "character")).toEqual({ width: 48, height: 64 })
    expect(parseCanvasSize("400 x 400", "object")).toEqual({ width: 400, height: 400 })
    expect(() => parseCanvasSize("400x400", "character")).toThrow(/8 to 256 for a character/)
    expect(() => parseCanvasSize("50x48", "object")).toThrow(/multiples of 4/)
    expect(() => parseCanvasSize("big", "object")).toThrow(/--size/)
  })
  it("picks an export file name and checks the bytes are that format", () => {
    expect(path.basename(exportOutPath("out/hero", "aseprite"))).toBe("hero.aseprite")
    expect(path.basename(exportOutPath("out/hero", "spritesheet"))).toBe("hero.zip")
    expect(path.basename(exportOutPath("out/hero.gif", "gif"))).toBe("hero.gif")
    expect(() => checkExportBytes(ZIP, "zip")).not.toThrow()
    expect(() => checkExportBytes(GIF, "gif")).not.toThrow()
    expect(() => checkExportBytes(ASE, "aseprite")).not.toThrow()
    expect(() => checkExportBytes(Buffer.from('{"detail":"nope"}'), "aseprite")).toThrow(/was not a aseprite file/)
  })
  it("parses the asset command line and its own --format set", () => {
    expect(parseArgs(["asset", "export", "--id", "o1", "--format", "aseprite", "--out", "x"])).toMatchObject({ command: "asset", subcommand: "export", id: "o1", format: "aseprite" })
    expect(parseArgs(["asset", "expand", "--id", "o1", "--direction", "south"])).toMatchObject({ subcommand: "expand", direction: "south", keep: false })
    expect(parseArgs(["pixelate", "--from", "a.png", "--pro"])).toMatchObject({ pro: true })
    expect(() => parseArgs(["asset", "export", "--id", "o1", "--format", "tiled"])).toThrow(/--format must be/)
    expect(() => parseArgs(["asset"])).toThrow(/needs a subcommand/)
  })
})

describe("exportAssetFile and importObjectFile", () => {
  it("writes a checked export and refuses to overwrite or to save an error body", async () => {
    const calls: unknown[] = []
    const client = { exportAsset: async (...args: unknown[]) => { calls.push(args); return GIF } } as never
    const res = await exportAssetFile(client, "object", "o1", "gif", { out: path.join(dir, "turn"), animationGroupId: "g1", direction: "east" })
    expect(path.basename(res.out)).toBe("turn.gif")
    expect(calls[0]).toEqual(["object", "o1", "gif", { animationGroupId: "g1", direction: "east" }])
    await expect(exportAssetFile(client, "object", "o1", "gif", { out: path.join(dir, "turn") })).rejects.toThrow(/already exists/)
    await expect(exportAssetFile(client, "object", "o1", "zip", { out: path.join(dir, "z") })).rejects.toThrow(/not a zip file/)
    expect(existsSync(path.join(dir, "z.zip"))).toBe(false)
  })
  it("imports a PNG and refuses a JPEG or one that is too large", async () => {
    const sent: unknown[] = []
    const client = { importObject: async (args: unknown) => { sent.push(args); return { object_id: "o9", name: "kiln", size: { width: 8, height: 8 }, image_url: "https://cdn/o9.png" } } } as never
    await writeFile(path.join(dir, "a.png"), PNG)
    expect(await importObjectFile(client, path.join(dir, "a.png"), { name: "kiln" })).toMatchObject({ objectId: "o9", size: { width: 8, height: 8 } })
    expect(sent[0]).toMatchObject({ name: "kiln", image: { format: "png" } })
    await writeFile(path.join(dir, "big.png"), encodeRgbaPng(260, 8, Buffer.alloc(260 * 8 * 4)))
    await expect(importObjectFile(client, path.join(dir, "big.png"))).rejects.toThrow(/at most 256x256/)
    await writeFile(path.join(dir, "b.jpg"), Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 16, 0x4a, 0x46, 0x49, 0x46, 0]))
    await expect(importObjectFile(client, path.join(dir, "b.jpg"))).rejects.toThrow(/not a PNG/)
  })
})

describe("expandObject and its review", () => {
  it("waits until the directions are ready for review and reports the quote and the bill", async () => {
    let polls = 0
    const quotes: number[][] = []
    const res = await expandObject({
      expandObjectRotations: async (_id: string, args: unknown) => { expect(args).toEqual({ existingDirection: "south", description: "a kiln" }); return { object_id: "o1", background_job_id: "job", status: "expanding", min_generations: 10, max_generations: 25 } },
      getObject: async () => ({ status: ++polls < 3 ? "expanding" : "review-expansion" }),
      getBackgroundJob: async () => ({ id: "job", status: "completed", usage: { type: "generations", generations: 10 } }),
    } as never, "o1", { existingDirection: "south", description: "a kiln", onQuote: (a, b) => quotes.push([a, b]), sleep: async () => {} })
    expect(quotes).toEqual([[10, 25]])
    expect(res).toMatchObject({ status: "review-expansion", minGenerations: 10, usage: { generations: 10 } })
  })
  it("downloads the pending directions, and refuses when nothing is waiting", async () => {
    const reviewing = {
      getObject: async () => ({ status: "review-expansion", expansion_review: { existing_direction: "south", rotation_urls: { south: "https://cdn/s.png", east: "https://cdn/e.png", west: null } } }),
      download: async () => PNG,
    } as never
    const res = await pullExpansionReview(reviewing, "o1", { out: path.join(dir, "review") })
    expect(res.existingDirection).toBe("south")
    expect(res.files.map((f) => f.direction)).toEqual(["south", "east"])
    expect((await readFile(path.join(dir, "review", "east.png"))).equals(PNG)).toBe(true)
    const done = { getObject: async () => ({ status: "completed", expansion_review: null }), download: async () => PNG } as never
    await expect(pullExpansionReview(done, "o1", { out: path.join(dir, "r2") })).rejects.toThrow(/no expansion waiting/)
  })
})

describe("pixelate --pro", () => {
  const job = (shape: Record<string, unknown>) => ({ getBackgroundJob: async () => ({ id: "j", status: "completed", last_response: shape, usage: { type: "generations", generations: 20 } }) })
  it("sends the Pro converter a palette and reads a single image or a list", async () => {
    await writeFile(path.join(dir, "in.png"), PNG)
    const sent: unknown[] = []
    const base = { imageToPixelartProFlash: async () => { throw new Error("flash must not be called") }, imageToPixelartPro: async (args: unknown) => { sent.push(args); return { background_job_id: "j", status: "processing" } } }
    const single = await pixelateFile({ ...base, ...job({ image: { base64: PNG.toString("base64") } }) } as never, path.join(dir, "in.png"), { pro: true, palette: ["#000000", "#ffffff"], out: path.join(dir, "a.png") })
    expect(sent[0]).toMatchObject({ targetPalette: { colors: ["#000000", "#ffffff"] } })
    expect(single).toMatchObject({ pixelated: { width: 8, height: 8 }, usage: { generations: 20 } })
    expect(single.imageId).toBeUndefined()
    expect(single.quantized).toBeUndefined()
    const both = await pixelateFile({ ...base, ...job({ image: { base64: PNG.toString("base64") }, quantized_image: { base64: PNG.toString("base64") }, original_image_n_colors: 141, quantized_image_n_colors: 40 }) } as never, path.join(dir, "in.png"), { pro: true, out: path.join(dir, "q.png") })
    expect(both).toMatchObject({ colors: 141, quantized: { colors: 40 } })
    expect(path.basename(both.quantized!.out)).toBe("q.quantized.png")
    expect(existsSync(path.join(dir, "q.quantized.png"))).toBe(true)
    const list = await pixelateFile({ ...base, ...job({ images: [{ base64: PNG.toString("base64") }] }) } as never, path.join(dir, "in.png"), { pro: true, out: path.join(dir, "b.png") })
    expect(list.pixelated).toEqual({ width: 8, height: 8 })
  })
  it("refuses a palette without --pro before sending anything", async () => {
    await writeFile(path.join(dir, "in.png"), PNG)
    const client = { imageToPixelartProFlash: async () => { throw new Error("sent") }, imageToPixelartPro: async () => { throw new Error("sent") }, getBackgroundJob: async () => ({}) } as never
    await expect(pixelateFile(client, path.join(dir, "in.png"), { maxColors: 8, out: path.join(dir, "c.png") })).rejects.toThrow(/needs the Pro converter/)
  })
})

describe("client requests", () => {
  function recording(reply: unknown, status = 200) {
    const calls: Array<{ url: string; method: string; body: unknown }> = []
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url: String(url), method: init?.method ?? "GET", body: init?.body ? JSON.parse(String(init.body)) : undefined })
      return new Response(typeof reply === "string" || Buffer.isBuffer(reply) ? reply : JSON.stringify(reply), { status })
    }))
    return { client: new PixelLabClient("key"), calls }
  }
  const route = (url: string) => url.split("/v2")[1]

  it("routes canvas and mirror by kind and sends the expected bodies", async () => {
    const canvas = recording({ id: "c1", previous: { width: 32, height: 32 }, canvas: { width: 48, height: 48 }, rotations_moved: 8 })
    await canvas.client.setCanvasSize("character", "c1", { width: 48, height: 48 })
    expect([canvas.calls[0]!.method, route(canvas.calls[0]!.url), canvas.calls[0]!.body]).toEqual(["POST", "/characters/c1/canvas", { image_size: { width: 48, height: 48 } }])
    const mirror = recording({ animation_group_id: "g1", source_direction: "east", target_direction: "west", frames_created: 8 })
    expect((await mirror.client.mirrorAnimation("object", "o1", "g1", "east")).target_direction).toBe("west")
    expect([route(mirror.calls[0]!.url), mirror.calls[0]!.body]).toEqual(["/objects/o1/animations/g1/mirror", { source_direction: "east" }])
  })
  it("accepts and dismisses an expansion, and builds the export URL", async () => {
    const review = recording({})
    await review.client.acceptObjectExpansion("o1")
    await review.client.dismissObjectReview("o1")
    expect(review.calls.map((c) => [route(c.url), c.body])).toEqual([["/objects/o1/select-frames", {}], ["/objects/o1/dismiss-review", {}]])
    const exported = recording(GIF)
    const bytes = await exported.client.exportAsset("object", "o1", "gif", { animationGroupId: "g1", direction: "east" })
    expect(bytes.subarray(0, 4).toString()).toBe("GIF8")
    expect(route(exported.calls[0]!.url)).toBe("/objects/o1/gif?animation_group_id=g1&direction=east")
  })
  it("puts PixelLab's own reason in a refusal, and says a 423 is still generating", async () => {
    const refused = recording({ detail: "Canvas 8x8 would crop the object: the artwork spans 16x20" }, 400)
    await expect(refused.client.setCanvasSize("object", "o1", { width: 8, height: 8 })).rejects.toThrow(/→ 400: Canvas 8x8 would crop the object: the artwork spans 16x20/)
    const validation = recording({ detail: [{ loc: ["body"], msg: "bad" }] }, 422)
    await expect(validation.client.setCanvasSize("object", "o1", { width: 8, height: 8 })).rejects.toThrow(/→ 422$/)
    const locked = recording("{}", 423)
    await expect(locked.client.exportAsset("object", "o1", "zip")).rejects.toThrow(/423; the asset or one of its animations is still generating/)
  })
})
