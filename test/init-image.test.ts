import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { loadManifest, resolveSpecs } from "../src/manifest.ts"
import { buildPlan } from "../src/pipeline/plan.ts"
import { submit } from "../src/pipeline/submit.ts"
import { PixelLabClient } from "../src/client.ts"
import { PixelLabProvider } from "../src/providers/pixellab.ts"
import { encodeRgbaPng } from "../src/png.ts"
import { AssetSchema, lockKey, type Lock } from "../src/types.ts"

let dir: string
const png = (shade: number) => encodeRgbaPng(32, 32, Buffer.alloc(32 * 32 * 4, shade))

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "pixelkiln-init-"))
  await writeFile(path.join(dir, "start.png"), png(90))
})
afterEach(async () => {
  vi.unstubAllGlobals()
  await rm(dir, { recursive: true, force: true })
})

async function load(generator: string, asset: Record<string, unknown>) {
  await writeFile(path.join(dir, "m.json"), JSON.stringify({
    name: "t",
    styles: { s: { generator, size: 32, outDir: "out" } },
    assets: { a: { prompt: "a golden knight", ...asset } },
  }))
  return loadManifest(path.join(dir, "m.json"))
}
const specOf = async (generator: string, asset: Record<string, unknown>) => (await resolveSpecs(await load(generator, asset)))[0]!

describe("initImage", () => {
  it("is hashed by its bytes and strength, only when set", async () => {
    const plain = await specOf("map", {})
    const withInit = await specOf("map", { initImage: "start.png" })
    const strong = await specOf("map", { initImage: "start.png", initImageStrength: 100 })
    expect(plain.initImage).toBeUndefined()
    expect(withInit.specHash).not.toBe(plain.specHash)
    expect(strong.specHash).not.toBe(withInit.specHash)
    await writeFile(path.join(dir, "copy.png"), png(90))
    expect((await specOf("map", { initImage: "copy.png" })).specHash).toBe(withInit.specHash)
    await writeFile(path.join(dir, "start.png"), png(91))
    expect((await specOf("map", { initImage: "start.png" })).specHash).not.toBe(withInit.specHash)
  })

  it("is refused where it does nothing, when the file is missing, and for a strength with no image", async () => {
    await expect(specOf("imagePro", { initImage: "start.png" })).rejects.toThrow(/taken by pixflux, map and isometricTile styles; style "s" uses "imagePro"/)
    await expect(specOf("map", { initImage: "gone.png" })).rejects.toThrow(/initImage: gone\.png is missing or not a PNG/)
    expect(AssetSchema.safeParse({ prompt: "x", initImageStrength: 100 }).success).toBe(false)
    expect(AssetSchema.safeParse({ prompt: "x", initImage: "a.png", initImageStrength: 1000 }).success).toBe(false)
    expect(AssetSchema.safeParse({ prompt: "x", initImage: "a.png", initImageStrength: 100 }).success).toBe(true)
  })

  it.each([
    ["map", /\/map-objects$/, { object_id: "o-1", background_job_id: "bg", status: "processing" }],
    ["isometricTile", /\/create-isometric-tile$/, { tile_id: "t-1", background_job_id: "bg", status: "processing" }],
    ["pixflux", /\/create-image-pixflux$/, { image: { base64: png(1).toString("base64") }, usage: { type: "generations", generations: 1 } }],
  ])("is sent by %s with its strength, and without one when none is set", async (generator, route, reply) => {
    const calls: Array<{ url: string; body: Record<string, unknown> }> = []
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
      if (init?.body) calls.push({ url: String(url), body: JSON.parse(String(init.body)) })
      return new Response(JSON.stringify(reply), { status: 200 })
    }))
    for (const asset of [{ initImage: "start.png", initImageStrength: 100 }, { initImage: "start.png" }, {}]) {
      const loaded = await load(generator, asset)
      const specs = await resolveSpecs(loaded)
      const lock: Lock = { version: 2, entries: {} }
      await submit(new PixelLabProvider(new PixelLabClient("key")), loaded, (await buildPlan(specs, lock)).actionable, lock, path.join(dir, "lock.json"), { spacingMs: 0 })
      expect(lock.entries[lockKey("s", "a")]?.status, JSON.stringify(asset)).not.toBe("failed")
    }
    const posts = calls.filter((call) => route.test(call.url))
    expect(posts).toHaveLength(3)
    expect(posts[0]!.body).toMatchObject({ init_image: { type: "base64", format: "png", base64: png(90).toString("base64") }, init_image_strength: 100 })
    expect(posts[1]!.body).toHaveProperty("init_image")
    expect(posts[1]!.body).not.toHaveProperty("init_image_strength")
    expect(posts[2]!.body).not.toHaveProperty("init_image")
  })

  it("is refused at submit when the file changed after the plan", async () => {
    const loaded = await load("map", { initImage: "start.png" })
    const specs = await resolveSpecs(loaded)
    const lock: Lock = { version: 2, entries: {} }
    const plan = await buildPlan(specs, lock)
    await writeFile(path.join(dir, "start.png"), png(200))
    let sent = 0
    vi.stubGlobal("fetch", vi.fn(async () => { sent++; return new Response("{}", { status: 200 }) }))
    await submit(new PixelLabProvider(new PixelLabClient("key")), loaded, plan.actionable, lock, path.join(dir, "lock.json"), { spacingMs: 0 })
    expect(sent).toBe(0)
    expect(lock.entries[lockKey("s", "a")]).toMatchObject({ status: "failed", error: expect.stringMatching(/init image changed after the manifest was resolved/) })
  })
})

