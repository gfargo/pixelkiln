import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { PixelLabClient } from "../src/client.ts"
import { loadManifest, resolveSpecs } from "../src/manifest.ts"
import { buildPlan } from "../src/pipeline/plan.ts"
import { fetchAssets } from "../src/pipeline/fetch.ts"
import { poll } from "../src/pipeline/poll.ts"
import { submit } from "../src/pipeline/submit.ts"
import { encodeRgbaPng } from "../src/png.ts"
import { PixelLabProvider } from "../src/providers/pixellab.ts"
import type { Lock } from "../src/types.ts"

let dir: string

function png(shade: number, width = 32, height = 32): Buffer {
  return encodeRgbaPng(width, height, Buffer.alloc(width * height * 4, shade))
}

async function writeManifest(style: Record<string, unknown> = {}, asset: Record<string, unknown> = { prompt: "medieval stone button" }) {
  await writeFile(path.join(dir, "m.json"), JSON.stringify({
    name: "test",
    provider: "pixellab",
    styles: { ui: { outDir: "out", generator: "uiElement", ...style } },
    assets: { button: asset },
  }))
  return loadManifest(path.join(dir, "m.json"))
}

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "pixelkiln-ui-element-"))
})
afterEach(async () => {
  vi.unstubAllGlobals()
  await rm(dir, { recursive: true, force: true })
})

describe("uiElement", () => {
  it("resolves non-square sizes down to 16px, carries uiColorPalette, and prices on the Pro canvas tiers", async () => {
    const [spec] = await resolveSpecs(await writeManifest({ uiColorPalette: "brown and gold" }, { prompt: "a slot", width: 40, height: 40 }))
    expect(spec).toMatchObject({ generator: "uiElement", width: 40, height: 40, uiColorPalette: "brown and gold" })
    expect(PixelLabProvider.forOffline().estimate(spec!)).toMatchObject({ unit: "generations", amount: 25 })
    const [big] = await resolveSpecs(await writeManifest())
    expect(big).toMatchObject({ width: 256, height: 256 })
    expect(PixelLabProvider.forOffline().estimate(big!)).toMatchObject({ amount: 40 })
  })

  it("refuses sizes outside the endpoint's range and more than one concept image", async () => {
    await expect(resolveSpecs(await writeManifest({}, { prompt: "x", width: 800, height: 64 }))).rejects.toThrow(/16 to 792 wide/)
    await writeFile(path.join(dir, "a.png"), png(1))
    await writeFile(path.join(dir, "b.png"), png(2))
    await expect(resolveSpecs(await writeManifest({ styleImages: [{ path: "a.png" }, { path: "b.png" }] }))).rejects.toThrow(/one concept image/)
  })

  it("sends generate-ui-v2 with the concept image and palette hint, then downloads the single result", async () => {
    await writeFile(path.join(dir, "concept.png"), png(9, 48, 16))
    const loaded = await writeManifest({ uiColorPalette: "blue and silver", styleImages: [{ path: "concept.png" }], noBackground: true }, { prompt: "sci-fi health bar", width: 96, height: 32 })
    const [spec] = await resolveSpecs(loaded)
    const lock: Lock = { version: 2, entries: {} }
    const lockPath = path.join(dir, "lock.json")
    const plan = await buildPlan([spec!], lock)
    const result = png(200, 96, 32)
    let body: Record<string, unknown> | null = null
    vi.stubGlobal("fetch", vi.fn(async (input: string, init?: RequestInit) => {
      const url = new URL(String(input))
      if (url.pathname === "/v2/generate-ui-v2") {
        body = JSON.parse(String(init!.body))
        return new Response(JSON.stringify({ background_job_id: "ui-1", status: "processing" }), { status: 202 })
      }
      if (url.pathname === "/v2/background-jobs/ui-1") {
        return new Response(JSON.stringify({
          id: "ui-1", status: "completed", created_at: "now",
          last_response: { images: [{ type: "base64", base64: result.toString("base64") }] },
          usage: { type: "generations", generations: 20 },
        }), { status: 200 })
      }
      throw new Error(`unexpected ${url.pathname}`)
    }))
    const provider = new PixelLabProvider(new PixelLabClient("key"))
    await submit(provider, loaded, plan.actionable, lock, lockPath, { spacingMs: 0 })
    expect(body).toMatchObject({
      image_size: { width: 96, height: 32 },
      color_palette: "blue and silver",
      no_background: true,
      concept_image: { image: { format: "png" }, size: { width: 48, height: 16 } },
    })
    expect(String(body!.description)).toContain("sci-fi health bar")

    await poll(provider, lock, lockPath, { intervalMs: 0, specs: [spec!] })
    expect(lock.entries["ui/button"]).toMatchObject({ status: "selected", billed: { amount: 20, unit: "generations" } })
    await fetchAssets(provider, [spec!], lock, lockPath)
    expect((await readFile(spec!.outFile)).equals(result)).toBe(true)
  })

  it("sends several returned images to review, and names the keys when the shape is unknown", async () => {
    const loaded = await writeManifest()
    const [spec] = await resolveSpecs(loaded)
    let answer: Record<string, unknown> = { images: [{ base64: png(1).toString("base64") }, { base64: png(2).toString("base64") }] }
    vi.stubGlobal("fetch", vi.fn(async () =>
      new Response(JSON.stringify({ id: "ui-2", status: "completed", created_at: "now", last_response: answer }), { status: 200 })))
    const provider = new PixelLabProvider(new PixelLabClient("key"))
    expect(await provider.poll("ui-2", "uiElement", { spec })).toMatchObject({ status: "review" })
    const picked = await provider.selectCandidate("ui-2", 1, undefined, "uiElement")
    expect(picked.sourceUrl).toMatch(/ui-2-1\.png$/)
    answer = { result: "?" }
    expect(await provider.poll("ui-2", "uiElement", { spec })).toMatchObject({
      status: "failed",
      error: expect.stringContaining("got: result"),
    })
  })
})
