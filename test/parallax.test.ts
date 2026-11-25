import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import path from "node:path"
import { tmpdir } from "node:os"
import { loadManifest } from "../src/manifest.ts"
import { decodePng, encodeRgbaPng, type DecodedPng } from "../src/png.ts"
import {
  cameraPath,
  composeParallaxFrame,
  exportGodot,
  exportLdtk,
  exportTiled,
  extendDown,
  finishPicture,
  layRun,
  loopPicture,
  resolveParallaxSet,
  seamRatio,
  skyBands,
  type ResolvedParallaxSet,
} from "../src/pipeline/parallax.ts"
import { ParallaxLayerSchema, type Lock } from "../src/types.ts"
import { main } from "../src/cli/main.ts"

let dir: string
beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "pixelkiln-parallax-"))
})
afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

/** A picture whose every pixel is distinct, so any shift shows; `alpha` clears columns. */
function striped(width: number, height: number, seed: number, clear?: (x: number, y: number) => boolean): DecodedPng {
  const pixels = Buffer.alloc(width * height * 4)
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const at = (y * width + x) * 4
      pixels[at] = (x * 7 + seed * 31) % 256
      pixels[at + 1] = (y * 13 + seed * 17) % 256
      pixels[at + 2] = (x * y + seed * 5) % 256
      pixels[at + 3] = clear?.(x, y) ? 0 : 255
    }
  }
  return { width, height, pixels }
}

function layer(png: DecodedPng, extra: Partial<ResolvedParallaxSet["layers"][number]> = {}): ResolvedParallaxSet["layers"][number] {
  return { name: "l", png, speed: 1, speedY: 1, x: 0, y: 0, repeat: true, repeatY: false, source: { kind: "file", path: "x.png" }, ...extra }
}

function set(layers: ResolvedParallaxSet["layers"], extra: Partial<ResolvedParallaxSet> = {}): ResolvedParallaxSet {
  return { id: "test", view: [64, 48], travel: 96, climb: 0, layers, warnings: [], ...extra }
}

const differing = (a: DecodedPng, b: DecodedPng) => {
  let n = 0
  for (let p = 0; p < a.width * a.height; p++) {
    if ([0, 1, 2, 3].some((c) => a.pixels[p * 4 + c] !== b.pixels[p * 4 + c])) n++
  }
  return n
}

/** The smallest sideways shift (0 to 2 px) at which `got` matches `want`, ignoring the columns the shift uncovers; 99 if none. */
function nearestShift(got: DecodedPng, want: DecodedPng): number {
  for (const shift of [0, 1, -1, 2, -2]) {
    let ok = true
    for (let y = 0; y < want.height && ok; y++) {
      for (let x = 2; x < want.width - 2 && ok; x++) {
        const a = (y * want.width + x) * 4
        const b = (y * want.width + x + shift) * 4
        if ([0, 1, 2, 3].some((c) => got.pixels[b + c] !== want.pixels[a + c])) ok = false
      }
    }
    if (ok) return Math.abs(shift)
  }
  return 99
}

/**
 * Draws an exported LDtk level the way LDtk's editor does: each tile at its
 * cell (counted across the layer, which is the level less the layer's pixel
 * offset) plus round(offset + camera centre x factor - layer size / 2 x factor).
 * See Camera.getParallaxOffsetX and LayerInstance.pxParallaxX in LDtk's source.
 */
async function drawLdtk(file: string, view: [number, number], camX: number, camY: number): Promise<DecodedPng> {
  const project = JSON.parse(await readFile(file, "utf8"))
  const level = project.levels[0]
  const [vw, vh] = view
  const cx = vw / 2 + camX
  const cy = level.pxHei - vh / 2 - camY
  const out: DecodedPng = { width: vw, height: vh, pixels: Buffer.alloc(vw * vh * 4) }
  for (const li of [...level.layerInstances].reverse()) {
    const def = project.defs.layers.find((d: { uid: number }) => d.uid === li.layerDefUid)
    const tileset = project.defs.tilesets.find((t: { uid: number }) => t.uid === def.tilesetDefUid)
    const picture = decodePng(await readFile(path.join(path.dirname(file), tileset.relPath)))
    const g = def.gridSize
    const width = level.pxWid - li.pxOffsetX
    const height = level.pxHei - li.pxOffsetY
    const cWid = Math.ceil(width / g)
    const ox = Math.round(li.pxOffsetX + cx * def.parallaxFactorX - width * 0.5 * def.parallaxFactorX)
    const oy = Math.round(li.pxOffsetY + cy * def.parallaxFactorY - height * 0.5 * def.parallaxFactorY)
    for (const tile of li.gridTiles) {
      const tx = (tile.d[0] % cWid) * g + ox - (cx - vw / 2)
      const ty = Math.floor(tile.d[0] / cWid) * g + oy - (cy - vh / 2)
      for (let y = 0; y < g; y++) {
        for (let x = 0; x < g; x++) {
          const sx = tx + x
          const sy = ty + y
          if (sx < 0 || sy < 0 || sx >= vw || sy >= vh) continue
          const src = ((tile.src[1] + y) * picture.width + tile.src[0] + x) * 4
          if (picture.pixels[src + 3] === 0) continue
          picture.pixels.copy(out.pixels, (sy * vw + sx) * 4, src, src + 4)
        }
      }
    }
  }
  return out
}

