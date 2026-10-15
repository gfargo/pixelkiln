import path from "node:path"
import { existsSync } from "node:fs"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { PixelLabClient } from "../src/client.ts"
import { sha256 } from "../src/hash.ts"
import { upsert } from "../src/lock.ts"
import { loadManifest, resolveSpecs } from "../src/manifest.ts"
import { portableOutputPath } from "../src/outputs.ts"
import { buildPlan } from "../src/pipeline/plan.ts"
import { poll } from "../src/pipeline/poll.ts"
import { fetchAssets } from "../src/pipeline/fetch.ts"
import { submit } from "../src/pipeline/submit.ts"
import { normalMapFile, normalMapSizeProblem } from "../src/pixellab-utils.ts"
import { decodePng, encodeRgbaPng, joinStripPng, splitStripPng } from "../src/png.ts"
import { PixelLabProvider } from "../src/providers/pixellab.ts"
import { CHARACTER_DIRECTIONS_8, RevisionSchema, type Lock, type ResolvedSpec } from "../src/types.ts"

function png(shade = 20, width = 32, height = 32): Buffer {
  return encodeRgbaPng(width, height, Buffer.alloc(width * height * 4, shade))
}

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status })
const frames = (n: number) => Array.from({ length: n }, (_, i) => `frame-${String(i).padStart(2, "0")}`)

/** A fake PixelLab: `/normal-map` queues a job, and the job completes with `result(body)`. */
function stubNormalMap(result: (body: Record<string, unknown>) => Buffer) {
  const bodies: Record<string, unknown>[] = []
  vi.stubGlobal("fetch", vi.fn(async (input: string, init?: RequestInit) => {
    const url = new URL(String(input))
    if (url.pathname === "/v2/normal-map") {
      bodies.push(JSON.parse(String(init!.body)))
      return json({ background_job_id: "nm-1", status: "processing" }, 202)
    }
    expect(url.pathname).toBe("/v2/background-jobs/nm-1")
    return json({
      id: "nm-1",
      status: "completed",
      last_response: { image: { type: "base64", base64: result(bodies.at(-1)!).toString("base64") } },
      usage: { type: "generations", generations: 0.5 },
    })
  }))
  return bodies
}

describe("strip helpers", () => {
  it("joins frames left to right and splits them back exactly", () => {
    const parts = [png(10, 8, 12), png(90, 8, 12), png(200, 8, 12)]
    const strip = joinStripPng(parts)
    const decoded = decodePng(strip)
    expect([decoded.width, decoded.height]).toEqual([24, 12])
    expect(decoded.pixels[(5 * 24 + 9) * 4]).toBe(90)
    const back = splitStripPng(strip, 3)
    for (const [index, part] of parts.entries()) expect(decodePng(back[index]!).pixels.equals(decodePng(part).pixels)).toBe(true)
    expect(() => splitStripPng(strip, 5)).toThrow(/does not split into 5 equal frames/)
    expect(() => joinStripPng([png(1, 8, 8), png(1, 9, 8)])).toThrow(/frame 1 is 9x8/)
  })

  it("checks /normal-map's documented sizes per frame", () => {
    expect(normalMapSizeProblem(64, 64)).toBeNull()
    expect(normalMapSizeProblem(512 * 4, 512, 4)).toBeNull()
    expect(normalMapSizeProblem(4, 64)).toMatch(/8 to 512 px per side/)
    expect(normalMapSizeProblem(513, 64)).toMatch(/8 to 512 px per side/)
    expect(normalMapSizeProblem(64 * 33, 64, 33)).toMatch(/1 to 32 frames/)
    expect(normalMapSizeProblem(100, 64, 3)).toMatch(/does not split into 3 equal frames/)
  })
})

describe("PixelLabClient: the normal-map wire", () => {
  afterEach(() => vi.unstubAllGlobals())

  it("sends the image alone by default, and frames and convention when given", async () => {
    const bodies: unknown[] = []
    vi.stubGlobal("fetch", vi.fn(async (input: string, init?: RequestInit) => {
      expect(new URL(String(input)).pathname).toBe("/v2/normal-map")
      bodies.push(JSON.parse(String(init!.body)))
      return json({ background_job_id: "nm-1", status: "processing" }, 202)
    }))
    const client = new PixelLabClient("key")
    const res = await client.normalMap({ image: { base64: "U1BSSVRF", format: "png" } })
    expect(res.background_job_id).toBe("nm-1")
    await client.normalMap({ image: { base64: "U1RSSVA=", format: "png" }, frames: 6, convention: "directx" })
    expect(bodies).toEqual([
      { image: { base64: "U1BSSVRF", format: "png" } },
      { image: { base64: "U1RSSVA=", format: "png" }, frames: 6, convention: "directx" },
    ])
  })
})

