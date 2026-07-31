import { deflateSync, inflateSync } from "node:zlib"

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

/** CRC-32 as PNG specifies it. Small enough not to warrant a dependency. */
function crc32(buf: Buffer): number {
  let c = ~0
  for (const byte of buf) {
    c ^= byte
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1))
  }
  return ~c
}

function chunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length)
  const body = Buffer.concat([Buffer.from(type, "ascii"), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body) >>> 0)
  return Buffer.concat([len, body, crc])
}

/**
 * Writes an 8-bit RGB PNG. Used to build the small swatch image that carries a
 * forced palette to the API — not a general encoder.
 */
export function encodeRgbPng(width: number, height: number, rgb: Buffer): Buffer {
  if (rgb.length !== width * height * 3) {
    throw new Error(`expected ${width * height * 3} bytes of RGB, got ${rgb.length}`)
  }
  const stride = width * 3
  // Filter byte 0 (none) per scanline.
  const raw = Buffer.alloc((stride + 1) * height)
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0
    rgb.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride)
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 2 // colour type: RGB
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ])
}

/**
 * Writes an 8-bit RGBA PNG.
 *
 * Separate from `encodeRgbPng` rather than replacing it: the palette swatch
 * the API accepts is RGB, and sprite sheets must keep their alpha channel —
 * flattening it would fill every sprite's transparent background with black
 * and the sheet would be unusable over anything but that colour.
 */
export function encodeRgbaPng(width: number, height: number, rgba: Buffer): Buffer {
  if (rgba.length !== width * height * 4) {
    throw new Error(`expected ${width * height * 4} bytes of RGBA, got ${rgba.length}`)
  }
  const stride = width * 4
  // Filter byte 0 (none) per scanline. Pixel art compresses well enough that
  // the adaptive filters are not worth the complexity here.
  const raw = Buffer.alloc((stride + 1) * height)
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride)
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 6 // colour type: RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ])
}

/**
 * Builds the palette swatch the API expects: a block of solid colour per entry.
 *
 * Deliberately chunky rather than one pixel per colour — a 4x1 image was
 * rejected outright with "cannot identify image file", while a 64x64 block
 * swatch was accepted.
 */
export function paletteSwatch(hexes: string[], size = 64): Buffer {
  const colours = hexes.map(parseHex)
  if (!colours.length) throw new Error("palette is empty")
  const rgb = Buffer.alloc(size * size * 3)
  const band = Math.max(1, Math.floor(size / colours.length))
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const c = colours[Math.min(colours.length - 1, Math.floor(x / band))]!
      const o = (y * size + x) * 3
      rgb[o] = c.r
      rgb[o + 1] = c.g
      rgb[o + 2] = c.b
    }
  }
  return encodeRgbPng(size, size, rgb)
}

export function parseHex(hex: string): { r: number; g: number; b: number } {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim())
  if (!m) throw new Error(`invalid hex colour "${hex}" — expected #rrggbb`)
  const n = parseInt(m[1]!, 16)
  return { r: (n >> 16) & 0xff, g: (n >> 8) & 0xff, b: n & 0xff }
}
