import { decodePng } from "./png.ts"

export const MediaType = {
  PNG: "image/png",
  GIF: "image/gif",
} as const

export type MediaType = (typeof MediaType)[keyof typeof MediaType]

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

export function mediaExtension(mediaType: MediaType): ".png" | ".gif" {
  return mediaType === MediaType.GIF ? ".gif" : ".png"
}

export function mediaTypeFromExtension(file: string): MediaType | null {
  const lower = file.toLowerCase()
  if (lower.endsWith(".png")) return MediaType.PNG
  if (lower.endsWith(".gif")) return MediaType.GIF
  return null
}

export function detectMediaType(bytes: Buffer): MediaType | null {
  if (bytes.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)) return MediaType.PNG
  const header = bytes.subarray(0, 6).toString("ascii")
  if (header === "GIF87a" || header === "GIF89a") return MediaType.GIF
  return null
}

/** Validate durable provider output before it reaches disk or the recovery cache. */
export function validateMedia(bytes: Buffer, expected?: MediaType): MediaType {
  const actual = detectMediaType(bytes)
  if (!actual) throw new Error(`response was not a supported PNG or GIF (${bytes.length} bytes)`)
  if (expected && actual !== expected) {
    throw new Error(`response was ${actual}, expected ${expected}`)
  }
  if (actual === MediaType.PNG) {
    decodePng(bytes)
  } else {
    validateGif(bytes)
  }
  return actual
}

/** Walk GIF blocks far enough to reject truncated/error-page payloads. */
function validateGif(bytes: Buffer): void {
  if (bytes.length < 14) throw new Error("invalid GIF: truncated logical screen descriptor")
  const width = bytes.readUInt16LE(6)
  const height = bytes.readUInt16LE(8)
  if (!width || !height) throw new Error("invalid GIF: zero-sized logical screen")

  const packed = bytes[10]!
  let offset = 13
  if (packed & 0x80) offset += 3 * 2 ** ((packed & 0x07) + 1)
  if (offset > bytes.length) throw new Error("invalid GIF: truncated global color table")

  let sawImage = false
  while (offset < bytes.length) {
    const marker = bytes[offset]!
    if (marker === 0x3b) {
      if (!sawImage) throw new Error("invalid GIF: contains no image frame")
      return
    }
    if (marker === 0x2c) {
      if (offset + 10 > bytes.length) throw new Error("invalid GIF: truncated image descriptor")
      const imagePacked = bytes[offset + 9]!
      offset += 10
      if (imagePacked & 0x80) offset += 3 * 2 ** ((imagePacked & 0x07) + 1)
      if (offset >= bytes.length) throw new Error("invalid GIF: missing image data")
      offset++ // LZW minimum code size
      offset = skipSubBlocks(bytes, offset)
      sawImage = true
      continue
    }
    if (marker === 0x21) {
      if (offset + 2 > bytes.length) throw new Error("invalid GIF: truncated extension")
      offset = skipSubBlocks(bytes, offset + 2)
      continue
    }
    throw new Error(`invalid GIF: unexpected block marker 0x${marker.toString(16)}`)
  }
  throw new Error("invalid GIF: missing trailer")
}

function skipSubBlocks(bytes: Buffer, start: number): number {
  let offset = start
  for (;;) {
    if (offset >= bytes.length) throw new Error("invalid GIF: truncated data blocks")
    const size = bytes[offset]!
    offset++
    if (size === 0) return offset
    offset += size
    if (offset > bytes.length) throw new Error("invalid GIF: truncated data block")
  }
}

export function cacheFileName(hash: string, mediaType: MediaType = MediaType.PNG): string {
  return `${hash}${mediaExtension(mediaType)}`
}
