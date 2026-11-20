import path from "node:path"
import { existsSync } from "node:fs"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { parseArgs } from "../src/cli/args.ts"
import { PixelKilnError } from "../src/errors.ts"
import {
  formatPixelfxEffects,
  listPixelfxEffects,
  loadPixelfx,
  makePixelfxVfx,
  pixelfxSheet,
  PIXELFX_INSTALL,
  readPixelfxRecipe,
  renderPixelfx,
  type PixelfxFrame,
  type PixelfxLibrary,
  type PixelfxModule,
} from "../src/pixelfx-vfx.ts"
import { decodePng } from "../src/png.ts"

type FakeDraw = (frame: PixelfxFrame, t: number, o: Record<string, unknown>) => void

const abgr = (hex: string) => {
  const n = Number.parseInt(hex.slice(1), 16)
  return (0xff000000 | ((n & 255) << 16) | (n & 0xff00) | (n >> 16)) >>> 0
}

/**
 * A stand-in for pixelfx with the same four core calls, so these tests run
 * without the library. Its one real effect moves a dot a pixel a frame, at a
 * row its seed picks, in the last color of its palette.
 */
function fakeLibrary(): PixelfxLibrary {
  const dot: PixelfxModule & { draw: FakeDraw } = {
    meta: { name: "Dot", desc: "A dot.", size: [4, 3], origin: [1, 2], duration: 0.5, loop: true, fps: 4, options: { palette: ["#000000", "#ff0000"], seed: 0 } },
    draw: (frame, t, o) => {
      const palette = (o.palette as string[] | undefined) ?? ["#ff0000"]
      const x = Math.round(t * 4) - frame.ox
      const y = ((o.seed as number) % 3) - frame.oy
      frame.color[y * frame.w + x] = abgr(palette[palette.length - 1]!)
    },
  }
  return {
    version: "9.9.9",
    core: {
      createFrame: (w, h, ox = 0, oy = 0) => ({ w, h, ox, oy, color: new Uint32Array(w * h), light: new Uint32Array(w * h) }),
      clearFrame: (frame) => {
        frame.color.fill(0)
        frame.light.fill(0)
        return frame
      },
      createFx: (mod, options = {}) => {
        const o = { ...(mod.meta?.options ?? {}), ...options }
        let t = 0
        return { update: (dt) => void (t += dt), draw: (frame) => (mod.draw as FakeDraw)(frame, t, o) }
      },
      composite: (frame, out) => {
        new Uint8Array(out.buffer, out.byteOffset, out.byteLength).set(new Uint8Array(frame.color.buffer))
        return out
      },
    },
    effects: {
      "test/dot": dot,
      "test/once": { ...dot, meta: { ...dot.meta!, name: "Once", loop: false, options: { seed: 0 } } },
      "test/hero": { ...dot, meta: { ...dot.meta!, name: "Hero", actor: 2 } },
    },
    categories: [{ id: "test", name: "test", blurb: "fakes" }],
  }
}

let dir: string
beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "pixelkiln-pixelfx-"))
})
afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

