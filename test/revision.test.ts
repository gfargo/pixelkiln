import path from "node:path"
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { sha256 } from "../src/hash.ts"
import { loadManifest, resolveSpecs, type LoadedManifest } from "../src/manifest.ts"
import { lockKey, type Lock } from "../src/types.ts"
import { FakeProvider } from "../src/providers/fake.ts"
import { encodeRgbaPng } from "../src/png.ts"
import { buildPlan } from "../src/pipeline/plan.ts"
import { fetchAssets } from "../src/pipeline/fetch.ts"
import { poll } from "../src/pipeline/poll.ts"
import { refineQualityProfiles } from "../src/pipeline/quality-profile.ts"
import { approveQualityRecord } from "../src/pipeline/refine.ts"
import { submit } from "../src/pipeline/submit.ts"

const fixer = path.resolve("test/fixtures/fake-pixelfixer.mjs")
const cli = path.resolve("node_modules/.bin/tsx")
const cliEntry = path.resolve("src/cli.ts")
const execFileAsync = promisify(execFile)

function png(red = 20, width = 2, height = 2): Buffer {
  const pixels = Buffer.alloc(width * height * 4)
  for (let offset = 0; offset < pixels.length; offset += 4) {
    pixels[offset] = red
    pixels[offset + 1] = 40
    pixels[offset + 2] = 80
    pixels[offset + 3] = 255
  }
  return encodeRgbaPng(width, height, pixels)
}

