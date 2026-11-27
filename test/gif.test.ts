import { describe, expect, it } from "vitest"
import { encodeGif } from "../src/gif.ts"

/** Reads back what encodeGif writes: the palette, and each frame's indices. */
function decode(gif: Buffer) {
  expect(gif.subarray(0, 6).toString("latin1")).toBe("GIF89a")
  const width = gif.readUInt16LE(6)
  const height = gif.readUInt16LE(8)
  const tableSize = 2 << (gif[10]! & 7)
  const palette = Array.from({ length: tableSize }, (_, i) => [...gif.subarray(13 + i * 3, 16 + i * 3)])
  let at = 13 + tableSize * 3
  const frames: { delay: number; indices: number[] }[] = []
  let delay = 0
  while (gif[at] !== 0x3b) {
    if (gif[at] === 0x21) {
      if (gif[at + 1] === 0xf9) delay = gif.readUInt16LE(at + 4)
      at += 2
      while (gif[at] !== 0) at += gif[at]! + 1
      at++
      continue
    }
    expect(gif[at]).toBe(0x2c)
    at += 10
    const minCode = gif[at++]!
    const data: number[] = []
    while (gif[at] !== 0) {
      data.push(...gif.subarray(at + 1, at + 1 + gif[at]!))
      at += gif[at]! + 1
    }
    at++
    const clear = 1 << minCode
    let size = minCode + 1
    let table: number[][] = []
    const reset = () => {
      table = Array.from({ length: clear + 2 }, (_, i) => [i])
      size = minCode + 1
    }
    reset()
    const indices: number[] = []
    let bit = 0
    let previous: number[] | null = null
    for (;;) {
      let code = 0
      for (let b = 0; b < size; b++, bit++) code |= ((data[bit >> 3]! >> (bit & 7)) & 1) << b
      if (code === clear) {
        reset()
        previous = null
        continue
      }
      if (code === clear + 1) break
      const entry: number[] = code < table.length ? table[code]! : [...previous!, previous![0]!]
      indices.push(...entry)
      if (previous && table.length < 4096) table.push([...previous, entry[0]!])
      if (table.length === 1 << size && size < 12) size++
      previous = entry
    }
    frames.push({ delay, indices })
  }
  return { width, height, palette, frames }
}

describe("GIF previews", () => {
  it("round-trips frames through one palette with index 0 transparent, looping at the given rate", () => {
    const width = 61
    const height = 47
    // Enough colours and noise to push the code width all the way to 12 and past a table reset.
    const frame = (seed: number) => {
      const pixels = Buffer.alloc(width * height * 4)
      for (let p = 0; p < width * height; p++) {
        const v = (p * 7919 + seed * 104729) % 200
        if (v < 20) continue
        pixels[p * 4] = v
        pixels[p * 4 + 1] = (v * 3) % 256
        pixels[p * 4 + 2] = (v * 5) % 256
        pixels[p * 4 + 3] = 255
      }
      return { width, height, pixels }
    }
    const frames = [frame(1), frame(2), frame(3)]
    const gif = encodeGif(frames, { delayMs: 125 })
    expect(gif.includes(Buffer.from("NETSCAPE2.0"))).toBe(true)
    const read = decode(gif)
    expect(read).toMatchObject({ width, height })
    expect(read.frames).toHaveLength(3)
    for (const [n, original] of frames.entries()) {
      expect(read.frames[n]!.delay).toBe(13)
      expect(read.frames[n]!.indices).toHaveLength(width * height)
      for (let p = 0; p < width * height; p += 37) {
        const index = read.frames[n]!.indices[p]!
        if (original.pixels[p * 4 + 3] === 0) expect(index).toBe(0)
        else expect(read.palette[index]).toEqual([...original.pixels.subarray(p * 4, p * 4 + 3)])
      }
    }
  })

  it("refuses frames of different sizes", () => {
    const one = { width: 2, height: 2, pixels: Buffer.alloc(16) }
    expect(() => encodeGif([one, { width: 3, height: 2, pixels: Buffer.alloc(24) }], { delayMs: 100 })).toThrow(/frame 1 is 3x2/)
  })
})
