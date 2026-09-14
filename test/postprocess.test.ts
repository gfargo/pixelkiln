import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { existsSync } from "node:fs"
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { FakeProvider } from "../src/providers/fake.ts"
import { openProject } from "../src/project.ts"
import { buildPlan, resumeActions } from "../src/pipeline/plan.ts"
import { submit } from "../src/pipeline/submit.ts"
import { poll } from "../src/pipeline/poll.ts"
import { fetchAssets } from "../src/pipeline/fetch.ts"
import { revertGeneration } from "../src/pipeline/history.ts"
import { applyPostprocess, postprocessCurrent, postprocessFor, samePostprocess } from "../src/pipeline/postprocess.ts"
import { quantize } from "../src/palette.ts"
import { decodePng, encodeRgbaPng } from "../src/png.ts"
import { sha256 } from "../src/hash.ts"
import { MediaType } from "../src/media.ts"
import { loadManifest } from "../src/manifest.ts"
import { lockKey } from "../src/types.ts"

const BLACK = [0, 0, 0, 255]
const WHITE = [255, 255, 255, 255]
const NEAR_BLACK = [12, 9, 14, 255]
const NEAR_WHITE = [240, 244, 250, 255]
const GHOST = [90, 20, 200, 0] // transparent, with colour noise underneath

const rgba = (...pixels: number[][]) => Buffer.from(pixels.flat())
const png = (w: number, h: number, ...pixels: number[][]) => encodeRgbaPng(w, h, rgba(...pixels))
const pixelsOf = (buf: Buffer) => {
  const decoded = decodePng(buf)
  const out: number[][] = []
  for (let i = 0; i < decoded.pixels.length; i += 4) out.push([...decoded.pixels.subarray(i, i + 4)])
  return out
}

/** Provider art that is close to, but not on, a two-colour palette. */
const OFF_PALETTE = png(2, 2, NEAR_BLACK, NEAR_WHITE, GHOST, [128, 128, 128, 255])
/** Provider art that already conforms. */
const ON_PALETTE = png(2, 1, BLACK, WHITE)

class PaintedProvider extends FakeProvider {
  constructor(private bytes: Buffer) {
    super({ candidates: 1 })
  }
  paint(bytes: Buffer) { this.bytes = bytes }
  override async download(url: string): Promise<Buffer> {
    if (!url.startsWith("fake://")) throw new Error(`cannot download ${url}`)
    return Buffer.from(this.bytes)
  }
}

describe("quantize", () => {
  it("snaps visible pixels to the nearest colour, zeroes transparent ones, and counts what moved", () => {
    const { png: out, changed } = quantize(decodePng(OFF_PALETTE), ["#000000", "#ffffff"])
    const pixels = []
    for (let i = 0; i < out.pixels.length; i += 4) pixels.push([...out.pixels.subarray(i, i + 4)])
    expect(pixels[0]).toEqual(BLACK)
    expect(pixels[1]).toEqual(WHITE)
    expect(pixels[2]).toEqual([0, 0, 0, 0])
    expect(["0,0,0,255", "255,255,255,255"]).toContain(pixels[3]!.join(","))
    expect(changed).toBe(4)
  })

  it("leaves a conforming picture untouched and breaks ties toward the earlier palette entry", () => {
    expect(quantize(decodePng(ON_PALETTE), ["#000000", "#FFFFFF"]).changed).toBe(0)
    // Grey sits at the same redmean distance from two greys either side of it.
    const grey = png(1, 1, [100, 100, 100, 255])
    const a = quantize(decodePng(grey), ["#5a5a5a", "#6e6e6e"]).png.pixels
    const b = quantize(decodePng(grey), ["#6e6e6e", "#5a5a5a"]).png.pixels
    expect([...a.subarray(0, 3)]).toEqual([0x5a, 0x5a, 0x5a])
    expect([...b.subarray(0, 3)]).toEqual([0x6e, 0x6e, 0x6e])
  })

  it("refuses a palette with fewer than two colours", () => {
    expect(() => quantize(decodePng(ON_PALETTE), ["#000000", "#000000"])).toThrow(/2–256 unique/)
  })
})