describe("normal-map revisions", () => {
  let dir: string
  let manifestPath: string
  let lockPath: string

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "pixelkiln-normal-map-"))
    manifestPath = path.join(dir, "pixelkiln.manifest.json")
    lockPath = path.join(dir, "pixelkiln.lock.json")
  })
  afterEach(async () => {
    vi.unstubAllGlobals()
    await rm(dir, { recursive: true, force: true })
  })

  async function single(revision: Record<string, unknown>, style: Record<string, unknown> = {}, extra: Record<string, unknown> = {}) {
    await writeFile(path.join(dir, "source.png"), png())
    await writeFile(manifestPath, JSON.stringify({
      name: "normal-map-test",
      provider: "pixellab",
      styles: { base: { generator: "map", size: 32, outDir: "art", ...style } },
      assets: {
        source: { prompt: "a stone tower", source: "source.png" },
        normals: { prompt: "normal map", revision },
        ...extra,
      },
    }))
    return loadManifest(manifestPath)
  }

  /** A downloaded parent written as a member set, the way a generated loop or character lands. */
  async function set(revision: Record<string, unknown>, roles: string[], size = 32) {
    await writeFile(manifestPath, JSON.stringify({
      name: "normal-map-set-test",
      provider: "pixellab",
      styles: { base: { generator: "map", size, outDir: "art" } },
      assets: { hero: { prompt: "a knight" }, normals: { prompt: "normal map", revision } },
    }))
    const loaded = await loadManifest(manifestPath)
    const [parent] = await resolveSpecs(loaded, { assets: ["hero"] })
    await mkdir(path.join(dir, "art"), { recursive: true })
    const lock: Lock = { version: 2, entries: {} }
    const outputs = []
    for (const [index, role] of roles.entries()) {
      const bytes = png(10 + index * 5, size, size)
      const file = path.join(dir, "art", `hero-${role}.png`)
      await writeFile(file, bytes)
      outputs.push({ path: portableOutputPath(file, dir), sha256: sha256(bytes), role, mediaType: "image/png" as const })
    }
    upsert(lock, "base/hero", {
      styleId: "base", assetId: "hero", specHash: parent!.specHash, generator: "map", prompt: "a knight",
      width: size, height: size, status: "downloaded", provider: "pixellab", objectId: "obj-hero", outputs,
      sourceUrls: roles.map((role) => ({ url: `https://cdn.example/${role}.png`, role })),
    })
    return { loaded, lock }
  }

  async function child(loaded: Awaited<ReturnType<typeof loadManifest>>): Promise<ResolvedSpec> {
    const [spec] = await resolveSpecs(loaded, { assets: ["normals"] })
    return spec!
  }

  it("makes one sprite's normal map as a background job, at 0.5 generation", async () => {
    const loaded = await single({ mode: "normal-map", from: "source", convention: "directx" })
    const spec = await child(loaded)
    expect(spec.cost).toBe(0.5)
    const lock: Lock = { version: 2, entries: {} }
    const plan = await buildPlan([spec], lock)
    const map = png(128)
    const bodies = stubNormalMap(() => map)
    const provider = new PixelLabProvider(new PixelLabClient("key"))
    await submit(provider, loaded, plan.actionable, lock, lockPath, { spacingMs: 0 })
    expect(bodies[0]).toEqual({ image: { base64: png().toString("base64"), format: "png" }, convention: "directx" })
    await poll(provider, lock, lockPath, { intervalMs: 0, specs: [spec] })
    await fetchAssets(provider, [spec], lock, lockPath)
    expect(lock.entries["base/normals"]).toMatchObject({ status: "downloaded", revision: { mode: "normal-map", convention: "directx" } })
    expect((await readFile(spec.outFile)).equals(map)).toBe(true)
  })

  it("sends a loop as one strip and cuts the map back into its frames", async () => {
    const { loaded, lock } = await set({ mode: "normal-map", from: "hero" }, frames(4))
    const spec = await child(loaded)
    expect(spec.cost).toBe(0.5)
    const plan = await buildPlan([spec], lock)
    const maps = [png(100), png(110), png(120), png(130)]
    const bodies = stubNormalMap(() => joinStripPng(maps))
    const provider = new PixelLabProvider(new PixelLabClient("key"))
    await submit(provider, loaded, plan.actionable, lock, lockPath, { spacingMs: 0 })
    expect(bodies).toHaveLength(1)
    expect(bodies[0]!.frames).toBe(4)
    const sent = decodePng(Buffer.from((bodies[0]!.image as { base64: string }).base64, "base64"))
    expect([sent.width, sent.height]).toEqual([128, 32])

    await poll(provider, lock, lockPath, { intervalMs: 0, specs: [spec] })
    expect(lock.entries["base/normals"]!.sourceUrls.map((source) => source.role)).toEqual(frames(4))
    await fetchAssets(provider, [spec], lock, lockPath)
    expect(lock.entries["base/normals"]).toMatchObject({ status: "downloaded" })
    for (const [index, role] of frames(4).entries()) {
      const written = decodePng(await readFile(path.join(dir, "art", `normals-${role}.png`)))
      expect(written.pixels.equals(decodePng(maps[index]!).pixels)).toBe(true)
    }
  })

  it("refuses a character's directions, and a loop longer than 32 frames", async () => {
    const directions = await set({ mode: "normal-map", from: "hero" }, [...CHARACTER_DIRECTIONS_8])
    await expect(child(directions.loaded)).rejects.toThrow(/set of directions .* one normal-map revision per direction/)
    await rm(path.join(dir, "art"), { recursive: true })
    const long = await set({ mode: "normal-map", from: "hero" }, frames(33), 16)
    await expect(child(long.loaded)).rejects.toThrow(/at most 32 frames/)
  })

  it("refuses a style that would recolour the map, and a mirror of one", async () => {
    await expect(child(await single({ mode: "normal-map", from: "source" }, { palette: ["#000000", "#ffffff"], enforcePalette: true })))
      .rejects.toThrow(/lighting data, not art, and style "base" sets enforcePalette/)
    const quality = { outDir: "art/final", palette: ["#000000", "#ffffff"] }
    await expect(child(await single({ mode: "normal-map", from: "source" }, { quality })))
      .rejects.toThrow(/sets quality/)
    const mirrored = await single({ mode: "normal-map", from: "source" }, {}, { flipped: { mirror: "normals" } })
    await expect(resolveSpecs(mirrored, { assets: ["normals", "flipped"] })).rejects.toThrow(/normal map cannot be mirrored/)
  })

  it("takes convention on normal-map only, and hashes it only when set", async () => {
    expect(RevisionSchema.safeParse({ mode: "normal-map", from: "a", convention: "opengl" }).success).toBe(true)
    expect(RevisionSchema.safeParse({ mode: "reduce-colors", from: "a", convention: "opengl" }).success).toBe(false)
    expect(RevisionSchema.safeParse({ mode: "normal-map", from: "a", strength: 0.5 }).success).toBe(false)
    const plain = await child(await single({ mode: "normal-map", from: "source" }))
    const opengl = await child(await single({ mode: "normal-map", from: "source", convention: "opengl" }))
    expect(plain.revision).not.toHaveProperty("convention")
    expect(opengl.specHash).not.toBe(plain.specHash)
  })
})

