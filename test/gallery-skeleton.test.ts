import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { existsSync } from "node:fs"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { sha256File } from "../src/hash.ts"
import { loadManifest, resolveSpecs } from "../src/manifest.ts"
import { encodeRgbaPng } from "../src/png.ts"
import { SKELETON_LABELS, scaffoldSkeletonSet } from "../src/skeleton.ts"
import type { Lock } from "../src/types.ts"
import { createGalleryEditHandler } from "../src/gallery/edit.ts"
import { serveGallery } from "../src/gallery/server.ts"
import { createGallerySkeletonHandlers } from "../src/gallery/skeleton.ts"
import { buildGallerySnapshot } from "../src/gallery/snapshot.ts"

let dir: string
let manifestPath: string
const lockPath = () => path.join(dir, "pixelkiln.lock.json")

const pose = SKELETON_LABELS.map((label, i) => ({ label, x: 0.5, y: 0.05 + i * 0.05, z_index: 1 }))
const poses = scaffoldSkeletonSet(pose, 3)

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "pixelkiln-gallery-skeleton-"))
  manifestPath = path.join(dir, "pixelkiln.manifest.json")
  await mkdir(path.join(dir, "art"))
  // Placed art needs no lock entry, which keeps the fixture offline.
  await writeFile(path.join(dir, "art", "hero.png"), encodeRgbaPng(64, 64, Buffer.alloc(64 * 64 * 4, 90)))
  await writeFile(path.join(dir, "art", "banner.png"), encodeRgbaPng(96, 32, Buffer.alloc(96 * 32 * 4, 90)))
  await writeFile(manifestPath, JSON.stringify({
    name: "skeleton-gallery",
    provider: "pixellab",
    styles: { chars: { outDir: "out" } },
    assets: {
      hero: { prompt: "a knight", width: 64, height: 64, source: "art/hero.png" },
      banner: { prompt: "a banner", width: 96, height: 32, source: "art/banner.png" },
    },
  }, null, 2) + "\n")
})
afterEach(async () => {
  vi.unstubAllGlobals()
  await rm(dir, { recursive: true, force: true })
})

async function context() {
  const loaded = await loadManifest(manifestPath)
  const specs = await resolveSpecs(loaded)
  const lock: Lock = { version: 2, entries: {} }
  return { loaded, specs, lock, lockPath: lockPath() }
}
const reload = async () => {
  const ctx = await context()
  return buildGallerySnapshot({ loaded: ctx.loaded, specs: ctx.specs, lock: ctx.lock, lockPath: lockPath() })
}
const request = async (extra: Record<string, unknown> = {}) => ({
  action: "create-skeleton-animation",
  expectedSha256: await sha256File(manifestPath),
  styleId: "chars",
  from: "hero",
  assetId: "hero-swing",
  prompt: "swinging the sword",
  direction: "south",
  keypointsFile: "poses/hero-swing.json",
  set: poses,
  ...extra,
})

