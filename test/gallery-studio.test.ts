import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { existsSync } from "node:fs"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { sha256File } from "../src/hash.ts"
import { loadManifest, resolveSpecs } from "../src/manifest.ts"
import { applyManifestEdit, priceManifestEdit } from "../src/manifest-edit.ts"
import { encodeRgbaPng } from "../src/png.ts"
import type { Lock } from "../src/types.ts"
import { createGalleryEditHandler, createGalleryPriceHandler } from "../src/gallery/edit.ts"
import { serveGallery } from "../src/gallery/server.ts"
import { buildGallerySnapshot } from "../src/gallery/snapshot.ts"

let dir: string
let manifestPath: string

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "pixelkiln-gallery-studio-"))
  manifestPath = path.join(dir, "pixelkiln.manifest.json")
  await writeFile(manifestPath, JSON.stringify({
    name: "studio",
    provider: "pixellab",
    styles: { props: { outDir: "out/props" } },
    assets: { crate: { prompt: "a crate", width: 32, height: 32 } },
  }, null, 2) + "\n")
})
afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

const expected = () => sha256File(manifestPath)
const sprite = (size = 64) => encodeRgbaPng(size, size, Buffer.alloc(size * size * 4, 120)).toString("base64")
const reload = async () => {
  const loaded = await loadManifest(manifestPath)
  const lock: Lock = { version: 2, entries: {} }
  return buildGallerySnapshot({ loaded, specs: await resolveSpecs(loaded), lock, lockPath: path.join(dir, "pixelkiln.lock.json") })
}

/** A new character in one write: its style, its base drawn from an uploaded sprite, a loop in three directions, and a portrait. */
const newCharacter = () => [
  { action: "add-style", styleId: "cast", style: { generator: "character", outDir: "out/cast", size: 64, mode: "v3", directions: 8 } },
  { action: "add-asset", assetId: "mira", asset: { prompt: "a knight in silver armour", styles: ["cast"], reference: "refs/mira.png" } },
  { action: "add-asset", assetId: "mira.walk", asset: { styles: ["cast"], animation: { of: "mira", template: "walk", mode: "skeleton-v3", directions: ["south", "west", "north"] } } },
  { action: "add-asset", assetId: "mira.bust", asset: { styles: ["cast"], portrait: { of: "mira", size: 64 } } },
]

describe("add-style", () => {
  it("adds a character style, and refuses a duplicate or an outDir outside the project", async () => {
    await applyManifestEdit(manifestPath, {
      action: "add-style", styleId: "cast", expectedSha256: await expected(),
      style: { generator: "character", outDir: "out/cast", size: 48, mode: "v3", palette: ["#AABBCC"] },
    })
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"))
    expect(manifest.styles.cast).toEqual({ generator: "character", outDir: "out/cast", size: 48, mode: "v3", palette: ["#aabbcc"] })
    await expect(applyManifestEdit(manifestPath, {
      action: "add-style", styleId: "cast", expectedSha256: await expected(), style: { generator: "character", outDir: "x" },
    })).rejects.toThrow(/style "cast" already exists/)
    const { ManifestEditSchema } = await import("../src/manifest-edit.ts")
    expect(ManifestEditSchema.safeParse({
      action: "add-style", styleId: "evil", expectedSha256: "0".repeat(64), style: { generator: "character", outDir: "../elsewhere" },
    }).success).toBe(false)
  })
})

describe("batch edits", () => {
  it("create a whole character in one validated write, and write nothing when any part is refused", async () => {
    const edit = createGalleryEditHandler({ manifestFor: () => manifestPath, reload })
    await edit({ action: "upload-image", path: "refs/mira.png", base64: sprite() })
    const build = await edit({ action: "batch", expectedSha256: await expected(), edits: newCharacter() })
    const keys = build.snapshot.items.map((item) => item.key).filter((key) => key.startsWith("cast/mira")).sort()
    // The loop shorthand expands into its three directions and a free mirror for west's flip.
    expect(keys).toEqual(["cast/mira", "cast/mira.bust", "cast/mira.walk.east", "cast/mira.walk.north", "cast/mira.walk.south", "cast/mira.walk.west"])
    expect(build.snapshot.items.find((item) => item.key === "cast/mira.walk.east")?.mirrorOfKey).toBe("cast/mira.walk.west")

    const before = await readFile(manifestPath, "utf8")
    await expect(edit({
      action: "batch", expectedSha256: await expected(),
      edits: [
        { action: "add-asset", assetId: "mira.idle", asset: { styles: ["cast"], animation: { of: "mira", template: "breathing-idle" } } },
        { action: "add-asset", assetId: "ghost.walk", asset: { styles: ["cast"], animation: { of: "ghost", template: "walk" } } },
      ],
    })).rejects.toThrow(/animation parent "ghost" is not declared/)
    expect(await readFile(manifestPath, "utf8")).toBe(before)
  })
})

