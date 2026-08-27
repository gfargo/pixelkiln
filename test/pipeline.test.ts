import { describe, expect, it, beforeEach, afterEach } from "vitest"
import { mkdir, mkdtemp, writeFile, rm, readFile, unlink } from "node:fs/promises"
import { existsSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { FakeProvider, FAKE_PNG } from "../src/providers/fake.ts"
import { loadManifest, resolveSpecs } from "../src/manifest.ts"
import { buildPlan } from "../src/pipeline/plan.ts"
import { submit } from "../src/pipeline/submit.ts"
import { poll } from "../src/pipeline/poll.ts"
import { fetchAssets, pushTags } from "../src/pipeline/fetch.ts"
import { adopt } from "../src/pipeline/adopt.ts"
import { loadLock, saveLock, spendByUnit } from "../src/lock.ts"
import { measureBalanceChange } from "../src/provider.ts"
import { sha256 } from "../src/hash.ts"
import { lockKey, primaryOutput, type Generator, type Lock } from "../src/types.ts"

/**
 * Integration coverage for the stages that spend money.
 *
 * These were the only modules with no tests, and four of the five real bugs
 * found in this project lived here — rate-limit spacing, the wrong
 * select-frames field, and two baseline-hash mistakes. The FakeProvider drives
 * the genuine state machine with no network and no API key.
 */

let dir: string
let lockPath: string

async function project(opts: {
  generator?: "1dir" | "map"
  assets?: Record<string, unknown>
} = {}) {
  const manifest = {
    name: "itest",
    styles: {
      base: {
        generator: opts.generator ?? "1dir",
        size: 64,
        outDir: "out",
        promptSuffix: "clean",
      },
    },
    assets: opts.assets ?? {
      anvil: { prompt: "an anvil", category: "tools" },
      hammer: { prompt: "a hammer", category: "tools" },
    },
  }
  const p = path.join(dir, "pixelkiln.manifest.json")
  await writeFile(p, JSON.stringify(manifest))
  const loaded = await loadManifest(p)
  return { loaded, specs: await resolveSpecs(loaded) }
}

const emptyLock = (): Lock => ({ version: 2, entries: {} })

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "pixelkiln-itest-"))
  lockPath = path.join(dir, "pixelkiln.lock.json")
})
afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

