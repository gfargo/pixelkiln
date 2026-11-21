import { describe, expect, it, beforeEach, afterEach, vi } from "vitest"
import { mkdtemp, writeFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { FakeProvider } from "../src/providers/fake.ts"
import { loadManifest, resolveSpecs, type LoadedManifest } from "../src/manifest.ts"
import { buildPlan } from "../src/pipeline/plan.ts"
import { submit } from "../src/pipeline/submit.ts"
import { poll } from "../src/pipeline/poll.ts"
import { runPicker, type PickResult, type RerollAsset } from "../src/pick/server.ts"
import { loadReviewState, reviewStatePathFor } from "../src/pick/candidates.ts"
import { lockKey, type Lock, type ResolvedSpec } from "../src/types.ts"

let dir: string
let lockPath: string
beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "pixelkiln-pick-review-"))
  lockPath = path.join(dir, "pixelkiln.lock.json")
})
afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

const key = lockKey("base", "anvil")
const other = lockKey("base", "lantern")

async function projectInReview(provider = new FakeProvider({ candidates: 3 })) {
  const manifestPath = path.join(dir, "pixelkiln.manifest.json")
  await writeFile(manifestPath, JSON.stringify({
    name: "itest",
    styles: { base: { generator: "1dir", size: 32, outDir: "out", promptSuffix: "clean" } },
    assets: { anvil: { prompt: "an anvil", category: "tools" }, lantern: { prompt: "a lantern", category: "tools" } },
  }))
  const loaded = await loadManifest(manifestPath)
  const specs = await resolveSpecs(loaded)
  const lock: Lock = { version: 2, entries: {} }
  await submit(provider, loaded, (await buildPlan(specs, lock)).actionable, lock, lockPath, { spacingMs: 0 })
  await poll(provider, lock, lockPath, { intervalMs: 0 })
  return { provider, lock, specs, loaded }
}

/** The page's reroll, as `gen` wires it: --force for one asset, then poll it back into review. */
function rerollWith(provider: FakeProvider, loaded: LoadedManifest, specs: ResolvedSpec[], lock: Lock): RerollAsset {
  return async (k) => {
    const spec = specs.find((s) => lockKey(s.styleId, s.assetId) === k)!
    await submit(provider, loaded, (await buildPlan([spec], lock, { force: true })).actionable, lock, lockPath, { spacingMs: 0 })
    await poll(provider, lock, lockPath, { intervalMs: 0, specs: [spec] })
  }
}

async function serve(provider: FakeProvider, lock: Lock, opts: Parameters<typeof runPicker>[3] = {}) {
  let url = ""
  const done = runPicker(provider, lock, lockPath, { open: false, ...opts, onReady: (ready) => (url = ready.url) })
  await vi.waitFor(() => expect(url).not.toBe(""))
  const post = (route: string, body: unknown, headers: Record<string, string> = {}) =>
    fetch(url + route, { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(body) })
  const session = async () => (await fetch(url + "session")).json() as Promise<{
    groups: { key: string; reviewObjectId: string; frameUrls: string[] }[]
    state: Record<string, { chosen: number | null; flagged: number[]; later: boolean }>
    rerolls: Record<string, { state: string; error?: string }>
    canReroll: boolean
  }>
  const apply = async (selections: { key: string; index: number }[]): Promise<PickResult> => {
    const res = await post("apply", { selections })
    expect(res.ok).toBe(true)
    return done
  }
  return { url, post, session, apply, done }
}

