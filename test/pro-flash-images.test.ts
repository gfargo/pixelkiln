import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { PixelLabClient } from "../src/client.ts"
import { sha256 } from "../src/hash.ts"
import { upsert } from "../src/lock.ts"
import { loadManifest, resolveSpecs } from "../src/manifest.ts"
import { buildPlan } from "../src/pipeline/plan.ts"
import { fetchAssets } from "../src/pipeline/fetch.ts"
import { poll } from "../src/pipeline/poll.ts"
import { submit } from "../src/pipeline/submit.ts"
import { encodeRgbaPng } from "../src/png.ts"
import { PixelLabProvider, proFlashCharacterCost, proFlashImageCost } from "../src/providers/pixellab.ts"
import { RevisionSchema, type Lock } from "../src/types.ts"

function png(shade: number, width = 32, height = 32): Buffer {
  return encodeRgbaPng(width, height, Buffer.alloc(width * height * 4, shade))
}
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status })
const proFlashJob = (id: string) => ({
  background_job_id: id,
  image_id: `img-${id}`,
  source_image_id: `src-${id}`,
  status: "processing",
  image_size: { width: 64, height: 64 },
  estimated_generations: 5,
})

let dir: string
let manifestPath: string
let lockPath: string
beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "pixelkiln-pro-flash-"))
  manifestPath = path.join(dir, "pixelkiln.manifest.json")
  lockPath = path.join(dir, "pixelkiln.lock.json")
})
afterEach(async () => {
  vi.unstubAllGlobals()
  await rm(dir, { recursive: true, force: true })
})

async function manifest(styles: Record<string, unknown>, assets: Record<string, unknown>) {
  await writeFile(manifestPath, JSON.stringify({ name: "pro-flash", provider: "pixellab", styles, assets }))
  return loadManifest(manifestPath)
}

describe("Pro Flash pricing", () => {
  it("prices an image by its longer side and a character's image tier the same way", () => {
    expect([proFlashImageCost(32, 32), proFlashImageCost(96, 64), proFlashImageCost(128, 128), proFlashImageCost(256, 208)]).toEqual([5, 5, 6, 9])
    expect(proFlashCharacterCost(64, 64, false)).toBe(6)
    expect(proFlashCharacterCost(64, 64, true)).toBe(1)
  })
})

describe("imageProFlash", () => {
  it("validates size, style image count, and traits without a style image", async () => {
    await writeFile(path.join(dir, "a.png"), png(1))
    await writeFile(path.join(dir, "b.png"), png(2))
    const bad = async (style: Record<string, unknown>, asset: Record<string, unknown> = { prompt: "x" }) =>
      resolveSpecs(await manifest({ stills: { generator: "imageProFlash", outDir: "art", ...style } }, { knight: asset }))
    await expect(bad({}, { prompt: "x", width: 50, height: 50 })).rejects.toThrow(/multiples of 4/)
    await expect(bad({}, { prompt: "x", width: 300, height: 64 })).rejects.toThrow(/16 to 256/)
    await expect(bad({ styleImages: [{ path: "a.png" }, { path: "b.png" }] })).rejects.toThrow(/one style image/)
    await expect(bad({ styleTraits: { outline: false } })).rejects.toThrow(/styleTraits choose what a style image lends/)
    const [spec] = await bad({ styleImages: [{ path: "a.png" }], styleTraits: { outline: false } }, { prompt: "x", width: 96, height: 64 })
    expect(spec).toMatchObject({ generator: "imageProFlash", width: 96, height: 64, styleTraits: { outline: false } })
    expect(PixelLabProvider.forOffline().estimate(spec!)).toMatchObject({ unit: "generations", amount: 5, candidates: 1 })
  })

  it("submits create-image-pro-flash with the style image and traits, records the owned image id, and downloads the result", async () => {
    await writeFile(path.join(dir, "style.png"), png(9, 48, 48))
    const loaded = await manifest(
      { stills: { generator: "imageProFlash", outDir: "art", styleImages: [{ path: "style.png" }], styleTraits: { palette: true, shading: false } } },
      { knight: { prompt: "a knight in blue armor", width: 64, height: 64 } },
    )
    const [spec] = await resolveSpecs(loaded)
    const lock: Lock = { version: 2, entries: {} }
    const plan = await buildPlan([spec!], lock)
    const result = png(200, 64, 64)
    let body: Record<string, unknown> | null = null
    vi.stubGlobal("fetch", vi.fn(async (input: string, init?: RequestInit) => {
      const url = new URL(String(input))
      if (url.pathname === "/v2/create-image-pro-flash") {
        body = JSON.parse(String(init!.body))
        return json(proFlashJob("job-1"), 202)
      }
      if (url.pathname === "/v2/background-jobs/job-1") {
        return json({
          id: "job-1", status: "completed", created_at: "now",
          last_response: { images: [{ type: "base64", base64: result.toString("base64") }], source_image_id: "src-job-1" },
          usage: { type: "generations", generations: 5 },
        })
      }
      throw new Error(`unexpected ${url.pathname}`)
    }))
    const provider = new PixelLabProvider(new PixelLabClient("key"))
    await submit(provider, loaded, plan.actionable, lock, lockPath, { spacingMs: 0 })
    expect(body).toMatchObject({
      image_size: { width: 64, height: 64 },
      no_background: true,
      style_image: { image: { format: "png" }, size: { width: 48, height: 48 } },
      style_options: { color_palette: true, shading: false },
    })
    expect(lock.entries["stills/knight"]!.providerMetadata.pixellab).toMatchObject({
      imageProFlash: { imageId: "img-job-1", sourceImageId: "src-job-1", estimatedGenerations: 5 },
    })
    await poll(provider, lock, lockPath, { intervalMs: 0, specs: [spec!] })
    expect(lock.entries["stills/knight"]).toMatchObject({ status: "selected", billed: { amount: 5, unit: "generations" } })
    await fetchAssets(provider, [spec!], lock, lockPath)
    expect((await readFile(spec!.outFile)).equals(result)).toBe(true)
  })
})

