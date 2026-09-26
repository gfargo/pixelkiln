import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { existsSync } from "node:fs"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { loadManifest, resolveSpecs } from "../src/manifest.ts"
import { PixelLabClient, PixelLabError } from "../src/client.ts"
import { PixelLabProvider, characterAnimationName, characterCost } from "../src/providers/pixellab.ts"
import { buildPlan, resumeActions } from "../src/pipeline/plan.ts"
import { submit } from "../src/pipeline/submit.ts"
import { poll } from "../src/pipeline/poll.ts"
import { fetchAssets, pushTags } from "../src/pipeline/fetch.ts"
import { packStyle } from "../src/pipeline/pack.ts"
import { renderGodotSpriteFrames } from "../src/pipeline/sheet-formats.ts"
import { openProject } from "../src/project.ts"
import { encodeRgbaPng } from "../src/png.ts"
import { upsert } from "../src/lock.ts"
import { sha256File } from "../src/hash.ts"
import { lockKey, type Lock, type ResolvedSpec } from "../src/types.ts"

let dir: string
beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "pixelkiln-characters-"))
})
afterEach(async () => {
  vi.unstubAllGlobals()
  await rm(dir, { recursive: true, force: true })
})

const manifestPath = () => path.join(dir, "pixelkiln.manifest.json")

async function writeManifest(overrides: { style?: Record<string, unknown>; assets?: Record<string, unknown>; extraStyles?: Record<string, unknown> } = {}) {
  await writeFile(manifestPath(), JSON.stringify({
    name: "cast-test",
    styles: {
      cast: {
        generator: "character",
        outDir: "art/characters",
        view: "side",
        size: 64,
        promptPrefix: "pixel art",
        promptSuffix: "clean lines",
        ...overrides.style,
      },
      ...overrides.extraStyles,
    },
    assets: overrides.assets ?? {
      mira: { prompt: "small young woman, dark curly hair in a bun, oversized hoodie" },
      "mira.chair_spin": { prompt: "sitting in the air with knees up, spinning", state: { of: "mira", paletteFromReference: true } },
      "mira.fireman_spin": { prompt: "spinning around the pole, knees crossed", animation: { of: "mira.chair_spin", direction: "east", frames: 8, fps: 10 } },
    },
  }))
  return manifestPath()
}

const px = (n: number, shade: number) => encodeRgbaPng(n, n, Buffer.alloc(n * n * 4, shade))

describe("manifest resolution", () => {
  it("resolves base, state, and animation shapes with their parents", async () => {
    const loaded = await loadManifest(await writeManifest())
    const specs = await resolveSpecs(loaded)
    const byId = new Map(specs.map((s) => [s.assetId, s]))
    const base = byId.get("mira")!
    expect(base.character).toMatchObject({ kind: "base", mode: "standard", directions: 8, template: "mannequin" })
    expect(base.prompt).toBe("pixel art, small young woman, dark curly hair in a bun, oversized hoodie, clean lines")
    expect(base.view).toBe("side")
    expect(base.width).toBe(64)

    const state = byId.get("mira.chair_spin")!
    expect(state.character).toMatchObject({ kind: "state", parentAssetId: "mira", directions: 8, state: { paletteFromReference: true } })
    // The edit goes to PixelLab as written; the base already carries the look.
    expect(state.prompt).toBe("sitting in the air with knees up, spinning")
    expect(state.character!.parentFile).toBe(path.join(dir, "art", "characters", "mira-south.png"))
    expect(state.character!.parentSha256).toBeNull()

    const animation = byId.get("mira.fireman_spin")!
    expect(animation.character).toMatchObject({
      kind: "animation",
      parentAssetId: "mira.chair_spin",
      animation: { mode: "v3", direction: "east", frames: 8, fps: 10, keepFirstFrame: true },
    })
    expect(animation.character!.parentSpec!.assetId).toBe("mira.chair_spin")
  })

  it("defaults the view to PixelLab's low top-down and infers template mode", async () => {
    const loaded = await loadManifest(await writeManifest({
      style: { view: undefined },
      assets: {
        cat: { prompt: "a tabby cat" },
        "cat.walk": { prompt: "", animation: { of: "cat", template: "walk" } },
      },
    }))
    const specs = await resolveSpecs(loaded)
    expect(specs.find((s) => s.assetId === "cat")!.view).toBe("low top-down")
    expect(specs.find((s) => s.assetId === "cat.walk")!.character!.animation).toMatchObject({ mode: "template", template: "walk", direction: "south" })
  })

  it("hashes the parent's generated south file into a child's identity", async () => {
    const file = await writeManifest()
    const before = (await resolveSpecs(await loadManifest(file))).find((s) => s.assetId === "mira.chair_spin")!
    await writeFile(path.join(dir, "art", "characters", "mira-south.png"), px(4, 10)).catch(async () => {
      await import("node:fs/promises").then((fs) => fs.mkdir(path.join(dir, "art", "characters"), { recursive: true }))
      await writeFile(path.join(dir, "art", "characters", "mira-south.png"), px(4, 10))
    })
    const first = (await resolveSpecs(await loadManifest(file))).find((s) => s.assetId === "mira.chair_spin")!
    expect(first.character!.parentSha256).not.toBeNull()
    expect(first.specHash).not.toBe(before.specHash)
    await writeFile(path.join(dir, "art", "characters", "mira-south.png"), px(4, 20))
    const second = (await resolveSpecs(await loadManifest(file))).find((s) => s.assetId === "mira.chair_spin")!
    expect(second.specHash).not.toBe(first.specHash)
    // A base's own identity does not depend on its files.
    const base1 = (await resolveSpecs(await loadManifest(file))).find((s) => s.assetId === "mira")!
    expect(base1.specHash).toBe((await resolveSpecs(await loadManifest(file))).find((s) => s.assetId === "mira")!.specHash)
  })

  it("refuses shapes that cannot resolve", async () => {
    const bad = async (assets: Record<string, unknown>, pattern: RegExp, style?: Record<string, unknown>) => {
      await writeManifest({ assets, style })
      await expect(loadManifest(manifestPath()).then(resolveSpecs)).rejects.toThrow(pattern)
    }
    await bad({ a: { prompt: "x", state: { of: "nope" } } }, /state\.of: unknown asset "nope"/)
    await bad({ a: { prompt: "x", state: { of: "a" } } }, /cannot be a state of itself/)
    await bad({ a: { prompt: "x" }, b: { prompt: "y", animation: { of: "a" } }, c: { prompt: "z", state: { of: "b" } } }, /"b" is an animation and cannot be a parent/)
    await bad({ a: { prompt: "x", state: { of: "b" } }, b: { prompt: "y", state: { of: "a" } } }, /state cycle a -> b -> a/)
    await bad({ a: { prompt: "x", state: { of: "b" }, animation: { of: "b" } }, b: { prompt: "y" } }, /state and animation are mutually exclusive/)
    await bad({ a: { prompt: "x", animation: { of: "b", frames: 7 } }, b: { prompt: "y" } }, /frames must be even/)
    await bad({ a: { prompt: "x", animation: { of: "b", template: "walk", frames: 8 } }, b: { prompt: "y" } }, /template decides its own frame count/)
    await bad({ a: { prompt: "x" } }, /v3 characters always have 8 directions/, { mode: "v3", directions: 4 })
    await bad({ a: { prompt: "x" } }, /mode applies to the character generator only/, { generator: "map", mode: "v3" })
    // A state in a map style has nothing to be a state of.
    await writeManifest({ assets: { a: { prompt: "x" }, b: { prompt: "y", state: { of: "a" } } }, extraStyles: { props: { generator: "map", outDir: "props" } } })
    await expect(loadManifest(manifestPath()).then((l) => resolveSpecs(l, { styles: ["props"] }))).rejects.toThrow(/state needs a character or objectPro style/)
  })
})

