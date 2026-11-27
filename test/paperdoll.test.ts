import { describe, expect, it } from "vitest"
import { bodyMask, buildLayerSheet, cutGraspFrames, cutLayerFrames, despeckle, extractLayer, graspSheet, isKeyColor, cutRuns, dressFrame, keySkin, layerFitProblem, layerSheetFit, neckRow, trimBase, packSheet, unionBounds, unpackSheet } from "../src/paperdoll.ts"
import { decodePng, encodeRgbaPng } from "../src/png.ts"

type Pixel = [number, number, number, number]
const CLEAR: Pixel = [0, 0, 0, 0]
const INK: Pixel = [0, 0, 0, 255]
const SKIN: Pixel = [200, 150, 110, 255]
const HAZE: Pixel = [249, 247, 248, 255]

/** Draws rows of characters: `.` clear, `#` outline, `s` skin, `w` haze, or any key of `extra`. */
const draw = (rows: string[], extra: Record<string, Pixel> = {}) => {
  const legend: Record<string, Pixel> = { ".": CLEAR, "#": INK, s: SKIN, w: HAZE, ...extra }
  const width = rows[0]!.length
  const buf = Buffer.alloc(width * rows.length * 4)
  rows.forEach((row, y) => [...row].forEach((ch, x) => Buffer.from(legend[ch]!).copy(buf, (y * width + x) * 4)))
  return encodeRgbaPng(width, rows.length, buf)
}
const pixel = (png: Buffer, x: number, y: number) => {
  const image = decodePng(png)
  return [...image.pixels.subarray((y * image.width + x) * 4, (y * image.width + x) * 4 + 4)]
}

// A 7x10 figure: a 3-wide head, a 1-wide neck on row 3 that opens into a 5-wide body.
const FIGURE = [
  "..###..",
  "..#s#..",
  "..###..",
  "...s...",
  ".##s##.",
  ".#sss#.",
  ".#sss#.",
  ".#sss#.",
  ".#sss#.",
  ".#####.",
]

describe("sheets", () => {
  it("packs frames left to right then down, and unpacks to the same bytes", () => {
    const frames = [SKIN, INK, HAZE].map((p) => draw(["ss", "ss"], { s: p }))
    const sheet = packSheet(frames, { columns: 2 })
    expect(sheet.cells).toEqual([
      { x: 0, y: 0, width: 2, height: 2 },
      { x: 2, y: 0, width: 2, height: 2 },
      { x: 0, y: 2, width: 2, height: 2 },
    ])
    expect(pixel(sheet.png, 2, 0)).toEqual(INK)
    expect(pixel(sheet.png, 3, 3)).toEqual(CLEAR)
    expect(unpackSheet(sheet.png, sheet.cells).map((f) => decodePng(f).pixels)).toEqual(frames.map((f) => decodePng(f).pixels))
  })

  it("cuts frames of different canvases to one cell", () => {
    const small = draw([".s.", ".s."])
    const large = draw([".....", "..s..", "..s..", "....."])
    const sheet = packSheet([small, large], {
      columns: 2,
      crop: [{ x: 1, y: 0, width: 1, height: 2 }, { x: 2, y: 1, width: 1, height: 2 }],
    })
    expect(decodePng(sheet.png)).toMatchObject({ width: 2, height: 2 })
    expect(pixel(sheet.png, 1, 1)).toEqual(SKIN)
  })

  it("refuses a crop that does not fit and frames cut to different sizes", () => {
    const frame = draw(["ss", "ss"])
    expect(() => packSheet([frame], { columns: 1, crop: { x: 1, y: 0, width: 2, height: 2 } })).toThrow(/does not fit/)
    expect(() => packSheet([frame, draw(["sss"])], { columns: 2 })).toThrow(/cut to 3x1/)
  })

  it("finds the box that holds every frame's opaque pixels", () => {
    expect(unionBounds([draw(["....", ".s..", "...."]), draw(["....", "....", "..s."])])).toEqual({ x: 1, y: 1, width: 2, height: 2 })
  })
})

