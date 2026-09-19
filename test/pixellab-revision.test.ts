import path from "node:path"
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
  it("supports inpaint and image-to-image, not outpaint", () => {
    const provider = PixelLabProvider.forOffline()
    expect(provider.supportsRevision("inpaint")).toBe(true)
    expect(provider.supportsRevision("image-to-image")).toBe(true)
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
})
