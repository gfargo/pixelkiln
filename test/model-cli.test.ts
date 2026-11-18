import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { execFile } from "node:child_process"
import { existsSync } from "node:fs"
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { promisify } from "node:util"
import { uvGuide } from "../src/glb-guide.ts"
import { glbImageBytes, parseGlb, replaceGlbImage, serializeGlb } from "../src/glb.ts"
import { decodeJpeg } from "../src/jpeg.ts"
import { renderGuide, hslToRgb } from "../src/pipeline/model-guide.ts"
import { decodePng } from "../src/png.ts"
import { solidPng, tinyGlb } from "./fixtures/tiny-glb.ts"

const execFileAsync = promisify(execFile)
const cli = (cwd: string, ...args: string[]) =>
  execFileAsync(path.resolve("node_modules/.bin/tsx"), [path.resolve("src/cli.ts"), ...args], { cwd, env: { ...process.env, PIXELKILN_EDITOR: "true" } })

describe("baseline JPEG", () => {
  it("decodes a subsampled YCbCr file of an odd size to what macOS's decoder gives", async () => {
    const jpeg = await readFile("test/fixtures/jpeg/gradient.jpg")
    const reference = decodePng(await readFile("test/fixtures/jpeg/gradient.reference.png"))
    const decoded = decodeJpeg(jpeg)
    expect([decoded.width, decoded.height]).toEqual([37, 21])
    expect([reference.width, reference.height]).toEqual([37, 21])
    const channels = reference.pixels.length / (37 * 21)
    let worst = 0
    let total = 0
    for (let pixel = 0; pixel < 37 * 21; pixel++) {
      for (let c = 0; c < 3; c++) {
        const gap = Math.abs(decoded.pixels[pixel * 4 + c]! - reference.pixels[pixel * channels + c]!)
        worst = Math.max(worst, gap)
        total += gap
      }
      expect(decoded.pixels[pixel * 4 + 3]).toBe(255)
    }
    // Decoders smooth subsampled colour differently; the gaps sit at chroma block edges, under a level on average.
    expect(total / (37 * 21 * 3)).toBeLessThan(1.5)
    expect(worst).toBeLessThanOrEqual(10)
  })

  it("refuses what it does not read, with the reason", () => {
    expect(() => decodeJpeg(Buffer.from("nope"))).toThrow(/start-of-image/)
    // SOI, then a progressive frame header.
    const progressive = Buffer.from([0xff, 0xd8, 0xff, 0xc2, 0x00, 0x0b, 0x08, 0x00, 0x08, 0x00, 0x08, 0x01, 0x01, 0x11, 0x00])
    expect(() => decodeJpeg(progressive)).toThrow(/progressive JPEG is not supported/)
    const cmyk = Buffer.from([0xff, 0xd8, 0xff, 0xc0, 0x00, 0x14, 0x08, 0x00, 0x08, 0x00, 0x08, 0x04, 1, 0x11, 0, 2, 0x11, 0, 3, 0x11, 0, 4, 0x11, 0])
    expect(() => decodeJpeg(cmyk)).toThrow(/4 colour components/)
  })
})

describe("the guide as files", () => {
  it("outlines and numbers each piece on a transparent PNG the texture's size, with a key", () => {
    const document = parseGlb(tinyGlb())
    const guide = uvGuide(document, 0)
    const { png, key } = renderGuide(guide, 64, 64)
    const image = decodePng(png)
    expect([image.width, image.height]).toEqual([64, 64])
    const alpha = (x: number, y: number) => image.pixels[(y * 64 + x) * 4 + 3]!
    // Corners of the texture are outside every piece; the hips piece's edge at u=0.05 is drawn.
    expect(alpha(63, 0)).toBe(0)
    expect(alpha(Math.round(0.05 * 64), 16)).toBe(255)
    expect(key).toContain("1\t#")
    expect(key).toMatch(/\tHips\n/)
    expect(key).toMatch(/Left lower arm, front\t35 35 61 61\tCharacter/)
  })

  it("converts the region colours", () => {
    expect(hslToRgb("hsl(0 100% 50%)")).toEqual([255, 0, 0])
    expect(hslToRgb("hsl(120 100% 50%)")).toEqual([0, 255, 0])
  })
})

