import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { existsSync } from "node:fs"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { glbImageBytes, parseGlb, replaceGlbImage, serializeGlb } from "../src/glb.ts"
import { sha256 } from "../src/hash.ts"
import { loadLock } from "../src/lock.ts"
import { loadManifest, resolveSpecs } from "../src/manifest.ts"
import { createGalleryEditHandler } from "../src/gallery/edit.ts"
import { buildGallerySnapshot } from "../src/gallery/snapshot.ts"
import {
  adoptModelExport,
  blenderArguments,
  blenderCommand,
  discoverModels,
  findModel,
  modelCompanionPath,
  modelExportPath,
  modelTextureProjectPath,
  openInBlender,
  readModelCompanion,
  saveModelTexture,
} from "../src/pipeline/model-edit.ts"
import { solidPng, tinyGlb } from "./fixtures/tiny-glb.ts"

let dir: string
let manifestPath: string
let modelFile: string

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "pixelkiln-model-edit-"))
  manifestPath = path.join(dir, "pixelkiln.manifest.json")
  await writeFile(manifestPath, JSON.stringify({
    name: "models",
    styles: {
      cast: { generator: "map", outDir: "art/cast" },
      props: { generator: "map", outDir: "art/props" },
    },
    assets: { anvil: { prompt: "an anvil", width: 32, height: 32 } },
  }))
  modelFile = path.join(dir, "art", "cast", "models", "knight.glb")
  await mkdir(path.dirname(modelFile), { recursive: true })
  await writeFile(modelFile, tinyGlb())
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

const model = async () => findModel(await loadManifest(manifestPath), "art/cast/models/knight.glb")
const imageOf = async (file: string, image: number) => Buffer.from(glbImageBytes(parseGlb(await readFile(file)), image).bytes)

describe("finding models", () => {
  it("lists every .glb under a style's outDir and leaves edits and hidden folders out", async () => {
    await mkdir(path.join(dir, "art", "cast", "edits", "models"), { recursive: true })
    await writeFile(path.join(dir, "art", "cast", "edits", "models", "knight.glb"), tinyGlb())
    await mkdir(path.join(dir, "art", "cast", ".cache"), { recursive: true })
    await writeFile(path.join(dir, "art", "cast", ".cache", "old.glb"), tinyGlb())
    await mkdir(path.join(dir, "art", "props"), { recursive: true })
    await writeFile(path.join(dir, "art", "props", "Crate.GLB"), tinyGlb())
    await writeFile(path.join(dir, "elsewhere.glb"), tinyGlb())
    const found = await discoverModels(await loadManifest(manifestPath))
    expect(found.map((entry) => [entry.styleId, path.relative(dir, entry.file), path.relative(dir, entry.editFile)])).toEqual([
      ["cast", "art/cast/models/knight.glb", "art/cast/edits/models/knight.glb"],
      ["props", "art/props/Crate.GLB", "art/props/edits/Crate.GLB"],
    ])
    expect((await discoverModels(await loadManifest(manifestPath), { styles: ["props"] })).map((entry) => entry.styleId)).toEqual(["props"])
  })

  it("refuses a path that is not one of the project's models", async () => {
    const loaded = await loadManifest(manifestPath)
    await writeFile(path.join(dir, "elsewhere.glb"), tinyGlb())
    await expect(findModel(loaded, "elsewhere.glb")).rejects.toThrow(/not a model under/)
    await expect(findModel(loaded, "../outside.glb")).rejects.toThrow(/not a model under/)
    await expect(findModel(loaded, "art/cast/edits/models/knight.glb")).rejects.toThrow(/not a model under/)
  })
})