describe("applyPostprocess", () => {
  const record = postprocessFor({ palette: ["#000000", "#FFFFFF", "#ffffff"], enforcePalette: true })!

  it("normalises the record and treats absent and empty alike", () => {
    expect(record.palette?.colors).toEqual(["#000000", "#ffffff"])
    expect(record.palette?.dither).toBe("none")
    expect(postprocessFor({ palette: ["#000000", "#ffffff"], enforcePalette: false })).toBeUndefined()
    expect(postprocessFor({ palette: [], enforcePalette: true })).toBeUndefined()
    expect(samePostprocess(undefined, {})).toBe(true)
    expect(samePostprocess(record, { palette: { colors: ["#000000", "#ffffff"], dither: "none", distance: "redmean" } })).toBe(true)
    expect(samePostprocess(record, { palette: { colors: ["#ffffff", "#000000"], dither: "none", distance: "redmean" } })).toBe(false)
    expect(postprocessCurrent({ postprocess: undefined }, { palette: ["#000000", "#ffffff"], enforcePalette: true })).toBe(false)
  })

  it("passes conforming PNGs and every GIF through as the provider's exact bytes", () => {
    expect(applyPostprocess(ON_PALETTE, MediaType.PNG, record)).toEqual({ bytes: ON_PALETTE, changed: false })
    const gif = Buffer.from("GIF89a-not-really")
    expect(applyPostprocess(gif, MediaType.GIF, record)).toEqual({ bytes: gif, changed: false })
    expect(applyPostprocess(OFF_PALETTE, MediaType.PNG, undefined)).toEqual({ bytes: OFF_PALETTE, changed: false })
  })

  it("re-encodes a PNG that needed snapping, deterministically", () => {
    const once = applyPostprocess(OFF_PALETTE, MediaType.PNG, record)
    const twice = applyPostprocess(OFF_PALETTE, MediaType.PNG, record)
    expect(once.changed).toBe(true)
    expect(once.bytes.equals(twice.bytes)).toBe(true)
    expect(pixelsOf(once.bytes).slice(0, 3)).toEqual([BLACK, WHITE, [0, 0, 0, 0]])
  })
})

