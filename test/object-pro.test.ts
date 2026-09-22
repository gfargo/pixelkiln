import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { existsSync } from "node:fs"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { PixelLabClient, PixelLabError } from "../src/client.ts"
import { PixelLabProvider, objectAnimationName, objectProCost } from "../src/providers/pixellab.ts"
import { buildPlan, resumeActions } from "../src/pipeline/plan.ts"
import { submit } from "../src/pipeline/submit.ts"
import { poll } from "../src/pipeline/poll.ts"
import { fetchAssets } from "../src/pipeline/fetch.ts"
import { openProject } from "../src/project.ts"
import { encodeRgbaPng } from "../src/png.ts"
import type { ResolvedSpec } from "../src/types.ts"

let dir: string
beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "pixelkiln-object-pro-"))
})
afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

const manifestPath = () => path.join(dir, "pixelkiln.manifest.json")

async function writeManifest(overrides: { style?: Record<string, unknown>; assets?: Record<string, unknown> } = {}) {
  await writeFile(manifestPath(), JSON.stringify({
    name: "props-test",
    styles: {
      props: {
        generator: "objectPro",
        outDir: "art/props",
        size: 64,
        promptPrefix: "pixel art",
        promptSuffix: "clean lines",
        ...overrides.style,
      },
    },
    assets: overrides.assets ?? {
      rune: { prompt: "a carved stone rune" },
      "rune.charged": { prompt: "glowing with blue light", state: { of: "rune" } },
      "rune.pulse": { prompt: "pulsing with light", animation: { of: "rune.charged", direction: "east", frames: 8, fps: 10 } },
    },
  }))
  return manifestPath()
}

const px = (n: number, shade: number) => encodeRgbaPng(n, n, Buffer.alloc(n * n * 4, shade))

describe("manifest resolution", () => {
  it("resolves base, state, and animation shapes with their parents", async () => {
    const { loadManifest, resolveSpecs } = await import("../src/manifest.ts")
    const loaded = await loadManifest(await writeManifest())
    const specs = await resolveSpecs(loaded)
    const base = specs.find((s) => s.assetId === "rune")!
    const state = specs.find((s) => s.assetId === "rune.charged")!
    const animation = specs.find((s) => s.assetId === "rune.pulse")!

    expect(base.objectPro).toMatchObject({ kind: "base", directions: 8 })
    expect(state.objectPro).toMatchObject({ kind: "state", parentAssetId: "rune" })
    expect(animation.objectPro).toMatchObject({ kind: "animation", parentAssetId: "rune.charged" })
    expect(animation.objectPro?.animation).toMatchObject({ mode: "v3", direction: "east", frames: 8, fps: 10 })
  })

  it("rejects state/animation on a non-character, non-objectPro style", async () => {
    const { loadManifest, resolveSpecs } = await import("../src/manifest.ts")
    const loaded = await loadManifest(await writeManifest({
      style: { generator: "map" },
      assets: { a: { prompt: "x" }, b: { prompt: "y", state: { of: "a" } } },
    }))
    await expect(resolveSpecs(loaded)).rejects.toThrow(/state needs a character or objectPro style/)
  })

  it("rejects a template/subject/outline/shading/detail animation override, since objectPro has no skeleton", async () => {
    const { loadManifest, resolveSpecs } = await import("../src/manifest.ts")
    const loaded = await loadManifest(await writeManifest({
      assets: {
        rune: { prompt: "a rune" },
        "rune.pulse": { prompt: "pulsing", animation: { of: "rune", template: "walk" } },
      },
    }))
    await expect(resolveSpecs(loaded)).rejects.toThrow(/objectPro has no skeleton\/template concept/)
  })

  it("carries objectDirections and styleTraits into the base shape", async () => {
    const { loadManifest, resolveSpecs } = await import("../src/manifest.ts")
    const loaded = await loadManifest(await writeManifest({
      style: { objectDirections: 1, styleTraits: { palette: false } },
      assets: { rune: { prompt: "a rune" } },
    }))
    const [spec] = await resolveSpecs(loaded)
    expect(spec.objectPro).toMatchObject({ directions: 1, styleTraits: { palette: false } })
  })
})

