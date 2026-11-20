/**
 * A baseline JPEG decoder with no dependency, for the one place PixelKiln
 * meets JPEG: textures embedded in a `.glb`, which an author paints as PNG.
 *
 * It reads sequential Huffman JPEG (SOF0 and SOF1) in grey or YCbCr with any
 * chroma subsampling and restart intervals, which is what image libraries and
 * 3D tools write by default. Progressive, arithmetic-coded, lossless, and
 * CMYK files are refused with the reason, rather than decoded wrongly.
 * Subsampled chroma is interpolated between sample centres; the output is
 * RGBA, opaque.
 */
export interface DecodedJpeg {
  width: number
  height: number
  /** RGBA, row-major, four bytes per pixel. */
  pixels: Buffer
}

const ZIGZAG = [
  0, 1, 8, 16, 9, 2, 3, 10, 17, 24, 32, 25, 18, 11, 4, 5, 12, 19, 26, 33, 40, 48, 41, 34, 27, 20, 13, 6, 7, 14, 21, 28,
  35, 42, 49, 56, 57, 50, 43, 36, 29, 22, 15, 23, 30, 37, 44, 51, 58, 59, 52, 45, 38, 31, 39, 46, 53, 60, 61, 54, 47, 55, 62, 63,
]

interface Huffman {
  /** code → value, keyed by (length << 16) | code. */
  lookup: Map<number, number>
  maxLength: number
}

interface Component {
  id: number
  h: number
  v: number
  quant: number
  dc: number
  ac: number
  /** Decoded samples for the whole padded image of this component. */
  samples: Uint8ClampedArray
  /** Width in blocks of the padded component plane. */
  blocksWide: number
  blocksHigh: number
  previousDc: number
}

function buildHuffman(lengths: number[], values: number[]): Huffman {
  const lookup = new Map<number, number>()
  let code = 0
  let at = 0
  let maxLength = 0
  for (let length = 1; length <= 16; length++) {
    for (let i = 0; i < lengths[length - 1]!; i++) {
      lookup.set((length << 16) | code, values[at++]!)
      maxLength = length
      code++
    }
    code <<= 1
  }
  return { lookup, maxLength }
}

// Separable inverse DCT, with the cosine table computed once.
const COS = new Float64Array(64)
for (let x = 0; x < 8; x++) for (let u = 0; u < 8; u++) COS[x * 8 + u] = (u === 0 ? Math.SQRT1_2 : 1) * Math.cos(((2 * x + 1) * u * Math.PI) / 16)

function idct(input: Float64Array, out: Uint8ClampedArray, outOffset: number, stride: number, temp: Float64Array) {
  for (let y = 0; y < 8; y++) {
    for (let x = 0; x < 8; x++) {
      let sum = 0
      for (let u = 0; u < 8; u++) sum += COS[x * 8 + u]! * input[y * 8 + u]!
      temp[y * 8 + x] = sum / 2
    }
  }
  for (let x = 0; x < 8; x++) {
    for (let y = 0; y < 8; y++) {
      let sum = 0
      for (let v = 0; v < 8; v++) sum += COS[y * 8 + v]! * temp[v * 8 + x]!
      out[outOffset + y * stride + x] = sum / 2 + 128
    }
  }
}

