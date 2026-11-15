import { decodePng, encodeRgbaPng, parseHex, type DecodedPng } from "./png.ts"

/**
 * Local image steps for paperdoll layers: dressing a bare character by
 * inpainting every frame of it on one sheet, then cutting the clothes back
 * out as a layer that sits over the untouched body.
 *
 *   frames ─ despeckle ─ packSheet ─┬─ keySkin ──── (provider inpaint) ─┐
 *                                   └─ bodyMask ──────────┘             │
 *                                   keyed + mask + result ─ extractLayer ┴─ unpackSheet
 *
 * Nothing here talks to a provider, and every function is a pure function of
 * its input bytes and parameters. `buildLayerSheet` and `cutLayerFrames` are
 * the two halves a `layer` asset runs either side of the provider's inpaint.
 *
 * Why the skin is keyed: a provider asked to "keep the skin" returns skin
 * tones that overlap leather, hair and wood, so the body cannot be told from
 * the outfit afterwards. Painting the skin a colour no outfit uses first
 * means it comes back as that colour, and dropping it is a hue test.
 */

/** One frame's place on a sheet, in sheet pixels. */
export interface SheetCell {
  x: number
  y: number
  width: number
  height: number
}

export interface Sheet {
  png: Buffer
  /** One per input frame, in input order: left to right, then top to bottom. */
  cells: SheetCell[]
}

const at = (image: DecodedPng, x: number, y: number) => (y * image.width + x) * 4
const opaque = (image: DecodedPng, x: number, y: number) => image.pixels[at(image, x, y) + 3]! > 0
const inside = (cell: SheetCell, x: number, y: number) =>
  x >= cell.x && x < cell.x + cell.width && y >= cell.y && y < cell.y + cell.height
const STEPS = [[1, 0], [-1, 0], [0, 1], [0, -1]] as const

function whole(image: DecodedPng): SheetCell {
  return { x: 0, y: 0, width: image.width, height: image.height }
}

function hsv(r: number, g: number, b: number): { h: number; s: number; v: number } {
  const max = Math.max(r, g, b)
  const min = Math.min(r, g, b)
  const delta = max - min
  let h = 0
  if (delta > 0) {
    if (max === r) h = ((g - b) / delta) % 6
    else if (max === g) h = (b - r) / delta + 2
    else h = (r - g) / delta + 4
    h *= 60
    if (h < 0) h += 360
  }
  return { h, s: max === 0 ? 0 : delta / max, v: max / 255 }
}

/**
 * The smallest box holding every opaque pixel of every frame, so a set of
 * frames on a padded canvas can share one tight cell. Frames must be one size.
 */
export function unionBounds(frames: Buffer[]): SheetCell {
  let left = Infinity
  let top = Infinity
  let right = -1
  let bottom = -1
  let size: DecodedPng | undefined
  for (const [index, frame] of frames.entries()) {
    const image = decodePng(frame)
    size ??= image
    if (image.width !== size.width || image.height !== size.height) {
      throw new Error(`frame ${index} is ${image.width}x${image.height}; frame 0 is ${size.width}x${size.height}`)
    }
    for (let y = 0; y < image.height; y++) {
      for (let x = 0; x < image.width; x++) {
        if (!opaque(image, x, y)) continue
        if (x < left) left = x
        if (x > right) right = x
        if (y < top) top = y
        if (y > bottom) bottom = y
      }
    }
  }
  if (right < 0) throw new Error("every frame is fully transparent")
  return { x: left, y: top, width: right - left + 1, height: bottom - top + 1 }
}

/**
 * Lays frames on one sheet, `columns` across, each cut to `crop` first (the
 * same box of every frame; the whole frame when omitted). Frames may differ in
 * size as long as `crop` fits inside each, which is how a 64px still and a
 * 96px animation frame of it share a sheet.
 */
