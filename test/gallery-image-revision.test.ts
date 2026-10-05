import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { existsSync } from "node:fs"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { sha256File } from "../src/hash.ts"
import { loadManifest, resolveSpecs } from "../src/manifest.ts"
import { encodeRgbaPng } from "../src/png.ts"
import type { Lock } from "../src/types.ts"
import { createGalleryEditHandler } from "../src/gallery/edit.ts"
import { buildGallerySnapshot } from "../src/gallery/snapshot.ts"

let dir: string
let manifestPath: string

const mask = (width: number, height: number) => encodeRgbaPng(width, height, Buffer.alloc(width * height * 4, 255))

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "pixelkiln-gallery-inpaint-"))
  manifestPath = path.join(dir, "pixelkiln.manifest.json")
  await mkdir(path.join(dir, "art"))
  for (const name of ["hero", "villain"]) {
    await writeFile(path.join(dir, "art", `${name}.png`), encodeRgbaPng(64, 64, Buffer.alloc(64 * 64 * 4, 90)))
  }
  await writeFile(manifestPath, JSON.stringify({
    name: "inpaint-gallery",
    provider: "pixellab",
    styles: { chars: { outDir: "out" } },
    assets: {
      hero: { prompt: "a knight", width: 64, height: 64, source: "art/hero.png" },
      villain: { prompt: "a baron", width: 64, height: 64, source: "art/villain.png" },
    },
  }, null, 2) + "\n")
})
afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

const reload = async () => {
  const loaded = await loadManifest(manifestPath)
  const specs = await resolveSpecs(loaded)
  const lock: Lock = { version: 2, entries: {} }
  return buildGallerySnapshot({ loaded, specs, lock, lockPath: path.join(dir, "pixelkiln.lock.json") })
}
const edit = () => createGalleryEditHandler({ manifestFor: () => manifestPath, reload })
const inpaint = async (extra: Record<string, unknown> = {}) => ({
  action: "create-inpaint-revision",
  expectedSha256: await sha256File(manifestPath),
  styleId: "chars",
  from: "hero",
  assetId: "hero-runestone",
  prompt: "a glowing runestone",
  maskPath: "masks/hero-runestone.png",
  maskBase64: mask(64, 64).toString("base64"),
  ...extra,
})

describe("creating an inpaint revision from the gallery", () => {
  it("writes the mask, declares the revision, and links it to its parent", async () => {
    const build = await edit()(await inpaint())
    expect(existsSync(path.join(dir, "masks", "hero-runestone.png"))).toBe(true)
    const written = JSON.parse(await readFile(manifestPath, "utf8"))
    expect(written.assets["hero-runestone"]).toEqual({
      prompt: "a glowing runestone",
      styles: ["chars"],
      revision: { mode: "inpaint", from: "hero", mask: "masks/hero-runestone.png" },
    })
    const item = build.snapshot.items.find((candidate) => candidate.key === "chars/hero-runestone")!
    expect(item.revisionParentKey).toBe("chars/hero")
  })

  it("removes the mask again when the manifest refuses it, and puts a replaced one back", async () => {
    // A mask that is not the parent's size is refused by the loader.
    await expect(edit()(await inpaint({ maskBase64: mask(32, 32).toString("base64") }))).rejects.toThrow(/mask/i)
    expect(existsSync(path.join(dir, "masks", "hero-runestone.png"))).toBe(false)

    await mkdir(path.join(dir, "masks"), { recursive: true })
    await writeFile(path.join(dir, "masks", "hero-runestone.png"), "hand edits")
    await expect(edit()(await inpaint())).rejects.toThrow(/already exists; choose another name/)
    await expect(edit()(await inpaint({ overwrite: true, assetId: "hero" }))).rejects.toThrow(/already exists/)
    expect(await readFile(path.join(dir, "masks", "hero-runestone.png"), "utf8")).toBe("hand edits")
  })

  it("keeps the mask inside the project and a PNG", async () => {
    await expect(edit()(await inpaint({ maskPath: "../escape.png" }))).rejects.toThrow(/inside the project/)
    await expect(edit()(await inpaint({ maskPath: "masks/m.jpg" }))).rejects.toThrow(/\.png path/)
    await expect(edit()(await inpaint({ maskBase64: Buffer.from("not an image").toString("base64") }))).rejects.toThrow(/readable PNG/)
    expect(existsSync(path.join(dir, "..", "escape.png"))).toBe(false)
  })
})

describe("creating an interpolate revision from the gallery", () => {
  it("names another sprite as the ending keyframe", async () => {
    const build = await edit()({
      action: "add-asset", assetId: "hero-to-villain", expectedSha256: await sha256File(manifestPath),
      asset: { prompt: "morphing", styles: ["chars"], revision: { mode: "interpolate", from: "hero", lastFrame: "art/villain.png", fps: 8 } },
    })
    const item = build.snapshot.items.find((candidate) => candidate.key === "chars/hero-to-villain")!
    expect(item.revisionParentKey).toBe("chars/hero")
    expect(JSON.parse(await readFile(manifestPath, "utf8")).assets["hero-to-villain"].revision)
      .toEqual({ mode: "interpolate", from: "hero", lastFrame: "art/villain.png", fps: 8 })
  })

  it("refuses an ending keyframe outside the project", async () => {
    await expect(edit()({
      action: "add-asset", assetId: "x", expectedSha256: await sha256File(manifestPath),
      asset: { prompt: "x", styles: ["chars"], revision: { mode: "interpolate", from: "hero", lastFrame: "../outside.png" } },
    })).rejects.toThrow(/inside the project/)
  })
})
