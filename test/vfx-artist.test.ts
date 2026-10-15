import path from "node:path"
import os from "node:os"
import { randomUUID } from "node:crypto"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { PixelLabClient } from "../src/client.ts"
import { parseArgs } from "../src/cli/args.ts"
import { runVfx } from "../src/cli/commands/pixellab-utils.ts"
import { loadManifest, resolveSpecs } from "../src/manifest.ts"
import { buildPlan } from "../src/pipeline/plan.ts"
import { fetchAssets } from "../src/pipeline/fetch.ts"
import { poll } from "../src/pipeline/poll.ts"
import { submit } from "../src/pipeline/submit.ts"
import {
  makeVfxWithArtist,
  parseVfxArtistResult,
  readVfxConversation,
  vfxArtistCeiling,
  vfxArtistFiles,
  vfxArtistQuote,
} from "../src/pixellab-vfx.ts"
import { decodePng, encodeRgbaPng } from "../src/png.ts"
import { PixelLabProvider } from "../src/providers/pixellab.ts"
import type { Lock } from "../src/types.ts"

const JOB = "0b1c4f3e-9d58-4c2a-8f43-5a2e0d6c7b11"
const EFFECT = "807f8698-6a03-480a-bc3e-40f051cb7aae"
const FILES = "https://cdn.pixellab.ai/vfx/807f8698"

/** Three 4x4 frames side by side, each a different shade, so slices are checkable. */
const SHEET = (() => {
  const pixels = Buffer.alloc(12 * 4 * 4)
  for (let y = 0; y < 4; y++) for (let x = 0; x < 12; x++) pixels.fill([40, 120, 200][Math.floor(x / 4)]!, (y * 12 + x) * 4, (y * 12 + x + 1) * 4)
  return encodeRgbaPng(12, 4, pixels)
})()
const ATLAS = {
  frames: [0, 1, 2].map((index) => ({ frame: { x: index * 4, y: 0, w: 4, h: 4 }, duration: 100 })),
  meta: { image: "zap.png", anchor: { kind: "ground", x: 2, y: 3 } },
}

/**
 * A completed `/vfx` job's `last_response`, built from PixelLab's OpenAPI
 * description; no live job has been seen. `files` is a name→URL map here,
 * one of the shapes the parser accepts.
 */
function delivered(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    effect_id: EFFECT,
    name: "zap",
    edit_url: `https://pixellab.ai/create-vfx?effect=${EFFECT}`,
    message: "A blue bolt strikes the ground and throws sparks.",
    canvas: { w: 4, h: 4 },
    frames: 3,
    fps: 10,
    loop: false,
    anchor: { kind: "ground", x: 2, y: 3 },
    parts: [{ name: "lightning_bolt" }, { name: "spark_burst" }],
    conversation: "opaque-conversation",
    files: {
      "zap.gif": `${FILES}/zap.gif`,
      "zap.png": `${FILES}/zap.png`,
      "zap.json": `${FILES}/zap.json`,
      "zap-normals.png": `${FILES}/zap-normals.png`,
    },
    ...overrides,
  }
}

interface Api {
  posts: Array<Record<string, unknown>>
  /** Every job id handed out; each is new, as PixelLab's are, so the frame cache never carries over. */
  jobs: string[]
  jobPolls: number
  submitStatuses: number[]
  job: (id: string) => Record<string, unknown>
}

let dir: string
let api: Api
beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "pixelkiln-vfx-artist-"))
  api = {
    posts: [],
    jobs: [],
    jobPolls: 0,
    submitStatuses: [],
    job: (id) => ({ id, status: "completed", last_response: delivered(), usage: { type: "generations", generations: 1 } }),
  }
  const polled = new Set<string>()
  vi.stubGlobal("fetch", vi.fn(async (input: string, init?: RequestInit) => {
    const url = String(input)
    if (url === "https://api.pixellab.ai/v2/vfx" && init?.method === "POST") {
      const status = api.submitStatuses.shift() ?? 202
      if (status !== 202) return new Response("busy", { status })
      api.posts.push(JSON.parse(String(init.body)))
      const id = randomUUID()
      api.jobs.push(id)
      return new Response(JSON.stringify({ background_job_id: id, status: "processing", quoted_generations: 1, usage: null }), { status: 202 })
    }
    const job = /\/v2\/background-jobs\/([^/]+)$/.exec(url)?.[1]
    if (job && api.jobs.includes(job)) {
      api.jobPolls++
      // Each job is still running the first time it is asked about.
      const first = !polled.has(job)
      polled.add(job)
      return new Response(JSON.stringify(first ? { id: job, status: "processing" } : api.job(job)), { status: 200 })
    }
    if (url === `${FILES}/zap.png`) return new Response(SHEET, { status: 200 })
    if (url === `${FILES}/zap.json`) return new Response(JSON.stringify(ATLAS), { status: 200 })
    if (url.startsWith(FILES)) return new Response(path.basename(url), { status: 200 })
    return new Response("not found", { status: 404 })
  }))
})
afterEach(async () => {
  vi.unstubAllGlobals()
  await rm(dir, { recursive: true, force: true })
})