describe("asset revisions", () => {
  let dir: string
  let manifestPath: string
  let provider: FakeProvider

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "pixelkiln-revision-"))
    manifestPath = path.join(dir, "pixelkiln.manifest.json")
    provider = new FakeProvider({ candidates: 1 })
  })

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  async function writeProject(
    revision: Record<string, unknown> = {
      mode: "image-to-image",
      from: "source",
      strength: 0.35,
    },
    options: { source?: boolean; quality?: boolean; childStyles?: string[] } = { source: true },
  ): Promise<LoadedManifest> {
    if (options.source !== false) await writeFile(path.join(dir, "source.png"), png())
    await writeFile(manifestPath, JSON.stringify({
      name: "revision-test",
      provider: "fake",
      styles: {
        base: {
          generator: "map",
          size: 16,
          outDir: "art/raw",
          ...(options.quality
            ? {
                quality: {
                  outDir: "art/final",
                  palette: ["#000000", "#ffffff"],
                  minGridConfidence: "high",
                },
              }
            : {}),
        },
      },
      assets: {
        source: {
          prompt: "a rough stone tower",
          ...(options.source === false ? {} : { source: "source.png" }),
        },
        revised: {
          prompt: "preserve the silhouette and add snow",
          width: 16,
          height: 16,
          ...(options.childStyles ? { styles: options.childStyles } : {}),
          revision,
        },
      },
    }))
    return loadManifest(manifestPath)
  }

  async function resolveChild(loaded: LoadedManifest) {
    return (await resolveSpecs(loaded, { assets: ["revised"], provider }))[0]!
  }

  it("validates references, modes, masks, and dependency cycles", async () => {
    await expect(writeProject({ mode: "image-to-image", from: "missing" }))
      .rejects.toThrow(/unknown asset "missing"/)

    await expect(writeProject({ mode: "image-to-image", from: "revised" }))
      .rejects.toThrow(/cannot revise itself/)

    await writeFile(manifestPath, JSON.stringify({
      name: "cycle",
      provider: "fake",
      styles: { base: { generator: "map", outDir: "out" } },
      assets: {
        one: { prompt: "one", revision: { mode: "image-to-image", from: "two" } },
        two: { prompt: "two", revision: { mode: "image-to-image", from: "one" } },
      },
    }))
    await expect(loadManifest(manifestPath)).rejects.toThrow(/revision cycle/)

    await expect(writeProject({ mode: "inpaint", from: "source" }))
      .rejects.toThrow(/inpaint revisions require a mask/)

    await expect(writeProject({ mode: "outpaint", from: "source", mask: "mask.png" }))
      .rejects.toThrow(/outpaint revisions do not accept a mask/)

    const loaded = await writeProject({ mode: "image-to-image", from: "source" })
    const raw = JSON.parse(await readFile(manifestPath, "utf8"))
    raw.assets.revised.source = "other.png"
    await writeFile(manifestPath, JSON.stringify(raw))
    await expect(loadManifest(loaded.path)).rejects.toThrow(/source and revision are mutually exclusive/)
  })

  it("resolves transitive inputs, hashes their bytes, and ignores their path", async () => {
    const loaded = await writeProject()
    const first = await resolveChild(loaded)
    expect(first.revision).toMatchObject({
      mode: "image-to-image",
      sourceAssetId: "source",
      sourceFile: path.join(dir, "source.png"),
      sourceSha256: sha256(png()),
      sourceWidth: 2,
      sourceHeight: 2,
      sourceFormat: "png",
      strength: 0.35,
    })

    await writeFile(path.join(dir, "source.png"), png(90))
    const changed = await resolveChild(await loadManifest(manifestPath))
    expect(changed.specHash).not.toBe(first.specHash)

    await writeFile(path.join(dir, "moved.png"), png(90))
    const raw = JSON.parse(await readFile(manifestPath, "utf8"))
    raw.assets.source.source = "moved.png"
    await writeFile(manifestPath, JSON.stringify(raw))
    const moved = await resolveChild(await loadManifest(manifestPath))
    expect(moved.specHash).toBe(changed.specHash)
  })

  it("requires a PNG mask with source dimensions and hashes mask changes", async () => {
    await writeFile(path.join(dir, "mask.png"), png(255))
    const loaded = await writeProject({
      mode: "inpaint",
      from: "source",
      mask: "mask.png",
      strength: 0.5,
    })
    const first = await resolveChild(loaded)
    expect(first.revision).toMatchObject({
      mode: "inpaint",
      maskSha256: sha256(png(255)),
      maskWidth: 2,
      maskHeight: 2,
      maskFormat: "png",
    })

    await writeFile(path.join(dir, "mask.png"), png(120))
    const changed = await resolveChild(await loadManifest(manifestPath))
    expect(changed.specHash).not.toBe(first.specHash)

    await writeFile(path.join(dir, "mask.png"), png(120, 3, 2))
    await expect(resolveChild(await loadManifest(manifestPath))).rejects.toThrow(
      /Revision mask.*3x2.*source.*2x2/,
    )

    await writeFile(path.join(dir, "mask.png"), Buffer.from("not an image"))
    await expect(resolveChild(await loadManifest(manifestPath))).rejects.toThrow(
      /revision mask is not a readable PNG or JPEG/,
    )
  })

  it("blocks a child until its generated parent is current", async () => {
    const loaded = await writeProject(undefined, { source: false })
    const firstChild = await resolveChild(loaded)
    const firstPlan = await buildPlan([firstChild], { version: 2, entries: {} })
    expect(firstPlan.items[0]).toMatchObject({ state: "blocked" })
    expect(firstPlan.actionable).toEqual([])
    expect(firstPlan.cost).toBe(0)

    const parent = (await resolveSpecs(loaded, { assets: ["source"], provider }))[0]!
    const lock: Lock = { version: 2, entries: {} }
    const lockPath = path.join(dir, "pixelkiln.lock.json")
    await submit(provider, loaded, (await buildPlan([parent], lock)).actionable, lock, lockPath, {
      spacingMs: 0,
    })
    await poll(provider, lock, lockPath, { intervalMs: 0, specs: [parent] })
    await fetchAssets(provider, [parent], lock, lockPath)

    const currentChild = await resolveChild(await loadManifest(manifestPath))
    const ready = await buildPlan([currentChild], lock)
    expect(ready.items[0]).toMatchObject({ state: "missing" })
    expect(ready.actionable).toHaveLength(1)

    await writeFile(parent.outFile, png(140))
    const changed = await buildPlan([currentChild], lock)
    expect(changed.items[0]).toMatchObject({ state: "blocked" })
    expect(changed.items[0]!.reason).toMatch(/parent output was modified/)
  })

  it("requires human-approved quality output before revising it", async () => {
    const loaded = await writeProject(undefined, { source: true, quality: true })
    const parent = (await resolveSpecs(loaded, { assets: ["source"], provider }))[0]!
    const empty: Lock = { version: 2, entries: {} }
    await refineQualityProfiles([parent], empty, {
      fixerCommand: process.execPath,
      fixerArgsPrefix: [fixer],
    })

    let child = await resolveChild(await loadManifest(manifestPath))
    expect((await buildPlan([child], empty)).items[0]).toMatchObject({ state: "blocked" })
    expect((await buildPlan([child], empty)).items[0]!.reason).toMatch(/needs-approval/)

    const record = parent.quality!.outFile.replace(/\.png$/, ".pixelkiln.json")
    await approveQualityRecord(record, { reviewer: "Revision test" })
    child = await resolveChild(await loadManifest(manifestPath))
    expect((await buildPlan([child], empty)).items[0]).toMatchObject({ state: "missing" })
    expect(child.revision!.sourceFile).toBe(parent.quality!.outFile)
  })

  it("records immutable lineage and rechecks bytes at the spending boundary", async () => {
    const loaded = await writeProject()
    let child = await resolveChild(loaded)
    const lock: Lock = { version: 2, entries: {} }
    const lockPath = path.join(dir, "pixelkiln.lock.json")
    const plan = await buildPlan([child], lock)

    await writeFile(path.join(dir, "source.png"), png(180))
    await expect(submit(provider, loaded, plan.actionable, lock, lockPath, { spacingMs: 0 }))
      .rejects.toThrow(/source changed after the manifest was resolved/)
    expect(provider.submissions).toEqual([])
    expect(lock.entries).toEqual({})

    child = await resolveChild(await loadManifest(manifestPath))
    await submit(provider, loaded, (await buildPlan([child], lock)).actionable, lock, lockPath, {
      spacingMs: 0,
    })
    expect(lock.entries[lockKey("base", "revised")]).toMatchObject({
      revision: {
        mode: "image-to-image",
        sourceAssetId: "source",
        sourceSha256: sha256(png(180)),
        strength: 0.35,
      },
      status: "processing",
    })
  })

  it("rejects a provider or style that cannot satisfy the revision", async () => {
    const loaded = await writeProject()
    loaded.manifest.provider = "pixellab"
    await expect(resolveSpecs(loaded, { assets: ["revised"] })).rejects.toThrow(
      /Provider "pixellab" does not support image-to-image revisions/,
    )

    const raw = JSON.parse(await readFile(manifestPath, "utf8"))
    raw.assets.source.styles = ["base"]
    raw.assets.revised.styles = ["other"]
    raw.styles.other = { generator: "map", outDir: "other" }
    await writeFile(manifestPath, JSON.stringify(raw))
    await expect(resolveSpecs(await loadManifest(manifestPath), {
      styles: ["other"],
      assets: ["revised"],
      provider,
    })).rejects.toThrow(/revision parents must participate in the same style/)
  })

  it("surfaces blocked lineage in CLI text and JSON without scheduling cost", async () => {
    await writeFile(path.join(dir, "workflow.json"), JSON.stringify({
      "3": { class_type: "KSampler", inputs: { denoise: 0.3 } },
      "5": { class_type: "EmptyLatentImage", inputs: { width: 16, height: 16 } },
      "6": { class_type: "CLIPTextEncode", inputs: { text: "placeholder" } },
      "9": { class_type: "SaveImage", inputs: { images: ["3", 0] } },
      "12": { class_type: "LoadImage", inputs: { image: "placeholder.png" } },
    }))
    await writeFile(manifestPath, JSON.stringify({
      name: "blocked-cli",
      provider: "comfyui",
      styles: {
        base: {
          generator: "map",
          outDir: "out",
          providerOptions: {
            comfyui: {
              workflowFile: "workflow.json",
              outputNodeId: "9",
              bindings: {
                prompt: { nodeId: "6", input: "text" },
                width: { nodeId: "5", input: "width" },
                height: { nodeId: "5", input: "height" },
                sourceImage: { nodeId: "12", input: "image" },
                strength: { nodeId: "3", input: "denoise" },
              },
            },
          },
        },
      },
      assets: {
        source: { prompt: "missing source", source: "missing.png" },
        revised: {
          prompt: "revise it",
          width: 16,
          height: 16,
          revision: { mode: "image-to-image", from: "source", strength: 0.3 },
        },
      },
    }))
    const common = [cliEntry, "plan", "--manifest", manifestPath, "--only", "revised"]
    const text = await execFileAsync(cli, common)
    expect(text.stdout).toMatch(/blocked\s+\(1\)/)
    expect(text.stdout).toContain("1 blocked")
    expect(text.stdout).toContain("nothing to generate")

    const json = await execFileAsync(cli, [...common, "--json"])
    expect(JSON.parse(json.stdout)).toMatchObject({
      totals: { blocked: 1 },
      cost: 0,
      actionable: [],
      items: [{
        key: "base/revised",
        state: "blocked",
        revision: { mode: "image-to-image", from: "source", sourceSha256: null, strength: 0.3 },
      }],
    })
  })
})