describe("keySkin", () => {
  it("keys every non-outline pixel of a bare base and keeps its brightness", () => {
    const keyed = keySkin(draw(["#s."]))
    expect(pixel(keyed, 0, 0)).toEqual(INK)
    expect(pixel(keyed, 1, 0)).toEqual([30, 200, 200, 255])
    expect(pixel(keyed, 2, 0)).toEqual(CLEAR)
    expect(isKeyColor(30, 200, 200)).toBe(true)
  })

  it("keys only the named skin colours when given them", () => {
    const keyed = keySkin(draw(["sc"], { c: [60, 90, 200, 255] }), { skin: ["#c8966e"] })
    expect(pixel(keyed, 0, 0)).toEqual([30, 200, 200, 255])
    expect(pixel(keyed, 1, 0)).toEqual([60, 90, 200, 255])
  })

  it("reads shades of the key as key, and leather or steel as not", () => {
    expect(isKeyColor(40, 170, 190)).toBe(true)
    expect(isKeyColor(20, 90, 95)).toBe(true)
    expect(isKeyColor(90, 60, 40)).toBe(false)
    expect(isKeyColor(150, 170, 175)).toBe(false)
  })

  it("reads skin in deep shadow as key, and dark teal cloth as cloth", () => {
    expect(isKeyColor(8, 55, 55)).toBe(true)
    expect(isKeyColor(38, 55, 55)).toBe(false)
  })
})

describe("bodyMask", () => {
  it("finds the neck and whitens only the opaque pixels below it", () => {
    const figure = draw(FIGURE)
    expect(neckRow(decodePng(figure))).toBe(3)
    const mask = bodyMask(figure)
    expect(pixel(mask, 3, 1)).toEqual([0, 0, 0, 255])
    expect(pixel(mask, 3, 3)).toEqual([0, 0, 0, 255])
    expect(pixel(mask, 3, 6)).toEqual([255, 255, 255, 255])
    expect(pixel(mask, 0, 6)).toEqual([0, 0, 0, 255])
  })

  it("masks each cell from its own neck and leaves an empty cell black", () => {
    const sheet = packSheet([draw(FIGURE), draw(FIGURE.map(() => "......."))], { columns: 2 })
    const white = (png: Buffer) => decodePng(png).pixels.filter((v, i) => i % 4 === 0 && v === 255).length
    expect(white(bodyMask(sheet.png, sheet.cells))).toBe(white(bodyMask(draw(FIGURE))))
  })
})

describe("extractLayer", () => {
  it("keeps repainted pixels and drops key skin, unchanged pixels, and anything outside the mask", () => {
    const LEATHER: Pixel = [90, 60, 40, 255]
    const KEY: Pixel = [30, 200, 200, 255]
    const legend = { k: KEY, l: LEATHER }
    const keyed = draw(["kkkk"], legend)
    const mask = draw(["#ooo"], { o: [255, 255, 255, 255] })
    //                  outside mask ─┐┌─ repainted  ┌─ still skin (a shade of key)  ┌─ erased
    const result = draw(["llx."], { ...legend, x: [40, 170, 190, 255] })
    const layer = extractLayer(result, keyed, mask)
    expect(pixel(layer, 0, 0)).toEqual(CLEAR)
    expect(pixel(layer, 1, 0)).toEqual(LEATHER)
    expect(pixel(layer, 2, 0)).toEqual(CLEAR)
    expect(pixel(layer, 3, 0)).toEqual(CLEAR)
  })

  it("drops a masked outline pixel the provider left exactly as it was", () => {
    const white = draw(["o"], { o: [255, 255, 255, 255] })
    expect(pixel(extractLayer(draw(["#"]), draw(["#"]), white), 0, 0)).toEqual(CLEAR)
  })

  it("refuses a mask of another size", () => {
    expect(() => extractLayer(draw(["ss"]), draw(["ss"]), draw(["s"]))).toThrow(/mask is 1x1/)
  })
})

