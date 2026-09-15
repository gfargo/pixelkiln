import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest"
import { existsSync } from "node:fs"
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { FakeProvider } from "../src/providers/fake.ts"
import { registerProvider } from "../src/providers/registry.ts"
import { adoptCharacters } from "../src/pipeline/adopt-characters.ts"
import { openProject } from "../src/project.ts"
import { resolveSpecs } from "../src/manifest.ts"
import { sha256 } from "../src/hash.ts"
import type { RemoteCharacterDetail } from "../src/provider.ts"

let dir: string
let provider: FakeProvider
beforeAll(() => {
  registerProvider({ id: "fake", create: () => provider })
})
beforeEach(async () => {
  provider = new FakeProvider({ candidates: 1 })
  dir = await mkdtemp(path.join(tmpdir(), "pixelkiln-adopt-characters-"))
})
afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

const DIRS8 = ["south", "south-east", "east", "north-east", "north", "north-west", "west", "south-west"]

function character(id: string, extra: Partial<RemoteCharacterDetail> = {}): RemoteCharacterDetail {
  return {
    id,
    name: "hero",
    stateName: "Idle",
    prompt: "a hero",
    groupId: "grp-hero",
    directions: 8,
    width: 92,
    height: 92,
    createdAt: "2026-09-01T00:00:00.000Z",
    previewUrl: `fake://${id}/south.png`,
    tags: [],
    status: "completed",
    animationCount: 0,
    rotations: DIRS8.map((direction) => ({ url: `fake://${id}/${direction}.png`, role: direction })),
    animations: [],
    ...extra,
  }
}

async function project(assets: Record<string, unknown>) {
  const manifestPath = path.join(dir, "pixelkiln.manifest.json")
  await writeFile(manifestPath, JSON.stringify({
    name: "adopt-characters",
    provider: "fake",
    styles: { cast: { generator: "character", outDir: "art", size: 64 } },
    assets,
  }))
  return manifestPath
}