describe("pick page persistence", () => {
  it("saves a choice, flags and 'later' to the review state as they are made", async () => {
    const { provider, lock } = await projectInReview()
    const page = await serve(provider, lock)

    expect((await page.post("state", { key, chosen: 1, flagged: [2, 2, 0] })).status).toBe(200)
    expect((await page.post("state", { key: other, chosen: null, later: true })).status).toBe(200)

    const saved = (await loadReviewState(reviewStatePathFor(lockPath))).assets
    expect(saved[key]).toMatchObject({ status: "pending", chosen: 1, flagged: [0, 2] })
    expect(saved[other]).toMatchObject({ chosen: null, later: true })

    // A refresh reads it back.
    const { state } = await page.session()
    expect(state[key]).toEqual({ chosen: 1, flagged: [0, 2], later: false })
    expect(state[other]).toEqual({ chosen: null, flagged: [], later: true })

    await page.apply([{ key, index: 1 }])
  })

  it("reopens a restarted review where it was left", async () => {
    const { provider, lock } = await projectInReview()
    const first = await serve(provider, lock)
    await first.post("state", { key, chosen: 2, flagged: [0] })
    // The run stops without applying; the job is polled again on the next run.
    await first.post("apply", { selections: [] })
    await first.done
    await poll(provider, lock, lockPath, { intervalMs: 0 })

    const second = await serve(provider, lock)
    const { state } = await second.session()
    expect(state[key]).toEqual({ chosen: 2, flagged: [0], later: false })
    await second.apply([{ key, index: 2 }])
    expect(lock.entries[key]).toMatchObject({ status: "selected", candidateIndex: 2 })
  })

  it("refuses a selection outside the candidates, an unknown asset, and a cross-origin write", async () => {
    const { provider, lock } = await projectInReview()
    const page = await serve(provider, lock)
    expect((await page.post("state", { key, chosen: 3 })).status).toBe(400)
    expect((await page.post("state", { key, flagged: [-1] })).status).toBe(400)
    expect((await page.post("state", { key: "base/nope", chosen: 0 })).status).toBe(400)
    expect((await page.post("state", { key, chosen: 0 }, { Origin: "http://evil.test" })).status).toBe(403)
    expect((await loadReviewState(reviewStatePathFor(lockPath))).assets[key]!.chosen).toBeNull()
    await page.apply([])
  })
})

describe("pick page reroll", () => {
  it("regenerates one asset inside the run and puts its new candidates back on the page", async () => {
    const { provider, lock, specs, loaded } = await projectInReview()
    const oldJob = lock.entries[key]!.reviewObjectId
    const page = await serve(provider, lock, { specs, reroll: rerollWith(provider, loaded, specs, lock) })
    await page.post("state", { key, chosen: 0 })

    const res = await page.post("reroll", { key })
    expect(res.status).toBe(202)

    let fresh: { key: string; reviewObjectId: string; frameUrls: string[] } | undefined
    await vi.waitFor(async () => {
      const s = await page.session()
      fresh = s.groups.find((g) => g.key === key)
      expect(s.rerolls[key]).toBeUndefined()
      expect(fresh?.reviewObjectId).not.toBe(oldJob)
    })
    const s = await page.session()
    // The new take starts undecided, on routes no earlier group used.
    expect(s.state[key]).toEqual({ chosen: null, flagged: [], later: false })
    expect(fresh!.frameUrls.every((u) => !u.startsWith("/review-frame/0/") && !u.startsWith("/review-frame/1/"))).toBe(true)
    expect(provider.submissions.filter((sub) => sub.assetId === "anvil")).toHaveLength(2)
    expect(provider.submissions.filter((sub) => sub.assetId === "lantern")).toHaveLength(1)

    const result = await page.apply([{ key, index: 1 }, { key: other, index: 0 }])
    expect(result).toEqual({ selected: 2, skipped: 0 })
    expect(lock.entries[key]).toMatchObject({ status: "selected", candidateIndex: 1 })
    expect(lock.entries[key]!.objectId).not.toContain(oldJob!)
  })

  it("reports a failed reroll on the page and keeps the old candidates", async () => {
    const { provider, lock } = await projectInReview()
    const page = await serve(provider, lock, { reroll: async () => { throw new Error("budget of 0 credits is spent") } })
    await page.post("reroll", { key })
    await vi.waitFor(async () => {
      expect((await page.session()).rerolls[key]).toEqual({ state: "failed", error: "budget of 0 credits is spent" })
    })
    expect((await page.session()).groups.find((g) => g.key === key)!.reviewObjectId).toBe(lock.entries[key]!.reviewObjectId)
    await page.apply([{ key, index: 0 }])
  })

  it("holds apply while a reroll is running", async () => {
    const { provider, lock } = await projectInReview()
    let release!: () => void
    const page = await serve(provider, lock, { reroll: () => new Promise<void>((r) => (release = r)).then(() => { throw new Error("stopped") }) })
    await page.post("reroll", { key })
    const blocked = await page.post("apply", { selections: [{ key: other, index: 0 }] })
    expect(blocked.status).toBe(500)
    expect(await blocked.text()).toMatch(/reroll is still running/)
    release()
    await vi.waitFor(async () => expect((await page.session()).rerolls[key]?.state).toBe("failed"))
    await page.apply([{ key: other, index: 0 }])
  })

  it("offers no reroll without a reroll hook", async () => {
    const { provider, lock } = await projectInReview()
    const page = await serve(provider, lock)
    expect((await page.session()).canReroll).toBe(false)
    expect((await page.post("reroll", { key })).status).toBe(400)
    await page.apply([])
  })
})
