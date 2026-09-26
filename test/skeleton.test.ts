import { describe, expect, it } from "vitest"
import { SkeletonFrameSchema, SkeletonKeypointSchema, SkeletonSetSchema, parseSkeletonSet } from "../src/skeleton.ts"

const joint = (overrides: Partial<{ label: string; x: number; y: number; z_index: number; depth: number }> = {}) => ({
  label: "RIGHT KNEE",
  x: 0.52,
  y: 0.71,
  z_index: 9,
  ...overrides,
})
const frame = (n = 18) => Array.from({ length: n }, (_, i) => joint({ label: `JOINT_${i}` }))

describe("SkeletonKeypointSchema", () => {
  it("accepts a joint matching PixelLab's own documented example, depth omitted", () => {
    expect(SkeletonKeypointSchema.safeParse(joint()).success).toBe(true)
  })

  it("accepts an optional depth", () => {
    expect(SkeletonKeypointSchema.safeParse(joint({ depth: 4 })).success).toBe(true)
  })

  it("rejects x/y outside 0-1", () => {
    expect(SkeletonKeypointSchema.safeParse(joint({ x: 1.5 })).success).toBe(false)
    expect(SkeletonKeypointSchema.safeParse(joint({ y: -0.1 })).success).toBe(false)
  })

  it("rejects an empty label", () => {
    expect(SkeletonKeypointSchema.safeParse(joint({ label: "" })).success).toBe(false)
  })

  it("rejects unknown fields", () => {
    expect(SkeletonKeypointSchema.safeParse({ ...joint(), extra: true }).success).toBe(false)
  })
})

describe("SkeletonFrameSchema", () => {
  it("requires exactly 18 joints", () => {
    expect(SkeletonFrameSchema.safeParse(frame(18)).success).toBe(true)
    expect(SkeletonFrameSchema.safeParse(frame(17)).success).toBe(false)
    expect(SkeletonFrameSchema.safeParse(frame(19)).success).toBe(false)
  })
})

describe("SkeletonSetSchema", () => {
  it("accepts 3 to 15 frames", () => {
    expect(SkeletonSetSchema.safeParse({ firstFrameKeypoints: frame(), frames: [frame(), frame(), frame()] }).success).toBe(true)
    expect(SkeletonSetSchema.safeParse({ firstFrameKeypoints: frame(), frames: Array.from({ length: 15 }, () => frame()) }).success).toBe(true)
  })

  it("rejects fewer than 3 or more than 15 frames", () => {
    expect(SkeletonSetSchema.safeParse({ firstFrameKeypoints: frame(), frames: [frame(), frame()] }).success).toBe(false)
    expect(SkeletonSetSchema.safeParse({ firstFrameKeypoints: frame(), frames: Array.from({ length: 16 }, () => frame()) }).success).toBe(false)
  })

  it("requires firstFrameKeypoints", () => {
    expect(SkeletonSetSchema.safeParse({ frames: [frame(), frame(), frame()] }).success).toBe(false)
  })
})

describe("parseSkeletonSet", () => {
  it("returns the parsed set for valid JSON", () => {
    const json = { firstFrameKeypoints: frame(), frames: [frame(), frame(), frame()] }
    expect(parseSkeletonSet(json, "poses.json")).toEqual(json)
  })

  it("throws naming the file and the first few issues for an invalid shape", () => {
    expect(() => parseSkeletonSet({ firstFrameKeypoints: frame(), frames: [] }, "poses.json"))
      .toThrow(/revision keypoints file poses\.json does not match the expected shape: frames:/)
  })

  it("throws for JSON that isn't even an object", () => {
    expect(() => parseSkeletonSet("not an object", "poses.json"))
      .toThrow(/revision keypoints file poses\.json does not match the expected shape/)
  })
})
