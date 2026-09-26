import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { PixelLabClient, parseProFlashQuote, type ProFlashQuote } from "../src/client.ts"
import { sha256File } from "../src/hash.ts"
import { loadManifest, resolveSpecs } from "../src/manifest.ts"
import { priceManifestEdit } from "../src/manifest-edit.ts"
import { encodeRgbaPng } from "../src/png.ts"
import { createProFlashQuoter, proFlashQuoteQuery } from "../src/providers/pixellab.ts"
import { createGalleryPriceHandler } from "../src/gallery/edit.ts"
import type { ResolvedSpec } from "../src/types.ts"

let dir: string
let manifestPath: string
beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "pixelkiln-pro-flash-quotes-"))
  manifestPath = path.join(dir, "pixelkiln.manifest.json")
})
afterEach(async () => {
  vi.unstubAllGlobals()
  await rm(dir, { recursive: true, force: true })
})

const png = (size: number) => encodeRgbaPng(size, size, Buffer.alloc(size * size * 4, 90))

async function specsOf(styles: Record<string, unknown>, assets: Record<string, unknown>): Promise<ResolvedSpec[]> {
  await writeFile(manifestPath, JSON.stringify({ name: "quotes", provider: "pixellab", styles, assets }))
  return resolveSpecs(await loadManifest(manifestPath))
}
const find = (specs: ResolvedSpec[], key: string) => specs.find((s) => `${s.styleId}/${s.assetId}` === key)!

describe("reading a /pro-flash/cost answer", () => {
  it("takes a total when given, else sums the image and rotations, and refuses one with no price", () => {
    expect(parseProFlashQuote({ image: 5, rotations: 1 })).toEqual({ image: 5, rotations: 1, total: 6 })
    expect(parseProFlashQuote({ image: 6, rotations: 2, total: 8 })).toEqual({ image: 6, rotations: 2, total: 8 })
    expect(parseProFlashQuote({ total_generations: 9 })).toEqual({ image: null, rotations: null, total: 9 })
    expect(parseProFlashQuote({ usage: { image_generations: 5, rotation_generations: 3 } })).toMatchObject({ total: 8 })
    expect(() => parseProFlashQuote({})).toThrow(/returned no price/)
    expect(() => parseProFlashQuote({ image: "five" })).toThrow(/returned no price/)
  })

  it("asks with the operation, size, and directions as query parameters", async () => {
    let asked: URL | undefined
    vi.stubGlobal("fetch", vi.fn(async (input: string, init?: RequestInit) => {
      asked = new URL(String(input))
      expect(init?.method ?? "GET").toBe("GET")
      return new Response(JSON.stringify({ image: 5, rotations: 1 }))
    }))
    const quote = await new PixelLabClient("key").proFlashCost({ operation: "character", width: 64, height: 64, nDirections: 8 })
    expect(asked!.pathname).toMatch(/\/pro-flash\/cost$/)
    expect(Object.fromEntries(asked!.searchParams)).toEqual({ operation: "character", width: "64", height: "64", n_directions: "8" })
    expect(quote.total).toBe(6)
  })
})

describe("which specs are priced by a Pro Flash quote", () => {
  it("follows the offline estimate's paths, and asks for rotations alone for a base from a sprite", async () => {
    await writeFile(path.join(dir, "sprite.png"), png(48))
    await writeFile(path.join(dir, "source.png"), png(64))
    await writeFile(path.join(dir, "mask.png"), png(64))
    const specs = await specsOf(
      {
        cast: { generator: "character", mode: "pro-flash", outDir: "cast", size: 64 },
        v3: { generator: "character", mode: "v3", outDir: "v3", size: 64 },
        stills: { generator: "imageProFlash", outDir: "stills" },
        props: { generator: "objectPro", outDir: "props", size: 64, objectDirections: 1 },
        base: { generator: "map", outDir: "art" },
      },
      {
        knight: { prompt: "a knight", styles: ["cast", "v3"] },
        squire: { prompt: "a squire", styles: ["cast"], reference: "sprite.png" },
        "knight.walk": { styles: ["cast"], animation: { of: "knight", template: "walk", direction: "south" } },
        banner: { prompt: "a banner", width: 128, height: 96, styles: ["stills"] },
        rune: { prompt: "a rune", styles: ["props"], reference: "sprite.png" },
        tower: { prompt: "a tower", source: "source.png", styles: ["base"] },
        "tower.snow": { prompt: "snow", width: 64, height: 64, styles: ["base"], revision: { mode: "inpaint", from: "tower", mask: "mask.png", engine: "pro-flash" } },
        "tower.plain": { prompt: "snow", width: 64, height: 64, styles: ["base"], revision: { mode: "image-to-image", from: "tower" } },
      },
    )
    expect(proFlashQuoteQuery(find(specs, "cast/knight"))).toEqual({ operation: "character", width: 64, height: 64, nDirections: 8, part: "total" })
    expect(proFlashQuoteQuery(find(specs, "cast/squire"))).toEqual({ operation: "character", width: 48, height: 48, nDirections: 8, part: "rotations" })
    expect(proFlashQuoteQuery(find(specs, "v3/knight"))).toBeNull()
    expect(proFlashQuoteQuery(find(specs, "cast/knight.walk"))).toBeNull()
    expect(proFlashQuoteQuery(find(specs, "stills/banner"))).toEqual({ operation: "create", width: 128, height: 96, part: "total" })
    expect(proFlashQuoteQuery(find(specs, "props/rune"))).toEqual({ operation: "object", width: 48, height: 48, nDirections: 1, part: "rotations" })
    expect(proFlashQuoteQuery(find(specs, "base/tower.snow"))).toEqual({ operation: "inpaint", width: 64, height: 64, part: "total" })
    expect(proFlashQuoteQuery(find(specs, "base/tower.plain"))).toBeNull()
  })
})