export function decodeJpeg(bytes: Uint8Array): DecodedJpeg {
  const fail = (why: string): never => { throw new Error(`invalid JPEG: ${why}`) }
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) fail("missing the start-of-image marker")
  const quant: Array<Int32Array | undefined> = []
  const dcTables: Array<Huffman | undefined> = []
  const acTables: Array<Huffman | undefined> = []
  let components: Component[] = []
  let width = 0
  let height = 0
  let hMax = 1
  let vMax = 1
  let restartInterval = 0
  let adobeTransform: number | null = null
  let offset = 2
  let scanned = false
  const u16 = (at: number) => (bytes[at]! << 8) | bytes[at + 1]!

  while (offset < bytes.length) {
    if (bytes[offset] !== 0xff) fail(`expected a marker at byte ${offset}`)
    const marker = bytes[offset + 1]!
    offset += 2
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0xff) { if (marker === 0xff) offset--; continue }
    if (marker === 0xd9) break
    if (offset + 2 > bytes.length) fail("truncated segment")
    const length = u16(offset)
    const segment = offset + 2
    const end = offset + length
    if (end > bytes.length) fail("a segment runs past the end of the file")
    switch (marker) {
      case 0xdb: { // quantisation tables
        let at = segment
        while (at < end) {
          const precision = bytes[at]! >> 4
          const id = bytes[at]! & 15
          at++
          const table = new Int32Array(64)
          for (let i = 0; i < 64; i++) {
            table[ZIGZAG[i]!] = precision ? u16(at + i * 2) : bytes[at + i]!
          }
          at += precision ? 128 : 64
          quant[id] = table
        }
        break
      }
      case 0xc4: { // Huffman tables
        let at = segment
        while (at < end) {
          const kind = bytes[at]! >> 4
          const id = bytes[at]! & 15
          const lengths = Array.from(bytes.subarray(at + 1, at + 17))
          const total = lengths.reduce((sum, n) => sum + n, 0)
          const values = Array.from(bytes.subarray(at + 17, at + 17 + total))
          at += 17 + total
          ;(kind ? acTables : dcTables)[id] = buildHuffman(lengths, values)
        }
        break
      }
      case 0xc0: case 0xc1: { // baseline and extended sequential frames
        if (bytes[segment] !== 8) fail(`${bytes[segment]}-bit samples are not supported`)
        height = u16(segment + 1)
        width = u16(segment + 3)
        const count = bytes[segment + 5]!
        if (!width || !height) fail("zero-sized image")
        if (count !== 1 && count !== 3) fail(`${count} colour components; only grey and YCbCr are supported`)
        components = []
        for (let i = 0; i < count; i++) {
          const at = segment + 6 + i * 3
          components.push({
            id: bytes[at]!, h: bytes[at + 1]! >> 4, v: bytes[at + 1]! & 15, quant: bytes[at + 2]!,
            dc: 0, ac: 0, samples: new Uint8ClampedArray(0), blocksWide: 0, blocksHigh: 0, previousDc: 0,
          })
        }
        hMax = Math.max(...components.map((c) => c.h))
        vMax = Math.max(...components.map((c) => c.v))
        const mcusWide = Math.ceil(width / (8 * hMax))
        const mcusHigh = Math.ceil(height / (8 * vMax))
        for (const c of components) {
          c.blocksWide = mcusWide * c.h
          c.blocksHigh = mcusHigh * c.v
          c.samples = new Uint8ClampedArray(c.blocksWide * 8 * c.blocksHigh * 8)
        }
        break
      }
      case 0xc2: case 0xc6: case 0xca: case 0xce:
        fail("progressive JPEG is not supported; re-save the texture as baseline JPEG or PNG")
        break
      case 0xc3: case 0xc5: case 0xc7: case 0xc9: case 0xcb: case 0xcd: case 0xcf:
        fail("lossless and arithmetic-coded JPEG are not supported")
        break
      case 0xdd:
        restartInterval = u16(segment)
        break
      case 0xee: // Adobe: says whether three components are YCbCr or RGB
        if (length >= 12 && String.fromCharCode(...bytes.subarray(segment, segment + 5)) === "Adobe") adobeTransform = bytes[segment + 11]!
        break
      case 0xda: { // start of scan
        if (!components.length) fail("scan before frame header")
        const count = bytes[segment]!
        const scan: Component[] = []
        for (let i = 0; i < count; i++) {
          const id = bytes[segment + 1 + i * 2]!
          const tables = bytes[segment + 2 + i * 2]!
          const component = components.find((c) => c.id === id) ?? fail(`scan names unknown component ${id}`)
          component.dc = tables >> 4
          component.ac = tables & 15
          scan.push(component)
        }
        offset = decodeScan(bytes, end, scan, components.length, hMax, vMax, width, height, restartInterval, quant, dcTables, acTables, fail)
        scanned = true
        continue
      }
      default:
        break
    }
    offset = end
  }
  if (!scanned) fail("no image data")

  const pixels = Buffer.alloc(width * height * 4)
  const grey = components.length === 1
  const rgb = !grey && adobeTransform === 0
  const planes = components.map((c) => ({ c, stride: c.blocksWide * 8, sx: c.h / hMax, sy: c.v / vMax }))
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const at = (y * width + x) * 4
      // Full-resolution planes are read as they are; subsampled ones between their sample centres, bilinearly.
      const sample = (i: number) => {
        const p = planes[i]!
        if (p.sx === 1 && p.sy === 1) return p.c.samples[y * p.stride + x]!
        const fx = Math.max(0, (x + 0.5) * p.sx - 0.5), fy = Math.max(0, (y + 0.5) * p.sy - 0.5)
        const x0 = Math.floor(fx), y0 = Math.floor(fy)
        const x1 = Math.min(x0 + 1, Math.ceil(width * p.sx) - 1), y1 = Math.min(y0 + 1, Math.ceil(height * p.sy) - 1)
        const tx = fx - x0, ty = fy - y0
        const at = (sx: number, sy: number) => p.c.samples[sy * p.stride + sx]!
        return (at(x0, y0) * (1 - tx) + at(x1, y0) * tx) * (1 - ty) + (at(x0, y1) * (1 - tx) + at(x1, y1) * tx) * ty
      }
      if (grey) {
        const value = sample(0)
        pixels[at] = pixels[at + 1] = pixels[at + 2] = value
      } else if (rgb) {
        pixels[at] = sample(0); pixels[at + 1] = sample(1); pixels[at + 2] = sample(2)
      } else {
        const Y = sample(0), Cb = sample(1) - 128, Cr = sample(2) - 128
        pixels[at] = clamp(Y + 1.402 * Cr)
        pixels[at + 1] = clamp(Y - 0.344136 * Cb - 0.714136 * Cr)
        pixels[at + 2] = clamp(Y + 1.772 * Cb)
      }
      pixels[at + 3] = 255
    }
  }
  return { width, height, pixels }
}

