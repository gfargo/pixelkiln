import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { existsSync } from "node:fs"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { FakeProvider } from "../src/providers/fake.ts"
import { loadManifest, resolveSpecs } from "../src/manifest.ts"
import { buildPlan } from "../src/pipeline/plan.ts"
import { submit } from "../src/pipeline/submit.ts"
import { poll } from "../src/pipeline/poll.ts"
import { fetchAssets } from "../src/pipeline/fetch.ts"
import { prepareReview, runPicker } from "../src/pick/server.ts"
import {
  cachedCandidatePath,
  candidateCacheDirFor,
  loadReviewState,
  reviewStatePathFor,
  setChosen,
} from "../src/pick/candidates.ts"
import { sha256 } from "../src/hash.ts"
import { lockKey, type Lock } from "../src/types.ts"
import type { JobState } from "../src/provider.ts"

let dir: string
let lockPath: string
beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "pixelkiln-candidates-"))
  lockPath = path.join(dir, "pixelkiln.lock.json")
})
afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

/** A provider whose jobs can expire, the way PixelLab drops a finished background job. */
class ExpiringProvider extends FakeProvider {
  expired = false
  downloadsGone = false
  override async poll(jobId: string, ...rest: unknown[]): Promise<JobState> {
    if (this.expired) throw new Error(`GET /background-jobs/${jobId} → 404`)
    return super.poll(jobId)
  }
  override async selectCandidate(jobId: string, index: number, commonTag?: string) {
    if (this.expired) throw new Error(`GET /background-jobs/${jobId} → 404`)
    return super.selectCandidate(jobId, index, commonTag)
  }
  override async download(url: string): Promise<Buffer> {
    if (this.downloadsGone && url.includes("/candidate/")) throw new Error("404 Not Found")
    return super.download(url)
  }
}

async function projectInReview(provider: FakeProvider) {
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
  return { lock, specs }
}

const key = lockKey("base", "anvil")

describe("candidate cache", () => {
  it("caches every candidate the moment poll sees the job reach review", async () => {
    const provider = new ExpiringProvider({ candidates: 3 })
    const { lock } = await projectInReview(provider)
    const state = await loadReviewState(reviewStatePathFor(lockPath))
    const asset = state.assets[key]!
    expect(asset).toMatchObject({ provider: "fake", jobId: lock.entries[key]!.reviewObjectId, mode: "candidates", status: "pending", chosen: null })
    expect(asset.candidates).toHaveLength(3)
    for (const candidate of asset.candidates) {
      const file = cachedCandidatePath(candidateCacheDirFor(lockPath), candidate)!
      // The same bytes fetch would have written.
      const expected = await provider.download(candidate.sourceUrl!)
      expect(sha256(await readFile(file))).toBe(sha256(expected))
      expect(path.dirname(file)).toBe(path.join(dir, ".pixelkiln", "cache"))
    }
  })

  it("applies a candidate after the provider has dropped the job", async () => {
    const provider = new ExpiringProvider({ candidates: 3 })
    const { lock, specs } = await projectInReview(provider)
    const expected = await provider.download(`fake://${lock.entries[key]!.reviewObjectId}/candidate/1`)
    provider.expired = true
    provider.downloadsGone = true

    let url = ""
    const picked = runPicker(provider, lock, lockPath, { open: false, onReady: (ready) => (url = ready.url) })
    await vi.waitFor(() => expect(url).not.toBe(""))
    // Frames come from local routes, not the provider.
    const html = await (await fetch(url)).text()
    expect(html).toContain("/review-frame/0/1")
    const frame = await fetch(url + "review-frame/0/1")
    expect(frame.ok).toBe(true)
    expect(sha256(Buffer.from(await frame.arrayBuffer()))).toBe(sha256(expected))

    const res = await fetch(url + "apply", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ selections: [{ key, index: 1 }] }),
    })
    expect(res.ok).toBe(true)
    expect(await picked).toEqual({ selected: 1, skipped: 0 })
    expect(lock.entries[key]).toMatchObject({ status: "selected", candidateIndex: 1 })

    const fetched = await fetchAssets(provider, specs, lock, lockPath)
    expect(fetched.failed).toBe(0)
    const output = lock.entries[key]!.outputs[0]!
    expect(output.sha256).toBe(sha256(expected))

    const state = await loadReviewState(reviewStatePathFor(lockPath))
    expect(state.assets[key]).toMatchObject({ status: "applied", chosen: 1 })
  })

  it("re-fetches an uncached candidate from its stored URL when the job is gone", async () => {
    const provider = new ExpiringProvider({ candidates: 2 })
    const { lock } = await projectInReview(provider)
    const asset = (await loadReviewState(reviewStatePathFor(lockPath))).assets[key]!
    await rm(cachedCandidatePath(candidateCacheDirFor(lockPath), asset.candidates[0]!)!)
    provider.expired = true

    const session = await prepareReview(provider, lock, { lockPath })
    expect(session?.groups.map((g) => g.key)).toEqual([key])
    expect(existsSync(cachedCandidatePath(candidateCacheDirFor(lockPath), asset.candidates[0]!)!)).toBe(true)
  })

  it("names the asset when the provider expired a candidate that was never cached", async () => {
    const provider = new ExpiringProvider({ candidates: 2 })
    const { lock } = await projectInReview(provider)
    const asset = (await loadReviewState(reviewStatePathFor(lockPath))).assets[key]!
    await rm(cachedCandidatePath(candidateCacheDirFor(lockPath), asset.candidates[0]!)!)
    provider.expired = true
    provider.downloadsGone = true

    const lines: string[] = []
    const session = await prepareReview(provider, lock, { lockPath, onProgress: (line) => lines.push(line) })
    expect(session).toBeNull()
    expect(lines.join("\n")).toMatch(/base\/anvil: job .* expired on the provider before every candidate was cached/)
  })

  it("keeps a chosen index across a reload", async () => {
    const provider = new ExpiringProvider({ candidates: 2 })
    await projectInReview(provider)
    await setChosen(reviewStatePathFor(lockPath), key, 1)
    await poll(provider, { version: 2, entries: {} }, lockPath, { intervalMs: 0 })
    expect((await loadReviewState(reviewStatePathFor(lockPath))).assets[key]!.chosen).toBe(1)
  })
})
