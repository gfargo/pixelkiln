import path from "node:path"
import { existsSync } from "node:fs"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { PixelLabClient } from "../src/client.ts"
import { parseArgs } from "../src/cli/args.ts"
import { defaultUnzoomOut, fontOutputPaths, generateFont, unzoomFile } from "../src/pixellab-utils.ts"
import { encodeRgbaPng } from "../src/png.ts"

function png(width: number, height: number): Buffer {
  return encodeRgbaPng(width, height, Buffer.alloc(width * height * 4, 90))
}

describe("PixelLabClient: unzoom, interpolation, edit-animation, and font wire", () => {
  afterEach(() => vi.unstubAllGlobals())

  it("sends unzoom the image and quantize, and reads back the detected sizes", async () => {
    vi.stubGlobal("fetch", vi.fn(async () =>
      new Response(JSON.stringify({
        image: { type: "base64", base64: "UkVTVUxU", format: "png" },
        original_size: { width: 512, height: 512 },
        unzoomed_size: { width: 32, height: 32 },
        zoom_factor_detected: 16,
        usage: { type: "generations", generations: 0.1 },
      }), { status: 200 })))
    const res = await new PixelLabClient("key").unzoom({ image: { base64: "SU4=", format: "png" }, quantize: 16 })
    expect(res.png.toString("base64")).toBe("UkVTVUxU")
    expect(res.unzoomedSize).toEqual({ width: 32, height: 32 })
    expect(res.zoomFactor).toBe(16)
    const call = vi.mocked(fetch).mock.calls[0]!
    expect(new URL(String(call[0])).pathname).toBe("/v2/unzoom")
    expect(JSON.parse(String((call[1] as RequestInit).body))).toEqual({ image: { base64: "SU4=", format: "png" }, quantize: 16 })
  })

  it("sends interpolation-v2 both keyframes wrapped with their size", async () => {
    vi.stubGlobal("fetch", vi.fn(async () =>
      new Response(JSON.stringify({ background_job_id: "job-i", status: "processing" }), { status: 202 })))
    const res = await new PixelLabClient("key").interpolationV2({
      startImage: { base64: "QQ==", format: "png" },
      endImage: { base64: "Qg==", format: "png" },
      width: 64,
      height: 48,
      action: "knocked backward",
      seed: 3,
    })
    expect(res.background_job_id).toBe("job-i")
    const call = vi.mocked(fetch).mock.calls[0]!
    expect(new URL(String(call[0])).pathname).toBe("/v2/interpolation-v2")
    expect(JSON.parse(String((call[1] as RequestInit).body))).toEqual({
      start_image: { image: { base64: "QQ==", format: "png" }, size: { width: 64, height: 48 } },
      end_image: { image: { base64: "Qg==", format: "png" }, size: { width: 64, height: 48 } },
      action: "knocked backward",
      image_size: { width: 64, height: 48 },
      seed: 3,
    })
  })

  it("sends edit-animation-v2 every frame with its size", async () => {
    vi.stubGlobal("fetch", vi.fn(async () =>
      new Response(JSON.stringify({ background_job_id: "job-e", status: "processing" }), { status: 202 })))
    await new PixelLabClient("key").editAnimationV2({
      frames: [{ base64: "MA==", format: "png" }, { base64: "MQ==", format: "png" }],
      width: 32,
      height: 32,
      description: "add a red cape",
    })
    const call = vi.mocked(fetch).mock.calls[0]!
    expect(new URL(String(call[0])).pathname).toBe("/v2/edit-animation-v2")
    expect(JSON.parse(String((call[1] as RequestInit).body))).toEqual({
      description: "add a red cape",
      frames: [
        { image: { base64: "MA==", format: "png" }, size: { width: 32, height: 32 } },
        { image: { base64: "MQ==", format: "png" }, size: { width: 32, height: 32 } },
      ],
      image_size: { width: 32, height: 32 },
    })
  })

  it("sends reduce-colors a whole frame set in one call and returns one result per frame", async () => {
    vi.stubGlobal("fetch", vi.fn(async () =>
      new Response(JSON.stringify({
        images: [{ base64: "QQ==" }, { base64: "Qg==" }],
        palette: { base64: "UA==" },
        n_colors: 8,
      }), { status: 200 })))
    const res = await new PixelLabClient("key").reduceColors({
      images: [{ base64: "MA==", format: "png" }, { base64: "MQ==", format: "png" }],
      numColors: 8,
    })
    expect(res.pngs.map((b) => b.toString("base64"))).toEqual(["QQ==", "Qg=="])
    const call = vi.mocked(fetch).mock.calls[0]!
    expect(JSON.parse(String((call[1] as RequestInit).body)).images).toHaveLength(2)
  })

  it("refuses a Cleanup-tier response with a different number of frames than were sent", async () => {
    vi.stubGlobal("fetch", vi.fn(async () =>
      new Response(JSON.stringify({ images: [{ base64: "QQ==" }] }), { status: 200 })))
    await expect(new PixelLabClient("key").correctPixelart({
      images: [{ base64: "MA==", format: "png" }, { base64: "MQ==", format: "png" }],
    })).rejects.toThrow(/sent 2 image\(s\), got 1 back/)
  })

  it("sends generate-font-pro and reads the completed job's download URLs", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input: string) => {
      const url = new URL(String(input))
      if (url.pathname === "/v2/generate-font-pro") {
        return new Response(JSON.stringify({ background_job_id: "font-1", status: "processing" }), { status: 202 })
      }
      return new Response(JSON.stringify({
        job_id: "font-1",
        status: "completed",
        glyph_px: 16,
        download_atlas_url: "https://cdn.example/atlas.png",
        download_ttf_url: "https://cdn.example/font.ttf",
      }), { status: 200 })
    }))
    const client = new PixelLabClient("key")
    await client.generateFontPro({ description: "arcade", weight: "Bold", glyphPx: 16, fontName: "Arcade" })
    const job = await client.getFontJob("font-1")
    expect(job.download_ttf_url).toBe("https://cdn.example/font.ttf")
    const calls = vi.mocked(fetch).mock.calls
    expect(JSON.parse(String((calls[0]![1] as RequestInit).body))).toEqual({
      description: "arcade",
      weight: "Bold",
      glyph_px: 16,
      font_name: "Arcade",
    })
    expect(new URL(String(calls[1]![0])).pathname).toBe("/v2/generate-font-pro/font-1")
  })
})

