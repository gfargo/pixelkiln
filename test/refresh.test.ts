import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { FakeProvider, FAKE_PNG } from "../src/providers/fake.ts"
import { pixelLabObjectUrl } from "../src/providers/pixellab.ts"
import { loadManifest, resolveSpecs } from "../src/manifest.ts"
import { buildPlan } from "../src/pipeline/plan.ts"
import { submit } from "../src/pipeline/submit.ts"
import { poll } from "../src/pipeline/poll.ts"
import { fetchAssets } from "../src/pipeline/fetch.ts"
import { loadLock, saveLock, upsert } from "../src/lock.ts"
import { sha256 } from "../src/hash.ts"
import { encodeRgbaPng } from "../src/png.ts"
import { createGenerateHandlers, type GenerateJob, type GalleryGenerateHandlers } from "../src/gallery/generate.ts"
import { buildGallerySnapshot } from "../src/gallery/snapshot.ts"
import { parseArgs } from "../src/cli/args.ts"
import { normalizeLockOutputPaths } from "../src/outputs.ts"
import { lockKey, type Lock } from "../src/types.ts"
import { openProject } from "../src/project.ts"
import { registerProvider } from "../src/providers/registry.ts"
import { adoptCharacters } from "../src/pipeline/adopt-characters.ts"

let dir: string
let lockPath: string
beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "pixelkiln-refresh-"))
  lockPath = path.join(dir, "pixelkiln.lock.json")
})
afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

/** A provider whose objects can be "edited upstream" between downloads. */
class EditableProvider extends FakeProvider {
  readonly replaced = new Map<string, Buffer>()
  override async download(url: string): Promise<Buffer> {
    return this.replaced.get(url) ?? super.download(url)
  }
}

async function generated() {
  const manifestPath = path.join(dir, "pixelkiln.manifest.json")
  await writeFile(manifestPath, JSON.stringify({
    name: "refresh",
    styles: { base: { generator: "map", outDir: "out", promptSuffix: "clean" } },
    assets: { anvil: { prompt: "an anvil", width: 32, height: 32 }, hammer: { prompt: "a hammer", width: 32, height: 32 } },
  }))
  const loaded = await loadManifest(manifestPath)
  const specs = await resolveSpecs(loaded)
  const provider = new EditableProvider({ candidates: 1 })
  const lock: Lock = { version: 2, entries: {} }
  await submit(provider, loaded, (await buildPlan(specs, lock)).actionable, lock, lockPath, { spacingMs: 0 })
  await poll(provider, lock, lockPath, { intervalMs: 0 })
  await fetchAssets(provider, specs, lock, lockPath, { cacheDir: false })
  await saveLock(lockPath, lock)
  return { manifestPath, loaded, specs, provider, lock }
}

const edited = encodeRgbaPng(2, 2, Buffer.from([255, 0, 0, 255, 255, 0, 0, 255, 255, 0, 0, 255, 255, 0, 0, 255]))

