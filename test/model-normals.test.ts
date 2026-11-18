import { existsSync } from "node:fs"
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { glbImageBytes, imageInfo, parseGlb } from "../src/glb.ts"
import { readModelCompanion, type ProjectModel } from "../src/pipeline/model-edit.ts"
import {
  baseColourTextures,
  drawView,
  fitSprite,
  frameView,
  parsePose,
  readSpriteFolder,
  restPrimitives,
  applyDetail,
  decodeImage,
  generateModelNormals,
  modelNormalDir,
  planModelNormals,
  type NormalMapper,
} from "../src/pipeline/model-normals.ts"
import { solidPng, tinyGlb } from "./fixtures/tiny-glb.ts"

let dir: string
let model: ProjectModel

beforeEach(async () => {
  dir = await realpath(await mkdtemp(path.join(tmpdir(), "pk-model-normals-")))
  await mkdir(path.join(dir, "models"), { recursive: true })
  await writeFile(path.join(dir, "models/knight.glb"), tinyGlb())
  model = { styleId: "cast", file: path.join(dir, "models/knight.glb"), editFile: path.join(dir, "edits/models/knight.glb") }
})
afterEach(async () => { await rm(dir, { recursive: true, force: true }) })

/** A stand-in for PixelLab: every picture comes back as one colour at its own size. */
const answering = (rgba: [number, number, number, number]): NormalMapper & { calls: number } => {
  const mapper = Object.assign(async (png: Buffer) => {
    mapper.calls++
    const { width } = imageInfo(png)!
    return solidPng(width, rgba)
  }, { calls: 0 })
  return mapper
}

const savedNormal = async () => decodeImage(glbImageBytes(parseGlb(await readFile(model.editFile)), 1).bytes)

