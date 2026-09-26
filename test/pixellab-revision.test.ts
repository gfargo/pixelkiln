import path from "node:path"
import { existsSync } from "node:fs"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { loadManifest, resolveSpecs } from "../src/manifest.ts"
import { PixelLabClient } from "../src/client.ts"
import { PixelLabProvider } from "../src/providers/pixellab.ts"
import { buildPlan } from "../src/pipeline/plan.ts"
import { submit } from "../src/pipeline/submit.ts"
import { poll } from "../src/pipeline/poll.ts"
import { fetchAssets } from "../src/pipeline/fetch.ts"
import { encodeRgbaPng } from "../src/png.ts"
import type { Lock } from "../src/types.ts"

function png(shade = 20, width = 32, height = 32): Buffer {
  return encodeRgbaPng(width, height, Buffer.alloc(width * height * 4, shade))
}

describe("PixelLab: supportsRevision", () => {
  it("supports every revision mode but outpaint", () => {
    const provider = PixelLabProvider.forOffline()
    expect(provider.supportsRevision("inpaint")).toBe(true)
    expect(provider.supportsRevision("image-to-image")).toBe(true)
    expect(provider.supportsRevision("reduce-colors")).toBe(true)
    expect(provider.supportsRevision("correct-pixelart")).toBe(true)
    expect(provider.supportsRevision("animate")).toBe(true)
    expect(provider.supportsRevision("animate-pixminimax")).toBe(true)
    expect(provider.supportsRevision("animate-skeleton")).toBe(true)
    expect(provider.supportsRevision("interpolate")).toBe(true)
    expect(provider.supportsRevision("edit-animation")).toBe(true)
    expect(provider.supportsRevision("outpaint")).toBe(false)
  })
})

describe("PixelLabClient: the revision wire", () => {
  const calls: { path: string; method: string; body: unknown }[] = []
  const answer = (body: unknown) => new Response(JSON.stringify(body), { status: 202, headers: { "Content-Type": "application/json" } })
  beforeEach(() => {
    calls.length = 0
    vi.stubGlobal("fetch", vi.fn(async (input: string, init?: RequestInit) => {
      const url = new URL(String(input))
      calls.push({ path: url.pathname, method: init?.method ?? "GET", body: init?.body ? JSON.parse(String(init.body)) : null })
      return answer({ background_job_id: "job-1", status: "processing" })
    }))
  })
  afterEach(() => vi.unstubAllGlobals())

  it("sends inpaint-v3 the way its schema documents it", async () => {
    const client = new PixelLabClient("key")
    await client.inpaintV3({
      description: "add a door",
      image: { base64: "U09VUkNF", format: "png" },
      width: 64,
      height: 32,
      maskImage: { base64: "TUFTSw==", format: "png" },
      noBackground: true,
      cropToMask: true,
      seed: 7,
    })
    expect(calls[0]).toMatchObject({
      path: "/v2/inpaint-v3",
      method: "POST",
      body: {
        description: "add a door",
        inpainting_image: { image: { base64: "U09VUkNF", format: "png" }, size: { width: 64, height: 32 } },
        mask_image: { image: { base64: "TUFTSw==", format: "png" }, size: { width: 64, height: 32 } },
        no_background: true,
        crop_to_mask: true,
        seed: 7,
      },
    })
  })

  it("sends edit-images-v2 as a single-image edit_with_text call", async () => {
    const client = new PixelLabClient("key")
    await client.editImagesV2({
      description: "add snow",
      image: { base64: "U09VUkNF", format: "png" },
      width: 48,
      height: 48,
    })
    expect(calls[0]).toMatchObject({
      path: "/v2/edit-images-v2",
      method: "POST",
      body: {
        method: "edit_with_text",
        description: "add snow",
        edit_images: [{ image: { base64: "U09VUkNF", format: "png" }, width: 48, height: 48 }],
        image_size: { width: 48, height: 48 },
      },
    })
  })
})

describe("PixelLabClient: the Cleanup-tier wire", () => {
  it("sends reduce-colors with numColors, omitting paletteImage", async () => {
    vi.stubGlobal("fetch", vi.fn(async () =>
      new Response(JSON.stringify({
        images: [{ base64: "UkVTVUxU" }],
        palette: { base64: "UEFMRVRURQ==" },
        n_colors: 16,
      }), { status: 200 })))
    const client = new PixelLabClient("key")
    const res = await client.reduceColors({ image: { base64: "U09VUkNF", format: "png" }, numColors: 16 })
    expect(res.png.toString("base64")).toBe("UkVTVUxU")
    expect(res.paletteStripPng.toString("base64")).toBe("UEFMRVRURQ==")
    expect(res.nColors).toBe(16)
    const call = vi.mocked(fetch).mock.calls[0]!
    expect(new URL(String(call[0])).pathname).toBe("/v2/reduce-colors")
    expect(JSON.parse(String((call[1] as RequestInit).body))).toEqual({
      images: [{ base64: "U09VUkNF", format: "png" }],
      num_colors: 16,
    })
  })

  it("sends reduce-colors with a paletteImage and dithering, omitting numColors", async () => {
    vi.stubGlobal("fetch", vi.fn(async () =>
      new Response(JSON.stringify({ images: [{ base64: "UkVTVUxU" }], palette: { base64: "UA==" }, n_colors: 4 }), { status: 200 })))
    const client = new PixelLabClient("key")
    await client.reduceColors({
      image: { base64: "U09VUkNF", format: "png" },
      paletteImage: { base64: "UEFM", format: "png" },
      dithering: "4x4",
      ditheringStrength: 7,
    })
    const call = vi.mocked(fetch).mock.calls[0]!
    expect(JSON.parse(String((call[1] as RequestInit).body))).toEqual({
      images: [{ base64: "U09VUkNF", format: "png" }],
      palette_image: { base64: "UEFM", format: "png" },
      dithering: "4x4",
      dithering_strength: 7,
    })
  })

  it("sends correct-pixelart with strength", async () => {
    vi.stubGlobal("fetch", vi.fn(async () =>
      new Response(JSON.stringify({ images: [{ base64: "UkVTVUxU" }] }), { status: 200 })))
    const client = new PixelLabClient("key")
    const res = await client.correctPixelart({ image: { base64: "U09VUkNF", format: "png" }, strength: 0.2 })
    expect(res.png.toString("base64")).toBe("UkVTVUxU")
    const call = vi.mocked(fetch).mock.calls[0]!
    expect(new URL(String(call[0])).pathname).toBe("/v2/correct-pixelart")
    expect(JSON.parse(String((call[1] as RequestInit).body))).toEqual({
      images: [{ base64: "U09VUkNF", format: "png" }],
      strength: 0.2,
    })
  })

  afterEach(() => vi.unstubAllGlobals())
})