export function packSheet(frames: Buffer[], options: { columns: number; crop?: SheetCell | SheetCell[] }): Sheet {
  if (!frames.length) throw new Error("a sheet needs at least one frame")
  const { columns } = options
  if (!Number.isInteger(columns) || columns < 1) throw new Error("columns must be a positive integer")
  const decoded = frames.map((frame) => decodePng(frame))
  const crops = decoded.map((image, index) =>
    Array.isArray(options.crop) ? options.crop[index] ?? whole(image) : options.crop ?? whole(image))
  const { width, height } = crops[0]!
  for (const [index, crop] of crops.entries()) {
    const image = decoded[index]!
    if (crop.width !== width || crop.height !== height) {
      throw new Error(`frame ${index} is cut to ${crop.width}x${crop.height}; frame 0 is cut to ${width}x${height}`)
    }
    if (crop.x < 0 || crop.y < 0 || crop.x + crop.width > image.width || crop.y + crop.height > image.height) {
      throw new Error(`frame ${index} is ${image.width}x${image.height}; the crop does not fit inside it`)
    }
  }
  const rows = Math.ceil(frames.length / columns)
  const sheet: DecodedPng = { width: columns * width, height: rows * height, pixels: Buffer.alloc(columns * width * rows * height * 4) }
  const cells = decoded.map((image, index) => {
    const crop = crops[index]!
    const cell = { x: (index % columns) * width, y: Math.floor(index / columns) * height, width, height }
    for (let y = 0; y < height; y++) {
      const from = at(image, crop.x, crop.y + y)
      image.pixels.copy(sheet.pixels, at(sheet, cell.x, cell.y + y), from, from + width * 4)
    }
    return cell
  })
  return { png: encodeRgbaPng(sheet.width, sheet.height, sheet.pixels), cells }
}

/** Cuts a sheet back into one PNG per cell. */
export function unpackSheet(sheet: Buffer, cells: SheetCell[]): Buffer[] {
  const image = decodePng(sheet)
  return cells.map((cell, index) => {
    if (cell.x < 0 || cell.y < 0 || cell.x + cell.width > image.width || cell.y + cell.height > image.height) {
      throw new Error(`cell ${index} does not fit inside the ${image.width}x${image.height} sheet`)
    }
    const out = Buffer.alloc(cell.width * cell.height * 4)
    for (let y = 0; y < cell.height; y++) {
      const from = at(image, cell.x, cell.y + y)
      image.pixels.copy(out, y * cell.width * 4, from, from + cell.width * 4)
    }
    return encodeRgbaPng(cell.width, cell.height, out)
  })
}

export interface KeyOptions {
  /** The stand-in colour. Default cyan, which almost no outfit uses. */
  key?: string
  /**
   * The colours that are skin. Omit on a bare base, where every pixel that is
   * not outline is skin.
   */
  skin?: string[]
  /** How far (RGB distance) a pixel may sit from a `skin` colour and still count. Default 0, exact. */
  tolerance?: number
  /** A pixel whose brightest channel is below this is outline and is left alone. Default 46. */
  outlineBelow?: number
}

const DEFAULT_KEY = "#00ffff"
/** How much of the key's own hue a keyed pixel keeps; the rest carries the source's shading. */
const KEY_SATURATION = 0.85

/**
 * Repaints skin in the key colour, keeping each pixel's brightness so the
 * body's shading survives for the provider to read as form.
 */
export function keySkin(png: Buffer, options: KeyOptions = {}): Buffer {
  const image = decodePng(png)
  const key = parseHex(options.key ?? DEFAULT_KEY)
  const skin = options.skin?.map((hex) => parseHex(hex))
  const reach = (options.tolerance ?? 0) ** 2
  const outlineBelow = options.outlineBelow ?? 46
  const out = Buffer.from(image.pixels)
  for (let i = 0; i < out.length; i += 4) {
    if (out[i + 3] === 0) continue
    const r = out[i]!
    const g = out[i + 1]!
    const b = out[i + 2]!
    const brightest = Math.max(r, g, b)
    if (skin) {
      if (!skin.some((c) => (c.r - r) ** 2 + (c.g - g) ** 2 + (c.b - b) ** 2 <= reach)) continue
    } else if (brightest < outlineBelow) continue
    const tint = (channel: number) => Math.floor(brightest * (1 - KEY_SATURATION + (KEY_SATURATION * channel) / 255))
    out[i] = tint(key.r)
    out[i + 1] = tint(key.g)
    out[i + 2] = tint(key.b)
  }
  return encodeRgbaPng(image.width, image.height, out)
}

/**
 * Whether a returned pixel still reads as keyed skin. A provider does not hand
 * back the flat key: it returns shades of it, so this is a hue window, not an
 * exact match.
 */