describe("pixelfx effects, with the library stood in for", () => {
  it("lists effects and marks the ones that need a character", () => {
    const lib = fakeLibrary()
    expect(listPixelfxEffects(lib).map((effect) => [effect.id, effect.needsCharacter])).toEqual([
      ["test/dot", false],
      ["test/once", false],
      ["test/hero", true],
    ])
    const text = formatPixelfxEffects(lib)
    expect(text).toContain("pixelfx 9.9.9: 3 effects")
    expect(text).toContain("test: fakes")
    expect(text).toMatch(/test\/hero .*needs a character/)
  })

  it("renders one frame per step, a closing frame for a one-shot, and the seed and palette it is given", () => {
    const lib = fakeLibrary()
    const loop = renderPixelfx(lib, { effect: "test/dot", options: { seed: 1, palette: ["#000", "#00ff00"] } })
    expect([loop.width, loop.height, loop.fps, loop.frames.length, loop.loop]).toEqual([4, 3, 4, 2, true])
    expect(loop.anchor).toEqual({ x: 1, y: 2 })
    // Frame 1: the dot has moved to x=1 on row 1 (the seed), in green.
    expect([...loop.frames[1]!.subarray((1 * 4 + 1) * 4, (1 * 4 + 2) * 4)]).toEqual([0, 255, 0, 255])
    expect(renderPixelfx(lib, { effect: "test/once" }).frames).toHaveLength(3)
    expect(renderPixelfx(lib, { effect: "test/dot", fps: 8 }).frames).toHaveLength(4)
  })

  it("adds a margin around the canvas and moves the anchor with it", () => {
    const render = renderPixelfx(fakeLibrary(), { effect: "test/dot", margin: 2 })
    expect([render.width, render.height]).toEqual([8, 7])
    expect(render.anchor).toEqual({ x: 3, y: 4 })
    expect([...render.frames[0]!.subarray((2 * 8 + 2) * 4, (2 * 8 + 3) * 4)]).toEqual([255, 0, 0, 255])
  })

  it("refuses what an effect cannot take", () => {
    const lib = fakeLibrary()
    expect(() => renderPixelfx(lib, { effect: "test/nope" })).toThrow(/no effect "test\/nope"; close: test\/dot/)
    expect(() => renderPixelfx(lib, { effect: "test/hero" })).toThrow(/stock character/)
    expect(() => renderPixelfx(lib, { effect: "test/once", options: { palette: ["#000", "#fff"] } })).toThrow(/takes no palette/)
    expect(() => renderPixelfx(lib, { effect: "test/dot", options: { palette: ["red", "#fff"] } })).toThrow(/hex colors/)
    expect(() => renderPixelfx(lib, { effect: "test/dot", fps: 0 })).toThrow(/fps/)
    expect(() => renderPixelfx(lib, { effect: "constructor" })).toThrow(/no effect/)
  })

  it("lays frames out in a grid", () => {
    const render = renderPixelfx(fakeLibrary(), { effect: "test/dot", fps: 8 })
    const sheet = pixelfxSheet(render)
    expect([sheet.columns, sheet.rows]).toEqual([2, 2])
    expect(sheet.rects[3]).toEqual({ x: 4, y: 3, w: 4, h: 3 })
    const image = decodePng(sheet.png)
    expect([image.width, image.height]).toEqual([8, 6])
    // Frame 3 sits bottom-right with its dot at x=2, row 0.
    expect([...image.pixels.subarray((3 * 8 + 6) * 4, (3 * 8 + 7) * 4)]).toEqual([255, 0, 0, 255])
  })

  it("writes a sheet, an atlas with the pivot as meta.anchor, and a record that renders the same pixels again", async () => {
    const lib = fakeLibrary()
    const out = path.join(dir, "fx", "dot")
    const res = await makePixelfxVfx(lib, { effect: "test/dot", fps: 8, options: { seed: 2 }, out })
    expect(res.paths).toEqual({ sheet: `${out}.png`, atlas: `${out}.json`, provenance: `${out}.vfx.json` })
    expect(existsSync(`${out}.gif`)).toBe(false)

    const atlas = JSON.parse(await readFile(res.paths.atlas, "utf8"))
    expect(atlas.frames).toHaveLength(4)
    expect(atlas.frames[1]).toMatchObject({ filename: "dot 1", frame: { x: 4, y: 0, w: 4, h: 3 }, duration: 125 })
    expect(atlas.meta).toMatchObject({ image: "dot.png", size: { w: 8, h: 6 }, anchor: { kind: "origin", x: 1, y: 2 } })
    expect(atlas.meta.pixelfx).toMatchObject({ id: "test/dot", version: "9.9.9", fps: 8, loop: true, frames: 4, columns: 2 })

    const record = JSON.parse(await readFile(res.paths.provenance, "utf8"))
    expect(record).toMatchObject({
      version: 1,
      provider: "pixelfx",
      tool: "pixelfx",
      library: { name: "pixelfx", version: "9.9.9", license: "MIT" },
      effect: "test/dot",
      frames: 4,
      anchor: { kind: "origin", x: 1, y: 2 },
      files: { sheet: "dot.png", atlas: "dot.json" },
      sheetSha256: res.sheetSha256,
      recipe: { effect: "test/dot", fps: 8, options: { seed: 2 } },
    })

    const read = await readPixelfxRecipe(res.paths.provenance)
    expect(read).toEqual({ recipe: record.recipe, libraryVersion: "9.9.9" })
    const again = await makePixelfxVfx(lib, { ...read!.recipe, out: path.join(dir, "again") })
    expect(again.sheetSha256).toBe(res.sheetSha256)
    expect((await readFile(again.paths.sheet)).equals(await readFile(res.paths.sheet))).toBe(true)
  })

  it("keeps existing files without force, and writes nothing for a bad recipe", async () => {
    const lib = fakeLibrary()
    const out = path.join(dir, "dot")
    await makePixelfxVfx(lib, { effect: "test/dot", out })
    await expect(makePixelfxVfx(lib, { effect: "test/dot", out })).rejects.toThrow(/already exists; pass --force/)
    await makePixelfxVfx(lib, { effect: "test/dot", out, force: true })
    await expect(makePixelfxVfx(lib, { effect: "test/hero", out: path.join(dir, "hero") })).rejects.toThrow(/stock character/)
    expect(existsSync(path.join(dir, "hero.png"))).toBe(false)
  })

  it("tells a pixelfx recipe from a PixelLab one", async () => {
    const file = path.join(dir, "r.json")
    await writeFile(file, JSON.stringify({ effect: "test/dot", fps: 6, options: { seed: 1 } }))
    expect(await readPixelfxRecipe(file)).toEqual({ recipe: { effect: "test/dot", fps: 6, options: { seed: 1 } } })
    await writeFile(file, JSON.stringify({ name: "Impact", layers: [] }))
    expect(await readPixelfxRecipe(file)).toBeNull()
    await writeFile(file, JSON.stringify({ tool: "vfx_workbench", effectId: "x", recipe: { layers: [] } }))
    expect(await readPixelfxRecipe(file)).toBeNull()
    await writeFile(file, JSON.stringify({ tool: "pixelfx", recipe: {} }))
    await expect(readPixelfxRecipe(file)).rejects.toThrow(/no recipe naming an effect/)
  })

  it("says how to install the library when it is missing", async () => {
    const failure = await loadPixelfx([dir]).catch((error: unknown) => error)
    expect(failure).toBeInstanceOf(PixelKilnError)
    expect((failure as PixelKilnError).code).toBe("capability")
    expect((failure as PixelKilnError).hint).toContain(PIXELFX_INSTALL)
  })

  it("parses the vfx flags", () => {
    const args = parseArgs(["vfx", "--lib", "pixelfx", "--effect", "fire/torch", "--palette", "#102,#43a,#fff", "--seed", "3", "--fps", "12", "--margin", "4", "--out", "fx/torch"])
    expect(args).toMatchObject({ subcommand: "make", lib: "pixelfx", effect: "fire/torch", palette: ["#102", "#43a", "#fff"], seed: 3, fps: 12, margin: 4 })
    expect(parseArgs(["vfx", "effects", "--json"])).toMatchObject({ subcommand: "effects", json: true })
  })
})

