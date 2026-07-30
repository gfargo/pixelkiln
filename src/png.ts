import { inflateSync } from "node:zlib"

export interface DecodedPng {
  width: number
  height: number
  /** RGBA, 4 bytes per pixel, row-major. */
  pixels: Buffer
}

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

/**
 * Minimal PNG reader for 8-bit RGBA, non-interlaced.
 *
 * Deliberately narrow rather than a general decoder: every image this tool
 * handles comes from a pixel-art generator and is RGBA8 (verified across the
 * badge and sprite sets). Supporting only that keeps the runtime dependency
 * count at one — Node's zlib does the only hard part — and anything else fails
 * with a clear message instead of decoding subtly wrong.
 */
export function decodePng(buf: Buffer): DecodedPng {
  if (buf.length < 8 || !buf.subarray(0, 8).equals(SIGNATURE)) {
    throw new Error("not a PNG")
  }

  let width = 0
  let height = 0
  let bitDepth = 0
  let colorType = 0
  let interlace = 0
  const idat: Buffer[] = []

  let offset = 8
  while (offset + 8 <= buf.length) {
    const length = buf.readUInt32BE(offset)
    const type = buf.toString("ascii", offset + 4, offset + 8)
    const data = buf.subarray(offset + 8, offset + 8 + length)

    if (type === "IHDR") {
      width = data.readUInt32BE(0)
      height = data.readUInt32BE(4)
      bitDepth = data[8]!
      colorType = data[9]!
      interlace = data[12]!
    } else if (type === "IDAT") {
      idat.push(data)
    } else if (type === "IEND") {
      break
    }
    offset += 12 + length // length + type + data + crc
  }

  if (bitDepth !== 8 || colorType !== 6) {
    throw new Error(
      `unsupported PNG: bitDepth=${bitDepth} colorType=${colorType} (only 8-bit RGBA is handled)`,
    )
  }
  if (interlace !== 0) throw new Error("unsupported PNG: interlaced")
  if (!idat.length) throw new Error("PNG has no image data")

  const raw = inflateSync(Buffer.concat(idat))
  return { width, height, pixels: unfilter(raw, width, height) }
}

/**
 * Reverses PNG's per-scanline filters. Each row is prefixed with a filter byte
 * and predicted from the row above and the pixel to the left.
 */
function unfilter(raw: Buffer, width: number, height: number): Buffer {
  const bpp = 4
  const stride = width * bpp
  const out = Buffer.alloc(stride * height)

  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)]!
    const src = raw.subarray(y * (stride + 1) + 1, y * (stride + 1) + 1 + stride)
    const dst = out.subarray(y * stride, (y + 1) * stride)
    const prev = y > 0 ? out.subarray((y - 1) * stride, y * stride) : null

    for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? dst[x - bpp]! : 0 // left
      const b = prev ? prev[x]! : 0 // above
      const c = prev && x >= bpp ? prev[x - bpp]! : 0 // upper-left
      const v = src[x]!
      switch (filter) {
        case 0: dst[x] = v; break
        case 1: dst[x] = (v + a) & 0xff; break
        case 2: dst[x] = (v + b) & 0xff; break
        case 3: dst[x] = (v + ((a + b) >> 1)) & 0xff; break
        case 4: dst[x] = (v + paeth(a, b, c)) & 0xff; break
        default: throw new Error(`unknown PNG filter ${filter} on row ${y}`)
      }
    }
  }
  return out
}

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c
  const pa = Math.abs(p - a)
  const pb = Math.abs(p - b)
  const pc = Math.abs(p - c)
  if (pa <= pb && pa <= pc) return a
  return pb <= pc ? b : c
}

export interface PaletteEntry {
  r: number
  g: number
  b: number
  /** Share of opaque pixels using this colour, 0-1. */
  weight: number
}

/**
 * Dominant colours of an image, ignoring transparency.
 *
 * Pixel art uses a small deliberate palette, so exact colour counting works —
 * no clustering needed. Nearly-transparent pixels are excluded because
 * anti-aliased edges would otherwise dominate the histogram of a small sprite.
 */
export function extractPalette(png: DecodedPng, topN = 8, alphaThreshold = 128): PaletteEntry[] {
  const counts = new Map<number, number>()
  let opaque = 0

  for (let i = 0; i < png.pixels.length; i += 4) {
    const alpha = png.pixels[i + 3]!
    if (alpha < alphaThreshold) continue
    opaque++
    const key = (png.pixels[i]! << 16) | (png.pixels[i + 1]! << 8) | png.pixels[i + 2]!
    counts.set(key, (counts.get(key) ?? 0) + 1)
  }
  if (opaque === 0) return []

  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, topN)
    .map(([key, n]) => ({
      r: (key >> 16) & 0xff,
      g: (key >> 8) & 0xff,
      b: key & 0xff,
      weight: n / opaque,
    }))
}

/** Fraction of pixels that are effectively transparent — a silhouette check. */
export function transparencyRatio(png: DecodedPng, alphaThreshold = 128): number {
  let clear = 0
  const total = png.pixels.length / 4
  for (let i = 0; i < png.pixels.length; i += 4) {
    if (png.pixels[i + 3]! < alphaThreshold) clear++
  }
  return total === 0 ? 0 : clear / total
}