describe("adoptCharacters", () => {
  it("maps a base, its state, and an animation by remoteId, writing every file and keeping identities current", async () => {
    provider.characters.set("char-base", character("char-base"))
    provider.characters.set("char-sit", character("char-sit", {
      stateName: "sitting",
      animationCount: 2,
      animations: [
        { groupId: "grp-walk", name: null, type: "walk", direction: "south", frames: Array.from({ length: 6 }, (_, i) => `fake://char-sit/animations/anim-1/south/${i}.png`) },
        { groupId: "grp-spin", name: "pixelkiln:cast/hero.sit.spin", type: "custom-spinning", direction: "east", frames: Array.from({ length: 4 }, (_, i) => `fake://char-sit/animations/anim-2/east/${i}.png`) },
      ],
    }))
    const manifestPath = await project({
      hero: { prompt: "a hero", remoteId: "char-base" },
      "hero.sit": { prompt: "sitting", state: { of: "hero" }, remoteId: "char-sit" },
      "hero.sit.walk": { prompt: "", animation: { of: "hero.sit", template: "walk", direction: "south", fps: 6 }, remoteId: "char-sit#grp-walk" },
      "hero.sit.spin": { prompt: "spinning", animation: { of: "hero.sit", direction: "east" } },
    })
    const p = await openProject(manifestPath, { env: false })
    const result = await adoptCharacters(provider, p.specs, p.lock, p.lockPath, {
      resolve: () => resolveSpecs(p.loaded),
      noCache: true,
    })
    expect(result).toMatchObject({ scanned: 2, matched: 4, unmatched: [], remaining: [], differing: [] })
    expect(result.written).toHaveLength(8 + 8 + 6 + 4)
    const files = (await readdir(path.join(dir, "art"))).sort()
    expect(files).toContain("hero-south.png")
    expect(files).toContain("hero.sit-north-west.png")
    expect(files).toContain("hero.sit.walk-frame-05.png")
    expect(files).toContain("hero.sit.spin-frame-03.png")

    const fresh = await openProject(manifestPath, { env: false })
    const plan = await fresh.plan()
    expect(plan.items.map((i) => `${i.key}=${i.state}`)).toEqual([
      "cast/hero=ok", "cast/hero.sit=ok", "cast/hero.sit.walk=ok", "cast/hero.sit.spin=ok",
    ])
    const base = fresh.lock.entries["cast/hero"]!
    expect(base).toMatchObject({ status: "downloaded", objectId: "char-base", cost: 0, generator: "character" })
    expect(base.outputs.map((o) => o.role)).toEqual(DIRS8)
    expect(base.sourceUrls).toHaveLength(8)
    expect(base.providerMetadata.fake).toMatchObject({ character: { characterId: "char-base", adopted: true } })
    const walk = fresh.lock.entries["cast/hero.sit.walk"]!
    expect(walk).toMatchObject({ objectId: "char-sit#grp-walk" })
    expect(walk.providerMetadata.fake).toMatchObject({ frameSet: { fps: 6, count: 6 }, character: { animationId: "anim-1", animationGroupId: "grp-walk", direction: "south" } })
    // The spin animation had no remoteId and no local frame; the name PixelKiln gives loops matched it.
    expect(fresh.lock.entries["cast/hero.sit.spin"]).toMatchObject({ objectId: "char-sit#grp-spin" })

    // Running again maps nothing new and rewrites nothing.
    const again = await adoptCharacters(provider, fresh.specs, fresh.lock, fresh.lockPath, { resolve: () => resolveSpecs(fresh.loaded), noCache: true })
    expect(again).toMatchObject({ matched: 0, written: [], unmatched: [] })
  })

  it("matches a base by the bytes of its south file, reports what it cannot match, and lists what is left", async () => {
    provider.characters.set("char-a", character("char-a", { name: "a" }))
    provider.characters.set("char-b", character("char-b", { name: "b", groupId: "grp-b" }))
    provider.characters.set("char-c", character("char-c", { name: "c", groupId: "grp-c", animationCount: 3 }))
    const manifestPath = await project({
      a: { prompt: "a" },
      nobody: { prompt: "nobody" },
      "a.pose": { prompt: "pose", state: { of: "a" } },
    })
    await mkdir(path.join(dir, "art"), { recursive: true })
    // The south file is exactly what the account holds; another direction differs locally.
    await writeFile(path.join(dir, "art", "a-south.png"), await provider.download("fake://char-a/south.png"))
    await writeFile(path.join(dir, "art", "a-east.png"), Buffer.from("hand painted"))

    const p = await openProject(manifestPath, { env: false })
    const result = await adoptCharacters(provider, p.specs, p.lock, p.lockPath, { resolve: () => resolveSpecs(p.loaded), noCache: true })
    expect(result.matched).toBe(1)
    expect(result.differing).toEqual(["art/a-east.png"].map((f) => path.relative(process.cwd(), path.join(dir, f))))
    expect(await readFile(path.join(dir, "art", "a-east.png"), "utf8")).toBe("hand painted")
    expect(result.unmatched).toEqual([
      expect.stringMatching(/^cast\/nobody: no remoteId and no .*nobody-south\.png to match by$/),
      expect.stringMatching(/^cast\/a\.pose: no remoteId and no .*a\.pose-south\.png to match by$/),
    ])
    expect(result.remaining.map((c) => c.id)).toEqual(["char-b", "char-c"])
    expect(existsSync(path.join(dir, "art", "a-north.png"))).toBe(true)
    const fresh = await openProject(manifestPath, { env: false })
    const plan = await fresh.plan()
    // The hand-painted east file differs from the record, which is what orphaned means.
    expect(plan.items.find((i) => i.key === "cast/a")).toMatchObject({ state: "orphaned", reason: "output modified since download" })
    expect(sha256(await readFile(path.join(dir, "art", "a-south.png")))).toBe(fresh.lock.entries["cast/a"]!.outputs[0]!.sha256)
  })

  it("refuses a remoteId the account does not have, and an animation whose parent is not adopted", async () => {
    provider.characters.set("char-a", character("char-a"))
    const manifestPath = await project({
      a: { prompt: "a", remoteId: "char-missing" },
      "a.walk": { prompt: "", animation: { of: "a", template: "walk" } },
    })
    const p = await openProject(manifestPath, { env: false })
    const result = await adoptCharacters(provider, p.specs, p.lock, p.lockPath, { resolve: () => resolveSpecs(p.loaded), noCache: true })
    expect(result.matched).toBe(0)
    expect(result.unmatched).toEqual([
      "cast/a: remoteId char-missing is not a character on this account",
      "cast/a.walk: its parent cast/a is not adopted yet",
    ])
    expect(result.remaining.map((c) => c.id)).toEqual(["char-a"])
  })

  it("does nothing for a provider without characters", async () => {
    delete (provider as { listCharacters?: unknown }).listCharacters
    const manifestPath = await project({ a: { prompt: "a", remoteId: "x" } })
    const p = await openProject(manifestPath, { env: false })
    const result = await adoptCharacters(provider, p.specs, p.lock, p.lockPath, { resolve: () => resolveSpecs(p.loaded), noCache: true })
    expect(result).toMatchObject({ scanned: 0, matched: 0 })
  })
})