async function project(assets: Record<string, unknown>) {
  await writeFile(path.join(dir, "m.json"), JSON.stringify({ name: "fx-test", styles: { fx: { outDir: "art/fx", generator: "vfx" } }, assets }))
  return loadManifest(path.join(dir, "m.json"))
}

describe("the VFX artist's price", () => {
  it("follows PixelLab's table by artist, sprite size, and change", () => {
    expect([vfxArtistQuote("lite", "none"), vfxArtistQuote("lite", 128), vfxArtistQuote("lite", 129), vfxArtistQuote("lite", 512)]).toEqual([1, 1, 3, 5])
    expect([vfxArtistQuote("pro", "none"), vfxArtistQuote("pro", 64), vfxArtistQuote("pro", 256), vfxArtistQuote("pro", 300)]).toEqual([6, 8, 14, 28])
    expect([vfxArtistQuote("lite", "none", true), vfxArtistQuote("lite", 200, true), vfxArtistQuote("pro", 100, true), vfxArtistQuote("pro", 512, true)])
      .toEqual([1, 2, 4, 8])
    // A sprite of unknown size is priced at the top tier.
    expect(vfxArtistQuote("pro", "unknown")).toBe(28)
    expect(vfxArtistCeiling(5)).toBe(10)
  })

  it("plans twice the quote, sized by the sprite, and the top tier for a sprite not drawn yet", async () => {
    await writeFile(path.join(dir, "small.png"), encodeRgbaPng(64, 32, Buffer.alloc(64 * 32 * 4)))
    await writeFile(path.join(dir, "mid.png"), encodeRgbaPng(200, 8, Buffer.alloc(200 * 8 * 4)))
    const specs = await resolveSpecs(await project({
      plain: { vfx: { description: "a blue lightning strike" } },
      pro: { vfx: { description: "a blue lightning strike", artist: "pro" } },
      small: { vfx: { description: "an aura", artist: "pro", sprite: "small.png" } },
      mid: { vfx: { description: "an aura", sprite: "mid.png" } },
      later: { vfx: { description: "an aura", sprite: "art/chars/hero.png" } },
      free: { vfx: { preset: "explosion" } },
    }), { provider: PixelLabProvider.forOffline() })
    const cost = Object.fromEntries(specs.map((spec) => [spec.assetId, spec.cost]))
    expect(cost).toEqual({ plain: 2, pro: 12, small: 16, mid: 6, later: 10, free: 0 })
    expect(specs.every((spec) => spec.costUnit === "generations")).toBe(true)
  })
})