describe("fetch --refresh", () => {
  it("replaces only files whose object changed upstream, and records the new bytes", async () => {
    const { specs, provider, lock } = await generated()
    const anvilFile = path.join(dir, "out", "anvil.png")
    const hammerFile = path.join(dir, "out", "hammer.png")
    const before = { anvil: await readFile(anvilFile), hammer: await readFile(hammerFile) }
    const recordedAt = lock.entries["base/anvil"]!.downloadedAt

    // Nothing changed upstream: every object is re-downloaded and found current.
    const same = await fetchAssets(provider, specs, lock, lockPath, { refresh: true, cacheDir: false })
    expect(same).toEqual({ downloaded: 0, skipped: 0, failed: 0, unchanged: 2 })
    expect(await readFile(anvilFile)).toEqual(before.anvil)

    // The anvil is edited in the provider's editor.
    provider.replaced.set(lock.entries["base/anvil"]!.sourceUrl!, edited)
    const changed = await fetchAssets(provider, specs, lock, lockPath, { refresh: true, cacheDir: false })
    expect(changed).toEqual({ downloaded: 1, skipped: 0, failed: 0, unchanged: 1 })
    expect(await readFile(anvilFile)).toEqual(edited)
    expect(await readFile(hammerFile)).toEqual(before.hammer)
    const entry = (await loadLock(lockPath)).entries["base/anvil"]!
    expect(entry.outputs[0]!.sha256).toBe(sha256(edited))
    expect(entry.status).toBe("downloaded")
    expect(entry.downloadedAt).not.toBe(recordedAt)
    // The sequence is a plain download in the record; plan agrees the work is current.
    const plan = await buildPlan(specs, await loadLock(lockPath))
    expect(plan.items.map((item) => [item.key, item.state])).toEqual([["base/anvil", "ok"], ["base/hammer", "ok"]])
  })

  it("never overwrites a locally modified file without --force", async () => {
    const { specs, provider, lock } = await generated()
    const hammerFile = path.join(dir, "out", "hammer.png")
    const local = encodeRgbaPng(1, 1, Buffer.from([0, 0, 255, 255]))
    await writeFile(hammerFile, local)
    provider.replaced.set(lock.entries["base/hammer"]!.sourceUrl!, edited)

    const refused = await fetchAssets(provider, specs, lock, lockPath, { refresh: true, cacheDir: false })
    expect(refused).toMatchObject({ downloaded: 0, failed: 1, unchanged: 1 })
    expect(await readFile(hammerFile)).toEqual(local)
    expect(lock.entries["base/hammer"]!.error).toMatch(/refusing to overwrite modified output/)

    const forced = await fetchAssets(provider, specs, lock, lockPath, { refresh: true, force: true, cacheDir: false })
    expect(forced).toMatchObject({ downloaded: 1, failed: 0 })
    expect(await readFile(hammerFile)).toEqual(edited)
  })

  it("skips entries with no durable source and leaves regular fetch untouched", async () => {
    const { specs, provider, lock } = await generated()
    upsert(lock, lockKey("base", "anvil"), { sourceUrl: null, sourceUrls: [] })
    provider.replaced.set(`fake://${lock.entries["base/hammer"]!.objectId}.png`, edited)
    const res = await fetchAssets(provider, specs, lock, lockPath, { refresh: true, cacheDir: false })
    expect(res).toEqual({ downloaded: 1, skipped: 0, failed: 0, unchanged: 0 })
    // A plain fetch of downloaded work still does nothing.
    const plain = await fetchAssets(provider, specs, lock, lockPath, { cacheDir: false })
    expect(plain).toEqual({ downloaded: 0, skipped: 0, failed: 0 })
    expect(parseArgs(["fetch", "--refresh", "--only", "anvil"])).toMatchObject({ command: "fetch", refresh: true })
  })
})

/** A provider whose character URLs rotate the way PixelLab's do (`?t=<edit time>`). */
class RotatingProvider extends FakeProvider {
  /** When set, a rotated URL serves the same bytes as before: only the stamp moved. */
  stableBytes = false
  override async download(url: string): Promise<Buffer> {
    return super.download(this.stableBytes ? url.replace(/\?t=\d+$/, "") : url)
  }
  /** Stamp every URL of a character (and one animation group, if named) with a new edit time. */
  stamp(id: string, t: number, groupId?: string) {
    const c = this.characters.get(id)!
    const restamp = (url: string) => url.replace(/(\?t=\d+)?$/, `?t=${t}`)
    c.rotations = c.rotations.map((r) => ({ ...r, url: restamp(r.url) }))
    c.previewUrl = c.rotations[0]!.url
    for (const a of c.animations) if (a.groupId === groupId) a.frames = a.frames.map(restamp)
  }
}

const DIRS8 = ["south", "south-east", "east", "north-east", "north", "north-west", "west", "south-west"]

let rotating: RotatingProvider
registerProvider({ id: "fake", create: () => rotating })