describe("despeckle", () => {
  const reference = [draw(FIGURE)]

  it("removes a haze sliver beside the head and the outline that framed it", () => {
    const ghosted = draw([
      "..###w.",
      "..#s#w#",
      "..###w.",
      "...s...",
      ".##s##.",
      ".#sss#.",
      ".#sss#.",
      ".#sss#.",
      ".#sss#.",
      ".#####.",
    ])
    const cleaned = despeckle(ghosted, { reference })
    expect(cleaned.removed).toBe(4)
    expect(decodePng(cleaned.png).pixels).toEqual(decodePng(draw(FIGURE)).pixels)
  })

  it("peels foreign colours off the body's own edge", () => {
    const fringed = draw(FIGURE.map((row, y) => (y === 6 ? "w#sss#." : row)).map((row, y) => (y === 6 ? ".wsss#." : row)))
    const cleaned = despeckle(fringed, { reference })
    expect(pixel(cleaned.png, 1, 6)).toEqual(CLEAR)
    expect(pixel(cleaned.png, 2, 6)).toEqual(SKIN)
  })

  it("leaves a clean figure alone", () => {
    expect(despeckle(draw(FIGURE), { reference }).removed).toBe(0)
  })

  it("keeps a thin detached part in the body's own colours, and drops it in a ghost's", () => {
    const finger = ["sss#sss", "sss#...", "sss#..."]
    expect(despeckle(draw(finger), { reference }).removed).toBe(0)
    const ghost = despeckle(draw(finger.map((row, y) => (y === 0 ? "sss#www" : row))), { reference })
    expect(pixel(ghost.png, 5, 0)).toEqual(CLEAR)
    expect(pixel(ghost.png, 3, 0)).toEqual(INK)
  })

  it("keeps an eye sealed inside the head and drops a sealed ghost beside it", () => {
    const EYE: Pixel = [200, 198, 187, 255]
    const head = [
      "#######...",
      "#sssss#...",
      "#s###s###.",
      "#s#e#s#e#.",
      "#s###s###.",
      "#sssss#...",
      "#######...",
    ]
    const still = draw(head.map((row) => row.slice(0, 7) + "..."), { e: EYE })
    // One eye pixel is a large share of a fixture this small, so raise the bar a real sprite clears easily.
    const cleaned = despeckle(draw(head, { e: EYE }), { reference: [still], minShare: 0.1 })
    expect(pixel(cleaned.png, 3, 3)).toEqual(EYE)
    expect(pixel(cleaned.png, 7, 3)).toEqual(CLEAR)
    expect(pixel(cleaned.png, 8, 3)).toEqual(CLEAR)
    expect(pixel(cleaned.png, 6, 3)).toEqual(INK)
  })

  it("leaves thick outline alone when nothing beside it was debris", () => {
    const thick = ["#####", "#####", "##s##", "#sss#", "##s##", "#####"]
    expect(despeckle(draw(thick), { reference: [draw(thick)] }).removed).toBe(0)
  })
})