export function isKeyColor(r: number, g: number, b: number, key = DEFAULT_KEY): boolean {
  const target = parseHex(key)
  const want = hsv(target.r, target.g, target.b).h
  const { h, s, v } = hsv(r, g, b)
  const apart = Math.abs(h - want)
  if (Math.min(apart, 360 - apart) > 20) return false
  // Skin in shadow comes back dark but still strongly keyed; a dark outfit
  // colour that merely leans the key's way (teal trousers) is far less
  // saturated, and stays.
  return (s >= 0.45 && v >= 0.35) || (s >= 0.6 && v >= 0.1)
}

/**
 * The row where a figure's neck is: the narrowest row between 19% and 42% of
 * the way down its opaque bounds, the lower one on a tie.
 *
 * A heuristic for a bald base with its arms below the shoulders. Hair wider
 * than the head, or a raised arm beside it, puts the narrowest row somewhere
 * else, and that frame wants a hand-painted mask instead.
 */
export function neckRow(image: DecodedPng, cell: SheetCell = whole(image)): number | null {
  let top = -1
  let bottom = -1
  const widths: number[] = []
  for (let y = 0; y < cell.height; y++) {
    let width = 0
    for (let x = 0; x < cell.width; x++) if (opaque(image, cell.x + x, cell.y + y)) width++
    widths.push(width)
    if (width > 0) {
      if (top < 0) top = y
      bottom = y
    }
  }
  if (top < 0) return null
  const height = bottom - top + 1
  let best: number | null = null
  for (let y = top + Math.round(height * 0.19); y < Math.min(top + Math.round(height * 0.42), cell.height); y++) {
    if (best === null || widths[y]! <= widths[best]!) best = y
  }
  return best === null ? null : cell.y + best
}

/**
 * Which part of each figure a layer may repaint.
 *
 * - `body`: the figure's own pixels below the neck. Clothing: it cannot grow
 *   past the silhouette, and the head stays put.
 * - `head`: everything from the top of the cell down to the neck, empty space
 *   included. Hats, hair, helmets: they need room above and beside the head.
 * - `around`: everything below the neck, empty space included. Held items,
 *   capes, packs: they need room beside the body, and the head stays put.
 */
export type LayerRegion = "body" | "head" | "around"

/**
 * The inpaint mask for a sheet: white (repaint) on each cell's `region`,
 * black (keep) everywhere else. Whatever the region, part of the figure is
 * always kept, and that is what stops the provider redrawing the pose: it
 * cannot move a head, or a body, that it may not touch.
 */
export function bodyMask(sheet: Buffer, cells?: SheetCell[], region: LayerRegion = "body"): Buffer {
  const image = decodePng(sheet)
  const out = Buffer.alloc(image.width * image.height * 4)
  for (let i = 3; i < out.length; i += 4) out[i] = 255
  for (const cell of cells ?? [whole(image)]) {
    const neck = neckRow(image, cell)
    if (neck === null) continue
    const from = region === "head" ? cell.y : neck + 1
    const to = region === "head" ? neck + 1 : cell.y + cell.height
    for (let y = from; y < to; y++) {
      for (let x = cell.x; x < cell.x + cell.width; x++) {
        if (region === "body" && !opaque(image, x, y)) continue
        out.fill(255, at(image, x, y), at(image, x, y) + 3)
      }
    }
  }
  return encodeRgbaPng(image.width, image.height, out)
}

/**
 * Cuts the outfit out of an inpaint result. A pixel belongs to the layer when
 * the mask let the provider repaint it, it came back opaque, it is not keyed
 * skin, and it is not the keyed input unchanged. Everything else is
 * transparent, so the layer drops over the original, un-keyed body.
 */
export function extractLayer(result: Buffer, keyed: Buffer, mask: Buffer, options: { key?: string } = {}): Buffer {
  const out = decodePng(result)
  const before = decodePng(keyed)
  const allowed = decodePng(mask)
  for (const [name, image] of [["keyed input", before], ["mask", allowed]] as const) {
    if (image.width !== out.width || image.height !== out.height) {
      throw new Error(`the ${name} is ${image.width}x${image.height}; the result is ${out.width}x${out.height}`)
    }
  }
  const layer = Buffer.alloc(out.pixels.length)
  for (let i = 0; i < layer.length; i += 4) {
    if (allowed.pixels[i] !== 255 || out.pixels[i + 3] === 0) continue
    if (isKeyColor(out.pixels[i]!, out.pixels[i + 1]!, out.pixels[i + 2]!, options.key)) continue
    if (out.pixels.compare(before.pixels, i, i + 4, i, i + 4) === 0) continue
    out.pixels.copy(layer, i, i, i + 4)
  }
  return encodeRgbaPng(out.width, out.height, layer)
}