async function cast() {
  const provider = (rotating = new RotatingProvider({ candidates: 1 }))
  const rotations = (id: string) => DIRS8.map((direction) => ({ url: `fake://${id}/${direction}.png`, role: direction }))
  provider.characters.set("char-hero", {
    id: "char-hero", name: "hero", stateName: "Idle", prompt: "a hero", groupId: "grp-hero", directions: 8, width: 92, height: 92,
    createdAt: "2026-09-01T00:00:00.000Z", previewUrl: "fake://char-hero/south.png", tags: [], status: "completed", animationCount: 1,
    rotations: rotations("char-hero"),
    animations: [{ groupId: "grp-walk", name: null, type: "walk", direction: "south", frames: [0, 1, 2, 3].map((i) => `fake://char-hero/animations/anim-1/south/${i}.png`) }],
  })
  const manifestPath = path.join(dir, "pixelkiln.manifest.json")
  await writeFile(manifestPath, JSON.stringify({
    name: "cast",
    provider: "fake",
    styles: { cast: { generator: "character", outDir: "art", size: 64 } },
    assets: {
      hero: { prompt: "a hero", remoteId: "char-hero" },
      "hero.walk": { prompt: "", animation: { of: "hero", template: "walk" }, remoteId: "char-hero#grp-walk" },
    },
  }))
  const project = await openProject(manifestPath, { env: false })
  const adopted = await adoptCharacters(provider, project.specs, project.lock, project.lockPath, { resolve: () => resolveSpecs(project.loaded), noCache: true })
  expect(adopted).toMatchObject({ matched: 2, unmatched: [] })
  const fresh = await openProject(manifestPath, { env: false })
  return { provider, specs: fresh.specs, lock: fresh.lock }
}

describe("fetch --refresh for characters", () => {
  it("asks for the character's current URLs and replaces every direction that changed", async () => {
    const { provider, specs, lock } = await cast()
    const south = path.join(dir, "art", "hero-south.png")
    const before = await readFile(south)
    const same = await fetchAssets(provider, specs, lock, lockPath, { refresh: true, cacheDir: false })
    expect(same).toEqual({ downloaded: 0, skipped: 0, failed: 0, unchanged: 2 })

    // Edited in PixelLab's editor: the rotations are re-rendered under a new stamp.
    provider.stamp("char-hero", 2)
    const changed = await fetchAssets(provider, specs, lock, lockPath, { refresh: true, cacheDir: false })
    expect(changed).toEqual({ downloaded: 1, skipped: 0, failed: 0, unchanged: 1 })
    expect(await readFile(south)).not.toEqual(before)
    const entry = (await loadLock(lockPath)).entries["cast/hero"]!
    expect(entry.sourceUrls!.map((s) => s.url)).toEqual(DIRS8.map((d) => `fake://char-hero/${d}.png?t=2`))
    expect(entry.outputs.map((o) => o.role)).toEqual(DIRS8)
    expect(entry.status).toBe("downloaded")
  })

  it("keeps a moved stamp for unchanged bytes without touching the download time", async () => {
    const { provider, specs, lock } = await cast()
    provider.stableBytes = true
    const recordedAt = lock.entries["cast/hero"]!.downloadedAt
    provider.stamp("char-hero", 3, "grp-walk")
    const res = await fetchAssets(provider, specs, lock, lockPath, { refresh: true, cacheDir: false })
    expect(res).toEqual({ downloaded: 0, skipped: 0, failed: 0, unchanged: 2 })
    const saved = await loadLock(lockPath)
    expect(saved.entries["cast/hero"]!.sourceUrls![0]!.url).toBe("fake://char-hero/south.png?t=3")
    expect(saved.entries["cast/hero"]!.downloadedAt).toBe(recordedAt)
    expect(saved.entries["cast/hero.walk"]!.sourceUrls!.map((s) => s.url)).toEqual([0, 1, 2, 3].map((i) => `fake://char-hero/animations/anim-1/south/${i}.png?t=3`))
  })

  it("refreshes an animation's frames by its group and fails an entry whose character is gone", async () => {
    const { provider, specs, lock } = await cast()
    const frame = path.join(dir, "art", "hero.walk-frame-02.png")
    const before = await readFile(frame)
    provider.stamp("char-hero", 4, "grp-walk")
    provider.stableBytes = false
    const res = await fetchAssets(provider, specs, lock, lockPath, { refresh: true, cacheDir: false })
    expect(res).toEqual({ downloaded: 2, skipped: 0, failed: 0, unchanged: 0 })
    expect(await readFile(frame)).not.toEqual(before)

    provider.characters.delete("char-hero")
    const gone = await fetchAssets(provider, specs, lock, lockPath, { refresh: true, cacheDir: false })
    expect(gone).toEqual({ downloaded: 0, skipped: 0, failed: 2, unchanged: 0 })
    expect(lock.entries["cast/hero"]).toMatchObject({ status: "download-failed", error: "download failed: char-hero no longer exists upstream" })
    expect(lock.entries["cast/hero.walk"]!.error).toBe("download failed: char-hero#grp-walk no longer exists upstream")
  })
})