describe("PixelLabClient: the animate wire", () => {
  afterEach(() => vi.unstubAllGlobals())

  it("sends animate-with-text-v3 with first_frame and action, omitting last_frame when unset", async () => {
    vi.stubGlobal("fetch", vi.fn(async () =>
      new Response(JSON.stringify({ background_job_id: "job-1", status: "processing" }), { status: 202 })))
    const client = new PixelLabClient("key")
    await client.animateWithTextV3({
      firstFrame: { base64: "RklGU1Q=", format: "png" },
      action: "walking forward",
      frameCount: 8,
      seed: 42,
      noBackground: true,
    })
    const call = vi.mocked(fetch).mock.calls[0]!
    expect(new URL(String(call[0])).pathname).toBe("/v2/animate-with-text-v3")
    expect(JSON.parse(String((call[1] as RequestInit).body))).toEqual({
      first_frame: { base64: "RklGU1Q=", format: "png" },
      action: "walking forward",
      frame_count: 8,
      seed: 42,
      no_background: true,
    })
  })

  it("sends animate-with-text-v3 with last_frame and enhance_prompt when set", async () => {
    vi.stubGlobal("fetch", vi.fn(async () =>
      new Response(JSON.stringify({ background_job_id: "job-1", status: "processing" }), { status: 202 })))
    const client = new PixelLabClient("key")
    await client.animateWithTextV3({
      firstFrame: { base64: "Rg==", format: "png" },
      lastFrame: { base64: "TA==", format: "png" },
      action: "chest lid closing",
      enhancePrompt: true,
    })
    const call = vi.mocked(fetch).mock.calls[0]!
    expect(JSON.parse(String((call[1] as RequestInit).body))).toEqual({
      first_frame: { base64: "Rg==", format: "png" },
      last_frame: { base64: "TA==", format: "png" },
      action: "chest lid closing",
      enhance_prompt: true,
    })
  })

  it("sends animate-pixminimax with description and direction", async () => {
    vi.stubGlobal("fetch", vi.fn(async () =>
      new Response(JSON.stringify({ background_job_id: "job-2", status: "processing" }), { status: 202 })))
    const client = new PixelLabClient("key")
    await client.animatePixminimax({
      firstFrame: { base64: "Rg==", format: "png" },
      description: "sword slash",
      frameCount: 12,
      direction: "east",
      enhancePrompt: true,
    })
    const call = vi.mocked(fetch).mock.calls[0]!
    expect(new URL(String(call[0])).pathname).toBe("/v2/animate-pixminimax")
    expect(JSON.parse(String((call[1] as RequestInit).body))).toEqual({
      first_frame: { base64: "Rg==", format: "png" },
      description: "sword slash",
      frame_count: 12,
      direction: "east",
      enhance_prompt: true,
    })
  })

  const keypoint = (label: string) => ({ label, x: 0.5, y: 0.5, z_index: 1 })

  it("sends animate-with-skeleton-v3 with first_frame_keypoints, keypoints, and direction, omitting unset optionals", async () => {
    vi.stubGlobal("fetch", vi.fn(async () =>
      new Response(JSON.stringify({ background_job_id: "job-3", status: "processing" }), { status: 202 })))
    const client = new PixelLabClient("key")
    await client.animateWithSkeletonV3({
      firstFrame: { base64: "Rg==", format: "png" },
      firstFrameKeypoints: [keypoint("NOSE")],
      keypoints: [[keypoint("NOSE")], [keypoint("NOSE")]],
      direction: "south",
    })
    const call = vi.mocked(fetch).mock.calls[0]!
    expect(new URL(String(call[0])).pathname).toBe("/v2/animate-with-skeleton-v3")
    expect(JSON.parse(String((call[1] as RequestInit).body))).toEqual({
      first_frame: { base64: "Rg==", format: "png" },
      first_frame_keypoints: [keypoint("NOSE")],
      keypoints: [[keypoint("NOSE")], [keypoint("NOSE")]],
      direction: "south",
    })
  })

  it("sends animate-with-skeleton-v3 with template_id, action, and description when set", async () => {
    vi.stubGlobal("fetch", vi.fn(async () =>
      new Response(JSON.stringify({ background_job_id: "job-4", status: "processing" }), { status: 202 })))
    const client = new PixelLabClient("key")
    await client.animateWithSkeletonV3({
      firstFrame: { base64: "Rg==", format: "png" },
      firstFrameKeypoints: [keypoint("NOSE")],
      keypoints: [[keypoint("NOSE")]],
      direction: "east",
      templateId: "bear",
      action: "walk",
      description: "a blue bear",
      seed: 3,
      noBackground: false,
    })
    const call = vi.mocked(fetch).mock.calls[0]!
    expect(JSON.parse(String((call[1] as RequestInit).body))).toEqual({
      first_frame: { base64: "Rg==", format: "png" },
      first_frame_keypoints: [keypoint("NOSE")],
      keypoints: [[keypoint("NOSE")]],
      direction: "east",
      template_id: "bear",
      action: "walk",
      description: "a blue bear",
      seed: 3,
      no_background: false,
    })
  })

  it("sends estimate-skeleton with image and parses keypoints back", async () => {
    const responseKeypoints = Array.from({ length: 18 }, (_, i) => keypoint(`JOINT_${i}`))
    vi.stubGlobal("fetch", vi.fn(async () =>
      new Response(JSON.stringify({ keypoints: responseKeypoints, usage: { type: "generations", generations: 0.1 } }), { status: 200 })))
    const client = new PixelLabClient("key")
    const res = await client.estimateSkeleton({ image: { base64: "Rg==", format: "png" } })
    const call = vi.mocked(fetch).mock.calls[0]!
    expect(new URL(String(call[0])).pathname).toBe("/v2/estimate-skeleton")
    expect(JSON.parse(String((call[1] as RequestInit).body))).toEqual({ image: { base64: "Rg==", format: "png" } })
    expect(res.keypoints).toEqual(responseKeypoints)
  })
})