describe("normalMapFile", () => {
  let dir: string
  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "pixelkiln-normal-map-file-"))
  })
  afterEach(async () => {
    vi.unstubAllGlobals()
    await rm(dir, { recursive: true, force: true })
  })

  it("sends a strip with its frame count, waits, and writes the map beside it", async () => {
    const input = path.join(dir, "walk.png")
    await writeFile(input, joinStripPng([png(1, 16, 16), png(2, 16, 16)]))
    const map = joinStripPng([png(128, 16, 16), png(129, 16, 16)])
    const statuses = ["processing", "completed"]
    const client = {
      normalMap: vi.fn(async () => ({ background_job_id: "nm-1", status: "processing" })),
      getBackgroundJob: vi.fn(async () => {
        const status = statuses.shift()!
        return { id: "nm-1", status, last_response: status === "completed" ? { image: { base64: map.toString("base64") } } : null }
      }),
    }
    const res = await normalMapFile(client, input, { frames: 2, convention: "directx", sleep: async () => {} })
    expect(client.normalMap).toHaveBeenCalledWith(expect.objectContaining({ frames: 2, convention: "directx" }))
    expect(res).toMatchObject({ out: path.join(dir, "walk.normal.png"), width: 32, height: 16, frames: 2, convention: "directx" })
    expect((await readFile(res.out)).equals(map)).toBe(true)
  })

  it("refuses a strip that does not split, and an existing output, before sending anything", async () => {
    const input = path.join(dir, "sprite.png")
    await writeFile(input, png(1, 30, 16))
    const client = { normalMap: vi.fn(), getBackgroundJob: vi.fn() }
    await expect(normalMapFile(client, input, { frames: 4 })).rejects.toThrow(/does not split into 4 equal frames/)
    await writeFile(path.join(dir, "sprite.normal.png"), png())
    await expect(normalMapFile(client, input)).rejects.toThrow(/already exists/)
    expect(client.normalMap).not.toHaveBeenCalled()
    expect(existsSync(path.join(dir, "sprite.normal.png"))).toBe(true)
  })
})
