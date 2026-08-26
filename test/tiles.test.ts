import { describe, expect, it, beforeEach, afterEach } from "vitest"
import { mkdtemp, writeFile, rm } from "node:fs/promises"
import { existsSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { imageMetadata, loadManifest, resolveSpecs } from "../src/manifest.ts"
import { PixelLabError } from "../src/client.ts"
import { PixelLabProvider } from "../src/providers/pixellab.ts"
import { buildPlan } from "../src/pipeline/plan.ts"
import { submit } from "../src/pipeline/submit.ts"
import { poll } from "../src/pipeline/poll.ts"
import { fetchAssets } from "../src/pipeline/fetch.ts"
import { encodeRgbaPng } from "../src/png.ts"
import { FAKE_PNG } from "../src/providers/fake.ts"
import {
  countNumberedDescriptions,
  tileVariationCount,
  tilesCost,
  type Lock,
  type ResolvedSpec,
  lockKey,
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
    expect(spec.candidates).toBe(16)
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

describe("style images", () => {
  it("submits the reference bytes with their actual dimensions", async () => {
    const pixels = Buffer.alloc(32 * 24 * 4, 255)
    await writeFile(path.join(dir, "reference.png"), encodeRgbaPng(32, 24, pixels))
    const loaded = await writeManifest({
      generator: "tiles",
      styleImages: [{ path: "reference.png" }],
    })
    const specs = await resolveSpecs(loaded)
    expect(specs[0]).toMatchObject({ width: 32, height: 24, size: 32, tileSize: 32 })
    let sent: { styleImages?: { base64: string; width: number; height: number }[] } | undefined
    const provider = new PixelLabProvider({
      createTilesPro: async (args: typeof sent) => {
        sent = args
        return { tile_id: "tiles-1", background_job_id: "bg-1", status: "processing" }
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

    expect(sent?.styleImages).toHaveLength(1)
    expect(sent?.styleImages?.[0]).toMatchObject({ width: 32, height: 24 })
    expect(sent?.styleImages?.[0]?.base64).toBeTruthy()
  })

  it("reads JPEG dimensions and preserves its request format", () => {
    const jpeg = Buffer.from([
      0xff, 0xd8,
      0xff, 0xc0, 0x00, 0x11, 0x08, 0x00, 0x18, 0x00, 0x20, 0x03,
      0x01, 0x11, 0x00, 0x02, 0x11, 0x00, 0x03, 0x11, 0x00,
      0xff, 0xd9,
    ])
    expect(imageMetadata(jpeg)).toEqual({ width: 32, height: 24, format: "jpeg" })
  })

  it("uses reference dimensions for a 1dir spec when the API will ignore size", async () => {
    const pixels = Buffer.alloc(32 * 24 * 4, 255)
    await writeFile(path.join(dir, "reference.png"), encodeRgbaPng(32, 24, pixels))
    const loaded = await writeManifest({
      generator: "1dir",
      size: 64,
      styleImages: [{ path: "reference.png" }],
    })

    const [spec] = await resolveSpecs(loaded)

    expect(spec).toMatchObject({ width: 32, height: 32, size: 32, candidates: 64, cost: 20 })
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

  it("treats a connectable feature as one ready multi-output set", async () => {
    const urls = {
      tile_2: "https://x/2.png",
      tile_0: "https://x/0.png",
      tile_1: "https://x/1.png",
    }
    const downloads: string[] = []
    let failMiddle = true
    const provider = new PixelLabProvider({
      getTilesPro: async () => ({ storage_urls: urls, kind: "tiles" }),
      download: async (url: string) => {
        downloads.push(url)
        if (url.endsWith("/1.png") && failMiddle) {
          failMiddle = false
          throw new Error("temporary CDN failure")
        }
        return FAKE_PNG
      },
    } as never)
    const loaded = await writeManifest({ generator: "tiles", tileSize: 32, tileFeature: "tileset" })
    const [spec] = await resolveSpecs(loaded)
    const key = lockKey(spec!.styleId, spec!.assetId)
    const lock: Lock = {
      version: 2,
      entries: {
        [key]: {
          styleId: spec!.styleId, assetId: spec!.assetId, specHash: spec!.specHash,
          generator: "tiles", tileFeature: "tileset", prompt: spec!.prompt, width: 32, height: 32,
          jobId: "job", reviewObjectId: "job", objectId: null, candidateIndex: null,
          status: "processing", error: null, sourceUrl: null, sourceUrls: [], outputs: [],
          submittedAt: null, downloadedAt: null, cost: 40, provider: "pixellab",
        },
      },
    }
    const lockPath = path.join(dir, "pixelkiln.lock.json")

    const polled = await poll(provider, lock, lockPath, { intervalMs: 0, specs: [spec!] })
    expect(polled.completed).toBe(1)
    expect(lock.entries[key]!.status).toBe("selected")
    expect(lock.entries[key]!.sourceUrls.map((s) => s.role)).toEqual([
      "tile-00", "tile-01", "tile-02",
    ])

    const interrupted = await fetchAssets(provider, [spec!], lock, lockPath)
    expect(interrupted.failed).toBe(1)
    expect(lock.entries[key]!.status).toBe("download-failed")
    expect(lock.entries[key]!.outputs.map((o) => o.role)).toEqual(["tile-00"])

    const fetched = await fetchAssets(provider, [spec!], lock, lockPath)
    expect(fetched.downloaded).toBe(1)
    expect(lock.entries[key]!.outputs.map((o) => o.role)).toEqual([
      "tile-00", "tile-01", "tile-02",
    ])
    expect(downloads.filter((url) => url.endsWith("/0.png"))).toHaveLength(1)
    for (const output of lock.entries[key]!.outputs) expect(existsSync(output.path)).toBe(true)
    expect(existsSync(spec!.outFile)).toBe(false)
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

describe("outline mode and connectable sets", () => {
  it("carries outlineMode onto a tiles spec", async () => {
    const loaded = await writeManifest({
      generator: "tiles",
      tileSize: 32,
      outlineMode: "segmentation",
    })
    const [spec] = await resolveSpecs(loaded)
    expect(spec.outlineMode).toBe("segmentation")
  })

  // The API rejects the pair outright. Catching it in the manifest means
  // `plan` reports it for free, rather than a run discovering it at submit.
  it("rejects tileFeature combined with styleImages", async () => {
    await expect(
      writeManifest({
        generator: "tiles",
        tileSize: 32,
        tileFeature: "tileset",
        styleImages: [{ path: "ref.png" }],
      }),
    ).rejects.toThrow(/cannot be combined/)
  })

  it("allows either one on its own", async () => {
    await expect(
      writeManifest({ generator: "tiles", tileFeature: "tileset" }),
    ).resolves.toBeDefined()
    await expect(
      writeManifest({ generator: "tiles", styleImages: [{ path: "ref.png" }] }),
    ).resolves.toBeDefined()
  })
})

describe("pixflux background", () => {
  // The API's own default is no_background: false. pixelkiln forced it true
  // for every pixflux asset, which is right for a sprite and wrong for
  // anything that IS a scene — a cover banner came back as a small subject
  // floating in a mostly-empty frame.
  it("strips the background by default, as a sprite wants", async () => {
    const loaded = await writeManifest({ generator: "pixflux" })
    const [spec] = await resolveSpecs(loaded)
    expect(spec.noBackground).toBe(true)
  })

  it("keeps the background when a style asks for a full-bleed image", async () => {
    const loaded = await writeManifest({ generator: "pixflux", noBackground: false })
    const [spec] = await resolveSpecs(loaded)
    expect(spec.noBackground).toBe(false)
  })
})