describe("layer sheets", () => {
  const LEATHER: Pixel = [90, 60, 40, 255]
  // The figure alone on its 7x10 canvas, and the same figure centred on a padded 11x14 one.
  const still = draw(FIGURE)
  const padded = draw(["...........", "...........", ...FIGURE.map((row) => `..${row}..`), "...........", "..........."])
  const sources = [
    { assetId: "hero", role: "south", png: still },
    { assetId: "hero.walk", role: "frame-00", png: padded },
    { assetId: "hero.walk", role: "frame-01", png: padded },
  ]
  const paint = (keyed: Buffer, mask: Buffer) => {
    const image = decodePng(keyed)
    const allowed = decodePng(mask)
    const out = Buffer.from(image.pixels)
    for (let i = 0; i < out.length; i += 4) if (allowed.pixels[i] === 255) Buffer.from(LEATHER).copy(out, i)
    return encodeRgbaPng(image.width, image.height, out)
  }

  it("centres frames of different canvases on one cell and remembers where each came from", () => {
    const built = buildLayerSheet(sources, { maxSide: 512, minSide: 1 })
    expect(built.frames.map((frame) => frame.cell.width)).toEqual([5, 5, 5])
    expect(built.frames.map((frame) => [frame.width, frame.height, frame.offsetX, frame.offsetY])).toEqual([
      [7, 10, 1, 0],
      [11, 14, 3, 2],
      [11, 14, 3, 2],
    ])
    const cells = unpackSheet(built.sheet, built.frames.map((frame) => frame.cell))
    expect(decodePng(cells[0]!).pixels).toEqual(decodePng(cells[1]!).pixels)
  })

  it("returns each layer on its source frame's own canvas", () => {
    const built = buildLayerSheet(sources, { maxSide: 512, minSide: 1 })
    const layers = cutLayerFrames(paint(built.keyed, built.mask), built)
    expect(decodePng(layers[0]!)).toMatchObject({ width: 7, height: 10 })
    expect(decodePng(layers[1]!)).toMatchObject({ width: 11, height: 14 })
    // The body's top-left outline pixel: (1,4) on the still, (3,6) on the padded frame.
    expect(pixel(layers[0]!, 1, 4)).toEqual(LEATHER)
    expect(pixel(layers[1]!, 3, 6)).toEqual(LEATHER)
    expect(pixel(layers[0]!, 3, 1)).toEqual(CLEAR)
    expect(pixel(layers[1]!, 0, 0)).toEqual(CLEAR)
  })

  it("picks the smallest sheet that fits, pads up to the provider's floor, and says when nothing fits", () => {
    const eight = Array.from({ length: 8 }, (_, index) => ({ assetId: "hero", role: String(index), png: still }))
    const built = buildLayerSheet(eight, { maxSide: 20, minSide: 1 })
    expect(decodePng(built.sheet)).toMatchObject({ width: 20, height: 20 })
    expect(decodePng(buildLayerSheet([sources[0]!], { maxSide: 512 }).sheet)).toMatchObject({ width: 32, height: 32 })
    expect(() => buildLayerSheet(eight, { maxSide: 12, minSide: 1 })).toThrow(/8 frames of 5x10 do not fit one 12px sheet/)
    // Columns that would make a 40x10 sheet give way to the count that fits.
    const narrowed = buildLayerSheet(eight, { maxSide: 20, minSide: 1, columns: 8 })
    expect(narrowed.fit).toMatchObject({ columns: 4, requestedColumns: 8, maxFrames: 8, across: 4, down: 2 })
    expect(decodePng(narrowed.sheet)).toMatchObject({ width: 20, height: 20 })
  })

  it("measures the fit without building a sheet, and names the most frames one holds", () => {
    const nine = Array.from({ length: 9 }, (_, index) => ({ assetId: "hero", role: String(index), png: still }))
    expect(layerSheetFit(nine.slice(0, 8), { maxSide: 20 })).toMatchObject({ frames: 8, cellWidth: 5, cellHeight: 10, columns: 4, maxFrames: 8 })
    const over = layerSheetFit(nine, { maxSide: 20 })
    expect(over).toMatchObject({ frames: 9, columns: null, maxFrames: 8 })
    expect(layerFitProblem(over)).toBe("9 frames of 5x10 do not fit one 20px sheet; at most 8 fit (4 across, 2 down)")
    expect(() => buildLayerSheet(nine, { maxSide: 20, minSide: 1 })).toThrow(/9 frames of 5x10 do not fit one 20px sheet; at most 8 fit/)
  })

  it("cleans loop frames against the stills and leaves the stills alone", () => {
    const ghosted = draw(FIGURE.map((row, y) => (y === 1 ? "..#s#w." : row)))
    const built = buildLayerSheet(
      [{ assetId: "hero", role: "south", png: still }, { assetId: "hero.walk", role: "frame-00", png: ghosted }],
      { maxSide: 512, minSide: 1, reference: [still] },
    )
    expect(built.cleaned).toBe(1)
    const cells = unpackSheet(built.sheet, built.frames.map((frame) => frame.cell))
    expect(decodePng(cells[1]!).pixels).toEqual(decodePng(cells[0]!).pixels)
  })

  it("takes a supplied mask of the sheet's size and refuses any other", () => {
    const built = buildLayerSheet(sources, { maxSide: 512, minSide: 1 })
    expect(buildLayerSheet(sources, { maxSide: 512, minSide: 1, mask: built.mask }).mask.equals(built.mask)).toBe(true)
    expect(() => buildLayerSheet(sources, { maxSide: 512, minSide: 1, mask: draw(["#"]) })).toThrow(/the mask is 1x1; this layer's sheet is 15x10/)
  })

  it("masks the head with the space above it, or everything below the neck with the space beside it", () => {
    const figure = draw(FIGURE)
    const head = bodyMask(figure, undefined, "head")
    expect(pixel(head, 0, 0)).toEqual([255, 255, 255, 255])
    expect(pixel(head, 3, 3)).toEqual([255, 255, 255, 255])
    expect(pixel(head, 3, 4)).toEqual([0, 0, 0, 255])
    const around = bodyMask(figure, undefined, "around")
    expect(pixel(around, 0, 6)).toEqual([255, 255, 255, 255])
    expect(pixel(around, 3, 1)).toEqual([0, 0, 0, 255])
  })

  it("keeps a limb the model shaded in strange colours, while still clearing a small sealed ghost", () => {
    const MAROON: Pixel = [143, 54, 53, 255]
    const W = 32, H = 30
    const paint = (rects: Array<[number, number, number, number, Pixel]>) => {
      const buf = Buffer.alloc(W * H * 4)
      for (const [x0, y0, x1, y1, colour] of rects) {
        for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) Buffer.from(colour).copy(buf, (y * W + x) * 4)
      }
      return encodeRgbaPng(W, H, buf)
    }
    // A 20x24 body in its outline. The still is only that.
    const body: Array<[number, number, number, number, Pixel]> = [[1, 1, 22, 26, INK], [2, 2, 21, 25, SKIN]]
    const still = paint(body)
    // The frame adds, each sealed in its own outline beside the body: a 5x7 leg and a 3x3 ghost, both maroon.
    const frame = paint([...body, [23, 4, 29, 12, INK], [24, 5, 28, 11, MAROON], [23, 15, 27, 19, INK], [24, 16, 26, 18, MAROON]])
    const cleaned = despeckle(frame, { reference: [still] })
    expect(pixel(cleaned.png, 26, 8)).toEqual(MAROON)   // 35 pixels: more than a ghost gets, so a limb
    expect(pixel(cleaned.png, 25, 17)).toEqual(CLEAR)   // 9 pixels: a ghost
    expect(pixel(cleaned.png, 10, 10)).toEqual(SKIN)
  })

  it("keys skin only where the provider may paint, so a head under an outfit's mask keeps its face", () => {
    const built = buildLayerSheet([sources[0]!], { maxSide: 512, minSide: 1 })
    const sheet = decodePng(built.sheet)
    const keyed = decodePng(built.keyed)
    const mask = decodePng(built.mask)
    let keyedInside = 0, keptOutside = 0, skinOutside = 0
    for (let i = 0; i < sheet.pixels.length; i += 4) {
      if (sheet.pixels[i + 3] === 0) continue
      const same = sheet.pixels.compare(keyed.pixels, i, i + 4, i, i + 4) === 0
      const skin = Math.max(sheet.pixels[i]!, sheet.pixels[i + 1]!, sheet.pixels[i + 2]!) >= 46
      if (mask.pixels[i] === 255) {
        if (skin && !same && isKeyColor(keyed.pixels[i]!, keyed.pixels[i + 1]!, keyed.pixels[i + 2]!)) keyedInside++
      } else {
        if (skin) skinOutside++
        if (same) keptOutside++
        else throw new Error("a pixel outside the mask was keyed")
      }
    }
    expect(keyedInside).toBeGreaterThan(0)
    expect(skinOutside).toBeGreaterThan(0)
    expect(keptOutside).toBeGreaterThan(0)
    // A head layer flips it: the body is outside the mask and keeps its colours.
    const head = buildLayerSheet([sources[0]!], { maxSide: 512, minSide: 1, region: "head" })
    const bottom = (decodePng(head.sheet).height - 2) * decodePng(head.sheet).width * 4
    expect(decodePng(head.keyed).pixels.subarray(bottom, bottom + decodePng(head.sheet).width * 4).equals(decodePng(head.sheet).pixels.subarray(bottom, bottom + decodePng(head.sheet).width * 4))).toBe(true)
  })

  it("pads every cell and returns each layer on a canvas grown by the padding", () => {
    const built = buildLayerSheet([sources[0]!], { maxSide: 512, minSide: 1, padding: 3, region: "head" })
    expect(built.frames[0]).toMatchObject({ padding: 3, offsetX: -2, offsetY: -3, cell: { width: 11, height: 16 } })
    // A hat: a solid block in the padding above the head, which the source canvas has no room for.
    const result = decodePng(built.keyed)
    for (let y = 0; y < 3; y++) for (let x = 2; x < 9; x++) Buffer.from(LEATHER).copy(result.pixels, (y * result.width + x) * 4)
    const [layer] = cutLayerFrames(encodeRgbaPng(result.width, result.height, result.pixels), built, { region: "head" })
    expect(decodePng(layer!)).toMatchObject({ width: 13, height: 16 })
    // Sheet (3,0) is frame (1,-3), which is (4,0) on the canvas grown by 3.
    expect(pixel(layer!, 4, 0)).toEqual(LEATHER)
    expect(pixel(layer!, 2, 0)).toEqual(CLEAR)
  })

  it("tidies a layer: outline scribbles, stray specks and dark blots go, the item stays", () => {
    const INK4: Pixel = [0, 0, 0, 255]
    const cell = { x: 0, y: 0, width: 12, height: 8 }
    const keyed = draw(Array.from({ length: 8 }, () => "............"))
    const mask = draw(Array.from({ length: 8 }, () => "oooooooooooo"), { o: [255, 255, 255, 255] })
    const result = draw([
      "............",
      ".####.....#.",   // the item's outline, and a lone scribble pixel
      ".#ll#.....#.",
      ".#ll#.......",
      ".####..##...",   // a 2x2 dark blot with no colour in it
      ".......##...",
      "...l........",   // a stray coloured speck
      ".......lllll",   // a small piece at the cell's edge
    ], { l: LEATHER, "#": INK4 })
    const frames = [{ assetId: "a", width: 12, height: 8, offsetX: 0, offsetY: 0, cell }]
    const [tidy] = cutLayerFrames(result, { keyed, mask, frames }, { region: "around" })
    expect(pixel(tidy!, 2, 2)).toEqual(LEATHER)
    expect(pixel(tidy!, 1, 1)).toEqual(INK4)
    expect(pixel(tidy!, 10, 1)).toEqual(CLEAR)
    expect(pixel(tidy!, 7, 4)).toEqual(CLEAR)
    expect(pixel(tidy!, 3, 6)).toEqual(CLEAR)
    expect(pixel(tidy!, 9, 7)).toEqual(CLEAR)
    // A clothing layer loses the same scribbles, which is what removes the
    // outline of the limbs a partial outfit leaves bare, but its cells are
    // cropped to the figure, so a small piece at the edge is a cuff, not bleed.
    const [body] = cutLayerFrames(result, { keyed, mask, frames })
    expect(pixel(body!, 10, 1)).toEqual(CLEAR)
    expect(pixel(body!, 7, 4)).toEqual(CLEAR)
    expect(pixel(body!, 3, 6)).toEqual(CLEAR)
    expect(pixel(body!, 9, 7)).toEqual(LEATHER)
    expect(pixel(body!, 2, 2)).toEqual(LEATHER)
  })

  it("cuts a grip pass: fingers over the handle in skin, the body's own skin left out, the blade untouched", () => {
    const SKIN_DARK: Pixel = [150, 100, 80, 255]
    const SKIN_LIGHT: Pixel = [230, 180, 150, 255]
    const STEEL: Pixel = [180, 190, 200, 255]
    const INK4: Pixel = [0, 0, 0, 255]
    const LEATHER: Pixel = [90, 60, 40, 255]
    // One 6x8 cell: a body column on the left, an item column at x=4 running the cell's height.
    const sheet = draw([
      "......", "d.....", "l.....", "d.....", "l.....", "d.....", "l.....", "......",
    ], { d: SKIN_DARK, l: SKIN_LIGHT })
    const keyed = keySkin(sheet)
    const cell = { x: 0, y: 0, width: 6, height: 8 }
    const frames = [{ assetId: "a", width: 6, height: 8, offsetX: 0, offsetY: 0, cell }]
    const placed = draw(Array.from({ length: 8 }, () => "....s."), { s: STEEL })
    const sent = graspSheet({ keyed, frames }, [placed], [{ x: 4, y: 4 }], 2)
    // The item is on the sheet, and only the disc at the hand is open.
    expect(pixel(sent.keyed, 4, 0)).toEqual(STEEL)
    expect(pixel(sent.mask, 4, 4)).toEqual([255, 255, 255, 255])
    expect(pixel(sent.mask, 4, 1)).toEqual([0, 0, 0, 255])
    expect(pixel(sent.mask, 0, 4)).toEqual([0, 0, 0, 255])

    // What comes back: a bright cyan finger across the handle at (4,4), cyan
    // beside the item at (3,4) (the hand itself), a lone dark pixel at (2,4),
    // and the handle redrawn in leather at (4,5) with its outline at (5,5).
    const cyan = (value: number): Pixel => [Math.floor(value * 0.15), value, value, 255]
    const result = decodePng(sent.keyed)
    const put = (x: number, y: number, colour: Pixel) => Buffer.from(colour).copy(result.pixels, (y * result.width + x) * 4)
    put(4, 4, cyan(228))
    put(3, 4, cyan(150))
    put(2, 4, INK4)
    put(4, 5, LEATHER)
    put(5, 5, INK4)
    const [layer] = cutGraspFrames(encodeRgbaPng(result.width, result.height, result.pixels), { sheet, keyed, mask: sent.mask, frames }, [placed])
    expect(pixel(layer!, 4, 4)).toEqual(SKIN_LIGHT)   // a finger, in the figure's own nearest skin colour
    expect(pixel(layer!, 3, 4)).toEqual(CLEAR)        // the hand beside the item is the frame's, not the layer's
    expect(pixel(layer!, 2, 4)).toEqual(CLEAR)        // dark with nothing kept beside it
    expect(pixel(layer!, 4, 5)).toEqual(LEATHER)      // the handle as redrawn
    expect(pixel(layer!, 5, 5)).toEqual(INK4)         // its outline
    expect(pixel(layer!, 4, 0)).toEqual(STEEL)        // outside the disc: the placed sprite
    expect(pixel(layer!, 4, 3)).toEqual(STEEL)        // in the disc and returned unchanged
  })
})

