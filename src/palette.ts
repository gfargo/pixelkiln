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

/**
 * Reads a palette file into `#rrggbb` values, in file order. The formats are
 * the ones Lospec offers for download:
 *
 * - `.hex`: one `rrggbb` per line, `#` optional.
 * - `.gpl`: a GIMP palette. A `GIMP Palette` header, `Name:`/`Columns:` lines,
 *   `#` comments, then `R G B` decimal triples with an optional colour name.
 * - `.txt`: a Paint.NET palette. `;` comments, then `aarrggbb` per line; the
 *   alpha byte is dropped.
 *
 * Throws with the file name and line on anything it cannot read. Range and
 * duplicate checks stay with the manifest schema, so a file palette fails the
 * same way an inline one does.
 */
export function parsePaletteFile(text: string, fileName: string): string[] {
  const ext = fileName.toLowerCase().split(".").pop()
  const lines = text.replace(/^﻿/, "").split(/\r?\n/)
  const colors: string[] = []
  const fail = (line: number, why: string): never => {
    throw new Error(`${fileName}:${line}: ${why}`)
  }
  if (ext === "gpl") {
    if (!/^GIMP Palette\s*$/.test(lines[0]?.trim() ?? "")) fail(1, 'a .gpl palette starts with "GIMP Palette"')
    lines.slice(1).forEach((raw, index) => {
      const line = raw.trim()
      if (!line || line.startsWith("#") || /^(Name|Columns):/i.test(line)) return
      const match = /^(\d{1,3})\s+(\d{1,3})\s+(\d{1,3})(\s|$)/.exec(line)
      if (!match) return fail(index + 2, `expected "R G B", got "${line}"`)
      const channels = match.slice(1, 4).map(Number)
      if (channels.some((value) => value > 255)) fail(index + 2, `channel above 255 in "${line}"`)
      colors.push(`#${channels.map((value) => value.toString(16).padStart(2, "0")).join("")}`)
    })
  } else if (ext === "hex" || ext === "txt") {
    lines.forEach((raw, index) => {
      const line = raw.trim()
      if (!line || (ext === "txt" && line.startsWith(";"))) return
      const match = ext === "hex" ? /^#?([0-9a-f]{6})$/i.exec(line) : /^[0-9a-f]{2}([0-9a-f]{6})$/i.exec(line)
      if (!match) fail(index + 1, `expected ${ext === "hex" ? "rrggbb" : "aarrggbb"}, got "${line}"`)
      colors.push(`#${match![1]!.toLowerCase()}`)
    })
  } else {
    throw new Error(`${fileName}: palette files are .hex, .gpl, or .txt (Paint.NET)`)
  }
  if (!colors.length) throw new Error(`${fileName}: no colours found`)
  return colors
}
