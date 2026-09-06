import path from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { existsSync } from "node:fs"
import {
  approveQualityRecord,
  checkQualityRecord,
  quantizeToPalette,
  refineAsset,
  refineFrameSet,
} from "../src/pipeline/refine.ts"
import { decodePng, encodeRgbaPng } from "../src/png.ts"

const fixture = path.resolve("test/fixtures/fake-pixelfixer.mjs")
const palette = ["#000000", "#ffffff"]

function samplePng(): Buffer {
  return encodeRgbaPng(2, 2, Buffer.from([
    12, 18, 24, 255,
    245, 240, 235, 255,
    70, 70, 70, 0,
    180, 180, 180, 96,
  ]))
}

describe("provider-neutral refinement", () => {
  let dir: string

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "pixelkiln-refine-test-"))
  })

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it("maps visible pixels to the exact palette without dithering and preserves alpha", () => {
    const input = decodePng(samplePng())
    const result = quantizeToPalette(input, palette)

    expect([...result.pixels]).toEqual([
      0, 0, 0, 255,
      255, 255, 255, 255,
      0, 0, 0, 0,
      255, 255, 255, 96,
    ])
  })

  it("writes a checked pending record, then makes it release-ready after human approval", async () => {
    const source = path.join(dir, "source.png")
    const output = path.join(dir, "final.png")
    await writeFile(source, samplePng())

    const refined = await refineAsset({
      source,
      output,
      palette,
      fixerCommand: process.execPath,
      fixerArgsPrefix: [fixture],
    })
    expect(refined.detection).toMatchObject({
      columns: 2,
      rows: 2,
      phaseX: 0,
      phaseY: 0,
      confidence: "high",
      consensus: "fast:ac+rl(S)",
    })
    expect(refined.audit).toMatchObject({ colorCount: 2, paletteConformant: true, safe: true })
    expect(refined.record).toBe(path.join(dir, "final.pixelkiln.json"))

    const pending = await checkQualityRecord(refined.record)
    expect(pending).toMatchObject({ safe: false, current: true, approved: false, auditSafe: true })
    expect(pending.reasons).toEqual(["human 1× review is pending"])

    const approved = await approveQualityRecord(refined.record, {
      reviewer: "Ada",
      note: "Readable at native scale.",
      approvedAt: new Date("2026-09-03T20:00:00.000Z"),
    })
    expect(approved).toMatchObject({ safe: true, current: true, approved: true, auditSafe: true })
    expect(approved.options.review).toEqual({
      status: "approved",
      reviewer: "Ada",
      approvedAt: "2026-09-03T20:00:00.000Z",
      checklist: {
        nativeScale: true,
        crispEdges: true,
        subjectReadable: true,
        paletteSeparation: true,
        alphaAndSeams: true,
      },
      note: "Readable at native scale.",
    })

    await refineAsset({
      source,
      output,
      palette,
      fixerCommand: process.execPath,
      fixerArgsPrefix: [fixture],
    })
    expect(await checkQualityRecord(refined.record)).toMatchObject({
      safe: false,
      current: true,
      approved: false,
    })
  })

  it("fails closed after the source, output, or quality metadata changes", async () => {
    const source = path.join(dir, "source.png")
    const output = path.join(dir, "final.png")
    await writeFile(source, samplePng())
    const refined = await refineAsset({
      source,
      output,
      palette,
      fixerCommand: process.execPath,
      fixerArgsPrefix: [fixture],
    })
    await approveQualityRecord(refined.record, { reviewer: "Ada" })

    await writeFile(output, samplePng())
    const outputChanged = await checkQualityRecord(refined.record)
    expect(outputChanged.safe).toBe(false)
    expect(outputChanged.reasons).toContain("output changed: final.png")
    await expect(approveQualityRecord(refined.record, { reviewer: "Grace" }))
      .rejects.toThrow(/stale refinement.*output final\.png/)

    await refineAsset({
      source,
      output,
      palette,
      fixerCommand: process.execPath,
      fixerArgsPrefix: [fixture],
      force: true,
    })
    await writeFile(source, encodeRgbaPng(2, 2, Buffer.alloc(16)))
    expect((await checkQualityRecord(refined.record)).reasons).toContain("source changed: source")

    await writeFile(source, samplePng())
    const record = JSON.parse(await readFile(refined.record, "utf8"))
    record.options.nativeGrid.revision = "different"
    await writeFile(refined.record, JSON.stringify(record))
    expect((await checkQualityRecord(refined.record)).reasons)
      .toContain("quality record fingerprint changed")
  })

  it("rejects low-confidence or structurally inconsistent grid recovery", async () => {
    const low = path.join(dir, "low-confidence.png")
    const wrong = path.join(dir, "wrong-size.png")
    await writeFile(low, samplePng())
    await writeFile(wrong, samplePng())

    await expect(refineAsset({
      source: low,
      output: path.join(dir, "low-final.png"),
      palette,
      fixerCommand: process.execPath,
      fixerArgsPrefix: [fixture],
    })).rejects.toThrow(/grid confidence low is below required high/)
    expect(existsSync(path.join(dir, "low-final.png"))).toBe(false)

    await expect(refineAsset({
      source: wrong,
      output: path.join(dir, "wrong-final.png"),
      palette,
      fixerCommand: process.execPath,
      fixerArgsPrefix: [fixture],
    })).rejects.toThrow(/expected detected grid 3x2/)
  })

  it("can require transparent canvas for isolated assets", async () => {
    const source = path.join(dir, "source.png")
    await writeFile(source, samplePng())

    await expect(refineAsset({
      source,
      output: path.join(dir, "isolated.png"),
      palette,
      minTransparency: 0.75,
      fixerCommand: process.execPath,
      fixerArgsPrefix: [fixture],
    })).rejects.toThrow(/transparency 50\.0% is below 75\.0%/)
    expect(existsSync(path.join(dir, "isolated.png"))).toBe(false)
  })

  it("preserves Pixel Art Fixer's supported source-size boundary", async () => {
    const tooSmall = path.join(dir, "too-small.png")
    const tooLarge = path.join(dir, "too-large.png")
    await writeFile(tooSmall, encodeRgbaPng(15, 16, Buffer.alloc(15 * 16 * 4)))
    await writeFile(tooLarge, encodeRgbaPng(2001, 2000, Buffer.alloc(2001 * 2000 * 4)))

    await expect(refineAsset({
      source: tooSmall,
      output: path.join(dir, "small-final.png"),
      palette,
      fixerPython: "must-not-run",
    })).rejects.toThrow(/at least 16px; got 15x16/)
    await expect(refineAsset({
      source: tooLarge,
      output: path.join(dir, "large-final.png"),
      palette,
      fixerPython: "must-not-run",
    })).rejects.toThrow(/at most 4,000,000 source pixels; got 2001x2000/)
  })

  it("refines and approves an ordered frame set atomically", async () => {
    const first = path.join(dir, "pose-a.png")
    const second = path.join(dir, "pose-b.png")
    const output = path.join(dir, "final.png")
    await writeFile(first, samplePng())
    await writeFile(second, samplePng())

    const refined = await refineFrameSet({
      sources: [
        { role: "frame-00", path: first },
        { role: "frame-01", path: second },
      ],
      output,
      fps: 8,
      palette,
      fixerCommand: process.execPath,
      fixerArgsPrefix: [fixture],
    })
    expect(refined.outputs).toEqual([
      path.join(dir, "final-frame-00.png"),
      path.join(dir, "final-frame-01.png"),
    ])
    expect(refined.audit).toMatchObject({ safe: true, colorCount: 2 })
    const pending = await checkQualityRecord(refined.record)
    expect(pending).toMatchObject({ current: true, approved: false, auditSafe: true })
    expect(pending.sources).toEqual([first, second])
    expect(pending.outputs).toEqual(refined.outputs)
    expect(pending.options.frameSet).toMatchObject({
      fps: 8,
      count: 2,
      roles: ["frame-00", "frame-01"],
    })

    const approved = await approveQualityRecord(refined.record, { reviewer: "Ada" })
    expect(approved).toMatchObject({ safe: true, current: true, approved: true })
    await writeFile(refined.outputs[1]!, samplePng())
    expect((await checkQualityRecord(refined.record)).reasons).toContain(
      "output changed: final-frame-01.png",
    )
  })

  it("rejects a frame set when recovered native grids disagree", async () => {
    const first = path.join(dir, "pose.png")
    const second = path.join(dir, "different-phase.png")
    await writeFile(first, samplePng())
    await writeFile(second, samplePng())

    await expect(refineFrameSet({
      sources: [
        { role: "frame-00", path: first },
        { role: "frame-01", path: second },
      ],
      output: path.join(dir, "final.png"),
      fps: 8,
      palette,
      fixerCommand: process.execPath,
      fixerArgsPrefix: [fixture],
    })).rejects.toThrow(/Frame-set native grid mismatch/)
    expect(existsSync(path.join(dir, "final-frame-00.png"))).toBe(false)
  })

  it("protects unowned output and refuses an in-place or underspecified palette", async () => {
    const source = path.join(dir, "source.png")
    const output = path.join(dir, "final.png")
    await writeFile(source, samplePng())
    await writeFile(output, "hand drawn")

    await expect(refineAsset({
      source,
      output,
      palette,
      fixerCommand: process.execPath,
      fixerArgsPrefix: [fixture],
    })).rejects.toThrow(/modified or unowned/)
    expect(await readFile(output, "utf8")).toBe("hand drawn")

    await expect(refineAsset({ source, output: source, palette }))
      .rejects.toThrow(/source and output must be different/)
    await expect(refineAsset({ source, output, palette: ["#000000"] }))
      .rejects.toThrow(/2–256 unique colors/)
  })
})
