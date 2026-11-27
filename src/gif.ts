import type { DecodedPng } from "./png.ts"

/**
 * A looping GIF of RGBA frames of one size, for previews. Every frame shares
 * one palette with index 0 transparent; pixel art seldom has more than 255
 * colours, and past that the rarest are mapped to the nearest kept one. Each
 * frame replaces the last (disposal 2), so a transparent pixel shows nothing
 * of the frame before it.
 */
export function encodeGif(frames: DecodedPng[], options: { delayMs: number }): Buffer {
  if (!frames.length) throw new Error("a GIF needs at least one frame")
  const { width, height } = frames[0]!
  for (const [index, frame] of frames.entries()) {
    if (frame.width !== width || frame.height !== height) {
      throw new Error(`frame ${index} is ${frame.width}x${frame.height}; frame 0 is ${width}x${height}`)
    }
  }
  // Colours by use, most used first, so a palette that must be cut drops the rarest.
  const counts = new Map<number, number>()
  for (const frame of frames) {
    for (let i = 0; i < frame.pixels.length; i += 4) {
      if (frame.pixels[i + 3]! < 128) continue
      const rgb = (frame.pixels[i]! << 16) | (frame.pixels[i + 1]! << 8) | frame.pixels[i + 2]!
      counts.set(rgb, (counts.get(rgb) ?? 0) + 1)
    }
  }
  const kept = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0] - b[0]).slice(0, 255).map(([rgb]) => rgb)
  const indexOf = new Map(kept.map((rgb, index) => [rgb, index + 1]))
  const nearest = (rgb: number) => {
    let hit = indexOf.get(rgb)
    if (hit !== undefined) return hit
    let best = Infinity
    for (const [index, colour] of kept.entries()) {
      const apart = (((colour >> 16) & 255) - ((rgb >> 16) & 255)) ** 2 + (((colour >> 8) & 255) - ((rgb >> 8) & 255)) ** 2 + ((colour & 255) - (rgb & 255)) ** 2
      if (apart < best) {
        best = apart
        hit = index + 1
      }
    }
    indexOf.set(rgb, hit!)
    return hit!
  }
  let bits = 1
  while (1 << bits < kept.length + 1) bits++
  const tableSize = 1 << bits

  const out: number[] = []
  const bytes = (...values: number[]) => out.push(...values)
  const word = (value: number) => bytes(value & 255, (value >> 8) & 255)
  for (const char of "GIF89a") bytes(char.charCodeAt(0))
  word(width)
  word(height)
  bytes(0x80 | ((bits - 1) << 4) | (bits - 1), 0, 0)
  for (let index = 0; index < tableSize; index++) {
    const rgb = index === 0 ? 0 : kept[index - 1] ?? 0
    bytes((rgb >> 16) & 255, (rgb >> 8) & 255, rgb & 255)
  }
  // Loop forever.
  bytes(0x21, 0xff, 11, ...[..."NETSCAPE2.0"].map((char) => char.charCodeAt(0)), 3, 1, 0, 0, 0)
  const delay = Math.max(2, Math.round(options.delayMs / 10))
  for (const frame of frames) {
    bytes(0x21, 0xf9, 4, (2 << 2) | 1)
    word(delay)
    bytes(0, 0)
    bytes(0x2c)
    word(0)
    word(0)
    word(width)
    word(height)
    bytes(0)
    const indices = new Uint8Array(width * height)
    for (let p = 0; p < indices.length; p++) {
      const i = p * 4
      if (frame.pixels[i + 3]! < 128) continue
      indices[p] = nearest((frame.pixels[i]! << 16) | (frame.pixels[i + 1]! << 8) | frame.pixels[i + 2]!)
    }
    const minCode = Math.max(2, bits)
    bytes(minCode)
    const data = lzw(indices, minCode)
    for (let start = 0; start < data.length; start += 255) {
      const block = data.subarray(start, start + 255)
      bytes(block.length, ...block)
    }
    bytes(0)
  }
  bytes(0x3b)
  return Buffer.from(out)
}

/** GIF's variable-width LZW over palette indices. */
function lzw(indices: Uint8Array, minCode: number): Uint8Array {
  const clear = 1 << minCode
  const end = clear + 1
  const out: number[] = []
  let buffer = 0
  let filled = 0
  let size = minCode + 1
  const emit = (code: number) => {
    buffer |= code << filled
    filled += size
    while (filled >= 8) {
      out.push(buffer & 255)
      buffer >>>= 8
      filled -= 8
    }
  }
  let table = new Map<number, number>()
  let next = end + 1
  emit(clear)
  let prefix = indices[0]!
  for (let p = 1; p < indices.length; p++) {
    const symbol = indices[p]!
    const key = (prefix << 8) | symbol
    const known = table.get(key)
    if (known !== undefined) {
      prefix = known
      continue
    }
    emit(prefix)
    if (next < 4096) {
      table.set(key, next++)
      // The decoder widens its codes one entry later than the encoder adds them.
      if (next > 1 << size && size < 12) size++
    } else {
      emit(clear)
      table = new Map()
      next = end + 1
      size = minCode + 1
    }
    prefix = symbol
  }
  emit(prefix)
  emit(end)
  if (filled > 0) out.push(buffer & 255)
  return Uint8Array.from(out)
}