describe("submit", () => {
  it("records a job id and marks the entry processing", async () => {
    const provider = new FakeProvider()
    const { loaded, specs } = await project()
    const lock = emptyLock()
    const plan = await buildPlan(specs, lock)

    const res = await submit(provider, loaded, plan.actionable, lock, lockPath, {
      spacingMs: 0,
      yes: true,
    } as never)

    expect(res.submitted).toBe(2)
    expect(res.failed).toBe(0)
    for (const spec of specs) {
      const entry = lock.entries[lockKey(spec.styleId, spec.assetId)]!
      expect(entry.jobId).toMatch(/^job-\d+$/)
      expect(entry.status).toBe("processing")
      expect(entry.provider).toBe("fake")
    }
  })

  // The lockfile must be written before the request is awaited, so a crash
  // mid-run never loses track of work that has already been paid for.
  it("persists the lockfile so an interrupted run is recoverable", async () => {
    const provider = new FakeProvider()
    const { loaded, specs } = await project()
    const lock = emptyLock()
    const plan = await buildPlan(specs, lock)
    await submit(provider, loaded, plan.actionable, lock, lockPath, { spacingMs: 0 })

    const reloaded = await loadLock(lockPath)
    expect(Object.keys(reloaded.entries)).toHaveLength(2)
    expect(reloaded.version).toBe(2)
  })

  it("refuses to exceed an explicit budget", async () => {
    const provider = new FakeProvider()
    const { loaded, specs } = await project()
    const lock = emptyLock()
    const plan = await buildPlan(specs, lock)
    // 2 assets x 40 = 80.
    await expect(
      submit(provider, loaded, plan.actionable, lock, lockPath, { budget: 50, spacingMs: 0 }),
    ).rejects.toThrow(/budget/i)
    expect(provider.submissions).toHaveLength(0)
  })

  it("uses the provider estimate and preserves fractional USD without mixing units", async () => {
    const provider = new FakeProvider({ costUnit: "usd", startingBalance: 10 })
    provider.estimate = (spec) => ({ unit: "usd", amount: 0.25, candidates: spec.candidates })
    const { loaded } = await project()
    const specs = await resolveSpecs(loaded, { provider })
    const lock = emptyLock()
    const before = await provider.balance()
    const plan = await buildPlan(specs, lock)
    expect(plan).toMatchObject({ cost: 0.5, costUnit: "usd" })
    const res = await submit(
      provider,
      loaded,
      plan.actionable,
      lock,
      lockPath,
      { budget: 0.5, spacingMs: 0 },
    )
    const after = await provider.balance()

    expect(res).toMatchObject({ submitted: 2, failed: 0, spent: 0.5, unit: "usd" })
    expect(Object.values(lock.entries).map((entry) => [entry.cost, entry.costUnit]))
      .toEqual([[0.25, "usd"], [0.25, "usd"]])
    expect(spendByUnit(lock)).toEqual({ generations: 0, usd: 0.5, free: 0 })
    expect(measureBalanceChange(before, after)).toMatchObject({
      unit: "usd",
      spent: 0.5,
      credited: 0,
    })
    expect(measureBalanceChange(before, { ...after, unit: "generations" })).toBeNull()
  })

  it("rejects malformed provider estimates before they can weaken a budget", async () => {
    const provider = new FakeProvider()
    provider.estimate = () => ({ unit: "generations", amount: Number.NaN, candidates: 4 })
    const { loaded } = await project()
    await expect(resolveSpecs(loaded, { provider })).rejects.toThrow(/invalid cost amount/)
  })

  it("marks an entry failed without billing it when the request is rejected", async () => {
    const provider = new FakeProvider()
    // Force a submit-time throw by asking for a generator the fake rejects.
    const broken = Object.assign(Object.create(Object.getPrototypeOf(provider)), provider, {
      submit: async () => {
        throw new Error("upstream refused")
      },
    })
    const { loaded, specs } = await project()
    const lock = emptyLock()
    const plan = await buildPlan(specs, lock)
    const res = await submit(broken, loaded, plan.actionable, lock, lockPath, { spacingMs: 0 })

    expect(res.submitted).toBe(0)
    expect(res.failed).toBe(2)
    const entry = lock.entries[lockKey("base", "anvil")]!
    expect(entry.status).toBe("failed")
    expect(entry.cost).toBe(0) // a rejected request is not charged
  })

  // Regression: the spacing/in-flight limits used to be hardcoded constants
  // in this module regardless of which provider was submitting to, which
  // would have silently applied PixelLab's own limits to any other backend.
  it("uses the provider's own rateLimit() instead of the pipeline default", async () => {
    const provider = new FakeProvider()
    expect(provider.rateLimit).toBeUndefined() // FakeProvider declares none
    const fast = Object.assign(Object.create(Object.getPrototypeOf(provider)), provider, {
      rateLimit: () => ({ spacingMs: 0, maxInFlight: 8 }),
    })
    const { loaded, specs } = await project()
    const lock = emptyLock()
    const plan = await buildPlan(specs, lock)

    const start = Date.now()
    // No spacingMs override here — this run relies entirely on the
    // provider's declared 0ms, not the module's own default spacing.
    await submit(fast, loaded, plan.actionable, lock, lockPath, {})
    // DEFAULT_RATE_LIMIT's 2500ms spacing would make 2 submissions take over
    // 2.5s; a provider declaring 0ms should finish orders of magnitude faster.
    expect(Date.now() - start).toBeLessThan(1000)
  })

  it("still lets an explicit spacingMs override the provider's own rateLimit()", async () => {
    const provider = new FakeProvider()
    const slow = Object.assign(Object.create(Object.getPrototypeOf(provider)), provider, {
      rateLimit: () => ({ spacingMs: 5000, maxInFlight: 8 }),
    })
    const { loaded, specs } = await project()
    const lock = emptyLock()
    const plan = await buildPlan(specs, lock)

    const start = Date.now()
    await submit(slow, loaded, plan.actionable, lock, lockPath, { spacingMs: 0 })
    expect(Date.now() - start).toBeLessThan(1000)
  })

  it("keeps a slot occupied when its status poll fails transiently", async () => {
    const provider = new FakeProvider({ candidates: 1 })
    let firstPoll = true
    let submissionsWhenPollFailed = -1
    const cautious = Object.assign(Object.create(Object.getPrototypeOf(provider)), provider, {
      rateLimit: () => ({ spacingMs: 0, maxInFlight: 1 }),
      poll: async (jobId: string, generator: Generator) => {
        if (firstPoll) {
          firstPoll = false
          submissionsWhenPollFailed = provider.submissions.length
          throw new Error("temporary status outage")
        }
        return provider.poll(jobId, generator)
      },
    })
    const { loaded, specs } = await project({ generator: "map" })
    const lock = emptyLock()

    const res = await submit(cautious, loaded, (await buildPlan(specs, lock)).actionable, lock, lockPath, {
      slotPollMs: 0,
      slotTimeoutMs: 1000,
    })

    expect(res.submitted).toBe(2)
    expect(submissionsWhenPollFailed).toBe(1)
  })
})