describe("upstream objects in the gallery", () => {
  it("links PixelLab objects and marks refreshable work", async () => {
    expect(pixelLabObjectUrl("map", "abc")).toBe("https://www.pixellab.ai/create-object/abc")
    expect(pixelLabObjectUrl("1dir", "a b")).toBe("https://www.pixellab.ai/create-object/a%20b")
    expect(pixelLabObjectUrl("tiles", "set-1")).toBe("https://www.pixellab.ai/maps/tiles/set-1")
    expect(pixelLabObjectUrl("tiles", "set-1#3")).toBe("https://www.pixellab.ai/maps/tiles/set-1")
    expect(pixelLabObjectUrl("pixflux", "abc")).toBeNull()
    expect(pixelLabObjectUrl("map", null)).toBeNull()

    const { loaded, specs, lock } = await generated()
    // Pretend the anvil came from PixelLab, as a real lock would record it.
    upsert(lock, lockKey("base", "anvil"), { provider: "pixellab", objectId: "obj-42" })
    const { snapshot } = await buildGallerySnapshot({ loaded, specs, lock, lockPath })
    const anvil = snapshot.items.find((item) => item.key === "base/anvil")!
    expect(anvil.upstreamUrl).toBe("https://www.pixellab.ai/create-object/obj-42")
    expect(anvil.refreshable).toBe(true)
    const hammer = snapshot.items.find((item) => item.key === "base/hammer")!
    expect(hammer.upstreamUrl).toBeNull()
    expect(hammer.refreshable).toBe(true)
    const sketchless = snapshot.items.find((item) => item.key === "base/anvil")!
    upsert(lock, lockKey("base", "hammer"), { sourceUrl: null, sourceUrls: [] })
    const again = await buildGallerySnapshot({ loaded, specs, lock, lockPath })
    expect(again.snapshot.items.find((item) => item.key === "base/hammer")!.refreshable).toBe(false)
    void sketchless
  })

  it("runs a refresh job at no cost", async () => {
    const { manifestPath, provider, lock } = await generated()
    provider.replaced.set(lock.entries["base/anvil"]!.sourceUrl!, edited)
    const loadProject = async () => {
      const loaded = await loadManifest(manifestPath)
      const specs = await resolveSpecs(loaded)
      const fresh = await loadLock(lockPath)
      normalizeLockOutputPaths(fresh, specs)
      return { loaded, specs, lock: fresh, lockPath }
    }
    const handlers: GalleryGenerateHandlers = createGenerateHandlers({
      loadProject,
      providerFor: () => provider,
      budget: { amount: 0, byProvider: {} },
      reload: async () => { const ctx = await loadProject(); return buildGallerySnapshot({ loaded: ctx.loaded, specs: ctx.specs, lock: ctx.lock, lockPath }) },
      pollIntervalMs: 0,
    })
    await expect(handlers.start({ keys: ["base/anvil"], refresh: true, resume: true })).rejects.toThrow(/exclusive/)
    const job = await handlers.start({ keys: ["base/anvil", "base/hammer"], refresh: true })
    expect(job.mode).toBe("refresh")
    let done: GenerateJob = job
    for (let i = 0; i < 300 && done.phase !== "done" && done.phase !== "failed"; i++) {
      await new Promise((resolve) => setTimeout(resolve, 10))
      done = handlers.status().jobs.find((candidate) => candidate.id === job.id)!
    }
    expect(done).toMatchObject({ phase: "done", spent: {}, counts: { submitted: 0, downloaded: 1 } })
    expect(done.messages.join("\n")).toMatch(/1 changed upstream and replaced, 1 unchanged/)
    expect(await readFile(path.join(dir, "out", "anvil.png"))).toEqual(edited)
    expect(handlers.status().spent).toEqual({})
  })
})
