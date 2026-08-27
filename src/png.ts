import { deflateSync, inflateSync } from "node:zlib"

export interface DecodedPng {
  width: number
  height: number
  /** RGBA, 4 bytes per pixel, row-major. */
  pixels: Buffer
}

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
const MAX_DECODED_BYTES = 256 * 1024 * 1024

interface PngHeader {
  width: number
  height: number
  bitDepth: number
  colorType: number
  channels: number
}

const CHANNELS = new Map([
  [0, 1], // greyscale
  [2, 3], // RGB
  [3, 1], // indexed colour
  [4, 2], // greyscale + alpha
  [6, 4], // RGBA
])

const LEGAL_DEPTHS = new Map<number, Set<number>>([
  [0, new Set([1, 2, 4, 8, 16])],
  [2, new Set([8, 16])],
  [3, new Set([1, 2, 4, 8])],
  [4, new Set([8, 16])],
  [6, new Set([8, 16])],
])

/**
 * Dependency-free decoder for standard non-interlaced PNG colour modes.
 *
 * Inputs are normalized to 8-bit RGBA for the audit and sheet pipelines. Adam7
 * remains deliberately unsupported: provider and game-art PNGs are normally
 * non-interlaced, and refusing the uncommon layout is safer than implementing
 * a second scanline geometry without a dedicated image dependency.
 */
export function decodePng(buf: Buffer): DecodedPng {
  if (buf.length < 8 || !buf.subarray(0, 8).equals(SIGNATURE)) {
    throw new Error("not a PNG")
  }

  let header: PngHeader | null = null
  let palette: Buffer | null = null
  let transparency: Buffer | null = null
  let sawImageData = false
  let sawEnd = false
  const idat: Buffer[] = []

  let offset = 8
  while (offset < buf.length) {
    if (offset + 12 > buf.length) throw new Error("truncated PNG chunk header")
    const length = buf.readUInt32BE(offset)
    const type = buf.toString("ascii", offset + 4, offset + 8)
    if (!/^[A-Za-z]{4}$/.test(type) || /[a-z]/.test(type[2]!)) {
      throw new Error(`PNG has an invalid chunk type ${JSON.stringify(type)}`)
    }
    const end = offset + 12 + length
    if (!Number.isSafeInteger(end) || end > buf.length) {
      throw new Error(`truncated PNG chunk ${type || "(unknown)"}`)
    }
    const data = buf.subarray(offset + 8, offset + 8 + length)
    const expectedCrc = buf.readUInt32BE(offset + 8 + length)
    const actualCrc = crc32(buf.subarray(offset + 4, offset + 8 + length)) >>> 0
    if (actualCrc !== expectedCrc) throw new Error(`PNG chunk ${type} has an invalid checksum`)

    if (!header && type !== "IHDR") throw new Error("PNG is missing its leading IHDR chunk")

    if (type === "IHDR") {
      if (header) throw new Error("PNG has more than one IHDR chunk")
      if (data.length !== 13) throw new Error("PNG has an invalid IHDR chunk")
      const width = data.readUInt32BE(0)
      const height = data.readUInt32BE(4)
      const bitDepth = data[8]!
      const colorType = data[9]!
      const channels = CHANNELS.get(colorType)
      if (!width || !height) throw new Error("PNG dimensions must be positive")
      if (!channels || !LEGAL_DEPTHS.get(colorType)?.has(bitDepth)) {
        throw new Error(`unsupported PNG: bitDepth=${bitDepth} colorType=${colorType}`)
      }
      if (data[10] !== 0) throw new Error(`unsupported PNG compression method ${data[10]}`)
      if (data[11] !== 0) throw new Error(`unsupported PNG filter method ${data[11]}`)
      if (data[12] !== 0) throw new Error("unsupported PNG: interlaced")
      header = { width, height, bitDepth, colorType, channels }
    } else if (type === "PLTE") {
      if (sawImageData) throw new Error("PNG palette appears after image data")
      if (palette) throw new Error("PNG has more than one palette")
      if (!data.length || data.length % 3 !== 0 || data.length > 256 * 3) {
        throw new Error("PNG has an invalid palette")
      }
      palette = Buffer.from(data)
    } else if (type === "tRNS") {
      if (sawImageData) throw new Error("PNG transparency appears after image data")
      if (transparency) throw new Error("PNG has more than one transparency chunk")
      transparency = Buffer.from(data)
    } else if (type === "IDAT") {
      sawImageData = true
      idat.push(data)
    } else if (type === "IEND") {
      if (data.length !== 0) throw new Error("PNG has an invalid IEND chunk")
      sawEnd = true
      break
    } else if (/^[A-Z]/.test(type)) {
      throw new Error(`unsupported critical PNG chunk ${type}`)
    }
    offset = end
  }

  if (!header) throw new Error("PNG has no image header")
  if (!sawEnd) throw new Error("PNG has no IEND chunk")
  if (!idat.length) throw new Error("PNG has no image data")
  validatePalette(header, palette)
  validateTransparency(header.colorType, transparency, palette)

  const bitsPerPixel = header.channels * header.bitDepth
  const stride = Math.ceil((header.width * bitsPerPixel) / 8)
  const rawLength = (stride + 1) * header.height
  const rgbaLength = header.width * header.height * 4
  if (
    !Number.isSafeInteger(rawLength) ||
    !Number.isSafeInteger(rgbaLength) ||
    rawLength > MAX_DECODED_BYTES ||
    rgbaLength > MAX_DECODED_BYTES
  ) {
    throw new Error("PNG dimensions exceed the 256 MiB decoded-image limit")
  }

  let raw: Buffer
  try {
    raw = inflateSync(Buffer.concat(idat), { maxOutputLength: rawLength })
  } catch (err) {
    throw new Error(`invalid PNG image data: ${err instanceof Error ? err.message : String(err)}`)
  }
  if (raw.length !== rawLength) {
    throw new Error(`invalid PNG image data length: expected ${rawLength}, got ${raw.length}`)
  }

  const filterBytes = Math.max(1, Math.ceil(bitsPerPixel / 8))
  const samples = unfilter(raw, stride, header.height, filterBytes)
  return {
    width: header.width,
    height: header.height,
    pixels: toRgba(samples, header, stride, palette, transparency),
  }
}