describe("poll", () => {
  it("routes a multi-candidate job to review", async () => {
    const provider = new FakeProvider({ candidates: 4 })
    const { loaded, specs } = await project()
    const lock = emptyLock()
    await submit(provider, loaded, (await buildPlan(specs, lock)).actionable, lock, lockPath, {
      spacingMs: 0,
    })

    const res = await poll(provider, lock, lockPath, { intervalMs: 0 })
    expect(res.review).toBe(2)
    expect(res.completed).toBe(0)
    expect(lock.entries[lockKey("base", "anvil")]!.status).toBe("review")
  })

  // A single-candidate generator has nothing to pick, so it must skip review.
  it("takes a single-candidate job straight to selected", async () => {
    const provider = new FakeProvider({ candidates: 1 })
    const { loaded, specs } = await project({ generator: "map" })
    const lock = emptyLock()
    await submit(provider, loaded, (await buildPlan(specs, lock)).actionable, lock, lockPath, {
      spacingMs: 0,
    })

    const res = await poll(provider, lock, lockPath, { intervalMs: 0 })
    expect(res.completed).toBe(2)
    expect(res.review).toBe(0)
    expect(lock.entries[lockKey("base", "anvil")]!.status).toBe("selected")
  })

  it("keeps polling through a processing state", async () => {
    const provider = new FakeProvider({ candidates: 1, processingPolls: 2 })
    const { loaded, specs } = await project({ generator: "map", assets: { anvil: { prompt: "a" } } })
    const lock = emptyLock()
    await submit(provider, loaded, (await buildPlan(specs, lock)).actionable, lock, lockPath, {
      spacingMs: 0,
    })

    const res = await poll(provider, lock, lockPath, { intervalMs: 0 })
    expect(res.completed).toBe(1)
  })

  it("records an upstream failure with its reason", async () => {
    const provider = new FakeProvider({ candidates: 1, failAssets: new Set(["hammer"]) })
    const { loaded, specs } = await project({ generator: "map" })
    const lock = emptyLock()
    await submit(provider, loaded, (await buildPlan(specs, lock)).actionable, lock, lockPath, {
      spacingMs: 0,
    })

    const res = await poll(provider, lock, lockPath, { intervalMs: 0 })
    expect(res.failed).toBe(1)
    expect(lock.entries[lockKey("base", "hammer")]!.error).toMatch(/fake failure/)
  })

  it("stops without hanging when a job id is unknown", async () => {
    const provider = new FakeProvider()
    const lock = emptyLock()
    lock.entries["base/ghost"] = {
      styleId: "base", assetId: "ghost", specHash: "h", generator: "map", prompt: "p",
      width: 32, height: 32, jobId: "job-nope", reviewObjectId: null, objectId: null,
      candidateIndex: null, status: "processing", error: null, sourceUrl: null,
      outputs: [], submittedAt: null, downloadedAt: null, cost: 1, provider: "fake",
    }
    const res = await poll(provider, lock, lockPath, { intervalMs: 0 })
    expect(res.failed).toBe(1)
  })
})

