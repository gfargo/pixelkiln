import path from "node:path"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { loadManifest, resolveSpecs } from "../src/manifest.ts"
import { PixelLabClient } from "../src/client.ts"
import { PixelLabProvider } from "../src/providers/pixellab.ts"
import { buildPlan } from "../src/pipeline/plan.ts"
import { submit } from "../src/pipeline/submit.ts"
import { poll } from "../src/pipeline/poll.ts"
import { lockKey, type Lock } from "../src/types.ts"

let dir: string
let manifestPath: string

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "pixelkiln-1dir-batch-"))
  manifestPath = path.join(dir, "pixelkiln.manifest.json")
})
afterEach(async () => {
  vi.unstubAllGlobals()
  await rm(dir, { recursive: true, force: true })
})

async function writeProject(overrides: Record<string, unknown> = {}) {
  await writeFile(manifestPath, JSON.stringify({
    name: "batch-test",
    provider: "pixellab",
    styles: { props: { generator: "1dir", outDir: "art", size: 64 } },
    assets: {
      chest: { prompt: "a treasure chest" },
      potion: { prompt: "a health potion", batch: { of: "chest", index: 1 } },
      key: { prompt: "a rusty key", batch: { of: "chest", index: 2 } },
    },
    ...overrides,
  }))
  return loadManifest(manifestPath)
}