describe("a vfx description in the manifest", () => {
  it("is exclusive with the workbench's settings and takes only a local PNG sprite", async () => {
    await expect(project({ zap: { vfx: { description: "zap", preset: "explosion" } } })).rejects.toThrow(/takes no preset/)
    await expect(project({ zap: { vfx: { description: "zap", parts: [{ name: "spark_burst" }] } } })).rejects.toThrow(/takes no parts/)
    await expect(project({ zap: { vfx: { description: "zap", fps: 12 } } })).rejects.toThrow(/takes no fps/)
    await expect(project({ zap: { vfx: { description: "zap", sprite: "character:abc:south" } } })).rejects.toThrow(/not a PixelLab reference/)
    await expect(project({ zap: { vfx: { preset: "explosion", artist: "pro" } } })).rejects.toThrow(/add a description/)
    await expect(project({ zap: { vfx: { description: "zap", name: "x".repeat(81) } } })).rejects.toThrow(/at most 80/)

    await writeFile(path.join(dir, "big.png"), encodeRgbaPng(520, 4, Buffer.alloc(520 * 4 * 4)))
    await expect(resolveSpecs(await project({ zap: { vfx: { description: "zap", sprite: "big.png" } } })))
      .rejects.toThrow(/takes up to 512x512/)
    const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x00, 0x04, 0x00, 0x04, 0x03, 0x01, 0x22, 0x00, 0x02, 0x11, 0x01, 0x03, 0x11, 0x01, 0xff, 0xd9])
    await writeFile(path.join(dir, "hero.jpg"), jpeg)
    await expect(resolveSpecs(await project({ zap: { vfx: { description: "zap", sprite: "hero.jpg" } } }))).rejects.toThrow(/must be PNG/)
  })

  it("adds description, artist, and sprite bytes to identity without moving a workbench effect's hash", async () => {
    await writeFile(path.join(dir, "a.png"), encodeRgbaPng(4, 4, Buffer.alloc(64, 1)))
    const hash = async (vfx: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
      (await resolveSpecs(await project({ zap: { vfx, ...extra } })))[0]!.specHash
    // Pinned from the hash code before the artist existed: a workbench effect must keep it.
    expect(await hash({ preset: "explosion", parts: [{ name: "scorch_mark" }], fps: 12 })).toBe(
      "0dec735595d5c5b3d05596043c5623a57dbc2498037a2f8c612470ca63f0ea8b",
    )
    const base = await hash({ description: "a blue lightning strike" })
    expect(await hash({ description: "a blue lightning strike", artist: "lite" })).toBe(base)
    expect(await hash({ description: "a blue lightning strike", name: "Zap" }, { prompt: "a label" })).toBe(base)
    expect(await hash({ description: "a blue lightning strike", artist: "pro" })).not.toBe(base)
    expect(await hash({ description: "a red lightning strike" })).not.toBe(base)
    const withSprite = await hash({ description: "a blue lightning strike", sprite: "a.png" })
    expect(withSprite).not.toBe(base)
    await writeFile(path.join(dir, "a.png"), encodeRgbaPng(4, 4, Buffer.alloc(64, 2)))
    expect(await hash({ description: "a blue lightning strike", sprite: "a.png" })).not.toBe(withSprite)
  })
})

