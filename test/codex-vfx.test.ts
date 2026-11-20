import path from "node:path"
import { existsSync } from "node:fs"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { parseArgs } from "../src/cli/args.ts"
import {
  CODEX_INSTALL,
  checkCodexRecipe,
  formatCodexEffects,
  listCodexEffects,
  loadCodex,
  makeCodexVfx,
  planCodex,
  readCodexRecipe,
  renderCodex,
  type CodexLibrary,
} from "../src/codex-vfx.ts"
import { PixelKilnError } from "../src/errors.ts"
import { decodePng } from "../src/png.ts"

/**
 * A stand-in for pixel-vfx-codex: the same files in the same places, and an engine with the calls
 * PixelKiln makes. Its one effect is a dot that moves right at a speed the `speed` parameter sets.
 */
const FAKE_ENGINE = `
(function (G) {
  const FX = new Map();
  class View {
    constructor(canvas, W, H) { this.W = W; this.H = H; this.pix = new Uint32Array(W * H); this.params = {}; this.tune = {}; this.hue = 0; }
    camera() { this.OX = this.W / 2; this.OY = this.H / 2; }
    P(x, y, z) { this.px = this.OX + x * 10; this.py = this.OY - z * 10; return true; }
    renderAt(def, t) {
      this.pix.fill(0);
      const speed = this.params.speed != null ? this.params.speed : def.params.speed.value;
      this.pix[20 * this.W + 10 + Math.floor(t * 10 * speed)] = 0xff0000ff;
    }
  }
  G.PXFX = {
    View,
    MODES: { '2d': { fps: 12 }, '25d': { fps: 20 }, '3d': { fps: 30 } },
    timing: (def) => ({ length: def.loop }),
    frameTime: (t) => t,
    define: (def) => FX.set(def.id, def),
    get: (id) => FX.get(id),
    all: () => [...FX.values()],
  };
})(typeof window !== 'undefined' ? window : globalThis);
`
const FAKE_EFFECT = `PXFX.define({ id: 'dot', loop: 0.5, params: { speed: { en: 'speed', min: 1, max: 3, step: 1, value: 1 } } });`

async function installFake(root: string, version = "1.0.0"): Promise<void> {
  const pkg = path.join(root, "node_modules", "pixel-vfx-codex")
  await mkdir(path.join(pkg, "engine"), { recursive: true })
  await mkdir(path.join(pkg, "fx"), { recursive: true })
  await mkdir(path.join(pkg, "data"), { recursive: true })
  await writeFile(path.join(pkg, "package.json"), JSON.stringify({ name: "pixel-vfx-codex", version }))
  await writeFile(path.join(pkg, "engine", "pxfx.js"), FAKE_ENGINE)
  await writeFile(path.join(pkg, "engine", "kit.js"), "")
  await writeFile(path.join(pkg, "fx", "dot.js"), FAKE_EFFECT)
  await writeFile(path.join(pkg, "data", "meta.json"), JSON.stringify([{ id: "dot", en: "Dot", descEn: "A dot that moves right.", category: "projectile", schools: ["test"] }]))
}

let dir: string
let fake: CodexLibrary
beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "pixelkiln-codex-"))
  await installFake(dir)
  fake = loadCodex([dir])
})
afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

