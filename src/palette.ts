import { parseHex, type DecodedPng } from "./png.ts"

/**
 * Snapping pixels to a closed palette. Shared by `refine`, which does it
 * after native-grid recovery, and by `fetch`, which does it to the
 * provider's bytes when a style sets `enforcePalette`.
 *
 * Nearest colour by redmean distance, no dithering, ties to the earlier
 * palette entry. Every choice here is deterministic on purpose: the lockfile
 * records the hash of the snapped bytes, and a restore has to reproduce
 * them from the raw ones.
 */
export interface PaletteColor {
  /** Canonical lowercase `#rrggbb`. */
  hex: string
  r: number
  g: number
  b: number
}

/** Canonical, de-duplicated palette in manifest order; 2 to 256 colours. */
export function normalizePalette(values: string[]): PaletteColor[] {
  const colors = new Map<string, PaletteColor>()
  for (const value of values) {
    const rgb = parseHex(value)
    const hex = `#${rgb.r.toString(16).padStart(2, "0")}${rgb.g.toString(16).padStart(2, "0")}${rgb.b.toString(16).padStart(2, "0")}`
    if (!colors.has(hex)) colors.set(hex, { hex, ...rgb })
  }
  if (colors.size < 2 || colors.size > 256) {
    throw new Error(`A palette must contain 2–256 unique colors; got ${colors.size}.`)
  }
  return [...colors.values()]
}

/**
 * Perceptual-ish RGB distance that weights channels by where the colour sits
 * (Riemersma's redmean). Cheap and good enough to pick a swatch; not a
 * colour-management tool.
 */
export function colorDistance(
  a: { r: number; g: number; b: number },
  b: { r: number; g: number; b: number },
): number {
  const rmean = (a.r + b.r) / 2
  const dr = a.r - b.r
  const dg = a.g - b.g
  const db = a.b - b.b
  return Math.sqrt(
    (((512 + rmean) * dr * dr) / 256) + 4 * dg * dg + (((767 - rmean) * db * db) / 256),
  )
}

export interface QuantizeResult {
  png: DecodedPng
  /** Visible pixels whose colour moved. 0 means the input already conformed. */
  changed: number
}

/**
 * Map every visible pixel to the nearest palette colour. Fully transparent
 * pixels are zeroed so the same picture always has the same bytes. Alpha is
 * left alone: a palette says which colours, not how opaque.
 */
export function quantize(png: DecodedPng, palette: string[]): QuantizeResult {
  const colors = normalizePalette(palette)
  const pixels = Buffer.from(png.pixels)
  const nearestOf = new Map<number, PaletteColor>()
  let changed = 0
  for (let i = 0; i < pixels.length; i += 4) {
    const alpha = pixels[i + 3]!
    if (alpha === 0) {
      if (pixels[i] || pixels[i + 1] || pixels[i + 2]) changed++
      pixels[i] = 0
      pixels[i + 1] = 0
      pixels[i + 2] = 0
      continue
    }
    const key = (pixels[i]! << 16) | (pixels[i + 1]! << 8) | pixels[i + 2]!
    let nearest = nearestOf.get(key)
    if (!nearest) {
      const pixel = { r: pixels[i]!, g: pixels[i + 1]!, b: pixels[i + 2]! }
      nearest = colors[0]!
      let distance = colorDistance(pixel, nearest)
      for (let j = 1; j < colors.length; j++) {
        const candidate = colors[j]!
        const candidateDistance = colorDistance(pixel, candidate)
        if (candidateDistance < distance) {
          nearest = candidate
          distance = candidateDistance
        }
      }
      nearestOf.set(key, nearest)
    }
    if (pixels[i] !== nearest.r || pixels[i + 1] !== nearest.g || pixels[i + 2] !== nearest.b) changed++
    pixels[i] = nearest.r
    pixels[i + 1] = nearest.g
    pixels[i + 2] = nearest.b
  }
  return { png: { width: png.width, height: png.height, pixels }, changed }
}

/** `quantize` for callers that only want the picture. */
export function quantizeToPalette(png: DecodedPng, palette: string[]): DecodedPng {
  return quantize(png, palette).png
}