describe("parallax layers", () => {
  it("takes exactly one of asset, file or sky", () => {
    expect(ParallaxLayerSchema.safeParse({ asset: "a", speed: 0.5 }).success).toBe(true)
    expect(ParallaxLayerSchema.safeParse({ speed: 0.5 }).success).toBe(false)
    expect(ParallaxLayerSchema.safeParse({ asset: "a", file: "b.png", speed: 0.5 }).success).toBe(false)
    expect(ParallaxLayerSchema.safeParse({ file: "b.png", style: "s", speed: 0.5 }).success).toBe(false)
  })

  it("takes a run of sprites, and run settings only on a run", () => {
    expect(ParallaxLayerSchema.safeParse({ run: [{ asset: "a" }, { file: "b.png" }], seed: 3, jitter: 4, speed: 0.25 }).success).toBe(true)
    expect(ParallaxLayerSchema.safeParse({ run: [{ asset: "a", file: "b.png" }], speed: 0.25 }).success).toBe(false)
    expect(ParallaxLayerSchema.safeParse({ run: [{ file: "b.png", style: "s" }], speed: 0.25 }).success).toBe(false)
    expect(ParallaxLayerSchema.safeParse({ run: [{ file: "b.png" }], file: "c.png", speed: 0.25 }).success).toBe(false)
    expect(ParallaxLayerSchema.safeParse({ file: "b.png", seed: 3, speed: 0.25 }).success).toBe(false)
  })

  it("lays a run the same way for the same seed, and differently for another", () => {
    const sprites = [striped(30, 12, 1, (x) => x < 4 || x > 25), striped(24, 16, 2, (x) => x < 3), striped(36, 10, 3)]
    const a = layRun(sprites, 200, { seed: 5 })
    expect(differing(a, layRun(sprites, 200, { seed: 5 }))).toBe(0)
    expect(differing(a, layRun(sprites, 200, { seed: 6 }))).toBeGreaterThan(0)
    expect(a.height).toBe(16)
    // Jitter leaves room for every foot to move either way.
    expect(layRun(sprites, 200, { seed: 5, jitter: 3 }).height).toBe(22)
  })

  it("lays a looping run so each sprite crosses the edge under the next", () => {
    const solid = (r: number, b: number): DecodedPng => {
      const png = striped(10, 4, 0)
      for (let p = 0; p < 40; p++) png.pixels.set([r, 0, b, 255], p * 4)
      return png
    }
    // Two sprites alternate, a full width apart: they start at 0, 10 and 20, and the third runs 3 px past the edge.
    const run = layRun([solid(255, 0), solid(0, 255)], 27, { seed: 1, step: 1, gap: 0, loop: true })
    const red = (x: number) => run.pixels[x * 4]
    const first = red(0)
    for (let x = 0; x < 27; x++) expect(red(x), `column ${x}`).toBe(Math.floor(x / 10) === 1 ? 255 - first! : first)
    expect(() => layRun([solid(255, 0)], 8, { seed: 1, loop: true })).toThrow(/at least as wide/)
  })

  it("takes foot and tint on a picture or a run, not on sky bands", () => {
    expect(ParallaxLayerSchema.safeParse({ file: "b.png", foot: 0.3, tint: { color: "#7f4776", amount: 0.55 }, speed: 0.25 }).success).toBe(true)
    expect(ParallaxLayerSchema.safeParse({ run: [{ file: "b.png" }], foot: 0.3, speed: 0.25 }).success).toBe(true)
    expect(ParallaxLayerSchema.safeParse({ sky: ["#000000"], tint: { color: "#7f4776", amount: 0.5 }, speed: 0 }).success).toBe(false)
    expect(ParallaxLayerSchema.safeParse({ file: "b.png", foot: 0, speed: 0.25 }).success).toBe(false)
    expect(ParallaxLayerSchema.safeParse({ file: "b.png", tint: { color: "#7f4776", amount: 1.5 }, speed: 0.25 }).success).toBe(false)
    expect(ParallaxLayerSchema.safeParse({ file: "b.png", foot: 0.3, extend: true, speed: 0.25 }).success).toBe(false)
  })

  it("takes loop on a picture that repeats, not on sky, a run or a layer that does not repeat", () => {
    for (const loop of ["cut", "crossfade", "mirror"]) expect(ParallaxLayerSchema.safeParse({ file: "b.png", loop, speed: 0.25 }).success).toBe(true)
    expect(ParallaxLayerSchema.safeParse({ asset: "far", loop: "cut", tint: { color: "#7f4776", amount: 1 }, extend: true, speed: 0.25 }).success).toBe(true)
    expect(ParallaxLayerSchema.safeParse({ file: "b.png", loop: "wrap", speed: 0.25 }).success).toBe(false)
    const refused = (extra: object) => ParallaxLayerSchema.safeParse({ speed: 0.25, loop: "cut", ...extra }).error?.issues[0]?.message
    expect(refused({ sky: ["#000000"] })).toMatch(/sky layer/)
    expect(refused({ run: [{ file: "b.png" }] })).toMatch(/laid as a loop already/)
    expect(refused({ file: "b.png", repeat: false })).toMatch(/does not repeat/)
  })

  it("loops a picture at the two columns that best continue into each other", () => {
    // Every column differs except 29, a copy of 2, so the best cut keeps columns 2 to 29.
    const png = striped(40, 6, 3)
    for (let y = 0; y < 6; y++) png.pixels.copy(png.pixels, (y * 40 + 29) * 4, (y * 40 + 2) * 4, (y * 40 + 3) * 4)
    const cut = loopPicture(png, "cut")
    expect(cut.loop).toEqual({ method: "cut", from: 40, columns: [2, 30] })
    expect(cut.png.width).toBe(28)
    expect(seamRatio(cut.png)).toBe(0)
    expect(seamRatio(png)).toBeGreaterThan(1)
  })

  it("crossfades the last eighth into the first and mirrors, adding no colours", () => {
    const png = striped(40, 6, 4, (x, y) => x === 1 && y === 2)
    const colour = (p: DecodedPng, at: number) => [...p.pixels.subarray(at * 4, at * 4 + 3)].join()
    const source = new Set(Array.from({ length: 240 }, (_, p) => colour(png, p)))
    const fade = loopPicture(png, "crossfade")
    expect([fade.png.width, fade.loop]).toEqual([35, { method: "crossfade", from: 40 }])
    for (let p = 0; p < 35 * 6; p++) expect(source.has(colour(fade.png, p))).toBe(true)
    // Past the blended columns the picture is untouched, and alpha is the first columns'.
    expect(fade.png.pixels.subarray(5 * 4, 35 * 4)).toEqual(png.pixels.subarray(5 * 4, 35 * 4))
    expect(fade.png.pixels[(2 * 35 + 1) * 4 + 3]).toBe(0)

    const mirror = loopPicture(png, "mirror")
    expect(mirror.png.width).toBe(80)
    for (let x = 0; x < 40; x++) {
      expect(mirror.png.pixels.subarray((3 * 80 + 40 + x) * 4, (3 * 80 + 41 + x) * 4)).toEqual(png.pixels.subarray((3 * 40 + 39 - x) * 4, (3 * 40 + 40 - x) * 4))
    }
    expect(seamRatio(mirror.png)).toBe(0)
    expect(() => loopPicture(striped(6, 4, 1), "cut", "far")).toThrow(/far: 6 px wide is too narrow to loop/)
  })

  it("trims a picture and thins its foot out with an ordered dither", () => {
    // An 8 x 20 block in a 16 x 24 picture with clear margins.
    const png = striped(16, 24, 1, (x, y) => x < 3 || x >= 11 || y < 2 || y >= 22)
    const foot = finishPicture(png, { foot: 0.5 })
    expect([foot.width, foot.height]).toEqual([8, 20])
    const opaque = (y: number) => Array.from({ length: foot.width }, (_, x) => foot.pixels[(y * foot.width + x) * 4 + 3]).filter((a) => a === 255).length
    // The top half is untouched; the bottom 10 rows thin out, and alpha stays 0 or 255.
    for (let y = 0; y < 10; y++) expect(opaque(y)).toBe(8)
    expect(opaque(10)).toBeGreaterThan(opaque(19))
    expect(opaque(19)).toBe(0)
    expect([...foot.pixels.filter((_, i) => i % 4 === 3)].every((a) => a === 0 || a === 255)).toBe(true)
    // A layer that loops keeps its width; only rows are trimmed.
    expect(finishPicture(png, { foot: 0.5, keepWidth: true }).width).toBe(16)
    expect(() => finishPicture(striped(4, 4, 1, () => true), { foot: 0.3 })).toThrow(/no opaque pixel/)
  })

  it("tints toward a colour and snaps to the palette, rounding halves to even", () => {
    const png: DecodedPng = { width: 3, height: 1, pixels: Buffer.from([1, 1, 1, 255, 3, 3, 3, 255, 200, 10, 10, 0]) }
    // 0.5 rounds to 0 and 1.5 to 2, as the script's numpy does; a clear pixel is left alone.
    const half = finishPicture(png, { tint: { color: "#000000", amount: 0.5 }, palette: ["#000000", "#010101", "#020202", "#030303"] })
    expect([...half.pixels]).toEqual([0, 0, 0, 255, 2, 2, 2, 255, 200, 10, 10, 0])
    // Without a palette, a tint snaps to the picture's own opaque colours, so it adds none.
    const own = finishPicture(png, { tint: { color: "#ffffff", amount: 0.4 } })
    expect([...own.pixels.subarray(0, 8)]).toEqual([3, 3, 3, 255, 3, 3, 3, 255])
    const flat = finishPicture(striped(6, 6, 2), { tint: { color: "#7f4776", amount: 1 }, palette: ["#000000", "#7f4777", "#ffffff"] })
    for (let p = 0; p < 36; p++) expect([...flat.pixels.subarray(p * 4, p * 4 + 3)]).toEqual([0x7f, 0x47, 0x77])
  })

  it("draws sky bands top to bottom with a dithered step", () => {
    const sky = skyBands(8, 32, ["#000000", "#ffffff"], 4)
    const row = (y: number) => [...Array(8).keys()].map((x) => sky.pixels[(y * 8 + x) * 4]!)
    expect(row(0).every((v) => v === 0)).toBe(true)
    expect(row(31).every((v) => v === 255)).toBe(true)
    // Just above the boundary some pixels already take the next band.
    expect(row(15).some((v) => v === 255) && row(15).some((v) => v === 0)).toBe(true)
  })

  it("measures a wrap seam against the picture's own steps", () => {
    // A ramp that steps evenly but jumps at the wrap.
    const ramp = striped(32, 4, 0)
    expect(seamRatio(ramp)).toBeGreaterThan(5)
    // A picture whose last column repeats its first wraps as smoothly as it steps.
    const looped = striped(32, 4, 0)
    for (let y = 0; y < 4; y++) looped.pixels.copy(looped.pixels, (y * 32 + 31) * 4, (y * 32) * 4, (y * 32) * 4 + 4)
    expect(seamRatio(looped)).toBeLessThan(seamRatio(ramp))
  })

  it("does not call a picture drawn at 2x rough", () => {
    const base = striped(32, 4, 0)
    for (let y = 0; y < 4; y++) base.pixels.copy(base.pixels, (y * 32 + 31) * 4, (y * 32) * 4, (y * 32) * 4 + 4)
    const doubled: DecodedPng = { width: 64, height: 4, pixels: Buffer.alloc(64 * 4 * 4) }
    for (let y = 0; y < 4; y++) for (let x = 0; x < 64; x++) base.pixels.copy(doubled.pixels, (y * 64 + x) * 4, (y * 32 + (x >> 1)) * 4, (y * 32 + (x >> 1)) * 4 + 4)
    expect(seamRatio(doubled)).toBeLessThan(2)
  })

  it("extends the bottom row down", () => {
    const png = extendDown(striped(4, 2, 1), 3)
    expect(png.height).toBe(5)
    expect(png.pixels.subarray(4 * 4 * 4, 5 * 4 * 4)).toEqual(png.pixels.subarray(4 * 4, 2 * 4 * 4))
  })

  it("moves each layer its speed of the camera, rounding after the camera", () => {
    const far = layer(striped(40, 48, 1), { speed: 0.25 })
    const frame0 = composeParallaxFrame(set([far]), 0, 0)
    const frame = composeParallaxFrame(set([far]), 10, 0)
    // 10 x 0.25 = 2.5: a half pixel goes toward +x on screen, as Godot and LDtk draw it, so 2 columns.
    for (let x = 0; x < 62; x++) {
      expect(frame.pixels.subarray(x * 4, x * 4 + 4)).toEqual(frame0.pixels.subarray((x + 2) * 4, (x + 2) * 4 + 4))
    }
  })

  it("climbs: a layer moves down by its vertical speed of the climb", () => {
    const tall = layer(striped(64, 96, 2), { y: -48, speedY: 0.5, repeat: false })
    const s = set([tall], { travel: 0, climb: 40 })
    const frame = composeParallaxFrame(s, 0, 40)
    const start = composeParallaxFrame(s, 0, 0)
    // At the top of the climb the view shows rows 20 above where it started.
    expect(frame.pixels.subarray(20 * 64 * 4, 21 * 64 * 4)).toEqual(start.pixels.subarray(0, 64 * 4))
  })

  it("runs the preview camera from the start to the far end", () => {
    const path = cameraPath({ travel: 100, climb: 40 }, 5)
    expect(path[0]).toEqual([0, 0])
    expect(path.at(-1)).toEqual([100, 40])
    expect(path[2]).toEqual([50, 20])
  })
})