describe("fetch", () => {
  it("writes the file, records its hash, and flips to downloaded", async () => {
    const provider = new FakeProvider({ candidates: 1 })
    const { loaded, specs } = await project({ generator: "map" })
    const lock = emptyLock()
    await submit(provider, loaded, (await buildPlan(specs, lock)).actionable, lock, lockPath, {
      spacingMs: 0,
    })
    await poll(provider, lock, lockPath, { intervalMs: 0 })

    const res = await fetchAssets(provider, specs, lock, lockPath)
    expect(res.downloaded).toBe(2)
    expect(res.failed).toBe(0)

    for (const spec of specs) {
      const entry = lock.entries[lockKey(spec.styleId, spec.assetId)]!
      expect(entry.status).toBe("downloaded")
      expect(existsSync(spec.outFile)).toBe(true)
      const output = primaryOutput(entry)!
      expect(output.path).toBe(path.relative(spec.root, spec.outFile))
      expect(output.sha256).toBe(sha256(await readFile(spec.outFile)))
    }
  })

  it("rejects a response that is not a PNG rather than writing garbage", async () => {
    const provider = new FakeProvider({ candidates: 1 })
    const notPng = Object.assign(Object.create(Object.getPrototypeOf(provider)), provider, {
      download: async () => Buffer.from("<html>error page</html>"),
    })
    const { loaded, specs } = await project({ generator: "map", assets: { anvil: { prompt: "a" } } })
    const lock = emptyLock()
    await submit(notPng, loaded, (await buildPlan(specs, lock)).actionable, lock, lockPath, {
      spacingMs: 0,
    })
    await poll(notPng, lock, lockPath, { intervalMs: 0 })

    const res = await fetchAssets(notPng, specs, lock, lockPath)
    expect(res.downloaded).toBe(0)
    expect(res.failed).toBe(1)
    expect(existsSync(specs[0]!.outFile)).toBe(false)
    expect(lock.entries[lockKey("base", "anvil")]!.error).toMatch(/not a PNG/i)
  })

  it("rejects a signature-correct but structurally corrupt PNG", async () => {
    const provider = new FakeProvider({ candidates: 1 })
    const corruptPng = Object.assign(Object.create(Object.getPrototypeOf(provider)), provider, {
      download: async () => FAKE_PNG.subarray(0, -2),
    })
    const { loaded, specs } = await project({
      generator: "map",
      assets: { anvil: { prompt: "a" } },
    })
    const lock = emptyLock()
    await submit(
      corruptPng,
      loaded,
      (await buildPlan(specs, lock)).actionable,
      lock,
      lockPath,
      { spacingMs: 0 },
    )
    await poll(corruptPng, lock, lockPath, { intervalMs: 0 })

    const res = await fetchAssets(corruptPng, specs, lock, lockPath)
    expect(res).toMatchObject({ downloaded: 0, failed: 1 })
    expect(existsSync(specs[0]!.outFile)).toBe(false)
    expect(lock.entries[lockKey("base", "anvil")]!.error).toMatch(/not a valid PNG/i)
  })

  it("retries a failed download without submitting and spending again", async () => {
    const provider = new FakeProvider({ candidates: 1 })
    let fail = true
    const flaky = Object.assign(Object.create(Object.getPrototypeOf(provider)), provider, {
      download: async (url: string) => {
        if (fail) {
          fail = false
          throw new Error("temporary CDN failure")
        }
        return provider.download(url)
      },
    })
    const { loaded, specs } = await project({ generator: "map", assets: { anvil: { prompt: "a" } } })
    const lock = emptyLock()
    await submit(flaky, loaded, (await buildPlan(specs, lock)).actionable, lock, lockPath, {
      spacingMs: 0,
    })
    await poll(flaky, lock, lockPath, { intervalMs: 0, specs })

    expect((await fetchAssets(flaky, specs, lock, lockPath)).failed).toBe(1)
    expect(lock.entries[lockKey("base", "anvil")]!.status).toBe("download-failed")
    const retryPlan = await buildPlan(specs, lock)
    expect(retryPlan.items[0]!.state).toBe("recoverable")
    expect(retryPlan.actionable).toHaveLength(0)
    expect(retryPlan.cost).toBe(0)

    expect((await fetchAssets(flaky, specs, lock, lockPath)).downloaded).toBe(1)
    expect(provider.submissions).toHaveLength(1)
    expect(lock.entries[lockKey("base", "anvil")]!.status).toBe("downloaded")
  })

  it("restores a missing downloaded file from its persisted source URL", async () => {
    const provider = new FakeProvider({ candidates: 1 })
    const { loaded, specs } = await project({ generator: "map", assets: { anvil: { prompt: "a" } } })
    const lock = emptyLock()
    await submit(provider, loaded, (await buildPlan(specs, lock)).actionable, lock, lockPath, {
      spacingMs: 0,
    })
    await poll(provider, lock, lockPath, { intervalMs: 0, specs })
    await fetchAssets(provider, specs, lock, lockPath)
    await unlink(specs[0]!.outFile)

    const orphaned = await buildPlan(specs, lock)
    expect(orphaned.items[0]!.state).toBe("orphaned")
    expect((await fetchAssets(provider, specs, lock, lockPath, { repair: true })).downloaded).toBe(1)
    expect(existsSync(specs[0]!.outFile)).toBe(true)
    expect(provider.submissions).toHaveLength(1)
  })

  it("restores from the content cache after the provider URL is gone", async () => {
    const provider = new FakeProvider({ candidates: 1 })
    const { loaded, specs } = await project({ generator: "map", assets: { anvil: { prompt: "a" } } })
    const lock = emptyLock()
    await submit(provider, loaded, (await buildPlan(specs, lock)).actionable, lock, lockPath, {
      spacingMs: 0,
    })
    await poll(provider, lock, lockPath, { intervalMs: 0, specs })
    await fetchAssets(provider, specs, lock, lockPath)

    const entry = lock.entries[lockKey("base", "anvil")]!
    await unlink(specs[0]!.outFile)
    entry.sourceUrl = null
    entry.sourceUrls = []
    const offline = Object.assign(Object.create(Object.getPrototypeOf(provider)), provider, {
      download: async () => {
        throw new Error("provider should not be called when the cache has the bytes")
      },
    })

    expect((await fetchAssets(offline, specs, lock, lockPath, { repair: true })).downloaded).toBe(1)
    expect(existsSync(specs[0]!.outFile)).toBe(true)
  })

  it("closes the loop: a full run ends with plan reporting ok", async () => {
    const provider = new FakeProvider({ candidates: 1 })
    const { loaded, specs } = await project({ generator: "map" })
    const lock = emptyLock()
    await submit(provider, loaded, (await buildPlan(specs, lock)).actionable, lock, lockPath, {
      spacingMs: 0,
    })
    await poll(provider, lock, lockPath, { intervalMs: 0 })
    await fetchAssets(provider, specs, lock, lockPath)

    const plan = await buildPlan(specs, lock)
    expect(plan.items.every((i) => i.state === "ok")).toBe(true)
    expect(plan.actionable).toHaveLength(0)
    expect(plan.cost).toBe(0)
  })
})