describe("provider", () => {
  const provider = new PixelLabProvider({} as never)

  it("supports the objectPro generator", () => {
    expect(provider.supports("objectPro")).toBe(true)
  })

  it("estimates base cost the same way pro-flash character bases are priced", () => {
    const spec = { generator: "objectPro", width: 64, height: 64, objectPro: { kind: "base", directions: 8 } } as unknown as ResolvedSpec
    expect(provider.estimate(spec)).toMatchObject({ unit: "generations" })
    expect(objectProCost(spec)).toBeGreaterThan(0)
  })

  it("rejects an animation direction that is not this object's single direction", async () => {
    const { loadManifest, resolveSpecs } = await import("../src/manifest.ts")
    const loaded = await loadManifest(await writeManifest({
      style: { objectDirections: 1 },
      assets: {
        rune: { prompt: "a rune" },
        "rune.pulse": { prompt: "pulsing", animation: { of: "rune", direction: "east" } },
      },
    }))
    await expect(resolveSpecs(loaded)).rejects.toThrow(/has 1 direction: south/)
  })

  it("rejects a reference sprite larger than 256px", async () => {
    const { loadManifest, resolveSpecs } = await import("../src/manifest.ts")
    await writeFile(path.join(dir, "ref.png"), px(300, 10))
    const loaded = await loadManifest(await writeManifest({
      assets: { rune: { prompt: "a rune", reference: "ref.png" } },
    }))
    await expect(resolveSpecs(loaded)).rejects.toThrow(/PixelLab objectPro takes up to 256px/)
  })
})

describe("the wire", () => {
  const calls: { path: string; method: string; body: unknown }[] = []
  const answer = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } })
  beforeEach(() => {
    calls.length = 0
    vi.stubGlobal("fetch", vi.fn(async (input: string, init?: RequestInit) => {
      const url = new URL(String(input))
      calls.push({ path: url.pathname, method: init?.method ?? "GET", body: init?.body ? JSON.parse(String(init.body)) : undefined })
      return answer({ object_id: "obj-1", background_job_id: "job-1", animation_group_id: "grp-1", mode: "v3", frame_count: 8, description: "", submissions: [] })
    }))
  })
  afterEach(() => vi.unstubAllGlobals())

  it("sends a base's own shape: n_directions, image_size or first_frame, style image and traits", async () => {
    const client = new PixelLabClient("key")
    await client.createObjectProFlash({ description: "a rune", directions: 8, size: 64, view: "side", seed: 3 })
    await client.createObjectProFlash({
      description: "a rune",
      directions: 1,
      size: 64,
      reference: { base64: "U09VVEg=", format: "png" },
      styleReference: { base64: "U1RZTEU=", format: "png" },
      styleReferenceSize: { width: 48, height: 48 },
      styleTraits: { palette: false, shading: true },
    })
    expect(calls[0]).toMatchObject({ path: "/v2/create-object-pro-flash", body: { description: "a rune", n_directions: 8, image_size: { width: 64, height: 64 }, view: "side", seed: 3 } })
    expect(calls[0]!.body).not.toHaveProperty("first_frame")
    expect(calls[1]).toMatchObject({
      body: {
        n_directions: 1,
        first_frame: { type: "base64", base64: "U09VVEg=", format: "png" },
        style_image: { image: { type: "base64", base64: "U1RZTEU=", format: "png" }, size: { width: 48, height: 48 } },
        style_options: { color_palette: false, shading: true },
      },
    })
    expect(calls[1]!.body).not.toHaveProperty("image_size")
  })

  it("sends a state and an animation the way the object endpoint documents them", async () => {
    const client = new PixelLabClient("key")
    await client.createObjectProState({ objectId: "obj-1", editDescription: "charged", stateName: "charged" })
    await client.animateObject({ objectId: "obj-1", directions: 8, direction: "east", animationDescription: "pulsing", displayName: "pixelkiln:props/rune.pulse", mode: "v3", frameCount: 8, replaceExisting: true })
    await client.animateObject({ objectId: "obj-2", directions: 1, direction: "south", animationDescription: "pulsing", mode: "v3" })
    expect(calls[0]).toMatchObject({ path: "/v2/objects/obj-1/states", body: { edit_description: "charged", state_name: "charged" } })
    expect(calls[1]).toMatchObject({
      path: "/v2/objects/obj-1/animations",
      body: { mode: "v3", directions: ["east"], animation_description: "pulsing", display_name: "pixelkiln:props/rune.pulse", frame_count: 8, replace_existing: true },
    })
    // A 1-direction object must not receive `directions` at all.
    expect(calls[2]!.body).not.toHaveProperty("directions")
  })
})

