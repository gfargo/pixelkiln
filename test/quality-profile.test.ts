import path from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { loadManifest, resolveSpecs } from "../src/manifest.ts"
import { packStyle } from "../src/pipeline/pack.ts"
import { buildPlan } from "../src/pipeline/plan.ts"
import {
  inspectQualityProfile,
  refineQualityProfiles,
  requireApprovedQualitySources,
} from "../src/pipeline/quality-profile.ts"
import { approveQualityRecord, checkQualityRecord } from "../src/pipeline/refine.ts"
import { decodePng, encodeRgbaPng } from "../src/png.ts"
import { sha256 } from "../src/hash.ts"
import type { Lock } from "../src/types.ts"

const fixture = path.resolve("test/fixtures/fake-pixelfixer.mjs")
const cli = path.resolve("node_modules/.bin/tsx")
const cliEntry = path.resolve("src/cli.ts")
const execFileAsync = promisify(execFile)
const emptyLock: Lock = { version: 2, entries: {} }

function samplePng(dark = 12): Buffer {
  return encodeRgbaPng(2, 2, Buffer.from([
    dark, 18, 24, 255,
    245, 240, 235, 255,
    70, 70, 70, 0,
    180, 180, 180, 96,
  ]))
}

describe("manifest quality profiles", () => {
  let dir: string
  let manifestPath: string

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "pixelkiln-quality-profile-"))
    manifestPath = path.join(dir, "pixelkiln.manifest.json")
    await writeFile(path.join(dir, "source.png"), samplePng())
  })

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  async function writeManifest(
    quality: Record<string, unknown> = {
      outDir: "art/final",
      palette: ["#000000", "#ffffff"],
      minGridConfidence: "high",
    },
    generator = "map",
  ) {
    await writeFile(manifestPath, JSON.stringify({
      name: "quality-test",
      styles: {
        base: { generator, size: 16, outDir: "art/raw", quality },
      },
      assets: {
        keep: { prompt: "a mountain keep", source: "source.png" },
      },
    }))
    const loaded = await loadManifest(manifestPath)
    return { loaded, specs: await resolveSpecs(loaded) }
  }

  it("resolves a separate PNG without changing paid generation identity", async () => {
    const first = await writeManifest()
    expect(first.specs[0]!.quality).toMatchObject({
      outFile: path.join(dir, "art/final/keep.png"),
      palette: ["#000000", "#ffffff"],
      minGridConfidence: "high",
    })

    const firstHash = first.specs[0]!.specHash
    const second = await writeManifest({
      outDir: "shipping/pixels",
      palette: ["#111111", "#eeeeee"],
      minGridConfidence: "medium",
      minTransparency: 0.25,
    })
    expect(second.specs[0]!.specHash).toBe(firstHash)
    expect(second.specs[0]!.quality!.outFile).toBe(path.join(dir, "shipping/pixels/keep.png"))
  })

  it("refines a configured batch and preserves a current approval on rerun", async () => {
    const { specs } = await writeManifest()
    const initialPlan = await buildPlan(specs, emptyLock)
    expect(initialPlan).toMatchObject({ cost: 0, actionable: [] })
    expect(initialPlan.items[0]).toMatchObject({
      state: "ok",
      quality: { state: "needs-refinement" },
    })

    const first = await refineQualityProfiles(specs, emptyLock, {
      fixerCommand: process.execPath,
      fixerArgsPrefix: [fixture],
    })
    expect(first).toMatchObject({ processed: 1, skipped: 0, failed: 0 })
    expect(first.items[0]).toMatchObject({ state: "needs-approval" })
    expect((await buildPlan(specs, emptyLock)).items[0]).toMatchObject({
      state: "ok",
      quality: { state: "needs-approval" },
    })

    const record = specs[0]!.quality!.outFile.replace(/\.png$/, ".pixelkiln.json")
    await approveQualityRecord(record, {
      reviewer: "Ada",
      approvedAt: new Date("2026-09-05T12:00:00.000Z"),
    })

    const second = await refineQualityProfiles(specs, emptyLock, {
      fixerCommand: process.execPath,
      fixerArgsPrefix: [fixture],
    })
    expect(second).toMatchObject({ processed: 0, skipped: 1, failed: 0 })
    expect(second.items[0]).toMatchObject({ state: "approved" })
    expect((await checkQualityRecord(record)).options.review).toMatchObject({
      status: "approved",
      reviewer: "Ada",
    })
    expect((await buildPlan(specs, emptyLock)).items[0]).toMatchObject({
      state: "ok",
      quality: { state: "approved" },
    })
  })

  it("fails packaging closed when source bytes or profile settings change", async () => {
    const first = await writeManifest()
    await refineQualityProfiles(first.specs, emptyLock, {
      fixerCommand: process.execPath,
      fixerArgsPrefix: [fixture],
    })
    const record = first.specs[0]!.quality!.outFile.replace(/\.png$/, ".pixelkiln.json")
    await approveQualityRecord(record, { reviewer: "Ada" })

    const approved = await requireApprovedQualitySources(first.specs, emptyLock)
    expect(approved).toEqual({ keep: path.join(dir, "art/final/keep.png") })
    const sheet = packStyle(emptyLock, "base", dir, { sourceOverrides: approved })
    expect(sheet.atlas.frames.map((frame) => frame.id)).toEqual(["keep"])
    expect(new Set([...decodePng(sheet.png).pixels])).toEqual(new Set([0, 96, 255]))

    await writeFile(path.join(dir, "source.png"), samplePng(30))
    expect(await inspectQualityProfile(first.specs[0]!, emptyLock)).toMatchObject({
      state: "needs-refinement",
    })
    await expect(requireApprovedQualitySources(first.specs, emptyLock)).rejects.toThrow(
      /Packaging requires current, human-approved quality output/,
    )

    await writeFile(path.join(dir, "source.png"), samplePng())
    const changed = await writeManifest({
      outDir: "art/final",
      palette: ["#111111", "#eeeeee"],
      minGridConfidence: "high",
    })
    expect(await inspectQualityProfile(changed.specs[0]!, emptyLock)).toMatchObject({
      state: "needs-refinement",
      reason: "quality profile changed",
    })
  })

  it("rejects a current approved record made from a different source path", async () => {
    const { specs } = await writeManifest()
    await writeFile(path.join(dir, "other.png"), samplePng())
    const otherSpec = { ...specs[0]!, source: "other.png" }
    await refineQualityProfiles([otherSpec], emptyLock, {
      fixerCommand: process.execPath,
      fixerArgsPrefix: [fixture],
    })
    const record = specs[0]!.quality!.outFile.replace(/\.png$/, ".pixelkiln.json")
    await approveQualityRecord(record, { reviewer: "Ada" })

    expect(await inspectQualityProfile(specs[0]!, emptyLock)).toMatchObject({
      state: "needs-refinement",
      reason: "quality profile changed",
    })
    await expect(requireApprovedQualitySources(specs, emptyLock)).rejects.toThrow(
      /Packaging requires current, human-approved quality output/,
    )
  })

  it("exposes the gate through plan/check and packages approved output through the CLI", async () => {
    const { specs } = await writeManifest()
    await refineQualityProfiles(specs, emptyLock, {
      fixerCommand: process.execPath,
      fixerArgsPrefix: [fixture],
    })
    const lockPath = path.join(dir, "pixelkiln.lock.json")
    const record = specs[0]!.quality!.outFile.replace(/\.png$/, ".pixelkiln.json")
    const common = ["--manifest", manifestPath, "--lock", lockPath]

    const planned = await execFileAsync(cli, [cliEntry, "plan", ...common, "--json"])
    expect(JSON.parse(planned.stdout).items[0]).toMatchObject({
      state: "ok",
      quality: { state: "needs-approval" },
    })
    await expect(execFileAsync(cli, [cliEntry, "refine", "check", ...common, "--json"]))
      .rejects.toMatchObject({ code: 1 })
    await expect(execFileAsync(cli, [cliEntry, "pack", ...common, "--style", "base"]))
      .rejects.toMatchObject({ code: 1 })

    await approveQualityRecord(record, { reviewer: "Ada" })
    const checked = await execFileAsync(cli, [cliEntry, "refine", "check", ...common, "--json"])
    expect(JSON.parse(checked.stdout)).toMatchObject({ safe: true })

    const out = path.join(dir, "dist/sheet")
    await execFileAsync(cli, [cliEntry, "pack", ...common, "--style", "base", "--out", out])
    expect(JSON.parse(await readFile(`${out}.json`, "utf8")).frames).toMatchObject([{ id: "keep" }])
    const provenance = JSON.parse(await readFile(`${out}.pixelkiln.json`, "utf8"))
    expect(provenance.sources).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "$quality/keep", included: true }),
      expect.objectContaining({ id: "keep", included: true }),
    ]))

    const manifest = JSON.parse(await readFile(manifestPath, "utf8"))
    manifest.styles.base.mount = {
      cellWidth: 2,
      cellHeight: 2,
      out: "dist/mounted.png",
    }
    manifest.assets.keep.cell = [0, 0]
    await writeFile(manifestPath, JSON.stringify(manifest))
    await execFileAsync(cli, [cliEntry, "mount", ...common, "--style", "base"])
    const mounted = JSON.parse(await readFile(path.join(dir, "dist/mounted.pixelkiln.json"), "utf8"))
    expect(mounted.sources).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "$quality/keep", included: true }),
      expect.objectContaining({ id: "keep", included: true }),
    ]))
  })

  it("rejects duplicate palettes, unsupported generators, and output collisions", async () => {
    await expect(writeManifest({
      outDir: "art/final",
      palette: ["#000000", "000000"],
    })).rejects.toThrow(/quality palette colors must be unique/)

    await expect(writeManifest({
      outDir: "art/final",
      palette: ["#000000", "#ffffff"],
    }, "tiles")).rejects.toThrow(/single-image generators only/)

    await expect(writeManifest({
      outDir: "art/raw",
      palette: ["#000000", "#ffffff"],
    })).rejects.toThrow(/Output collision/)
  })

  it("blocks modified raw provider output instead of refining untracked bytes", async () => {
    const { specs } = await writeManifest()
    const source = specs[0]!.outFile
    await mkdir(path.dirname(source), { recursive: true })
    await writeFile(source, samplePng())
    const lock: Lock = {
      version: 2,
      entries: {
        "base/keep": {
          styleId: "base",
          assetId: "keep",
          specHash: specs[0]!.specHash,
          generator: "map",
          tileFeature: null,
          prompt: specs[0]!.prompt,
          width: 16,
          height: 16,
          status: "downloaded",
          jobId: "job",
          objectId: "object",
          reviewObjectId: null,
          candidateIndex: null,
          error: null,
          outputs: [{ path: "art/raw/keep.png", sha256: "not-the-current-hash" }],
          provider: "pixellab",
          providerMetadata: {},
          sourceUrl: null,
          sourceUrls: [],
          submittedAt: null,
          cost: 1,
          costUnit: "generations",
          downloadedAt: null,
        },
      },
    }
    // Remove the committed-source shortcut so this spec uses the lock entry.
    const generatedSpec = { ...specs[0]!, source: undefined }
    expect(await inspectQualityProfile(generatedSpec, lock)).toMatchObject({
      state: "blocked",
      reason: "raw provider output was modified after download",
    })
  })

  it("blocks approved output when the underlying generation spec is stale", async () => {
    const { specs } = await writeManifest()
    const source = specs[0]!.outFile
    await mkdir(path.dirname(source), { recursive: true })
    const png = samplePng()
    await writeFile(source, png)
    const generatedSpec = { ...specs[0]!, source: undefined }
    const lock: Lock = {
      version: 2,
      entries: {
        "base/keep": {
          styleId: "base", assetId: "keep", specHash: generatedSpec.specHash,
          generator: "map", tileFeature: null, prompt: generatedSpec.prompt,
          width: 16, height: 16, status: "downloaded", jobId: "job", objectId: "object",
          reviewObjectId: null, candidateIndex: null, error: null,
          outputs: [{ path: "art/raw/keep.png", sha256: sha256(png) }],
          provider: "pixellab", providerMetadata: {}, sourceUrl: null, sourceUrls: [],
          submittedAt: null, downloadedAt: null, cost: 1, costUnit: "generations",
        },
      },
    }
    await refineQualityProfiles([generatedSpec], lock, {
      fixerCommand: process.execPath,
      fixerArgsPrefix: [fixture],
    })
    const record = generatedSpec.quality!.outFile.replace(/\.png$/, ".pixelkiln.json")
    await approveQualityRecord(record, { reviewer: "Ada" })

    const staleSpec = { ...generatedSpec, specHash: "changed-generation-spec" }
    expect(await inspectQualityProfile(staleSpec, lock)).toMatchObject({
      state: "blocked",
      reason: "raw provider output does not match the current generation spec",
    })
    await expect(requireApprovedQualitySources([staleSpec], lock)).rejects.toThrow(
      /Packaging requires current, human-approved quality output/,
    )
  })
})
