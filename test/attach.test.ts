import { describe, expect, it } from "vitest"
import { attachFrame, gripPoint, handPlacement, heldAngle, parseAnchorsFile, rotateAbout } from "../src/attach.ts"
import { decodePng, encodeRgbaPng, type DecodedPng } from "../src/png.ts"
import { SKELETON_LABELS } from "../src/skeleton.ts"

type Pixel = [number, number, number, number]
const CLEAR: Pixel = [0, 0, 0, 0]
const STEEL: Pixel = [180, 190, 200, 255]
const GRIP: Pixel = [120, 80, 40, 255]
const SKIN: Pixel = [220, 170, 140, 255]

function draw(rows: string[], colours: Record<string, Pixel>): Buffer {
  const width = rows[0]!.length
  const pixels = Buffer.alloc(width * rows.length * 4)
  rows.forEach((row, y) => [...row].forEach((char, x) => Buffer.from(colours[char] ?? CLEAR).copy(pixels, (y * width + x) * 4)))
  return encodeRgbaPng(width, rows.length, pixels)
}
const pixel = (image: DecodedPng, x: number, y: number) => [...image.pixels.subarray((y * image.width + x) * 4, (y * image.width + x) * 4 + 4)]

/** A skeleton with every joint in the middle, then the named ones moved. */
function skeleton(moved: Record<string, { x: number; y: number; z_index?: number }>) {
  return SKELETON_LABELS.map((label) => ({ label, x: 0.5, y: 0.5, z_index: 0, ...moved[label] }))
}

// Upright, handle down: a 1px blade over a 1px grip, 5 tall on a 3x5 canvas.
const SWORD = draw([".s.", ".s.", ".s.", ".g.", ".g."], { s: STEEL, g: GRIP })

describe("held items", () => {
  it("puts the hand a little past the wrist, behind the body when the wrist is", () => {
    const frame = { width: 20, height: 20, keypoints: skeleton({ "RIGHT ELBOW": { x: 0.5, y: 0.25 }, "RIGHT ARM": { x: 0.5, y: 0.5 }, "LEFT ELBOW": { x: 0.2, y: 0.5 }, "LEFT ARM": { x: 0.2, y: 0.5, z_index: -2 } }) }
    // Wrist at y 10, forearm 5 long: the palm is 35% of that further on.
    expect(handPlacement(frame, "right-hand")).toEqual({ x: 10, y: 11.75, behind: false })
    expect(handPlacement(frame, "left-hand")).toMatchObject({ x: 4, behind: true })
    // The author's own position wins, and keeps the estimate's depth unless it says.
    expect(handPlacement({ ...frame, place: { "left-hand": { x: 3, y: 9 } } }, "left-hand")).toEqual({ x: 3, y: 9, behind: true })
    expect(handPlacement({ ...frame, place: { "left-hand": { x: 3, y: 9, behind: false, angle: 20 } } }, "left-hand")).toEqual({ x: 3, y: 9, behind: false, angle: 20 })
  })

  it("leans an item the way the figure faces from the side, and outward from the front", () => {
    expect(heldAngle("east", "right-hand", 40, 15)).toBeCloseTo(40)
    expect(heldAngle("west", "right-hand", 40, 15)).toBeCloseTo(-40)
    // Facing the viewer the right hand is on screen-left, so outward is anticlockwise.
    expect(heldAngle("south", "right-hand", 40, 15)).toBeCloseTo(-15)
    expect(heldAngle("south", "left-hand", 40, 15)).toBeCloseTo(15)
    expect(heldAngle("north", "right-hand", 40, 15)).toBeCloseTo(15)
    expect(heldAngle("south-east", "right-hand", 40, 0)).toBeCloseTo(40 * Math.SQRT1_2)
  })

  it("finds the grip in an item's lowest fifth, upright or leaning", () => {
    expect(gripPoint(decodePng(SWORD))).toEqual({ x: 1, y: 4 })
    const leaning = draw(["....s", "...s.", "..s..", ".g...", "g...."], { s: STEEL, g: GRIP })
    expect(gripPoint(decodePng(leaning))).toEqual({ x: 0, y: 4 })
    expect(() => gripPoint(decodePng(draw(["..", ".."], {})))).toThrow(/no opaque pixels/)
  })

  it("turns an item about its grip with no new colours", () => {
    const item = decodePng(SWORD)
    const same = rotateAbout(item, { x: 1, y: 4 }, 0)
    expect(same.image).toBe(item)
    // A quarter turn clockwise lays the blade out to the right of the grip.
    const turned = rotateAbout(item, { x: 1, y: 4 }, 90)
    const { x, y } = turned.pivot
    expect(pixel(turned.image, x, y)).toEqual(GRIP)
    expect(pixel(turned.image, x + 1, y)).toEqual(GRIP)
    expect(pixel(turned.image, x + 4, y)).toEqual(STEEL)
    expect(pixel(turned.image, x, y - 2)).toEqual(CLEAR)
    let opaque = 0
    for (let i = 3; i < turned.image.pixels.length; i += 4) if (turned.image.pixels[i]) opaque++
    expect(opaque).toBe(5)
  })

  it("pins the grip to the hand on a canvas grown by the padding", () => {
    const body = draw(Array.from({ length: 8 }, () => "........"), {})
    const placed = attachFrame(body, SWORD, { placement: { x: 4, y: 6, behind: false }, padding: 2 })
    const layer = decodePng(placed.png)
    expect(layer).toMatchObject({ width: 12, height: 12 })
    // Frame (4,6) is canvas (6,8): the grip's lowest pixel. The blade runs up from it.
    expect(pixel(layer, 6, 8)).toEqual(GRIP)
    expect(pixel(layer, 6, 4)).toEqual(STEEL)
    expect(pixel(layer, 5, 8)).toEqual(CLEAR)
    expect(placed.clipped).toBe(0)
    // Held near the top with no padding, the blade runs off the canvas and is counted.
    expect(attachFrame(body, SWORD, { placement: { x: 4, y: 2, behind: false }, padding: 0 }).clipped).toBe(2)
  })

  it("leaves out what the body covers when the item is behind it", () => {
    const body = draw(["....", "bbbb", "bbbb", "....", "....", "...."], { b: SKIN })
    const front = decodePng(attachFrame(body, SWORD, { placement: { x: 1, y: 4, behind: false }, padding: 0 }).png)
    expect(pixel(front, 1, 1)).toEqual(STEEL)
    const behind = decodePng(attachFrame(body, SWORD, { placement: { x: 1, y: 4, behind: true }, padding: 0 }).png)
    expect(pixel(behind, 1, 0)).toEqual(STEEL)
    expect(pixel(behind, 1, 1)).toEqual(CLEAR)
    expect(pixel(behind, 1, 2)).toEqual(CLEAR)
    expect(pixel(behind, 1, 4)).toEqual(GRIP)
  })

  it("refuses an anchors file that is not one, naming where", () => {
    expect(() => parseAnchorsFile({ version: 2, frames: {} }, "anchors.json")).toThrow(/anchors\.json is not an anchors file: version/)
    expect(parseAnchorsFile({ version: 1, frames: {} }, "anchors.json")).toEqual({ version: 1, frames: {} })
  })
})