describe("pixel-vfx-codex effects, with the library stood in for", () => {
  it("says how to install the library when it is missing", async () => {
    const empty = await mkdtemp(path.join(tmpdir(), "pixelkiln-codex-empty-"))
    try {
      expect(() => loadCodex([empty])).toThrow(PixelKilnError)
      try {
        loadCodex([empty])
      } catch (error) {
        expect((error as PixelKilnError).code).toBe("capability")
        expect((error as PixelKilnError).hint).toContain(CODEX_INSTALL)
      }
    } finally {
      await rm(empty, { recursive: true, force: true })
    }
  })

  it("refuses an install that lacks the files it needs", async () => {
    await rm(path.join(dir, "node_modules", "pixel-vfx-codex", "data"), { recursive: true })
    expect(() => loadCodex([dir])).toThrow(/has no data\/meta.json/)
  })

  it("keeps the engine's global out of this process", () => {
    expect((globalThis as { PXFX?: unknown }).PXFX).toBeUndefined()
  })

  it("lists effects with their parameters and prints them by category", () => {
    expect(fake.version).toBe("1.0.0")
    expect(fake.engineSha256).toMatch(/^[0-9a-f]{12}$/)
    expect(listCodexEffects(fake)).toEqual([
      expect.objectContaining({ id: "dot", en: "Dot", category: "projectile", loopSeconds: 0.5, params: { speed: { label: "speed", min: 1, max: 3, value: 1 } } }),
    ])
    const text = formatCodexEffects(fake)
    expect(text).toContain("pixel-vfx-codex 1.0.0: 1 effects")
    expect(text).toContain("projectile (1)")
    expect(text).toMatch(/dot\s+Dot/)
  })

  it("plans the frame count from the camera's step rate and the effect's length", () => {
    expect(planCodex(fake, { effect: "dot" })).toEqual({ camera: "2d", fps: 12, frames: 6, seconds: 0.5 })
    expect(planCodex(fake, { effect: "dot", camera: "25d" })).toMatchObject({ fps: 20, frames: 10 })
    expect(planCodex(fake, { effect: "dot", fps: 24 }).frames).toBe(12)
  })

  it("crops every frame to the box holding all of them and the pivot, and keeps the pivot in it", () => {
    const render = renderCodex(fake, { effect: "dot" })
    // The dot walks x 10..15 on row 20; the pivot is the middle of the 160x100 canvas, (80, 50).
    expect([render.width, render.height]).toEqual([71, 31])
    expect(render.anchor).toEqual({ x: 70, y: 30 })
    expect(render.frames).toHaveLength(6)
    expect(render.frames.every((frame) => frame.length === 71 * 31 * 4)).toBe(true)
    // Frame 3 is at t = 0.25 s, so the dot is at x = 12, two columns in from the crop's edge, on its top row.
    expect([...render.frames[3]!.subarray(2 * 4, 3 * 4)]).toEqual([255, 0, 0, 255])
    const padded = renderCodex(fake, { effect: "dot", margin: 2 })
    expect([padded.width, padded.height]).toEqual([75, 35])
    expect(padded.anchor).toEqual({ x: 72, y: 32 })
  })

  it("passes parameters and the camera to the effect", () => {
    const slow = renderCodex(fake, { effect: "dot" })
    const fast = renderCodex(fake, { effect: "dot", params: { speed: 3 } })
    expect(fast.frames.map((frame) => frame.toString("hex"))).not.toEqual(slow.frames.map((frame) => frame.toString("hex")))
    expect(renderCodex(fake, { effect: "dot", camera: "25d" }).fps).toBe(20)
  })

  it("refuses what an effect cannot take", () => {
    expect(() => checkCodexRecipe(fake, { effect: "do" })).toThrow(/no effect "do"; close: dot/)
    expect(() => checkCodexRecipe(fake, { effect: "dot", params: { size: 1 } })).toThrow(/no parameter "size"; it has speed/)
    expect(() => checkCodexRecipe(fake, { effect: "dot", params: { speed: 9 } })).toThrow(/from 1 to 3/)
    expect(() => checkCodexRecipe(fake, { effect: "dot", tune: { bogus: 1 } })).toThrow(/unknown tune knob "bogus"/)
    expect(() => checkCodexRecipe(fake, { effect: "dot", fps: 0 })).toThrow(/fps/)
    expect(() => checkCodexRecipe(fake, { effect: "dot", margin: 99 })).toThrow(/margin/)
    expect(() => checkCodexRecipe(fake, { effect: "dot", hue: 400 })).toThrow(/hue/)
    expect(() => checkCodexRecipe(fake, { effect: "dot", camera: "5d" as never })).toThrow(/camera/)
  })

  it("writes a sheet, an atlas with the pivot as meta.anchor, and a record that renders the same pixels again", async () => {
    const out = path.join(dir, "fx", "dot")
    const res = await makeCodexVfx(fake, { effect: "dot", params: { speed: 2 }, margin: 1, out })
    expect(res.paths).toEqual({ sheet: `${out}.png`, atlas: `${out}.json`, provenance: `${out}.vfx.json` })
    expect(existsSync(`${out}.gif`)).toBe(false)
    const image = decodePng(await readFile(res.paths.sheet))
    expect(image.width).toBe(res.columns * res.width)

    const atlas = JSON.parse(await readFile(res.paths.atlas, "utf8"))
    expect(atlas.frames).toHaveLength(6)
    expect(atlas.frames[1]).toMatchObject({ filename: "dot 1", duration: 83 })
    expect(atlas.meta).toMatchObject({ image: "dot.png", anchor: { kind: "origin", x: res.anchor.x, y: res.anchor.y } })
    expect(atlas.meta.codex).toMatchObject({ id: "dot", version: "1.0.0", camera: "2d", fps: 12, loop: true, frames: 6 })

    const record = JSON.parse(await readFile(res.paths.provenance, "utf8"))
    expect(record).toMatchObject({
      version: 1,
      provider: "codex",
      tool: "codex",
      library: { name: "pixel-vfx-codex", version: "1.0.0", engineSha256: fake.engineSha256, license: "MIT" },
      effect: "dot",
      sheetSha256: res.sheetSha256,
      recipe: { effect: "dot", margin: 1, params: { speed: 2 } },
    })

    const read = await readCodexRecipe(res.paths.provenance)
    expect(read).toEqual({ recipe: record.recipe, libraryVersion: "1.0.0", engineSha256: fake.engineSha256 })
    const again = await makeCodexVfx(fake, { ...read!.recipe, out: path.join(dir, "again") })
    expect(again.sheetSha256).toBe(res.sheetSha256)
  })

  it("keeps existing files without force, before rendering anything", async () => {
    const out = path.join(dir, "dot")
    await makeCodexVfx(fake, { effect: "dot", out })
    await expect(makeCodexVfx(fake, { effect: "dot", out })).rejects.toThrow(/already exists; pass --force/)
    await makeCodexVfx(fake, { effect: "dot", out, force: true })
    await expect(makeCodexVfx(fake, { effect: "nope", out: path.join(dir, "nope") })).rejects.toThrow(/no effect/)
    expect(existsSync(path.join(dir, "nope.png"))).toBe(false)
  })

  it("tells a codex record from other recipes", async () => {
    const file = path.join(dir, "r.json")
    await writeFile(file, JSON.stringify({ effect: "dot", camera: "25d", params: { speed: 2 } }))
    expect(await readCodexRecipe(file)).toBeNull()
    expect(await readCodexRecipe(file, { bare: true })).toEqual({ recipe: { effect: "dot", camera: "25d", params: { speed: 2 } } })
    await writeFile(file, JSON.stringify({ tool: "pixelfx", recipe: { effect: "fire/torch" } }))
    expect(await readCodexRecipe(file, { bare: true })).toBeNull()
    await writeFile(file, JSON.stringify({ name: "Impact", layers: [] }))
    expect(await readCodexRecipe(file, { bare: true })).toBeNull()
    await writeFile(file, JSON.stringify({ tool: "codex", recipe: {} }))
    await expect(readCodexRecipe(file)).rejects.toThrow(/no recipe naming an effect/)
  })

  it("parses the vfx flags", () => {
    const args = parseArgs(["vfx", "--lib", "codex", "--effect", "fireball", "--camera", "25d", "--hue", "40", "--param", "sparks=30,debris=4", "--tune", "size=1.2", "--margin", "2", "--out", "fx/fb"])
    expect(args).toMatchObject({ subcommand: "make", lib: "codex", effect: "fireball", camera: "25d", hue: 40, param: ["sparks=30", "debris=4"], tune: ["size=1.2"], margin: 2 })
    expect(parseArgs(["vfx", "effects", "--lib", "codex", "--json"])).toMatchObject({ subcommand: "effects", lib: "codex", json: true })
  })
})