describe("pricing an unsaved edit", () => {
  it("quotes every new asset the way plan would, summed by unit, and writes nothing", async () => {
    await writeFile(path.join(dir, "refs.png"), Buffer.from(sprite(), "base64"))
    const edits = newCharacter().map((each) => (each.action === "add-asset" && each.assetId === "mira" ? { ...each, asset: { ...each.asset, reference: "refs.png" } } : each))
    const before = await readFile(manifestPath, "utf8")
    const price = await priceManifestEdit(manifestPath, { action: "batch", expectedSha256: await expected(), edits } as never)
    expect(await readFile(manifestPath, "utf8")).toBe(before)
    const byKey = Object.fromEntries(price.items.map((item) => [item.key, item]))
    // v3 from a reference sprite: rotations only, ceil(64 x 64 x 8 / 65536) = 1.
    expect(byKey["cast/mira"]).toMatchObject({ change: "new", cost: 1, costUnit: "generations" })
    expect(byKey["cast/mira.walk.west"]).toMatchObject({ change: "new", cost: 4 })
    // A mirror is made locally and costs nothing.
    expect(byKey["cast/mira.walk.east"]).toMatchObject({ change: "new", cost: 0 })
    expect(price.totals.generations).toBe(price.items.reduce((sum, item) => sum + item.cost, 0))
    // An asset that names no styles is in every style, a new one included: the
    // quote shows that the existing crate would be drawn as a character too.
    expect(byKey["cast/crate"]).toMatchObject({ change: "new" })
    expect(price.items.filter((item) => !item.key.startsWith("cast/mira"))).toEqual([expect.objectContaining({ key: "cast/crate" })])

    // A changed prompt is priced as a change; an unchanged asset is not listed.
    const change = await priceManifestEdit(manifestPath, { action: "patch-asset", assetId: "crate", expectedSha256: await expected(), patch: { prompt: "a mossy crate" } })
    expect(change.items).toEqual([expect.objectContaining({ key: "props/crate", change: "changed" })])
    await expect(priceManifestEdit(manifestPath, { action: "patch-asset", assetId: "crate", expectedSha256: "0".repeat(64), patch: { prompt: "x" } }))
      .rejects.toMatchObject({ status: 409 })
  })

  it("is served behind the session guard", async () => {
    const server = await serveGallery({ open: false, load: reload, price: createGalleryPriceHandler({ manifestFor: () => manifestPath }) })
    try {
      const origin = server.url.replace(/\/$/, "")
      const body = JSON.stringify({ action: "patch-asset", assetId: "crate", expectedSha256: await expected(), patch: { prompt: "a mossy crate" } })
      const post = (headers: Record<string, string>) => fetch(new URL("/api/price", server.url), { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body })
      expect((await post({ Origin: origin })).status).toBe(403)
      const ok = await post({ Origin: origin, "X-Pixelkiln-Session": server.session! })
      expect(ok.status).toBe(200)
      expect(((await ok.json()) as { items: unknown[] }).items).toHaveLength(1)
    } finally {
      await server.close()
    }
  })
})

describe("uploading an image for a manifest input", () => {
  it("writes a PNG or JPEG inside the project and refuses anything else", async () => {
    const edit = createGalleryEditHandler({ manifestFor: () => manifestPath, reload })
    await edit({ action: "upload-image", path: "refs/a.png", base64: sprite(32) })
    expect(existsSync(path.join(dir, "refs", "a.png"))).toBe(true)
    await expect(edit({ action: "upload-image", path: "../escape.png", base64: sprite() })).rejects.toThrow(/inside the project/)
    await expect(edit({ action: "upload-image", path: "refs/b.gif", base64: sprite() })).rejects.toThrow(/\.png, \.jpg, or \.jpeg/)
    await expect(edit({ action: "upload-image", path: "refs/c.jpg", base64: sprite() })).rejects.toThrow(/is a PNG; name it \.png/)
    await expect(edit({ action: "upload-image", path: "refs/d.png", base64: Buffer.from("not an image").toString("base64") })).rejects.toThrow(/not a readable PNG or JPEG/)
    await expect(edit({ action: "upload-image", path: "refs/a.png", base64: sprite() })).rejects.toThrow(/already exists/)
    await edit({ action: "upload-image", path: "refs/a.png", base64: sprite(), overwrite: true })
  })
})