export interface DespeckleOptions {
  /** Stills whose colours are known good, typically the character's rotations. */
  reference: Buffer[]
  /** How near (RGB distance) a reference colour must be to vouch for a pixel. Default 30. */
  tolerance?: number
  /**
   * A colour is the figure's own when at least this share of the reference's
   * non-outline pixels sit within `tolerance` of it. Default 0.005. Anything
   * rarer is suspect: the off-white and grey of a ghost are usually near some
   * colour the still uses a few times (an eye highlight), so "appears in the
   * reference at all" lets them through.
   */
  minShare?: number
  /** A pixel whose brightest channel is below this is outline. Default 60. */
  outlineBelow?: number
  /** Clean each of these cells on its own; the whole image when omitted. */
  cells?: SheetCell[]
}

/**
 * Removes the ghost pixels an animation model leaves around a figure: pale
 * arcs beside the head, stray fragments off a limb. Per cell, the body is the
 * largest connected run of non-outline pixels. Debris is
 *
 * - any other run that touches transparency and is either one or two pixels
 *   or mostly in colours the reference barely uses,
 * - any other run in such colours that outline has sealed off, unless the body
 *   lies beyond it in all four directions (which is what tells an eye, inside
 *   the head, from a ghost with its own outline, beside it),
 * - such colours on the body's own exposed edge, peeled up to four deep, and
 * - outline pixels left with nothing but outline or transparency around them.
 *
 * Colour, not shape, decides: a fragment of three or more pixels in the
 * body's own colours is kept however thin, because that is also what a
 * finger or a far hand looks like. A ghost in the body's own colours
 * therefore survives.
 */