describe("character controls", () => {
  it("resolves proportions, guidance, isometric, and a reference sprite into the base's identity", async () => {
    await writeFile(path.join(dir, "mira-south.png"), px(64, 30))
    const file = await writeManifest({
      style: { proportions: "chibi", textGuidanceScale: 12, isometric: true },
      assets: {
        mira: { prompt: "mira", reference: "mira-south.png" },
        rook: { prompt: "rook", proportions: { headSize: 1.6 } },
        "mira.walk": { prompt: "", animation: { of: "mira", template: "walk" } },
      },
    })
    const specs = await resolveSpecs(await loadManifest(file))
    const byId = new Map(specs.map((s) => [s.assetId, s]))
    expect(byId.get("mira")!.character).toMatchObject({
      proportions: "chibi", textGuidanceScale: 12, isometric: true,
      reference: { south: { path: path.join(dir, "mira-south.png"), width: 64, height: 64, format: "png" } },
    })
    // The asset's own proportions win over the style's.
    expect(byId.get("rook")!.character).toMatchObject({ proportions: { headSize: 1.6 } })
    expect(byId.get("mira.walk")!.character).toMatchObject({ textGuidanceScale: 12, isometric: true })

    // A redrawn reference is a different base; a plain style tweak is too.
    const before = byId.get("mira")!.specHash
    await writeFile(path.join(dir, "mira-south.png"), px(64, 31))
    const redrawn = await resolveSpecs(await loadManifest(file))
    expect(redrawn.find((s) => s.assetId === "mira")!.specHash).not.toBe(before)
    await writeFile(path.join(dir, "mira-south.png"), px(64, 30))
    const plain = await resolveSpecs(await loadManifest(await writeManifest({ style: { proportions: "chibi", textGuidanceScale: 12, isometric: true }, assets: { mira: { prompt: "mira" } } })))
    expect(plain[0]!.specHash).not.toBe(before)
    // Manifests that never set these keep the hashes they had before the
    // controls existed (pinned against the published v0.43.0).
    const unset = await resolveSpecs(await loadManifest(await writeManifest({ assets: { mira: { prompt: "mira" } } })))
    expect(unset[0]!.specHash).toBe("8cbc9748fa2b75699f0aefb15743991d36ce9c9ca5230bc57f83e99813c6379b")
  })

  it("refuses controls where the engine or template cannot take them", async () => {
    await writeFile(path.join(dir, "s64.png"), px(64, 30))
    await writeFile(path.join(dir, "s48.png"), px(48, 30))
    await writeFile(path.join(dir, "s200.png"), px(200, 30))
    const refused = async (overrides: Parameters<typeof writeManifest>[0]) => resolveSpecs(await loadManifest(await writeManifest(overrides)))
    await expect(refused({ style: { mode: "v3", proportions: "chibi" }, assets: { a: { prompt: "a" } } })).rejects.toThrow(/proportions apply to standard bases; the v3 engine/)
    await expect(refused({ style: { template: "cat", proportions: "chibi" }, assets: { a: { prompt: "a" } } })).rejects.toThrow(/mannequin template; cat is a quadruped/)
    await expect(refused({ assets: { a: { prompt: "a", reference: "s48.png" } } })).rejects.toThrow(/reference \(south\) is 48x48; standard mode wants each image at the style's size, 64x64/)
    await expect(refused({ style: { template: "cat" }, assets: { a: { prompt: "a", reference: "s64.png" } } })).rejects.toThrow(/a cat reference needs south and east images/)
    await expect(refused({ style: { directions: 4 }, assets: { a: { prompt: "a", reference: { south: "s64.png", "south-east": "s64.png" } } } })).rejects.toThrow(/"south-east" is not one of this character's 4 directions/)
    await expect(refused({ assets: { a: { prompt: "a", reference: { east: "s64.png" } } } })).rejects.toThrow(/needs a south-facing sprite/)
    await expect(refused({ assets: { a: { prompt: "a", reference: "missing.png" } } })).rejects.toThrow(/Reference sprite \(south\) not found/)
    await expect(refused({ style: { mode: "v3" }, assets: { a: { prompt: "a", reference: { south: "s64.png", east: "s64.png" } } } })).rejects.toThrow(/v3 rotates one south-facing reference/)
    await expect(refused({ style: { mode: "pro" }, assets: { a: { prompt: "a", reference: "s200.png" } } })).rejects.toThrow(/reference is 200x200; PixelLab pro takes up to 168px/)
    await expect(refused({ assets: { a: { prompt: "a" }, b: { prompt: "b", state: { of: "a" }, reference: "s64.png" } } })).rejects.toThrow(/reference sprite belongs on a base/)
    // Style images: pro takes one as its style anchor; the other engines have no slot.
    await expect(refused({ style: { styleImages: [{ path: "s64.png" }] }, assets: { a: { prompt: "a" } } })).rejects.toThrow(/standard characters take no style images/)
    await expect(refused({ style: { mode: "pro", styleImages: [{ path: "s64.png" }, { path: "s48.png" }] }, assets: { a: { prompt: "a" } } })).rejects.toThrow(/pro characters take one style image/)
    await expect(refused({ style: { mode: "pro", styleImages: [{ path: "s200.png" }] }, assets: { a: { prompt: "a" } } })).rejects.toThrow(/style image is 200x200; the limit is 168px/)
    await expect(refused({ style: { mode: "pro", styleImages: [{ path: "s64.png" }] }, assets: { a: { prompt: "a", reference: "s64.png" } } })).rejects.toThrow(/rotating its own reference takes no style image/)
    const ok = await refused({ style: { mode: "pro", styleImages: [{ path: "s64.png" }] }, assets: { a: { prompt: "a" } } })
    expect(ok[0]!.styleImagePaths).toEqual(["s64.png"])
    // v3 with a reference and a quadruped standard base with both sprites resolve.
    await expect(refused({ style: { mode: "v3" }, assets: { a: { prompt: "a", reference: "s200.png" } } })).resolves.toHaveLength(1)
    await expect(refused({ style: { template: "cat" }, assets: { a: { prompt: "a", reference: { south: "s64.png", east: "s64.png" } } } })).resolves.toHaveLength(1)
  })

  it("resolves a loop's pose frames into its identity and refuses them where they cannot apply", async () => {
    await writeFile(path.join(dir, "start.png"), px(92, 10))
    await writeFile(path.join(dir, "end.png"), px(92, 20))
    await writeFile(path.join(dir, "end64.png"), px(64, 20))
    await writeFile(path.join(dir, "big.png"), px(300, 20))
    const loop = (animation: Record<string, unknown>, style: Record<string, unknown> = {}) =>
      writeManifest({ style, assets: { mira: { prompt: "mira" }, "mira.leap": { prompt: "leaping", animation: { of: "mira", ...animation } } } })
    const specs = await resolveSpecs(await loadManifest(await loop({ startFrame: "start.png", endFrame: "end.png", subject: "a frog", enhancePrompt: true })))
    const leap = specs.find((s) => s.assetId === "mira.leap")!
    expect(leap.character!.animation).toMatchObject({
      mode: "v3", subject: "a frog", enhancePrompt: true,
      startFrame: { path: path.join(dir, "start.png"), width: 92, height: 92 },
      endFrame: { path: path.join(dir, "end.png"), width: 92, height: 92 },
    })
    const before = leap.specHash
    await writeFile(path.join(dir, "end.png"), px(92, 21))
    const redrawn = await resolveSpecs(await loadManifest(await loop({ startFrame: "start.png", endFrame: "end.png", subject: "a frog", enhancePrompt: true })))
    expect(redrawn.find((s) => s.assetId === "mira.leap")!.specHash).not.toBe(before)
    // A loop without any of these keeps the hash it had before they existed (pinned against the published v0.43.0).
    const plain = await resolveSpecs(await loadManifest(await loop({ template: "walk" })))
    expect(plain.find((s) => s.assetId === "mira.leap")!.specHash).toBe("f9d73e753105691f1fdbff7a1f8fe911b820e93eeb23da7b81cd7bc2977e5d3d")

    const refused = async (animation: Record<string, unknown>, style: Record<string, unknown> = {}) => resolveSpecs(await loadManifest(await loop(animation, style)))
    await expect(refused({ template: "walk", startFrame: "start.png" })).rejects.toThrow(/startFrame is for v3 loops; a template loop starts from the character's rotation/)
    await expect(refused({ mode: "pro", endFrame: "end.png" })).rejects.toThrow(/endFrame is for v3 loops; a pro loop takes neither/)
    await expect(refused({ template: "walk", enhancePrompt: true })).rejects.toThrow(/enhancePrompt is for v3 loops/)
    await expect(refused({ outline: "lineless" })).rejects.toThrow(/outline overrides apply to template loops only/)
    await expect(refused({ startFrame: "start.png", endFrame: "end64.png" })).rejects.toThrow(/end frame is 64x64 but the start frame is 92x92/)
    await expect(refused({ startFrame: "big.png" })).rejects.toThrow(/start frame is 300x300; PixelLab v3 takes up to 256px/)
    await expect(refused({ endFrame: "missing.png" })).rejects.toThrow(/Animation end frame not found/)
    await expect(refused({ template: "walk" }, { enhancePrompt: true })).rejects.toThrow(/enhancePrompt applies to v3 bases; the standard engine/)
    // Without a start frame the end frame is checked against the parent's rotation once that is on disk.
    await expect(refused({ endFrame: "end64.png" })).resolves.toHaveLength(2)
    const { mkdir } = await import("node:fs/promises")
    await mkdir(path.join(dir, "art", "characters"), { recursive: true })
    await writeFile(path.join(dir, "art", "characters", "mira-south.png"), px(92, 5))
    await expect(refused({ endFrame: "end64.png" })).rejects.toThrow(/end frame is 64x64 but the character's rotation is 92x92/)
    await expect(refused({ endFrame: "end.png" })).resolves.toHaveLength(2)
    await expect(refused({ template: "walk", outline: "lineless", shading: "flat shading", detail: "low detail", subject: "a frog" })).resolves.toHaveLength(2)
  })

  it("sends a loop's overrides through the adapter and refuses a pose that changed since resolve", async () => {
    await writeFile(path.join(dir, "start.png"), px(92, 10))
    const file = await writeManifest({
      style: { palette: ["#000000", "#ffffff"] },
      assets: { mira: { prompt: "mira" }, "mira.leap": { prompt: "leaping", animation: { of: "mira", startFrame: "start.png", subject: "a frog", enhancePrompt: true, frames: 6 } } },
    })
    const client = fakeClient()
    const provider = new PixelLabProvider(client as never)
    let p = await openProject(file, { env: false })
    await submit(provider, p.loaded, (await p.plan()).actionable, p.lock, p.lockPath, { spacingMs: 0 })
    client.complete("char-1", 10)
    await poll(provider, p.lock, p.lockPath, { intervalMs: 0, specs: p.specs })
    await fetchAssets(provider, p.specs, p.lock, p.lockPath)
    p = await openProject(file, { env: false })
    await submit(provider, p.loaded, (await p.plan()).actionable, p.lock, p.lockPath, { spacingMs: 0 })
    expect(client.animated[0]).toMatchObject({
      mode: "v3", frameCount: 6, description: "a frog", enhancePrompt: true,
      startFrame: { base64: px(92, 10).toString("base64"), format: "png" },
    })
    expect(client.animated[0]!.paletteSwatchBase64).toEqual(expect.any(String))
    expect(client.animated[0]!.endFrame).toBeUndefined()

    await writeFile(path.join(dir, "start.png"), px(92, 11))
    const leap = p.specs.find((s) => s.assetId === "mira.leap")!
    const result = await submit(provider, p.loaded, [{ spec: leap, key: "cast/mira.leap", state: "missing", reason: "forced" }], p.lock, p.lockPath, { spacingMs: 0 })
    expect(result.failed).toBe(1)
    expect(p.lock.entries["cast/mira.leap"]!.error).toMatch(/start frame changed after the manifest was resolved/)
  })

  it("resolves a concept image and a style anchor for pro bases and refuses them elsewhere", async () => {
    await writeFile(path.join(dir, "concept.png"), px(200, 30))
    await writeFile(path.join(dir, "huge.png"), px(1100, 30))
    await writeFile(path.join(dir, "s64.png"), px(64, 30))
    const file = await writeManifest({
      style: { mode: "pro", styleCharacter: "hero" },
      assets: {
        hero: { prompt: "a hero" },
        rook: { prompt: "a rook" },
        sage: { prompt: "a sage", concept: "concept.png", styleCharacter: "rook" },
        "hero.sit": { prompt: "sitting", state: { of: "hero" } },
      },
    })
    const specs = await resolveSpecs(await loadManifest(file))
    const byId = new Map(specs.map((s) => [s.assetId, s]))
    expect(byId.get("hero")!.character!.styleAnchor).toBeUndefined()
    expect(byId.get("rook")!.character!.styleAnchor).toMatchObject({ assetId: "hero", sha256: null, file: path.join(dir, "art/characters", "hero-south.png") })
    expect(byId.get("sage")!.character).toMatchObject({ styleAnchor: { assetId: "rook" }, concept: { width: 200, height: 200, format: "png" } })
    expect(byId.get("hero.sit")!.character!.styleAnchor).toBeUndefined()
    const before = byId.get("rook")!.specHash
    // The anchor landing on disk is part of the dependent's identity.
    const { mkdir } = await import("node:fs/promises")
    await mkdir(path.join(dir, "art", "characters"), { recursive: true })
    await writeFile(path.join(dir, "art", "characters", "hero-south.png"), px(92, 5))
    const landed = await resolveSpecs(await loadManifest(file))
    expect(landed.find((s) => s.assetId === "rook")!.specHash).not.toBe(before)
    expect(landed.find((s) => s.assetId === "hero")!.specHash).toBe(byId.get("hero")!.specHash)

    const refused = async (overrides: Parameters<typeof writeManifest>[0]) => resolveSpecs(await loadManifest(await writeManifest(overrides)))
    await expect(refused({ style: { styleCharacter: "a" }, assets: { a: { prompt: "a" }, b: { prompt: "b" } } })).rejects.toThrow(/styleCharacter is a pro input; the standard engine/)
    await expect(refused({ assets: { a: { prompt: "a", concept: "concept.png" } } })).rejects.toThrow(/concept image is a pro input/)
    await expect(refused({ style: { mode: "pro" }, assets: { a: { prompt: "a", concept: "huge.png" } } })).rejects.toThrow(/concept image is 1100x1100; PixelLab pro takes up to 1024px/)
    await expect(refused({ style: { mode: "pro" }, assets: { a: { prompt: "a" }, b: { prompt: "b", reference: "s64.png", styleCharacter: "a" } } })).rejects.toThrow(/rotating its own reference takes no styleCharacter/)
    await expect(refused({ style: { mode: "pro" }, assets: { a: { prompt: "a" }, "a.walk": { prompt: "", animation: { of: "a", template: "walk" } }, b: { prompt: "b", styleCharacter: "a.walk" } } })).rejects.toThrow(/styleCharacter a.walk is not a character base or state/)
    await expect(refused({ style: { mode: "pro" }, assets: { a: { prompt: "a", styleCharacter: "nobody" } } })).rejects.toThrow(/"nobody" is not available in style "cast"/)
    await expect(refused({ assets: { a: { prompt: "a", concept: "concept.png", reference: "s64.png" } } })).rejects.toThrow(/concept and reference are mutually exclusive/)
    await expect(refused({ assets: { a: { prompt: "a" }, b: { prompt: "b", state: { of: "a" }, concept: "concept.png" } } })).rejects.toThrow(/concept image belongs on a base/)
  })

  it("waits for the anchor, sends its character id, and goes stale when the anchor is redrawn", async () => {
    const file = await writeManifest({ style: { mode: "pro", styleCharacter: "hero" }, assets: { hero: { prompt: "a hero" }, rook: { prompt: "a rook" } } })
    const client = fakeClient()
    const provider = new PixelLabProvider(client as never)
    let p = await openProject(file, { env: false })
    let plan = await p.plan()
    expect(plan.items.map((i) => `${i.key}=${i.state}`)).toEqual(["cast/hero=missing", "cast/rook=blocked"])
    expect(plan.items[1]!.reason).toMatch(/style anchor cast\/hero is not ready: parent is not in the lockfile/)
    await submit(provider, p.loaded, plan.actionable, p.lock, p.lockPath, { spacingMs: 0 })
    client.complete("char-1", 10)
    await poll(provider, p.lock, p.lockPath, { intervalMs: 0, specs: p.specs })
    await fetchAssets(provider, p.specs, p.lock, p.lockPath)

    p = await openProject(file, { env: false })
    plan = await p.plan()
    expect(plan.items.map((i) => `${i.key}=${i.state}`)).toEqual(["cast/hero=ok", "cast/rook=missing"])
    await submit(provider, p.loaded, plan.actionable, p.lock, p.lockPath, { spacingMs: 0 })
    expect(client.created[1]).toMatchObject({ description: expect.stringContaining("a rook"), styleCharacterId: "char-1" })
    client.complete("char-2", 20)
    await poll(provider, p.lock, p.lockPath, { intervalMs: 0, specs: p.specs })
    await fetchAssets(provider, p.specs, p.lock, p.lockPath)
    p = await openProject(file, { env: false })
    expect((await p.plan()).items.map((i) => `${i.key}=${i.state}`)).toEqual(["cast/hero=ok", "cast/rook=ok"])

    // A redrawn anchor changes the look the rook was drawn in.
    const forced = await buildPlan(p.specs, p.lock, { force: true })
    await submit(provider, p.loaded, forced.actionable.filter((i) => i.key === "cast/hero"), p.lock, p.lockPath, { spacingMs: 0 })
    client.complete("char-3", 30)
    await poll(provider, p.lock, p.lockPath, { intervalMs: 0, specs: p.specs })
    await fetchAssets(provider, p.specs, p.lock, p.lockPath)
    p = await openProject(file, { env: false })
    expect((await p.plan()).items.map((i) => `${i.key}=${i.state}`)).toEqual(["cast/hero=ok", "cast/rook=stale"])
  })

  it("resolves a pro-flash base with a style image and its traits, and applies the engine's own limits", async () => {
    await writeFile(path.join(dir, "style.png"), px(48, 30))
    await writeFile(path.join(dir, "s64.png"), px(64, 30))
    await writeFile(path.join(dir, "s300.png"), px(300, 30))
    const refused = async (overrides: Parameters<typeof writeManifest>[0]) => resolveSpecs(await loadManifest(await writeManifest(overrides)))
    const specs = await refused({ style: { mode: "pro-flash", template: "custom", styleImages: [{ path: "style.png" }], styleTraits: { palette: false } }, assets: { a: { prompt: "a" } } })
    expect(specs[0]!.character).toMatchObject({ mode: "pro-flash", directions: 8, template: "custom", styleTraits: { palette: false } })
    expect(specs[0]!.cost).toBe(6)
    const fromSprite = await refused({ style: { mode: "pro-flash" }, assets: { b: { prompt: "b", reference: "s64.png" } } })
    expect(fromSprite[0]!.cost).toBe(1)
    // A style image is a style-wide input, so a base rotating its own sprite cannot sit under one.
    await expect(refused({ style: { mode: "pro-flash", styleImages: [{ path: "style.png" }] }, assets: { b: { prompt: "b", reference: "s64.png" } } })).rejects.toThrow(/pro-flash base rotating its own reference takes no style image/)

    await expect(refused({ style: { mode: "pro-flash", size: 66 }, assets: { a: { prompt: "a" } } })).rejects.toThrow(/multiples of 4 pixels; 66x66 is not/)
    await expect(refused({ style: { mode: "pro-flash", template: "dragon" }, assets: { a: { prompt: "a" } } })).rejects.toThrow(/pro-flash character template must be one of: mannequin, bear, cat, dog, horse, lion, custom/)
    await expect(refused({ style: { mode: "pro", template: "custom" }, assets: { a: { prompt: "a" } } })).rejects.toThrow(/pro character template must be one of: mannequin, bear, cat, dog, horse, lion$/)
    await expect(refused({ style: { mode: "pro-flash", styleTraits: { outline: false } }, assets: { a: { prompt: "a" } } })).resolves.toHaveLength(1)
    await expect(refused({ style: { mode: "v3", styleTraits: { outline: false } }, assets: { a: { prompt: "a" } } })).rejects.toThrow(/styleTraits choose what a pro-flash style image lends/)
    await expect(refused({ style: { mode: "pro-flash" }, assets: { a: { prompt: "a", reference: "s300.png" } } })).rejects.toThrow(/reference is 300x300; PixelLab pro-flash takes up to 256px/)
    await expect(refused({ style: { mode: "pro-flash", styleImages: [{ path: "s300.png" }] }, assets: { a: { prompt: "a" } } })).rejects.toThrow(/style image is 300x300; the limit is 256px/)
    // Read from a live 422 in September 2026: the style image has to fit the canvas being drawn.
    await writeFile(path.join(dir, "s104.png"), px(104, 30))
    await expect(refused({ style: { mode: "pro-flash", styleImages: [{ path: "s104.png" }] }, assets: { a: { prompt: "a" } } })).rejects.toThrow(/style image is 104x104 but the character is 64x64; crop the image/)
    await expect(refused({ style: { mode: "pro-flash", size: 128, styleImages: [{ path: "s104.png" }] }, assets: { a: { prompt: "a" } } })).resolves.toHaveLength(1)
    await expect(refused({ style: { mode: "pro-flash", proportions: "chibi" }, assets: { a: { prompt: "a" } } })).rejects.toThrow(/proportions apply to standard bases; the pro-flash engine/)
    await expect(refused({ style: { mode: "pro-flash", styleCharacter: "a" }, assets: { a: { prompt: "a" }, b: { prompt: "b" } } })).rejects.toThrow(/styleCharacter is a pro input; the pro-flash engine/)
  })

  it("reads the reference at submit time and refuses one that changed since resolve", async () => {
    await writeFile(path.join(dir, "mira-south.png"), px(64, 30))
    const file = await writeManifest({ style: { proportions: "heroic" }, assets: { mira: { prompt: "mira", reference: "mira-south.png" } } })
    const client = fakeClient()
    const provider = new PixelLabProvider(client as never)
    const p = await openProject(file, { env: false })
    await submit(provider, p.loaded, (await p.plan()).actionable, p.lock, p.lockPath, { spacingMs: 0 })
    expect(client.created[0]).toMatchObject({ proportions: "heroic", reference: { south: { base64: px(64, 30).toString("base64"), format: "png" } } })

    await writeFile(path.join(dir, "mira-south.png"), px(64, 99))
    const forced = await buildPlan(p.specs, p.lock, { force: true })
    const result = await submit(provider, p.loaded, forced.actionable, p.lock, p.lockPath, { spacingMs: 0 })
    expect(result.failed).toBe(1)
    expect(p.lock.entries["cast/mira"]!.error).toMatch(/reference \(south\) changed after the manifest was resolved/)
  })
})

describe("skeleton-v3 loops", () => {
  it("pose a template, so they need one and take none of the frame or style controls", async () => {
    const { CharacterAnimationSchema } = await import("../src/types.ts")
    const issues = (animation: Record<string, unknown>) => {
      const result = CharacterAnimationSchema.safeParse({ of: "mira", ...animation })
      return result.success ? [] : result.error.issues.map((issue) => issue.message)
    }
    expect(issues({ template: "walk", mode: "skeleton-v3" })).toEqual([])
    expect(issues({ mode: "skeleton-v3" })).toEqual(["skeleton-v3 mode needs a template"])
    expect(issues({ template: "walk", mode: "skeleton-v3", frames: 8 })).toEqual(["a template decides its own frame count; drop frames"])
    expect(issues({ template: "walk", mode: "skeleton-v3", outline: "lineless" })).toEqual(["outline overrides apply to template loops only"])
    expect(issues({ template: "walk", mode: "v3" })[0]).toMatch(/use "template" or "skeleton-v3"/)
  })

  it("resolve with no prompt of their own, priced at the top of PixelLab's range", async () => {
    const loaded = await loadManifest(await writeManifest({
      assets: {
        mira: { prompt: "a knight" },
        "mira.walk": { prompt: "", animation: { of: "mira", template: "walk", mode: "skeleton-v3", direction: "east" } },
      },
    }))
    const walk = (await resolveSpecs(loaded)).find((spec) => spec.assetId === "mira.walk")!
    expect(walk.character?.animation).toMatchObject({ mode: "skeleton-v3", template: "walk", direction: "east" })
    expect(walk.cost).toBe(4)
  })
})

describe("characterCost", () => {
  const spec = (character: Partial<ResolvedSpec["character"]>, size = 64) =>
    ({ width: size, height: size, character: { kind: "base", mode: "standard", directions: 8, template: "mannequin", ...character } } as unknown as ResolvedSpec)

  it("prices pro-flash as its image tier plus v3's rotations, or the rotations alone from a sprite", () => {
    const base = (size: number, extra: Record<string, unknown> = {}) => ({ width: size, height: size, character: { kind: "base", mode: "pro-flash", directions: 8, template: "mannequin", ...extra } }) as unknown as ResolvedSpec
    expect(characterCost(base(64))).toBe(6)
    expect(characterCost(base(96))).toBe(7)
    expect(characterCost(base(128))).toBe(8)
    expect(characterCost(base(160))).toBe(10)
    expect(characterCost(base(256))).toBe(17)
    // Read from PixelLab's cost endpoint in September 2026: 32 to 80 → 6, 96 → 7, 112 → 8, 192 → 11, 224 → 16.
    expect(characterCost(base(32))).toBe(6)
    expect(characterCost(base(112))).toBe(8)
    expect(characterCost(base(192))).toBe(11)
    expect(characterCost(base(224))).toBe(16)
    const sprite = (size: number) => base(64, { reference: { south: { width: size, height: size } } })
    expect(characterCost(sprite(64))).toBe(1)
    expect(characterCost(sprite(96))).toBe(2)
    expect(characterCost(sprite(18))).toBe(1)
  })

  it("prices each shape and engine the way PixelLab charges", () => {
    expect(characterCost(spec({ mode: "standard" }))).toBe(1)
    expect(characterCost(spec({ mode: "v3" }, 64))).toBe(2)
    // From the author's own sprite v3 draws nothing, so only the rotations are billed, on the sprite's canvas.
    expect(characterCost(spec({ mode: "v3", reference: { south: { width: 64, height: 64 } } } as never, 64))).toBe(1)
    expect(characterCost(spec({ mode: "v3", reference: { south: { width: 128, height: 128 } } } as never, 64))).toBe(2)
    expect(characterCost(spec({ mode: "v3" }, 128))).toBe(3)
    expect(characterCost(spec({ mode: "pro" }, 64))).toBe(40)
    expect(characterCost(spec({ mode: "pro" }, 32))).toBe(20)
    expect(characterCost(spec({ kind: "state" }, 64))).toBe(40)
    expect(characterCost(spec({ kind: "state" }, 32))).toBe(20)
    const anim = (mode: "template" | "skeleton-v3" | "v3" | "pro", size: number, frames = 8) =>
      spec({ kind: "animation", animation: { mode, direction: "east", frames, fps: 8, keepFirstFrame: true } }, size)
    expect(characterCost(anim("template", 128))).toBe(1)
    // PixelLab documents 2-4 per direction by the template's length; plan budgets the top.
    expect(characterCost(anim("skeleton-v3", 128))).toBe(4)
    expect(characterCost(anim("v3", 64))).toBe(1)
    expect(characterCost(anim("v3", 128))).toBe(2)
    expect(characterCost(anim("v3", 160, 16))).toBe(7)
    expect(characterCost(anim("pro", 64))).toBe(40)
  })

  it("is what plan reports before any spend", async () => {
    const loaded = await loadManifest(await writeManifest())
    const specs = await resolveSpecs(loaded)
    const cost = Object.fromEntries(specs.map((s) => [s.assetId, s.cost]))
    expect(cost).toEqual({ mira: 1, "mira.chair_spin": 40, "mira.fireman_spin": 1 })
    const plan = await buildPlan(specs, { version: 2, entries: {} })
    expect(plan.items.find((i) => i.key === "cast/mira")).toMatchObject({ state: "missing" })
    expect(plan.items.find((i) => i.key === "cast/mira.chair_spin")).toMatchObject({ state: "blocked", reason: expect.stringContaining("state parent cast/mira is not ready") })
    expect(plan.groups[0]).toMatchObject({ provider: "pixellab", cost: 1 })
  })
})

describe("the wire", () => {
  const calls: { path: string; method: string; body: unknown }[] = []
  const answer = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } })
  beforeEach(() => {
    calls.length = 0
    vi.stubGlobal("fetch", vi.fn(async (input: string, init?: RequestInit) => {
      const url = new URL(String(input))
      calls.push({ path: url.pathname + url.search, method: init?.method ?? "GET", body: init?.body ? JSON.parse(String(init.body)) : null })
      if (url.pathname.endsWith("/animations") && init?.method === "DELETE") return answer({ success: true, deleted_count: 1 })
      if (url.pathname === "/v2/animate-character") return answer({ background_job_ids: ["job-e"], directions: ["east"] })
      if (url.pathname === "/v2/characters/animations" && init?.method === "POST") {
        return answer({ background_job_ids: ["job-s"], directions: ["east"], animation_group_id: "group-1" })
      }
      return answer({ character_id: "char-1", background_job_id: "job-1", status: "processing" })
    }))
  })

  it("picks the endpoint by engine and directions and sends the palette to standard", async () => {
    const client = new PixelLabClient("key")
    await client.createCharacter({ mode: "standard", description: "a", size: 64, directions: 8, template: "mannequin", view: "side", paletteSwatchBase64: "AAA=" })
    await client.createCharacter({ mode: "standard", description: "a", size: 48, directions: 4, template: "cat" })
    await client.createCharacter({ mode: "v3", description: "a", size: 128, directions: 8, template: "mannequin", outline: "lineless", seed: 7 })
    await client.createCharacter({ mode: "pro", description: "a", size: 96, directions: 8, template: "mannequin", noBackground: false })
    expect(calls.map((c) => c.path)).toEqual([
      "/v2/create-character-with-8-directions",
      "/v2/create-character-with-4-directions",
      "/v2/create-character-v3",
      "/v2/create-character-pro",
    ])
    expect(calls[0]!.body).toMatchObject({ description: "a", image_size: { width: 64, height: 64 }, template_id: "mannequin", view: "side", color_image: { base64: "AAA=" }, force_colors: true })
    expect(calls[1]!.body).toMatchObject({ template_id: "cat" })
    expect(calls[2]!.body).toMatchObject({ outline: "lineless", seed: 7, no_background: true })
    expect(calls[2]!.body).not.toHaveProperty("color_image")
    expect(calls[3]!.body).toMatchObject({ no_background: false })
  })

  it("sends proportions, guidance, isometric, and reference sprites where each engine takes them", async () => {
    const client = new PixelLabClient("key")
    const south = { base64: "U09VVEg=", format: "png" as const }
    const east = { base64: "RUFTVA==", format: "png" as const }
    await client.createCharacter({ mode: "standard", description: "a", size: 64, directions: 8, template: "mannequin", proportions: "chibi", textGuidanceScale: 12, isometric: true, reference: { south, east } })
    await client.createCharacter({ mode: "standard", description: "a", size: 64, directions: 8, template: "mannequin", proportions: { headSize: 1.4, legsLength: 0.8 } })
    await client.createCharacter({ mode: "v3", description: "a", size: 64, directions: 8, template: "mannequin", reference: { south }, proportions: "chibi", isometric: true })
    await client.createCharacter({ mode: "pro", description: "a", size: 64, directions: 8, template: "mannequin", reference: { south } })
    await client.createCharacter({ mode: "pro", description: "a", size: 64, directions: 8, template: "mannequin", styleReference: east })
    await client.createCharacter({ mode: "pro", description: "a", size: 64, directions: 8, template: "mannequin" })
    await client.animateCharacter({ characterId: "char-1", animationName: "n", template: "walk", mode: "template", directions: ["south"], textGuidanceScale: 5, isometric: true })
    await client.animateCharacter({ characterId: "char-1", animationName: "n", actionDescription: "x", mode: "v3", directions: ["south"], textGuidanceScale: 5, isometric: true })
    expect(calls[0]!.body).toMatchObject({
      proportions: { type: "preset", name: "chibi" }, text_guidance_scale: 12, isometric: true,
      directions: { south: { type: "base64", base64: "U09VVEg=", format: "png" }, east: { type: "base64", base64: "RUFTVA==", format: "png" } },
    })
    expect(calls[1]!.body).toMatchObject({ proportions: { type: "custom", head_size: 1.4, legs_length: 0.8 } })
    expect(calls[1]!.body.proportions).not.toHaveProperty("arms_length")
    // v3 rotates the south sprite and has no proportions or isometric to set.
    expect(calls[2]!.body).toMatchObject({ reference_image: { type: "base64", base64: "U09VVEg=", format: "png" } })
    expect(calls[2]!.body).not.toHaveProperty("proportions")
    expect(calls[2]!.body).not.toHaveProperty("isometric")
    expect(calls[2]!.body).not.toHaveProperty("directions")
    // pro rotates a reference, or anchors its style on one, or neither.
    expect(calls[3]!.body).toMatchObject({ method: "rotate_character", reference_image: { base64: "U09VVEg=" } })
    expect(calls[4]!.body).toMatchObject({ method: "create_with_style", reference_image: { base64: "RUFTVA==" } })
    expect(calls[5]!.body).toMatchObject({ method: "create_with_style" })
    expect(calls[5]!.body).not.toHaveProperty("reference_image")
    // Guidance is a template-mode knob; isometric applies to every loop.
    expect(calls[6]!.body).toMatchObject({ text_guidance_scale: 5, isometric: true })
    expect(calls[7]!.body).toMatchObject({ isometric: true })
    expect(calls[7]!.body).not.toHaveProperty("text_guidance_scale")
  })

  it("sends a loop's pose frames, subject, style hints, prompt enhancement, and palette where each mode takes them", async () => {
    const client = new PixelLabClient("key")
    const start = { base64: "U1RBUlQ=", format: "png" as const }
    const end = { base64: "RU5E", format: "png" as const }
    await client.animateCharacter({ characterId: "c", animationName: "n", actionDescription: "leap", mode: "v3", directions: ["south"], startFrame: start, endFrame: end, description: "a frog", enhancePrompt: true, outline: "lineless", paletteSwatchBase64: "AAA=" })
    await client.animateCharacter({ characterId: "c", animationName: "n", template: "walk", mode: "template", directions: ["south"], outline: "lineless", shading: "flat shading", detail: "low detail", description: "a frog", startFrame: start, enhancePrompt: true })
    await client.animateCharacter({ characterId: "c", animationName: "n", actionDescription: "leap", mode: "pro", directions: ["south"], startFrame: start, outline: "lineless", enhancePrompt: true })
    await client.createCharacter({ mode: "v3", description: "a", size: 64, directions: 8, template: "mannequin", enhancePrompt: true })
    await client.createCharacter({ mode: "standard", description: "a", size: 64, directions: 8, template: "mannequin", enhancePrompt: true })
    expect(calls[0]!.body).toMatchObject({
      custom_start_frame: { type: "base64", base64: "U1RBUlQ=", format: "png" }, end_frame: { type: "base64", base64: "RU5E", format: "png" },
      description: "a frog", enhance_prompt: true, color_image: { base64: "AAA=" }, force_colors: true,
    })
    expect(calls[0]!.body).not.toHaveProperty("outline")
    expect(calls[1]!.body).toMatchObject({ outline: "lineless", shading: "flat shading", detail: "low detail", description: "a frog" })
    for (const key of ["custom_start_frame", "enhance_prompt"]) expect(calls[1]!.body).not.toHaveProperty(key)
    for (const key of ["custom_start_frame", "outline", "enhance_prompt"]) expect(calls[2]!.body).not.toHaveProperty(key)
    expect(calls[3]!.body).toMatchObject({ enhance_prompt: true })
    expect(calls[4]!.body).not.toHaveProperty("enhance_prompt")
  })

  it("sends pro's concept image and style anchor, and drops both when rotating a reference", async () => {
    const client = new PixelLabClient("key")
    const concept = { base64: "Q09OQ0VQVA==", format: "jpeg" as const }
    const south = { base64: "U09VVEg=", format: "png" as const }
    const style = { base64: "U1RZTEU=", format: "png" as const }
    await client.createCharacter({ mode: "pro", description: "a", size: 64, directions: 8, template: "mannequin", concept, styleReference: style, styleCharacterId: "char-9" })
    await client.createCharacter({ mode: "pro", description: "a", size: 64, directions: 8, template: "mannequin", styleCharacterId: "char-9" })
    await client.createCharacter({ mode: "pro", description: "a", size: 64, directions: 8, template: "mannequin", reference: { south }, concept, styleCharacterId: "char-9" })
    expect(calls[0]!.body).toMatchObject({ method: "create_from_concept", concept_image: { type: "base64", base64: "Q09OQ0VQVA==", format: "jpeg" }, reference_image: { base64: "U1RZTEU=" }, style_character_id: "char-9" })
    expect(calls[1]!.body).toMatchObject({ method: "create_with_style", style_character_id: "char-9" })
    expect(calls[1]!.body).not.toHaveProperty("concept_image")
    expect(calls[2]!.body).toMatchObject({ method: "rotate_character", reference_image: { base64: "U09VVEg=" } })
    for (const key of ["concept_image", "style_character_id"]) expect(calls[2]!.body).not.toHaveProperty(key)
  })

  it("sends pro-flash its own shape: the sprite or a size, the style image with its size and traits, eight directions", async () => {
    const client = new PixelLabClient("key")
    const south = { base64: "U09VVEg=", format: "png" as const }
    const style = { base64: "U1RZTEU=", format: "png" as const }
    await client.createCharacter({ mode: "pro-flash", description: "a", size: 64, directions: 8, template: "custom", view: "side", seed: 3, styleReference: style, styleReferenceSize: { width: 48, height: 48 }, styleTraits: { palette: false, shading: true } })
    await client.createCharacter({ mode: "pro-flash", description: "a", size: 64, directions: 8, template: "mannequin", reference: { south }, proportions: "chibi", enhancePrompt: true })
    expect(calls[0]).toMatchObject({ path: "/v2/create-character-pro-flash", body: {
      description: "a", image_size: { width: 64, height: 64 }, template_id: "custom", n_directions: 8, view: "side", seed: 3,
      style_image: { image: { type: "base64", base64: "U1RZTEU=", format: "png" }, size: { width: 48, height: 48 } },
      style_options: { color_palette: false, shading: true },
    } })
    expect(calls[0]!.body).not.toHaveProperty("first_frame")
    expect(calls[1]!.body).toMatchObject({ first_frame: { type: "base64", base64: "U09VVEg=", format: "png" }, n_directions: 8 })
    for (const key of ["image_size", "style_image", "style_options", "proportions", "enhance_prompt"]) expect(calls[1]!.body).not.toHaveProperty(key)
  })

  it("sends a skeleton-v3 loop to /characters/animations with its template, and nothing template-only", async () => {
    const res = await new PixelLabClient("key").animateCharacter({
      characterId: "char-1",
      animationName: "walk",
      template: "walk",
      mode: "skeleton-v3",
      directions: ["east"],
      textGuidanceScale: 9,
      outline: "lineless",
    })
    expect(res.background_job_ids).toEqual(["job-s"])
    expect(calls[0]).toMatchObject({ path: "/v2/characters/animations", method: "POST" })
    expect(calls[0]!.body).toMatchObject({ character_id: "char-1", mode: "skeleton-v3", template_animation_id: "walk", directions: ["east"] })
    expect(calls[0]!.body).not.toHaveProperty("text_guidance_scale")
    expect(calls[0]!.body).not.toHaveProperty("outline")
    expect(calls[0]!.body).not.toHaveProperty("frame_count")
  })

  it("sends a state and an animation the way the API documents them", async () => {
    const client = new PixelLabClient("key")
    await client.createCharacterState({ characterId: "char-1", editDescription: "sitting", stateName: "chair", paletteFromReference: true, canvas: { width: 80, height: 80 } })
    await client.animateCharacter({ characterId: "char-1", animationName: "pixelkiln:cast/x", actionDescription: "spinning", mode: "v3", frameCount: 8, keepFirstFrame: false, directions: ["east"] })
    await client.animateCharacter({ characterId: "char-1", animationName: "pixelkiln:cast/y", template: "walk", mode: "template", frameCount: 8, directions: ["south"] })
    await client.deleteCharacterAnimations("char-1", { animationGroupId: "grp" }, "east")
    expect(calls[0]).toMatchObject({ path: "/v2/create-character-state", body: { character_id: "char-1", edit_description: "sitting", state_name: "chair", use_color_palette_from_reference: true, override_frame_size: { width: 80, height: 80 } } })
    expect(calls[1]!.body).toEqual({ character_id: "char-1", animation_name: "pixelkiln:cast/x", mode: "v3", directions: ["east"], action_description: "spinning", frame_count: 8, keep_first_frame: false })
    expect(calls[2]!.body).toEqual({ character_id: "char-1", animation_name: "pixelkiln:cast/y", mode: "template", directions: ["south"], template_animation_id: "walk" })
    expect(calls[3]).toMatchObject({ method: "DELETE", path: "/v2/characters/char-1/animations?animation_group_id=grp&direction=east" })
  })
})

/** A fake client that behaves like PixelLab's character records. */
function fakeClient() {
  const characters = new Map<string, { id: string; status: string; directions: number; rotations: Record<string, string>; animations: { display_name: string; animation_type: string; animation_group_id: string; directions: { direction: string; frames: string[] }[] }[]; group_id: string | null; state_name: string | null }>()
  let counter = 0
  const jobs = new Map<string, string>()
  const jobResponses = new Map<string, Record<string, unknown>>()
  // Separate from `jobs`/`jobResponses`: those two are iterated wholesale by
  // `landAnimation` to complete every in-flight animation job, and a base or
  // state's own background job must not be swept up in that.
  const baseJobs = new Map<string, string>()
  const baseJobUsage = new Map<string, Record<string, unknown>>()
  /** Custom `last_response` for a job whose only status source is getBackgroundJob (an outfit transfer). */
  const baseJobResponse = new Map<string, Record<string, unknown>>()
  const portraitJobs = new Map<string, { status: string; downloadUrl?: string; width?: number; height?: number }>()
  const client = {
    calls: [] as string[],
    /** Whether the character list carries the name PixelKiln gave an animation. */
    listNames: true,
    tags: new Map<string, string[]>(),
    pixels: new Map<string, Buffer>(),
    characters,
    created: [] as Record<string, unknown>[],
    animated: [] as Record<string, unknown>[],
    async createCharacter(args: { directions: 4 | 8; description: string }) {
      const id = `char-${++counter}`
      client.calls.push(`create:${args.description}`)
      client.created.push(args)
      characters.set(id, { id, status: "pending", directions: args.directions, rotations: {}, animations: [], group_id: null, state_name: null })
      baseJobs.set(`job-${id}`, "processing")
      return { character_id: id, background_job_id: `job-${id}` }
    },
    async createCharacterState(args: { characterId: string; editDescription: string }) {
      const parent = characters.get(args.characterId)
      if (!parent) throw new PixelLabError("POST /create-character-state → 404", 404, "")
      const id = `char-${++counter}`
      client.calls.push(`state:${args.characterId}:${args.editDescription}`)
      characters.set(id, { id, status: "pending", directions: parent.directions, rotations: {}, animations: [], group_id: "grp", state_name: args.editDescription })
      baseJobs.set(`job-${id}`, "processing")
      return { character_id: id, background_job_id: `job-${id}` }
    },
    async animateCharacter(args: { characterId: string; animationName: string; directions: string[]; mode: string }) {
      const character = characters.get(args.characterId)
      if (!character) throw new PixelLabError("POST /animate-character → 404", 404, "")
      client.calls.push(`animate:${args.characterId}:${args.animationName}:${args.directions.join(",")}:${args.mode}`)
      client.animated.push(args)
      const jobId = `anim-job-${++counter}`
      jobs.set(jobId, "processing")
      return { background_job_ids: [jobId], directions: args.directions }
    },
    async getCharacter(id: string) {
      const c = characters.get(id)
      if (!c) throw new PixelLabError(`GET /characters/${id} → 404`, 404, "")
      return { id, name: "n", prompt: "p", size: { width: 64, height: 64 }, directions: c.directions, created_at: "2026-01-01", animation_count: c.animations.length, template_id: "mannequin", status: c.status, rotation_urls: c.status === "completed" ? c.rotations : null, tags: [], group_id: c.group_id, state_name: c.state_name, animations: c.animations }
    },
    async getBackgroundJob(id: string) {
      if (baseJobs.has(id)) {
        return { id, status: baseJobs.get(id)!, last_response: baseJobResponse.get(id) ?? null, usage: baseJobUsage.get(id) ?? null }
      }
      const status = jobs.get(id)
      if (status === undefined) throw new PixelLabError(`GET /background-jobs/${id} → 404`, 404, "")
      const response = jobResponses.get(id) ?? null
      // Real jobs duplicate `usage` at the top level and under
      // `last_response.billing_usage`; the fake mirrors that so either
      // reading path can be exercised.
      return { id, status, last_response: response, usage: (response?.billing_usage as Record<string, unknown> | undefined) ?? null }
    },
    /** Test hook: PixelLab cleans finished jobs up; the animation list is what is left. */
    forgetJobs() { jobs.clear(); jobResponses.clear(); baseJobs.clear(); baseJobUsage.clear(); baseJobResponse.clear() },
    /** Test hook: what a base or state's own background job reports as billed once it completes. */
    setBaseUsage(characterId: string, usage: Record<string, unknown>) { baseJobUsage.set(`job-${characterId}`, usage) },
    /** Test hook: what any background job (by its own id) reports as billed once it completes. */
    setJobUsage(jobId: string, usage: Record<string, unknown>) { baseJobUsage.set(jobId, usage) },
    portraitsSet: [] as { characterId: string; base64: string }[],
    async createPortraitCharacterPro(args: { direction: string; image: { base64: string; format: string }; resultSize?: number }) {
      const jobId = `portrait-job-${++counter}`
      client.calls.push(`portrait:${args.direction}:${args.resultSize}`)
      portraitJobs.set(jobId, { status: "processing" })
      baseJobs.set(jobId, "processing")
      return { background_job_id: jobId, status: "processing", usage: null }
    },
    async getPortraitCharacterJob(jobId: string) {
      const job = portraitJobs.get(jobId)
      if (!job) throw new PixelLabError(`GET /portrait-character-pro/${jobId} → 404`, 404, "")
      if (job.status === "processing") throw new PixelLabError("locked", 423, "")
      return { status: job.status, download_url: job.downloadUrl ?? null, width: job.width ?? null, height: job.height ?? null }
    },
    async setCharacterPortrait(characterId: string, image: { base64: string; format: string }) {
      client.calls.push(`set-portrait:${characterId}`)
      client.portraitsSet.push({ characterId, base64: image.base64 })
      return { character_id: characterId, size: 16, url: `https://cdn.test/${characterId}/portrait.png`, usage: { type: "generations", generations: 0 } }
    },
    async transferOutfitV2(args: { frames: unknown[] }) {
      const jobId = `outfit-job-${++counter}`
      client.calls.push(`outfit:${args.frames.length}`)
      baseJobs.set(jobId, "processing")
      return { background_job_id: jobId, status: "processing", usage: null }
    },
    /** Test hook: land an outfit job with `count` resulting frame images, inline as base64. */
    completeOutfit(jobId: string, count: number) {
      const images = Array.from({ length: count }, (_, i) => ({ type: "base64", base64: px(8, 60 + i).toString("base64"), width: 8, height: 8 }))
      baseJobResponse.set(jobId, { quantized_images: images })
      baseJobs.set(jobId, "completed")
    },
    failOutfitJob(jobId: string) { baseJobs.set(jobId, "failed") },
    /** Test hook: land a portrait job with a downloadable square image. */
    completePortrait(jobId: string, size: number) {
      const url = `https://cdn.test/portrait/${jobId}.png`
      client.pixels.set(url, px(size, 50))
      portraitJobs.set(jobId, { status: "completed", downloadUrl: url, width: size, height: size })
      baseJobs.set(jobId, "completed")
    },
    failPortraitJob(jobId: string) { portraitJobs.set(jobId, { status: "failed" }) },
    async deleteCharacterAnimations(id: string, selector: { animationGroupId?: string }, direction?: string) {
      const c = characters.get(id)!
      client.calls.push(`delete:${id}:${selector.animationGroupId}:${direction}`)
      c.animations = c.animations.filter((a) => a.animation_group_id !== selector.animationGroupId)
      return { success: true, deleted_count: 1 }
    },
    async setCharacterTags(id: string, tags: string[]) { client.tags.set(id, tags) },
    async setTags() { throw new Error("objects endpoint must not be used for characters") },
    async download(url: string) {
      const bytes = client.pixels.get(url)
      if (!bytes) throw new Error(`no fake bytes for ${url}`)
      return bytes
    },
    /** Test hook: finish a character's rotations with distinct bytes per direction. */
    complete(id: string, shade: number) {
      const c = characters.get(id)!
      const order = c.directions === 4 ? ["south", "west", "east", "north"] : ["south", "south-east", "east", "north-east", "north", "north-west", "west", "south-west"]
      c.rotations = {}
      order.forEach((direction, i) => {
        const url = `https://cdn.test/${id}/${direction}.png?t=${shade}`
        c.rotations[direction] = url
        client.pixels.set(url, px(8, shade + i))
      })
      c.status = "completed"
      if (baseJobs.has(`job-${id}`)) baseJobs.set(`job-${id}`, "completed")
    },
    /** Test hook: land an animation with `count` frames for one direction. */
    landAnimation(id: string, name: string, direction: string, count: number, usage?: Record<string, unknown>) {
      const c = characters.get(id)!
      const frames = Array.from({ length: count }, (_, i) => {
        const url = `https://cdn.test/${id}/anim/${direction}/${i}.png`
        client.pixels.set(url, px(8, 100 + i))
        return url
      })
      const animationId = `anim-${direction}-${count}`
      const urls = frames.map((url) => url.replace("/anim/", `/animations/${animationId}/`))
      for (const [i, url] of urls.entries()) client.pixels.set(url, client.pixels.get(frames[i]!)!)
      // The job completes with the frames; the character lists the group without the name in fallback tests.
      c.animations.push({ display_name: client.listNames ? name : null as unknown as string, animation_type: "walk", animation_group_id: `grp-${name}-${direction}`, directions: [{ direction, frames: urls }] })
      for (const [jobId] of jobs) {
        jobs.set(jobId, "completed")
        jobResponses.set(jobId, { direction, frame_count: count, animation_id: animationId, character_id: id, storage_urls: { frames: urls }, ...(usage ? { billing_usage: usage } : {}) })
      }
    },
    failJob() { for (const [jobId] of jobs) jobs.set(jobId, "failed") },
  }
  return client
}

describe("the pipeline", () => {
  it("generates a base, then a state from its character id, then an animation into review", async () => {
    const file = await writeManifest()
    const client = fakeClient()
    const provider = new PixelLabProvider(client as never)
    const project = () => openProject(file, { env: false })

    // Base: the only actionable item; the state is blocked, the animation too.
    let p = await project()
    let plan = await p.plan()
    expect(plan.actionable.map((i) => i.key)).toEqual(["cast/mira"])
    expect(plan.items.find((i) => i.key === "cast/mira.fireman_spin")).toMatchObject({ state: "blocked" })
    await submit(provider, p.loaded, plan.actionable, p.lock, p.lockPath, { spacingMs: 0 })
    expect(client.calls).toEqual(["create:pixel art, small young woman, dark curly hair in a bun, oversized hoodie, clean lines"])
    expect(p.lock.entries["cast/mira"]).toMatchObject({ status: "processing", jobId: "char-1", cost: 1 })
    expect(await poll(provider, p.lock, p.lockPath, { intervalMs: 0, timeoutMs: 0, specs: p.specs })).toMatchObject({ stillRunning: 1 })
    client.complete("char-1", 10)
    await poll(provider, p.lock, p.lockPath, { intervalMs: 0, specs: p.specs })
    expect(p.lock.entries["cast/mira"]).toMatchObject({ status: "selected", objectId: "char-1" })
    expect(p.lock.entries["cast/mira"]!.sourceUrls.map((s) => s.role)).toEqual(["south", "south-east", "east", "north-east", "north", "north-west", "west", "south-west"])
    await fetchAssets(provider, p.specs, p.lock, p.lockPath)
    const base = p.lock.entries["cast/mira"]!
    expect(base.status).toBe("downloaded")
    expect(base.outputs.map((o) => path.basename(o.path))).toEqual(["mira-south.png", "mira-south-east.png", "mira-east.png", "mira-north-east.png", "mira-north.png", "mira-north-west.png", "mira-west.png", "mira-south-west.png"])
    expect(base.providerMetadata.pixellab).toMatchObject({ character: { characterId: "char-1", directions: 8 } })
    expect(existsSync(path.join(dir, "art", "characters", "mira-south.png"))).toBe(true)

    // State: now actionable at its tier, submitted with the parent's character id.
    p = await project()
    plan = await p.plan()
    expect(plan.items.find((i) => i.key === "cast/mira")).toMatchObject({ state: "ok" })
    expect(plan.actionable.map((i) => i.key)).toEqual(["cast/mira.chair_spin"])
    expect(plan.groups[0]!.cost).toBe(40)
    await submit(provider, p.loaded, plan.actionable, p.lock, p.lockPath, { spacingMs: 0 })
    expect(client.calls.at(-1)).toBe("state:char-1:sitting in the air with knees up, spinning")
    client.complete("char-2", 30)
    await poll(provider, p.lock, p.lockPath, { intervalMs: 0, specs: p.specs })
    await fetchAssets(provider, p.specs, p.lock, p.lockPath)
    expect(p.lock.entries["cast/mira.chair_spin"]).toMatchObject({ status: "downloaded", objectId: "char-2" })

    // Animation: one direction, lands in review as an ordered frame set.
    p = await project()
    plan = await p.plan()
    expect(plan.actionable.map((i) => i.key)).toEqual(["cast/mira.fireman_spin"])
    expect(plan.groups[0]!.cost).toBe(1)
    await submit(provider, p.loaded, plan.actionable, p.lock, p.lockPath, { spacingMs: 0 })
    expect(client.calls.at(-1)).toBe("animate:char-2:pixelkiln:cast/mira.fireman_spin:east:v3")
    expect(await poll(provider, p.lock, p.lockPath, { intervalMs: 0, timeoutMs: 0, specs: p.specs })).toMatchObject({ stillRunning: 1 })
    client.landAnimation("char-2", characterAnimationName({ styleId: "cast", assetId: "mira.fireman_spin" }), "east", 9)
    const polled = await poll(provider, p.lock, p.lockPath, { intervalMs: 0, specs: p.specs })
    expect(polled.review).toBe(1)
    const entry = p.lock.entries["cast/mira.fireman_spin"]!
    expect(entry.status).toBe("review")
    expect(entry.providerMetadata.pixellab).toMatchObject({ frameSet: { fps: 10, count: 9 }, character: { direction: "east", characterId: "char-2" } })
    const state = await provider.poll(entry.reviewObjectId!, "character", { spec: p.specs.find((s) => s.assetId === "mira.fireman_spin") })
    expect(state).toMatchObject({ status: "review-set", fps: 10, objectId: expect.stringMatching(/^char-2#/) })
    expect((state as { sources: { role?: string }[] }).sources.map((s) => s.role)).toEqual(Array.from({ length: 9 }, (_, i) => `frame-${String(i).padStart(2, "0")}`))
    expect(resumeActions(p.specs, p.lock)).toEqual([{ command: "pick", keys: ["cast/mira.fireman_spin"] }])
  })

  it("refuses a state whose parent is not in the lockfile, naming the parent", async () => {
    const file = await writeManifest()
    const client = fakeClient()
    const provider = new PixelLabProvider(client as never)
    const p = await openProject(file, { env: false })
    const state = p.specs.find((s) => s.assetId === "mira.chair_spin")!
    const plan = await p.plan()
    const item = plan.items.find((i) => i.key === "cast/mira.chair_spin")!
    expect(item.state).toBe("blocked")
    expect(item.reason).toMatch(/state parent cast\/mira is not ready: parent is not in the lockfile/)
    // Forced past planning, submit refuses at the spending boundary.
    const result = await submit(provider, p.loaded, [{ spec: state, key: "cast/mira.chair_spin", state: "missing", reason: "forced" }], p.lock, p.lockPath, { spacingMs: 0 }).catch((e: Error) => e)
    expect(String(result)).toMatch(/cast\/mira/)
    expect(client.calls).toEqual([])
  })

  it("makes states stale when their base is regenerated, and re-rolls its own animation", async () => {
    const file = await writeManifest()
    const client = fakeClient()
    const provider = new PixelLabProvider(client as never)
    const run = async (keys: string[], complete: (id: string) => void) => {
      const p = await openProject(file, { env: false })
      const plan = await p.plan()
      const items = plan.items.filter((i) => keys.includes(i.key))
      await submit(provider, p.loaded, items, p.lock, p.lockPath, { spacingMs: 0 })
      for (const key of keys) complete(p.lock.entries[key]!.jobId!)
      await poll(provider, p.lock, p.lockPath, { intervalMs: 0, specs: p.specs })
      await fetchAssets(provider, p.specs, p.lock, p.lockPath)
      return p
    }
    await run(["cast/mira"], (id) => client.complete(id, 10))
    await run(["cast/mira.chair_spin"], (id) => client.complete(id, 30))

    // Regenerate the base with different pixels: the state's parent hash moved.
    let p = await openProject(file, { env: false })
    const forced = await buildPlan(p.specs, p.lock, { force: true })
    await submit(provider, p.loaded, forced.actionable.filter((i) => i.key === "cast/mira"), p.lock, p.lockPath, { spacingMs: 0 })
    client.complete(p.lock.entries["cast/mira"]!.jobId!, 50)
    await poll(provider, p.lock, p.lockPath, { intervalMs: 0, specs: p.specs })
    await fetchAssets(provider, p.specs, p.lock, p.lockPath)
    p = await openProject(file, { env: false })
    const plan = await p.plan()
    expect(plan.items.find((i) => i.key === "cast/mira")).toMatchObject({ state: "ok" })
    expect(plan.items.find((i) => i.key === "cast/mira.chair_spin")).toMatchObject({ state: "stale" })
    expect(plan.items.find((i) => i.key === "cast/mira.fireman_spin")).toMatchObject({ state: "blocked" })

    // A re-rolled animation clears its own earlier take for that direction first.
    await run(["cast/mira.chair_spin"], (id) => client.complete(id, 70))
    const name = characterAnimationName({ styleId: "cast", assetId: "mira.fireman_spin" })
    p = await openProject(file, { env: false })
    await submit(provider, p.loaded, (await p.plan()).actionable, p.lock, p.lockPath, { spacingMs: 0 })
    const stateId = p.lock.entries["cast/mira.chair_spin"]!.objectId!
    client.landAnimation(stateId, name, "east", 5)
    await poll(provider, p.lock, p.lockPath, { intervalMs: 0, specs: p.specs })
    expect(p.lock.entries["cast/mira.fireman_spin"]!.status).toBe("review")
    // Forced by hand: a forced plan defers a child whose parent is forced too.
    const animationSpec = p.specs.find((s) => s.assetId === "mira.fireman_spin")!
    await submit(provider, p.loaded, [{ spec: animationSpec, key: "cast/mira.fireman_spin", state: "missing", reason: "forced" }], p.lock, p.lockPath, { spacingMs: 0 })
    expect(client.calls.filter((c) => c.startsWith("delete:"))).toEqual([`delete:${stateId}:grp-${name}-east:east`])
  })

  it("reports a failed animation job and tags the character, not an object", async () => {
    const file = await writeManifest({ style: { tags: ["cast"] } })
    const client = fakeClient()
    const provider = new PixelLabProvider(client as never)
    let p = await openProject(file, { env: false })
    await submit(provider, p.loaded, (await p.plan()).actionable, p.lock, p.lockPath, { spacingMs: 0 })
    client.complete("char-1", 10)
    await poll(provider, p.lock, p.lockPath, { intervalMs: 0, specs: p.specs })
    await fetchAssets(provider, p.specs, p.lock, p.lockPath)
    expect(await pushTags(provider, p.specs, p.lock)).toBe(1)
    expect(client.tags.get("char-1")).toContain("cast")

    // A direct animation of the base (v3, south) whose job fails upstream.
    await writeManifest({ style: { tags: ["cast"] }, assets: {
      mira: { prompt: "small young woman, dark curly hair in a bun, oversized hoodie" },
      "mira.idle": { prompt: "breathing", animation: { of: "mira" } },
    } })
    p = await openProject(file, { env: false })
    const plan = await p.plan()
    expect(plan.actionable.map((i) => i.key)).toEqual(["cast/mira.idle"])
    await submit(provider, p.loaded, plan.actionable, p.lock, p.lockPath, { spacingMs: 0 })
    client.failJob()
    await poll(provider, p.lock, p.lockPath, { intervalMs: 0, specs: p.specs })
    expect(p.lock.entries["cast/mira.idle"]).toMatchObject({ status: "failed", error: expect.stringContaining("animation generation failed") })
  })

  it("finds a finished animation through its job even when the character list lost the name, and by id once the job is gone", async () => {
    const file = await writeManifest({ assets: {
      mira: { prompt: "small young woman, dark curly hair in a bun, oversized hoodie" },
      "mira.walk": { prompt: "", animation: { of: "mira", template: "walk", direction: "south", fps: 6 } },
    } })
    const client = fakeClient()
    client.listNames = false
    const provider = new PixelLabProvider(client as never)
    let p = await openProject(file, { env: false })
    await submit(provider, p.loaded, (await p.plan()).actionable, p.lock, p.lockPath, { spacingMs: 0 })
    client.complete("char-1", 10)
    await poll(provider, p.lock, p.lockPath, { intervalMs: 0, specs: p.specs })
    await fetchAssets(provider, p.specs, p.lock, p.lockPath)
    p = await openProject(file, { env: false })
    await submit(provider, p.loaded, (await p.plan()).actionable, p.lock, p.lockPath, { spacingMs: 0 })
    client.landAnimation("char-1", "whatever-pixellab-called-it", "south", 6)

    // The job says where the frames are; the group id comes from the URL match.
    await poll(provider, p.lock, p.lockPath, { intervalMs: 0, specs: p.specs })
    const entry = p.lock.entries["cast/mira.walk"]!
    expect(entry.status).toBe("review")
    expect(entry.providerMetadata.pixellab).toMatchObject({ frameSet: { fps: 6, count: 6 }, character: { animationId: "anim-south-6", animationGroupId: "grp-whatever-pixellab-called-it-south" } })

    // With the job cleaned up, the recorded animation id still finds the frames.
    client.forgetJobs()
    const again = await provider.poll(entry.reviewObjectId!, "character", { spec: p.specs.find((s) => s.assetId === "mira.walk"), metadata: entry.providerMetadata.pixellab })
    expect(again.status).toBe("review-set")

    // A re-roll deletes by the group id the poll recorded, not by name.
    const walkSpec = p.specs.find((s) => s.assetId === "mira.walk")!
    await submit(provider, p.loaded, [{ spec: walkSpec, key: "cast/mira.walk", state: "missing", reason: "forced" }], p.lock, p.lockPath, { spacingMs: 0 })
    expect(client.calls.filter((c) => c.startsWith("delete:"))).toEqual(["delete:char-1:grp-whatever-pixellab-called-it-south:south"])
  })

  it("re-resolves a character's rotation and frame URLs for fetch --refresh, and only those", async () => {
    const client = fakeClient()
    const provider = new PixelLabProvider(client as never)
    await client.createCharacter({ directions: 4, description: "x" })
    client.complete("char-1", 10)
    await client.animateCharacter({ characterId: "char-1", animationName: "pixelkiln:cast/x.walk", directions: ["east"], mode: "v3" })
    client.landAnimation("char-1", "pixelkiln:cast/x.walk", "east", 4)
    const sources = [{ url: "https://cdn.test/char-1/south.png?t=1", role: "south" }]

    const base = await provider.refreshSources("char-1", { generator: "character", sources })
    expect(base!.map((s) => s.role)).toEqual(["south", "west", "east", "north"])
    expect(base![0]!.url).toBe("https://cdn.test/char-1/south.png?t=10")

    const byGroup = await provider.refreshSources("char-1#grp-pixelkiln:cast/x.walk-east", {
      generator: "character", sources, metadata: { character: { direction: "east" } },
    })
    expect(byGroup!.map((s) => s.role)).toEqual(["frame-00", "frame-01", "frame-02", "frame-03"])
    expect(byGroup![0]!.url).toMatch(/\/animations\/anim-east-4\/east\/0\.png$/)
    // Without the group (an older record), the recorded name and id still find it.
    const byName = await provider.refreshSources("char-1#anim-east-4", {
      generator: "character", sources, metadata: { character: { direction: "east", animationName: "pixelkiln:cast/x.walk", animationId: "anim-east-4" } },
    })
    expect(byName).toHaveLength(4)

    expect(await provider.refreshSources("char-1#grp-nope", { generator: "character", sources, metadata: { character: { direction: "east" } } })).toBeNull()
    expect(await provider.refreshSources("char-gone", { generator: "character", sources })).toBeNull()
    expect(await provider.refreshSources("obj-1", { generator: "map", sources })).toBeUndefined()
  })

  it("snaps every direction to an enforced palette and keeps the raw bytes", async () => {
    const file = await writeManifest({ style: { palette: ["#000000", "#ffffff"], enforcePalette: true } })
    const client = fakeClient()
    const provider = new PixelLabProvider(client as never)
    const p = await openProject(file, { env: false })
    await submit(provider, p.loaded, (await p.plan()).actionable, p.lock, p.lockPath, { spacingMs: 0 })
    client.complete("char-1", 120)
    await poll(provider, p.lock, p.lockPath, { intervalMs: 0, specs: p.specs })
    await fetchAssets(provider, p.specs, p.lock, p.lockPath)
    const entry = p.lock.entries["cast/mira"]!
    expect(entry.outputs).toHaveLength(8)
    expect(entry.outputs.every((o) => o.raw)).toBe(true)
    expect(entry.postprocess?.palette?.colors).toEqual(["#000000", "#ffffff"])
    const south = await readFile(path.join(dir, "art", "characters", "mira-south.png"))
    expect(south.length).toBeGreaterThan(0)
  })
})

describe("billed usage", () => {
  it("records what a base's background job actually billed, next to the submit-time estimate", async () => {
    const file = await writeManifest({ assets: { mira: { prompt: "small young woman" } } })
    const client = fakeClient()
    const provider = new PixelLabProvider(client as never)
    const p = await openProject(file, { env: false })
    await submit(provider, p.loaded, (await p.plan()).actionable, p.lock, p.lockPath, { spacingMs: 0 })
    expect(p.lock.entries["cast/mira"]!.cost).toBe(1)
    client.complete("char-1", 10)
    client.setBaseUsage("char-1", { type: "generations", generations: 2 })
    await poll(provider, p.lock, p.lockPath, { intervalMs: 0, specs: p.specs })
    expect(p.lock.entries["cast/mira"]).toMatchObject({ cost: 1, billed: { amount: 2, unit: "generations" } })
  })

  it("records a state's actual bill against its wider estimate tier", async () => {
    const file = await writeManifest()
    const client = fakeClient()
    const provider = new PixelLabProvider(client as never)
    let p = await openProject(file, { env: false })
    await submit(provider, p.loaded, (await p.plan()).actionable, p.lock, p.lockPath, { spacingMs: 0 })
    client.complete("char-1", 10)
    await poll(provider, p.lock, p.lockPath, { intervalMs: 0, specs: p.specs })
    await fetchAssets(provider, p.specs, p.lock, p.lockPath)

    p = await openProject(file, { env: false })
    const plan = await p.plan()
    expect(plan.actionable.map((i) => i.key)).toEqual(["cast/mira.chair_spin"])
    await submit(provider, p.loaded, plan.actionable, p.lock, p.lockPath, { spacingMs: 0 })
    expect(p.lock.entries["cast/mira.chair_spin"]!.cost).toBe(40)
    client.complete("char-2", 30)
    // The live example from issue #143: a 64px state estimated at 40 billed about 22.
    client.setBaseUsage("char-2", { type: "generations", generations: 22 })
    await poll(provider, p.lock, p.lockPath, { intervalMs: 0, specs: p.specs })
    expect(p.lock.entries["cast/mira.chair_spin"]).toMatchObject({ cost: 40, billed: { amount: 22, unit: "generations" } })
  })

  it("records an animation's actual bill from the same background job poll already reads for its frames", async () => {
    const file = await writeManifest()
    const client = fakeClient()
    const provider = new PixelLabProvider(client as never)
    let p = await openProject(file, { env: false })
    await submit(provider, p.loaded, (await p.plan()).actionable, p.lock, p.lockPath, { spacingMs: 0 })
    client.complete("char-1", 10)
    await poll(provider, p.lock, p.lockPath, { intervalMs: 0, specs: p.specs })
    await fetchAssets(provider, p.specs, p.lock, p.lockPath)

    p = await openProject(file, { env: false })
    await submit(provider, p.loaded, (await p.plan()).actionable, p.lock, p.lockPath, { spacingMs: 0 })
    client.complete("char-2", 30)
    await poll(provider, p.lock, p.lockPath, { intervalMs: 0, specs: p.specs })
    await fetchAssets(provider, p.specs, p.lock, p.lockPath)

    p = await openProject(file, { env: false })
    const animCost = (await p.plan()).actionable[0]!.spec.cost
    await submit(provider, p.loaded, (await p.plan()).actionable, p.lock, p.lockPath, { spacingMs: 0 })
    client.landAnimation("char-2", "pixelkiln:cast/mira.fireman_spin", "east", 8, { type: "generations", generations: animCost + 3 })
    await poll(provider, p.lock, p.lockPath, { intervalMs: 0, specs: p.specs })
    const entry = p.lock.entries["cast/mira.fireman_spin"]!
    expect(entry.status).toBe("review")
    expect(entry.billed).toEqual({ amount: animCost + 3, unit: "generations" })
  })

  it("records no billed amount once the background job record is gone, rather than guessing", async () => {
    const file = await writeManifest({ assets: { mira: { prompt: "small young woman" } } })
    const client = fakeClient()
    const provider = new PixelLabProvider(client as never)
    const p = await openProject(file, { env: false })
    await submit(provider, p.loaded, (await p.plan()).actionable, p.lock, p.lockPath, { spacingMs: 0 })
    client.complete("char-1", 10)
    client.forgetJobs()
    await poll(provider, p.lock, p.lockPath, { intervalMs: 0, specs: p.specs })
    expect(p.lock.entries["cast/mira"]).toMatchObject({ status: "selected", billed: null })
  })
})

describe("portraits", () => {
  it("resolves a portrait's shape and size, independent of the style's own size", async () => {
    const file = await writeManifest({
      assets: {
        mira: { prompt: "small young woman" },
        "mira.bust": { portrait: { of: "mira", size: 128 } },
      },
    })
    const specs = await resolveSpecs(await loadManifest(file))
    const bust = specs.find((s) => s.assetId === "mira.bust")!
    expect(bust.character).toMatchObject({ kind: "portrait", portrait: { size: 128 }, parentAssetId: "mira" })
    expect(bust.width).toBe(128)
    expect(bust.height).toBe(128)
    // No prompt is sent; the endpoint takes an image, not text.
    expect(bust.prompt).toBe("")
  })

  it("refuses a prompt-less shape to combine with state, animation, or a reference/concept", async () => {
    const refused = async (overrides: Parameters<typeof writeManifest>[0]) => resolveSpecs(await loadManifest(await writeManifest(overrides)))
    await expect(refused({ assets: {
      mira: { prompt: "a hero" },
      "mira.dented": { prompt: "dented", state: { of: "mira" } },
    }, extraStyles: {} })).resolves.toBeDefined() // sanity: state alone is fine
    await expect(refused({ assets: {
      mira: { prompt: "a hero" },
      "mira.bust": { state: { of: "mira" }, portrait: { of: "mira" } },
    } })).rejects.toThrow(/mutually exclusive/)
    await expect(refused({ assets: {
      mira: { prompt: "a hero" },
      "mira.bust": { portrait: { of: "mira" }, reference: "refs/x.png" },
    } })).rejects.toThrow(/a state, animation, mirror, portrait, or outfit takes its look from its parent/)
  })

  it("submits the parent's local south file, attaches the result to the parent's record once drawn, and records what it billed", async () => {
    const file = await writeManifest({
      assets: {
        mira: { prompt: "small young woman" },
        "mira.bust": { portrait: { of: "mira", size: 16 } },
      },
    })
    const client = fakeClient()
    const provider = new PixelLabProvider(client as never)
    let p = await openProject(file, { env: false })
    await submit(provider, p.loaded, (await p.plan()).actionable, p.lock, p.lockPath, { spacingMs: 0 })
    client.complete("char-1", 10)
    await poll(provider, p.lock, p.lockPath, { intervalMs: 0, specs: p.specs })
    await fetchAssets(provider, p.specs, p.lock, p.lockPath)

    p = await openProject(file, { env: false })
    const plan = await p.plan()
    expect(plan.actionable.map((i) => i.key)).toEqual(["cast/mira.bust"])
    expect(plan.groups[0]!.cost).toBe(20)
    await submit(provider, p.loaded, plan.actionable, p.lock, p.lockPath, { spacingMs: 0 })
    expect(client.calls.at(-1)).toBe("portrait:character_to_portrait:16")
    const jobId = p.lock.entries["cast/mira.bust"]!.jobId!

    // Still drawing: 423 reads as processing, same as tiles and map objects.
    expect(await poll(provider, p.lock, p.lockPath, { intervalMs: 0, timeoutMs: 0, specs: p.specs })).toMatchObject({ stillRunning: 1 })

    client.completePortrait(jobId, 16)
    client.setJobUsage(jobId, { type: "generations", generations: 20 })
    await poll(provider, p.lock, p.lockPath, { intervalMs: 0, specs: p.specs })
    expect(p.lock.entries["cast/mira.bust"]).toMatchObject({ status: "selected", billed: { amount: 20, unit: "generations" } })
    // SetPortrait attached it to the parent character, not to itself.
    expect(client.portraitsSet).toEqual([{ characterId: "char-1", base64: expect.any(String) }])

    await fetchAssets(provider, p.specs, p.lock, p.lockPath)
    const bust = p.lock.entries["cast/mira.bust"]!
    expect(bust.status).toBe("downloaded")
    expect(path.basename(bust.outputs[0]!.path)).toBe("mira.bust.png")
  })

  it("fails cleanly when the portrait job fails upstream", async () => {
    const file = await writeManifest({
      assets: {
        mira: { prompt: "small young woman" },
        "mira.bust": { portrait: { of: "mira" } },
      },
    })
    const client = fakeClient()
    const provider = new PixelLabProvider(client as never)
    let p = await openProject(file, { env: false })
    await submit(provider, p.loaded, (await p.plan()).actionable, p.lock, p.lockPath, { spacingMs: 0 })
    client.complete("char-1", 10)
    await poll(provider, p.lock, p.lockPath, { intervalMs: 0, specs: p.specs })
    await fetchAssets(provider, p.specs, p.lock, p.lockPath)

    p = await openProject(file, { env: false })
    await submit(provider, p.loaded, (await p.plan()).actionable, p.lock, p.lockPath, { spacingMs: 0 })
    const jobId = p.lock.entries["cast/mira.bust"]!.jobId!
    client.failPortraitJob(jobId)
    await poll(provider, p.lock, p.lockPath, { intervalMs: 0, specs: p.specs })
    expect(p.lock.entries["cast/mira.bust"]).toMatchObject({ status: "failed", error: expect.stringContaining("portrait generation failed") })
    expect(client.portraitsSet).toEqual([])
  })

  it("refuses a portrait's view outside the endpoint's own enum, even on a standard base that allows more", async () => {
    const file = await writeManifest({
      style: { view: "oblique", directions: 4 },
      assets: {
        mira: { prompt: "small young woman" },
        "mira.bust": { portrait: { of: "mira" } },
      },
    })
    // Resolving specs validates every character shape up front (oblique is
    // fine for the standard-mode base but not for the portrait's own,
    // narrower view enum), so this fails before anything is generated.
    await expect(openProject(file, { env: false })).rejects.toThrow(/PixelLab portrait view must be one of/)
  })
})

describe("outfit transfer", () => {
  function armoredManifest(overrides: Record<string, unknown> = {}) {
    return writeManifest({
      assets: {
        mira: { prompt: "small young woman" },
        "mira.walk": { prompt: "walking forward", animation: { of: "mira", direction: "south", frames: 4, fps: 8 } },
        "mira.walk.armored": { outfit: { of: "mira.walk", reference: "armor.png" } },
        ...overrides,
      },
    })
  }

  /** A loop lands in "review", like any frame set; accept it into "selected" the way `pick` does. */
  async function acceptReview(provider: PixelLabProvider, p: { lock: Lock; specs: ResolvedSpec[] }, key: string) {
    const entry = p.lock.entries[key]!
    const spec = p.specs.find((s) => lockKey(s.styleId, s.assetId) === key)
    const state = await provider.poll(entry.reviewObjectId!, entry.generator, { spec, metadata: entry.providerMetadata?.pixellab })
    if (state.status !== "review-set") throw new Error(`${key} is not ready for review`)
    upsert(p.lock, key, { status: "selected", objectId: state.objectId, sourceUrl: state.sources[0]?.url ?? null, sourceUrls: state.sources })
  }

  it("resolves an outfit's shape from its source loop, with no prompt of its own", async () => {
    await writeFile(path.join(dir, "armor.png"), px(32, 99))
    const specs = await resolveSpecs(await loadManifest(await armoredManifest()))
    const source = specs.find((s) => s.assetId === "mira.walk")!
    const outfit = specs.find((s) => s.assetId === "mira.walk.armored")!
    expect(outfit.character).toMatchObject({ kind: "outfit", parentAssetId: "mira.walk" })
    expect(outfit.character!.outfit!.reference).toMatchObject({ width: 32, height: 32 })
    expect(outfit.prompt).toBe("")
    expect(outfit.width).toBe(source.width)
    expect(outfit.height).toBe(source.height)
    expect(outfit.generator).toBe("character")
  })

  it("refuses re-clothing a non-loop, and refuses combining outfit with a prompt shape", async () => {
    await writeFile(path.join(dir, "armor.png"), px(32, 99))
    const resolve = async (overrides: Record<string, unknown>) => resolveSpecs(await loadManifest(await writeManifest(overrides)))
    await expect(resolve({
      assets: {
        mira: { prompt: "small young woman" },
        "mira.walk": { prompt: "walking forward", animation: { of: "mira", direction: "south", frames: 4, fps: 8 } },
        "mira.walk.armored": { outfit: { of: "mira", reference: "armor.png" } },
      },
    })).rejects.toThrow(/outfit "mira" is not a character loop/)
    await expect(resolve({
      assets: {
        mira: { prompt: "a hero" },
        "mira.walk": { prompt: "walking", animation: { of: "mira", direction: "south", frames: 4 } },
        "mira.walk.armored": { prompt: "armored", outfit: { of: "mira.walk", reference: "armor.png" }, state: { of: "mira" } },
      },
    })).rejects.toThrow(/mutually exclusive/)
  })

  it("submits the source loop's downloaded frames and the reference image, and records what it billed", async () => {
    await writeFile(path.join(dir, "armor.png"), px(32, 99))
    const file = await armoredManifest()
    const client = fakeClient()
    const provider = new PixelLabProvider(client as never)
    let p = await openProject(file, { env: false })
    await submit(provider, p.loaded, (await p.plan()).actionable, p.lock, p.lockPath, { spacingMs: 0 })
    client.complete("char-1", 10)
    await poll(provider, p.lock, p.lockPath, { intervalMs: 0, specs: p.specs })
    await fetchAssets(provider, p.specs, p.lock, p.lockPath)

    p = await openProject(file, { env: false })
    const loopPlan = await p.plan()
    expect(loopPlan.actionable.map((i) => i.key)).toEqual(["cast/mira.walk"])
    await submit(provider, p.loaded, loopPlan.actionable, p.lock, p.lockPath, { spacingMs: 0 })
    client.landAnimation("char-1", "pixelkiln:cast/mira.walk", "south", 4)
    await poll(provider, p.lock, p.lockPath, { intervalMs: 0, specs: p.specs })
    await acceptReview(provider, p, "cast/mira.walk")
    await fetchAssets(provider, p.specs, p.lock, p.lockPath)

    p = await openProject(file, { env: false })
    const outfitPlan = await p.plan()
    expect(outfitPlan.actionable.map((i) => i.key)).toEqual(["cast/mira.walk.armored"])
    expect(outfitPlan.groups[0]!.cost).toBe(20)
    await submit(provider, p.loaded, outfitPlan.actionable, p.lock, p.lockPath, { spacingMs: 0 })
    expect(client.calls.at(-1)).toBe("outfit:4")
    const jobId = p.lock.entries["cast/mira.walk.armored"]!.jobId!

    client.completeOutfit(jobId, 4)
    client.setJobUsage(jobId, { type: "generations", generations: 20 })
    await poll(provider, p.lock, p.lockPath, { intervalMs: 0, specs: p.specs })
    expect(p.lock.entries["cast/mira.walk.armored"]).toMatchObject({
      status: "selected",
      billed: { amount: 20, unit: "generations" },
    })

    await fetchAssets(provider, p.specs, p.lock, p.lockPath)
    const entry = p.lock.entries["cast/mira.walk.armored"]!
    expect(entry.status).toBe("downloaded")
    expect(entry.outputs.map((o) => o.role)).toEqual(["frame-00", "frame-01", "frame-02", "frame-03"])
    expect(entry.outfit).toMatchObject({ sourceAssetId: "mira.walk" })
  })

  it("goes stale when the source loop is regenerated", async () => {
    await writeFile(path.join(dir, "armor.png"), px(32, 99))
    const file = await armoredManifest()
    const client = fakeClient()
    const provider = new PixelLabProvider(client as never)
    let p = await openProject(file, { env: false })
    await submit(provider, p.loaded, (await p.plan()).actionable, p.lock, p.lockPath, { spacingMs: 0 })
    client.complete("char-1", 10)
    await poll(provider, p.lock, p.lockPath, { intervalMs: 0, specs: p.specs })
    await fetchAssets(provider, p.specs, p.lock, p.lockPath)

    p = await openProject(file, { env: false })
    await submit(provider, p.loaded, (await p.plan()).actionable, p.lock, p.lockPath, { spacingMs: 0 })
    client.landAnimation("char-1", "pixelkiln:cast/mira.walk", "south", 4)
    await poll(provider, p.lock, p.lockPath, { intervalMs: 0, specs: p.specs })
    await acceptReview(provider, p, "cast/mira.walk")
    await fetchAssets(provider, p.specs, p.lock, p.lockPath)

    p = await openProject(file, { env: false })
    await submit(provider, p.loaded, (await p.plan()).actionable, p.lock, p.lockPath, { spacingMs: 0 })
    const jobId = p.lock.entries["cast/mira.walk.armored"]!.jobId!
    client.completeOutfit(jobId, 4)
    await poll(provider, p.lock, p.lockPath, { intervalMs: 0, specs: p.specs })
    await fetchAssets(provider, p.specs, p.lock, p.lockPath)
    const p2 = await openProject(file, { env: false })
    expect((await p2.plan()).items.find((i) => i.key === "cast/mira.walk.armored")).toMatchObject({ state: "ok" })

    // Simulate the loop being regenerated: new bytes land on disk and the
    // lock is updated to match, without re-running the whole animation
    // pipeline for it (a hand-modified file, caught separately, is not
    // what this test is after).
    const walkEntry = p2.lock.entries["cast/mira.walk"]!
    const newOutputs = await Promise.all(walkEntry.outputs.map(async (o) => {
      const abs = path.resolve(dir, o.path)
      await writeFile(abs, px(8, 200))
      return { ...o, sha256: await sha256File(abs) }
    }))
    upsert(p2.lock, "cast/mira.walk", { outputs: newOutputs })
    const rePlan = await p2.plan()
    expect(rePlan.items.find((i) => i.key === "cast/mira.walk.armored")).toMatchObject({
      state: "stale",
      reason: expect.stringContaining("outfit source mira.walk changed"),
    })
  })

  it("refuses fewer than 2 source frames", async () => {
    await writeFile(path.join(dir, "armor.png"), px(32, 99))
    const file = await armoredManifest({ "mira.walk": { prompt: "walking", animation: { of: "mira", template: "walk", direction: "south" } } })
    const client = fakeClient()
    const provider = new PixelLabProvider(client as never)
    let p = await openProject(file, { env: false })
    await submit(provider, p.loaded, (await p.plan()).actionable, p.lock, p.lockPath, { spacingMs: 0 })
    client.complete("char-1", 10)
    await poll(provider, p.lock, p.lockPath, { intervalMs: 0, specs: p.specs })
    await fetchAssets(provider, p.specs, p.lock, p.lockPath)

    p = await openProject(file, { env: false })
    await submit(provider, p.loaded, (await p.plan()).actionable, p.lock, p.lockPath, { spacingMs: 0 })
    client.landAnimation("char-1", "pixelkiln:cast/mira.walk", "south", 1)
    await poll(provider, p.lock, p.lockPath, { intervalMs: 0, specs: p.specs })
    await acceptReview(provider, p, "cast/mira.walk")
    await fetchAssets(provider, p.specs, p.lock, p.lockPath)

    p = await openProject(file, { env: false })
    const result = await submit(provider, p.loaded, (await p.plan()).actionable, p.lock, p.lockPath, { spacingMs: 0 })
    expect(result.failed).toBe(1)
    expect(p.lock.entries["cast/mira.walk.armored"]!.error).toMatch(/needs 2 to 16/)
  })

  it("fails cleanly when the outfit job fails upstream", async () => {
    await writeFile(path.join(dir, "armor.png"), px(32, 99))
    const file = await armoredManifest()
    const client = fakeClient()
    const provider = new PixelLabProvider(client as never)
    let p = await openProject(file, { env: false })
    await submit(provider, p.loaded, (await p.plan()).actionable, p.lock, p.lockPath, { spacingMs: 0 })
    client.complete("char-1", 10)
    await poll(provider, p.lock, p.lockPath, { intervalMs: 0, specs: p.specs })
    await fetchAssets(provider, p.specs, p.lock, p.lockPath)

    p = await openProject(file, { env: false })
    await submit(provider, p.loaded, (await p.plan()).actionable, p.lock, p.lockPath, { spacingMs: 0 })
    client.landAnimation("char-1", "pixelkiln:cast/mira.walk", "south", 4)
    await poll(provider, p.lock, p.lockPath, { intervalMs: 0, specs: p.specs })
    await acceptReview(provider, p, "cast/mira.walk")
    await fetchAssets(provider, p.specs, p.lock, p.lockPath)

    p = await openProject(file, { env: false })
    await submit(provider, p.loaded, (await p.plan()).actionable, p.lock, p.lockPath, { spacingMs: 0 })
    const jobId = p.lock.entries["cast/mira.walk.armored"]!.jobId!
    client.failOutfitJob(jobId)
    await poll(provider, p.lock, p.lockPath, { intervalMs: 0, specs: p.specs })
    expect(p.lock.entries["cast/mira.walk.armored"]).toMatchObject({ status: "failed", error: expect.stringContaining("outfit transfer failed") })
  })
})

describe("packing a cast", () => {
  it("lists directions as members and an animation as a looping set at its fps", async () => {
    const styleDir = path.join(dir, "art", "characters")
    await import("node:fs/promises").then((fs) => fs.mkdir(styleDir, { recursive: true }))
    const outputs: Record<string, { path: string; sha256: string; role: string }[]> = { mira: [], "mira.fireman_spin": [] }
    for (const direction of ["south", "west", "east", "north"]) {
      await writeFile(path.join(styleDir, `mira-${direction}.png`), px(8, 10))
      outputs.mira!.push({ path: `art/characters/mira-${direction}.png`, sha256: "x", role: direction })
    }
    for (let i = 0; i < 4; i++) {
      await writeFile(path.join(styleDir, `mira.fireman_spin-frame-0${i}.png`), px(8, 50 + i))
      outputs["mira.fireman_spin"]!.push({ path: `art/characters/mira.fireman_spin-frame-0${i}.png`, sha256: "x", role: `frame-0${i}` })
    }
    const lock = { version: 2, entries: {
      "cast/mira": { status: "downloaded", generator: "character", provider: "pixellab", outputs: outputs.mira },
      "cast/mira.fireman_spin": { status: "downloaded", generator: "character", provider: "pixellab", outputs: outputs["mira.fireman_spin"], providerMetadata: { pixellab: { frameSet: { fps: 10, count: 4 } } } },
    } } as unknown as Lock
    const { atlas } = packStyle(lock, "cast", dir)
    expect(atlas.sets).toEqual([
      { id: "mira", kind: "members", frames: ["mira/south", "mira/west", "mira/east", "mira/north"] },
      { id: "mira.fireman_spin", kind: "frames", fps: 10, frames: ["mira.fireman_spin/frame-00", "mira.fireman_spin/frame-01", "mira.fireman_spin/frame-02", "mira.fireman_spin/frame-03"] },
    ])
    const tres = renderGodotSpriteFrames(atlas, { imageName: "cast-sheet.png" })
    expect(tres).toContain('"name": &"mira.fireman_spin",\n"speed": 10.0')
    expect(tres).toContain('"name": &"mira/south",\n"speed": 5.0')
  })
})
