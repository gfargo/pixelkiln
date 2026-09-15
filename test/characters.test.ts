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
    await expect(loadManifest(manifestPath()).then((l) => resolveSpecs(l, { styles: ["props"] }))).rejects.toThrow(/state needs a character style/)
  })
})

describe("characterCost", () => {
  const spec = (character: Partial<ResolvedSpec["character"]>, size = 64) =>
    ({ width: size, height: size, character: { kind: "base", mode: "standard", directions: 8, template: "mannequin", ...character } } as unknown as ResolvedSpec)

  it("prices each shape and engine the way PixelLab charges", () => {
    expect(characterCost(spec({ mode: "standard" }))).toBe(1)
    expect(characterCost(spec({ mode: "v3" }, 64))).toBe(2)
    expect(characterCost(spec({ mode: "v3" }, 128))).toBe(3)
    expect(characterCost(spec({ mode: "pro" }, 64))).toBe(40)
    expect(characterCost(spec({ mode: "pro" }, 32))).toBe(20)
    expect(characterCost(spec({ kind: "state" }, 64))).toBe(40)
    expect(characterCost(spec({ kind: "state" }, 32))).toBe(20)
    const anim = (mode: "template" | "v3" | "pro", size: number, frames = 8) =>
      spec({ kind: "animation", animation: { mode, direction: "east", frames, fps: 8, keepFirstFrame: true } }, size)
    expect(characterCost(anim("template", 128))).toBe(1)
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
  const client = {
    calls: [] as string[],
    /** Whether the character list carries the name PixelKiln gave an animation. */
    listNames: true,
    tags: new Map<string, string[]>(),
    pixels: new Map<string, Buffer>(),
    characters,
    async createCharacter(args: { directions: 4 | 8; description: string }) {
      const id = `char-${++counter}`
      client.calls.push(`create:${args.description}`)
      characters.set(id, { id, status: "pending", directions: args.directions, rotations: {}, animations: [], group_id: null, state_name: null })
      return { character_id: id, background_job_id: `job-${id}` }
    },
    async createCharacterState(args: { characterId: string; editDescription: string }) {
      const parent = characters.get(args.characterId)
      if (!parent) throw new PixelLabError("POST /create-character-state → 404", 404, "")
      const id = `char-${++counter}`
      client.calls.push(`state:${args.characterId}:${args.editDescription}`)
      characters.set(id, { id, status: "pending", directions: parent.directions, rotations: {}, animations: [], group_id: "grp", state_name: args.editDescription })
      return { character_id: id, background_job_id: `job-${id}` }
    },
    async animateCharacter(args: { characterId: string; animationName: string; directions: string[]; mode: string }) {
      const character = characters.get(args.characterId)
      if (!character) throw new PixelLabError("POST /animate-character → 404", 404, "")
      client.calls.push(`animate:${args.characterId}:${args.animationName}:${args.directions.join(",")}:${args.mode}`)
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
      const status = jobs.get(id)
      if (status === undefined) throw new PixelLabError(`GET /background-jobs/${id} → 404`, 404, "")
      return { id, status, last_response: jobResponses.get(id) ?? null }
    },
    /** Test hook: PixelLab cleans finished jobs up; the animation list is what is left. */
    forgetJobs() { jobs.clear(); jobResponses.clear() },
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
    },
    /** Test hook: land an animation with `count` frames for one direction. */
    landAnimation(id: string, name: string, direction: string, count: number) {
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
        jobResponses.set(jobId, { direction, frame_count: count, animation_id: animationId, character_id: id, storage_urls: { frames: urls } })
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