const clamp = (value: number) => (value < 0 ? 0 : value > 255 ? 255 : Math.round(value))

function decodeScan(
  bytes: Uint8Array,
  start: number,
  scan: Component[],
  frameComponents: number,
  hMax: number,
  vMax: number,
  width: number,
  height: number,
  restartInterval: number,
  quant: Array<Int32Array | undefined>,
  dcTables: Array<Huffman | undefined>,
  acTables: Array<Huffman | undefined>,
  fail: (why: string) => never,
): number {
  let offset = start
  let bitBuffer = 0
  let bitCount = 0
  let hitMarker = false
  const readBit = (): number => {
    if (bitCount === 0) {
      if (hitMarker || offset >= bytes.length) { bitBuffer = 0; bitCount = 8; } else {
        let byte = bytes[offset++]!
        if (byte === 0xff) {
          const next = bytes[offset]
          if (next === 0x00) offset++
          else { hitMarker = true; offset--; byte = 0 }
        }
        bitBuffer = byte
        bitCount = 8
      }
    }
    bitCount--
    return (bitBuffer >> bitCount) & 1
  }
  const receive = (length: number) => {
    let value = 0
    for (let i = 0; i < length; i++) value = (value << 1) | readBit()
    return value
  }
  const extend = (value: number, length: number) => (length && value < 1 << (length - 1) ? value - (1 << length) + 1 : value)
  const decode = (table: Huffman): number => {
    let code = 0
    for (let length = 1; length <= table.maxLength; length++) {
      code = (code << 1) | readBit()
      const value = table.lookup.get((length << 16) | code)
      if (value !== undefined) return value
    }
    return fail("corrupt Huffman data")
  }
  const coefficients = new Float64Array(64)
  const temp = new Float64Array(64)
  const decodeBlock = (c: Component, blockRow: number, blockColumn: number) => {
    const dcTable = dcTables[c.dc] ?? fail(`missing DC table ${c.dc}`)
    const acTable = acTables[c.ac] ?? fail(`missing AC table ${c.ac}`)
    const q = quant[c.quant] ?? fail(`missing quantisation table ${c.quant}`)
    coefficients.fill(0)
    const t = decode(dcTable)
    const diff = t ? extend(receive(t), t) : 0
    c.previousDc += diff
    coefficients[0] = c.previousDc * q[0]!
    for (let k = 1; k < 64;) {
      const rs = decode(acTable)
      const s = rs & 15
      const r = rs >> 4
      if (s === 0) {
        if (r === 15) { k += 16; continue }
        break
      }
      k += r
      if (k > 63) break
      const z = ZIGZAG[k]!
      coefficients[z] = extend(receive(s), s) * q[z]!
      k++
    }
    if (blockRow >= c.blocksHigh || blockColumn >= c.blocksWide) return
    const stride = c.blocksWide * 8
    idct(coefficients, c.samples, blockRow * 8 * stride + blockColumn * 8, stride, temp)
  }

  const single = scan.length === 1
  // A scan of one component is not interleaved: its blocks run in raster order over that component alone.
  const units = single
    ? Math.ceil((Math.ceil((width * scan[0]!.h) / hMax)) / 8) * Math.ceil((Math.ceil((height * scan[0]!.v) / vMax)) / 8)
    : Math.ceil(width / (8 * hMax)) * Math.ceil(height / (8 * vMax))
  const unitsWide = single ? Math.ceil(Math.ceil((width * scan[0]!.h) / hMax) / 8) : Math.ceil(width / (8 * hMax))
  if (frameComponents > 1 && single) {
    // Allowed by the standard, rare in practice; handled by the same raster walk.
  }
  for (let unit = 0; unit < units; unit++) {
    if (restartInterval && unit > 0 && unit % restartInterval === 0) {
      // Skip to the restart marker and reset the predictors.
      bitCount = 0
      hitMarker = false
      while (offset + 1 < bytes.length && !(bytes[offset] === 0xff && bytes[offset + 1]! >= 0xd0 && bytes[offset + 1]! <= 0xd7)) offset++
      offset += 2
      for (const c of scan) c.previousDc = 0
    }
    const row = Math.floor(unit / unitsWide)
    const column = unit % unitsWide
    if (single) decodeBlock(scan[0]!, row, column)
    else for (const c of scan) for (let v = 0; v < c.v; v++) for (let h = 0; h < c.h; h++) decodeBlock(c, row * c.v + v, column * c.h + h)
  }
  // Find the next marker after the entropy-coded data.
  while (offset + 1 < bytes.length && !(bytes[offset] === 0xff && bytes[offset + 1] !== 0x00 && !(bytes[offset + 1]! >= 0xd0 && bytes[offset + 1]! <= 0xd7))) offset++
  return offset
}