describe("pro-flash revision engine", () => {
  async function project(revision: Record<string, unknown>, size = 64) {
    await writeFile(path.join(dir, "source.png"), png(40, size, size))
    await writeFile(path.join(dir, "mask.png"), png(255, size, size))
    return manifest(
      { base: { generator: "map", outDir: "art" } },
      { source: { prompt: "a tower", source: "source.png" }, revised: { prompt: "add snow", width: size, height: size, revision } },
    )
  }

  it("is only accepted on image-to-image and inpaint", () => {
    expect(RevisionSchema.safeParse({ mode: "reduce-colors", from: "a", engine: "pro-flash" }).success).toBe(false)
    expect(RevisionSchema.safeParse({ mode: "image-to-image", from: "a", engine: "pro-flash" }).success).toBe(true)
  })

  it("sends edit-image-pro-flash and inpaint-image-pro-flash, priced on the Pro Flash tier", async () => {
    const calls: { path: string; body: Record<string, unknown> }[] = []
    vi.stubGlobal("fetch", vi.fn(async (input: string, init?: RequestInit) => {
      const url = new URL(String(input))
      calls.push({ path: url.pathname, body: JSON.parse(String(init!.body)) })
      return json(proFlashJob(`job-${calls.length}`), 202)
    }))
    const provider = new PixelLabProvider(new PixelLabClient("key"))

    const edit = await project({ mode: "image-to-image", from: "source", engine: "pro-flash" })
    const [editSpec] = await resolveSpecs(edit, { assets: ["revised"] })
    expect(provider.estimate(editSpec!)).toMatchObject({ amount: 5 })
    const lock: Lock = { version: 2, entries: {} }
    await submit(provider, edit, (await buildPlan([editSpec!], lock)).actionable, lock, lockPath, { spacingMs: 0 })
    expect(calls[0]).toMatchObject({ path: "/v2/edit-image-pro-flash", body: { method: "text", description: "add snow", image: { format: "png" } } })
    expect(lock.entries["base/revised"]!.revision).toMatchObject({ mode: "image-to-image", engine: "pro-flash" })

    const inpaint = await project({ mode: "inpaint", from: "source", mask: "mask.png", engine: "pro-flash" })
    const [inpaintSpec] = await resolveSpecs(inpaint, { assets: ["revised"] })
    const lock2: Lock = { version: 2, entries: {} }
    await submit(provider, inpaint, (await buildPlan([inpaintSpec!], lock2)).actionable, lock2, lockPath, { spacingMs: 0 })
    expect(calls[1]).toMatchObject({ path: "/v2/inpaint-image-pro-flash", body: { description: "add snow", mask_image: { format: "png" } } })
  })

  it("refuses sizes the Pro Flash edit tier cannot take, a strength, and ComfyUI", async () => {
    await expect(resolveSpecs(await project({ mode: "image-to-image", from: "source", engine: "pro-flash" }, 300), { assets: ["revised"] }))
      .rejects.toThrow(/32 to 256 pixels per side/)
    await expect(resolveSpecs(await project({ mode: "image-to-image", from: "source", engine: "pro-flash", strength: 0.3 }), { assets: ["revised"] }))
      .rejects.toThrow(/takes no strength/)
    // The same revision on a ComfyUI style is refused at resolve, not silently run through the workflow.
    await writeFile(path.join(dir, "source.png"), png(40, 16, 16))
    await writeFile(path.join(dir, "workflow.json"), JSON.stringify({
      "5": { class_type: "EmptyLatentImage", inputs: { width: 16, height: 16 } },
      "6": { class_type: "CLIPTextEncode", inputs: { text: "" } },
      "9": { class_type: "SaveImage", inputs: {} },
      "12": { class_type: "LoadImage", inputs: { image: "placeholder.png" } },
    }))
    await writeFile(manifestPath, JSON.stringify({
      name: "comfy",
      provider: "comfyui",
      styles: {
        base: {
          generator: "map",
          outDir: "out",
          providerOptions: {
            comfyui: {
              workflowFile: "workflow.json",
              outputNodeId: "9",
              bindings: {
                prompt: { nodeId: "6", input: "text" },
                width: { nodeId: "5", input: "width" },
                height: { nodeId: "5", input: "height" },
                sourceImage: { nodeId: "12", input: "image" },
              },
            },
          },
        },
      },
      assets: {
        source: { prompt: "a tower", source: "source.png" },
        revised: { prompt: "add snow", width: 16, height: 16, revision: { mode: "image-to-image", from: "source", engine: "pro-flash" } },
      },
    }))
    await expect(resolveSpecs(await loadManifest(manifestPath), { assets: ["revised"] })).rejects.toThrow(/no "pro-flash" revision engine/)
  })
})