describe("saving a painted texture", () => {
  it("writes an edited copy, a record and the layer file, and never the model as built", async () => {
    const before = await readFile(modelFile)
    const painted = solidPng(8, [10, 220, 30, 255])
    const target = await model()
    const saved = await saveModelTexture(target, {
      image: 0,
      png: painted,
      project: Buffer.from("layers"),
      editor: "pixelorama@test",
      protocol: 4,
      now: new Date("2026-11-18T10:00:00Z"),
    })
    expect(saved.created).toBe(true)
    expect(path.relative(dir, saved.editFile)).toBe("art/cast/edits/models/knight.glb")
    expect((await readFile(modelFile)).equals(before)).toBe(true)
    expect((await imageOf(saved.editFile, 0)).equals(painted)).toBe(true)
    expect((await imageOf(saved.editFile, 2)).equals(await imageOf(modelFile, 2))).toBe(true)
    expect(await readFile(modelTextureProjectPath(saved.editFile, 0), "utf8")).toBe("layers")
    expect(JSON.parse(await readFile(modelCompanionPath(saved.editFile), "utf8"))).toEqual({
      version: 2,
      editor: "pixelorama@test",
      protocol: 4,
      savedAt: "2026-11-18T10:00:00.000Z",
      project: "knight.image-0.pxo",
      outputs: [{ role: null, basedOn: sha256(before), sha256: sha256(await readFile(saved.editFile)) }],
      textures: [{ image: 0, name: "Sprite", sha256: sha256(painted), editor: "pixelorama@test", savedAt: "2026-11-18T10:00:00.000Z", project: "knight.image-0.pxo" }],
    })
  })

  it("keeps textures painted earlier when another one is saved", async () => {
    const target = await model()
    const body = solidPng(8, [1, 2, 3, 255])
    const helm = solidPng(8, [4, 5, 6, 255])
    await saveModelTexture(target, { image: 0, png: body, editor: "a", protocol: 4 })
    const second = await saveModelTexture(target, { image: 2, png: helm, editor: "b", protocol: 4 })
    expect(second.created).toBe(false)
    expect((await imageOf(second.editFile, 0)).equals(body)).toBe(true)
    expect((await imageOf(second.editFile, 2)).equals(helm)).toBe(true)
    expect(second.companion.textures.map((texture) => [texture.image, texture.name, texture.editor])).toEqual([[0, "Sprite", "a"], [2, "Helm", "b"]])
    expect(second.companion.outputs[0]!.basedOn).toBe(sha256(await readFile(modelFile)))
  })

  it("refuses a texture of the wrong size, a non-PNG, and an image the model lacks", async () => {
    const target = await model()
    await expect(saveModelTexture(target, { image: 0, png: solidPng(16, [0, 0, 0, 255]), editor: "x", protocol: 4 })).rejects.toThrow(/16×16; image 0 of the model is 8×8/)
    await expect(saveModelTexture(target, { image: 0, png: Buffer.from("nope"), editor: "x", protocol: 4 })).rejects.toThrow(/not a valid PNG/)
    await expect(saveModelTexture(target, { image: 9, png: solidPng(8, [0, 0, 0, 255]), editor: "x", protocol: 4 })).rejects.toThrow(/no image 9/)
    expect(existsSync(target.editFile)).toBe(false)
  })
})

