import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { PixelLabClient } from "../src/client.ts"
import { loadManifest, resolveSpecs } from "../src/manifest.ts"
import { buildPlan } from "../src/pipeline/plan.ts"
import { submit } from "../src/pipeline/submit.ts"
import { encodeRgbaPng } from "../src/png.ts"
import { PixelLabProvider } from "../src/providers/pixellab.ts"
import { AssetSchema, type Lock } from "../src/types.ts"

let dir: string

function png(shade: number, width = 64, height = 64): Buffer {
  return encodeRgbaPng(width, height, Buffer.alloc(width * height * 4, shade))
}

async function writeManifest(asset: Record<string, unknown>, generator = "map") {
  await writeFile(path.join(dir, "m.json"), JSON.stringify({
    name: "test",
    provider: "pixellab",
    styles: { props: { outDir: "out", generator } },
    assets: { barrel: { prompt: "a small wooden barrel", width: 64, height: 64, ...asset } },
  }))
  return loadManifest(path.join(dir, "m.json"))
}

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "pixelkiln-map-scene-"))
})
afterEach(async () => {
  vi.unstubAllGlobals()
  await rm(dir, { recursive: true, force: true })
})

describe("map object drawn into a scene", () => {
  it("defaults the placement to PixelLab's own oval, and keeps it out of assets without a scene", async () => {
    expect(AssetSchema.parse({ prompt: "x", scene: { image: "s.png" } }).scene).toEqual({ image: "s.png", placement: { oval: 0.3 } })
    expect(AssetSchema.safeParse({ prompt: "x", scene: { image: "s.png", placement: { oval: 0.99 } } }).success).toBe(false)
    expect(AssetSchema.safeParse({ prompt: "x", scene: { image: "s.png", placement: { oval: 0.3, rectangle: 0.3 } } }).success).toBe(false)
    const plain = await resolveSpecs(await writeManifest({}))
    expect(plain[0]!.scene).toBeUndefined()
  })

  it("is blocked until the scene exists, and the scene's bytes are its identity", async () => {
    const loaded = await writeManifest({ scene: { image: "maps/tavern.png", placement: { rectangle: 0.5 } } })
    const lock: Lock = { version: 2, entries: {} }
    const [pending] = await resolveSpecs(loaded)
    expect(pending!.scene).toMatchObject({ sha256: null, placement: { type: "rectangle", fraction: 0.5 } })
    const blocked = await buildPlan([pending!], lock)
    expect(blocked.items[0]).toMatchObject({ state: "blocked", reason: expect.stringMatching(/scene image does not exist yet/) })

    await mkdir(path.join(dir, "maps"))
    await writeFile(path.join(dir, "maps", "tavern.png"), png(40, 128, 96))
    const [first] = await resolveSpecs(loaded)
    expect((await buildPlan([first!], lock)).items[0]).toMatchObject({ state: "missing" })
    await writeFile(path.join(dir, "maps", "tavern.png"), png(41, 128, 96))
    const [second] = await resolveSpecs(loaded)
    expect(second!.specHash).not.toBe(first!.specHash)
    // A scene changed after resolving is caught before anything is sent.
    await writeFile(path.join(dir, "maps", "tavern.png"), png(42, 128, 96))
    expect((await buildPlan([second!], lock)).items[0]).toMatchObject({ state: "blocked", reason: expect.stringMatching(/changed after/) })
  })

  it("refuses a scene on anything but a map object, from a provider that cannot draw one, or with a mask of the wrong size", async () => {
    await expect(resolveSpecs(await writeManifest({ scene: { image: "s.png" } }, "pixflux"))).rejects.toThrow(/only a map object can be drawn into a scene/)
    const loaded = await writeManifest({ scene: { image: "s.png" } })
    await expect(resolveSpecs(loaded, {
      provider: { id: "plain", supports: () => true, estimate: () => ({ unit: "generations", amount: 1, candidates: 1 }) },
    })).rejects.toThrow(/provider "plain" cannot draw into a scene/)
    await writeFile(path.join(dir, "s.png"), png(1, 128, 96))
    await writeFile(path.join(dir, "mask.png"), png(255, 64, 64))
    await expect(resolveSpecs(await writeManifest({ scene: { image: "s.png", placement: { mask: "mask.png" } } })))
      .rejects.toThrow(/the mask is 64x64; the scene s\.png is 128x96/)
    expect(AssetSchema.safeParse({ mirror: "x", scene: { image: "s.png" } }).success).toBe(false)
  })

  it("sends the scene as background_image with the placement as inpainting", async () => {
    await writeFile(path.join(dir, "s.png"), png(7, 128, 96))
    await writeFile(path.join(dir, "mask.png"), png(255, 128, 96))
    const bodies: Record<string, unknown>[] = []
    vi.stubGlobal("fetch", vi.fn(async (_input: string, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init!.body)))
      return new Response(JSON.stringify({ object_id: `o-${bodies.length}`, status: "processing", background_job_id: "b" }), { status: 202 })
    }))
    const provider = new PixelLabProvider(new PixelLabClient("key"))
    for (const placement of [{ oval: 0.2 }, { mask: "mask.png" }]) {
      const loaded = await writeManifest({ scene: { image: "s.png", placement } })
      const [spec] = await resolveSpecs(loaded)
      expect(spec!.cost).toBe(1)
      const lock: Lock = { version: 2, entries: {} }
      const plan = await buildPlan([spec!], lock)
      await submit(provider, loaded, plan.actionable, lock, path.join(dir, "lock.json"), { spacingMs: 0 })
    }
    const scene = { type: "base64", base64: png(7, 128, 96).toString("base64"), format: "png" }
    expect(bodies[0]).toMatchObject({
      image_size: { width: 64, height: 64 },
      background_image: scene,
      inpainting: { type: "oval", fraction: 0.2 },
    })
    expect(bodies[1]).toMatchObject({
      background_image: scene,
      inpainting: { type: "mask", mask_image: { type: "base64", base64: png(255, 128, 96).toString("base64"), format: "png" } },
    })
  })
})
