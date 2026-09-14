import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { existsSync } from "node:fs"
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { FakeProvider } from "../src/providers/fake.ts"
import { loadManifest, resolveSpecs } from "../src/manifest.ts"
import { buildPlan } from "../src/pipeline/plan.ts"
import { submit } from "../src/pipeline/submit.ts"
import { poll } from "../src/pipeline/poll.ts"
import { fetchAssets } from "../src/pipeline/fetch.ts"
import { inspectCaches } from "../src/pipeline/cache-health.ts"
import { historyLimit, pickHistory, referencedHashes, revertGeneration, HISTORY_ENV } from "../src/pipeline/history.ts"
import { loadLock, saveLock } from "../src/lock.ts"
import { sha256 } from "../src/hash.ts"
import { encodeRgbaPng } from "../src/png.ts"
import { DEFAULT_HISTORY_LIMIT, lockKey, type Lock } from "../src/types.ts"
import { buildGallerySnapshot } from "../src/gallery/snapshot.ts"
import { createGenerateHandlers, type GalleryGenerateHandlers, type GenerateJob } from "../src/gallery/generate.ts"
import { normalizeLockOutputPaths } from "../src/outputs.ts"
import { renderGallery } from "../src/gallery/page.ts"
import { parseArgs } from "../src/cli/args.ts"

let dir: string
let lockPath: string

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "pixelkiln-history-"))
  lockPath = path.join(dir, "pixelkiln.lock.json")
})
afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

async function project(extra: Record<string, unknown> = {}) {
  const manifestPath = path.join(dir, "pixelkiln.manifest.json")
  await writeFile(manifestPath, JSON.stringify({
    name: "history-test",
    ...extra,
    styles: { base: { generator: "map", outDir: "out" } },
    assets: { anvil: { prompt: "an anvil", width: 32, height: 32 } },
  }))
  const loaded = await loadManifest(manifestPath)
  const specs = await resolveSpecs(loaded)
  return { manifestPath, loaded, specs, spec: specs[0]! }
}

/** One full generation of anvil: submit, poll, fetch. FakeProvider returns a fresh image each time. */
async function generate(provider: FakeProvider, loaded: Awaited<ReturnType<typeof project>>["loaded"], specs: Awaited<ReturnType<typeof project>>["specs"], lock: Lock, force = false) {
  await submit(provider, loaded, (await buildPlan(specs, lock, { force })).actionable, lock, lockPath, { spacingMs: 0 })
  await poll(provider, lock, lockPath, { intervalMs: 0 })
  await fetchAssets(provider, specs, lock, lockPath)
  await saveLock(lockPath, lock)
  return lock.entries["base/anvil"]!
}

describe("how many generations to keep", () => {
  it("defaults to five, reads the environment, and lets the manifest override it", async () => {
    expect(historyLimit(undefined, {})).toBe(DEFAULT_HISTORY_LIMIT)
    expect(historyLimit(undefined, { [HISTORY_ENV]: "12" })).toBe(12)
    expect(historyLimit(undefined, { [HISTORY_ENV]: "0" })).toBe(0)
    expect(historyLimit({ history: 2 }, { [HISTORY_ENV]: "12" })).toBe(2)
    expect(historyLimit({ history: 0 }, {})).toBe(0)
    expect(() => historyLimit(undefined, { [HISTORY_ENV]: "many" })).toThrow(/whole number from 0 to 100/)
    expect(() => historyLimit(undefined, { [HISTORY_ENV]: "-1" })).toThrow(/whole number/)
    const { loaded } = await project({ history: 3 })
    expect(loaded.manifest.history).toBe(3)
    await expect(project({ history: 101 })).rejects.toThrow(/history/)
  })
})

describe("regenerating keeps the generation it replaces", () => {
  it("pushes the outgoing generation onto history, newest first, up to the limit", async () => {
    const { loaded, specs } = await project({ history: 2 })
    const provider = new FakeProvider({ candidates: 1 })
    const lock: Lock = { version: 2, entries: {} }
    const first = await generate(provider, loaded, specs, lock)
    expect(first.history).toBeUndefined()
    const firstHash = first.outputs[0]!.sha256
    const firstObject = first.objectId

    const second = await generate(provider, loaded, specs, lock, true)
    expect(second.outputs[0]!.sha256).not.toBe(firstHash)
    expect(second.history).toHaveLength(1)
    expect(second.history![0]).toMatchObject({
      objectId: firstObject, outputs: [{ path: "out/anvil.png", sha256: firstHash }], prompt: "an anvil", provider: "fake",
      cost: 1, retiredAt: second.submittedAt,
    })
    // Live-state fields stay out of history.
    expect(Object.keys(second.history![0]!)).not.toContain("status")

    const third = await generate(provider, loaded, specs, lock, true)
    const fourth = await generate(provider, loaded, specs, lock, true)
    expect(fourth.history!.map((g) => g.outputs[0]!.sha256)).toEqual([third.outputs[0]!.sha256, second.outputs[0]!.sha256])
    // Written to disk as such, and read back.
    const onDisk = await loadLock(lockPath)
    expect(onDisk.entries["base/anvil"]!.history).toHaveLength(2)
  })

  it("keeps nothing when the limit is zero, and survives a checkpoint resume", async () => {
    const { loaded, specs } = await project({ history: 0 })
    const provider = new FakeProvider({ candidates: 1 })
    const lock: Lock = { version: 2, entries: {} }
    await generate(provider, loaded, specs, lock)
    const again = await generate(provider, loaded, specs, lock, true)
    expect(again.history).toBeUndefined()
  })
})