describe("the quoter", () => {
  const spec = { provider: "pixellab", generator: "imageProFlash", width: 64, height: 64 } as ResolvedSpec
  const sameSize = { ...spec, assetId: "other" } as ResolvedSpec

  it("asks each question once while fresh, again once stale, and again after a failure", async () => {
    let now = 0
    const answers: Array<ProFlashQuote | Error> = [new Error("down"), { image: 5, rotations: null, total: 5 }, { image: 7, rotations: null, total: 7 }]
    const proFlashCost = vi.fn(async () => {
      const next = answers.shift()!
      if (next instanceof Error) throw next
      return next
    })
    const quote = createProFlashQuoter({ proFlashCost }, { ttlMs: 1000, now: () => now })
    await expect(quote(spec)).rejects.toThrow("down")
    expect(await quote(spec)).toBe(5)
    expect(await quote(sameSize)).toBe(5)
    expect(proFlashCost).toHaveBeenCalledTimes(2)
    now = 2000
    expect(await quote(spec)).toBe(7)
    expect(await quote({ ...spec, generator: "map" } as ResolvedSpec)).toBeNull()
    expect(proFlashCost).toHaveBeenCalledTimes(3)
  })

  it("gives up on a slow answer", async () => {
    const quote = createProFlashQuoter({ proFlashCost: () => new Promise(() => {}) }, { timeoutMs: 20 })
    await expect(quote(spec)).rejects.toThrow(/did not answer within/)
  })
})

describe("pricing a draft with live quotes", () => {
  beforeEach(async () => {
    await writeFile(manifestPath, JSON.stringify({
      name: "quotes",
      provider: "pixellab",
      styles: { cast: { generator: "character", mode: "pro-flash", outDir: "cast", size: 64 } },
      assets: {},
    }, null, 2))
  })
  const draft = async () => ({
    action: "batch" as const,
    expectedSha256: await sha256File(manifestPath),
    edits: [
      { action: "add-asset" as const, assetId: "mira", asset: { prompt: "a knight" } },
      { action: "add-asset" as const, assetId: "mira.walk", asset: { animation: { of: "mira", template: "walk", direction: "south" } } },
    ],
  })

  it("puts PixelLab's quote in place of the estimate, keeps the estimate beside it, and writes nothing", async () => {
    const before = await readFile(manifestPath, "utf8")
    const price = await priceManifestEdit(manifestPath, await draft() as never, {
      quote: async (spec) => (spec.character?.kind === "base" ? 11 : null),
    })
    expect(await readFile(manifestPath, "utf8")).toBe(before)
    const byKey = Object.fromEntries(price.items.map((i) => [i.key, i]))
    expect(byKey["cast/mira"]).toMatchObject({ cost: 11, quote: "live", estimate: 6 })
    expect(byKey["cast/mira.walk"]).not.toHaveProperty("quote")
    expect(price.totals.generations).toBe(11 + byKey["cast/mira.walk"]!.cost)
    expect(price.quoteError).toBeUndefined()
  })

  it("falls back to the estimate when a quote fails, and says why", async () => {
    const price = await priceManifestEdit(manifestPath, await draft() as never, {
      quote: async () => { throw new Error("PixelLab's Pro Flash quote did not answer within 5s") },
    })
    expect(price.items.find((i) => i.key === "cast/mira")).toMatchObject({ cost: 6 })
    expect(price.items.some((i) => i.quote)).toBe(false)
    expect(price.quoteError).toMatch(/did not answer/)
  })

  it("is what the gallery's price route answers, and a project without a key keeps the estimate", async () => {
    const quoted = createGalleryPriceHandler({
      manifestFor: () => manifestPath,
      quoteFor: async () => createProFlashQuoter({ proFlashCost: async () => ({ image: 6, rotations: 1, total: 7 }) }),
    })
    expect((await quoted(await draft())).items.find((i) => i.key === "cast/mira")).toMatchObject({ cost: 7, quote: "live" })
    const offline = createGalleryPriceHandler({ manifestFor: () => manifestPath, quoteFor: async () => null })
    const price = await offline(await draft())
    expect(price.items.find((i) => i.key === "cast/mira")).toMatchObject({ cost: 6 })
    expect(price.quoteError).toBeUndefined()
  })
})