// The real library is a dev dependency (it is not on the npm registry); where it is absent these are skipped.
const real = await loadPixelfx().catch(() => null)

describe.skipIf(!real)("pixelfx effects, with the library installed", () => {
  it("lists the catalog", () => {
    const effects = listPixelfxEffects(real!)
    expect(effects.length).toBeGreaterThan(200)
    expect(effects.find((effect) => effect.id === "fire/torch")).toMatchObject({ width: 72, height: 120, loop: true, needsCharacter: false })
  })

  it("renders a drawn effect and a simulated one to the same bytes every time", async () => {
    for (const [effect, options] of [
      ["fire/candle", { seed: 5 }],
      ["impacts/hit-spark", { seed: 11 }],
    ] as const) {
      const recipe = { effect, fps: 12, options }
      const first = await makePixelfxVfx(real!, { ...recipe, out: path.join(dir, "a"), force: true })
      const second = await makePixelfxVfx(real!, { ...recipe, out: path.join(dir, "b"), force: true })
      expect(second.sheetSha256, effect).toBe(first.sheetSha256)
      const image = decodePng(await readFile(first.paths.sheet))
      expect(image.width).toBe(first.columns * first.width)
      expect(image.pixels.some((byte) => byte !== 0), effect).toBe(true)
      const other = await makePixelfxVfx(real!, { ...recipe, options: { seed: options.seed + 1 }, out: path.join(dir, "c"), force: true })
      expect(other.sheetSha256, `${effect} with another seed`).not.toBe(first.sheetSha256)
    }
  })
})