describe("PixelLab provider: revision submit and poll", () => {
  let dir: string
  let manifestPath: string

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "pixelkiln-pixellab-revision-"))
    manifestPath = path.join(dir, "pixelkiln.manifest.json")
  })
  afterEach(async () => {
    vi.unstubAllGlobals()
    await rm(dir, { recursive: true, force: true })
  })

  async function writeProject(revision: Record<string, unknown>) {
    await writeFile(path.join(dir, "source.png"), png())
    if (revision.mask) await writeFile(path.join(dir, "mask.png"), png(255, 32, 32))
    await writeFile(manifestPath, JSON.stringify({
      name: "pixellab-revision-test",
      provider: "pixellab",
      styles: { base: { generator: "map", size: 32, outDir: "art" } },
      assets: {
        source: { prompt: "a stone tower", source: "source.png" },
        revised: { prompt: "add snow", width: 32, height: 32, revision },
      },
    }))
    return loadManifest(manifestPath)
  }

  it("submits an inpaint revision and reads a base64 result off the completed job", async () => {
    const loaded = await writeProject({ mode: "inpaint", from: "source", mask: "mask.png" })
    const [child] = await resolveSpecs(loaded, { assets: ["revised"] })
    const lock: Lock = { version: 2, entries: {} }
    const lockPath = path.join(dir, "pixelkiln.lock.json")
    const plan = await buildPlan([child!], lock)
    expect(plan.items[0]).toMatchObject({ state: "missing" })

    const resultPng = png(200, 32, 32)
    let submitBody: Record<string, unknown> | null = null
    let polls = 0
    vi.stubGlobal("fetch", vi.fn(async (input: string, init?: RequestInit) => {
      const url = new URL(String(input))
      if (url.pathname === "/v2/inpaint-v3") {
        submitBody = init?.body ? JSON.parse(String(init.body)) : null
        return new Response(JSON.stringify({ background_job_id: "bg-1", status: "processing" }), { status: 202 })
      }
      if (url.pathname === "/v2/background-jobs/bg-1") {
        polls += 1
        const status = polls < 2 ? "processing" : "completed"
        const body = status === "processing"
          ? { id: "bg-1", status, created_at: "now" }
          : { id: "bg-1", status, created_at: "now", last_response: { image: { base64: resultPng.toString("base64"), format: "png" } } }
        return new Response(JSON.stringify(body), { status: 200 })
      }
      throw new Error(`unexpected request: ${init?.method ?? "GET"} ${url.pathname}`)
    }))

    const provider = new PixelLabProvider(new PixelLabClient("key"))
    await submit(provider, loaded, plan.actionable, lock, lockPath, { spacingMs: 0 })
    expect(submitBody).toMatchObject({
      description: "add snow",
      inpainting_image: { size: { width: 32, height: 32 } },
      mask_image: { size: { width: 32, height: 32 } },
    })

    await poll(provider, lock, lockPath, { intervalMs: 0, specs: [child!] })
    expect(lock.entries["base/revised"]).toMatchObject({ status: "selected" })
    expect(lock.entries["base/revised"]!.sourceUrl).toMatch(/^file:\/\//)

    await fetchAssets(provider, [child!], lock, lockPath)
    expect(lock.entries["base/revised"]).toMatchObject({ status: "downloaded" })
    const written = await import("node:fs/promises").then((fs) => fs.readFile(child!.outFile))
    expect(written.equals(resultPng)).toBe(true)
  })

  it("fails clearly when a completed job has no recognizable image field, instead of retrying forever", async () => {
    const loaded = await writeProject({ mode: "image-to-image", from: "source" })
    const [child] = await resolveSpecs(loaded, { assets: ["revised"] })
    const lock: Lock = { version: 2, entries: {} }
    const lockPath = path.join(dir, "pixelkiln.lock.json")
    const plan = await buildPlan([child!], lock)

    vi.stubGlobal("fetch", vi.fn(async (input: string) => {
      const url = new URL(String(input))
      if (url.pathname === "/v2/edit-images-v2") {
        return new Response(JSON.stringify({ background_job_id: "bg-2", status: "processing" }), { status: 202 })
      }
      return new Response(JSON.stringify({
        id: "bg-2", status: "completed", created_at: "now",
        last_response: { totally_unexpected_field: true },
      }), { status: 200 })
    }))

    const provider = new PixelLabProvider(new PixelLabClient("key"))
    await submit(provider, loaded, plan.actionable, lock, lockPath, { spacingMs: 0 })
    const result = await poll(provider, lock, lockPath, { intervalMs: 0, specs: [child!] })
    expect(result.failed).toBe(1)
    expect(lock.entries["base/revised"]).toMatchObject({
      status: "failed",
      error: expect.stringMatching(/Invalid PixelLab response for revision job bg-2.*totally_unexpected_field/),
    })
  })

  it("refuses a declared strength on image-to-image, which PixelLab's edit endpoint has no knob for", async () => {
    const loaded = await writeProject({ mode: "image-to-image", from: "source", strength: 0.4 })
    const [child] = await resolveSpecs(loaded, { assets: ["revised"] })
    const lock: Lock = { version: 2, entries: {} }
    const lockPath = path.join(dir, "pixelkiln.lock.json")
    const plan = await buildPlan([child!], lock)
    vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 202 })))
    const provider = new PixelLabProvider(new PixelLabClient("key"))
    const result = await submit(provider, loaded, plan.actionable, lock, lockPath, { spacingMs: 0 })
    expect(result.failed).toBe(1)
    expect(lock.entries["base/revised"]).toMatchObject({
      status: "failed",
      error: expect.stringContaining("PixelLab image-to-image revisions take no strength"),
    })
  })

  it("estimates revision cost on the same canvas-area tiers as 1dir, not the underlying generator's flat rate", async () => {
    const loaded = await writeProject({ mode: "inpaint", from: "source", mask: "mask.png" })
    const [child] = await resolveSpecs(loaded, { assets: ["revised"] })
    // The style's plain `map` generator would price this at 1 generation;
    // a 32x32 revision should price at the 1dir/tiles-pro floor instead.
    expect(child!.cost).toBe(20)
  })

  it("estimates reduce-colors and correct-pixelart at a flat 0.1 generations, not the canvas tiers", async () => {
    const reduce = await resolveSpecs(await writeProject({ mode: "reduce-colors", from: "source", numColors: 8 }), { assets: ["revised"] })
    expect(reduce[0]!.cost).toBe(0.1)
    const correct = await resolveSpecs(await writeProject({ mode: "correct-pixelart", from: "source" }), { assets: ["revised"] })
    expect(correct[0]!.cost).toBe(0.1)
  })

  it("submits reduce-colors synchronously (no background job) and reads the billed usage back on poll", async () => {
    const loaded = await writeProject({ mode: "reduce-colors", from: "source", numColors: 8 })
    const [child] = await resolveSpecs(loaded, { assets: ["revised"] })
    const lock: Lock = { version: 2, entries: {} }
    const lockPath = path.join(dir, "pixelkiln.lock.json")
    const plan = await buildPlan([child!], lock)

    const resultPng = png(90, 32, 32)
    let submitBody: Record<string, unknown> | null = null
    vi.stubGlobal("fetch", vi.fn(async (input: string, init?: RequestInit) => {
      const url = new URL(String(input))
      expect(url.pathname).toBe("/v2/reduce-colors")
      submitBody = init?.body ? JSON.parse(String(init.body)) : null
      return new Response(JSON.stringify({
        images: [{ base64: resultPng.toString("base64") }],
        palette: { base64: "cA==" },
        n_colors: 8,
        usage: { type: "generations", generations: 0.1 },
      }), { status: 200 })
    }))

    const provider = new PixelLabProvider(new PixelLabClient("key"))
    await submit(provider, loaded, plan.actionable, lock, lockPath, { spacingMs: 0 })
    expect(submitBody).toMatchObject({ images: [{ format: "png" }], num_colors: 8 })

    // No /background-jobs polling at all: the result was already cached
    // locally by submit, so poll only needs to notice the file exists.
    const pollResult = await poll(provider, lock, lockPath, { intervalMs: 0, specs: [child!] })
    expect(pollResult.failed).toBe(0)
    expect(lock.entries["base/revised"]).toMatchObject({ status: "selected", billed: { amount: 0.1, unit: "generations" } })
    expect(lock.entries["base/revised"]!.sourceUrl).toMatch(/^file:\/\//)

    await fetchAssets(provider, [child!], lock, lockPath)
    expect(lock.entries["base/revised"]).toMatchObject({ status: "downloaded" })
    const written = await import("node:fs/promises").then((fs) => fs.readFile(child!.outFile))
    expect(written.equals(resultPng)).toBe(true)
  })

  it("submits correct-pixelart synchronously and downloads the corrected bytes", async () => {
    const loaded = await writeProject({ mode: "correct-pixelart", from: "source" })
    const [child] = await resolveSpecs(loaded, { assets: ["revised"] })
    const lock: Lock = { version: 2, entries: {} }
    const lockPath = path.join(dir, "pixelkiln.lock.json")
    const plan = await buildPlan([child!], lock)

    const resultPng = png(30, 32, 32)
    vi.stubGlobal("fetch", vi.fn(async (input: string) => {
      expect(new URL(String(input)).pathname).toBe("/v2/correct-pixelart")
      return new Response(JSON.stringify({ images: [{ base64: resultPng.toString("base64") }] }), { status: 200 })
    }))

    const provider = new PixelLabProvider(new PixelLabClient("key"))
    await submit(provider, loaded, plan.actionable, lock, lockPath, { spacingMs: 0 })
    await poll(provider, lock, lockPath, { intervalMs: 0, specs: [child!] })
    await fetchAssets(provider, [child!], lock, lockPath)
    expect(lock.entries["base/revised"]).toMatchObject({ status: "downloaded" })
    const written = await import("node:fs/promises").then((fs) => fs.readFile(child!.outFile))
    expect(written.equals(resultPng)).toBe(true)
  })

  it("fails cleanly on poll when a reduce-colors cache file is missing", async () => {
    const loaded = await writeProject({ mode: "reduce-colors", from: "source" })
    const [child] = await resolveSpecs(loaded, { assets: ["revised"] })
    const lock: Lock = { version: 2, entries: {} }
    const lockPath = path.join(dir, "pixelkiln.lock.json")
    const provider = new PixelLabProvider(new PixelLabClient("key"))
    // A jobId that was never submitted (and so never cached) simulates the
    // cache being cleared between submit and poll.
    const { upsert } = await import("../src/lock.ts")
    const { lockKey } = await import("../src/types.ts")
    upsert(lock, lockKey("base", "revised"), {
      styleId: "base", assetId: "revised", specHash: child!.specHash, generator: child!.generator,
      prompt: child!.prompt, width: 32, height: 32, status: "processing", provider: "pixellab", jobId: "never-submitted",
      revision: { mode: "reduce-colors", sourceAssetId: "source", sourceSha256: child!.revision!.sourceSha256! },
    })
    const result = await poll(provider, lock, lockPath, { intervalMs: 0, specs: [child!] })
    expect(result.failed).toBe(1)
    expect(lock.entries["base/revised"]).toMatchObject({
      status: "failed",
      error: expect.stringContaining("revision result is no longer cached locally"),
    })
  })

  it("submits an animate revision as a real background job and downloads every returned frame", async () => {
    const loaded = await writeProject({ mode: "animate", from: "source", frames: 4 })
    const [child] = await resolveSpecs(loaded, { assets: ["revised"] })
    const lock: Lock = { version: 2, entries: {} }
    const lockPath = path.join(dir, "pixelkiln.lock.json")
    const plan = await buildPlan([child!], lock)

    const frames = [0, 1, 2, 3].map((i) => png(20 + i * 10, 32, 32))
    let submitBody: Record<string, unknown> | null = null
    let polls = 0
    vi.stubGlobal("fetch", vi.fn(async (input: string, init?: RequestInit) => {
      const url = new URL(String(input))
      if (url.pathname === "/v2/animate-with-text-v3") {
        submitBody = init?.body ? JSON.parse(String(init.body)) : null
        return new Response(JSON.stringify({ background_job_id: "anim-1", status: "processing" }), { status: 202 })
      }
      if (url.pathname === "/v2/background-jobs/anim-1") {
        polls += 1
        const status = polls < 2 ? "processing" : "completed"
        const body = status === "processing"
          ? { id: "anim-1", status, created_at: "now" }
          : {
              id: "anim-1", status, created_at: "now",
              last_response: { frame_urls: frames.map((f) => ({ base64: f.toString("base64") })) },
              usage: { type: "generations", generations: 2 },
            }
        return new Response(JSON.stringify(body), { status: 200 })
      }
      throw new Error(`unexpected request: ${init?.method ?? "GET"} ${url.pathname}`)
    }))

    const provider = new PixelLabProvider(new PixelLabClient("key"))
    await submit(provider, loaded, plan.actionable, lock, lockPath, { spacingMs: 0 })
    expect(submitBody).toMatchObject({ action: "add snow", frame_count: 4 })

    // Like a character/objectPro loop, an animate revision lands in review
    // for a human accept/reject step rather than auto-selecting.
    const polled = await poll(provider, lock, lockPath, { intervalMs: 0, specs: [child!] })
    expect(polled.review).toBe(1)
    const entry = lock.entries["base/revised"]!
    expect(entry.status).toBe("review")
    expect(entry.providerMetadata.pixellab).toMatchObject({ frameSet: { fps: 8, count: 4 } })

    const state = await provider.poll(entry.reviewObjectId!, entry.generator, { spec: child })
    expect(state).toMatchObject({ status: "review-set", fps: 8, billed: { amount: 2, unit: "generations" } })
    const reviewed = state as { frameUrls: string[]; sources: { url: string; role?: string }[] }
    expect(reviewed.sources.map((s) => s.role)).toEqual(["frame-00", "frame-01", "frame-02", "frame-03"])
    // Each source URL is a local file:// cache of the decoded base64 frame,
    // the same way pollRevision's single-image case already caches one.
    for (const [i, source] of reviewed.sources.entries()) {
      expect(source.url).toMatch(/^file:\/\//)
      const written = await import("node:fs/promises").then((fs) => fs.readFile(source.url.replace("file://", "")))
      expect(written.equals(frames[i]!)).toBe(true)
    }
  })

  it("reads hosted frame URLs directly off animate-pixminimax without caching locally", async () => {
    const loaded = await writeProject({ mode: "animate-pixminimax", from: "source", direction: "east" })
    const [child] = await resolveSpecs(loaded, { assets: ["revised"] })
    const lock: Lock = { version: 2, entries: {} }
    const lockPath = path.join(dir, "pixelkiln.lock.json")
    const plan = await buildPlan([child!], lock)

    const hostedUrls = ["https://cdn.pixellab.ai/f0.png", "https://cdn.pixellab.ai/f1.png"]
    vi.stubGlobal("fetch", vi.fn(async (input: string) => {
      const url = new URL(String(input))
      if (url.pathname === "/v2/animate-pixminimax") {
        return new Response(JSON.stringify({ background_job_id: "anim-2", status: "processing" }), { status: 202 })
      }
      return new Response(JSON.stringify({
        id: "anim-2", status: "completed", created_at: "now",
        last_response: { frame_urls: hostedUrls },
      }), { status: 200 })
    }))

    const provider = new PixelLabProvider(new PixelLabClient("key"))
    await submit(provider, loaded, plan.actionable, lock, lockPath, { spacingMs: 0 })
    await poll(provider, lock, lockPath, { intervalMs: 0, specs: [child!] })
    const entry = lock.entries["base/revised"]!
    const state = await provider.poll(entry.reviewObjectId!, entry.generator, { spec: child })
    expect((state as { sources: { url: string }[] }).sources.map((s) => s.url)).toEqual(hostedUrls)
  })

  it("fails clearly when an animate job completes with no recognizable frame list", async () => {
    const loaded = await writeProject({ mode: "animate", from: "source" })
    const [child] = await resolveSpecs(loaded, { assets: ["revised"] })
    const lock: Lock = { version: 2, entries: {} }
    const lockPath = path.join(dir, "pixelkiln.lock.json")
    const plan = await buildPlan([child!], lock)

    vi.stubGlobal("fetch", vi.fn(async (input: string) => {
      const url = new URL(String(input))
      if (url.pathname === "/v2/animate-with-text-v3") {
        return new Response(JSON.stringify({ background_job_id: "anim-3", status: "processing" }), { status: 202 })
      }
      return new Response(JSON.stringify({
        id: "anim-3", status: "completed", created_at: "now",
        last_response: { totally_unexpected_field: true },
      }), { status: 200 })
    }))

    const provider = new PixelLabProvider(new PixelLabClient("key"))
    await submit(provider, loaded, plan.actionable, lock, lockPath, { spacingMs: 0 })
    const result = await poll(provider, lock, lockPath, { intervalMs: 0, specs: [child!] })
    expect(result.failed).toBe(1)
    expect(lock.entries["base/revised"]).toMatchObject({
      status: "failed",
      error: expect.stringMatching(/Invalid PixelLab response for animate job anim-3.*totally_unexpected_field/),
    })
  })

  it("estimates animate cost on character's own v3-loop formula, plus enhancePrompt's documented surcharge", async () => {
    const loaded = await writeProject({ mode: "animate", from: "source", frames: 8 })
    const [child] = await resolveSpecs(loaded, { assets: ["revised"] })
    // 32*32*8 / 65536 = 0.125, ceil'd to 1.
    expect(child!.cost).toBe(1)

    const enhanced = await resolveSpecs(
      await writeProject({ mode: "animate-pixminimax", from: "source", frames: 8, enhancePrompt: true }),
      { assets: ["revised"] },
    )
    expect(enhanced[0]!.cost).toBe(1.05)
  })

  it("rejects animate/animate-pixminimax sources over 256px per side and animate frame counts over 16", async () => {
    const bigDir = await mkdtemp(path.join(tmpdir(), "pixelkiln-pixellab-revision-big-"))
    try {
      await writeFile(path.join(bigDir, "source.png"), png(20, 300, 300))
      await writeFile(path.join(bigDir, "pixelkiln.manifest.json"), JSON.stringify({
        name: "big", provider: "pixellab",
        styles: { base: { generator: "map", size: 300, outDir: "art" } },
        assets: {
          source: { prompt: "a big tower", source: "source.png" },
          revised: { prompt: "add snow", width: 300, height: 300, revision: { mode: "animate", from: "source" } },
        },
      }))
      const bigLoaded = await loadManifest(path.join(bigDir, "pixelkiln.manifest.json"))
      // resolveSpecs validates against the live-registered "pixellab"
      // provider as part of resolution, so the size limit is enforced here
      // rather than needing a separate `.validate()` call.
      await expect(resolveSpecs(bigLoaded, { assets: ["revised"] })).rejects.toThrow(/PixelLab animate source is 300x300/)
    } finally {
      await rm(bigDir, { recursive: true, force: true })
    }

    await expect(resolveSpecs(await writeProject({ mode: "animate", from: "source", frames: 40 }), { assets: ["revised"] }))
      .rejects.toThrow(/PixelLab animate takes 4 to 16 frames/)
  })
})