export function despeckle(png: Buffer, options: DespeckleOptions): { png: Buffer; removed: number } {
  const image = decodePng(png)
  const tolerance = options.tolerance ?? 30
  const outlineBelow = options.outlineBelow ?? 60
  const minShare = options.minShare ?? 0.005
  const outline = (pixels: Buffer, i: number) => Math.max(pixels[i]!, pixels[i + 1]!, pixels[i + 2]!) < outlineBelow
  // How many non-outline reference pixels carry each colour.
  const palette = new Map<number, number>()
  let total = 0
  for (const still of options.reference) {
    const { pixels } = decodePng(still)
    for (let i = 0; i < pixels.length; i += 4) {
      if (pixels[i + 3] === 0 || outline(pixels, i)) continue
      const rgb = (pixels[i]! << 16) | (pixels[i + 1]! << 8) | pixels[i + 2]!
      palette.set(rgb, (palette.get(rgb) ?? 0) + 1)
      total++
    }
  }
  if (!total) throw new Error("the reference stills have no opaque pixels that are not outline")
  const known = new Map<number, boolean>()
  const src = image.pixels
  const foreign = (i: number) => {
    const rgb = (src[i]! << 16) | (src[i + 1]! << 8) | src[i + 2]!
    let hit = known.get(rgb)
    if (hit === undefined) {
      let vouched = 0
      for (const [color, count] of palette) {
        const apart = (((color >> 16) & 255) - src[i]!) ** 2 + (((color >> 8) & 255) - src[i + 1]!) ** 2 + ((color & 255) - src[i + 2]!) ** 2
        if (apart <= tolerance ** 2) vouched += count
      }
      hit = vouched / total < minShare
      known.set(rgb, hit)
    }
    return hit
  }
  const out = Buffer.from(src)
  let removed = 0
  const erase = (i: number) => {
    out.fill(0, i, i + 4)
    removed++
  }

  for (const cell of options.cells ?? [whole(image)]) {
    // Runs of non-outline pixels, 4-connected, labelled over the cell.
    const label = new Int32Array(cell.width * cell.height).fill(-1)
    const local = (x: number, y: number) => (y - cell.y) * cell.width + (x - cell.x)
    const body = (x: number, y: number) => inside(cell, x, y) && src[at(image, x, y) + 3]! > 0 && !outline(src, at(image, x, y))
    const runs: Array<Array<[number, number]>> = []
    for (let y = cell.y; y < cell.y + cell.height; y++) {
      for (let x = cell.x; x < cell.x + cell.width; x++) {
        if (!body(x, y) || label[local(x, y)]! >= 0) continue
        const run: Array<[number, number]> = [[x, y]]
        label[local(x, y)] = runs.length
        for (let n = 0; n < run.length; n++) {
          const [px, py] = run[n]!
          for (const [dx, dy] of STEPS) {
            const qx = px + dx
            const qy = py + dy
            if (!body(qx, qy) || label[local(qx, qy)]! >= 0) continue
            label[local(qx, qy)] = runs.length
            run.push([qx, qy])
          }
        }
        runs.push(run)
      }
    }
    if (!runs.length) continue
    const main = runs.reduce((best, run, index) => (run.length > runs[best]!.length ? index : best), 0)
    const open = (x: number, y: number) => !inside(cell, x, y) || src[at(image, x, y) + 3] === 0

    const dropped = new Set<number>()
    for (const [index, run] of runs.entries()) {
      if (index === main) continue
      const strange = run.filter(([x, y]) => foreign(at(image, x, y))).length / run.length > 0.5
      let debris: boolean
      if (run.some(([x, y]) => STEPS.some(([dx, dy]) => open(x + dx, y + dy)))) {
        debris = strange || run.length <= 2
      } else {
        // Sealed by outline. Walk out from the run in each direction through
        // opaque pixels: an eye meets the body every way, a ghost does not.
        const reaches = ([dx, dy]: readonly [number, number]) => run.some(([x, y]) => {
          for (let qx = x + dx, qy = y + dy; !open(qx, qy); qx += dx, qy += dy) {
            if (label[local(qx, qy)] === main) return true
          }
          return false
        })
        debris = strange && !STEPS.every(reaches)
      }
      if (debris) {
        for (const [x, y] of run) erase(at(image, x, y))
        dropped.add(index)
      }
    }

    // Every run that stays, not only the body: a soft outline is a run of its
    // own, and a ghost pixel can hang off it without touching the skin.
    const peeled = new Set<number>()
    const kept = runs.flatMap((run, index) => (dropped.has(index) ? [] : run))
    for (let round = 0; round < 4; round++) {
      const next = kept.filter(([x, y]) =>
        !peeled.has(local(x, y)) && foreign(at(image, x, y)) &&
        STEPS.some(([dx, dy]) => inside(cell, x + dx, y + dy) && (src[at(image, x + dx, y + dy) + 3] === 0 || peeled.has(local(x + dx, y + dy)))))
      if (!next.length) break
      for (const [x, y] of next) {
        peeled.add(local(x, y))
        erase(at(image, x, y))
      }
    }

    // Outline that framed only debris: an outline pixel beside something just
    // erased, with no body pixel left among its eight neighbours. Erasing one
    // can strand the next, so this follows the chain. Outline nowhere near
    // debris is never looked at: a thick line or a dark crevice has pixels
    // with no body neighbour too, and those are the figure's own.
    const frontier: Array<[number, number]> = []
    for (let y = cell.y; y < cell.y + cell.height; y++) {
      for (let x = cell.x; x < cell.x + cell.width; x++) {
        if (src[at(image, x, y) + 3]! > 0 && out[at(image, x, y) + 3] === 0) frontier.push([x, y])
      }
    }
    for (let n = 0; n < frontier.length; n++) {
      const [fx, fy] = frontier[n]!
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const x = fx + dx
          const y = fy + dy
          if (!inside(cell, x, y)) continue
          const i = at(image, x, y)
          if (out[i + 3] === 0 || !outline(out, i)) continue
          let held = false
          for (let ny = -1; ny <= 1 && !held; ny++) {
            for (let nx = -1; nx <= 1 && !held; nx++) {
              if (!inside(cell, x + nx, y + ny)) continue
              const j = at(image, x + nx, y + ny)
              held = out[j + 3]! > 0 && !outline(out, j)
            }
          }
          if (held) continue
          erase(i)
          frontier.push([x, y])
        }
      }
    }
  }
  return { png: encodeRgbaPng(image.width, image.height, out), removed }
}

/** One source frame's place in a layer job: which cell it took, and where that cell sits in the frame. */
export interface LayerFrame {
  /** The asset the frame came from. */
  assetId: string
  /** The frame's role within that asset (a direction, a frame name), when it has one. */
  role?: string
  /** The frame's own canvas, which its layer is returned on. */
  width: number
  height: number
  /** Where the cell's top-left corner falls in the frame; negative when the frame is smaller than the cell on that side. */
  offsetX: number
  offsetY: number
  /** Empty space the cell holds beyond the figures' own bounds on every side, which the layer's canvas grows by. */
  padding?: number
  cell: SheetCell
}

