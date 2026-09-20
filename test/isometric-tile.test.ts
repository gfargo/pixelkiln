import { describe, expect, it, beforeEach, afterEach } from "vitest"
import { mkdtemp, writeFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { loadManifest, resolveSpecs } from "../src/manifest.ts"
import { PixelLabProvider } from "../src/providers/pixellab.ts"
import { buildPlan } from "../src/pipeline/plan.ts"
import { submit } from "../src/pipeline/submit.ts"
import { isometricTileCost, type Lock, type ResolvedSpec } from "../src/types.ts"

let dir: string

async function writeManifest(style: Record<string, unknown>, prompt = "a raised sandstone plateau") {
  const manifest = {
    name: "test",
    styles: { base: { outDir: "out", generator: "isometricTile", ...style } },
    assets: { plateau: { prompt } },
  }
  await writeFile(path.join(dir, "m.json"), JSON.stringify(manifest))
  return loadManifest(path.join(dir, "m.json"))
}

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "pixelkiln-isometric-tile-"))
})
afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

describe("resolving an isometricTile spec", () => {
  it("carries the isometric-tile fields and a flat USD cost", async () => {
    const loaded = await writeManifest({ isometricTileSize: 32, isometricTileShape: "thick tile" })
    const [spec] = await resolveSpecs(loaded)

    expect(spec.generator).toBe("isometricTile")
    expect(spec.prompt).toBe("a raised sandstone plateau")
    expect(spec.isometricTileSize).toBe(32)
    expect(spec.isometricTileShape).toBe("thick tile")
    expect(spec.width).toBe(32)
    expect(spec.height).toBe(32)
    expect(spec.candidates).toBe(1)
    expect(spec.cost).toBe(isometricTileCost())
    expect(spec.costUnit).toBe("usd")
  })

  it("defaults the canvas to 32px when neither asset nor style set a size", async () => {
    const loaded = await writeManifest({})
    const [spec] = await resolveSpecs(loaded)
    expect(spec.width).toBe(32)
    expect(spec.height).toBe(32)
    expect(spec.isometricTileSize).toBeUndefined()
    expect(spec.isometricTileShape).toBeUndefined()
  })

  it("leaves isometric-tile fields off a different generator", async () => {
    const manifest = {
      name: "test",
      styles: { base: { outDir: "out", generator: "map" } },
      assets: { rock: { prompt: "a rock" } },
    }
    await writeFile(path.join(dir, "m.json"), JSON.stringify(manifest))
    const loaded = await loadManifest(path.join(dir, "m.json"))
    const [spec] = await resolveSpecs(loaded)
    expect(spec.isometricTileSize).toBeUndefined()
    expect(spec.isometricTileShape).toBeUndefined()
  })
})

describe("provider", () => {
  const provider = new PixelLabProvider({} as never)

  it("supports the isometricTile generator", () => {
    expect(provider.supports("isometricTile")).toBe(true)
  })

  it("estimates an isometricTile spec in USD, never candidates beyond one", () => {
    const spec = { generator: "isometricTile", width: 32, height: 32, size: 32, cost: 0.02, candidates: 1 } as ResolvedSpec
    expect(provider.estimate(spec)).toEqual({ unit: "usd", amount: 0.02, candidates: 1 })
  })

  it("rejects a canvas outside 16-64 pixels", async () => {
    const loaded = await writeManifest({ size: 128 })
    await expect(resolveSpecs(loaded)).rejects.toThrow(/size must be 16 to 64 pixels/)
  })

  it("rejects an outline value the endpoint does not accept", async () => {
    const loaded = await writeManifest({ outline: "single color black outline" })
    await expect(resolveSpecs(loaded)).rejects.toThrow(/PixelLab isometricTile outline must be one of/)
  })

  it("rejects style images", async () => {
    const loaded = await writeManifest({})
    const [spec] = await resolveSpecs(loaded)
    expect(() => provider.validate(spec, [{ base64: "x", width: 32, height: 32, format: "png" } as never])).toThrow(
      /does not support style images/,
    )
  })
})

describe("submit and poll", () => {
  it("sends the prompt and isometric-tile fields to the client", async () => {
    const loaded = await writeManifest({ isometricTileSize: 16, isometricTileShape: "block" })
    const specs = await resolveSpecs(loaded)
    let sent: Record<string, unknown> | undefined
    const provider = new PixelLabProvider({
      createIsometricTile: async (args: Record<string, unknown>) => {
        sent = args
        return { tile_id: "tile-1", background_job_id: "bg-1", status: "processing" }
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
      description: "a raised sandstone plateau",
      imageWidth: 32,
      imageHeight: 32,
      tileSize: 16,
      tileShape: "block",
    })
  })

  it("polls straight to ready with one source and no candidates to review", async () => {
    const provider = new PixelLabProvider({
      getIsometricTile: async () => ({
        image: { base64: Buffer.from("a").toString("base64"), format: "png" },
        usage: { type: "usd", usd: 0.02 },
      }),
    } as never)

    const state = await provider.poll("tile-1", "isometricTile")
    expect(state.status).toBe("ready")
    if (state.status !== "ready") return
    expect(state.sourceUrl).toMatch(/^file:\/\//)
    expect(state.billed).toEqual({ amount: 0.02, unit: "usd" })
  })

  it("reports processing while the API answers 423", async () => {
    const provider = new PixelLabProvider({
      getIsometricTile: async () => {
        const { PixelLabError } = await import("../src/client.ts")
        throw new PixelLabError("still drawing", 423, "")
      },
    } as never)
    const state = await provider.poll("tile-1", "isometricTile")
    expect(state.status).toBe("processing")
  })
})