// The real package is a dev dependency (it is not on the npm registry); where it is absent these are skipped.
const real = (() => {
  try {
    return loadCodex()
  } catch {
    return null
  }
})()

describe.skipIf(!real)("pixel-vfx-codex effects, with the library installed", () => {
  it("loads every effect", () => {
    expect(real!.loadErrors).toEqual([])
    expect(listCodexEffects(real!).length).toBeGreaterThanOrEqual(138)
    expect(listCodexEffects(real!).find((effect) => effect.id === "fireball")?.params).toHaveProperty("tailLength")
  })

  it("renders to the same bytes every time, in each camera, and keeps the pivot inside the frame", async () => {
    for (const camera of ["2d", "25d"] as const) {
      const recipe = { effect: "healing-field", camera }
      const first = await makeCodexVfx(real!, { ...recipe, out: path.join(dir, `a-${camera}`) })
      const second = await makeCodexVfx(real!, { ...recipe, out: path.join(dir, `b-${camera}`) })
      expect(second.sheetSha256, camera).toBe(first.sheetSha256)
      expect(first.anchor.x).toBeGreaterThanOrEqual(0)
      expect(first.anchor.x).toBeLessThan(first.width)
      expect(first.anchor.y).toBeLessThan(first.height)
      expect(decodePng(await readFile(first.paths.sheet)).pixels.some((byte) => byte !== 0), camera).toBe(true)
    }
    const flat = renderCodex(real!, { effect: "fireball" })
    const turned = renderCodex(real!, { effect: "fireball", hue: 120 })
    expect(turned.frames.map((frame) => frame.toString("hex"))).not.toEqual(flat.frames.map((frame) => frame.toString("hex")))
  }, 120_000)
})