export interface LayerSheet {
  /** The frames as they are (after cleaning), on one sheet. What the layer is composited over. */
  sheet: Buffer
  /** `sheet` with skin keyed: the image the provider repaints. */
  keyed: Buffer
  /** White where the provider may paint. */
  mask: Buffer
  frames: LayerFrame[]
  /** Pixels `despeckle` removed, over all frames. */
  cleaned: number
}

export interface LayerSheetOptions {
  /** The longest side a provider accepts. */
  maxSide: number
  /** The shortest side a provider accepts. Default 32. */
  minSide?: number
  /** Sheet columns; chosen to fit `maxSide` in the smallest area when omitted. */
  columns?: number
  /** Which part of each figure may be repainted. Default `body`. */
  region?: LayerRegion
  /**
   * Empty pixels added around every cell, for things that reach past the
   * figure: a hat above it, a sword beside it. Each layer frame comes back on
   * its source frame's canvas grown by this much on every side.
   */
  padding?: number
  key?: string
  skin?: string[]
  /** Stills to clean every other frame against; cleaning is skipped when empty. */
  reference?: Buffer[]
  /** Replaces the computed mask. Must be the sheet's size. */
  mask?: Buffer
  /** Replaces the computed keyed sheet. Must be the sheet's size. */
  keyed?: Buffer
}

/**
 * Builds everything a provider needs to dress a set of frames in one inpaint:
 * the frames cleaned, centred on a common canvas, cut to the one box that
 * holds them all, laid on a sheet, keyed and masked.
 *
 * Frames of different canvases share a sheet by their centres, which is how
 * PixelLab pads an animation frame around its character's still.
 */