describe("parallax exports", () => {
  const sample = () =>
    set([
      layer(skyBands(64, 48, ["#102030", "#405060"]), { name: "sky", speed: 0, source: { kind: "sky", colors: [] } }),
      layer(striped(40, 20, 3, (x, y) => y < (x % 10)), { name: "far", speed: 0.25, y: 20 }),
      layer(striped(27, 16, 4, (x) => x % 9 === 0), { name: "near", speed: 1, y: 32 }),
    ])

  it("writes a Tiled map with image layers at their speeds", () => {
    const result = exportTiled(sample(), path.join(dir, "bg"))
    const map = JSON.parse(result.files[0]!.data as string)
    expect(map.layers.map((l: { name: string; parallaxx: number; repeatx: boolean; type: string }) => [l.name, l.type, l.parallaxx, l.repeatx])).toEqual([
      ["sky", "imagelayer", 0, true],
      ["far", "imagelayer", 0.25, true],
      ["near", "imagelayer", 1, true],
    ])
    // The origin stays at (0, 0); each offset takes back what the start view's centre moves it.
    expect(map.parallaxoriginx).toBeUndefined()
    expect(map.layers.map((l: { offsetx: number }) => l.offsetx)).toEqual([-32, -24, 0])
    // Tiled draws a layer at offset + (1 - factor) x view centre; with the camera
    // moved camX that must equal the preview's x - round(camX x speed) + camX.
    const s = sample()
    for (const camX of [0, 10, 96]) {
      for (const [i, l] of map.layers.entries()) {
        const drawn = l.offsetx + (1 - l.parallaxx) * (32 + camX) - camX
        expect(drawn).toBeCloseTo(s.layers[i]!.x - camX * s.layers[i]!.speed, 6)
      }
    }
    expect(result.files.slice(1).map((f) => path.basename(f.path))).toEqual(["bg-sky.png", "bg-far.png", "bg-near.png"])
  })

  it("writes a Godot scene of Parallax2D layers with the sprite inside its first repeat", () => {
    const climbing = set([layer(striped(40, 30, 5), { name: "clouds", speed: 0.5, speedY: 0.5, x: 50, y: -70, repeatY: true })], { climb: 60 })
    const scene = exportGodot(climbing, path.join(dir, "bg")).files[0]!.data as string
    expect(scene).toContain('[node name="clouds" type="Parallax2D" parent="."]')
    expect(scene).toContain("scroll_scale = Vector2(0.5, 0.5)")
    // The start view is at y = climb; the layer keeps what that start would move it.
    expect(scene).toContain("scroll_offset = Vector2(0, -30)")
    expect(scene).toContain("repeat_size = Vector2(40, 30)")
    // x 50 wraps to 10 in a 40 px repeat; y -70 + 60 = -10 wraps to 20 in 30.
    expect(scene).toContain("position = Vector2(10, 20)")
    expect(scene).toContain("texture_filter = 1")
  })

  it("writes an LDtk level that LDtk draws as the preview does", async () => {
    const s = sample()
    const base = path.join(dir, "bg")
    const result = exportLdtk(s, base)
    for (const file of result.files) await writeFile(file.path, file.data)
    const project = JSON.parse(result.files[0]!.data as string)
    expect(project.defs.layers.map((d: { identifier: string; parallaxFactorX: number; parallaxScaling: boolean }) => [d.identifier, d.parallaxFactorX, d.parallaxScaling])).toEqual([
      ["near", 0, false],
      ["far", 0.75, false],
      ["sky", 1, false],
    ])
    for (const camX of [0, 1, 2, 6, 7, 33, 50, 96]) {
      expect(differing(await drawLdtk(`${base}.ldtk`, s.view, camX, 0), composeParallaxFrame(s, camX, 0)), `camera ${camX}`).toBe(0)
    }
  })

  it("lands every LDtk layer's start view exactly, at any view, travel and speed", async () => {
    let n = 0
    for (const [vw, vh] of [[384, 216], [320, 180], [256, 144], [480, 270]] as Array<[number, number]>) {
      for (const travel of [160, 330, 480]) {
        for (const speed of [0, 0.1, 0.125, 0.33, 0.5, 0.75, 1, 1.3, 3]) {
          const s = set([layer(striped(vw, vh, n % 7, (x, y) => (x * 3 + y) % 11 === 0), { name: "l", speed, speedY: 1 })], { view: [vw, vh], travel })
          const base = path.join(dir, `sweep${n++}`)
          const result = exportLdtk(s, base)
          for (const file of result.files) await writeFile(file.path, file.data)
          // A layer faster than the camera may lose tiles past the level's edge; anything else loses none.
          if (speed > 1) continue
          const at = `${vw}x${vh} travel ${travel} speed ${speed}`
          expect(result.options.warnings, at).toEqual([])
          expect(differing(await drawLdtk(`${base}.ldtk`, s.view, 0, 0), composeParallaxFrame(s, 0, 0)), at).toBe(0)
          // Where no offset within a tile makes LDtk's offset a whole pixel, later
          // positions may round one pixel apart from the preview, never more.
          expect(nearestShift(await drawLdtk(`${base}.ldtk`, s.view, travel, 0), composeParallaxFrame(s, travel, 0)), at).toBeLessThanOrEqual(1)
        }
      }
    }
  })

  it("places a climbing LDtk level the same way", async () => {
    const s = set([
      layer(skyBands(64, 48 + 30, ["#102030", "#405060", "#a0b0c0"]), { name: "sky", speed: 0, speedY: 0.3, y: -30, source: { kind: "sky", colors: [] } }),
      layer(striped(30, 80, 6, (x, y) => (x + y) % 7 === 0), { name: "wall", speed: 1, speedY: 1, y: -32, repeat: false }),
    ], { travel: 0, climb: 100 })
    const base = path.join(dir, "climb")
    const result = exportLdtk(s, base)
    for (const file of result.files) await writeFile(file.path, file.data)
    // Not 5 or 15: 0.3 of them is a half pixel, and this sky's LDtk offset is not a whole
    // pixel at the start, so LDtk may round that half the other way (one pixel).
    for (const camY of [0, 1, 33, 64, 100]) {
      expect(differing(await drawLdtk(`${base}.ldtk`, s.view, 0, camY), composeParallaxFrame(s, 0, camY)), `climb ${camY}`).toBe(0)
    }
  })
})