describe("pushTags", () => {
  it("applies manifest tags to the generated objects", async () => {
    const provider = new FakeProvider({ candidates: 1 })
    const { loaded, specs } = await project({ generator: "map", assets: { anvil: { prompt: "a" } } })
    const lock = emptyLock()
    await submit(provider, loaded, (await buildPlan(specs, lock)).actionable, lock, lockPath, {
      spacingMs: 0,
    })
    await poll(provider, lock, lockPath, { intervalMs: 0 })

    const tagged = await pushTags(provider, specs, lock)
    expect(tagged).toBe(1)
    const objectId = lock.entries[lockKey("base", "anvil")]!.objectId!
    expect(provider.tags.get(objectId)).toContain("asset:anvil")
  })

  it("is a no-op against a provider without tagging", async () => {
    const provider = new FakeProvider({ candidates: 1 })
    const untagged = Object.assign(Object.create(Object.getPrototypeOf(provider)), provider, {
      setTags: undefined,
    })
    const { loaded, specs } = await project({ generator: "map", assets: { anvil: { prompt: "a" } } })
    const lock = emptyLock()
    await submit(untagged, loaded, (await buildPlan(specs, lock)).actionable, lock, lockPath, {
      spacingMs: 0,
    })
    await poll(untagged, lock, lockPath, { intervalMs: 0 })
    await expect(pushTags(untagged, specs, lock)).resolves.toBe(0)
  })
})