describe("adopting an export", () => {
  /** What another program might hand back: the same model re-encoded, with one texture repainted. */
  async function exportWith(image: number, png: Buffer, mutate: (json: ReturnType<typeof parseGlb>["json"]) => void = () => {}) {
    const target = await model()
    const document = replaceGlbImage(parseGlb(await readFile(modelFile)), image, png, "image/png")
    // A re-export reorders and rewrites things the edit must not inherit.
    document.json.asset.generator = "another program"
    document.json.animations = []
    mutate(document.json)
    await mkdir(path.dirname(modelExportPath(target.editFile)), { recursive: true })
    await writeFile(modelExportPath(target.editFile), serializeGlb(document))
    return target
  }

  it("takes only the changed base colour textures into a copy of the model as built", async () => {
    const repainted = solidPng(8, [250, 250, 0, 255])
    const target = await exportWith(2, repainted)
    const adopted = await adoptModelExport(target, { now: new Date("2026-11-18T11:00:00Z") })
    expect(adopted.mode).toBe("textures")
    expect(adopted.taken).toEqual(["Helm"])
    const edit = parseGlb(await readFile(adopted.editFile))
    expect(Buffer.from(glbImageBytes(edit, 2).bytes).equals(repainted)).toBe(true)
    // Everything the export changed besides the texture is ignored.
    expect(edit.json.asset.generator).toBe("pixelkiln test fixture")
    expect(edit.json.animations).toHaveLength(1)
    expect(adopted.companion).toMatchObject({
      editor: "blender",
      project: null,
      textures: [{ image: 2, name: "Helm", editor: "blender", project: null }],
      adoptedExport: sha256(await readFile(modelExportPath(target.editFile))),
    })
    expect((await readModelCompanion(adopted.editFile))?.outputs[0]!.basedOn).toBe(sha256(await readFile(modelFile)))
  })

  it("keeps the record of a texture the export passed through unchanged", async () => {
    const target = await model()
    const helm = solidPng(8, [7, 7, 7, 255])
    await saveModelTexture(target, { image: 2, png: helm, project: Buffer.from("layers"), editor: "pixelorama@test", protocol: 4 })
    // The other program opened the edit, repainted the body, and exported both.
    const body = solidPng(8, [9, 9, 9, 255])
    const exported = replaceGlbImage(parseGlb(await readFile(target.editFile)), 0, body, "image/png")
    await writeFile(modelExportPath(target.editFile), serializeGlb(exported))
    const adopted = await adoptModelExport(target)
    expect(adopted.taken.sort()).toEqual(["Helm", "Sprite"])
    expect(adopted.companion.textures.map((texture) => [texture.name, texture.editor, texture.project])).toEqual([
      ["Sprite", "blender", null],
      ["Helm", "pixelorama@test", "knight.image-2.pxo"],
    ])
  })

  it("takes the whole file when asked", async () => {
    const target = await exportWith(0, solidPng(8, [3, 3, 3, 255]))
    const adopted = await adoptModelExport(target, { mode: "whole" })
    expect((await readFile(adopted.editFile)).equals(await readFile(modelExportPath(target.editFile)))).toBe(true)
    expect(parseGlb(await readFile(adopted.editFile)).json.asset.generator).toBe("another program")
  })

  it("says so when no material matches, or nothing was exported", async () => {
    const target = await exportWith(0, solidPng(8, [3, 3, 3, 255]), (json) => { for (const material of json.materials!) material.name = `${material.name}.001` })
    await expect(adoptModelExport(target)).rejects.toThrow(/no material of the exported model matches/)
    await rm(modelExportPath(target.editFile))
    await expect(adoptModelExport(target)).rejects.toThrow(/exported model is not on disk/)
    expect(existsSync(target.editFile)).toBe(false)
  })
})

describe("starting Blender", () => {
  const none = () => false
  it("uses PIXELKILN_BLENDER, then the platform's usual places", () => {
    expect(blenderCommand({ PIXELKILN_BLENDER: "flatpak run org.blender.Blender" }, "linux", none)).toEqual(["flatpak", "run", "org.blender.Blender"])
    expect(blenderCommand({}, "darwin", (file) => file === "/Applications/Blender.app/Contents/MacOS/Blender")).toEqual(["/Applications/Blender.app/Contents/MacOS/Blender"])
    expect(blenderCommand({ PATH: "/opt/tools:/usr/bin" }, "linux", (file) => file === "/opt/tools/blender")).toEqual(["/opt/tools/blender"])
    expect(blenderCommand({ ProgramFiles: "C:\\Program Files" }, "win32", (file) => file.endsWith("Blender 4.10\\blender.exe"), () => ["Blender 4.2", "Blender 4.10", "readme.txt"]))
      .toEqual(["C:\\Program Files\\Blender Foundation\\Blender 4.10\\blender.exe"])
    expect(blenderCommand({}, "linux", none)).toBeNull()
  })

  it("passes the model and the export path as arguments, never inside the script", async () => {
    const target = await model()
    const args = blenderArguments(target.file, modelExportPath(target.editFile))
    expect(args[0]).toBe("--python-expr")
    expect(args[1]).not.toContain(dir)
    expect(args.slice(2)).toEqual(["--", target.file, path.join(dir, "art", "cast", "edits", "models", "knight.export.glb")])
  })

  it("opens the edit when there is one, else the model as built", async () => {
    const target = await model()
    const launches: string[][] = []
    const launch = (program: string, args: string[]) => { launches.push([program, ...args]) }
    expect(openInBlender(target, { command: ["blender", "--factory-startup"], launch })).toContain("knight.glb")
    expect(launches[0]!.slice(0, 2)).toEqual(["blender", "--factory-startup"])
    expect(launches[0]!.at(-2)).toBe(target.file)
    await saveModelTexture(target, { image: 0, png: solidPng(8, [1, 1, 1, 255]), editor: "x", protocol: 4 })
    openInBlender(target, { command: ["blender"], launch })
    expect(launches[1]!.at(-2)).toBe(target.editFile)
    expect(() => openInBlender(target, { command: null, launch })).toThrow(/PIXELKILN_BLENDER/)
  })
})

