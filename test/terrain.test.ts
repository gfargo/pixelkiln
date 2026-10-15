import { describe, expect, it, beforeEach, afterEach } from "vitest"
import { mkdir, mkdtemp, writeFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { loadManifest, resolveSpecs } from "../src/manifest.ts"
import { PixelLabProvider } from "../src/providers/pixellab.ts"
import { buildPlan } from "../src/pipeline/plan.ts"
import { submit } from "../src/pipeline/submit.ts"
import {
  LockEntrySchema,
  lockKey,
  parseTerrainDescriptions,
  terrainCost,
  terrainTileCount,
  type Lock,
  type LockEntry,
  type ResolvedSpec,
} from "../src/types.ts"
import { sha256, specHash } from "../src/hash.ts"
import { currentEntryOutputPath } from "../src/outputs.ts"
import { retireGeneration } from "../src/pipeline/history.ts"

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

  it("switches a Pro set to the 25-tile tall-wall layout above 0.4", () => {
    expect(terrainTileCount(undefined, "pro")).toBe(16)
    expect(terrainTileCount(0.25, "pro")).toBe(16)
    expect(terrainTileCount(0.5, "pro")).toBe(25)
    expect(terrainTileCount(1, "pro")).toBe(25)
  })
})

describe("terrainCost", () => {
  it("prices a set flat by mode and tile size", () => {
    expect(terrainCost(undefined, 16)).toBe(4)
    expect(terrainCost("standard", 32)).toBe(4)
    expect(terrainCost("pro", 16)).toBe(15)
    expect(terrainCost("pro", 32)).toBe(15)
    expect(terrainCost("pro", 64)).toBe(25)
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
    expect(spec.cost).toBe(15)
  })

  it("wraps each parsed segment in the style's prompt prefix/suffix", async () => {
    const loaded = await writeManifest({ promptPrefix: "pixel art", promptSuffix: "16-bit" })
    const [spec] = await resolveSpecs(loaded)
    expect(spec.terrainLowerDescription).toBe("pixel art, deep ocean water, 16-bit")
    expect(spec.terrainUpperDescription).toBe("pixel art, golden sand, 16-bit")
  })

  it("counts off the cliff transition tier at standard's flat price", async () => {
    const loaded = await writeManifest({ terrainTransitionSize: 1 })
    const [spec] = await resolveSpecs(loaded)
    expect(spec.candidates).toBe(25)
    expect(spec.cost).toBe(4)
  })

  it("counts a Pro set at transitionSize 0.5 as 25 tiles", async () => {
    const loaded = await writeManifest({ terrainMode: "pro", terrainTransitionSize: 0.5, terrainTileSize: 64 })
    const [spec] = await resolveSpecs(loaded)
    expect(spec.candidates).toBe(25)
    expect(spec.cost).toBe(25)
  })

  it("carries the Pro shape controls", async () => {
    const loaded = await writeManifest({
      terrainMode: "pro",
      terrainTransitionSize: 0.25,
      terrainRoundness: 2,
      terrainBoundaryAmplitude: 0.2,
      terrainBoundarySeed: 7,
      terrainStepSlope: 1.5,
      terrainConnectDiagonals: true,
    })
    const [spec] = await resolveSpecs(loaded)
    expect(spec).toMatchObject({
      terrainRoundness: 2,
      terrainBoundaryAmplitude: 0.2,
      terrainBoundarySeed: 7,
      terrainStepSlope: 1.5,
      terrainConnectDiagonals: true,
    })
  })

  it("keeps an existing terrain spec's hash and hashes each shape control only when set", async () => {
    const [plain] = await resolveSpecs(await writeManifest({ terrainMode: "pro" }))
    // The hash a terrain spec had before the shape controls existed.
    const { terrainRoundness: _r, terrainBoundaryAmplitude: _a, terrainBoundarySeed: _s, terrainStepSlope: _t, terrainConnectDiagonals: _d, ...legacy } = plain!
    expect(plain!.specHash).toBe(specHash(legacy, []))
    const [round] = await resolveSpecs(await writeManifest({ terrainMode: "pro", terrainRoundness: 1 }))
    const [diagonal] = await resolveSpecs(await writeManifest({ terrainMode: "pro", terrainConnectDiagonals: false }))
    expect(new Set([plain!.specHash, round!.specHash, diagonal!.specHash]).size).toBe(3)
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

  it.each([
    [{ terrainRoundness: 1 }, /terrainRoundness needs terrainMode: "pro" or a terrainShapeStyle/],
    [{ terrainShapeStyle: "round", terrainRoundness: 1.5 }, /terrainRoundness above 1 .* needs terrainMode: "pro"/],
    [{ terrainBoundaryAmplitude: 0.1 }, /terrainBoundaryAmplitude needs terrainMode: "pro" or a terrainShapeStyle/],
    [{ terrainMode: "pro", terrainBoundarySeed: 3 }, /terrainBoundarySeed .* set both or neither/],
    [{ terrainMode: "pro", terrainStepSlope: 1 }, /terrainStepSlope needs terrainMode: "pro" with terrainTransitionSize 0.25/],
    [{ terrainStepSlope: 1, terrainTransitionSize: 0.25 }, /terrainStepSlope needs terrainMode: "pro"/],
    [{ terrainConnectDiagonals: true }, /terrainConnectDiagonals needs terrainMode: "pro"/],
  ])("rejects a shape control outside the mode that reads it: %o", async (style, error) => {
    await expect(resolveSpecs(await writeManifest(style))).rejects.toThrow(error)
  })

  it("accepts roundness and a meander on a standard set with a shape style", async () => {
    const loaded = await writeManifest({ terrainShapeStyle: "square", terrainRoundness: 0.5, terrainBoundaryAmplitude: 0.1 })
    await expect(resolveSpecs(loaded)).resolves.toHaveLength(1)
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
      terrainRoundness: 2,
      terrainBoundaryAmplitude: 0.3,
      terrainBoundarySeed: 4,
      terrainConnectDiagonals: true,
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
      roundness: 2,
      boundaryAmplitude: 0.3,
      boundarySeed: 4,
      connectDiagonals: true,
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
        metadata: { terrainIds: { lower: "base-lower", upper: "base-upper" }, view: "high top-down" },
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
    // Each terrain's base tile id, for a set connected to this one.
    expect(state.metadata?.terrainIds).toEqual({ lower: "base-lower", upper: "base-upper" })
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

describe("connected terrain sets", () => {
  const coastPrompt = "1). deep ocean water texture 2). golden sand texture"
  const meadowPrompt = "1). golden sand texture 2). green grass texture"

  async function writeConnected(assets: Record<string, unknown>, styles: Record<string, unknown> = {}) {
    const manifest = {
      name: "test",
      styles: { base: { outDir: "out", generator: "terrain", terrainMode: "pro" }, ...styles },
      assets,
    }
    await writeFile(path.join(dir, "m.json"), JSON.stringify(manifest))
    return loadManifest(path.join(dir, "m.json"))
  }

  const pair = (connect: Record<string, unknown> = { lower: { of: "coast", terrain: "upper" } }) => ({
    coast: { prompt: coastPrompt },
    meadow: { prompt: meadowPrompt, connect },
  })

  /** A downloaded terrain set, with its one output on disk. */
  async function downloaded(spec: ResolvedSpec, objectId: string, metadata: Record<string, unknown> = {}): Promise<LockEntry> {
    const bytes = Buffer.from(`tiles of ${objectId}`)
    const entry = LockEntrySchema.parse({
      styleId: spec.styleId,
      assetId: spec.assetId,
      specHash: spec.specHash,
      generator: spec.generator,
      prompt: spec.prompt,
      width: spec.width,
      height: spec.height,
      status: "downloaded",
      jobId: objectId,
      objectId,
      outputs: [{ path: "x.png", sha256: sha256(bytes) }],
      providerMetadata: { pixellab: metadata },
    })
    const file = currentEntryOutputPath(entry, spec, 0)
    await mkdir(path.dirname(file), { recursive: true })
    await writeFile(file, bytes)
    return entry
  }

  it("rejects an unknown set, a set connected to itself, and a cycle", async () => {
    await expect(writeConnected({ meadow: { prompt: meadowPrompt, connect: { lower: { of: "nope", terrain: "upper" } } } }))
      .rejects.toThrow(/connect\.lower\.of: unknown asset "nope"/)
    await expect(writeConnected({ meadow: { prompt: meadowPrompt, connect: { upper: { of: "meadow", terrain: "lower" } } } }))
      .rejects.toThrow(/cannot connect to itself/)
    await expect(writeConnected({
      coast: { prompt: coastPrompt, connect: { upper: { of: "meadow", terrain: "lower" } } },
      meadow: { prompt: meadowPrompt, connect: { lower: { of: "coast", terrain: "upper" } } },
    })).rejects.toThrow(/connection cycle coast -> meadow -> coast/)
  })

  it("rejects connect outside a terrain style and across styles", async () => {
    const other = { other: { outDir: "out2", generator: "terrain" } }
    const loaded = await writeConnected({
      coast: { prompt: coastPrompt, styles: ["other"] },
      meadow: { prompt: meadowPrompt, styles: ["base"], connect: { lower: { of: "coast", terrain: "upper" } } },
    }, other)
    await expect(resolveSpecs(loaded)).rejects.toThrow(/"coast" is not in style "base"; connected terrain sets share one style/)
    const map = await writeConnected(pair(), { base: { outDir: "out", generator: "map" } })
    await expect(resolveSpecs(map)).rejects.toThrow(/connect needs a terrain style/)
  })

  it("makes the connection identity and resolves the other set even when filtered away", async () => {
    const [meadow] = await resolveSpecs(await writeConnected(pair()), { assets: ["meadow"] })
    expect(meadow!.terrainConnect?.lower).toMatchObject({ assetId: "coast", terrain: "upper" })
    expect(meadow!.terrainConnect?.lower?.spec.assetId).toBe("coast")
    const [lowerOf] = await resolveSpecs(await writeConnected(pair({ lower: { of: "coast", terrain: "lower" } })), { assets: ["meadow"] })
    const [plain] = await resolveSpecs(await writeConnected({ coast: { prompt: coastPrompt }, meadow: { prompt: meadowPrompt } }), { assets: ["meadow"] })
    expect(new Set([meadow!.specHash, lowerOf!.specHash, plain!.specHash]).size).toBe(3)
  })

  it("blocks the connected set until the other set is downloaded", async () => {
    const specs = await resolveSpecs(await writeConnected(pair()))
    const plan = await buildPlan(specs, { version: 2, entries: {} })
    const meadow = plan.items.find((item) => item.spec.assetId === "meadow")!
    expect(plan.items.find((item) => item.spec.assetId === "coast")!.state).toBe("missing")
    expect(meadow.state).toBe("blocked")
    expect(meadow.reason).toMatch(/connected set base\/coast is not ready/)
    expect(plan.actionable.map((item) => item.spec.assetId)).toEqual(["coast"])
  })

  it("follows the other set in the next wave when --force regenerates both", async () => {
    const specs = await resolveSpecs(await writeConnected(pair()))
    const lock: Lock = { version: 2, entries: {} }
    lock.entries[lockKey("base", "coast")] = await downloaded(specs[0]!, "coast-set-1")
    const plan = await buildPlan(specs, lock, { force: true })
    const meadow = plan.items.find((item) => item.spec.assetId === "meadow")!
    expect(meadow.state).toBe("blocked")
    expect(meadow.reason).toMatch(/base\/coast is being generated in this run/)
  })

  it("sends the other set's recorded terrain id, records the connection, and goes stale when that set is regenerated", async () => {
    const loaded = await writeConnected(pair())
    const specs = await resolveSpecs(loaded)
    const coast = specs.find((spec) => spec.assetId === "coast")!
    const lock: Lock = { version: 2, entries: {} }
    lock.entries[lockKey("base", "coast")] = await downloaded(coast, "coast-set-1", { terrainIds: { lower: "ocean-id", upper: "sand-id" } })

    const plan = await buildPlan(specs, lock)
    expect(plan.actionable.map((item) => item.spec.assetId)).toEqual(["meadow"])
    let sent: Record<string, unknown> | undefined
    const provider = new PixelLabProvider({
      createTileset: async (args: Record<string, unknown>) => {
        sent = args
        return { tileset_id: "meadow-set-1", background_job_id: "bg-1", status: "processing" }
      },
    } as never)
    await submit(provider, loaded, plan.actionable, lock, path.join(dir, "pixelkiln.lock.json"), { spacingMs: 0 })

    expect(sent).toMatchObject({ lowerBaseTileId: "sand-id", lowerDescription: "golden sand texture" })
    expect(sent?.upperBaseTileId).toBeUndefined()
    const entry = lock.entries[lockKey("base", "meadow")]!
    expect(entry.terrainConnect).toEqual({ lower: { sourceAssetId: "coast", sourceObjectId: "coast-set-1" } })
    expect(entry.providerMetadata.pixellab).toMatchObject({ baseTileIds: { lower: "sand-id" } })

    const meadow = specs.find((spec) => spec.assetId === "meadow")!
    lock.entries[lockKey("base", "meadow")] = {
      ...(await downloaded(meadow, "meadow-set-1")),
      terrainConnect: entry.terrainConnect,
    }
    expect((await buildPlan(specs, lock)).items.map((item) => item.state)).toEqual(["ok", "ok"])

    // The coast set regenerated: a new tileset, so a new sand terrain id.
    lock.entries[lockKey("base", "coast")] = await downloaded(coast, "coast-set-2", { terrainIds: { lower: "ocean-2", upper: "sand-2" } })
    const stale = (await buildPlan(specs, lock)).items.find((item) => item.spec.assetId === "meadow")!
    expect(stale.state).toBe("stale")
    expect(stale.reason).toMatch(/connected set coast was regenerated/)
  })

  it("reads the terrain id from PixelLab when the other set was downloaded before ids were recorded", async () => {
    const loaded = await writeConnected(pair({ upper: { of: "coast", terrain: "lower" } }))
    const specs = await resolveSpecs(loaded)
    const lock: Lock = { version: 2, entries: {} }
    lock.entries[lockKey("base", "coast")] = await downloaded(specs.find((spec) => spec.assetId === "coast")!, "coast-set-1")
    const read: string[] = []
    let sent: Record<string, unknown> | undefined
    const provider = new PixelLabProvider({
      getTileset: async (id: string) => {
        read.push(id)
        return { metadata: { terrainIds: { lower: "ocean-id", upper: "sand-id" }, view: "high top-down" } }
      },
      createTileset: async (args: Record<string, unknown>) => {
        sent = args
        return { tileset_id: "meadow-set-1", background_job_id: "bg-1", status: "processing" }
      },
    } as never)
    await submit(provider, loaded, (await buildPlan(specs, lock)).actionable, lock, path.join(dir, "lock.json"), { spacingMs: 0 })
    expect(read).toEqual(["coast-set-1"])
    expect(sent).toMatchObject({ upperBaseTileId: "ocean-id" })
  })

  it("keeps a retired generation's connection so a restore compares against it", async () => {
    const specs = await resolveSpecs(await writeConnected(pair()))
    const entry = await downloaded(specs[1]!, "meadow-set-1")
    const connection = { lower: { sourceAssetId: "coast", sourceObjectId: "coast-set-1" } }
    expect(retireGeneration({ ...entry, terrainConnect: connection }, "2026-10-15T00:00:00.000Z").terrainConnect).toEqual(connection)
    expect("terrainConnect" in retireGeneration(entry, "2026-10-15T00:00:00.000Z")).toBe(false)
  })
})