describe("manifest resolution", () => {
  it("elects a leader from its members and builds itemDescriptions in index order", async () => {
    const loaded = await writeProject()
    const specs = await resolveSpecs(loaded)
    const chest = specs.find((s) => s.assetId === "chest")!
    const potion = specs.find((s) => s.assetId === "potion")!
    const key = specs.find((s) => s.assetId === "key")!

    expect(chest.batch).toMatchObject({
      role: "leader",
      itemDescriptions: ["a treasure chest", "a health potion", "a rusty key"],
      memberAssetIds: ["potion", "key"],
    })
    expect(potion.batch).toMatchObject({ role: "member", index: 1, leaderAssetId: "chest" })
    expect(key.batch).toMatchObject({ role: "member", index: 2, leaderAssetId: "chest" })
    expect(potion.batch!.itemDescriptions).toEqual(chest.batch!.itemDescriptions)
  })

  it("rejects a batch naming itself as its own leader", async () => {
    const loaded = await writeProject({
      assets: { chest: { prompt: "a treasure chest", batch: { of: "chest", index: 1 } } },
    })
    await expect(resolveSpecs(loaded)).rejects.toThrow(/a batch cannot name itself as its own leader/)
  })

  it("rejects a leader that isn't a 1dir asset", async () => {
    const loaded = await writeProject({
      styles: {
        props: { generator: "1dir", outDir: "art", size: 64 },
        cast: { generator: "character", outDir: "cast", size: 64, mode: "v3" },
      },
      assets: {
        chest: { prompt: "a hero", styles: ["cast"] },
        potion: { prompt: "a health potion", styles: ["cast"], batch: { of: "chest", index: 1 } },
      },
    })
    await expect(resolveSpecs(loaded)).rejects.toThrow(/only a 1dir asset can lead a batch/)
  })

  it("rejects duplicate and non-contiguous indices", async () => {
    const dupe = await writeProject({
      assets: {
        chest: { prompt: "a treasure chest" },
        potion: { prompt: "a health potion", batch: { of: "chest", index: 1 } },
        key: { prompt: "a rusty key", batch: { of: "chest", index: 1 } },
      },
    })
    await expect(resolveSpecs(dupe)).rejects.toThrow(/two batch members both claim index 1/)

    const gap = await writeProject({
      assets: {
        chest: { prompt: "a treasure chest" },
        potion: { prompt: "a health potion", batch: { of: "chest", index: 1 } },
        key: { prompt: "a rusty key", batch: { of: "chest", index: 3 } },
      },
    })
    await expect(resolveSpecs(gap)).rejects.toThrow(/batch member indices must be 1..2 with no gaps/)
  })

  it("rejects a member whose own size differs from the leader's", async () => {
    const loaded = await writeProject({
      assets: {
        chest: { prompt: "a treasure chest" },
        potion: { prompt: "a health potion", size: 32, batch: { of: "chest", index: 1 } },
      },
    })
    await expect(resolveSpecs(loaded)).rejects.toThrow(/batch members share the leader's canvas size/)
  })

  it("rejects a batch larger than the size's candidate count", async () => {
    // 64px -> candidateCount 16, so 1 leader + 16 members (17 total) is one over.
    const assets: Record<string, unknown> = { chest: { prompt: "item 0" } }
    for (let i = 1; i <= 16; i++) {
      assets[`item${i}`] = { prompt: `item ${i}`, batch: { of: "chest", index: i } }
    }
    const loaded = await writeProject({ assets })
    await expect(resolveSpecs(loaded)).rejects.toThrow(/a 64px batch holds at most 16 items/)
  })

  it("couples every sibling's hash to the whole group's descriptions", async () => {
    const first = await resolveSpecs(await writeProject())
    const firstChestHash = first.find((s) => s.assetId === "chest")!.specHash
    const firstPotionHash = first.find((s) => s.assetId === "potion")!.specHash
    const firstKeyHash = first.find((s) => s.assetId === "key")!.specHash

    // Changing only the "key" member's prompt must also change "chest" and
    // "potion"'s hashes, since they all ride on one submitted job together.
    const changed = await resolveSpecs(await writeProject({
      assets: {
        chest: { prompt: "a treasure chest" },
        potion: { prompt: "a health potion", batch: { of: "chest", index: 1 } },
        key: { prompt: "a rustier key", batch: { of: "chest", index: 2 } },
      },
    }))
    expect(changed.find((s) => s.assetId === "chest")!.specHash).not.toBe(firstChestHash)
    expect(changed.find((s) => s.assetId === "potion")!.specHash).not.toBe(firstPotionHash)
    expect(changed.find((s) => s.assetId === "key")!.specHash).not.toBe(firstKeyHash)
  })

  it("prices only the leader; members cost nothing", async () => {
    const specs = await resolveSpecs(await writeProject())
    const chest = specs.find((s) => s.assetId === "chest")!
    const potion = specs.find((s) => s.assetId === "potion")!
    const key = specs.find((s) => s.assetId === "key")!
    expect(chest.cost).toBeGreaterThan(0)
    expect(potion.cost).toBe(0)
    expect(key.cost).toBe(0)
  })

  it("rejects batch alongside state, animation, mirror, or revision", async () => {
    await expect(writeProject({
      assets: {
        chest: { prompt: "a treasure chest" },
        potion: {
          prompt: "a health potion",
          batch: { of: "chest", index: 1 },
          mirror: "chest",
        },
      },
    })).rejects.toThrow(/mirror and batch are mutually exclusive/)
  })
})

describe("PixelLabClient: the batch wire", () => {
  afterEach(() => vi.unstubAllGlobals())

  it("sends item_descriptions for a batch leader, omitting it otherwise", async () => {
    let body: Record<string, unknown> | null = null
    vi.stubGlobal("fetch", vi.fn(async (input: string, init?: RequestInit) => {
      body = init?.body ? JSON.parse(String(init.body)) : null
      return new Response(JSON.stringify({ object_id: "obj-1", status: "processing", n_frames: 1, background_job_id: "bg-1" }), { status: 202 })
    }))
    const client = new PixelLabClient("key")
    await client.create1Direction({ description: "a treasure chest", size: 64, view: "top-down", itemDescriptions: ["a treasure chest", "a health potion", "a rusty key"] })
    expect((body as unknown as { item_descriptions: string[] }).item_descriptions).toEqual(["a treasure chest", "a health potion", "a rusty key"])

    await client.create1Direction({ description: "a plain icon", size: 64, view: "top-down" })
    expect(body).not.toHaveProperty("item_descriptions")
  })
})

describe("PixelLab provider: batch submit and poll", () => {
  it("makes exactly one create-1-direction-object call for the whole batch and fans the job out to every member", async () => {
    const loaded = await writeProject()
    const specs = await resolveSpecs(loaded)
    const lock: Lock = { version: 2, entries: {} }
    const lockPath = path.join(dir, "pixelkiln.lock.json")
    const plan = await buildPlan(specs, lock)
    expect(plan.actionable).toHaveLength(3)

    let submitCalls = 0
    let submitBody: Record<string, unknown> | null = null
    vi.stubGlobal("fetch", vi.fn(async (input: string, init?: RequestInit) => {
      const url = new URL(String(input))
      if (url.pathname === "/v2/create-1-direction-object") {
        submitCalls++
        submitBody = init?.body ? JSON.parse(String(init.body)) : null
        return new Response(JSON.stringify({ object_id: "obj-1", status: "processing", n_frames: 1, background_job_id: "bg-1" }), { status: 202 })
      }
      if (url.pathname === "/v2/objects/obj-1") {
        return new Response(JSON.stringify({
          id: "obj-1", prompt: "a treasure chest", size: { width: 64, height: 64 }, directions: 1,
          created_at: "now", rotation_urls: {}, status: "review",
          frame_urls: Array.from({ length: 16 }, (_, i) => `https://cdn.test/obj-1/frame-${i}.png`),
        }), { status: 200 })
      }
      if (url.pathname === "/v2/background-jobs/bg-1") {
        // billedForJob's lookup; a clean 200 so it never engages the shared
        // retry-with-backoff logic that a thrown/network-shaped failure would.
        return new Response(JSON.stringify({ id: "bg-1", status: "completed", created_at: "now" }), { status: 200 })
      }
      throw new Error(`unexpected request: ${init?.method ?? "GET"} ${url.pathname}`)
    }))

    const provider = new PixelLabProvider(new PixelLabClient("key"))
    const result = await submit(provider, loaded, plan.actionable, lock, lockPath, { spacingMs: 0 })
    expect(submitCalls).toBe(1)
    expect(submitBody).toMatchObject({
      description: "a treasure chest",
      item_descriptions: ["a treasure chest", "a health potion", "a rusty key"],
    })
    // Only the leader's own estimate is billed; two members ride for free.
    expect(result.submitted).toBe(3)
    expect(result.spent).toBe(specs.find((s) => s.assetId === "chest")!.cost)

    for (const assetId of ["chest", "potion", "key"]) {
      expect(lock.entries[lockKey("props", assetId)]).toMatchObject({ jobId: "obj-1", status: "processing" })
    }
    expect(lock.entries[lockKey("props", "potion")]!.batch).toMatchObject({ role: "member", leaderAssetId: "chest", index: 1 })
    expect(lock.entries[lockKey("props", "key")]!.batch).toMatchObject({ role: "member", leaderAssetId: "chest", index: 2 })

    await poll(provider, lock, lockPath, { intervalMs: 0, specs })
    for (const assetId of ["chest", "potion", "key"]) {
      expect(lock.entries[lockKey("props", assetId)]).toMatchObject({ status: "review", reviewObjectId: "obj-1" })
    }
  })

  it("refuses to submit a leader whose members are not in the same batch (e.g. --only excluded one)", async () => {
    const loaded = await writeProject()
    const specs = await resolveSpecs(loaded)
    const lock: Lock = { version: 2, entries: {} }
    const lockPath = path.join(dir, "pixelkiln.lock.json")
    const plan = await buildPlan(specs, lock)
    const leaderOnly = plan.actionable.filter((item) => item.spec.assetId === "chest")

    vi.stubGlobal("fetch", vi.fn(async () => {
      throw new Error("should not reach the network: the pre-flight check must refuse first")
    }))
    const provider = new PixelLabProvider(new PixelLabClient("key"))
    await expect(submit(provider, loaded, leaderOnly, lock, lockPath, { spacingMs: 0 }))
      .rejects.toThrow(/batch member\(s\) potion, key must be submitted in the same run as this leader/)
  })

  it("refuses a member spec that somehow reaches provider.submit() directly", async () => {
    const loaded = await writeProject()
    const specs = await resolveSpecs(loaded)
    const potion = specs.find((s) => s.assetId === "potion")!
    const provider = new PixelLabProvider(new PixelLabClient("key"))
    await expect(provider.submit(potion, [])).rejects.toThrow(/a batch member cannot submit on its own/)
  })
})