export function buildLayerSheet(
  sources: Array<{ assetId: string; role?: string; png: Buffer }>,
  options: LayerSheetOptions,
): LayerSheet {
  if (!sources.length) throw new Error("a layer needs at least one source frame")
  const minSide = options.minSide ?? 32
  let cleaned = 0
  // Stills drawn entirely in outline-dark colours give cleaning no body
  // palette to judge against; the frames go through as they are.
  const reference = options.reference ?? []
  const judgeable = reference.some((still) => {
    const { pixels } = decodePng(still)
    for (let i = 0; i < pixels.length; i += 4) {
      if (pixels[i + 3]! > 0 && Math.max(pixels[i]!, pixels[i + 1]!, pixels[i + 2]!) >= 60) return true
    }
    return false
  })
  const decoded = sources.map((source) => {
    let png = source.png
    if (judgeable && !reference.includes(source.png)) {
      const result = despeckle(png, { reference })
      png = result.png
      cleaned += result.removed
    }
    return { ...source, image: decodePng(png) }
  })
  const canvasWidth = Math.max(...decoded.map((frame) => frame.image.width))
  const canvasHeight = Math.max(...decoded.map((frame) => frame.image.height))
  // Each frame's top-left on the common canvas, then the box of opaque pixels over all of them.
  const placed = decoded.map((frame) => ({
    ...frame,
    left: Math.floor((canvasWidth - frame.image.width) / 2),
    top: Math.floor((canvasHeight - frame.image.height) / 2),
  }))
  let left = Infinity
  let top = Infinity
  let right = -1
  let bottom = -1
  for (const frame of placed) {
    for (let y = 0; y < frame.image.height; y++) {
      for (let x = 0; x < frame.image.width; x++) {
        if (!opaque(frame.image, x, y)) continue
        left = Math.min(left, frame.left + x)
        right = Math.max(right, frame.left + x)
        top = Math.min(top, frame.top + y)
        bottom = Math.max(bottom, frame.top + y)
      }
    }
  }
  if (right < 0) throw new Error("every source frame is fully transparent")
  const padding = options.padding ?? 0
  left -= padding
  top -= padding
  const cellWidth = right - left + 1 + padding
  const cellHeight = bottom - top + 1 + padding

  const fits = (columns: number) => {
    const rows = Math.ceil(placed.length / columns)
    return columns * cellWidth <= options.maxSide && rows * cellHeight <= options.maxSide
  }
  let columns = options.columns
  if (columns !== undefined) {
    if (!fits(columns)) {
      throw new Error(
        `${placed.length} frames in ${columns} columns of ${cellWidth}x${cellHeight} make a ` +
          `${columns * cellWidth}x${Math.ceil(placed.length / columns) * cellHeight} sheet; the limit is ${options.maxSide}px a side`,
      )
    }
  } else {
    let best: { columns: number; area: number; longest: number } | undefined
    for (let candidate = 1; candidate <= placed.length; candidate++) {
      if (!fits(candidate)) continue
      const width = candidate * cellWidth
      const height = Math.ceil(placed.length / candidate) * cellHeight
      const score = { columns: candidate, area: width * height, longest: Math.max(width, height) }
      if (!best || score.area < best.area || (score.area === best.area && score.longest < best.longest)) best = score
    }
    if (!best) {
      throw new Error(
        `${placed.length} frames of ${cellWidth}x${cellHeight} do not fit one ${options.maxSide}px sheet; ` +
          "split the layer across two assets",
      )
    }
    columns = best.columns
  }
  const rows = Math.ceil(placed.length / columns)
  // A sheet under the provider's floor is padded with empty space, never scaled.
  const width = Math.max(minSide, columns * cellWidth)
  const height = Math.max(minSide, rows * cellHeight)
  const sheet: DecodedPng = { width, height, pixels: Buffer.alloc(width * height * 4) }
  const frames = placed.map((frame, index): LayerFrame => {
    const cell = { x: (index % columns!) * cellWidth, y: Math.floor(index / columns!) * cellHeight, width: cellWidth, height: cellHeight }
    const offsetX = left - frame.left
    const offsetY = top - frame.top
    for (let y = 0; y < cellHeight; y++) {
      const sy = offsetY + y
      if (sy < 0 || sy >= frame.image.height) continue
      const x0 = Math.max(0, -offsetX)
      const x1 = Math.min(cellWidth, frame.image.width - offsetX)
      if (x1 <= x0) continue
      const from = at(frame.image, offsetX + x0, sy)
      frame.image.pixels.copy(sheet.pixels, at(sheet, cell.x + x0, cell.y + y), from, from + (x1 - x0) * 4)
    }
    return {
      assetId: frame.assetId,
      ...(frame.role ? { role: frame.role } : {}),
      width: frame.image.width,
      height: frame.image.height,
      offsetX,
      offsetY,
      ...(padding ? { padding } : {}),
      cell,
    }
  })
  const sheetPng = encodeRgbaPng(width, height, sheet.pixels)
  const sized = (name: string, png: Buffer) => {
    const image = decodePng(png)
    if (image.width !== width || image.height !== height) {
      throw new Error(`the ${name} is ${image.width}x${image.height}; this layer's sheet is ${width}x${height}`)
    }
    return png
  }
  return {
    sheet: sheetPng,
    keyed: options.keyed ? sized("keyed sheet", options.keyed) : keySkin(sheetPng, { key: options.key, skin: options.skin }),
    mask: options.mask ? sized("mask", options.mask) : bodyMask(sheetPng, frames.map((frame) => frame.cell), options.region),
    frames,
    cleaned,
  }
}

/**
 * Cleans an item layer (a hat, a held sword) in place. Given room around the
 * figure, a provider does two things an outfit mask never lets it do:
 *
 * - It redraws stretches of the figure's own outline a pixel off, which come
 *   back as changed dark pixels and so as thin scribbles in the layer. A dark
 *   pixel is kept only when it borders a coloured layer pixel (it is the
 *   item's outline) or sits in a solid 2x2 block of layer pixels (it is part
 *   of a dark item, or of a thick outline).
 * - It lets a long item run past its cell, so the tip turns up in the next
 *   one, and it leaves the odd stray pixel. A fragment that touches its
 *   cell's edge is dropped when it is under 20 pixels, and any fragment when
 *   it is under 8. An item smaller than that (a stud earring) does not
 *   survive this; give it a hand-made mask and the `body` region instead.
 * - It redraws the figure's dark details (an eye, a navel, a deep shadow) as
 *   small solid blots. A fragment with no coloured pixel at all is dropped
 *   when it is under 40 pixels.
 */
const SPECK = 8
const BLEED = 20
const SHADOW = 40