describe("model normal maps from PixelLab", () => {
  it("plans the texture source as one tile per normal map, priced, without touching the model", async () => {
    const plan = await planModelNormals(model, { source: "texture" })
    expect(plan.from).toBe("built")
    expect(plan.images).toEqual([{ image: 1, name: "Sprite normal map", width: 4, height: 4 }])
    expect(plan.calls.map((call) => call.label)).toEqual(["image 1 tile 0,0"])
    expect(plan.cost).toBe(0.1)
    expect(planModelNormals(model, { source: "texture", mode: "pro" }).then((p) => p.cost)).resolves.toBe(0.5)
    expect(existsSync(model.editFile)).toBe(false)
    expect(existsSync(path.join(modelNormalDir(model.editFile), "texture", "image-1-tile-0-0.png"))).toBe(true)
  })

  it("plans the views source as one call per direction", async () => {
    const plan = await planModelNormals(model, { source: "views", size: 16 })
    expect(plan.calls.map((call) => call.label)).toEqual(["view south", "view east", "view north", "view west"])
    expect(plan.cost).toBe(0.4)
    const eight = await planModelNormals(model, { source: "views", size: 16, views: ["south", "south-east", "east", "north-east", "north", "north-west", "west", "south-west"] })
    expect(eight.cost).toBe(0.8)
    await expect(planModelNormals(model, { source: "views", views: ["up"] })).rejects.toThrow(/not a direction/)
    await expect(planModelNormals(model, { source: "views", size: 1024 })).rejects.toThrow(/8 to 512/)
  })

  it("refuses an image that is not a normal map", async () => {
    await expect(planModelNormals(model, { source: "texture", images: [0] })).rejects.toThrow(/not one of the model's normal maps/)
  })

  it("puts the texture source's detail on the normal map, records it, and answers again from the cache", async () => {
    // Leaning right: red above the middle.
    const mapper = answering([200, 128, 200, 255])
    const result = await generateModelNormals(model, { source: "texture", replace: true }, mapper)
    expect(mapper.calls).toBe(1)
    expect(result.sent).toBe(1)
    const saved = await savedNormal()
    expect(saved.pixels[0]).toBeGreaterThan(160)
    const companion = await readModelCompanion(model.editFile)
    expect(companion?.textures.map((t) => [t.name, t.editor])).toEqual([["Sprite normal map", "pixellab normal-map (texture, replace)"]])
    // Same pictures and request: nothing is sent.
    const again = await generateModelNormals(model, { source: "texture", amount: 0 }, async () => { throw new Error("must not be called") })
    expect(again.sent).toBe(0)
    expect(existsSync(result.details[0]!)).toBe(true)
  })

  it("re-tunes rather than stacks: a second run blends onto the map from before the first", async () => {
    const mapper = answering([200, 128, 200, 255])
    await generateModelNormals(model, { source: "texture" }, mapper)
    const once = Buffer.from((await savedNormal()).pixels)
    await generateModelNormals(model, { source: "texture" }, mapper)
    expect(Buffer.from((await savedNormal()).pixels).equals(once)).toBe(true)
    await generateModelNormals(model, { source: "texture", amount: 0 }, mapper)
    // Amount 0 puts back the map as it was before.
    expect((await savedNormal()).pixels[0]).toBeLessThan(132)
    expect(mapper.calls).toBe(1)
  })

  it("carries a view's detail into the texel's own frame", async () => {
    // Every view says "leans to the picture's right". From the front, the
    // picture's right is the quads' tangent (+X), so the map leans right;
    // from behind it is -X, and the quads face away from that view anyway.
    const mapper = answering([220, 128, 180, 255])
    await generateModelNormals(model, { source: "views", size: 32, views: ["south"], replace: true }, mapper)
    const saved = await savedNormal()
    expect(saved.pixels[0]).toBeGreaterThan(170)
    expect(Math.abs(saved.pixels[1]! - 128)).toBeLessThan(6)
  })

  it("blends onto the baked map: flat detail leaves it as it was", () => {
    // (0.6, -0.2, 0.77) or so: a unit normal leaning right and a little down.
    const existing = decodeImage(solidPng(4, [204, 102, 226, 255]))
    const normal = new Float32Array(16 * 3)
    for (let texel = 0; texel < 16; texel++) normal[texel * 3 + 2] = 1
    const out = applyDetail(existing, { width: 4, height: 4, normal, weight: new Float32Array(16).fill(1) })
    for (let k = 0; k < 3; k++) expect(Math.abs(out.pixels[k]! - existing.pixels[k]!)).toBeLessThanOrEqual(2)
  })

  it("fits a sprite of the model itself, and uses it as a source", async () => {
    const document = parseGlb(tinyGlb())
    const primitives = restPrimitives(document)
    const textures = baseColourTextures(document)
    const sprite = drawView(document, primitives, frameView(primitives, 0, 48), textures)
    const fit = fitSprite(document, primitives, decodeImage(sprite.png), 0, textures)
    expect(fit.agreement).toBeGreaterThan(0.9)
    expect(fit.overlap).toBeGreaterThan(0.9)
    expect(fit.camera.tilt).toBe(0)

    const plan = await planModelNormals(model, { source: "sprites", sprites: [{ direction: "south", png: sprite.png }] })
    expect(plan.calls.map((call) => call.label)).toEqual(["sprite south"])
    expect(plan.fits?.[0]?.agreement).toBeGreaterThan(0.9)
    expect(existsSync(path.join(modelNormalDir(model.editFile), "sprites", "sprite-south.fit.png"))).toBe(true)
    const result = await generateModelNormals(model, { source: "sprites", sprites: [{ direction: "south", png: sprite.png }], replace: true }, answering([220, 128, 180, 255]))
    expect(result.companion.textures.map((t) => t.editor)).toEqual(["pixellab normal-map (sprites, replace)"])
    expect((await savedNormal()).pixels[0]).toBeGreaterThan(170)
  })

  it("leaves out a sprite that does not line up, and says why when none does", async () => {
    const stranger = solidPng(48, [0, 255, 0, 255])
    await expect(planModelNormals(model, { source: "sprites", sprites: [{ direction: "south", png: stranger }] })).rejects.toThrow(/no sprite lines up with the model well enough \(sprite south 0%/)
    await expect(planModelNormals(model, { source: "sprites" })).rejects.toThrow(/needs the figure's sprites/)
    await expect(planModelNormals(model, { source: "sprites", sprites: [{ direction: "south", png: solidPng(600, [0, 0, 0, 255]) }] })).rejects.toThrow(/8 to 512 px/)
  })

  it("poses the model at a moment of an animation", () => {
    const document = parseGlb(tinyGlb())
    expect(parsePose("Wave@0.5")).toEqual({ animation: "Wave", time: 0.5 })
    expect(parsePose("0")).toEqual({ animation: 0, time: 0 })
    expect(() => parsePose("Wave@soon")).toThrow(/not a pose/)
    const rest = restPrimitives(document)[0]!.positions
    // The fixture's Wave turns the forearm bone 45 degrees halfway through; the hips quad stays put.
    const waved = restPrimitives(document, { animation: "wave", time: 0.5 })[0]!.positions
    expect(Array.from(waved.slice(0, 12))).toEqual(Array.from(rest.slice(0, 12)))
    expect(Array.from(waved.slice(12, 24))).not.toEqual(Array.from(rest.slice(12, 24)))
    expect(() => restPrimitives(document, { animation: "Dance", time: 0 })).toThrow(/no animation "Dance"; it has: Wave/)
  })

  it("reads a folder of sprites by direction, and a PixelLab rotations folder inside it", async () => {
    const folder = path.join(dir, "models", "knight.sprites")
    await mkdir(path.join(folder, "rotations"), { recursive: true })
    await writeFile(path.join(folder, "rotations", "south.png"), solidPng(8, [1, 2, 3, 255]))
    await writeFile(path.join(folder, "rotations", "north-east.png"), solidPng(8, [1, 2, 3, 255]))
    await writeFile(path.join(folder, "rotations", "notes.png"), solidPng(8, [1, 2, 3, 255]))
    expect((await readSpriteFolder(folder)).map((sprite) => sprite.direction)).toEqual(["north-east", "south"])
  })
})
