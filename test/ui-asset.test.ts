import { describe, expect, it, beforeEach, afterEach } from "vitest"
import { mkdtemp, writeFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { loadManifest, resolveSpecs } from "../src/manifest.ts"
import { PixelLabProvider } from "../src/providers/pixellab.ts"
import { buildPlan } from "../src/pipeline/plan.ts"
import { submit } from "../src/pipeline/submit.ts"
import { generationCost, type Lock, type ResolvedSpec } from "../src/types.ts"

let dir: string

async function writeManifest(
  style: Record<string, unknown> = {},
  asset: Record<string, unknown> = { prompt: "a wooden dialog panel" },
) {
  const manifest = {
    name: "test",
    styles: { base: { outDir: "out", generator: "uiAsset", ...style } },
    assets: { panel: asset },
  }
  await writeFile(path.join(dir, "m.json"), JSON.stringify(manifest))
  return loadManifest(path.join(dir, "m.json"))
}

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "pixelkiln-ui-asset-"))
})
afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

describe("resolving a uiAsset spec", () => {
  it("defaults to a 256x256 canvas, under the API's own default size", async () => {
    const loaded = await writeManifest()
    const [spec] = await resolveSpecs(loaded)
    expect(spec.generator).toBe("uiAsset")
    expect(spec.width).toBe(256)
    expect(spec.height).toBe(256)
    expect(spec.candidates).toBe(1)
    expect(spec.costUnit).toBe("generations")
  })

  it("takes non-square width/height from the asset, like imagePro", async () => {
    const loaded = await writeManifest({}, { prompt: "a wide toolbar", width: 512, height: 192 })
    const [spec] = await resolveSpecs(loaded)
    expect(spec.width).toBe(512)
    expect(spec.height).toBe(192)
  })

  it("carries pieces, elements, and the style's uiColorPalette hint", async () => {
    const loaded = await writeManifest(
      { uiColorPalette: "brown and gold" },
      {
        prompt: "a health bar panel",
        pieces: [{ id: "bg", kind: "rounded_rect", x: 0, y: 0, w: 256, h: 64, radius: 8 }],
        elements: ["health_bar", "button"],
      },
    )
    const [spec] = await resolveSpecs(loaded)
    expect(spec.uiPieces).toEqual([{ id: "bg", kind: "rounded_rect", x: 0, y: 0, w: 256, h: 64, radius: 8 }])
    expect(spec.uiElements).toEqual(["health_bar", "button"])
    expect(spec.uiColorPalette).toBe("brown and gold")
  })

  it("leaves pieces, elements, and uiColorPalette off a different generator", async () => {
    const manifest = {
      name: "test",
      styles: { base: { outDir: "out", generator: "map" } },
      assets: { rock: { prompt: "a rock" } },
    }
    await writeFile(path.join(dir, "m.json"), JSON.stringify(manifest))
    const loaded = await loadManifest(path.join(dir, "m.json"))
    const [spec] = await resolveSpecs(loaded)
    expect(spec.uiPieces).toBeUndefined()
    expect(spec.uiElements).toBeUndefined()
    expect(spec.uiColorPalette).toBeUndefined()
  })

  it("rejects pieces or elements on a non-uiAsset style", async () => {
    const manifest = {
      name: "test",
      styles: { base: { outDir: "out", generator: "map" } },
      assets: { rock: { prompt: "a rock", elements: ["button"] } },
    }
    await writeFile(path.join(dir, "m.json"), JSON.stringify(manifest))
    const loaded = await loadManifest(path.join(dir, "m.json"))
    await expect(resolveSpecs(loaded)).rejects.toThrow(/elements needs a uiAsset style/)
  })

  it("changing pieces/elements/uiColorPalette changes the hash", async () => {
    const base = await resolveSpecs(await writeManifest())
    const withPieces = await resolveSpecs(
      await writeManifest({}, { prompt: "a wooden dialog panel", elements: ["window"] }),
    )
    expect(withPieces[0]!.specHash).not.toBe(base[0]!.specHash)

    const withPalette = await resolveSpecs(await writeManifest({ uiColorPalette: "brown and gold" }))
    expect(withPalette[0]!.specHash).not.toBe(base[0]!.specHash)
  })
})