describe("models in the gallery", () => {
  const build = async (filter?: { styles?: string[]; assets?: string[] }) => {
    const loaded = await loadManifest(manifestPath)
    const lockPath = path.join(dir, "pixelkiln.lock.json")
    return buildGallerySnapshot({ loaded, specs: await resolveSpecs(loaded), lock: await loadLock(lockPath), lockPath, ...(filter ? { filter } : {}) })
  }

  it("lists a model with what it holds and serves only its files", async () => {
    const { snapshot, media } = await build()
    expect(snapshot.models).toHaveLength(1)
    const listed = snapshot.models[0]!
    expect(listed).toMatchObject({
      id: "model:cast/models/knight.glb",
      styleId: "cast",
      name: "knight",
      edit: null,
      error: null,
      editPath: "art/cast/edits/models/knight.glb",
      exportPath: "art/cast/edits/models/knight.export.glb",
      exportWaiting: null,
    })
    expect(listed.file.path).toBe("art/cast/models/knight.glb")
    expect(listed.summary?.items).toEqual(["Helm"])
    // The model is not an asset: the manifest's one asset, in its two styles, is all `items` holds.
    expect(snapshot.items.map((item) => item.key)).toEqual(["cast/anvil", "props/anvil"])
    const served = [...media.values()].filter((entry) => entry.contentType === "model/gltf-binary")
    expect(served.map((entry) => entry.path)).toEqual([modelFile])
    expect(listed.file.url).toMatch(/^\/media\/[0-9a-f]{24}\?v=/)
  })

  it("shows the edit, its record, a rebuild since, and an export waiting", async () => {
    const target = await model()
    await saveModelTexture(target, { image: 0, png: solidPng(8, [1, 1, 1, 255]), project: Buffer.from("layers"), editor: "pixelorama@test", protocol: 4 })
    let listed = (await build()).snapshot.models[0]!
    expect(listed.edit).toMatchObject({ status: "edited", editor: "pixelorama@test", changedSince: false })
    expect(listed.edit!.textures).toMatchObject([{ image: 0, name: "Sprite", project: "art/cast/edits/models/knight.image-0.pxo" }])
    expect(listed.edit!.textures[0]!.projectUrl).toMatch(/^\/media\//)

    await writeFile(modelExportPath(target.editFile), tinyGlb({ helmTexture: solidPng(8, [2, 2, 2, 255]) }))
    listed = (await build()).snapshot.models[0]!
    expect(listed.exportWaiting?.bytes).toBeGreaterThan(0)
    await adoptModelExport(target)
    expect((await build()).snapshot.models[0]!.exportWaiting).toBeNull()

    await writeFile(modelFile, tinyGlb({ bodyTexture: solidPng(8, [5, 5, 5, 255]) }))
    expect((await build()).snapshot.models[0]!.edit!.status).toBe("rebuilt-since")
  })

  it("reports a file that is not a model without hiding it, and follows --style and --only", async () => {
    await writeFile(path.join(dir, "art", "cast", "broken.glb"), "not a model")
    const { snapshot } = await build()
    expect(snapshot.models.map((entry) => [entry.name, entry.error === null])).toEqual([["broken", false], ["knight", true]])
    expect(snapshot.models[0]!.error).toMatch(/invalid glb/)
    expect((await build({ styles: ["props"] })).snapshot.models).toEqual([])
    expect((await build({ assets: ["anvil"] })).snapshot.models).toEqual([])
  })

  it("saves a texture through the gallery's edit route and refuses a path outside the project's models", async () => {
    const loaded = () => loadManifest(manifestPath)
    const lockPath = path.join(dir, "pixelkiln.lock.json")
    const reload = async () => build()
    const started: string[] = []
    const edit = createGalleryEditHandler({
      manifestFor: () => manifestPath,
      loadProject: async () => {
        const manifest = await loaded()
        return { loaded: manifest, specs: await resolveSpecs(manifest), lock: await loadLock(lockPath), lockPath }
      },
      reload,
      openBlender: (target) => { started.push(target.file); return "blender" },
    })
    const manifestBefore = await readFile(manifestPath, "utf8")
    const painted = solidPng(8, [40, 50, 60, 255])
    const result = await edit({ action: "save-model-texture", path: "art/cast/models/knight.glb", image: 2, png: painted.toString("base64"), editor: "pixelorama@test", protocol: 4 })
    expect(result.snapshot.models[0]!.edit?.textures.map((texture) => texture.name)).toEqual(["Helm"])
    expect(await readFile(manifestPath, "utf8")).toBe(manifestBefore)
    await edit({ action: "open-model", path: "art/cast/models/knight.glb" })
    expect(started).toEqual([modelFile])
    await expect(edit({ action: "save-model-texture", path: "../outside.glb", image: 0, png: painted.toString("base64"), editor: "x", protocol: 4 })).rejects.toThrow(/not a model under/)
    await expect(edit({ action: "save-model-texture", path: "art/cast/models/knight.glb", image: -1, png: "", editor: "x", protocol: 4 })).rejects.toThrow(/invalid model edit/)
    await expect(edit({ action: "adopt-model-export", path: "art/cast/models/knight.glb" })).rejects.toThrow(/exported model is not on disk/)
  })
})

describe("normal maps", () => {
  it("are named by material and :normal, painted into the copy, and recorded as the normal map", async () => {
    const target = await model()
    const { resolveTextureImage } = await import("../src/pipeline/model-edit.ts")
    const document = parseGlb(await readFile(modelFile))
    expect(resolveTextureImage(document, "Sprite:normal")).toBe(1)
    expect(resolveTextureImage(document, "sprite")).toBe(0)
    expect(() => resolveTextureImage(document, "Helm:normal")).toThrow(/no normal map for material "Helm"; the model's textures are 0 \(Sprite\), 1 \(Sprite:normal\), 2 \(Helm\)/)
    const flat = solidPng(4, [128, 128, 255, 255])
    const saved = await saveModelTexture(target, { image: 1, png: flat, editor: "x", protocol: 5 })
    expect(saved.companion.textures).toMatchObject([{ image: 1, name: "Sprite normal map" }])
    expect((await imageOf(saved.editFile, 1)).equals(flat)).toBe(true)
  })

  it("come back from a Blender export by material name too", async () => {
    const target = await model()
    const normal = solidPng(4, [200, 128, 200, 255])
    const exported = replaceGlbImage(parseGlb(await readFile(modelFile)), 1, normal, "image/png")
    await mkdir(path.dirname(modelExportPath(target.editFile)), { recursive: true })
    await writeFile(modelExportPath(target.editFile), serializeGlb(exported))
    const adopted = await adoptModelExport(target)
    expect(adopted.taken).toEqual(["Sprite normal map"])
    expect((await imageOf(adopted.editFile, 1)).equals(normal)).toBe(true)
  })
})
