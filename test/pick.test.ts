import { describe, expect, it, beforeEach, afterEach, vi } from "vitest"
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { FakeProvider, FAKE_PNG } from "../src/providers/fake.ts"
import { loadManifest, resolveSpecs } from "../src/manifest.ts"
import { buildPlan } from "../src/pipeline/plan.ts"
import { submit } from "../src/pipeline/submit.ts"
import { poll } from "../src/pipeline/poll.ts"
import { prepareReview, runPicker } from "../src/pick/server.ts"
import { fetchAssets } from "../src/pipeline/fetch.ts"
import { lockKey, type Lock } from "../src/types.ts"
import type { JobState } from "../src/provider.ts"

let dir: string
let lockPath: string
beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "pixelkiln-pick-"))
  lockPath = path.join(dir, "pixelkiln.lock.json")
})
afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

/** Drives the real submit → poll pipeline so the resulting lock entry is
 *  genuinely in review status, rather than hand-authoring one. */
async function projectInReview(candidates = 4, provider = new FakeProvider({ candidates })) {
  const manifest = {
    name: "itest",
    styles: { base: { generator: "1dir", size: 64, outDir: "out", promptSuffix: "clean" } },
    assets: { anvil: { prompt: "an anvil", category: "tools" } },
  }
  const manifestPath = path.join(dir, "pixelkiln.manifest.json")
  await writeFile(manifestPath, JSON.stringify(manifest))
  const loaded = await loadManifest(manifestPath)
  const specs = await resolveSpecs(loaded)
  const lock: Lock = { version: 2, entries: {} }
  await submit(provider, loaded, (await buildPlan(specs, lock)).actionable, lock, lockPath, { spacingMs: 0 })
  await poll(provider, lock, lockPath, { intervalMs: 0 })
  return { provider, lock, specs }
}

/**
 * Candidates the way PixelLab's imagePro and uiElement report them: decoded
 * to a local cache and named by `file://` URL, beside whatever the provider
 * hosts. Promotion names no source of its own, so `apply` falls back to the
 * URL the provider listed for the candidate.
 */
class LocalCacheProvider extends FakeProvider {
  constructor(private readonly urls: string[]) {
    super({ candidates: urls.length })
  }
  override async poll(jobId: string): Promise<JobState> {
    const state = await super.poll(jobId)
    return state.status === "review" ? { ...state, candidateUrls: this.urls } : state
  }
  override async selectCandidate(jobId: string, index: number, commonTag?: string) {
    return { ...(await super.selectCandidate(jobId, index, commonTag)), sourceUrl: null }
  }
}