function tidyItemLayer(layer: DecodedPng, cells: SheetCell[], outlineBelow = 60): void {
  const px = layer.pixels
  const on = (x: number, y: number, cell: SheetCell) => inside(cell, x, y) && px[at(layer, x, y) + 3]! > 0
  const dark = (i: number) => Math.max(px[i]!, px[i + 1]!, px[i + 2]!) < outlineBelow
  for (const cell of cells) {
    const drop: number[] = []
    for (let y = cell.y; y < cell.y + cell.height; y++) {
      for (let x = cell.x; x < cell.x + cell.width; x++) {
        const i = at(layer, x, y)
        if (px[i + 3] === 0 || !dark(i)) continue
        let keep = false
        for (let dy = -1; dy <= 1 && !keep; dy++) {
          for (let dx = -1; dx <= 1 && !keep; dx++) {
            if (on(x + dx, y + dy, cell) && !dark(at(layer, x + dx, y + dy))) keep = true
          }
        }
        // Any of the four 2x2 blocks this pixel is a corner of.
        for (const [bx, by] of [[0, 0], [-1, 0], [0, -1], [-1, -1]] as const) {
          if (keep) break
          keep = on(x + bx, y + by, cell) && on(x + bx + 1, y + by, cell) && on(x + bx, y + by + 1, cell) && on(x + bx + 1, y + by + 1, cell)
        }
        if (!keep) drop.push(i)
      }
    }
    for (const i of drop) px.fill(0, i, i + 4)

    const seen = new Uint8Array(cell.width * cell.height)
    const local = (x: number, y: number) => (y - cell.y) * cell.width + (x - cell.x)
    for (let y = cell.y; y < cell.y + cell.height; y++) {
      for (let x = cell.x; x < cell.x + cell.width; x++) {
        if (!on(x, y, cell) || seen[local(x, y)]) continue
        const run: Array<[number, number]> = [[x, y]]
        seen[local(x, y)] = 1
        let edge = false
        let coloured = false
        for (let n = 0; n < run.length; n++) {
          const [cx, cy] = run[n]!
          if (!dark(at(layer, cx, cy))) coloured = true
          if (cx === cell.x || cy === cell.y || cx === cell.x + cell.width - 1 || cy === cell.y + cell.height - 1) edge = true
          for (let dy = -1; dy <= 1; dy++) {
            for (let dx = -1; dx <= 1; dx++) {
              if (!on(cx + dx, cy + dy, cell) || seen[local(cx + dx, cy + dy)]) continue
              seen[local(cx + dx, cy + dy)] = 1
              run.push([cx + dx, cy + dy])
            }
          }
        }
        if (run.length < SPECK || (edge && run.length < BLEED) || (!coloured && run.length < SHADOW)) for (const [cx, cy] of run) px.fill(0, at(layer, cx, cy), at(layer, cx, cy) + 4)
      }
    }
  }
}

/**
 * Turns a provider's repainted sheet into one layer PNG per source frame,
 * each on its frame's own canvas so it drops straight over that frame. A
 * padded sheet returns each layer on that canvas grown by the padding on
 * every side, so the two share a centre.
 */
export function cutLayerFrames(
  result: Buffer,
  prepared: { keyed: Buffer; mask: Buffer; frames: LayerFrame[] },
  options: { key?: string; region?: LayerRegion } = {},
): Buffer[] {
  const layer = decodePng(extractLayer(result, prepared.keyed, prepared.mask, options))
  if (options.region && options.region !== "body") tidyItemLayer(layer, prepared.frames.map((frame) => frame.cell))
  return prepared.frames.map((frame) => {
    const pad = frame.padding ?? 0
    const out: DecodedPng = {
      width: frame.width + pad * 2,
      height: frame.height + pad * 2,
      pixels: Buffer.alloc((frame.width + pad * 2) * (frame.height + pad * 2) * 4),
    }
    // Where the cell's corner lands on the grown canvas.
    const dx = frame.offsetX + pad
    const dy = frame.offsetY + pad
    for (let y = 0; y < frame.cell.height; y++) {
      const ty = dy + y
      if (ty < 0 || ty >= out.height) continue
      const x0 = Math.max(0, -dx)
      const x1 = Math.min(frame.cell.width, out.width - dx)
      if (x1 <= x0) continue
      const from = at(layer, frame.cell.x + x0, frame.cell.y + y)
      layer.pixels.copy(out.pixels, at(out, dx + x0, ty), from, from + (x1 - x0) * 4)
    }
    return encodeRgbaPng(out.width, out.height, out.pixels)
  })
}