/** A fake client that behaves like PixelLab's object records. */
function fakeClient() {
  const objects = new Map<string, { id: string; status: string; directions: number; rotations: Record<string, string>; animations: { display_name: string | null; animation_group_id: string; directions: { direction: string; storage_urls: { frames: string[] } }[] }[]; group_id: string | null; state_name: string | null }>()
  let counter = 0
  const jobs = new Map<string, string>()
  const jobResponses = new Map<string, Record<string, unknown>>()
  const baseJobs = new Map<string, string>()
  const client = {
    calls: [] as string[],
    pixels: new Map<string, Buffer>(),
    async createObjectProFlash(args: { directions: 1 | 8; description: string }) {
      const id = `obj-${++counter}`
      client.calls.push(`create:${args.description}`)
      objects.set(id, { id, status: "pending", directions: args.directions, rotations: {}, animations: [], group_id: null, state_name: null })
      baseJobs.set(`job-${id}`, "processing")
      return { object_id: id, background_job_id: `job-${id}` }
    },
    async createObjectProState(args: { objectId: string; editDescription: string }) {
      const parent = objects.get(args.objectId)
      if (!parent) throw new PixelLabError("POST /objects/{id}/states → 404", 404, "")
      const id = `obj-${++counter}`
      client.calls.push(`state:${args.objectId}:${args.editDescription}`)
      objects.set(id, { id, status: "pending", directions: parent.directions, rotations: {}, animations: [], group_id: "grp", state_name: args.editDescription })
      baseJobs.set(`job-${id}`, "processing")
      return { object_id: id, background_job_id: `job-${id}` }
    },
    async animateObject(args: { objectId: string; direction: string; mode: string }) {
      const object = objects.get(args.objectId)
      if (!object) throw new PixelLabError("POST /objects/{id}/animations → 404", 404, "")
      client.calls.push(`animate:${args.objectId}:${args.direction}:${args.mode}`)
      const jobId = `anim-job-${++counter}`
      jobs.set(jobId, "processing")
      return { animation_group_id: `grp-${jobId}`, object_id: args.objectId, mode: args.mode, frame_count: 8, submissions: [{ direction: args.direction, status: "queued", background_job_id: jobId, animation_id: null }] }
    },
    async getObject(id: string) {
      const o = objects.get(id)
      if (!o) throw new PixelLabError(`GET /objects/${id} → 404`, 404, "")
      return { id, name: "n", prompt: "p", size: { width: 64, height: 64 }, directions: o.directions, created_at: "2026-01-01", status: o.status, rotation_urls: o.status === "completed" ? o.rotations : null, tags: [], group_id: o.group_id, state_name: o.state_name, animations: o.animations }
    },
    async getBackgroundJob(id: string) {
      if (baseJobs.has(id)) return { id, status: baseJobs.get(id)!, last_response: null, usage: null }
      const status = jobs.get(id)
      if (status === undefined) throw new PixelLabError(`GET /background-jobs/${id} → 404`, 404, "")
      return { id, status, last_response: jobResponses.get(id) ?? null, usage: null }
    },
    async setTags() {},
    async download(url: string) {
      const bytes = client.pixels.get(url)
      if (!bytes) throw new Error(`no fake bytes for ${url}`)
      return bytes
    },
    complete(id: string, shade: number) {
      const o = objects.get(id)!
      const order = o.directions === 1 ? ["south"] : ["south", "south-east", "east", "north-east", "north", "north-west", "west", "south-west"]
      o.rotations = {}
      order.forEach((direction, i) => {
        const url = `https://cdn.test/${id}/${direction}.png?t=${shade}`
        o.rotations[direction] = url
        client.pixels.set(url, px(8, shade + i))
      })
      o.status = "completed"
      if (baseJobs.has(`job-${id}`)) baseJobs.set(`job-${id}`, "completed")
    },
    landAnimation(id: string, name: string, direction: string, count: number) {
      const o = objects.get(id)!
      const frames = Array.from({ length: count }, (_, i) => {
        const url = `https://cdn.test/${id}/anim/${direction}/${i}.png`
        client.pixels.set(url, px(8, 100 + i))
        return url
      })
      const animationId = `anim-${direction}-${count}`
      const urls = frames.map((url) => url.replace("/anim/", `/animations/${animationId}/`))
      for (const [i, url] of urls.entries()) client.pixels.set(url, client.pixels.get(frames[i]!)!)
      o.animations.push({ display_name: name, animation_group_id: `grp-${name}-${direction}`, directions: [{ direction, storage_urls: { frames: urls } }] })
      for (const [jobId] of jobs) {
        jobs.set(jobId, "completed")
        jobResponses.set(jobId, { direction, frame_count: count, animation_id: animationId, object_id: id, storage_urls: { frames: urls } })
      }
    },
  }
  return client
}