describe("reading a delivered effect", () => {
  it("reads files as a URL list, a record list, or a name map, and never takes the normal map for the sheet", () => {
    expect(vfxArtistFiles([`${FILES}/zap.gif`, `${FILES}/zap.png?v=1`])).toEqual([
      { name: "zap.gif", url: `${FILES}/zap.gif` },
      { name: "zap.png", url: `${FILES}/zap.png?v=1` },
    ])
    expect(vfxArtistFiles([{ name: "zap.json", url: `${FILES}/x` }, { filename: "zap.png", download_url: `${FILES}/y` }])).toEqual([
      { name: "zap.json", url: `${FILES}/x` },
      { name: "zap.png", url: `${FILES}/y` },
    ])
    expect(vfxArtistFiles({ gif: `${FILES}/zap.gif`, "zap.png": { url: `${FILES}/s` } }).map((file) => file.name)).toEqual(["zap.gif", "zap.png"])

    const normalsFirst = delivered({ files: [`${FILES}/zap-normals.png`, `${FILES}/zap.png`, `${FILES}/zap-game.zip`] })
    const result = parseVfxArtistResult(normalsFirst, JOB)
    expect(result.sheet.name).toBe("zap.png")
    expect(result.normals?.name).toBe("zap-normals.png")
    expect(result.gamePack?.name).toBe("zap-game.zip")
    expect(result).toMatchObject({ effectId: EFFECT, width: 4, height: 4, frames: 3, fps: 10, loop: false, anchor: { kind: "ground", x: 2, y: 3 } })
  })

  it("fails naming the keys it got when the shape is not understood", () => {
    expect(() => parseVfxArtistResult(delivered({ files: { gif: `${FILES}/zap.gif` } }), JOB)).toThrow(/without a spritesheet.*files: \{"gif"/)
    expect(() => parseVfxArtistResult({ result: {} }, JOB)).toThrow(/without an effect_id \(last_response keys: result/)
  })
})

describe("the PixelLab provider and a vfx description", () => {
  async function run(lock: Lock, assets: Record<string, unknown>, opts: { force?: boolean } = {}) {
    const loaded = await project(assets)
    const specs = await resolveSpecs(loaded)
    const provider = new PixelLabProvider(new PixelLabClient("key"))
    const lockPath = path.join(dir, "pixelkiln.lock.json")
    await submit(provider, loaded, (await buildPlan(specs, lock, { force: opts.force })).actionable, lock, lockPath, { spacingMs: 0 })
    const polled = await poll(provider, lock, lockPath, { intervalMs: 0, specs })
    await fetchAssets(provider, specs, lock, lockPath)
    return polled
  }

  it("posts the description over REST, waits for the job, slices the sheet, and records the bill and the effect", async () => {
    await writeFile(path.join(dir, "hero.png"), encodeRgbaPng(4, 4, Buffer.alloc(64, 7)))
    const lock: Lock = { version: 2, entries: {} }
    expect((await run(lock, { zap: { vfx: { description: "a blue lightning strike", artist: "pro", sprite: "hero.png" } } })).failed).toBe(0)

    expect(api.posts).toHaveLength(1)
    expect(api.posts[0]).toEqual({
      description: "a blue lightning strike",
      artist: "pro",
      sprite: { type: "base64", base64: (await readFile(path.join(dir, "hero.png"))).toString("base64"), format: "png" },
      name: "pixelkiln:fx/zap",
    })
    expect(api.jobPolls).toBe(2) // processing, then completed

    const entry = lock.entries["fx/zap"]!
    expect(entry).toMatchObject({ status: "downloaded", objectId: EFFECT, cost: 16, billed: { amount: 1, unit: "generations" } })
    expect(entry.outputs!.map((output) => [output.role, path.basename(output.path)])).toEqual([
      ["frame-00", "zap-frame-00.png"],
      ["frame-01", "zap-frame-01.png"],
      ["frame-02", "zap-frame-02.png"],
    ])
    const last = decodePng(await readFile(path.join(dir, "art/fx/zap-frame-02.png")))
    expect([last.width, last.height, last.pixels[0]]).toEqual([4, 4, 200])
    expect(entry.providerMetadata?.pixellab).toMatchObject({
      frameSet: { fps: 10, count: 3, loop: false },
      vfx: {
        artist: "pro",
        quotedGenerations: 1,
        effectId: EFFECT,
        editUrl: `https://pixellab.ai/create-vfx?effect=${EFFECT}`,
        anchor: { kind: "ground", x: 2, y: 3 },
        files: ["zap.gif", "zap.png", "zap.json", "zap-normals.png"],
        fileUrls: { sheet: `${FILES}/zap.png`, atlas: `${FILES}/zap.json` },
      },
    })
    // The conversation only prices a change, which a manifest never sends.
    expect(JSON.stringify(entry)).not.toContain("opaque-conversation")
    expect(JSON.stringify(entry)).not.toContain("file://")
  })

  it("retries a busy renderer (503) and regenerates as a fresh effect, recording the one it replaced", async () => {
    const lock: Lock = { version: 2, entries: {} }
    api.submitStatuses = [503]
    await run(lock, { zap: { vfx: { description: "a blue lightning strike" } } })
    expect(api.posts).toHaveLength(1)
    expect(lock.entries["fx/zap"]!.status).toBe("downloaded")

    await run(lock, { zap: { vfx: { description: "a blue lightning strike" } } }, { force: true })
    expect(api.posts).toHaveLength(2)
    expect(api.posts[1]).not.toHaveProperty("effect_id")
    expect(api.posts[1]).not.toHaveProperty("conversation")
    expect(lock.entries["fx/zap"]!.providerMetadata?.pixellab).toMatchObject({ vfx: { previousEffect: EFFECT } })
  }, 20_000)

  it("cuts the frames again from the recorded links when the local cache was cleared", async () => {
    const loaded = await project({ zap: { vfx: { description: "a blue lightning strike" } } })
    const specs = await resolveSpecs(loaded)
    const provider = new PixelLabProvider(new PixelLabClient("key"))
    const lock: Lock = { version: 2, entries: {} }
    const lockPath = path.join(dir, "pixelkiln.lock.json")
    await submit(provider, loaded, (await buildPlan(specs, lock)).actionable, lock, lockPath, { spacingMs: 0 })
    await poll(provider, lock, lockPath, { intervalMs: 0, specs })
    const jobId = lock.entries["fx/zap"]!.jobId!
    const cache = path.join(os.tmpdir(), "pixelkiln-vfx")
    for (const file of [`${jobId}.json`, `${jobId}-0.png`, `${jobId}-1.png`, `${jobId}-2.png`]) await rm(path.join(cache, file), { force: true })
    const polls = api.jobPolls
    const state = await provider.poll(jobId, "vfx", { spec: specs[0], metadata: lock.entries["fx/zap"]!.providerMetadata?.pixellab })
    expect(state).toMatchObject({ status: "ready", objectId: EFFECT })
    expect(api.jobPolls).toBe(polls)
  })

  it("fails the entry, rather than polling forever, on a delivered job it cannot read", async () => {
    api.job = (id) => ({ id, status: "completed", last_response: { effect_id: EFFECT, files: { gif: `${FILES}/zap.gif` } } })
    const lock: Lock = { version: 2, entries: {} }
    expect((await run(lock, { zap: { vfx: { description: "a blue lightning strike" } } })).failed).toBe(1)
    expect(lock.entries["fx/zap"]!.error).toMatch(/update parseVfxArtistResult/)
  })
})

describe("pixelkiln vfx --description", () => {
  it("parses --artist", () => {
    expect(parseArgs(["vfx", "--description", "a spark", "--artist", "pro", "--out", "fx/spark"]))
      .toMatchObject({ command: "vfx", subcommand: "make", description: "a spark", artist: "pro", out: "fx/spark" })
  })

  it("makes an effect, downloads every file, and keeps the conversation a change can send back", async () => {
    const client = new PixelLabClient("key")
    const out = path.join(dir, "fx", "zap")
    const res = await makeVfxWithArtist(client, {
      description: "a blue lightning strike",
      out,
      gamePack: true,
      sleep: async () => {},
    })
    expect(res).toMatchObject({ effectId: EFFECT, width: 4, height: 4, frames: 3, fps: 10, loop: false, quotedGenerations: 1 })
    expect(api.posts[0]).toEqual({ description: "a blue lightning strike", game_pack: true })
    expect(await readFile(`${out}.gif`, "utf8")).toBe("zap.gif")
    expect(await readFile(`${out}-normals.png`, "utf8")).toBe("zap-normals.png")
    expect(JSON.parse(await readFile(`${out}.json`, "utf8")).meta.image).toBe("zap.png")
    const record = JSON.parse(await readFile(`${out}.vfx.json`, "utf8"))
    expect(record).toMatchObject({ tool: "vfx", artist: "lite", effectId: EFFECT, conversation: "opaque-conversation", usage: { generations: 1 } })
    expect(await readVfxConversation(`${out}.vfx.json`, EFFECT)).toBe("opaque-conversation")
    expect(await readVfxConversation(`${out}.vfx.json`, "another")).toBeUndefined()

    await makeVfxWithArtist(client, {
      description: "make it red",
      effect: EFFECT,
      conversation: "opaque-conversation",
      out,
      force: true,
      sleep: async () => {},
    })
    expect(api.posts[1]).toEqual({ description: "make it red", effect_id: EFFECT, conversation: "opaque-conversation" })
  })

  it("prices before it sends: a dry run prints the quote and ceiling, and --budget is held to the ceiling", async () => {
    const lines: string[] = []
    vi.spyOn(console, "log").mockImplementation((line: string) => void lines.push(line))
    await writeFile(path.join(dir, "hero.png"), encodeRgbaPng(200, 100, Buffer.alloc(200 * 100 * 4)))
    const argv = ["vfx", "--description", "an aura", "--artist", "pro", "--sprite", path.join(dir, "hero.png"), "--out", path.join(dir, "aura")]
    await runVfx(parseArgs([...argv, "--dry-run"]))
    expect(lines.join("\n")).toMatch(/about 14 generations .* at most 28/)
    await expect(runVfx(parseArgs([...argv, "--budget", "20", "--dry-run"]))).rejects.toThrow(/below this effect's 28-generation ceiling/)
    await expect(runVfx(parseArgs(["vfx", "--description", "x", "--preset", "explosion", "--out", "o"]))).rejects.toThrow(/takes no --preset/)
    await expect(runVfx(parseArgs(["vfx", "--description", "x", "--sprite", "character:a:south", "--out", "o"]))).rejects.toThrow(/local PNG/)
    await expect(runVfx(parseArgs(["vfx", "--preset", "explosion", "--artist", "pro", "--out", "o"]))).rejects.toThrow(/add one/)
    expect(api.posts).toHaveLength(0)
    vi.restoreAllMocks()
  })
})