describe("a pixflux style's outline, shading and detail", () => {
  async function loadStyled(style: Record<string, unknown>) {
    await writeFile(path.join(dir, "m.json"), JSON.stringify({
      name: "t",
      styles: { s: { generator: "pixflux", size: 32, outDir: "out", ...style } },
      assets: { a: { prompt: "an anvil" } },
    }))
    return loadManifest(path.join(dir, "m.json"))
  }
  async function posted(style: Record<string, unknown>): Promise<Record<string, unknown>> {
    const bodies: Array<Record<string, unknown>> = []
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init?: RequestInit) => {
      if (init?.body) bodies.push(JSON.parse(String(init.body)))
      return new Response(JSON.stringify({ image: { base64: png(1).toString("base64") }, usage: { type: "generations", generations: 1 } }), { status: 200 })
    }))
    const loaded = await loadStyled(style)
    const specs = await resolveSpecs(loaded, { provider: new PixelLabProvider(new PixelLabClient("key")) })
    const lock: Lock = { version: 2, entries: {} }
    await submit(new PixelLabProvider(new PixelLabClient("key")), loaded, (await buildPlan(specs, lock)).actionable, lock, path.join(dir, "lock.json"), { spacingMs: 0 })
    expect(lock.entries[lockKey("s", "a")]?.status).not.toBe("failed")
    return bodies[0]!
  }

  it("are sent when the style sets them and left out when it does not", async () => {
    expect(await posted({ outline: "lineless", shading: "flat shading", detail: "highly detailed" }))
      .toMatchObject({ outline: "lineless", shading: "flat shading", detail: "highly detailed" })
    const bare = await posted({})
    for (const key of ["outline", "shading", "detail"]) expect(bare).not.toHaveProperty(key)
  })

  it("keep the hash they always had", async () => {
    const hash = async (style: Record<string, unknown>) => (await resolveSpecs(await loadStyled(style)))[0]!.specHash
    // Pinned from main before the fields were sent.
    expect(await hash({})).toBe("90a7723fb651ef7a9af6c736368fd436662de5ab3f34ca19c3ec61b72aea25b6")
    expect(await hash({ outline: "lineless", shading: "flat shading", detail: "highly detailed" })).toBe("791dcd4f77078ced566be672889d55b3ecef3f390c253586c1da9f6509cc5d5b")
  })

  it("refuse a value the endpoint does not know, at plan", async () => {
    const loaded = await loadStyled({ detail: "high detail" })
    await expect(resolveSpecs(loaded, { provider: new PixelLabProvider(new PixelLabClient("key")) })).rejects.toThrow(/pixflux detail must be one of: low detail, medium detail, highly detailed/)
  })
})
