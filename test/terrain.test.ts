import { describe, expect, it, beforeEach, afterEach } from "vitest"
import { mkdtemp, writeFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { loadManifest, resolveSpecs } from "../src/manifest.ts"
import { PixelLabProvider } from "../src/providers/pixellab.ts"
import { buildPlan } from "../src/pipeline/plan.ts"
import { submit } from "../src/pipeline/submit.ts"
import { parseTerrainDescriptions, terrainTileCount, tilesCost, type Lock, type ResolvedSpec } from "../src/types.ts"

let dir: string

async function writeManifest(style: Record<string, unknown>, prompt = "1). deep ocean water 2). golden sand") {
  const manifest = {
    name: "test",
    styles: { base: { outDir: "out", generator: "terrain", ...style } },
    assets: { ground: { prompt } },
  }
  await writeFile(path.join(dir, "m.json"), JSON.stringify(manifest))
  return loadManifest(path.join(dir, "m.json"))
}

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "pixelkiln-terrain-"))
})
afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

describe("parseTerrainDescriptions", () => {
  it("splits a numbered prompt into lower/upper/transition", () => {
    expect(parseTerrainDescriptions("1). ocean water 2). golden sand 3). wet sand with foam")).toEqual({
      lower: "ocean water",
      upper: "golden sand",
      transition: "wet sand with foam",
    })
  })

  it("accepts just lower and upper, leaving transition undefined", () => {
    expect(parseTerrainDescriptions("1). grass 2). dirt path")).toEqual({
      lower: "grass",
      upper: "dirt path",
      transition: undefined,
    })
  })

  it("rejects a prompt with fewer than two numbered groups", () => {
    expect(parseTerrainDescriptions("just some grass")).toBeNull()
    expect(parseTerrainDescriptions("1). only one group")).toBeNull()
  })
})

describe("terrainTileCount", () => {
  it("is 16 for a standard set and 25 at the cliff transitionSize", () => {
    expect(terrainTileCount(undefined)).toBe(16)
    expect(terrainTileCount(0.5)).toBe(16)
    expect(terrainTileCount(1)).toBe(25)
  })
})

describe("resolving a terrain spec", () => {
  it("splits the prompt and carries the terrain fields", async () => {
    const loaded = await writeManifest({ terrainTileSize: 32, terrainMode: "pro", terrainSpreadX: 0.3 })
    const [spec] = await resolveSpecs(loaded)

    expect(spec.generator).toBe("terrain")
    expect(spec.terrainLowerDescription).toBe("deep ocean water")
    expect(spec.terrainUpperDescription).toBe("golden sand")
    expect(spec.terrainTransitionDescription).toBeUndefined()
    expect(spec.terrainTileSize).toBe(32)
    expect(spec.terrainMode).toBe("pro")
    expect(spec.terrainSpreadX).toBe(0.3)
    expect(spec.width).toBe(32)
    expect(spec.height).toBe(32)
    expect(spec.candidates).toBe(16)
    expect(spec.cost).toBe(tilesCost(32, 16))
  })

  it("wraps each parsed segment in the style's prompt prefix/suffix", async () => {
    const loaded = await writeManifest({ promptPrefix: "pixel art", promptSuffix: "16-bit" })
    const [spec] = await resolveSpecs(loaded)
    expect(spec.terrainLowerDescription).toBe("pixel art, deep ocean water, 16-bit")
    expect(spec.terrainUpperDescription).toBe("pixel art, golden sand, 16-bit")
  })

  it("prices and counts off the cliff transition tier", async () => {
    const loaded = await writeManifest({ terrainTransitionSize: 1 })
    const [spec] = await resolveSpecs(loaded)
    expect(spec.candidates).toBe(25)
    expect(spec.cost).toBe(tilesCost(16, 25))
  })

  it("rejects a terrain prompt without two numbered groups", async () => {
    const loaded = await writeManifest({}, "just grass and water")
    await expect(resolveSpecs(loaded)).rejects.toThrow(/terrain needs/)
  })

  it("leaves terrain fields off a non-terrain generator", async () => {
    const manifest = {
      name: "test",
      styles: { base: { outDir: "out", generator: "map" } },
      assets: { ground: { prompt: "a rock" } },
    }
    await writeFile(path.join(dir, "m.json"), JSON.stringify(manifest))
    const loaded = await loadManifest(path.join(dir, "m.json"))
    const [spec] = await resolveSpecs(loaded)
    expect(spec.terrainLowerDescription).toBeUndefined()
    expect(spec.terrainTileSize).toBeUndefined()
  })
})

