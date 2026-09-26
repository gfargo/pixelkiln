import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { loadManifest, resolveSpecs } from "../src/manifest.ts"
import { loadLock, saveLock, upsert } from "../src/lock.ts"
import { sha256 } from "../src/hash.ts"
import { decodePng, encodeRgbaPng } from "../src/png.ts"
import { memberPath, sourceIsStem, sourceOutputPath } from "../src/outputs.ts"
import {
  handEditBases,
  readHandEditCompanion,
  saveHandEdit,
  startHandEdit,
} from "../src/pipeline/hand-edit.ts"
import { mountStyle, packStyle } from "../src/pipeline/pack.ts"
import { buildGallerySnapshot } from "../src/gallery/snapshot.ts"
import { exportTileset } from "../src/pipeline/tileset-export.ts"
import { createGalleryEditHandler } from "../src/gallery/edit.ts"
import { serveGallery } from "../src/gallery/server.ts"
import { renderGallery } from "../src/gallery/page.ts"
import { lockKey, type Lock } from "../src/types.ts"

/** The gallery client as written: its typed modules, read for what they say rather than as bundled. */
const clientSource = () => readdirSync(new URL("../src/gallery/client/src/", import.meta.url))
  .filter((f) => f.endsWith(".ts"))
  .map((f) => readFileSync(new URL(`../src/gallery/client/src/${f}`, import.meta.url), "utf8"))
  .join("\n")

let dir: string
let lockPath: string

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "pixelkiln-editor-frames-"))
  lockPath = path.join(dir, "pixelkiln.lock.json")
})
afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

const px = (r: number, g: number, b: number) => encodeRgbaPng(2, 2, Buffer.from(Array(4).fill([r, g, b, 255]).flat()))
const FRAMES = [px(255, 0, 0), px(0, 255, 0), px(0, 0, 255)]
const ROLES = ["frame-00", "frame-01", "frame-02"]
const EDITOR = { editor: "pixelorama@v1.2.2-stable", protocol: 3 }

/**
 * A ComfyUI frame set as the lockfile records it after a download (three
 * 2×2 members on disk under `out/`) beside a single-image asset, declared by
 * a manifest whose frames style is shaped like the ComfyUI adapter expects.
 */
async function frameProject() {
  const manifestPath = path.join(dir, "pixelkiln.manifest.json")
  await writeFile(path.join(dir, "frames-api.json"), JSON.stringify({
    "3": { class_type: "KSampler", inputs: { seed: 1, steps: 20, latent_image: ["5", 0] } },
    "5": { class_type: "EmptyLatentImage", inputs: { width: 64, height: 64, batch_size: 1 } },
    "6": { class_type: "CLIPTextEncode", inputs: { text: "placeholder" } },
    "9": { class_type: "SaveImage", inputs: { filename_prefix: "PixelKiln", images: ["8", 0] } },
    "19": { class_type: "LoadImage", inputs: { image: "placeholder.png" } },
  }))
  for (const i of [0, 1, 2]) await writeFile(path.join(dir, `pose-${i}.png`), encodeRgbaPng(16, 16, Buffer.alloc(16 * 16 * 4, 255)))
  await writeFile(manifestPath, JSON.stringify({
    name: "frame-edit",
    provider: "comfyui",
    styles: {
      motion: {
        generator: "frames", outDir: "out", seed: 100,
        providerOptions: {
          comfyui: {
            workflowFile: "frames-api.json", outputNodeId: "9", frames: { vary: "pose", seedStep: 7 },
            bindings: {
              prompt: { nodeId: "6", input: "text" }, width: { nodeId: "5", input: "width" }, height: { nodeId: "5", input: "height" },
              seed: { nodeId: "3", input: "seed" }, pose: { nodeId: "19", input: "image" },
            },
          },
        },
      },
    },
    assets: {
      walk: { prompt: "a walk cycle", width: 16, height: 16, providerInputs: { pose: ["pose-0.png", "pose-1.png", "pose-2.png"] }, cell: [0, 0] },
    },
  }, null, 2) + "\n")
  const loaded = await loadManifest(manifestPath)
  const specs = await resolveSpecs(loaded)
  const spec = specs.find((s) => s.assetId === "walk")!
  await mkdir(path.join(dir, "out"), { recursive: true })
  for (const [i, png] of FRAMES.entries()) await writeFile(path.join(dir, `out/walk-${ROLES[i]}.png`), png)
  const lock: Lock = { version: 2, entries: {} }
  upsert(lock, lockKey("motion", "walk"), {
    styleId: "motion", assetId: "walk", specHash: spec.specHash, generator: "frames",
    prompt: spec.prompt, width: 16, height: 16, status: "downloaded", provider: "comfyui",
    outputs: FRAMES.map((png, i) => ({ path: `out/walk-${ROLES[i]}.png`, sha256: sha256(png), role: ROLES[i]!, mediaType: "image/png" as const })),
    providerMetadata: { comfyui: { frameSet: { count: 3, fps: 8, promptIds: [] } } },
    cost: 0, costUnit: "free",
  })
  await saveLock(lockPath, lock)
  return { manifestPath, loaded, specs, spec, lock }
}