describe("adopt", () => {
  it("maps a pre-existing remote asset to a local file by hash", async () => {
    const provider = new FakeProvider()
    const seeded = provider.seed({ id: "old-1", prompt: "the real prompt used upstream" })
    const bytes = await provider.download(seeded.previewUrl!)

    const { specs } = await project({ assets: { anvil: { prompt: "an anvil", category: "tools" } } })
    const spec = specs[0]!
    await writeFile(spec.outFile, bytes).catch(async () => {
      const { mkdir } = await import("node:fs/promises")
      await mkdir(path.dirname(spec.outFile), { recursive: true })
      await writeFile(spec.outFile, bytes)
    })

    const lock = emptyLock()
    const res = await adopt(provider, specs, lock, lockPath)

    expect(res.matched).toBe(1)
    const entry = lock.entries[lockKey("base", "anvil")]!
    expect(entry.objectId).toBe("old-1")
    // The upstream prompt is recovered rather than the manifest's placeholder.
    expect(entry.prompt).toBe("the real prompt used upstream")
    // Adopted work was already paid for.
    expect(entry.cost).toBe(0)
    expect(entry.outputs[0]!.path).toBe("out/tools/anvil.png")
    // Baselined against today's spec, so plan reports ok rather than stale.
    expect((await buildPlan(specs, lock)).items[0]!.state).toBe("ok")
  })

  it("reports a remote asset that matches nothing local", async () => {
    const provider = new FakeProvider()
    provider.seed({ id: "unrelated" })
    const { specs } = await project({ assets: { anvil: { prompt: "a" } } })
    const res = await adopt(provider, specs, emptyLock(), lockPath)
    expect(res.matched).toBe(0)
    expect(res.unmatchedRemote.map((o) => o.id)).toEqual(["unrelated"])
    expect(res.unmatchedLocal).toHaveLength(1)
  })

  it("does not adopt a corrupt local PNG by hash", async () => {
    const provider = new FakeProvider()
    const { specs } = await project({ assets: { anvil: { prompt: "a" } } })
    const spec = specs[0]!
    await mkdir(path.dirname(spec.outFile), { recursive: true })
    await writeFile(spec.outFile, FAKE_PNG.subarray(0, -2))

    const res = await adopt(provider, specs, emptyLock(), lockPath)
    expect(res.matched).toBe(0)
    expect(res.unmatchedLocal[0]).toMatch(/invalid PNG/)
  })

  it("fails clearly against a provider that cannot list", async () => {
    const provider = new FakeProvider({ supportsList: false })
    const { specs } = await project({ assets: { anvil: { prompt: "a" } } })
    await expect(adopt(provider, specs, emptyLock(), lockPath)).rejects.toThrow(
      /does not support listing/i,
    )
  })
})

describe("concurrent lock writes", () => {
  // Regression: parallel fetch workers each save after their own upsert. With
  // a shared `<path>.tmp` they raced — one worker's rename moved the file out
  // from under another's, failing with ENOENT and losing that write.
  it("survives many concurrent saves without losing one", async () => {
    const lock = emptyLock()
    const saves: Promise<void>[] = []
    for (let i = 0; i < 40; i++) {
      lock.entries[`base/a${i}`] = {
        styleId: "base", assetId: `a${i}`, specHash: "h", generator: "map", prompt: "p",
        width: 32, height: 32, jobId: null, reviewObjectId: null, objectId: null,
        candidateIndex: null, status: "downloaded", error: null, sourceUrl: null,
        outputs: [], submittedAt: null, downloadedAt: null, cost: 1, provider: "fake",
      }
      saves.push(saveLock(lockPath, lock))
    }
    await Promise.all(saves)
    const reloaded = await loadLock(lockPath)
    expect(Object.keys(reloaded.entries)).toHaveLength(40)
  })
})