describe("provider", () => {
  const provider = new PixelLabProvider({} as never)

  it("supports the terrain generator", () => {
    expect(provider.supports("terrain")).toBe(true)
  })

  it("estimates a terrain spec from the resolved set", () => {
    const spec = {
      generator: "terrain",
      width: 16,
      height: 16,
      size: 16,
      cost: 40,
      candidates: 16,
    } as ResolvedSpec
    expect(provider.estimate(spec)).toEqual({ unit: "generations", amount: 40, candidates: 16 })
  })

  it("rejects shapeStyle combined with pro mode", async () => {
    const loaded = await writeManifest({ terrainMode: "pro", terrainShapeStyle: "round" })
    await expect(resolveSpecs(loaded)).rejects.toThrow(/terrainShapeStyle is standard-mode only/)
  })

  it("rejects a 64px tile outside pro mode", async () => {
    const loaded = await writeManifest({ terrainTileSize: 64 })
    await expect(resolveSpecs(loaded)).rejects.toThrow(/64px tile needs terrainMode/)
  })

  it("rejects an off-grid transitionSize without shapeStyle", async () => {
    const loaded = await writeManifest({ terrainTransitionSize: 0.9 })
    await expect(resolveSpecs(loaded)).rejects.toThrow(/TransitionSize must be 0, 0.25, 0.5, or 1/)
  })
})

describe("submit and poll", () => {
  it("sends the split descriptions and terrain fields to the client", async () => {
    const loaded = await writeManifest({
      terrainTileSize: 32,
      terrainMode: "pro",
      terrainSpreadX: 0.3,
      terrainSlopeSize: 0.2,
      terrainRaggedness: 0.1,
      terrainView: "low top-down",
    }, "1). deep ocean water 2). golden sand 3). wet sand with foam")
    const specs = await resolveSpecs(loaded)
    let sent: Record<string, unknown> | undefined
    const provider = new PixelLabProvider({
      createTileset: async (args: Record<string, unknown>) => {
        sent = args
        return { tileset_id: "tileset-1", background_job_id: "bg-1", status: "processing" }
      },
    } as never)
    const lock: Lock = { version: 2, entries: {} }

    await submit(
      provider,
      loaded,
      (await buildPlan(specs, lock)).actionable,
      lock,
      path.join(dir, "pixelkiln.lock.json"),
      { spacingMs: 0 },
    )

    expect(sent).toMatchObject({
      lowerDescription: "deep ocean water",
      upperDescription: "golden sand",
      transitionDescription: "wet sand with foam",
      tileSize: 32,
      mode: "pro",
      spreadX: 0.3,
      slopeSize: 0.2,
      raggedness: 0.1,
      view: "low top-down",
    })
  })

  it("polls straight to ready with one source file per tile, never review", async () => {
    const tiles = [
      { id: "t0", name: "none", image: { base64: Buffer.from("a").toString("base64"), format: "png" }, corners: { NW: "upper", NE: "upper", SW: "upper", SE: "upper" }, pattern_4x4: { row_0: [255, 255, 255, 255], row_1: [255, 1, 1, 255], row_2: [255, 1, 1, 255], row_3: [255, 255, 255, 255] } },
      { id: "t1", name: "NW+NE+SW+SE", image: { base64: Buffer.from("b").toString("base64"), format: "png" }, corners: { NW: "lower", NE: "lower", SW: "lower", SE: "lower" }, pattern_4x4: { row_0: [255, 255, 255, 255], row_1: [255, 0, 0, 255], row_2: [255, 0, 0, 255], row_3: [255, 255, 255, 255] } },
    ]
    const provider = new PixelLabProvider({
      getTileset: async () => ({
        tileset: { total_tiles: 2, tile_size: { width: 16, height: 16 }, terrain_types: ["lower", "upper"], tiles },
        usage: { type: "generations", generations: 20 },
      }),
    } as never)

    const state = await provider.poll("tileset-1", "terrain")
    expect(state.status).toBe("ready")
    if (state.status !== "ready") return
    expect(state.sources).toHaveLength(2)
    expect(state.sources?.[0]?.role).toBe("tile-00-none")
    expect(state.sources?.[1]?.role).toBe("tile-01-nw-ne-sw-se")
    expect(state.sources?.every((s) => s.url.startsWith("file://"))).toBe(true)
    expect(state.billed).toEqual({ amount: 20, unit: "generations" })
  })

  it("reports processing while the API answers 423", async () => {
    const provider = new PixelLabProvider({
      getTileset: async () => {
        const { PixelLabError } = await import("../src/client.ts")
        throw new PixelLabError("still drawing", 423, "")
      },
    } as never)
    const state = await provider.poll("tileset-1", "terrain")
    expect(state.status).toBe("processing")
  })
})