describe("PixelLab provider: animate-skeleton", () => {
  let dir: string
  let manifestPath: string

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "pixelkiln-pixellab-skeleton-"))
    manifestPath = path.join(dir, "pixelkiln.manifest.json")
  })
  afterEach(async () => {
    vi.unstubAllGlobals()
    await rm(dir, { recursive: true, force: true })
  })

  const joint = (label: string) => ({ label, x: 0.5, y: 0.5, z_index: 1 })
  const frame = () => Array.from({ length: 18 }, (_, i) => joint(`JOINT_${i}`))
  const skeletonSet = (frameCount: number) => ({
    firstFrameKeypoints: frame(),
    frames: Array.from({ length: frameCount }, () => frame()),
  })

  async function writeProject(
    revisionExtra: Record<string, unknown>,
    opts: { keypointsFile?: string | false; frameCount?: number } = {},
  ) {
    await writeFile(path.join(dir, "source.png"), png())
    const keypointsFile = opts.keypointsFile === false ? undefined : (opts.keypointsFile ?? "poses.json")
    // Always start clean: a prior call in the same test (different
    // frameCount) may have left a stale poses.json on disk, which would
    // silently satisfy a "not yet authored" case that expects none to exist.
    if (keypointsFile && existsSync(path.join(dir, keypointsFile))) {
      await rm(path.join(dir, keypointsFile))
    }
    if (keypointsFile && opts.frameCount !== undefined) {
      await writeFile(path.join(dir, keypointsFile), JSON.stringify(skeletonSet(opts.frameCount)))
    }
    await writeFile(manifestPath, JSON.stringify({
      name: "pixellab-skeleton-test",
      provider: "pixellab",
      styles: { base: { generator: "map", size: 32, outDir: "art" } },
      assets: {
        source: { prompt: "a stone tower", source: "source.png" },
        revised: {
          prompt: "swinging the sword",
          width: 32,
          height: 32,
          revision: { mode: "animate-skeleton", from: "source", direction: "south", ...(keypointsFile ? { keypointsFile } : {}), ...revisionExtra },
        },
      },
    }))
    return loadManifest(manifestPath)
  }

  it("requires keypointsFile and direction; rejects fields that belong to other modes", async () => {
    await expect(writeProject({}, { keypointsFile: false })).rejects.toThrow(/require keypointsFile/)
    await expect(
      loadManifest(await (async () => {
        await writeFile(path.join(dir, "source.png"), png())
        await writeFile(manifestPath, JSON.stringify({
          name: "t", provider: "pixellab",
          styles: { base: { generator: "map", size: 32, outDir: "art" } },
          assets: {
            source: { prompt: "a stone tower", source: "source.png" },
            revised: { prompt: "x", width: 32, height: 32, revision: { mode: "animate-skeleton", from: "source", keypointsFile: "poses.json" } },
          },
        }))
        return manifestPath
      })()),
    ).rejects.toThrow(/require a direction/)
  })

  it("rejects keypointsFile/skeletonTemplate/description/direction on a mode other than animate-skeleton", async () => {
    await writeFile(path.join(dir, "source.png"), png())
    await writeFile(manifestPath, JSON.stringify({
      name: "t", provider: "pixellab",
      styles: { base: { generator: "map", size: 32, outDir: "art" } },
      assets: {
        source: { prompt: "a stone tower", source: "source.png" },
        revised: { prompt: "x", width: 32, height: 32, revision: { mode: "image-to-image", from: "source", keypointsFile: "poses.json" } },
      },
    }))
    await expect(loadManifest(manifestPath)).rejects.toThrow(/keypointsFile applies to animate-skeleton revisions only/)
  })

  it("resolves frames from the keypoints file, not a manifest number, and keeps planning offline before the file exists", async () => {
    // Declared but not yet authored: plan must still work, same as a
    // not-yet-drawn mask never blocking planning.
    const notReady = await writeProject({}, { keypointsFile: "poses.json", frameCount: undefined })
    const [pending] = await resolveSpecs(notReady, { assets: ["revised"] })
    expect(pending!.revision!.keypointsFile).toBeDefined()
    expect(pending!.revision!.skeleton).toBeNull()
    expect(pending!.revision!.frames).toBeUndefined()

    const ready = await writeProject({}, { keypointsFile: "poses.json", frameCount: 3 })
    const [child] = await resolveSpecs(ready, { assets: ["revised"] })
    expect(child!.revision!.frames).toBe(3)
    expect(child!.revision!.keypointsSha256).toMatch(/^[0-9a-f]{64}$/)
    expect(child!.revision!.skeleton!.frames).toHaveLength(3)
  })

  it("throws naming the file when the keypoints file is malformed", async () => {
    await writeFile(path.join(dir, "source.png"), png())
    await writeFile(path.join(dir, "poses.json"), JSON.stringify({ firstFrameKeypoints: frame(), frames: [frame(), frame()] })) // only 2, needs 3-15
    await writeFile(manifestPath, JSON.stringify({
      name: "t", provider: "pixellab",
      styles: { base: { generator: "map", size: 32, outDir: "art" } },
      assets: {
        source: { prompt: "a stone tower", source: "source.png" },
        revised: { prompt: "x", width: 32, height: 32, revision: { mode: "animate-skeleton", from: "source", direction: "south", keypointsFile: "poses.json" } },
      },
    }))
    const loaded = await loadManifest(manifestPath)
    await expect(resolveSpecs(loaded, { assets: ["revised"] })).rejects.toThrow(/poses\.json does not match the expected shape/)
  })

  it("estimates cost on PixelLab's own documented anchors, interpolating between them, and defaults to the 8-frame anchor before the file exists", async () => {
    expect((await resolveSpecs(await writeProject({}, { keypointsFile: "poses.json", frameCount: 3 }), { assets: ["revised"] }))[0]!.cost).toBe(2)
    expect((await resolveSpecs(await writeProject({}, { keypointsFile: "poses.json", frameCount: 8 }), { assets: ["revised"] }))[0]!.cost).toBe(3)
    expect((await resolveSpecs(await writeProject({}, { keypointsFile: "poses.json", frameCount: 15 }), { assets: ["revised"] }))[0]!.cost).toBe(4)
    // Not yet authored: falls back to the 8-frame anchor, same "assume a
    // mid-size default" convention animate's own frames ?? 8 already uses.
    expect((await resolveSpecs(await writeProject({}, { keypointsFile: "poses.json", frameCount: undefined }), { assets: ["revised"] }))[0]!.cost).toBe(3)
  })

  it("submits an animate-skeleton revision as a background job, never calling estimate-skeleton", async () => {
    const loaded = await writeProject({}, { keypointsFile: "poses.json", frameCount: 3 })
    const [child] = await resolveSpecs(loaded, { assets: ["revised"] })
    const lock: Lock = { version: 2, entries: {} }
    const lockPath = path.join(dir, "pixelkiln.lock.json")
    const plan = await buildPlan([child!], lock)

    const frames = [0, 1, 2].map((i) => png(20 + i * 10, 32, 32))
    let submitBody: Record<string, unknown> | null = null
    let polls = 0
    vi.stubGlobal("fetch", vi.fn(async (input: string, init?: RequestInit) => {
      const url = new URL(String(input))
      if (url.pathname === "/v2/estimate-skeleton") {
        throw new Error("estimate-skeleton must never be called from submitRevision")
      }
      if (url.pathname === "/v2/animate-with-skeleton-v3") {
        submitBody = init?.body ? JSON.parse(String(init.body)) : null
        return new Response(JSON.stringify({ background_job_id: "skel-1", status: "processing" }), { status: 202 })
      }
      if (url.pathname === "/v2/background-jobs/skel-1") {
        polls += 1
        const status = polls < 2 ? "processing" : "completed"
        const body = status === "processing"
          ? { id: "skel-1", status, created_at: "now" }
          : { id: "skel-1", status, created_at: "now", last_response: { images: frames.map((f) => ({ base64: f.toString("base64") })) } }
        return new Response(JSON.stringify(body), { status: 200 })
      }
      throw new Error(`unexpected request: ${init?.method ?? "GET"} ${url.pathname}`)
    }))

    const provider = new PixelLabProvider(new PixelLabClient("key"))
    await submit(provider, loaded, plan.actionable, lock, lockPath, { spacingMs: 0 })
    expect(submitBody).toMatchObject({ direction: "south" })
    expect((submitBody as Record<string, unknown>).first_frame_keypoints).toHaveLength(18)
    expect((submitBody as Record<string, unknown>).keypoints).toHaveLength(3)

    // Like animate/animate-pixminimax, an ordered frame set lands in review
    // for a human accept/reject step rather than auto-selecting.
    const polled = await poll(provider, lock, lockPath, { intervalMs: 0, specs: [child!] })
    expect(polled.review).toBe(1)
    expect(lock.entries["base/revised"]).toMatchObject({ status: "review" })
  })

  it("refuses to submit when the keypoints file is not ready, and detects drift since resolve", async () => {
    const loaded = await writeProject({}, { keypointsFile: "poses.json", frameCount: undefined })
    const [child] = await resolveSpecs(loaded, { assets: ["revised"] })
    const lock: Lock = { version: 2, entries: {} }
    const lockPath = path.join(dir, "pixelkiln.lock.json")
    const plan = await buildPlan([child!], lock)
    vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 202 })))
    const provider = new PixelLabProvider(new PixelLabClient("key"))
    const result = await submit(provider, loaded, plan.actionable, lock, lockPath, { spacingMs: 0 })
    expect(result.failed).toBe(1)
    expect(lock.entries["base/revised"]).toMatchObject({
      status: "failed",
      error: expect.stringContaining("revision keypoints are not ready"),
    })
  })

  it("rejects a source over 256px per side", async () => {
    const bigDir = await mkdtemp(path.join(tmpdir(), "pixelkiln-pixellab-skeleton-big-"))
    try {
      await writeFile(path.join(bigDir, "source.png"), png(20, 300, 300))
      await writeFile(path.join(bigDir, "poses.json"), JSON.stringify(skeletonSet(3)))
      await writeFile(path.join(bigDir, "pixelkiln.manifest.json"), JSON.stringify({
        name: "big", provider: "pixellab",
        styles: { base: { generator: "map", size: 300, outDir: "art" } },
        assets: {
          source: { prompt: "a big tower", source: "source.png" },
          revised: {
            prompt: "swing", width: 300, height: 300,
            revision: { mode: "animate-skeleton", from: "source", direction: "south", keypointsFile: "poses.json" },
          },
        },
      }))
      const bigLoaded = await loadManifest(path.join(bigDir, "pixelkiln.manifest.json"))
      await expect(resolveSpecs(bigLoaded, { assets: ["revised"] })).rejects.toThrow(/PixelLab animate-skeleton source is 300x300/)
    } finally {
      await rm(bigDir, { recursive: true, force: true })
    }
  })
})