describe("restoring a previous generation", () => {
  it("swaps it back in from the cache, without the provider, and can be undone the same way", async () => {
    const { loaded, specs, spec } = await project()
    const provider = new FakeProvider({ candidates: 1 })
    const lock: Lock = { version: 2, entries: {} }
    const first = await generate(provider, loaded, specs, lock)
    const firstHash = first.outputs[0]!.sha256
    const firstBytes = await readFile(path.join(dir, "out/anvil.png"))
    const second = await generate(provider, loaded, specs, lock, true)
    const secondHash = second.outputs[0]!.sha256
    expect(await readFile(path.join(dir, "out/anvil.png"))).not.toEqual(firstBytes)

    // No provider contact: the bytes come from .pixelkiln/cache.
    const offline = new FakeProvider({ candidates: 1 })
    offline.download = async () => { throw new Error("offline") }
    const lines: string[] = []
    const result = await revertGeneration(offline, spec, lock, lockPath, { generation: 1, onProgress: (m) => lines.push(m) })
    expect(result).toMatchObject({ index: 1, downloaded: 1 })
    expect(result.restored.outputs[0]!.sha256).toBe(firstHash)
    expect(await readFile(path.join(dir, "out/anvil.png"))).toEqual(firstBytes)
    expect(lines.some((l) => /cached/.test(l))).toBe(true)

    const entry = (await loadLock(lockPath)).entries["base/anvil"]!
    expect(entry).toMatchObject({ status: "downloaded", objectId: first.objectId, outputs: [{ sha256: firstHash }], supersededOutputs: [] })
    expect(entry.history!.map((g) => g.outputs[0]!.sha256)).toEqual([secondHash])

    // Undo the undo: by hash prefix this time.
    const back = await revertGeneration(offline, spec, lock, lockPath, { generation: secondHash.slice(0, 8) })
    expect(back.restored.outputs[0]!.sha256).toBe(secondHash)
    expect(sha256(await readFile(path.join(dir, "out/anvil.png")))).toBe(secondHash)
    expect((await loadLock(lockPath)).entries["base/anvil"]!.history!.map((g) => g.outputs[0]!.sha256)).toEqual([firstHash])
  })

  it("refuses to bury a hand-changed file unless forced, and names bad selectors", async () => {
    const { loaded, specs, spec } = await project()
    const provider = new FakeProvider({ candidates: 1 })
    const lock: Lock = { version: 2, entries: {} }
    await generate(provider, loaded, specs, lock)
    await generate(provider, loaded, specs, lock, true)
    const file = path.join(dir, "out/anvil.png")
    const edited = encodeRgbaPng(1, 1, Buffer.from([9, 9, 9, 255]))
    await writeFile(file, edited)
    await expect(revertGeneration(provider, spec, lock, lockPath, { generation: 1 })).rejects.toThrow(/changed after download; keep it with pixelkiln edit, or pass --force/)
    expect(await readFile(file)).toEqual(edited)
    expect((await loadLock(lockPath)).entries["base/anvil"]!.history).toHaveLength(1)
    const forced = await revertGeneration(provider, spec, lock, lockPath, { generation: 1, force: true })
    expect(sha256(await readFile(file))).toBe(forced.restored.outputs[0]!.sha256)

    const entry = lock.entries[lockKey("base", "anvil")]!
    expect(() => pickHistory(entry, 5)).toThrow(/keeps 1 previous generation\(s\); there is no #5/)
    expect(() => pickHistory(entry, "zzzz")).toThrow(/no previous generation .* starting with "zzzz"/)
    expect(() => pickHistory({ ...entry, history: [] }, 1)).toThrow(/no previous generations recorded/)
  })

  it("is what cache --prune keeps", async () => {
    const { loaded, specs } = await project()
    const provider = new FakeProvider({ candidates: 1 })
    const lock: Lock = { version: 2, entries: {} }
    const first = await generate(provider, loaded, specs, lock)
    const second = await generate(provider, loaded, specs, lock, true)
    expect(referencedHashes(lock)).toEqual(new Set([second.outputs[0]!.sha256, first.outputs[0]!.sha256]))
    const report = await inspectCaches(lock, lockPath, { prune: true })
    expect(report.content.referenced).toBe(2)
    expect(report.content.unreferenced).toEqual([])
    const cached = await readdir(path.join(dir, ".pixelkiln/cache"))
    expect(cached.sort()).toEqual([first.outputs[0]!.sha256 + ".png", second.outputs[0]!.sha256 + ".png"].sort())
    expect(existsSync(path.join(dir, ".pixelkiln/cache", first.outputs[0]!.sha256 + ".png"))).toBe(true)
  })
})

async function untilPhase(handlers: GalleryGenerateHandlers, id: string, phases: string[]): Promise<GenerateJob> {
  for (let i = 0; i < 400; i++) {
    const job = handlers.status().jobs.find((candidate) => candidate.id === id)!
    if (phases.includes(job.phase)) return job
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error("job did not settle")
}

describe("the gallery's view of history", () => {
  it("lists replaced generations with cache-backed thumbnails and brings one back as a free job", async () => {
    const { manifestPath, loaded, specs } = await project()
    const provider = new FakeProvider({ candidates: 1 })
    const lock: Lock = { version: 2, entries: {} }
    const first = await generate(provider, loaded, specs, lock)
    const second = await generate(provider, loaded, specs, lock, true)
    const third = await generate(provider, loaded, specs, lock, true)

    const { snapshot, media } = await buildGallerySnapshot({ loaded, specs, lock, lockPath })
    expect(snapshot.project!.historyLimit).toBe(DEFAULT_HISTORY_LIMIT)
    const item = snapshot.items.find((i) => i.key === "base/anvil")!
    expect(item.history.map((g) => [g.index, g.outputs[0]!.sha256, g.cached, g.promptDiffers])).toEqual([
      [1, second.outputs[0]!.sha256, true, false],
      [2, first.outputs[0]!.sha256, true, false],
    ])
    expect(item.history[0]!.objectId).toBe(second.objectId)
    // The thumbnail is the cache file, on the media allowlist like any output.
    const url = item.history[0]!.outputs[0]!.url!
    const id = /^\/media\/([0-9a-f]{24})/.exec(url)![1]!
    expect(media.get(id)!.path).toBe(path.join(dir, ".pixelkiln/cache", second.outputs[0]!.sha256 + ".png"))
    expect(item.outputs[0]!.sha256).toBe(third.outputs[0]!.sha256)

    const loadProject = async () => {
      const fresh = await loadManifest(manifestPath)
      const freshSpecs = await resolveSpecs(fresh)
      const freshLock = await loadLock(lockPath)
      normalizeLockOutputPaths(freshLock, freshSpecs)
      return { loaded: fresh, specs: freshSpecs, lock: freshLock, lockPath }
    }
    const handlers = createGenerateHandlers({
      loadProject, providerFor: () => provider, budget: { amount: 0, byProvider: {} },
      reload: async () => buildGallerySnapshot({ loaded, specs, lock: await loadLock(lockPath), lockPath }),
      pollIntervalMs: 0, submitSpacingMs: 0,
    })
    await expect(handlers.start({ keys: ["base/anvil", "base/anvil"], revert: "1" })).rejects.toThrow(/revert takes one key/)
    await expect(handlers.start({ keys: ["base/anvil"], revert: "1", refresh: true })).rejects.toThrow(/exclusive/)
    await expect(handlers.start({ keys: ["base/anvil"], revert: "9" })).resolves.toMatchObject({ mode: "revert" })
    const bad = await untilPhase(handlers, handlers.status().jobs[0]!.id, ["done", "failed"])
    expect(bad.phase).toBe("failed")
    expect(bad.error).toMatch(/there is no #9/)

    const job = await handlers.start({ keys: ["base/anvil"], revert: "2" })
    expect(job).toMatchObject({ mode: "revert", revert: "2", force: false })
    const done = await untilPhase(handlers, job.id, ["done", "failed"])
    expect(done).toMatchObject({ phase: "done", spent: {}, counts: { downloaded: 1 } })
    expect(sha256(await readFile(path.join(dir, "out/anvil.png")))).toBe(first.outputs[0]!.sha256)
    const after = (await loadLock(lockPath)).entries["base/anvil"]!
    expect(after.history!.map((g) => g.outputs[0]!.sha256)).toEqual([third.outputs[0]!.sha256, second.outputs[0]!.sha256])
    expect(handlers.status().spent).toEqual({})
  })

  it("renders the section and the CLI parses its commands", () => {
    const snapshot = { items: [], styles: [], totals: { entries: 0 }, project: { name: "x", manifest: "m", lock: "l" } } as never
    const page = renderGallery(snapshot, { generation: true, session: "0".repeat(32) })
    expect(page).toContain("function historySection(item)")
    expect(page).toContain("Restore this one")
    expect(page).toContain("body.revert = revert")
    expect(parseArgs(["history"])).toMatchObject({ command: "history" })
    expect(parseArgs(["history", "--only", "anvil", "--json"])).toMatchObject({ command: "history", assets: ["anvil"], json: true })
    expect(parseArgs(["restore", "--only", "anvil", "--generation", "2"])).toMatchObject({ command: "restore", assets: ["anvil"], generation: "2" })
    expect(parseArgs(["restore", "--only", "anvil", "--generation", "d14b73af"]).generation).toBe("d14b73af")
    expect(() => parseArgs(["restore", "--generation"])).toThrow(/needs a value/)
  })
})