describe("a frame set's source is a stem with one file per member", () => {
  it("expands like generated outputs do", () => {
    const entry = { generator: "frames", outputs: ROLES.map((role) => ({ path: "x", sha256: "y", role })) } as never
    expect(sourceOutputPath("out/edits/walk.png", entry, 1, dir)).toBe(path.join(dir, "out/edits/walk-frame-01.png"))
    expect(memberPath("/a/walk.png", "frame-02", 2, 3)).toBe("/a/walk-frame-02.png")
    const single = { generator: "map", outputs: [{ path: "x", sha256: "y" }] } as never
    expect(sourceOutputPath("out/edits/anvil.png", single, 0, dir)).toBe(path.join(dir, "out/edits/anvil.png"))
    // Any PNG set: a tile set's edit is a stem too, unless the source is one
    // existing file, which is still a single image placed for the whole set.
    const tiles = { generator: "tiles", outputs: [{ path: "x", sha256: "y", role: "tile-00" }, { path: "z", sha256: "y", role: "tile-01" }] } as never
    expect(sourceOutputPath("out/edits/ground.png", tiles, 1, dir)).toBe(path.join(dir, "out/edits/ground-tile-01.png"))
    expect(sourceIsStem("out/edits/ground.png", tiles, dir)).toBe(true)
    writeFileSync(path.join(dir, "sheet.png"), "x")
    expect(sourceIsStem("sheet.png", tiles, dir)).toBe(false)
    expect(sourceOutputPath("sheet.png", tiles, 1, dir)).toBe(path.join(dir, "sheet.png"))
    // A set with a GIF in it is not a member set.
    const gif = { generator: "animation", outputs: [{ path: "a.gif", sha256: "y", role: "gif", mediaType: "image/gif" }, { path: "b.png", sha256: "y", role: "sheet" }] } as never
    expect(sourceIsStem("out/edits/run.png", gif, dir)).toBe(false)
  })

  it("starts an edit by copying every frame and declaring the stem", async () => {
    const { manifestPath, loaded, lock, spec } = await frameProject()
    expect(handEditBases(spec, lock)).toEqual(ROLES.map((role) => ({ role, path: path.join(dir, `out/walk-${role}.png`) })))
    const started = await startHandEdit(loaded, lock, spec)
    expect(started).toMatchObject({ source: "out/edits/walk.png", created: true, declared: true })
    expect(started.editPath).toBe(path.join(dir, "out/edits/walk.png"))
    expect(existsSync(started.editPath)).toBe(false)
    expect(started.members.map((m) => [m.role, path.relative(dir, m.path)])).toEqual(ROLES.map((role) => [role, `out/edits/walk-${role}.png`]))
    for (const [i, member] of started.members.entries()) expect(await readFile(member.path)).toEqual(FRAMES[i])
    expect(JSON.parse(await readFile(manifestPath, "utf8")).assets.walk.source).toBe("out/edits/walk.png")

    // Idempotent, and a member removed by hand is restored without touching the rest.
    await rm(started.members[1]!.path)
    await writeFile(started.members[2]!.path, px(9, 9, 9))
    const again = await startHandEdit(await loadManifest(manifestPath), lock, (await resolveSpecs(await loadManifest(manifestPath))).find((s) => s.assetId === "walk")!)
    expect(again).toMatchObject({ created: true, declared: false })
    expect(await readFile(again.members[1]!.path)).toEqual(FRAMES[1])
    expect(await readFile(again.members[2]!.path)).toEqual(px(9, 9, 9))
  })

  it("is what pack and mount place, member by member", async () => {
    const { manifestPath, loaded, lock, spec } = await frameProject()
    const started = await startHandEdit(loaded, lock, spec)
    await writeFile(started.members[1]!.path, px(7, 7, 7))
    const sources = { walk: "out/edits/walk.png" }

    const sheet = packStyle(lock, "motion", dir, { sources })
    expect(sheet.atlas.frames.map((f) => f.id).sort()).toEqual(["walk/frame-00", "walk/frame-01", "walk/frame-02"])
    const decoded = decodePng(sheet.png)
    const at = (id: string) => {
      const frame = sheet.atlas.frames.find((f) => f.id === id)!
      const offset = (frame.y * decoded.width + frame.x) * 4
      return [...decoded.pixels.subarray(offset, offset + 3)]
    }
    expect(at("walk/frame-00")).toEqual([255, 0, 0])
    expect(at("walk/frame-01")).toEqual([7, 7, 7])
    expect(at("walk/frame-02")).toEqual([0, 0, 255])
    // Without the source, the generated frames are packed.
    const plain = decodePng(packStyle(lock, "motion", dir).png)
    const frame1 = packStyle(lock, "motion", dir).atlas.frames.find((f) => f.id === "walk/frame-01")!
    expect([...plain.pixels.subarray((frame1.y * plain.width + frame1.x) * 4, (frame1.y * plain.width + frame1.x) * 4 + 3)]).toEqual([0, 255, 0])

    // mount needs the role, then places that member's edit.
    const mounted = mountStyle(lock, "motion", dir, { cellWidth: 2, cellHeight: 2 }, { walk: [0, 0] }, sources, { walk: "frame-01" })
    expect(mounted.skipped).toEqual([])
    expect([...decodePng(mounted.png).pixels.subarray(0, 3)]).toEqual([7, 7, 7])
    expect(() => mountStyle(lock, "motion", dir, { cellWidth: 2, cellHeight: 2 }, { walk: [0, 0] }, sources)).toThrow(/set `outputRole` to choose one/)
    expect(JSON.parse(await readFile(manifestPath, "utf8")).assets.walk.source).toBe("out/edits/walk.png")
  })
})