describe("provider", () => {
  const provider = new PixelLabProvider({} as never)

  it("supports the uiAsset generator", () => {
    expect(provider.supports("uiAsset")).toBe(true)
  })

  it("estimates in generations off the generic canvas-tier fallback, one candidate", () => {
    const spec = { generator: "uiAsset", width: 256, height: 256, size: 256 } as ResolvedSpec
    expect(provider.estimate(spec)).toEqual({
      unit: "generations",
      amount: generationCost(256, 256, "uiAsset"),
      candidates: 1,
    })
  })

  it("rejects a canvas outside 192-688 pixels per side", async () => {
    const tooSmall = await writeManifest({}, { prompt: "x", width: 128, height: 256 })
    await expect(resolveSpecs(tooSmall)).rejects.toThrow(/192 to 688 pixels per side/)

    const tooLarge = await writeManifest({}, { prompt: "x", width: 700, height: 256 })
    await expect(resolveSpecs(tooLarge)).rejects.toThrow(/192 to 688 pixels per side/)
  })
})

describe("submit and poll", () => {
  it("sends the prompt, size, pieces, elements, and color palette to the client", async () => {
    const loaded = await writeManifest(
      { uiColorPalette: "brown and gold" },
      {
        prompt: "a health bar panel",
        pieces: [{ id: "bg", kind: "rounded_rect", x: 0, y: 0, w: 256, h: 64, radius: 8 }],
        elements: ["health_bar"],
      },
    )
    const specs = await resolveSpecs(loaded)
    let sent: Record<string, unknown> | undefined
    const provider = new PixelLabProvider({
      createUiAsset: async (args: Record<string, unknown>) => {
        sent = args
        return { ui_asset_id: "ui-1", background_job_id: "bg-1", status: "processing" }
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
      description: "a health bar panel",
      width: 256,
      height: 256,
      pieces: [{ id: "bg", kind: "rounded_rect", x: 0, y: 0, w: 256, h: 64, radius: 8 }],
      elements: ["health_bar"],
      colorPalette: "brown and gold",
    })
  })

  it("polls straight to ready with one source and no candidates to review", async () => {
    const provider = new PixelLabProvider({
      getUiAsset: async () => ({
        status: "completed",
        imageUrl: "https://cdn.test/ui-1.png",
        progressPercent: 100,
        etaSeconds: 0,
      }),
      getBackgroundJob: async () => ({ id: "bg-1", status: "completed", usage: { type: "generations", generations: 25 } }),
    } as never)

    const state = await provider.poll("ui-1", "uiAsset", { metadata: { backgroundJobId: "bg-1" } })
    expect(state.status).toBe("ready")
    if (state.status !== "ready") return
    expect(state.sourceUrl).toBe("https://cdn.test/ui-1.png")
    expect(state.sources).toEqual([{ url: "https://cdn.test/ui-1.png" }])
    expect(state.billed).toEqual({ amount: 25, unit: "generations" })
  })

  it("reports processing with progress while the job is still drawing", async () => {
    const provider = new PixelLabProvider({
      getUiAsset: async () => ({ status: "processing", imageUrl: null, progressPercent: 40, etaSeconds: 12 }),
    } as never)
    const state = await provider.poll("ui-1", "uiAsset")
    expect(state).toMatchObject({ status: "processing", progressPercent: 40, etaSeconds: 12 })
  })

  it("reports failed when the upstream job fails", async () => {
    const provider = new PixelLabProvider({
      getUiAsset: async () => ({ status: "failed", imageUrl: null, progressPercent: null, etaSeconds: null }),
    } as never)
    const state = await provider.poll("ui-1", "uiAsset")
    expect(state.status).toBe("failed")
  })
})