describe("pixelkiln model", () => {
  let dir: string
  let modelFile: string
  beforeEach(async () => {
    dir = await realpath(await mkdtemp(path.join(tmpdir(), "pixelkiln-model-cli-")))
    await writeFile(path.join(dir, "pixelkiln.manifest.json"), JSON.stringify({
      name: "models",
      styles: { cast: { generator: "map", outDir: "art" } },
      assets: { anvil: { prompt: "an anvil", width: 32, height: 32 } },
    }))
    modelFile = path.join(dir, "art", "models", "knight.glb")
    await mkdir(path.dirname(modelFile), { recursive: true })
    // The body texture as a JPEG, the way generated models carry theirs.
    const base = parseGlb(tinyGlb())
    await writeFile(modelFile, serializeGlb(replaceGlbImage(base, 0, await readFile("test/fixtures/jpeg/gradient.jpg"), "image/jpeg")))
  })
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it("lists models, as text and as JSON", async () => {
    const text = (await cli(dir, "model")).stdout
    expect(text).toContain("art/models/knight.glb  (cast)")
    expect(text).toContain("image 0: Sprite base colour, 37×21 jpeg")
    const json = JSON.parse((await cli(dir, "model", "list", "--json")).stdout) as Array<{ name: string; file: { url?: string } }>
    expect(json.map((model) => model.name)).toEqual(["knight"])
    expect(json[0]!.file.url).toBeUndefined()
  })

  it("exports a JPEG texture as PNG with its guide, and imports the painting into an edited copy", async () => {
    const before = await readFile(modelFile)
    const exported = JSON.parse((await cli(dir, "model", "export", "knight", "--image", "Sprite", "--no-open", "--json")).stdout) as { texture: string; guide: string; key: string; image: number; fromEdit: boolean }
    expect(exported.image).toBe(0)
    expect(exported.fromEdit).toBe(false)
    expect(path.relative(dir, exported.texture)).toBe("art/edits/models/knight.image-0.png")
    const texture = decodePng(await readFile(exported.texture))
    expect([texture.width, texture.height]).toEqual([37, 21])
    expect(decodePng(await readFile(exported.guide)).width).toBe(37)
    expect(await readFile(exported.key, "utf8")).toContain("Hips")

    const painted = solidPng(1, [0, 0, 0, 255])
    await writeFile(exported.texture, painted)
    await expect(cli(dir, "model", "import", "knight", "--image", "0")).rejects.toMatchObject({ stderr: expect.stringContaining("1×1; image 0 of the model is 37×21") })

    const repaint = Buffer.from(texture.pixels)
    repaint.fill(200, 0, 37 * 4)
    const { encodeRgbaPng } = await import("../src/png.ts")
    const png = encodeRgbaPng(37, 21, repaint)
    await writeFile(exported.texture, png)
    const imported = await cli(dir, "model", "import", "art/models/knight.glb", "--image", "0")
    expect(imported.stdout).toContain("into art/edits/models/knight.glb (new edit)")
    const edit = path.join(dir, "art", "edits", "models", "knight.glb")
    expect(Buffer.from(glbImageBytes(parseGlb(await readFile(edit)), 0).bytes).equals(png)).toBe(true)
    expect((await readFile(modelFile)).equals(before)).toBe(true)
    const record = JSON.parse(await readFile(path.join(dir, "art", "edits", "models", "knight.edit.json"), "utf8")) as { editor: string; textures: Array<{ name: string }> }
    expect(record.editor).toBe("true (via pixelkiln model import)")
    expect(record.textures.map((t) => t.name)).toEqual(["Sprite"])

    // The next export starts from the edit, so painting carries on.
    const again = JSON.parse((await cli(dir, "model", "export", "knight", "--image", "0", "--no-open", "--json")).stdout) as { fromEdit: boolean }
    expect(again.fromEdit).toBe(true)
  })

  it("adopts an export, and says what is wrong when a model or texture is not there", async () => {
    const exportFile = path.join(dir, "art", "edits", "models", "knight.export.glb")
    await mkdir(path.dirname(exportFile), { recursive: true })
    await writeFile(exportFile, tinyGlb({ helmTexture: solidPng(8, [1, 2, 3, 255]) }))
    expect((await cli(dir, "model", "adopt", "knight")).stdout).toContain("adopted Sprite, Helm into art/edits/models/knight.glb")
    expect(existsSync(path.join(dir, "art", "edits", "models", "knight.glb"))).toBe(true)
    await expect(cli(dir, "model", "export", "ghost", "--image", "0")).rejects.toMatchObject({ stderr: expect.stringContaining('no model "ghost"') })
    await expect(cli(dir, "model", "export", "knight", "--image", "Cape", "--no-open")).rejects.toMatchObject({ stderr: expect.stringContaining('no base colour texture for material "Cape"') })
    await expect(cli(dir, "model", "export")).rejects.toMatchObject({ stderr: expect.stringContaining("needs a model") })
    await expect(cli(dir, "model", "adopt", "knight", "--mode", "all")).rejects.toMatchObject({ stderr: expect.stringContaining("textures (the default) or whole") })
  })

  it("prices normal map detail, refuses past --budget, and re-runs from cached answers without a key", async () => {
    const dry = (await cli(dir, "model", "normal-map", "knight", "--dry-run")).stdout
    expect(dry).toContain("the figure drawn from 4 directions")
    expect(dry).toContain("for: Sprite normal map (image 1)")
    expect(dry).toContain("cost 0.4 generations")
    expect(dry).toContain("dry run: nothing sent")
    await expect(cli(dir, "model", "normal-map", "knight", "--source", "texture", "--budget", "0.05", "--yes")).rejects.toMatchObject({ stderr: expect.stringContaining("below this run's 0.1-generation cost") })
    await expect(cli(dir, "model", "normal-map", "knight", "--source", "texture", "--views", "south")).rejects.toMatchObject({ stderr: expect.stringContaining("--views goes with --source views") })
    await expect(cli(dir, "model", "normal-map", "knight", "--source", "sprites")).rejects.toMatchObject({ stderr: expect.stringContaining("views (the default) or texture") })

    // Answer the one texture tile ahead of time: the run then sends nothing and needs no key.
    const plan = JSON.parse((await cli(dir, "model", "normal-map", "knight", "--image", "Sprite", "--source", "texture", "--dry-run", "--json")).stdout) as { cost: number; calls: Array<{ cache: string }> }
    expect(plan.cost).toBe(0.1)
    await writeFile(plan.calls[0]!.cache, solidPng(4, [200, 128, 200, 255]))
    const run = await execFileAsync(path.resolve("node_modules/.bin/tsx"), [path.resolve("src/cli.ts"), "model", "normal-map", "knight", "--source", "texture", "--blend", "2"], {
      cwd: dir,
      env: { ...process.env, PIXELLAB_API_KEY: "" },
    })
    expect(run.stdout).toContain("already answered, free")
    expect(run.stdout).toContain("saved Sprite normal map into art/edits/models/knight.glb")
    const record = JSON.parse(await readFile(path.join(dir, "art", "edits", "models", "knight.edit.json"), "utf8")) as { textures: Array<{ name: string; editor: string }> }
    expect(record.textures).toMatchObject([{ name: "Sprite normal map", editor: "pixellab normal-map (texture)" }])
  })
})