describe("pixelkiln parallax", () => {
  it("previews and exports a manifest's set from files and sky bands", async () => {
    await writeFile(path.join(dir, "far.png"), encodeRgbaPng(40, 20, striped(40, 20, 7).pixels))
    const manifest = {
      name: "p",
      styles: { s: { palette: ["#000000", "#ffffff"], outDir: "out" } },
      assets: {},
      parallax: {
        dusk: {
          view: [64, 48],
          travel: 96,
          layers: [
            { name: "sky", sky: ["#102030", "#405060"], speed: 0 },
            { name: "far", file: "far.png", bottom: 30, speed: 0.25, extend: true },
          ],
        },
      },
    }
    const manifestPath = path.join(dir, "pixelkiln.manifest.json")
    await writeFile(manifestPath, JSON.stringify(manifest))
    await writeFile(path.join(dir, "pixelkiln.lock.json"), JSON.stringify({ version: 2, entries: {} }))
    const loaded = await loadManifest(manifestPath)
    const resolved = await resolveParallaxSet(loaded.manifest, dir, { version: 2, entries: {} } as unknown as Lock, "dusk")
    // extend: true carries the far layer's bottom row to the foot of the view.
    expect(resolved.layers[1]!.png.height).toBe(38)
    expect(resolved.layers[1]!.y).toBe(10)

    const args = ["--manifest", manifestPath, "--lock", path.join(dir, "pixelkiln.lock.json")]
    await main(["parallax", "preview", ...args])
    await main(["parallax", "export", "dusk", "--format", "godot", ...args])
    const out = path.join(dir, "parallax", "dusk")
    expect(decodePng(await readFile(path.join(out, "dusk.preview.png"))).width).toBe(64 * 3)
    expect(await readFile(path.join(out, "dusk.preview.html"), "utf8")).toContain("image-rendering: pixelated")
    expect(await readFile(path.join(out, "godot", "dusk.tscn"), "utf8")).toContain('type="Parallax2D"')
  })

  it("lays a run of silhouettes across everything the camera sees of it", async () => {
    await writeFile(path.join(dir, "cone.png"), encodeRgbaPng(30, 12, striped(30, 12, 1, (x, y) => Math.abs(x - 15) > y + 2).pixels))
    await writeFile(path.join(dir, "mesa.png"), encodeRgbaPng(40, 9, striped(40, 9, 2, (x, y) => y < 3 && (x < 6 || x > 33)).pixels))
    const manifestPath = path.join(dir, "pixelkiln.manifest.json")
    await writeFile(manifestPath, JSON.stringify({
      name: "p",
      styles: { s: { palette: ["#000000", "#ffffff"], outDir: "out" } },
      assets: {},
      parallax: {
        dusk: {
          view: [64, 48],
          travel: 96,
          layers: [
            { name: "sky", sky: ["#102030"], speed: 0 },
            { name: "hills", run: [{ file: "cone.png" }, { file: "mesa.png" }], bottom: 40, speed: 0.5, jitter: 2, repeat: false, x: -8 },
            { name: "looped", run: [{ file: "cone.png" }, { file: "mesa.png" }], bottom: 44, speed: 1 },
          ],
        },
      },
    }))
    const lockPath = path.join(dir, "pixelkiln.lock.json")
    await writeFile(lockPath, JSON.stringify({ version: 2, entries: {} }))
    const loaded = await loadManifest(manifestPath)
    const resolved = await resolveParallaxSet(loaded.manifest, dir, { version: 2, entries: {} } as unknown as Lock, "dusk")
    const [, hills, looped] = resolved.layers
    // From x = -8 to the view's width plus half the travel.
    expect(hills!.png.width).toBe(8 + 64 + 48)
    expect(hills!.y).toBe(40 + 2 - (12 + 4))
    expect(looped!.png.width).toBe(64 + 96)
    expect(resolved.warnings).toEqual([])
    // Two layers of the same sprites take different seeds from their names.
    expect(hills!.source).toMatchObject({ kind: "run" })
    expect((hills!.source as { seed: number }).seed).not.toBe((looped!.source as { seed: number }).seed)

    const args = ["--manifest", manifestPath, "--lock", lockPath]
    await main(["parallax", "export", "dusk", "--format", "tiled", ...args])
    const record = JSON.parse(await readFile(path.join(dir, "parallax", "dusk", "tiled", "dusk.pixelkiln.json"), "utf8"))
    expect(JSON.stringify(record)).toContain("layer:hills:2")
    const map = JSON.parse(await readFile(path.join(dir, "parallax", "dusk", "tiled", "dusk.tmj"), "utf8"))
    expect(map.layers.find((l: { name: string }) => l.name === "hills").repeatx).toBe(false)
    expect(map.layers.find((l: { name: string }) => l.name === "looped").repeatx).toBe(true)
  })

  it("finishes each sprite of a run before laying it, and records how", async () => {
    // A sprite with clear margins and a two-colour body.
    await writeFile(path.join(dir, "cone.png"), encodeRgbaPng(20, 16, striped(20, 16, 1, (x, y) => x < 2 || x > 17 || y < 4 || y > 13).pixels))
    const manifestPath = path.join(dir, "pixelkiln.manifest.json")
    const lockPath = path.join(dir, "pixelkiln.lock.json")
    const parallax = (palette: unknown, extra = {}) => ({
      dusk: {
        view: [64, 48],
        travel: 96,
        palette,
        layers: [{ name: "cones", run: [{ file: "cone.png" }], bottom: 40, speed: 0.5, foot: 0.25, tint: { color: "#7f4776", amount: 1 }, ...extra }],
      },
    })
    const styles = { s: { palette: ["#000000", "#7f4776", "#ffffff"], outDir: "out" }, bare: { outDir: "out" } }
    await writeFile(manifestPath, JSON.stringify({ name: "p", styles, assets: {}, parallax: parallax("s") }))
    await writeFile(lockPath, JSON.stringify({ version: 2, entries: {} }))
    const loaded = await loadManifest(manifestPath)
    const resolved = await resolveParallaxSet(loaded.manifest, dir, { version: 2, entries: {} } as unknown as Lock, "dusk")
    const cones = resolved.layers[0]!
    // Trimmed to the 16 x 10 body before it is laid; every pixel left is the tint colour.
    expect(cones.png.height).toBe(10)
    expect(cones.y).toBe(30)
    for (let p = 0; p < cones.png.width * cones.png.height; p++) {
      if (cones.png.pixels[p * 4 + 3]) expect([...cones.png.pixels.subarray(p * 4, p * 4 + 3)]).toEqual([0x7f, 0x47, 0x76])
    }
    // The bottom row of the body is thinned.
    const lastRow = Array.from({ length: cones.png.width }, (_, x) => cones.png.pixels[(9 * cones.png.width + x) * 4 + 3])
    expect(lastRow.filter((a) => a === 255).length).toBeLessThan(cones.png.width / 2)

    await main(["parallax", "export", "dusk", "--format", "tiled", "--manifest", manifestPath, "--lock", lockPath])
    const record = JSON.parse(await readFile(path.join(dir, "parallax", "dusk", "tiled", "dusk.pixelkiln.json"), "utf8"))
    expect(record.options.layers[0]).toMatchObject({ foot: 0.25, tint: { color: "#7f4776", amount: 1 } })
    expect(record.options.palette).toEqual(["#000000", "#7f4776", "#ffffff"])

    await writeFile(manifestPath, JSON.stringify({ name: "p", styles, assets: {}, parallax: parallax("bare") }))
    await expect(loadManifest(manifestPath)).rejects.toThrow(/parallax\.dusk\.palette: style "bare" has no palette/)
    await writeFile(manifestPath, JSON.stringify({ name: "p", styles, assets: {}, parallax: parallax("nope") }))
    await expect(loadManifest(manifestPath)).rejects.toThrow(/parallax\.dusk\.palette: unknown style "nope"/)
  })

  it("loops a whole picture before finishing it, and records the columns it kept", async () => {
    // Column 29 copies column 2, so the cut keeps columns 2 to 29; the last 12 columns are clear.
    const far = striped(40, 10, 5, (x) => x >= 30)
    for (let y = 0; y < 10; y++) far.pixels.copy(far.pixels, (y * 40 + 29) * 4, (y * 40 + 2) * 4, (y * 40 + 3) * 4)
    await writeFile(path.join(dir, "far.png"), encodeRgbaPng(40, 10, far.pixels))
    const manifestPath = path.join(dir, "pixelkiln.manifest.json")
    const lockPath = path.join(dir, "pixelkiln.lock.json")
    const write = (extra: object) =>
      writeFile(manifestPath, JSON.stringify({
        name: "p",
        styles: { s: { palette: ["#000000", "#936090", "#ffffff"], outDir: "out" } },
        assets: {},
        parallax: { dusk: { view: [64, 48], travel: 96, palette: "s", layers: [{ name: "far", file: "far.png", bottom: 30, speed: 0.25, ...extra }] } },
      }))
    await writeFile(lockPath, JSON.stringify({ version: 2, entries: {} }))
    const resolve = async () => resolveParallaxSet((await loadManifest(manifestPath)).manifest, dir, { version: 2, entries: {} } as unknown as Lock, "dusk")

    await write({})
    const rough = await resolve()
    expect(rough.warnings.join()).toMatch(/far: its sideways join is .* set "loop": "cut" to smooth it/)

    await write({ loop: "cut", tint: { color: "#936090", amount: 1 } })
    const looped = await resolve()
    const layer = looped.layers[0]!
    expect([layer.png.width, layer.seamRatio, looped.warnings]).toEqual([28, 0, []])
    // Tinted after the cut: every pixel the cut kept is the tint colour.
    for (let p = 0; p < 28 * 10; p++) expect([...layer.png.pixels.subarray(p * 4, p * 4 + 4)]).toEqual([0x93, 0x60, 0x90, 255])

    await main(["parallax", "export", "dusk", "--format", "tiled", "--manifest", manifestPath, "--lock", lockPath])
    const record = JSON.parse(await readFile(path.join(dir, "parallax", "dusk", "tiled", "dusk.pixelkiln.json"), "utf8"))
    expect(record.options.layers[0]).toMatchObject({ loop: { method: "cut", from: 40, columns: [2, 30] }, tint: { color: "#936090", amount: 1 } })
  })

  it("rejects a run sprite whose asset is not in the manifest", async () => {
    const manifestPath = path.join(dir, "pixelkiln.manifest.json")
    await writeFile(manifestPath, JSON.stringify({
      name: "p",
      styles: { s: { palette: ["#000000", "#ffffff"], outDir: "out" } },
      assets: {},
      parallax: { dusk: { view: [64, 48], layers: [{ run: [{ file: "a.png" }, { asset: "missing" }], speed: 0.5 }] } },
    }))
    await expect(loadManifest(manifestPath)).rejects.toThrow(/parallax\.dusk\.layers\.0\.run\.1\.asset: unknown asset "missing"/)
  })

  it("rejects a set id that is not safe for a folder or a node name", async () => {
    const manifestPath = path.join(dir, "pixelkiln.manifest.json")
    await writeFile(manifestPath, JSON.stringify({
      name: "p",
      styles: { s: { palette: ["#000000", "#ffffff"], outDir: "out" } },
      assets: {},
      parallax: { "../escape": { view: [64, 48], layers: [{ sky: ["#000000"], speed: 0 }] } },
    }))
    await expect(loadManifest(manifestPath)).rejects.toThrow(/set id/)
  })

  it("warns when a climbing backdrop runs out above the view", async () => {
    await writeFile(path.join(dir, "back.png"), encodeRgbaPng(64, 60, striped(64, 60, 2).pixels))
    const manifestPath = path.join(dir, "pixelkiln.manifest.json")
    await writeFile(manifestPath, JSON.stringify({
      name: "p",
      styles: { s: { palette: ["#000000", "#ffffff"], outDir: "out" } },
      assets: {},
      parallax: { up: { view: [64, 48], travel: 0, climb: 40, layers: [{ file: "back.png", speed: 0.5, speedY: 0.5 }] } },
    }))
    const loaded = await loadManifest(manifestPath)
    const resolved = await resolveParallaxSet(loaded.manifest, dir, { version: 2, entries: {} } as unknown as Lock, "up")
    // 60 rows ending at row 48 start at row -12; a 40 px climb at 0.5 shows 20 rows higher.
    expect(resolved.warnings.join("\n")).toMatch(/8 empty row\(s\) show above it/)
  })

  it("rejects a layer whose asset is not in the manifest", async () => {
    const manifestPath = path.join(dir, "pixelkiln.manifest.json")
    await writeFile(manifestPath, JSON.stringify({
      name: "p",
      styles: { s: { palette: ["#000000", "#ffffff"], outDir: "out" } },
      assets: {},
      parallax: { dusk: { view: [64, 48], layers: [{ asset: "missing", speed: 0.5 }] } },
    }))
    await expect(loadManifest(manifestPath)).rejects.toThrow(/parallax\.dusk\.layers\.0\.asset: unknown asset "missing"/)
  })
})
