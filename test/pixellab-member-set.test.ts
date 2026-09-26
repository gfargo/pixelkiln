import path from "node:path"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { PixelLabClient } from "../src/client.ts"
import { sha256 } from "../src/hash.ts"
import { upsert } from "../src/lock.ts"
import { loadManifest, resolveSpecs } from "../src/manifest.ts"
import { portableOutputPath } from "../src/outputs.ts"
import { buildPlan } from "../src/pipeline/plan.ts"
import { poll } from "../src/pipeline/poll.ts"
import { fetchAssets } from "../src/pipeline/fetch.ts"
import { inspectRevisionReadiness } from "../src/pipeline/revision.ts"
import { submit } from "../src/pipeline/submit.ts"
import { encodeRgbaPng } from "../src/png.ts"
import { PixelLabProvider, editAnimationFrameCeiling } from "../src/providers/pixellab.ts"
import { CHARACTER_DIRECTIONS_8, RevisionSchema, type Lock, type ResolvedSpec } from "../src/types.ts"

function png(shade = 20, width = 32, height = 32): Buffer {
  return encodeRgbaPng(width, height, Buffer.alloc(width * height * 4, shade))
}

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status })

describe("revision member sets and the interpolate/edit-animation modes", () => {
  let dir: string
  let manifestPath: string
  let lockPath: string

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "pixelkiln-member-set-"))
    manifestPath = path.join(dir, "pixelkiln.manifest.json")
    lockPath = path.join(dir, "pixelkiln.lock.json")
  })
  afterEach(async () => {
    vi.unstubAllGlobals()
    await rm(dir, { recursive: true, force: true })
  })

  /**
   * A downloaded parent written as a member set, the way a generated
   * animation or character lands: `art/hero-<role>.png` beside a lock entry
   * that records each one.
   */
  async function project(revision: Record<string, unknown>, roles: string[], opts: { size?: number; extra?: Record<string, unknown> } = {}) {
    const size = opts.size ?? 32
    await writeFile(manifestPath, JSON.stringify({
      name: "member-set-test",
      provider: "pixellab",
      styles: { base: { generator: "map", size, outDir: "art" } },
      assets: {
        hero: { prompt: "a knight" },
        revised: { prompt: "add a red cape", width: size, height: size, revision },
        ...opts.extra,
      },
    }))
    const loaded = await loadManifest(manifestPath)
    const [parent] = await resolveSpecs(loaded, { assets: ["hero"] })
    await mkdir(path.join(dir, "art"), { recursive: true })
    const lock: Lock = { version: 2, entries: {} }
    const outputs = []
    for (const [index, role] of roles.entries()) {
      const bytes = png(10 + index * 5, size, size)
      const file = path.join(dir, "art", `hero-${role}.png`)
      await writeFile(file, bytes)
      outputs.push({ path: portableOutputPath(file, dir), sha256: sha256(bytes), role, mediaType: "image/png" as const })
    }
    upsert(lock, "base/hero", {
      styleId: "base", assetId: "hero", specHash: parent!.specHash, generator: "map", prompt: "a knight",
      width: size, height: size, status: "downloaded", provider: "pixellab", objectId: "obj-hero", outputs,
      sourceUrls: roles.map((role) => ({ url: `https://cdn.example/${role}.png`, role })),
    })
    return { loaded, lock }
  }

  const frames = (n: number) => Array.from({ length: n }, (_, i) => `frame-${String(i).padStart(2, "0")}`)

  async function child(loaded: Awaited<ReturnType<typeof loadManifest>>): Promise<ResolvedSpec> {
    const [spec] = await resolveSpecs(loaded, { assets: ["revised"] })
    return spec!
  }

  it("resolves a frame-set parent as every member, hashed together", async () => {
    const { loaded } = await project({ mode: "reduce-colors", from: "hero", numColors: 8 }, frames(4))
    const spec = await child(loaded)
    const members = spec.revision!.sourceMembers!
    expect(members.map((member) => member.role)).toEqual(frames(4))
    expect(spec.revision!.sourceFile).toBe(members[0]!.file)
    expect(spec.revision!.sourceSha256).toBe(sha256(JSON.stringify(members.map((member) => member.sha256))))

    // Changing any one member (not just the first) changes the child's identity.
    await writeFile(members[2]!.file, png(200))
    const changed = await child(loaded)
    expect(changed.specHash).not.toBe(spec.specHash)
  })

  it("sends reduce-colors every frame in one call and writes the set back under the parent's roles", async () => {
    const { loaded, lock } = await project({ mode: "reduce-colors", from: "hero", numColors: 8 }, frames(3))
    const spec = await child(loaded)
    const plan = await buildPlan([spec], lock)
    const results = [png(70), png(80), png(90)]
    let body: { images: unknown[] } | null = null
    vi.stubGlobal("fetch", vi.fn(async (input: string, init?: RequestInit) => {
      expect(new URL(String(input)).pathname).toBe("/v2/reduce-colors")
      body = JSON.parse(String(init!.body))
      return json({
        images: results.map((r) => ({ base64: r.toString("base64") })),
        palette: { base64: "cA==" },
        n_colors: 8,
        usage: { type: "generations", generations: 0.1 },
      })
    }))
    const provider = new PixelLabProvider(new PixelLabClient("key"))
    await submit(provider, loaded, plan.actionable, lock, lockPath, { spacingMs: 0 })
    expect(body!.images).toHaveLength(3)

    await poll(provider, lock, lockPath, { intervalMs: 0, specs: [spec] })
    expect(lock.entries["base/revised"]).toMatchObject({ status: "selected" })
    expect(lock.entries["base/revised"]!.sourceUrls.map((source) => source.role)).toEqual(frames(3))

    await fetchAssets(provider, [spec], lock, lockPath)
    expect(lock.entries["base/revised"]).toMatchObject({ status: "downloaded" })
    for (const [index, role] of frames(3).entries()) {
      const written = await readFile(path.join(dir, "art", `revised-${role}.png`))
      expect(written.equals(results[index]!)).toBe(true)
    }
  })

  it("keeps a character's direction roles through correct-pixelart", async () => {
    const { loaded, lock } = await project({ mode: "correct-pixelart", from: "hero" }, [...CHARACTER_DIRECTIONS_8])
    const spec = await child(loaded)
    expect(spec.revision!.sourceMembers!.map((member) => member.role)).toEqual(CHARACTER_DIRECTIONS_8)
    const plan = await buildPlan([spec], lock)
    vi.stubGlobal("fetch", vi.fn(async () =>
      json({ images: CHARACTER_DIRECTIONS_8.map((_, i) => ({ base64: png(100 + i).toString("base64") })) })))
    const provider = new PixelLabProvider(new PixelLabClient("key"))
    await submit(provider, loaded, plan.actionable, lock, lockPath, { spacingMs: 0 })
    await poll(provider, lock, lockPath, { intervalMs: 0, specs: [spec] })
    await fetchAssets(provider, [spec], lock, lockPath)
    const written = await readFile(path.join(dir, "art", "revised-north-west.png"))
    expect(written.equals(png(105))).toBe(true)
  })

  it("is not ready when a leftover member from an older generation sits beside the set", async () => {
    const { loaded, lock } = await project({ mode: "reduce-colors", from: "hero" }, frames(2))
    await writeFile(path.join(dir, "art", "hero-frame-02.png"), png(1))
    const spec = await child(loaded)
    expect(spec.revision!.sourceMembers).toHaveLength(3)
    const readiness = await inspectRevisionReadiness(spec, lock)
    expect(readiness).toMatchObject({ ready: false, reason: expect.stringContaining("records 2 output(s) but 3 member file(s)") })
  })

  it("refuses a member set for a mode that reads one image, and caps reduce-colors at 512x512 in all", async () => {
    // Provider validation runs inside resolution, so both surface at plan time.
    const single = await project({ mode: "image-to-image", from: "hero" }, frames(2))
    await expect(child(single.loaded)).rejects.toThrow(/reads one source image; hero is a 2-member set/)

    const big = await project({ mode: "reduce-colors", from: "hero" }, frames(5), { size: 256 })
    await expect(child(big.loaded)).rejects.toThrow(/5 frames of 256x256/)
  })

  it("submits edit-animation with every frame and reviews the result under the parent's roles", async () => {
    const { loaded, lock } = await project({ mode: "edit-animation", from: "hero", fps: 12 }, frames(4))
    const spec = await child(loaded)
    const plan = await buildPlan([spec], lock)
    const edited = [0, 1, 2, 3].map((i) => png(150 + i))
    let body: Record<string, unknown> | null = null
    vi.stubGlobal("fetch", vi.fn(async (input: string, init?: RequestInit) => {
      const url = new URL(String(input))
      if (url.pathname === "/v2/edit-animation-v2") {
        body = JSON.parse(String(init!.body))
        return json({ background_job_id: "edit-1", status: "processing" }, 202)
      }
      if (url.pathname === "/v2/background-jobs/edit-1") {
        return json({
          id: "edit-1", status: "completed", created_at: "now",
          last_response: { images: edited.map((f) => ({ type: "base64", base64: f.toString("base64") })) },
        })
      }
      throw new Error(`unexpected ${url.pathname}`)
    }))
    const provider = new PixelLabProvider(new PixelLabClient("key"))
    await submit(provider, loaded, plan.actionable, lock, lockPath, { spacingMs: 0 })
    expect(body).toMatchObject({ description: "add a red cape", image_size: { width: 32, height: 32 } })
    expect((body!.frames as unknown[]).length).toBe(4)

    const polled = await poll(provider, lock, lockPath, { intervalMs: 0, specs: [spec] })
    expect(polled.review).toBe(1)
    const entry = lock.entries["base/revised"]!
    expect(entry.providerMetadata.pixellab).toMatchObject({ frameSet: { fps: 12, count: 4 } })
    const state = await provider.poll(entry.reviewObjectId!, entry.generator, { spec })
    expect(state).toMatchObject({ status: "review-set", fps: 12 })
    expect((state as { sources: { role: string }[] }).sources.map((source) => source.role)).toEqual(frames(4))
  })

  it("validates edit-animation's parent and its size-dependent frame ceiling", async () => {
    const provider = PixelLabProvider.forOffline()
    expect([editAnimationFrameCeiling(64, 64), editAnimationFrameCeiling(80, 72), editAnimationFrameCeiling(128, 96)]).toEqual([16, 9, 4])

    const tooMany = await project({ mode: "edit-animation", from: "hero" }, frames(5), { size: 96 })
    await expect(child(tooMany.loaded)).rejects.toThrow(/at most 4 frames at 96x96/)

    await rm(path.join(dir, "art"), { recursive: true, force: true })
    await mkdir(path.join(dir, "art"), { recursive: true })
    await writeFile(path.join(dir, "art", "hero.png"), png())
    await expect(child(tooMany.loaded)).rejects.toThrow(/needs a frame set to edit; hero is a single image/)
  })

  it("submits interpolate with the parent as the start keyframe and lastFrame as the end", async () => {
    await mkdir(path.join(dir, "keys"), { recursive: true })
    await writeFile(path.join(dir, "keys", "landed.png"), png(222))
    const { loaded, lock } = await project(
      { mode: "interpolate", from: "hero", lastFrame: "keys/landed.png" },
      [],
      { extra: {} },
    )
    await writeFile(path.join(dir, "art", "hero.png"), png(33))
    const bytes = await readFile(path.join(dir, "art", "hero.png"))
    upsert(lock, "base/hero", {
      outputs: [{ path: "art/hero.png", sha256: sha256(bytes), mediaType: "image/png" }],
      sourceUrls: [{ url: "https://cdn.example/hero.png" }],
    })
    const spec = await child(loaded)
    expect(spec.revision!.sourceMembers).toBeUndefined()
    const plan = await buildPlan([spec], lock)
    let body: Record<string, unknown> | null = null
    vi.stubGlobal("fetch", vi.fn(async (input: string, init?: RequestInit) => {
      const url = new URL(String(input))
      if (url.pathname === "/v2/interpolation-v2") {
        body = JSON.parse(String(init!.body))
        return json({ background_job_id: "interp-1", status: "processing" }, 202)
      }
      return json({
        id: "interp-1", status: "completed", created_at: "now",
        last_response: { images: [1, 2, 3].map((i) => ({ base64: png(i).toString("base64") })) },
      })
    }))
    const provider = new PixelLabProvider(new PixelLabClient("key"))
    await submit(provider, loaded, plan.actionable, lock, lockPath, { spacingMs: 0 })
    expect(body).toMatchObject({
      action: "add a red cape",
      start_image: { image: { base64: bytes.toString("base64") }, size: { width: 32, height: 32 } },
      end_image: { image: { base64: png(222).toString("base64") }, size: { width: 32, height: 32 } },
      image_size: { width: 32, height: 32 },
    })
    const polled = await poll(provider, lock, lockPath, { intervalMs: 0, specs: [spec] })
    expect(polled.review).toBe(1)
  })

  it("holds interpolate until its ending keyframe exists, and refuses a size mismatch", async () => {
    const { loaded, lock } = await project({ mode: "interpolate", from: "hero", lastFrame: "keys/end.png" }, [])
    await writeFile(path.join(dir, "art", "hero.png"), png(33))
    const bytes = await readFile(path.join(dir, "art", "hero.png"))
    upsert(lock, "base/hero", { outputs: [{ path: "art/hero.png", sha256: sha256(bytes), mediaType: "image/png" }], sourceUrls: [] })
    expect(await inspectRevisionReadiness(await child(loaded), lock))
      .toMatchObject({ ready: false, reason: expect.stringContaining("revision last frame is missing") })

    await mkdir(path.join(dir, "keys"), { recursive: true })
    await writeFile(path.join(dir, "keys", "end.png"), png(1, 48, 48))
    await expect(child(loaded)).rejects.toThrow(/lastFrame is 48x48; the start keyframe is 32x32/)
  })

  it("prices interpolate and edit-animation on the Pro canvas tiers, edit-animation on its packed grid", async () => {
    const provider = PixelLabProvider.forOffline()
    const interp = await project({ mode: "interpolate", from: "hero", lastFrame: "keys/end.png" }, [])
    expect(provider.estimate(await child(interp.loaded))).toMatchObject({ unit: "generations", amount: 20 })
    const set = await project({ mode: "edit-animation", from: "hero" }, frames(4))
    // Four 32x32 frames pack into a 64x64 grid: 4096px², the top tier.
    expect(provider.estimate(await child(set.loaded))).toMatchObject({ unit: "generations", amount: 40 })
  })

  it("resolves a revision inside a character style as an edit of the loop, not a new character", async () => {
    await writeFile(manifestPath, JSON.stringify({
      name: "character-revision",
      provider: "pixellab",
      styles: { chars: { generator: "character", size: 48, outDir: "art" } },
      assets: {
        hero: { prompt: "a knight" },
        "hero-walk-east": { prompt: "walking", animation: { of: "hero", direction: "east", frames: 4 } },
        "hero-walk-east-16c": { prompt: "16 colors", revision: { mode: "reduce-colors", from: "hero-walk-east", numColors: 16 } },
      },
    }))
    await mkdir(path.join(dir, "art"), { recursive: true })
    for (const role of frames(4)) await writeFile(path.join(dir, "art", `hero-walk-east-${role}.png`), png(40, 48, 48))
    const [spec] = await resolveSpecs(await loadManifest(manifestPath), { assets: ["hero-walk-east-16c"] })
    expect(spec!.character).toBeUndefined()
    expect(spec!.revision!.sourceMembers!.map((member) => member.role)).toEqual(frames(4))
    // The loop's own playback rate (the character default, 8) travels with it.
    expect(spec!.revision!.sourceFps).toBe(8)
  })

  it("schema: interpolate needs lastFrame, and the frame-set fields stay on their own modes", () => {
    expect(RevisionSchema.safeParse({ mode: "interpolate", from: "a" }).error?.issues[0]?.message)
      .toMatch(/interpolate revisions require lastFrame/)
    expect(RevisionSchema.safeParse({ mode: "edit-animation", from: "a", lastFrame: "x.png" }).success).toBe(false)
    expect(RevisionSchema.safeParse({ mode: "edit-animation", from: "a", frames: 8 }).success).toBe(false)
    expect(RevisionSchema.safeParse({ mode: "edit-animation", from: "a", fps: 10 }).success).toBe(true)
    expect(RevisionSchema.safeParse({ mode: "reduce-colors", from: "a", fps: 10 }).success).toBe(false)
    expect(RevisionSchema.safeParse({ mode: "interpolate", from: "a", lastFrame: "x.png", strength: 0.5 }).success).toBe(false)
  })
})