function validatePalette(header: PngHeader, palette: Buffer | null): void {
  if (header.colorType === 3 && !palette) throw new Error("indexed PNG has no palette")
  if ((header.colorType === 0 || header.colorType === 4) && palette) {
    throw new Error("greyscale PNG cannot contain a palette")
  }
  if (header.colorType === 3 && palette && palette.length / 3 > 2 ** header.bitDepth) {
    throw new Error("indexed PNG palette has more entries than its bit depth permits")
  }
}

/**
 * Reverses PNG's per-scanline filters. Each row is prefixed with a filter byte
 * and predicted from the row above and the pixel to the left.
 */
function unfilter(raw: Buffer, stride: number, height: number, bpp: number): Buffer {
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

function validateTransparency(
  colorType: number,
  transparency: Buffer | null,
  palette: Buffer | null,
): void {
  if (!transparency) return
  if (colorType === 0 && transparency.length !== 2) {
    throw new Error("greyscale PNG has an invalid transparency chunk")
  }
  if (colorType === 2 && transparency.length !== 6) {
    throw new Error("RGB PNG has an invalid transparency chunk")
  }
  if (colorType === 3 && transparency.length > (palette?.length ?? 0) / 3) {
    throw new Error("indexed PNG transparency exceeds its palette")
  }
  if (colorType === 4 || colorType === 6) {
    throw new Error("PNG with an alpha channel cannot also contain tRNS")
  }
}

function toRgba(
  samples: Buffer,
  header: PngHeader,
  stride: number,
  palette: Buffer | null,
  transparency: Buffer | null,
): Buffer {
  const out = Buffer.alloc(header.width * header.height * 4)
  const transparentGrey = header.colorType === 0 && transparency
    ? transparency.readUInt16BE(0)
    : null
  const transparentRgb = header.colorType === 2 && transparency
    ? [
        transparency.readUInt16BE(0),
        transparency.readUInt16BE(2),
        transparency.readUInt16BE(4),
      ]
    : null

  for (let y = 0; y < header.height; y++) {
    const row = samples.subarray(y * stride, (y + 1) * stride)
    for (let x = 0; x < header.width; x++) {
      const dst = (y * header.width + x) * 4
      if (header.colorType === 0) {
        const grey = sample(row, x, 0, header.channels, header.bitDepth)
        const byte = sampleToByte(grey, header.bitDepth)
        out[dst] = byte
        out[dst + 1] = byte
        out[dst + 2] = byte
        out[dst + 3] = grey === transparentGrey ? 0 : 255
      } else if (header.colorType === 2) {
        const rgb = [0, 1, 2].map((channel) =>
          sample(row, x, channel, header.channels, header.bitDepth))
        out[dst] = sampleToByte(rgb[0]!, header.bitDepth)
        out[dst + 1] = sampleToByte(rgb[1]!, header.bitDepth)
        out[dst + 2] = sampleToByte(rgb[2]!, header.bitDepth)
        out[dst + 3] = transparentRgb && rgb.every((value, i) => value === transparentRgb[i])
          ? 0
          : 255
      } else if (header.colorType === 3) {
        const index = sample(row, x, 0, 1, header.bitDepth)
        const paletteOffset = index * 3
        if (!palette || paletteOffset + 2 >= palette.length) {
          throw new Error(`indexed PNG pixel references missing palette entry ${index}`)
        }
        out[dst] = palette[paletteOffset]!
        out[dst + 1] = palette[paletteOffset + 1]!
        out[dst + 2] = palette[paletteOffset + 2]!
        out[dst + 3] = transparency?.[index] ?? 255
      } else if (header.colorType === 4) {
        const grey = sampleToByte(sample(row, x, 0, 2, header.bitDepth), header.bitDepth)
        out[dst] = grey
        out[dst + 1] = grey
        out[dst + 2] = grey
        out[dst + 3] = sampleToByte(sample(row, x, 1, 2, header.bitDepth), header.bitDepth)
      } else {
        out[dst] = sampleToByte(sample(row, x, 0, 4, header.bitDepth), header.bitDepth)
        out[dst + 1] = sampleToByte(sample(row, x, 1, 4, header.bitDepth), header.bitDepth)
        out[dst + 2] = sampleToByte(sample(row, x, 2, 4, header.bitDepth), header.bitDepth)
        out[dst + 3] = sampleToByte(sample(row, x, 3, 4, header.bitDepth), header.bitDepth)
      }
    }
  }
  return out
}

function sample(
  row: Buffer,
  x: number,
  channel: number,
  channels: number,
  bitDepth: number,
): number {
  if (bitDepth === 8) return row[x * channels + channel]!
  if (bitDepth === 16) return row.readUInt16BE((x * channels + channel) * 2)
  const bitOffset = x * bitDepth
  const shift = 8 - bitDepth - (bitOffset % 8)
  return (row[Math.floor(bitOffset / 8)]! >> shift) & ((1 << bitDepth) - 1)
}

function sampleToByte(value: number, bitDepth: number): number {
  if (bitDepth === 8) return value
  if (bitDepth === 16) return Math.round(value / 257)
  return Math.round((value * 255) / ((1 << bitDepth) - 1))
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
