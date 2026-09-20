import path from "node:path"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { loadManifest, resolveSpecs } from "../src/manifest.ts"
import { PixelLabClient } from "../src/client.ts"
import { PixelLabProvider } from "../src/providers/pixellab.ts"
import { encodeRgbaPng } from "../src/png.ts"
import { candidateCount, generationCost, type ResolvedSpec } from "../src/types.ts"

let dir: string
let manifestPath: string

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "pixelkiln-image-pro-"))
  manifestPath = path.join(dir, "pixelkiln.manifest.json")
})
afterEach(async () => {
  vi.unstubAllGlobals()
  await rm(dir, { recursive: true, force: true })
})

async function writeManifest(style: Record<string, unknown> = {}, asset: Record<string, unknown> = {}) {
  await writeFile(manifestPath, JSON.stringify({
    name: "image-pro-test",
    provider: "pixellab",
    styles: { base: { generator: "imagePro", outDir: "art", ...style } },
    assets: { scene: { prompt: "a moonlit forest clearing", ...asset } },
  }))
  return loadManifest(manifestPath)
}

describe("PixelLabClient: generate-image-v2 wire", () => {
  const calls: { path: string; method: string; body: unknown }[] = []
  beforeEach(() => {
    calls.length = 0
    vi.stubGlobal("fetch", vi.fn(async (input: string, init?: RequestInit) => {
      const url = new URL(String(input))
      calls.push({ path: url.pathname, method: init?.method ?? "GET", body: init?.body ? JSON.parse(String(init.body)) : null })
      return new Response(JSON.stringify({ background_job_id: "bg-1", status: "processing" }), {
        status: 202,
        headers: { "Content-Type": "application/json" },
      })
    }))
  })

  it("sends description, image_size, and the optional fields it was given", async () => {
    const client = new PixelLabClient("key")
    await client.createImagePro({
      description: "a moonlit forest clearing",
      width: 384,
      height: 216,
      noBackground: false,
      seed: 7,
    })
    expect(calls[0]).toMatchObject({
      path: "/v2/generate-image-v2",
      method: "POST",
      body: {
        description: "a moonlit forest clearing",
        image_size: { width: 384, height: 216 },
        no_background: false,
        seed: 7,
      },
    })
  })
})

describe("resolving an imagePro spec", () => {
  it("prices flat 40 regardless of size and counts candidates by size tier", async () => {
    const loaded = await writeManifest({}, { width: 64, height: 64 })
    const [spec] = await resolveSpecs(loaded)
    expect(spec.generator).toBe("imagePro")
    expect(spec.width).toBe(64)
    expect(spec.height).toBe(64)
    expect(spec.cost).toBe(40)
    expect(spec.candidates).toBe(candidateCount(64))
  })

  it("supports a non-square canvas via asset width/height overrides", async () => {
    const loaded = await writeManifest({}, { width: 384, height: 216 })
    const [spec] = await resolveSpecs(loaded)
    expect(spec.width).toBe(384)
    expect(spec.height).toBe(216)
    expect(spec.cost).toBe(generationCost(384, 216, "imagePro"))
  })
})

describe("provider", () => {
  const provider = new PixelLabProvider({} as never)

  it("supports the imagePro generator", () => {
    expect(provider.supports("imagePro")).toBe(true)
  })

  it("estimates a flat 40 with candidates by size", () => {
    const spec = { generator: "imagePro", width: 64, height: 64, size: 64 } as ResolvedSpec
    expect(provider.estimate(spec)).toEqual({ unit: "generations", amount: 40, candidates: candidateCount(64) })
  })

  it("rejects a canvas outside the API's 792x688 box", async () => {
    const loaded = await writeManifest({}, { width: 800, height: 64 })
    await expect(resolveSpecs(loaded)).rejects.toThrow(/16 to 792 wide/)
  })

  it("rejects style images", async () => {
    await writeFile(path.join(dir, "ref.png"), encodeRgbaPng(16, 16, Buffer.alloc(16 * 16 * 4, 255)))
    const loaded = await writeManifest({ styleImages: [{ path: "ref.png" }] })
    await expect(resolveSpecs(loaded)).rejects.toThrow(/does not support style images/)
  })
})

describe("poll and selectCandidate", () => {
  it("polls straight to review with one candidate per decoded image", async () => {
    const png1 = Buffer.from("one").toString("base64")
    const png2 = Buffer.from("two").toString("base64")
    const provider = new PixelLabProvider({
      getBackgroundJob: async () => ({
        id: "bg-1",
        status: "completed",
        last_response: { images: [{ base64: png1, format: "png" }, { base64: png2, format: "png" }] },
        usage: { type: "generations", generations: 40 },
      }),
    } as never)

    const state = await provider.poll("bg-1", "imagePro")
    expect(state.status).toBe("review")
    if (state.status !== "review") return
    expect(state.candidateUrls).toHaveLength(2)
    expect(state.candidateUrls.every((u) => u.startsWith("file://"))).toBe(true)
    expect(state.billed).toEqual({ amount: 40, unit: "generations" })

    const picked = await provider.selectCandidate("bg-1", 1, undefined, "imagePro")
    expect(picked.objectId).toBe("bg-1#1")
    expect(picked.sourceUrl).toBe(state.candidateUrls[1])
  })

  it("reports processing while the job is still running", async () => {
    const provider = new PixelLabProvider({
      getBackgroundJob: async () => ({ id: "bg-1", status: "processing" }),
    } as never)
    const state = await provider.poll("bg-1", "imagePro")
    expect(state.status).toBe("processing")
  })

  it("fails loudly on a completed job with no recognized images field", async () => {
    const provider = new PixelLabProvider({
      getBackgroundJob: async () => ({ id: "bg-1", status: "completed", last_response: { unexpected: true } }),
    } as never)
    const state = await provider.poll("bg-1", "imagePro")
    expect(state.status).toBe("failed")
    if (state.status !== "failed") return
    expect(state.error).toMatch(/no recognized images array/)
  })

  it("surfaces an upstream failure", async () => {
    const provider = new PixelLabProvider({
      getBackgroundJob: async () => ({ id: "bg-1", status: "failed" }),
    } as never)
    const state = await provider.poll("bg-1", "imagePro")
    expect(state.status).toBe("failed")
  })
})

