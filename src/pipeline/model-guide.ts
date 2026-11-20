import { pieceLabel, regionColour, type UvGuide } from "../glb-guide.ts"
import { encodeRgbaPng } from "../png.ts"

/**
 * The texture guide as files, for painting in a desktop editor: a
 * transparent PNG the size of the texture with every unwrap piece outlined
 * in its region's colour and numbered, and a key that says what each number
 * is. The gallery draws the same outlines with the region names written in;
 * there is no text renderer here, so the PNG carries numbers and the key
 * carries the words.
 */

/** 3×5 digits, one row per string, `#` lit. */
const DIGITS: Record<string, string[]> = {
  "0": ["###", "#.#", "#.#", "#.#", "###"],
  "1": [".#.", "##.", ".#.", ".#.", "###"],
  "2": ["###", "..#", "###", "#..", "###"],
  "3": ["###", "..#", "###", "..#", "###"],
  "4": ["#.#", "#.#", "###", "..#", "..#"],
  "5": ["###", "#..", "###", "..#", "###"],
  "6": ["###", "#..", "###", "#.#", "###"],
  "7": ["###", "..#", ".#.", ".#.", ".#."],
  "8": ["###", "#.#", "###", "#.#", "###"],
  "9": ["###", "#.#", "###", "..#", "###"],
}

/** `hsl(h s% l%)` as regionColour writes it, to RGB. */
export function hslToRgb(css: string): [number, number, number] {
  const match = /hsl\(\s*([\d.]+)\s+([\d.]+)%\s+([\d.]+)%\s*\)/.exec(css)
  if (!match) return [255, 255, 255]
  const h = Number(match[1]) / 360, s = Number(match[2]) / 100, l = Number(match[3]) / 100
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s
  const p = 2 * l - q
  const channel = (t: number) => {
    t = (t + 1) % 1
    const value = t < 1 / 6 ? p + (q - p) * 6 * t : t < 1 / 2 ? q : t < 2 / 3 ? p + (q - p) * (2 / 3 - t) * 6 : p
    return Math.round(value * 255)
  }
  return [channel(h + 1 / 3), channel(h), channel(h - 1 / 3)]
}

export interface GuideFiles {
  png: Buffer
  /** One line per region, then one per piece. */
  key: string
}

/** Draw the guide for one texture at its own size. */
export function renderGuide(guide: UvGuide, width: number, height: number): GuideFiles {
  const pixels = Buffer.alloc(width * height * 4)
  const put = (x: number, y: number, rgb: readonly number[], alpha = 255) => {
    if (x < 0 || y < 0 || x >= width || y >= height) return
    const at = (y * width + x) * 4
    pixels[at] = rgb[0]!; pixels[at + 1] = rgb[1]!; pixels[at + 2] = rgb[2]!; pixels[at + 3] = alpha
  }
  const thickness = Math.max(1, Math.round(width / 512))
  const dot = (x: number, y: number, rgb: readonly number[], radius: number) => {
    for (let dy = -radius; dy <= radius; dy++) for (let dx = -radius; dx <= radius; dx++) put(x + dx, y + dy, rgb)
  }
  const line = (x0: number, y0: number, x1: number, y1: number, rgb: readonly number[], radius: number) => {
    const steps = Math.max(1, Math.ceil(Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0))))
    for (let i = 0; i <= steps; i++) dot(Math.round(x0 + ((x1 - x0) * i) / steps), Math.round(y0 + ((y1 - y0) * i) / steps), rgb, radius)
  }
  const black = [0, 0, 0]
  const colours = guide.regions.map((_, index) => hslToRgb(regionColour(index)))
  // A dark halo first, then the colour, so the outlines read on any texture.
  for (const pass of [0, 1]) {
    for (const piece of guide.pieces) {
      const colour = pass ? colours[guide.regions.indexOf(piece.region)]! : black
      const radius = pass ? Math.floor((thickness - 1) / 2) : Math.floor((thickness - 1) / 2) + 1
      for (let at = 0; at < piece.outline.length; at += 4) {
        line(piece.outline[at]! * width, piece.outline[at + 1]! * height, piece.outline[at + 2]! * width, piece.outline[at + 3]! * height, colour, radius)
      }
    }
  }
  // Each piece's region number, where it fits: white on a dark box.
  const scale = Math.max(1, Math.round(width / 384))
  for (const piece of guide.pieces) {
    const text = String(guide.regions.indexOf(piece.region) + 1)
    const textWidth = (text.length * 4 - 1) * scale
    const textHeight = 5 * scale
    const boxWidth = (piece.bounds[2] - piece.bounds[0]) * width
    const boxHeight = (piece.bounds[3] - piece.bounds[1]) * height
    if (textWidth + 2 * scale > boxWidth || textHeight + 2 * scale > boxHeight) continue
    const left = Math.round(Math.min(width - textWidth - scale, Math.max(scale, piece.anchor[0] * width - textWidth / 2)))
    const top = Math.round(Math.min(height - textHeight - scale, Math.max(scale, piece.anchor[1] * height - textHeight / 2)))
    for (let y = top - scale; y < top + textHeight + scale; y++) for (let x = left - scale; x < left + textWidth + scale; x++) put(x, y, black, 220)
    for (const [index, char] of [...text].entries()) {
      const glyph = DIGITS[char]!
      for (let gy = 0; gy < 5; gy++) for (let gx = 0; gx < 3; gx++) {
        if (glyph[gy]![gx] !== "#") continue
        for (let sy = 0; sy < scale; sy++) for (let sx = 0; sx < scale; sx++) put(left + (index * 4 + gx) * scale + sx, top + gy * scale + sy, [255, 255, 255])
      }
    }
  }
  const key = [
    "# Regions: the number drawn on each piece, its outline colour, and what it is",
    ...guide.regions.map((region, index) => {
      const [r, g, b] = colours[index]!
      return `${index + 1}\t#${[r, g, b].map((c) => c.toString(16).padStart(2, "0")).join("")}\t${region}`
    }),
    "",
    "# Pieces, largest first: id, region number, label, pixel bounds (left top right bottom), meshes",
    ...guide.pieces.map((piece) => [
      piece.id,
      guide.regions.indexOf(piece.region) + 1,
      pieceLabel(piece),
      piece.bounds.map((value, index) => Math.round(value * (index % 2 ? height : width))).join(" "),
      piece.meshes.join(", "),
    ].join("\t")),
    "",
  ].join("\n")
  return { png: encodeRgbaPng(width, height, pixels), key }
}