describe("trimming the base under a layer", () => {
  const SKIN = [220, 170, 140, 255]
  const CLOTH = [40, 70, 160, 255]
  /** A 20x30 figure: a head, a two-pixel neck, a 12-wide body from row 8, and a 6-wide hand hanging off the right at rows 18-27 (60 pixels). */
  function figure() {
    const pixels = Buffer.alloc(20 * 30 * 4)
    const put = (x: number, y: number, colour: number[]) => Buffer.from(colour).copy(pixels, (y * 20 + x) * 4)
    for (let y = 0; y < 6; y++) for (let x = 7; x < 13; x++) put(x, y, SKIN)
    for (let y = 6; y < 8; y++) for (let x = 9; x < 11; x++) put(x, y, SKIN)
    for (let y = 8; y < 30; y++) for (let x = 2; x < 14; x++) put(x, y, SKIN)
    for (let y = 18; y < 28; y++) for (let x = 14; x < 20; x++) put(x, y, SKIN)
    return encodeRgbaPng(20, 30, pixels)
  }
  /** Clothes over the body one pixel short on the left, and with a 2x2 gap at its right shoulder. */
  function shirt(padding = 0) {
    const w = 20 + padding * 2
    const h = 30 + padding * 2
    const pixels = Buffer.alloc(w * h * 4)
    for (let y = 8; y < 30; y++) {
      for (let x = 3; x < 14; x++) {
        if (y < 10 && x >= 12) continue
        Buffer.from(CLOTH).copy(pixels, ((y + padding) * w + x + padding) * 4)
      }
    }
    return encodeRgbaPng(w, h, pixels)
  }

  it("hides the bare strip beside the clothes and the island at the shoulder, and keeps the hand and the head", () => {
    const cut = trimBase(figure(), [shirt()])
    // The left column of the body, rows 8-29: a one-pixel run with air on one side and cloth on the other.
    for (let y = 8; y < 30; y++) expect(cut.mask[y * 20 + 2]).toBe(1)
    // The 2x2 shoulder gap is a run of two too, and the hand (six wide) is not touched.
    expect(cut.mask[8 * 20 + 12]).toBe(1)
    expect(cut.mask[22 * 20 + 16]).toBe(0)
    expect(cut.mask[2 * 20 + 8]).toBe(0)
    expect(cut.mask[7 * 20 + 9]).toBe(0)
    expect(cut.pixels).toBe(22 + 4)
    expect(cutRuns(cut).slice(0, 2)).toEqual([[2, 8, 1], [12, 8, 2]])
  })

  it("leaves a run wider than the limit, and lines a padded layer up by its centre", () => {
    expect(trimBase(figure(), [shirt()], { run: 0, island: 0 }).pixels).toBe(0)
    expect(trimBase(figure(), [shirt(4)]).pixels).toBe(22 + 4)
  })

  it("composes the base, cut, under its layers on the largest canvas", () => {
    const base = figure()
    const layer = shirt(4)
    const cut = trimBase(base, [layer])
    const dressed = decodePng(dressFrame(base, [layer], cut))
    expect(dressed).toMatchObject({ width: 28, height: 38 })
    const pixel = (x: number, y: number) => [...dressed.pixels.subarray((y * 28 + x) * 4, (y * 28 + x) * 4 + 4)]
    expect(pixel(2 + 4, 15 + 4)).toEqual([0, 0, 0, 0])
    expect(pixel(5 + 4, 15 + 4)).toEqual(CLOTH)
    expect(pixel(16 + 4, 22 + 4)).toEqual(SKIN)
    expect(pixel(8 + 4, 2 + 4)).toEqual(SKIN)
  })
})