describe("the pipeline", () => {
  it("generates a base, then a state from its object id, then an animation into review", async () => {
    const file = await writeManifest()
    const client = fakeClient()
    const provider = new PixelLabProvider(client as never)
    const project = () => openProject(file, { env: false })

    let p = await project()
    let plan = await p.plan()
    expect(plan.actionable.map((i) => i.key)).toEqual(["props/rune"])
    expect(plan.items.find((i) => i.key === "props/rune.pulse")).toMatchObject({ state: "blocked" })
    await submit(provider, p.loaded, plan.actionable, p.lock, p.lockPath, { spacingMs: 0 })
    expect(client.calls).toEqual(["create:pixel art, a carved stone rune, clean lines"])
    expect(p.lock.entries["props/rune"]).toMatchObject({ status: "processing", jobId: "obj-1" })
    expect(await poll(provider, p.lock, p.lockPath, { intervalMs: 0, timeoutMs: 0, specs: p.specs })).toMatchObject({ stillRunning: 1 })
    client.complete("obj-1", 10)
    await poll(provider, p.lock, p.lockPath, { intervalMs: 0, specs: p.specs })
    await fetchAssets(provider, p.specs, p.lock, p.lockPath)
    const base = p.lock.entries["props/rune"]!
    expect(base.status).toBe("downloaded")
    expect(base.providerMetadata.pixellab).toMatchObject({ objectPro: { objectId: "obj-1", directions: 8 } })
    expect(existsSync(path.join(dir, "art", "props", "rune-south.png"))).toBe(true)

    p = await project()
    plan = await p.plan()
    expect(plan.actionable.map((i) => i.key)).toEqual(["props/rune.charged"])
    await submit(provider, p.loaded, plan.actionable, p.lock, p.lockPath, { spacingMs: 0 })
    expect(client.calls.at(-1)).toBe("state:obj-1:glowing with blue light")
    client.complete("obj-2", 30)
    await poll(provider, p.lock, p.lockPath, { intervalMs: 0, specs: p.specs })
    await fetchAssets(provider, p.specs, p.lock, p.lockPath)
    expect(p.lock.entries["props/rune.charged"]).toMatchObject({ status: "downloaded", objectId: "obj-2" })

    p = await project()
    plan = await p.plan()
    expect(plan.actionable.map((i) => i.key)).toEqual(["props/rune.pulse"])
    await submit(provider, p.loaded, plan.actionable, p.lock, p.lockPath, { spacingMs: 0 })
    expect(client.calls.at(-1)).toBe("animate:obj-2:east:v3")
    expect(await poll(provider, p.lock, p.lockPath, { intervalMs: 0, timeoutMs: 0, specs: p.specs })).toMatchObject({ stillRunning: 1 })
    client.landAnimation("obj-2", objectAnimationName({ styleId: "props", assetId: "rune.pulse" }), "east", 9)
    const polled = await poll(provider, p.lock, p.lockPath, { intervalMs: 0, specs: p.specs })
    expect(polled.review).toBe(1)
    const entry = p.lock.entries["props/rune.pulse"]!
    expect(entry.status).toBe("review")
    expect(entry.providerMetadata.pixellab).toMatchObject({ frameSet: { fps: 10, count: 9 }, objectPro: { direction: "east", objectId: "obj-2" } })
    const state = await provider.poll(entry.reviewObjectId!, "objectPro", { spec: p.specs.find((s) => s.assetId === "rune.pulse") })
    expect(state).toMatchObject({ status: "review-set", fps: 10, objectId: expect.stringMatching(/^obj-2#/) })
    expect(resumeActions(p.specs, p.lock)).toEqual([{ command: "pick", keys: ["props/rune.pulse"] }])
  })

  it("refuses a state whose parent is not in the lockfile, naming the parent", async () => {
    const file = await writeManifest()
    const client = fakeClient()
    const provider = new PixelLabProvider(client as never)
    const p = await openProject(file, { env: false })
    const state = p.specs.find((s) => s.assetId === "rune.charged")!
    const result = await submit(provider, p.loaded, [{ spec: state, key: "props/rune.charged", state: "missing", reason: "forced" }], p.lock, p.lockPath, { spacingMs: 0 }).catch((e: Error) => e)
    expect(String(result)).toMatch(/props\/rune/)
    expect(client.calls).toEqual([])
  })

  it("reports a failed animation job", async () => {
    const file = await writeManifest({ assets: { rune: { prompt: "a rune" }, "rune.pulse": { prompt: "pulsing", animation: { of: "rune", direction: "east" } } } })
    const client = fakeClient()
    const provider = new PixelLabProvider(client as never)
    const p = await openProject(file, { env: false })
    await submit(provider, p.loaded, (await p.plan()).actionable, p.lock, p.lockPath, { spacingMs: 0 })
    client.complete("obj-1", 10)
    await poll(provider, p.lock, p.lockPath, { intervalMs: 0, specs: p.specs })
    await fetchAssets(provider, p.specs, p.lock, p.lockPath)
    const p2 = await openProject(file, { env: false })
    await submit(provider, p2.loaded, (await p2.plan()).actionable, p2.lock, p2.lockPath, { spacingMs: 0 })
    // The animation job fails outright, not just goes missing.
    const failing = { ...client, getBackgroundJob: async () => ({ id: "x", status: "failed", last_response: null, usage: null }) }
    const failingProvider = new PixelLabProvider(failing as never)
    const entry = p2.lock.entries["props/rune.pulse"]!
    const state = await failingProvider.poll(entry.jobId!, "objectPro")
    expect(state).toMatchObject({ status: "failed" })
  })
})