describe("saving a frame set from the browser", () => {
  it("writes every member, refuses a set whose shape changed, and reports status per member", async () => {
    const { manifestPath, loaded, lock, spec } = await frameProject()
    const edited = [px(255, 0, 0), px(1, 2, 3), px(0, 0, 255)]
    const saved = await saveHandEdit(loaded, lock, spec, {
      frames: edited.map((png, i) => ({ role: ROLES[i]!, png })), project: Buffer.from("PKlayers"), ...EDITOR, now: new Date("2026-09-12T12:00:00Z"),
    })
    expect(saved).toMatchObject({ source: "out/edits/walk.png", created: true, declared: true, projectPath: path.join(dir, "out/edits/walk.pxo") })
    for (const [i, member] of saved.members.entries()) expect(await readFile(member.path)).toEqual(edited[i])
    expect(saved.companion).toEqual({
      version: 2, editor: EDITOR.editor, protocol: 3, savedAt: "2026-09-12T12:00:00.000Z", project: "walk.pxo",
      outputs: edited.map((png, i) => ({ role: ROLES[i], basedOn: sha256(FRAMES[i]!), sha256: sha256(png) })),
    })
    expect(await readHandEditCompanion(saved.editPath)).toEqual(saved.companion)

    // The wrong shape: a frame added in the editor, a frame missing, or a size change.
    const reloaded = await loadManifest(manifestPath)
    const respec = (await resolveSpecs(reloaded)).find((s) => s.assetId === "walk")!
    await expect(saveHandEdit(reloaded, lock, respec, { frames: [...edited.map((png, i) => ({ role: ROLES[i]!, png })), { role: null, png: px(0, 0, 0) }], ...EDITOR }))
      .rejects.toThrow(/set of 3 members \(frame-00, frame-01, frame-02\); the editor returned 4 \(frame-00, frame-01, frame-02, new\)/)
    await expect(saveHandEdit(reloaded, lock, respec, { frames: edited.slice(0, 2).map((png, i) => ({ role: ROLES[i]!, png })), ...EDITOR }))
      .rejects.toThrow(/returned 2/)
    await expect(saveHandEdit(reloaded, lock, respec, { frames: [{ role: "frame-00", png: px(1, 1, 1) }, { role: "frame-01", png: encodeRgbaPng(1, 1, Buffer.alloc(4, 9)) }, { role: "frame-02", png: px(1, 1, 1) }], ...EDITOR }))
      .rejects.toThrow(/member frame-01 is 1×1; motion\/walk is 2×2/)
    await expect(saveHandEdit(reloaded, lock, respec, { png: px(1, 1, 1), ...EDITOR })).rejects.toThrow(/set of 3 members/)
    for (const [i, member] of saved.members.entries()) expect(await readFile(member.path)).toEqual(edited[i])

    // The gallery sees one edit per member and judges the set as a whole.
    let { snapshot } = await buildGallerySnapshot({ loaded: reloaded, specs: await resolveSpecs(reloaded), lock, lockPath })
    let item = snapshot.items.find((i) => i.key === "motion/walk")!
    expect(item.editStatus).toBe("edited")
    expect(item.editChanged).toEqual([false, true, false])
    expect(item.edits.map((e) => [e.path, e.exists, e.sha256])).toEqual(edited.map((png, i) => [`out/edits/walk-${ROLES[i]}.png`, true, sha256(png)]))
    expect(item.edit).toEqual(item.edits[0])
    expect(item.editMeta).toMatchObject({ editor: EDITOR.editor, basedOn: sha256(FRAMES[0]!), changedSince: false, project: "out/edits/walk.pxo" })
    expect(item.editMeta!.projectUrl).toMatch(/^\/media\//)

    // One member regenerated → the set is regenerated-since; one member gone → missing.
    lock.entries[lockKey("motion", "walk")]!.outputs[2]!.sha256 = sha256(px(5, 5, 5))
    await writeFile(path.join(dir, "out/walk-frame-02.png"), px(5, 5, 5))
    ;({ snapshot } = await buildGallerySnapshot({ loaded: reloaded, specs: await resolveSpecs(reloaded), lock, lockPath }))
    expect(snapshot.items.find((i) => i.key === "motion/walk")!.editStatus).toBe("regenerated-since")
    await rm(saved.members[1]!.path)
    ;({ snapshot } = await buildGallerySnapshot({ loaded: reloaded, specs: await resolveSpecs(reloaded), lock, lockPath }))
    item = snapshot.items.find((i) => i.key === "motion/walk")!
    expect(item.editStatus).toBe("missing")
    expect(item.edits[1]!.exists).toBe(false)
  })

  it("goes through /api/edit as frames and is refused as png", async () => {
    const { manifestPath } = await frameProject()
    const load = async () => {
      const loaded = await loadManifest(manifestPath)
      return buildGallerySnapshot({ loaded, specs: await resolveSpecs(loaded), lock: await loadLock(lockPath), lockPath })
    }
    const loadProject = async () => {
      const loaded = await loadManifest(manifestPath)
      return { loaded, specs: await resolveSpecs(loaded), lock: await loadLock(lockPath), lockPath }
    }
    const server = await serveGallery({ open: false, load, edit: createGalleryEditHandler({ manifestFor: () => manifestPath, reload: load, loadProject }) })
    try {
      const origin = server.url.replace(/\/$/, "")
      const before = (await (await fetch(new URL("/api/gallery.json", server.url))).json()) as { project: { manifestSha256: string } }
      const post = (body: unknown) => fetch(new URL("/api/edit", server.url), {
        method: "POST", headers: { "Content-Type": "application/json", Origin: origin, "X-Pixelkiln-Session": server.session! }, body: JSON.stringify(body),
      })
      const base = { action: "save-edit", assetId: "walk", styleId: "motion", expectedSha256: before.project.manifestSha256, ...EDITOR }
      const both = await post({ ...base, png: px(1, 1, 1).toString("base64"), frames: [{ role: "frame-00", png: px(1, 1, 1).toString("base64") }] })
      expect(both.status).toBe(400)
      expect(await both.text()).toMatch(/not both/)
      const asPng = await post({ ...base, png: px(1, 1, 1).toString("base64") })
      expect(asPng.status).toBe(400)
      expect(await asPng.text()).toMatch(/set of 3 members/)
      const ok = await post({ ...base, frames: ROLES.map((role) => ({ role, png: px(4, 4, 4).toString("base64") })), pxo: Buffer.from("PKx").toString("base64") })
      expect(ok.status).toBe(200)
      const after = (await ok.json()) as { items: Array<{ key: string; editStatus: string; edits: Array<{ path: string }>; source: string }> }
      const item = after.items.find((i) => i.key === "motion/walk")!
      expect(item).toMatchObject({ editStatus: "edited", source: "out/edits/walk.png" })
      expect(item.edits.map((e) => e.path)).toEqual(ROLES.map((role) => `out/edits/walk-${role}.png`))
      expect(await readFile(path.join(dir, "out/edits/walk-frame-02.png"))).toEqual(px(4, 4, 4))
    } finally {
      await server.close()
    }
  })

  it("is sent to the editor as frames and shown per member", () => {
    const snapshot = { items: [], styles: [], totals: { entries: 0 }, project: { name: "x", manifest: "m", lock: "l" } } as never
    const rendered = renderGallery(snapshot, { editable: true, editor: true, session: "0".repeat(32) })
    expect(rendered).toContain("pixelkiln:open")
    const page = clientSource()
    expect(page).toContain("message.frames = pngs.map((png, i) => ({ role: S.SHEET.roles[i], png }))")
    expect(page).toContain("body.frames.push({ role: f.role === undefined ? null : f.role, png: await toBase64(f.png) })")
    expect(page).toContain("cannot open sets")
    expect(page).toContain("Hand edit (' + item.edits.length + ' ' + memberNoun(item, item.edits.length) + ')")
  })
})

describe("a tile set is edited the same way, one file per tile", () => {
  /** A PixelLab connectable tileset as the lockfile records it: four 4×4 tiles under `out/`. */
  async function tileProject() {
    const manifestPath = path.join(dir, "pixelkiln.manifest.json")
    await writeFile(manifestPath, JSON.stringify({
      name: "tile-edit",
      styles: { ground: { generator: "tiles", tileSize: 32, tileFeature: "tileset", outDir: "out" } },
      assets: { terrain: { prompt: "grass meeting water", width: 32, height: 32, cell: [0, 0], outputRole: "tile-02" } },
    }, null, 2) + "\n")
    const loaded = await loadManifest(manifestPath)
    const spec = (await resolveSpecs(loaded)).find((s) => s.assetId === "terrain")!
    await mkdir(path.join(dir, "out"), { recursive: true })
    const rules = JSON.parse(await readFile(path.resolve("test/fixtures/tileset/tile-rules.json"), "utf8"))
    const tiles = [0, 1, 2, 3].map((i) => {
      const pixels = Buffer.alloc(4 * 4 * 4, i * 40)
      for (let p = 3; p < pixels.length; p += 4) pixels[p] = 255
      return encodeRgbaPng(4, 4, pixels)
    })
    const roles = tiles.map((_, i) => `tile-0${i}`)
    for (const [i, png] of tiles.entries()) await writeFile(path.join(dir, `out/terrain-${roles[i]}.png`), png)
    const lock: Lock = { version: 2, entries: {} }
    upsert(lock, lockKey("ground", "terrain"), {
      styleId: "ground", assetId: "terrain", specHash: spec.specHash, generator: "tiles", prompt: spec.prompt, width: 32, height: 32,
      status: "downloaded", provider: "pixellab",
      outputs: tiles.map((png, i) => ({ path: `out/terrain-${roles[i]}.png`, sha256: sha256(png), role: roles[i]! })),
      providerMetadata: { pixellab: { tileKind: "tileset", tileRules: rules } },
      cost: 40, costUnit: "generations",
    })
    await saveLock(lockPath, lock)
    return { manifestPath, loaded, spec, lock, tiles, roles }
  }

  it("starts, saves, packs, mounts, and exports per tile", async () => {
    const { manifestPath, loaded, spec, lock, tiles, roles } = await tileProject()
    const started = await startHandEdit(loaded, lock, spec)
    expect(started.source).toBe("out/edits/terrain.png")
    expect(started.members.map((m) => m.role)).toEqual(roles)
    const reloaded = await loadManifest(manifestPath)
    const respec = (await resolveSpecs(reloaded)).find((s) => s.assetId === "terrain")!
    const solid = (v: number) => { const p = Buffer.alloc(64, v); for (let i = 3; i < 64; i += 4) p[i] = 255; return encodeRgbaPng(4, 4, p) }
    const saved = await saveHandEdit(reloaded, lock, respec, {
      frames: roles.map((role, i) => ({ role, png: i === 2 ? solid(200) : tiles[i]! })), ...EDITOR,
    })
    expect(saved.companion.outputs.map((o) => o.role)).toEqual(roles)

    const { snapshot } = await buildGallerySnapshot({ loaded: reloaded, specs: await resolveSpecs(reloaded), lock, lockPath })
    const item = snapshot.items.find((i) => i.key === "ground/terrain")!
    expect(item).toMatchObject({ editStatus: "edited", editChanged: [false, false, true, false] })
    expect(item.edits.map((e) => e.path)).toEqual(roles.map((role) => `out/edits/terrain-${role}.png`))

    const sources = { terrain: "out/edits/terrain.png" }
    const packed = packStyle(lock, "ground", dir, { sources })
    const tile2 = packed.atlas.frames.find((f) => f.id === "terrain/tile-02")!
    const decoded = decodePng(packed.png)
    expect(decoded.pixels[(tile2.y * decoded.width + tile2.x) * 4]).toBe(200)
    const mounted = mountStyle(lock, "ground", dir, { cellWidth: 4, cellHeight: 4 }, { terrain: [0, 0] }, sources, { terrain: "tile-02" })
    expect(decodePng(mounted.png).pixels[0]).toBe(200)
    const exported = exportTileset(lock.entries[lockKey("ground", "terrain")]!, respec, { format: "generic", manifestDir: dir, imageName: "terrain.png", columns: 2 })
    const atlasTile2 = exported.generic.tiles.find((t) => t.role === "tile-02")!
    const atlas = decodePng(exported.png)
    expect(atlas.pixels[(atlasTile2.y * atlas.width + atlasTile2.x) * 4]).toBe(200)
    expect(exported.sources.some((s) => s.path.endsWith("out/edits/terrain-tile-02.png"))).toBe(true)
  })

  it("leaves a single committed file placed for the whole set alone", async () => {
    const { manifestPath, lock, tiles } = await tileProject()
    await writeFile(path.join(dir, "sheet.png"), tiles[3]!)
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"))
    manifest.assets.terrain.source = "sheet.png"
    await writeFile(manifestPath, JSON.stringify(manifest))
    const loaded = await loadManifest(manifestPath)
    const spec = (await resolveSpecs(loaded)).find((s) => s.assetId === "terrain")!
    await expect(startHandEdit(loaded, lock, spec)).rejects.toThrow(/one committed file placed for the whole set/)
    // mount places that file; pack keeps the lock outputs; the gallery shows one edit.
    const mounted = mountStyle(lock, "ground", dir, { cellWidth: 4, cellHeight: 4 }, { terrain: [0, 0] }, { terrain: "sheet.png" }, { terrain: "tile-02" })
    expect(decodePng(mounted.png).pixels[0]).toBe(120)
    expect(packStyle(lock, "ground", dir, { sources: { terrain: "sheet.png" } }).atlas.frames).toHaveLength(4)
    const { snapshot } = await buildGallerySnapshot({ loaded, specs: await resolveSpecs(loaded), lock, lockPath })
    expect(snapshot.items.find((i) => i.key === "ground/terrain")!.edits).toHaveLength(1)
  })
})
