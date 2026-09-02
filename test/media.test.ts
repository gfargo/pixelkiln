import { describe, expect, it } from "vitest"
import {
  cacheFileName,
  detectMediaType,
  mediaExtension,
  MediaType,
  validateMedia,
} from "../src/media.ts"
import { FAKE_PNG } from "../src/providers/fake.ts"

export const MINIMAL_GIF = Buffer.from(
  "R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==",
  "base64",
)

describe("typed generated media", () => {
  it("recognizes and structurally validates PNG and GIF output", () => {
    expect(validateMedia(FAKE_PNG)).toBe(MediaType.PNG)
    expect(validateMedia(MINIMAL_GIF)).toBe(MediaType.GIF)
    expect(detectMediaType(MINIMAL_GIF)).toBe(MediaType.GIF)
  })

  it("rejects truncated GIF bytes before they reach the durable cache", () => {
    expect(() => validateMedia(MINIMAL_GIF.subarray(0, -1), MediaType.GIF)).toThrow(
      /missing trailer/,
    )
  })

  it("uses the media type in cache and destination extensions", () => {
    expect(mediaExtension(MediaType.GIF)).toBe(".gif")
    expect(cacheFileName("abc", MediaType.GIF)).toBe("abc.gif")
    expect(cacheFileName("abc", MediaType.PNG)).toBe("abc.png")
  })
})