describe("unzoomFile", () => {
  let dir: string
  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "pixelkiln-unzoom-"))
  })
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it("writes beside the input by default and never over it", async () => {
    const input = path.join(dir, "knight.png")
    await writeFile(input, png(256, 256))
    const unzoom = vi.fn(async () => ({
      png: png(16, 16),
      originalSize: { width: 256, height: 256 },
      unzoomedSize: { width: 16, height: 16 },
      zoomFactor: 16,
      usage: null,
    }))
    const res = await unzoomFile({ unzoom }, input, { quantize: 0 })
    expect(res.out).toBe(path.join(dir, "knight.unzoomed.png"))
    expect(defaultUnzoomOut(input)).toBe(res.out)
    expect((await readFile(res.out)).equals(png(16, 16))).toBe(true)
    expect(unzoom.mock.calls[0]![0]).toMatchObject({ image: { format: "png" }, quantize: 0 })
    await expect(unzoomFile({ unzoom }, input, { out: input })).rejects.toThrow(/will not overwrite its own input/)
    await expect(unzoomFile({ unzoom }, input)).rejects.toThrow(/already exists/)
  })

  it("refuses an image below PixelLab's 256px floor before sending anything", async () => {
    const input = path.join(dir, "small.png")
    await writeFile(input, png(64, 64))
    const unzoom = vi.fn()
    await expect(unzoomFile({ unzoom }, input)).rejects.toThrow(/at least 256x256/)
    expect(unzoom).not.toHaveBeenCalled()
  })
})

describe("generateFont", () => {
  let dir: string
  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "pixelkiln-font-"))
  })
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it("polls until completed and writes the .ttf and the atlas", async () => {
    const statuses = ["processing", "finalizing", "completed"]
    const client = {
      generateFontPro: vi.fn(async () => ({ background_job_id: "font-9", status: "processing" })),
      getFontJob: vi.fn(async () => {
        const status = statuses.shift()!
        return {
          job_id: "font-9",
          status,
          glyph_px: 16,
          download_ttf_url: status === "completed" ? "https://cdn.example/f.ttf" : null,
          download_atlas_url: status === "completed" ? "https://cdn.example/a.png" : null,
        }
      }),
      download: vi.fn(async (url: string) => Buffer.from(url.endsWith(".ttf") ? "TTF" : "PNG")),
    }
    const seen: string[] = []
    const res = await generateFont(client, {
      description: "arcade",
      weight: "Regular",
      out: path.join(dir, "fonts", "arcade.ttf"),
      sleep: async () => {},
      onProgress: (status) => seen.push(status),
    })
    expect(seen).toEqual(["processing", "finalizing", "completed"])
    expect(res.ttf).toBe(path.join(dir, "fonts", "arcade.ttf"))
    expect(res.atlas).toBe(path.join(dir, "fonts", "arcade.png"))
    expect(await readFile(res.ttf, "utf8")).toBe("TTF")
    expect(await readFile(res.atlas, "utf8")).toBe("PNG")
    expect(fontOutputPaths(path.join(dir, "x"))).toEqual({ ttf: path.join(dir, "x.ttf"), atlas: path.join(dir, "x.png") })
  })

  it("stops on an upstream failure and refuses to replace existing files without force", async () => {
    const failing = {
      generateFontPro: vi.fn(async () => ({ background_job_id: "font-f", status: "processing" })),
      getFontJob: vi.fn(async () => ({ job_id: "font-f", status: "failed" })),
      download: vi.fn(),
    }
    await expect(generateFont(failing, { description: "x", weight: "Bold", out: path.join(dir, "f"), sleep: async () => {} }))
      .rejects.toThrow(/failed upstream/)
    await writeFile(path.join(dir, "g.ttf"), "old")
    await expect(generateFont(failing, { description: "x", weight: "Bold", out: path.join(dir, "g") }))
      .rejects.toThrow(/already exists/)
    expect(existsSync(path.join(dir, "g.png"))).toBe(false)
  })
})

describe("parseArgs: unzoom and font", () => {
  it("reads the new flags and range-checks them", () => {
    expect(parseArgs(["unzoom", "--from", "a.png", "--quantize", "-1"]).quantize).toBe(-1)
    expect(() => parseArgs(["unzoom", "--from", "a.png", "--quantize", "300"])).toThrow(/--quantize/)
    const font = parseArgs(["font", "--description", "arcade", "--weight", "Bold", "--glyph-px", "32", "--out", "f"])
    expect(font).toMatchObject({ command: "font", description: "arcade", weight: "Bold", glyphPx: 32, out: "f" })
  })
})
