import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"
import { existsSync } from "node:fs"
import { mkdtemp, readFile, rm, unlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { FakeProvider } from "../src/providers/fake.ts"
import { registerProvider } from "../src/providers/registry.ts"
import { parseArgs } from "../src/cli/args.ts"
import { runGenerate } from "../src/cli/commands/generate.ts"
import { openProject } from "../src/project.ts"
import { loadManifest, resolveSpecs } from "../src/manifest.ts"
import { flipHorizontal, mirroredRole, mirrorSourceHash } from "../src/pipeline/mirror.ts"
import { packStyle } from "../src/pipeline/pack.ts"
import { decodePng, encodeRgbaPng } from "../src/png.ts"
import { sha256 } from "../src/hash.ts"
import { saveLock, upsert } from "../src/lock.ts"
import type { Provider } from "../src/provider.ts"

const PROVIDER = "mirror-fake"
let fake: FakeProvider
let dir: string
let quiet: ReturnType<typeof vi.spyOn>

beforeAll(() => {
  registerProvider({ id: PROVIDER, create: () => fake as Provider })
})
beforeEach(async () => {
  fake = new FakeProvider({ candidates: 1 })
  Object.defineProperty(fake, "id", { value: PROVIDER })
  dir = await mkdtemp(path.join(tmpdir(), "pixelkiln-mirror-"))
  quiet = vi.spyOn(console, "log").mockImplementation(() => {})
})
afterEach(async () => {
  quiet.mockRestore()
  process.exitCode = undefined
  await rm(dir, { recursive: true, force: true })
})

const lines = () => quiet.mock.calls.map((c) => String(c[0] ?? "")).join("\n")

/** A base, a walk loop facing west, and the east loop as its mirror. */
async function cast(assets: Record<string, unknown> = {}) {
  const manifestPath = path.join(dir, "pixelkiln.manifest.json")
  await writeFile(manifestPath, JSON.stringify({
    name: "mirror",
    provider: PROVIDER,
    styles: { cast: { generator: "character", outDir: "art", size: 64 } },
    assets: {
      hero: { prompt: "a hero" },
      "hero.walk.west": { prompt: "", animation: { of: "hero", template: "walk", direction: "west", fps: 10 } },
      "hero.walk.east": { mirror: "hero.walk.west" },
      ...assets,
    },
  }))
  return manifestPath
}

const gen = (manifestPath: string, ...flags: string[]) =>
  runGenerate(parseArgs(["gen", "--manifest", manifestPath, "--yes", "--no-open", "--budget", "200", ...flags]))

const states = async (manifestPath: string) =>
  (await (await openProject(manifestPath, { env: false })).plan()).items.map((i) => `${i.key}=${i.state}`)

describe("flipHorizontal", () => {
  it("reverses every row and keeps the alpha channel", () => {
    // 3x2: each pixel's red channel is its column, alpha its row.
    const rgba = Buffer.alloc(3 * 2 * 4)
    for (let y = 0; y < 2; y++) for (let x = 0; x < 3; x++) rgba.set([x * 40, 0, 0, 100 + y * 100], (y * 3 + x) * 4)
    const flipped = decodePng(flipHorizontal(encodeRgbaPng(3, 2, rgba)))
    expect([flipped.width, flipped.height]).toEqual([3, 2])
    for (let y = 0; y < 2; y++) {
      expect([...flipped.pixels.subarray(y * 12, y * 12 + 12)].filter((_v, i) => i % 4 === 0)).toEqual([80, 40, 0])
      expect([...flipped.pixels.subarray(y * 12, y * 12 + 12)].filter((_v, i) => i % 4 === 3)).toEqual([100 + y * 100, 100 + y * 100, 100 + y * 100])
    }
  })

  it("swaps direction roles and leaves frame roles alone", () => {
    expect(mirroredRole("west")).toBe("east")
    expect(mirroredRole("north-east")).toBe("north-west")
    expect(mirroredRole("south")).toBe("south")
    expect(mirroredRole("frame-03")).toBe("frame-03")
    expect(mirroredRole(undefined)).toBeUndefined()
  })
})

describe("mirror assets", () => {
  it("resolve as the source's shape facing the other way, at no cost, and are refused where a flip means nothing", async () => {
    const manifestPath = await cast({ "hero.other": { mirror: "hero" } })
    const project = await openProject(manifestPath, { env: false })
    const east = project.specs.find((s) => s.assetId === "hero.walk.east")!
    expect(east).toMatchObject({ cost: 0, prompt: "", generator: "character", mirror: { sourceAssetId: "hero.walk.west" } })
    expect(east.character).toMatchObject({ kind: "animation", parentAssetId: "hero", animation: { direction: "east", template: "walk", fps: 10 } })
    expect(east.specHash).not.toBe(project.specs.find((s) => s.assetId === "hero.walk.west")!.specHash)
    expect(project.specs.find((s) => s.assetId === "hero.other")!.character).toMatchObject({ kind: "base", directions: 8 })
    const plan = await project.plan()
    expect(plan.items.map((i) => `${i.key}=${i.state}`)).toEqual([
      "cast/hero=missing", "cast/hero.walk.west=blocked", "cast/hero.walk.east=blocked", "cast/hero.other=blocked",
    ])
    expect(plan.items.find((i) => i.key === "cast/hero.walk.east")!.reason).toMatch(/mirror source cast\/hero.walk.west is not ready/)

    const refused = async (assets: Record<string, unknown>, styles?: Record<string, unknown>) => {
      const file = path.join(dir, "bad.manifest.json")
      await writeFile(file, JSON.stringify({ name: "bad", provider: styles ? "pixellab" : PROVIDER, styles: styles ?? { cast: { generator: "character", outDir: "art" } }, assets }))
      return resolveSpecs(await loadManifest(file))
    }
    await expect(refused({ hero: { prompt: "h" }, "hero.idle": { prompt: "", animation: { of: "hero", template: "breathing-idle" } }, "hero.idle.2": { mirror: "hero.idle" } }))
      .rejects.toThrow(/mirroring hero.idle gives another south-facing loop/)
    await expect(refused({ a: { mirror: "a" } })).rejects.toThrow(/cannot mirror itself/)
    await expect(refused({ a: { prompt: "a" }, b: { mirror: "a" } }, { ground: { generator: "tiles", outDir: "t" } })).rejects.toThrow(/tile set cannot be mirrored/)
    await expect(refused({ a: { prompt: "a" }, b: { mirror: "missing" } })).rejects.toThrow(/"missing" is not available in style "cast"/)
    await expect(refused({ a: {} })).rejects.toThrow(/prompt/)
    await expect(refused({ a: { prompt: "a" }, b: { mirror: "a", source: "x.png" } })).rejects.toThrow(/cannot also declare a source/)
  })

  it("flips the source's frames in the wave after it lands, records the flip, and packs it as a loop", async () => {
    const manifestPath = await cast()
    await gen(manifestPath)
    expect(await states(manifestPath)).toEqual(["cast/hero=ok", "cast/hero.walk.west=ok", "cast/hero.walk.east=ok"])
    expect(fake.submissions.map((s) => s.assetId)).toEqual(["hero", "hero.walk.west"])
    expect(lines()).toContain("mirror  cast/hero.walk.east ← cast/hero.walk.west (8 files flipped, no generation cost)")

    const project = await openProject(manifestPath, { env: false })
    const west = project.lock.entries["cast/hero.walk.west"]!
    const east = project.lock.entries["cast/hero.walk.east"]!
    expect(east).toMatchObject({
      status: "downloaded", cost: 0, jobId: null, objectId: null, provider: PROVIDER,
      mirror: { sourceAssetId: "hero.walk.west", sourceSha256: mirrorSourceHash(west) },
    })
    expect(east.outputs.map((o) => o.role)).toEqual(west.outputs.map((o) => o.role))
    expect(east.providerMetadata[PROVIDER]).toEqual({ frameSet: { fps: 10, count: 8 }, character: { kind: "animation", mirrorOf: "hero.walk.west", direction: "east" } })
    for (const [index, output] of east.outputs.entries()) {
      const flipped = flipHorizontal(await readFile(path.join(dir, west.outputs[index]!.path)))
      expect(sha256(await readFile(path.join(dir, output.path)))).toBe(sha256(flipped))
      expect(output.sha256).toBe(sha256(flipped))
    }
    expect(existsSync(path.join(dir, "art", "hero.walk.east-frame-07.png"))).toBe(true)

    const sheet = packStyle(project.lock, "cast", dir)
    const loop = sheet.atlas.sets.find((set) => set.id === "hero.walk.east")
    expect(loop).toMatchObject({ kind: "frames", fps: 10 })
    expect(loop!.frames).toHaveLength(8)
  })

  it("goes stale when the source is regenerated or a member goes missing, and orphaned when hand-edited", async () => {
    const manifestPath = await cast()
    await gen(manifestPath)
    const project = await openProject(manifestPath, { env: false })

    // The source's record moved on since the flip (a re-roll, a restore).
    const east = project.lock.entries["cast/hero.walk.east"]!
    upsert(project.lock, "cast/hero.walk.east", { mirror: { sourceAssetId: "hero.walk.west", sourceSha256: "f".repeat(64) } })
    await saveLock(project.lockPath, project.lock)
    let plan = await (await openProject(manifestPath, { env: false })).plan()
    expect(plan.items.find((i) => i.key === "cast/hero.walk.east")).toMatchObject({ state: "stale", reason: "mirror source hero.walk.west changed; flip it again (no generation cost)" })
    // A modified source is not something to flip; the mirror waits on it.
    const west = project.lock.entries["cast/hero.walk.west"]!
    upsert(project.lock, "cast/hero.walk.west", { outputs: west.outputs.map((o, i) => (i === 3 ? { ...o, sha256: "f".repeat(64) } : o)) })
    await saveLock(project.lockPath, project.lock)
    plan = await (await openProject(manifestPath, { env: false })).plan()
    expect(plan.items.find((i) => i.key === "cast/hero.walk.west")).toMatchObject({ state: "orphaned" })
    expect(plan.items.find((i) => i.key === "cast/hero.walk.east")).toMatchObject({ state: "blocked", reason: expect.stringMatching(/mirror source cast\/hero.walk.west is not ready: parent output was modified/) })
    // Records back in place: the mirror is current again.
    upsert(project.lock, "cast/hero.walk.west", { outputs: west.outputs })
    upsert(project.lock, "cast/hero.walk.east", { mirror: east.mirror })
    await saveLock(project.lockPath, project.lock)
    expect(await states(manifestPath)).toEqual(["cast/hero=ok", "cast/hero.walk.west=ok", "cast/hero.walk.east=ok"])

    // A missing member is made again, for free.
    await unlink(path.join(dir, "art", "hero.walk.east-frame-02.png"))
    plan = await (await openProject(manifestPath, { env: false })).plan()
    expect(plan.items.find((i) => i.key === "cast/hero.walk.east")).toMatchObject({ state: "stale", reason: "mirror output missing on disk; flip it again (no generation cost)" })
    expect(plan.groups.reduce((sum, g) => sum + g.cost, 0)).toBe(0)
    fake.submissions.length = 0
    await gen(manifestPath)
    expect(fake.submissions).toHaveLength(0)
    expect(existsSync(path.join(dir, "art", "hero.walk.east-frame-02.png"))).toBe(true)
    expect(await states(manifestPath)).toEqual(["cast/hero=ok", "cast/hero.walk.west=ok", "cast/hero.walk.east=ok"])

    // A hand edit is respected the way it is for generated art.
    await writeFile(path.join(dir, "art", "hero.walk.east-frame-02.png"), encodeRgbaPng(1, 1, Buffer.from([1, 2, 3, 255])))
    plan = await (await openProject(manifestPath, { env: false })).plan()
    expect(plan.items.find((i) => i.key === "cast/hero.walk.east")).toMatchObject({ state: "orphaned", reason: "output modified since download" })
  })

  it("re-flips after its source is regenerated, in a later wave of the same run", async () => {
    const manifestPath = await cast()
    await gen(manifestPath)
    const before = (await openProject(manifestPath, { env: false })).lock.entries["cast/hero.walk.east"]!
    fake.submissions.length = 0
    quiet.mockClear()
    await gen(manifestPath, "--force")
    // Wave 1 forces the base; the loop follows; the mirror flips last.
    expect(fake.submissions.map((s) => s.assetId)).toEqual(["hero", "hero.walk.west"])
    expect(lines()).toContain("wave 3: 1 asset(s) became actionable")
    expect(await states(manifestPath)).toEqual(["cast/hero=ok", "cast/hero.walk.west=ok", "cast/hero.walk.east=ok"])
    const after = (await openProject(manifestPath, { env: false })).lock.entries["cast/hero.walk.east"]!
    // The fake's frames differ only past the image data, so the flipped
    // pixels are the same; the record shows which source generation it is from.
    expect(after.mirror!.sourceSha256).not.toBe(before.mirror!.sourceSha256)
    expect(after.mirror!.sourceSha256).toBe(mirrorSourceHash((await openProject(manifestPath, { env: false })).lock.entries["cast/hero.walk.west"]!))
  })

  it("mirrors a direction set with its sides swapped, listed clockwise from south", async () => {
    const manifestPath = await cast({ "hero.other": { mirror: "hero" } })
    await gen(manifestPath)
    const project = await openProject(manifestPath, { env: false })
    const other = project.lock.entries["cast/hero.other"]!
    expect(other.outputs.map((o) => o.role)).toEqual(["south", "south-east", "east", "north-east", "north", "north-west", "west", "south-west"])
    const hero = project.lock.entries["cast/hero"]!
    const westOfHero = hero.outputs.find((o) => o.role === "west")!
    const eastOfOther = other.outputs.find((o) => o.role === "east")!
    expect(eastOfOther.sha256).toBe(sha256(flipHorizontal(await readFile(path.join(dir, westOfHero.path)))))
    expect(other.providerMetadata[PROVIDER]).toEqual({ character: { kind: "base", mirrorOf: "hero" } })
  })
})
