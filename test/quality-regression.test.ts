import { afterEach, beforeEach, describe, expect, it } from "vitest"
import path from "node:path"
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { createArtifactBundleManifest } from "../src/artifacts.ts"
import { encodeRgbaPng } from "../src/png.ts"
import {
  checkQualityBaseline,
  measureImageQuality,
  resolveQualityInputs,
  snapshotQualityBaseline,
} from "../src/pipeline/quality-regression.ts"

describe("image quality regression", () => {
  let dir: string

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "pixelkiln-quality-regression-"))
  })

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  function verticalBands(colors: Array<[number, number, number, number]>): Buffer {
    const width = 8
    const height = 8
    const pixels = Buffer.alloc(width * height * 4)
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const color = colors[Math.min(colors.length - 1, Math.floor(x * colors.length / width))]!
        const offset = (y * width + x) * 4
        pixels.set(color, offset)
      }
    }
    return encodeRgbaPng(width, height, pixels)
  }

  async function setup(
    tolerances: Record<string, unknown> = {},
  ): Promise<{ image: string; inputs: string; baseline: string }> {
    const image = path.join(dir, "art", "sample.png")
    const inputs = path.join(dir, "config", "quality-inputs.json")
    const baseline = path.join(dir, "quality", "pixelkiln.quality.json")
    await Promise.all([
      mkdir(path.dirname(image), { recursive: true }),
      mkdir(path.dirname(inputs), { recursive: true }),
      mkdir(path.dirname(baseline), { recursive: true }),
    ])
    await writeFile(image, verticalBands([
      [0, 0, 0, 255],
      [255, 255, 255, 255],
    ]))
    await writeFile(inputs, JSON.stringify([{
      id: "sample",
      path: "../art/sample.png",
      tolerances,
    }]))
    return { image, inputs, baseline }
  }

  it("snapshots portable metrics and passes an unchanged image", async () => {
    const { image, inputs, baseline } = await setup()
    const raw = JSON.parse(await readFile(inputs, "utf8"))
    const resolved = resolveQualityInputs(raw, inputs)
    const snapshot = await snapshotQualityBaseline(resolved, baseline)

    expect(snapshot.baseline.cases[0]?.file).toBe("../art/sample.png")
    expect(snapshot.baseline.cases[0]?.expected).toMatchObject({
      width: 8,
      height: 8,
      colorCount: 2,
      partialAlpha: 0,
    })
    expect((await measureImageQuality(image)).meanEdgeContrast).toBeGreaterThan(0.9)
    expect((await checkQualityBaseline(baseline)).safe).toBe(true)
  })

  it("catches softened edges, palette growth, and changed structure", async () => {
    const { image, inputs, baseline } = await setup()
    const raw = JSON.parse(await readFile(inputs, "utf8"))
    await snapshotQualityBaseline(resolveQualityInputs(raw, inputs), baseline)

    await writeFile(image, verticalBands([
      [0, 0, 0, 255],
      [85, 85, 85, 255],
      [170, 170, 170, 255],
      [255, 255, 255, 255],
    ]))
    const report = await checkQualityBaseline(baseline)
    expect(report.safe).toBe(false)
    expect(report.summary.changed).toBe(1)
    expect(report.cases[0]?.violations.join("\n")).toMatch(/new color|edge density|edge contrast/)
  })

  it("catches partial-alpha edges", async () => {
    const { image, inputs, baseline } = await setup()
    const raw = JSON.parse(await readFile(inputs, "utf8"))
    await snapshotQualityBaseline(resolveQualityInputs(raw, inputs), baseline)

    const softened = verticalBands([
      [0, 0, 0, 128],
      [255, 255, 255, 255],
    ])
    await writeFile(image, softened)
    const report = await checkQualityBaseline(baseline)
    expect(report.safe).toBe(false)
    expect(report.cases[0]?.violations.join("\n")).toContain("partial-alpha pixels increased")
  })

  it("supports exact-hash gates and protects an existing baseline", async () => {
    const { image, inputs, baseline } = await setup({
      requireExactHash: true,
      maxEdgeDensityDelta: 1,
      maxEdgeContrastDrop: 1,
      maxIsolatedPixelIncrease: 1,
    })
    const raw = JSON.parse(await readFile(inputs, "utf8"))
    const resolved = resolveQualityInputs(raw, inputs)
    await snapshotQualityBaseline(resolved, baseline)

    await writeFile(image, verticalBands([
      [255, 255, 255, 255],
      [0, 0, 0, 255],
    ]))
    await expect(snapshotQualityBaseline(resolved, baseline)).rejects.toThrow(/already exists.*--force/)
    const report = await checkQualityBaseline(baseline)
    expect(report.safe).toBe(false)
    expect(report.cases[0]?.violations).toContain("image hash changed")

    const replaced = await snapshotQualityBaseline(resolved, baseline, { force: true })
    expect(replaced.changed).toBe(true)
    expect((await checkQualityBaseline(baseline)).safe).toBe(true)
  })

  it("rejects duplicate case ids before file access", () => {
    expect(() => resolveQualityInputs([
      { id: "same", path: "a.png" },
      { id: "same", path: "b.png" },
    ], path.join(dir, "inputs.json"))).toThrow(/duplicate quality case id/)
  })

  it("refuses to overwrite a measured image or record with the baseline", async () => {
    const { image, inputs } = await setup()
    const raw = JSON.parse(await readFile(inputs, "utf8"))
    const resolved = resolveQualityInputs(raw, inputs)
    await expect(snapshotQualityBaseline(resolved, image, { force: true }))
      .rejects.toThrow(/would overwrite an input/)
    expect((await measureImageQuality(image)).width).toBe(8)
  })

  it("does not mistake another artifact companion for a refinement record", async () => {
    const { image, inputs, baseline } = await setup()
    const record = path.join(dir, "art", "sample.pixelkiln.json")
    const imageBytes = await readFile(image)
    const manifest = createArtifactBundleManifest(record, [{ path: image, data: imageBytes }], {
      kind: "pack",
      sources: [],
      options: {},
    })
    await writeFile(record, JSON.stringify(manifest, null, 2) + "\n")
    const raw = [{ id: "sample", path: "../art/sample.png", record: "../art/sample.pixelkiln.json" }]
    await expect(snapshotQualityBaseline(resolveQualityInputs(raw, inputs), baseline))
      .rejects.toThrow(/not a PixelKiln refinement record/)
  })

  it("keeps the committed ComfyUI reference set inside its quality envelope", async () => {
    const report = await checkQualityBaseline(path.resolve(
      "benchmarks/provider-hires/comfyui/pixelkiln.quality-baseline.json",
    ))
    expect(report.safe).toBe(true)
    expect(report.summary).toEqual({ total: 3, passed: 3, failed: 0, changed: 0 })
  })
})
