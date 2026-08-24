import { describe, expect, it, beforeEach, afterEach } from "vitest"
import { mkdtemp, writeFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { loadManifest, resolveSpecs } from "../src/manifest.ts"
import { PixelLabError } from "../src/client.ts"
import { PixelLabProvider } from "../src/providers/pixellab.ts"
import {
  countNumberedDescriptions,
  tileVariationCount,
  tilesCost,
  type ResolvedSpec,
} from "../src/types.ts"

let dir: string

async function writeManifest(style: Record<string, unknown>, prompt = "a grass tile") {
  const manifest = {
    name: "test",
    styles: { base: { outDir: "out", ...style } },
    assets: { ground: { prompt } },
  }
  await writeFile(path.join(dir, "m.json"), JSON.stringify(manifest))
  return loadManifest(path.join(dir, "m.json"))
}

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "pixelkiln-tiles-"))
})
afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

describe("numbered descriptions", () => {
  // The endpoint documents "1). grass 2). dirt" as the way to say what should
  // come back, and returns a group of variations per number — so the count
  // drives both the price and how many candidates the pick sheet shows.
  it("counts the numbered items the endpoint groups by", () => {
    expect(countNumberedDescriptions("1). grass tile 2). dirt tile 3). stone tile")).toBe(3)
    expect(countNumberedDescriptions("1). grass  10). lava")).toBe(2)
  })

  it("treats an unnumbered prompt as a single group", () => {
    expect(countNumberedDescriptions("just some grass")).toBe(0)
    expect(tileVariationCount(0)).toBe(4)
  })
})

describe("tiles cost", () => {
  // Pricing off one tile would put every set at the floor: a 32px tile is
  // 1024px on its own no matter how many of them the call draws.
  it("prices off the whole set, not one tile", () => {
    expect(tilesCost(32, 1)).toBe(20)
    expect(tilesCost(32, 16)).toBe(40)
  })

  it("is monotonic in the number of variations", () => {
    const costs = [1, 2, 4, 8, 16].map((n) => tilesCost(32, n))
    expect(costs).toEqual([...costs].sort((a, b) => a - b))
  })
})

describe("resolving a tiles spec", () => {
  it("carries the tile fields and prices off the set", async () => {
    const loaded = await writeManifest(
      { generator: "tiles", tileSize: 32, tileType: "isometric", tileView: "low top-down" },
      "1). dark rough grass 2). tall meadow grass",
    )
    const [spec] = await resolveSpecs(loaded)

    expect(spec.generator).toBe("tiles")
    expect(spec.tileSize).toBe(32)
    expect(spec.tileType).toBe("isometric")
    expect(spec.tileFeature).toBeUndefined()
    // two numbered groups -> 8 variations -> top canvas tier
    expect(spec.candidates).toBe(8)
    expect(spec.cost).toBe(tilesCost(32, 8))
  })

  it("leaves tile fields off a non-tiles generator", async () => {
    const loaded = await writeManifest({ generator: "map", outDir: "out" })
    const [spec] = await resolveSpecs(loaded)
    expect(spec.tileSize).toBeUndefined()
    expect(spec.tileType).toBeUndefined()
    expect(spec.candidates).toBe(1)
  })

  it("accepts a connectable set via tileFeature", async () => {
    const loaded = await writeManifest({
      generator: "tiles",
      tileSize: 32,
      tileFeature: "tileset",
    })
    const [spec] = await resolveSpecs(loaded)
    expect(spec.tileFeature).toBe("tileset")
  })

  it("rejects a tileFeature the API does not define", async () => {
    await expect(writeManifest({ generator: "tiles", tileFeature: "hexes" })).rejects.toThrow(
      /tileFeature/,
    )
  })
})

describe("provider", () => {
  const provider = new PixelLabProvider({} as never)

  it("supports the tiles generator", () => {
    expect(provider.supports("tiles")).toBe(true)
  })

  it("estimates a tiles spec from the resolved set, not the sprite box", () => {
    const spec = {
      generator: "tiles",
      width: 32,
      height: 32,
      size: 32,
      cost: 40,
      candidates: 16,
    } as ResolvedSpec
    expect(provider.estimate(spec)).toEqual({
      unit: "generations",
      amount: 40,
      candidates: 16,
    })
  })
})

describe("tile url ordering", () => {
  // A connectable set is sliced by index, so the order the pick sheet and the
  // lockfile see has to be tile_0, tile_1, ... — not whatever order the JSON
  // object happened to arrive in.
  it("sorts numerically, not lexicographically", async () => {
    const urls: Record<string, string> = {}
    for (const i of [10, 2, 1, 0, 11]) urls[`tile_${i}`] = `https://x/${i}.png`

    const provider = new PixelLabProvider({
      getTilesPro: async () => ({ storage_urls: urls, kind: "tiles" }),
    } as never)

    const state = await provider.poll("job", "tiles")
    expect(state.status).toBe("review")
    if (state.status !== "review") return
    expect(state.candidateUrls).toEqual([
      "https://x/0.png",
      "https://x/1.png",
      "https://x/2.png",
      "https://x/10.png",
      "https://x/11.png",
    ])
  })
})

describe("selecting a tiles variation", () => {
  const client = {
    getTilesPro: async () => ({
      storage_urls: { tile_0: "https://x/0.png", tile_1: "https://x/1.png" },
      kind: "tiles",
    }),
    selectFrames: async () => {
      throw new Error("select-frames must not be called for a tiles variation")
    },
  }

  it("records job#index and never calls select-frames", async () => {
    const provider = new PixelLabProvider(client as never)
    const picked = await provider.selectCandidate("job-abc", 1, "asset:ground", "tiles")
    expect(picked).toEqual({ objectId: "job-abc#1", sourceUrl: "https://x/1.png" })
  })

  it("fails loudly on an index the set does not have", async () => {
    const provider = new PixelLabProvider(client as never)
    await expect(provider.selectCandidate("job-abc", 7, undefined, "tiles")).rejects.toThrow(
      /no variation at index 7/,
    )
  })
})

describe("polling a tiles job", () => {
  // There is no `status` field on GET /tiles-pro/{id} — the HTTP code is the
  // status. 423 means still drawing, and treating it as a hard error would
  // abort a run that was merely early.
  it("reads 423 as still processing", async () => {
    const provider = new PixelLabProvider({
      getTilesPro: async () => {
        throw new PixelLabError("locked", 423, "")
      },
    } as never)
    expect(await provider.poll("job", "tiles")).toEqual({ status: "processing" })
  })

  it("does not swallow a real failure", async () => {
    const provider = new PixelLabProvider({
      getTilesPro: async () => {
        throw new PixelLabError("nope", 404, "")
      },
    } as never)
    await expect(provider.poll("job", "tiles")).rejects.toThrow(/nope/)
  })

  it("reports an empty set as failed rather than an empty review", async () => {
    const provider = new PixelLabProvider({
      getTilesPro: async () => ({ storage_urls: {}, kind: "tiles" }),
    } as never)
    expect(await provider.poll("job", "tiles")).toEqual({
      status: "failed",
      error: "tiles job returned no storage urls",
    })
  })
})