describe("reusing an owned Pro Flash image (#145)", () => {
  it("sends source_image_id instead of the sprite when the reference is an imageProFlash output", async () => {
    await mkdir(path.join(dir, "art"), { recursive: true })
    const still = png(77, 64, 64)
    await writeFile(path.join(dir, "art", "knight.png"), still)
    const loaded = await manifest(
      {
        stills: { generator: "imageProFlash", outDir: "art" },
        cast: { generator: "character", mode: "pro-flash", outDir: "cast", size: 64 },
      },
      {
        knight: { prompt: "a knight", width: 64, height: 64, styles: ["stills"] },
        hero: { prompt: "a knight", reference: "art/knight.png", styles: ["cast"] },
      },
    )
    const specs = await resolveSpecs(loaded)
    const hero = specs.find((spec) => spec.assetId === "hero")!
    const lock: Lock = { version: 2, entries: {} }
    upsert(lock, "stills/knight", {
      styleId: "stills", assetId: "knight", specHash: specs.find((s) => s.assetId === "knight")!.specHash,
      generator: "imageProFlash", prompt: "a knight", width: 64, height: 64, status: "downloaded", provider: "pixellab",
      objectId: "job-still", outputs: [{ path: "art/knight.png", sha256: sha256(still), mediaType: "image/png" }],
      providerMetadata: { pixellab: { imageProFlash: { imageId: "img-1", sourceImageId: "owned-south-1" } } },
    })
    let body: Record<string, unknown> | null = null
    vi.stubGlobal("fetch", vi.fn(async (_input: string, init?: RequestInit) => {
      body = JSON.parse(String(init!.body))
      return json({ background_job_id: "job-c", character_id: "char-1", status: "processing", estimated_generations: 1, first_direction_generated: true }, 202)
    }))
    const provider = new PixelLabProvider(new PixelLabClient("key"))
    await submit(provider, loaded, (await buildPlan([hero], lock)).actionable, lock, lockPath, { spacingMs: 0 })
    expect(body).toMatchObject({ source_image_id: "owned-south-1" })
    expect(body).not.toHaveProperty("first_frame")

    // A sprite with no owned copy still uploads as before.
    await writeFile(path.join(dir, "art", "knight.png"), png(12, 64, 64))
    const [fresh] = await resolveSpecs(await loadManifest(manifestPath), { assets: ["hero"] })
    const lock2: Lock = { version: 2, entries: {} }
    await submit(provider, loaded, (await buildPlan([fresh!], lock2)).actionable, lock2, lockPath, { spacingMs: 0 })
    expect(body).toHaveProperty("first_frame")
    expect(body).not.toHaveProperty("source_image_id")
  })
})