describe("runPicker", () => {
  it("returns immediately without starting a server when nothing is in review", async () => {
    const provider = new FakeProvider()
    const res = await runPicker(provider, { version: 2, entries: {} }, lockPath, { open: false })
    expect(res).toEqual({ selected: 0, skipped: 0 })
  })

  it("promotes the chosen candidate and persists it to the lockfile", async () => {
    const { provider, lock } = await projectInReview(4)
    const key = lockKey("base", "anvil")
    expect(lock.entries[key]!.status).toBe("review")

    let url = ""
    let readyKeys: string[] = []
    const picked = runPicker(provider, lock, lockPath, {
      open: false,
      onReady: (ready) => {
        url = ready.url
        readyKeys = ready.keys
      },
    })

    await vi.waitFor(() => expect(url).not.toBe(""))
    expect(readyKeys).toEqual([key])
    const res = await fetch(url + "apply", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ selections: [{ key, index: 2 }] }),
    })
    expect(res.ok).toBe(true)
    expect(await picked).toEqual({ selected: 1, skipped: 0 })

    const entry = lock.entries[key]!
    expect(entry.status).toBe("selected")
    expect(entry.candidateIndex).toBe(2)
    expect(entry.objectId).toBeTruthy()

    const onDisk = JSON.parse(await readFile(lockPath, "utf8"))
    expect(onDisk.entries[key].status).toBe("selected")
  })

  it("shows the art a regeneration would replace beside the new candidates", async () => {
    // First generation: one candidate, downloaded. Then regenerate with four
    // candidates so the entry lands in review while the old file still exists.
    const manifest = {
      name: "regen",
      styles: { base: { generator: "1dir", size: 64, outDir: "out", promptSuffix: "clean" } },
      assets: { anvil: { prompt: "an anvil" } },
    }
    const manifestPath = path.join(dir, "pixelkiln.manifest.json")
    await writeFile(manifestPath, JSON.stringify(manifest))
    const loaded = await loadManifest(manifestPath)
    const specs = await resolveSpecs(loaded)
    const key = lockKey("base", "anvil")
    const lock: Lock = { version: 2, entries: {} }
    const first = new FakeProvider({ candidates: 1 })
    await submit(first, loaded, (await buildPlan(specs, lock)).actionable, lock, lockPath, { spacingMs: 0 })
    await poll(first, lock, lockPath, { intervalMs: 0 })
    await fetchAssets(first, specs, lock, lockPath, { cacheDir: false })
    expect(lock.entries[key]!.status).toBe("downloaded")
    const oldFile = path.join(dir, "out", "anvil.png")
    const oldBytes = await readFile(oldFile)

    const again = new FakeProvider({ candidates: 4 })
    await submit(again, loaded, (await buildPlan(specs, lock, { force: true })).actionable, lock, lockPath, { spacingMs: 0 })
    await poll(again, lock, lockPath, { intervalMs: 0 })
    expect(lock.entries[key]!.status).toBe("review")
    expect(lock.entries[key]!.supersededOutputs?.[0]?.path).toBe("out/anvil.png")

    const session = await prepareReview(again, lock, { specs, routePrefix: "/review/abc" })
    expect(session).not.toBeNull()
    const group = session!.groups[0]!
    expect(group.current).toEqual({ url: "/review/abc/current-art/0", width: 1, height: 1 })
    expect(session!.assets.get("/review/abc/current-art/0")).toEqual({ path: oldFile, contentType: "image/png" })
    expect(session!.html()).toContain("CURRENT ART")
    // Without the spec there is no manifest root to resolve the old path from.
    expect((await prepareReview(again, lock))!.groups[0]!.current).toBeUndefined()

    // The standalone review server serves the old bytes on the same route.
    let url = ""
    const picked = runPicker(again, lock, lockPath, {
      open: false,
      specs,
      onProgress: (m) => (url ||= m.match(/http:\/\/127\.0\.0\.1:\d+\//)?.[0] ?? ""),
    })
    await vi.waitFor(() => expect(url).not.toBe(""))
    const served = await fetch(url + "current-art/0")
    expect(served.status).toBe(200)
    expect(Buffer.from(await served.arrayBuffer()).equals(oldBytes)).toBe(true)
    await fetch(url + "apply", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ selections: [{ key, index: 0 }] }),
    })
    expect(await picked).toEqual({ selected: 1, skipped: 0 })
  })

  it("serves a candidate the provider cached on disk on its own route, never as a file:// URL", async () => {
    // A sheet served from http://127.0.0.1 cannot load a file:// image.
    const cached = path.join(dir, "cached-0.png")
    await writeFile(cached, FAKE_PNG)
    const hosted = "https://cdn.example.test/candidate-1.png"
    const { provider, lock } = await projectInReview(2, new LocalCacheProvider([`file://${cached}`, hosted]))
    const key = lockKey("base", "anvil")
    expect(lock.entries[key]!.status).toBe("review")

    // Hosted under the gallery, the route carries the prefix; a hosted URL is untouched.
    const embedded = await prepareReview(provider, lock, { routePrefix: "/review/abc" })
    expect(embedded!.groups[0]!.frameUrls).toEqual(["/review/abc/review-frame/0/0", hosted])
    expect(embedded!.assets.get("/review/abc/review-frame/0/0")).toEqual({ path: cached, contentType: "image/png" })
    expect(embedded!.html()).not.toContain("file://")

    let url = ""
    const picked = runPicker(provider, lock, lockPath, {
      open: false,
      onReady: (ready) => (url = ready.url),
    })
    await vi.waitFor(() => expect(url).not.toBe(""))
    const page = await (await fetch(url)).text()
    expect(page).toContain("/review-frame/0/0")
    expect(page).toContain(hosted)
    expect(page).not.toContain("file://")
    const served = await fetch(url + "review-frame/0/0")
    expect(served.status).toBe(200)
    expect(served.headers.get("content-type")).toBe("image/png")
    expect(Buffer.from(await served.arrayBuffer())).toEqual(FAKE_PNG)
    // Only the cached candidate has a route; the hosted one needs none.
    expect((await fetch(url + "review-frame/0/1")).status).toBe(404)

    await fetch(url + "apply", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ selections: [{ key, index: 0 }] }),
    })
    expect(await picked).toEqual({ selected: 1, skipped: 0 })
    // The lockfile records the provider's URL, which fetch can read, not the route.
    expect(lock.entries[key]).toMatchObject({ status: "selected", candidateIndex: 0, sourceUrl: `file://${cached}` })
  })

  it("ignores an out-of-range index instead of throwing", async () => {
    const { provider, lock } = await projectInReview(4)
    const key = lockKey("base", "anvil")

    let url = ""
    const picked = runPicker(provider, lock, lockPath, {
      open: false,
      onProgress: (m) => (url ||= m.match(/http:\/\/127\.0\.0\.1:\d+\//)?.[0] ?? ""),
    })
    await vi.waitFor(() => expect(url).not.toBe(""))
    await fetch(url + "apply", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ selections: [{ key, index: 99 }] }),
    })

    expect(await picked).toEqual({ selected: 0, skipped: 1 })
    expect(lock.entries[key]!.status).toBe("review")
  })

  it("rejects cross-origin or non-JSON review submissions", async () => {
    const { provider, lock } = await projectInReview(4)
    const key = lockKey("base", "anvil")
    let url = ""
    const picked = runPicker(provider, lock, lockPath, {
      open: false,
      onProgress: (m) => (url ||= m.match(/http:\/\/127\.0\.0\.1:\d+\//)?.[0] ?? ""),
    })
    await vi.waitFor(() => expect(url).not.toBe(""))

    const nonJson = await fetch(url + "apply", { method: "POST", body: "{}" })
    expect(nonJson.status).toBe(415)
    const crossOrigin = await fetch(url + "apply", {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: "https://example.test" },
      body: "{}",
    })
    expect(crossOrigin.status).toBe(403)

    await fetch(url + "apply", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ selections: [{ key, index: 0 }] }),
    })
    await picked
  })

  it("serves only the registered revision source for side-by-side review", async () => {
    const { provider, lock, specs } = await projectInReview(4)
    const sourceFile = path.join(dir, "source.png")
    await writeFile(sourceFile, FAKE_PNG)
    const sourceSpec = { ...specs[0]!, assetId: "source", source: "source.png" }
    const revisionSpec = {
      ...specs[0]!,
      revision: {
        mode: "image-to-image" as const,
        sourceAssetId: "source",
        sourceFile,
        sourceSha256: "a".repeat(64),
        sourceWidth: 1,
        sourceHeight: 1,
        sourceFormat: "png" as const,
        sourceSpec,
        strength: 0.3,
      },
    }

    let url = ""
    const picked = runPicker(provider, lock, lockPath, {
      open: false,
      specs: [revisionSpec],
      onProgress: (message) => (url ||= message.match(/http:\/\/127\.0\.0\.1:\d+\//)?.[0] ?? ""),
    })
    await vi.waitFor(() => expect(url).not.toBe(""))

    const page = await (await fetch(url)).text()
    expect(page).toContain("/revision-source/0")
    const source = await fetch(url + "revision-source/0")
    expect(source.headers.get("content-type")).toBe("image/png")
    expect(Buffer.from(await source.arrayBuffer())).toEqual(FAKE_PNG)
    expect((await fetch(url + "revision-source/../pixelkiln.lock.json")).status).toBe(404)

    await fetch(url + "apply", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ selections: [{ key: lockKey("base", "anvil"), index: 0 }] }),
    })
    await picked
  })
})