describe("enforcePalette through the pipeline", () => {
  let dir: string
  let manifestPath: string
  const lockPathOf = () => path.join(dir, "pixelkiln.lock.json")
  const cacheDir = () => path.join(dir, ".pixelkiln", "cache")

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "pixelkiln-postprocess-"))
    manifestPath = path.join(dir, "pixelkiln.manifest.json")
  })
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  async function writeManifest(enforcePalette: boolean, palette = ["#000000", "#ffffff"]) {
    await writeFile(manifestPath, JSON.stringify({
      name: "palette-test",
      styles: { base: { generator: "map", outDir: "out", promptSuffix: "two tone", palette, enforcePalette } },
      assets: { anvil: { prompt: "an anvil", width: 16, height: 16 } },
    }))
  }

  async function generate(provider: FakeProvider) {
    const project = await openProject(manifestPath, { env: false })
    const plan = await project.plan()
    await submit(provider, project.loaded, plan.actionable, project.lock, project.lockPath, { spacingMs: 0 })
    await poll(provider, project.lock, project.lockPath, { intervalMs: 0, specs: project.specs })
    const result = await fetchAssets(provider, project.specs, project.lock, project.lockPath)
    return { project, result }
  }

  const outFile = () => path.join(dir, "out", "anvil.png")
  const entryOf = async () => (await openProject(manifestPath, { env: false })).lock.entries[lockKey("base", "anvil")]!

  it("snaps the download, records the raw hash and the palette, and caches both", async () => {
    await writeManifest(true)
    const provider = new PaintedProvider(OFF_PALETTE)
    const { result } = await generate(provider)
    expect(result).toMatchObject({ downloaded: 1, failed: 0 })

    const written = await readFile(outFile())
    expect(pixelsOf(written).slice(0, 3)).toEqual([BLACK, WHITE, [0, 0, 0, 0]])
    const entry = await entryOf()
    expect(entry.postprocess).toEqual({ palette: { colors: ["#000000", "#ffffff"], dither: "none", distance: "redmean" } })
    expect(entry.outputs[0]).toMatchObject({ sha256: sha256(written), raw: sha256(OFF_PALETTE) })
    const cached = await readdir(cacheDir())
    expect(cached).toContain(`${sha256(OFF_PALETTE)}.png`)
    expect(cached).toContain(`${sha256(written)}.png`)

    const project = await openProject(manifestPath, { env: false })
    expect((await project.plan()).items[0]).toMatchObject({ state: "ok" })
  })

  it("keeps a provider's already-conforming bytes exactly, with no raw hash", async () => {
    await writeManifest(true)
    await generate(new PaintedProvider(ON_PALETTE))
    const entry = await entryOf()
    expect((await readFile(outFile())).equals(ON_PALETTE)).toBe(true)
    expect(entry.outputs[0]!.raw).toBeUndefined()
    expect(entry.postprocess?.palette?.colors).toEqual(["#000000", "#ffffff"])
  })

  it("turning enforcement on or off is recoverable and re-applied by fetch for free", async () => {
    await writeManifest(false)
    const provider = new PaintedProvider(OFF_PALETTE)
    await generate(provider)
    expect((await readFile(outFile())).equals(OFF_PALETTE)).toBe(true)
    const downloadsBefore = provider.submissions.length

    // On: plan flags it, resume points at fetch, and fetch snaps from the file on disk.
    await writeManifest(true)
    let project = await openProject(manifestPath, { env: false })
    expect((await project.plan()).items[0]).toMatchObject({ state: "recoverable", reason: expect.stringContaining("turned on") })
    expect(resumeActions(project.specs, project.lock)).toEqual([{ command: "fetch", keys: ["base/anvil"] }])
    expect((await project.plan()).actionable).toHaveLength(0)
    const on = await fetchAssets(provider, project.specs, project.lock, project.lockPath)
    expect(on).toMatchObject({ downloaded: 1, failed: 0 })
    const snapped = await readFile(outFile())
    expect(pixelsOf(snapped)[0]).toEqual(BLACK)
    let entry = await entryOf()
    expect(entry.outputs[0]).toMatchObject({ sha256: sha256(snapped), raw: sha256(OFF_PALETTE) })
    expect(entry.postprocess?.palette?.colors).toHaveLength(2)
    project = await openProject(manifestPath, { env: false })
    expect((await project.plan()).items[0]).toMatchObject({ state: "ok" })

    // Off: the provider's bytes come back from the cache, and the record clears.
    await writeManifest(false)
    project = await openProject(manifestPath, { env: false })
    expect((await project.plan()).items[0]).toMatchObject({ state: "recoverable", reason: expect.stringContaining("turned off") })
    await fetchAssets(provider, project.specs, project.lock, project.lockPath)
    expect((await readFile(outFile())).equals(OFF_PALETTE)).toBe(true)
    entry = await entryOf()
    expect(entry.outputs[0]!.raw).toBeUndefined()
    expect(entry.postprocess).toBeUndefined()
    expect(JSON.parse(await readFile(lockPathOf(), "utf8")).entries["base/anvil"]).not.toHaveProperty("postprocess")

    // Nothing above asked the provider for anything.
    expect(provider.submissions.length).toBe(downloadsBefore)
  })

  it("restore reproduces the snapped bytes from the raw cache, and from the provider when the cache is gone", async () => {
    await writeManifest(true)
    const provider = new PaintedProvider(OFF_PALETTE)
    await generate(provider)
    const recorded = (await entryOf()).outputs[0]!

    await rm(outFile())
    await rm(path.join(cacheDir(), `${recorded.sha256}.png`))
    let project = await openProject(manifestPath, { env: false })
    expect((await project.plan()).items[0]).toMatchObject({ state: "orphaned" })
    await fetchAssets(provider, project.specs, project.lock, project.lockPath, { repair: true })
    expect(sha256(await readFile(outFile()))).toBe(recorded.sha256)

    await rm(outFile())
    await rm(cacheDir(), { recursive: true, force: true })
    project = await openProject(manifestPath, { env: false })
    const repaired = await fetchAssets(provider, project.specs, project.lock, project.lockPath, { repair: true })
    expect(repaired).toMatchObject({ downloaded: 1, failed: 0 })
    expect(sha256(await readFile(outFile()))).toBe(recorded.sha256)
    expect((await entryOf()).outputs[0]).toMatchObject({ sha256: recorded.sha256, raw: recorded.raw })
  })

  it("refresh compares the provider's bytes against the raw hash, not the snapped one", async () => {
    await writeManifest(true)
    const provider = new PaintedProvider(OFF_PALETTE)
    await generate(provider)
    const snapped = await readFile(outFile())

    let project = await openProject(manifestPath, { env: false })
    const same = await fetchAssets(provider, project.specs, project.lock, project.lockPath, { refresh: true })
    expect(same).toMatchObject({ unchanged: 1, downloaded: 0 })
    expect((await readFile(outFile())).equals(snapped)).toBe(true)

    // The object changed upstream: the new bytes are snapped like the first ones.
    provider.paint(png(2, 2, NEAR_WHITE, NEAR_BLACK, NEAR_BLACK, NEAR_WHITE))
    project = await openProject(manifestPath, { env: false })
    const changed = await fetchAssets(provider, project.specs, project.lock, project.lockPath, { refresh: true })
    expect(changed).toMatchObject({ downloaded: 1, unchanged: 0 })
    expect(pixelsOf(await readFile(outFile()))).toEqual([WHITE, BLACK, BLACK, WHITE])
  })

  it("leaves a hand-changed file alone when enforcement changes, unless forced", async () => {
    await writeManifest(false)
    const provider = new PaintedProvider(OFF_PALETTE)
    await generate(provider)
    await writeFile(outFile(), png(2, 2, WHITE, WHITE, WHITE, WHITE))
    await writeManifest(true)
    const project = await openProject(manifestPath, { env: false })
    expect((await project.plan()).items[0]).toMatchObject({ state: "orphaned", reason: "output modified since download" })
    expect(await fetchAssets(provider, project.specs, project.lock, project.lockPath)).toMatchObject({ downloaded: 0, failed: 0 })
    expect(pixelsOf(await readFile(outFile()))[0]).toEqual(WHITE)
    await fetchAssets(provider, project.specs, project.lock, project.lockPath, { repair: true, force: true })
    expect(pixelsOf(await readFile(outFile()))[0]).toEqual(BLACK)
  })

  it("keeps the palette record with a retired generation and brings it back on revert", async () => {
    await writeManifest(true)
    const provider = new PaintedProvider(OFF_PALETTE)
    await generate(provider)
    const first = (await entryOf()).outputs[0]!

    // Regenerate with different provider bytes; the first generation retires with its record.
    provider.paint(png(2, 2, NEAR_WHITE, NEAR_WHITE, NEAR_BLACK, NEAR_BLACK))
    let project = await openProject(manifestPath, { env: false })
    const plan = await buildPlan(project.specs, project.lock, { force: true })
    await submit(provider, project.loaded, plan.actionable, project.lock, project.lockPath, { spacingMs: 0 })
    await poll(provider, project.lock, project.lockPath, { intervalMs: 0, specs: project.specs })
    await fetchAssets(provider, project.specs, project.lock, project.lockPath)
    let entry = await entryOf()
    expect(entry.history).toHaveLength(1)
    expect(entry.history![0]).toMatchObject({ postprocess: { palette: { colors: ["#000000", "#ffffff"] } }, outputs: [first] })

    project = await openProject(manifestPath, { env: false })
    const reverted = await revertGeneration(provider, project.specs[0]!, project.lock, project.lockPath, { generation: 1 })
    expect(reverted.index).toBe(1)
    expect(sha256(await readFile(outFile()))).toBe(first.sha256)
    entry = await entryOf()
    expect(entry.postprocess?.palette?.colors).toEqual(["#000000", "#ffffff"])
    expect(entry.outputs[0]).toMatchObject({ sha256: first.sha256, raw: first.raw })
  })

  it("does not put enforcement in the spec hash, and refuses it without a palette", async () => {
    await writeManifest(false)
    const off = (await openProject(manifestPath, { env: false })).specs[0]!.specHash
    await writeManifest(true)
    expect((await openProject(manifestPath, { env: false })).specs[0]!.specHash).toBe(off)
    await writeManifest(true, [])
    await expect(loadManifest(manifestPath)).rejects.toThrow(/enforcePalette needs a palette/)
    expect(existsSync(manifestPath)).toBe(true)
  })
})