describe("creating a skeleton animation from the gallery", () => {
  it("writes the poses, declares the revision, and shows the poses on the new record", async () => {
    const edit = createGalleryEditHandler({ manifestFor: () => manifestPath, reload })
    const build = await edit(await request({ description: "silver armour" }))

    expect(JSON.parse(await readFile(path.join(dir, "poses", "hero-swing.json"), "utf8"))).toEqual(poses)
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"))
    expect(manifest.assets["hero-swing"]).toEqual({
      prompt: "swinging the sword",
      styles: ["chars"],
      revision: {
        mode: "animate-skeleton",
        from: "hero",
        keypointsFile: "poses/hero-swing.json",
        direction: "south",
        description: "silver armour",
      },
    })
    const item = build.snapshot.items.find((candidate) => candidate.key === "chars/hero-swing")!
    expect(item.skeleton).toEqual({ keypointsFile: "poses/hero-swing.json", set: poses })
    expect(item.revisionParentKey).toBe("chars/hero")
    expect(build.snapshot.items.find((candidate) => candidate.key === "chars/hero")!.skeleton).toBeNull()
  })

  it("uses a keypoints file already in the project, and refuses one that is missing", async () => {
    const edit = createGalleryEditHandler({ manifestFor: () => manifestPath, reload })
    const { set: _, ...withoutPoses } = await request()
    await expect(edit(withoutPoses)).rejects.toThrow(/does not exist; paste poses or estimate them/)
    await mkdir(path.join(dir, "poses"))
    await writeFile(path.join(dir, "poses", "hero-swing.json"), JSON.stringify(poses))
    await edit(await request({ set: undefined }))
    expect(JSON.parse(await readFile(manifestPath, "utf8")).assets["hero-swing"].revision.keypointsFile).toBe("poses/hero-swing.json")
  })

  it("never writes outside the project or over a file unasked, and undoes the write when the manifest refuses", async () => {
    const edit = createGalleryEditHandler({ manifestFor: () => manifestPath, reload })
    await expect(edit(await request({ keypointsFile: "../escape.json" }))).rejects.toThrow(/inside the project/)
    await expect(edit(await request({ keypointsFile: "poses/hero.txt" }))).rejects.toThrow(/\.json path/)
    expect(existsSync(path.join(dir, "..", "escape.json"))).toBe(false)

    await mkdir(path.join(dir, "poses"))
    await writeFile(path.join(dir, "poses", "hero-swing.json"), "hand edits")
    await expect(edit(await request())).rejects.toThrow(/already exists; choose another path, or replace it/)
    // Replacing is allowed when asked, but a refused manifest edit (a
    // duplicate asset id here) puts the old file back.
    await expect(edit(await request({ assetId: "hero", overwrite: true }))).rejects.toThrow(/already exists/)
    expect(await readFile(path.join(dir, "poses", "hero-swing.json"), "utf8")).toBe("hand edits")
    // A file the failed call created itself is removed again.
    await expect(edit(await request({ assetId: "hero", keypointsFile: "poses/new.json" }))).rejects.toThrow(/already exists/)
    expect(existsSync(path.join(dir, "poses", "new.json"))).toBe(false)

    const bad = { ...poses, frames: [pose] }
    await expect(edit(await request({ set: bad }))).rejects.toThrow(/invalid skeleton animation: set\.frames/)
  })
})

describe("estimating a skeleton from the gallery", () => {
  it("estimates from the sprite the record shows and returns poses to edit, writing nothing", async () => {
    const estimateSkeleton = vi.fn(async () => ({ keypoints: pose, usage: null }))
    const handlers = createGallerySkeletonHandlers({ loadProject: context, client: () => ({ estimateSkeleton }) })
    const out = await handlers.estimate({ styleId: "chars", assetId: "hero", frames: 5 })
    expect(out.source).toBe("art/hero.png")
    expect(out.set).toEqual(scaffoldSkeletonSet(pose, 5))
    expect(estimateSkeleton).toHaveBeenCalledWith({ image: { base64: expect.any(String), format: "png" } })
    expect(existsSync(path.join(dir, "poses"))).toBe(false)

    await expect(handlers.estimate({ styleId: "chars", assetId: "banner" })).rejects.toThrow(/96x32; estimate-skeleton takes a square image/)
    await expect(handlers.estimate({ styleId: "chars", assetId: "nobody" })).rejects.toThrow(/not declared/)
    expect(estimateSkeleton).toHaveBeenCalledTimes(1)
  })

  it("is served only behind the session guard", async () => {
    const estimateSkeleton = vi.fn(async () => ({ keypoints: pose, usage: null }))
    const server = await serveGallery({
      open: false,
      load: reload,
      skeleton: createGallerySkeletonHandlers({ loadProject: context, client: () => ({ estimateSkeleton }) }),
    })
    try {
      const origin = server.url.replace(/\/$/, "")
      const post = (headers: Record<string, string>) => fetch(new URL("/api/skeleton/estimate", server.url), {
        method: "POST",
        headers: { "Content-Type": "application/json", ...headers },
        body: JSON.stringify({ styleId: "chars", assetId: "hero" }),
      })
      expect((await post({ Origin: origin })).status).toBe(403)
      expect((await post({ Origin: "http://evil.example", "X-Pixelkiln-Session": server.session! })).status).toBe(403)
      const ok = await post({ Origin: origin, "X-Pixelkiln-Session": server.session! })
      expect(ok.status).toBe(200)
      expect(((await ok.json()) as { set: unknown }).set).toEqual(scaffoldSkeletonSet(pose))
      expect(estimateSkeleton).toHaveBeenCalledTimes(1)
    } finally {
      await server.close()
    }
    const readOnly = await serveGallery({ open: false, load: reload })
    try {
      const res = await fetch(new URL("/api/skeleton/estimate", readOnly.url), { method: "POST", body: "{}" })
      expect(res.status).toBe(405)
    } finally {
      await readOnly.close()
    }
  })
})
