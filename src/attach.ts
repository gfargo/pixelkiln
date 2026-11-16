/**
 * Held items: a rigid sprite (a sword, a shield, a lantern) pinned to a hand
 * in every frame of a character, as a paperdoll layer.
 *
 * An inpainted layer redraws the item per frame, so it drifts and can change
 * hands. A held item is drawn once per direction and placed, so it is the
 * same pixels in every frame. Where it goes comes from an anchors file: each
 * frame's skeleton, estimated once per character (`pixelkiln anchors`) and
 * reused by every item that character holds.
 *
 * Everything here is pure: bytes in, bytes out.
 */
import { z } from "zod"
import { decodePng, encodeRgbaPng, type DecodedPng } from "./png.ts"
import { SkeletonFrameSchema, type SkeletonKeypoint } from "./skeleton.ts"
import { ATTACH_JOINTS, CHARACTER_DIRECTIONS_8, type AttachJoint, type CharacterDirection, type ResolvedSpec } from "./types.ts"

/** Where an item sits in one frame: the hand in frame pixels, and whether the body covers it. */
export interface Placement {
  x: number
  y: number
  behind: boolean
  /** Extra clockwise degrees for this frame alone, on top of the layer's tilt and lean. */
  angle?: number
}

const PlacementSchema = z
  .object({
    x: z.number(),
    y: z.number(),
    behind: z.boolean().optional(),
    angle: z.number().min(-360).max(360).optional(),
  })
  .strict()

/**
 * One frame's entry in an anchors file. `sha256` is the frame the skeleton
 * was estimated from, so a regenerated frame is caught instead of silently
 * holding its item where the old pose had its hand. `place` is the author's
 * correction for a joint, in frame pixels; it wins over the skeleton.
 */
export const AnchorFrameSchema = z
  .object({
    sha256: z.string().regex(/^[0-9a-f]{64}$/),
    width: z.number().int().positive(),
    height: z.number().int().positive(),
    keypoints: SkeletonFrameSchema,
    place: z.record(z.enum(ATTACH_JOINTS), PlacementSchema).optional(),
  })
  .strict()
export type AnchorFrame = z.infer<typeof AnchorFrameSchema>

/** An anchors file: asset id, then frame role, then that frame's skeleton. */
export const AnchorsFileSchema = z
  .object({
    version: z.literal(1),
    frames: z.record(z.string().min(1), z.record(z.string().min(1), AnchorFrameSchema)),
  })
  .strict()
export type AnchorsFile = z.infer<typeof AnchorsFileSchema>

export function parseAnchorsFile(json: unknown, label: string): AnchorsFile {
  const parsed = AnchorsFileSchema.safeParse(json)
  if (!parsed.success) {
    const issue = parsed.error.issues[0]!
    throw new Error(`${label} is not an anchors file: ${issue.path.join(".") || "(root)"}: ${issue.message}`)
  }
  return parsed.data
}

/** How far past the wrist the palm is, as a share of the forearm. */
const REACH = 0.35

/**
 * The hand a skeleton implies: PixelLab's arm joint is the wrist, so the palm
 * is a little further along the forearm. The body covers the hand when the
 * estimate puts the wrist behind the figure's plane.
 */
export function handPlacement(frame: Pick<AnchorFrame, "width" | "height" | "keypoints" | "place">, joint: AttachJoint): Placement {
  const placed = frame.place?.[joint]
  const side = joint === "right-hand" ? "RIGHT" : "LEFT"
  const find = (label: string): SkeletonKeypoint => {
    const point = frame.keypoints.find((candidate) => candidate.label === label)
    if (!point) throw new Error(`the skeleton has no ${label} joint`)
    return point
  }
  const wrist = find(`${side} ARM`)
  const elbow = find(`${side} ELBOW`)
  const estimated = {
    x: (wrist.x + REACH * (wrist.x - elbow.x)) * frame.width,
    y: (wrist.y + REACH * (wrist.y - elbow.y)) * frame.height,
    behind: wrist.z_index < 0,
  }
  if (!placed) return estimated
  return { x: placed.x, y: placed.y, behind: placed.behind ?? estimated.behind, ...(placed.angle === undefined ? {} : { angle: placed.angle }) }
}

/** Screen-space facing: x is +1 facing east, y is +1 facing south (toward the viewer). */
const FACING: Record<CharacterDirection, { x: number; y: number }> = {
  south: { x: 0, y: 1 },
  "south-east": { x: Math.SQRT1_2, y: Math.SQRT1_2 },
  east: { x: 1, y: 0 },
  "north-east": { x: Math.SQRT1_2, y: -Math.SQRT1_2 },
  north: { x: 0, y: -1 },
  "north-west": { x: -Math.SQRT1_2, y: -Math.SQRT1_2 },
  west: { x: -1, y: 0 },
  "south-west": { x: -Math.SQRT1_2, y: Math.SQRT1_2 },
}

export function isDirection(value: string | undefined): value is CharacterDirection {
  return CHARACTER_DIRECTIONS_8.includes(value as CharacterDirection)
}

/**
 * Clockwise degrees to turn an item drawn upright so it reads as held.
 * `tilt` leans it the way the figure faces, which on screen only shows from
 * the side: full to the right facing east, full to the left facing west,
 * none facing the viewer or away. `lean` tips it outward from the body,
 * which only shows from the front and back, and to the side the hand is on.
 */
export function heldAngle(direction: CharacterDirection, joint: AttachJoint, tilt: number, lean: number): number {
  const facing = FACING[direction]
  const outward = joint === "right-hand" ? -1 : 1
  return tilt * facing.x + lean * outward * facing.y
}

/** The item's opaque bounds, or null when it has no opaque pixel. */
function opaqueBounds(image: DecodedPng): { left: number; top: number; right: number; bottom: number } | null {
  let left = image.width, top = image.height, right = -1, bottom = -1
  for (let y = 0; y < image.height; y++) {
    for (let x = 0; x < image.width; x++) {
      if (image.pixels[(y * image.width + x) * 4 + 3] === 0) continue
      if (x < left) left = x
      if (x > right) right = x
      if (y < top) top = y
      if (y > bottom) bottom = y
    }
  }
  return right < 0 ? null : { left, top, right, bottom }
}

/**
 * Where a hand holds an item when the author does not say: the middle of its
 * lowest fifth. A sword, a staff, a torch and a lantern on a handle are all
 * drawn handle-down, upright or leaning, and this lands on the handle either
 * way. An item held elsewhere (a shield by its centre) needs `grip`.
 */
export function gripPoint(item: DecodedPng): { x: number; y: number } {
  const bounds = opaqueBounds(item)
  if (!bounds) throw new Error("the item has no opaque pixels")
  const rows = Math.max(1, Math.round((bounds.bottom - bounds.top + 1) * 0.2))
  let sumX = 0, sumY = 0, count = 0
  for (let y = bounds.bottom - rows + 1; y <= bounds.bottom; y++) {
    for (let x = bounds.left; x <= bounds.right; x++) {
      if (item.pixels[(y * item.width + x) * 4 + 3] === 0) continue
      sumX += x
      sumY += y
      count++
    }
  }
  return { x: sumX / count, y: sumY / count }
}

/**
 * Turns an image clockwise about a pivot, nearest neighbour, so every output
 * pixel is one of the input's own colours. The canvas grows to hold the
 * corners; the pivot's new position comes back with it.
 */
export function rotateAbout(image: DecodedPng, pivot: { x: number; y: number }, degrees: number): { image: DecodedPng; pivot: { x: number; y: number } } {
  if (degrees % 360 === 0) return { image, pivot }
  const reach = Math.ceil(Math.max(
    Math.hypot(pivot.x, pivot.y),
    Math.hypot(image.width - pivot.x, pivot.y),
    Math.hypot(pivot.x, image.height - pivot.y),
    Math.hypot(image.width - pivot.x, image.height - pivot.y),
  )) + 1
  const side = reach * 2 + 1
  const out: DecodedPng = { width: side, height: side, pixels: Buffer.alloc(side * side * 4) }
  const radians = (degrees * Math.PI) / 180
  const cos = Math.cos(radians)
  const sin = Math.sin(radians)
  for (let y = 0; y < side; y++) {
    for (let x = 0; x < side; x++) {
      const dx = x - reach
      const dy = y - reach
      // Screen y runs down, so a clockwise turn on screen is this inverse map.
      const sx = Math.floor(cos * dx + sin * dy + pivot.x + 0.5)
      const sy = Math.floor(-sin * dx + cos * dy + pivot.y + 0.5)
      if (sx < 0 || sy < 0 || sx >= image.width || sy >= image.height) continue
      image.pixels.copy(out.pixels, (y * side + x) * 4, (sy * image.width + sx) * 4, (sy * image.width + sx) * 4 + 4)
    }
  }
  return { image: out, pivot: { x: reach, y: reach } }
}

/** The middle of an item's opaque pixels: where a shield or a buckler is held. */
export function centerPoint(item: DecodedPng): { x: number; y: number } {
  const bounds = opaqueBounds(item)
  if (!bounds) throw new Error("the item has no opaque pixels")
  return { x: (bounds.left + bounds.right) / 2, y: (bounds.top + bounds.bottom) / 2 }
}

/**
 * Resizes an image by a factor, nearest neighbour, so every output pixel is
 * one of the input's own colours. Shrinking pixel art drops rows and columns
 * outright: fine for bringing an item down a size, rough on fine detail.
 */
export function scaleBy(image: DecodedPng, factor: number): DecodedPng {
  if (factor === 1) return image
  const width = Math.max(1, Math.round(image.width * factor))
  const height = Math.max(1, Math.round(image.height * factor))
  const pixels = Buffer.alloc(width * height * 4)
  for (let y = 0; y < height; y++) {
    const sy = Math.min(image.height - 1, Math.floor((y + 0.5) / factor))
    for (let x = 0; x < width; x++) {
      const sx = Math.min(image.width - 1, Math.floor((x + 0.5) / factor))
      image.pixels.copy(pixels, (y * width + x) * 4, (sy * image.width + sx) * 4, (sy * image.width + sx) * 4 + 4)
    }
  }
  return { width, height, pixels }
}

export interface AttachOptions {
  placement: Placement
  /** Clockwise degrees to turn the item about its grip. */
  angle?: number
  /**
   * The point of the item the hand holds: `center`, or a point in the item's
   * own pixels as drawn (before `scale`). Default `gripPoint`.
   */
  grip?: { x: number; y: number } | "center"
  /** Resize the item by this factor before placing it. Default 1. */
  scale?: number
  /** Empty pixels around the frame on the layer's canvas. */
  padding: number
}

/**
 * One layer frame: the item, turned and pinned by its grip to the hand, on
 * the frame's canvas grown by `padding`. Where the body covers the hand, the
 * item's pixels under the figure are left out, so the layer still drops over
 * the frame and reads as behind it. `clipped` counts item pixels that fell
 * off the canvas: more padding keeps them.
 */
export function attachFrame(frame: Buffer, item: Buffer, options: AttachOptions): { png: Buffer; clipped: number } {
  const body = decodePng(frame)
  const factor = options.scale ?? 1
  const drawn = scaleBy(decodePng(item), factor)
  const grip = options.grip === "center"
    ? centerPoint(drawn)
    : options.grip
      // The centre of the named pixel, carried to where that pixel went.
      ? { x: (options.grip.x + 0.5) * factor - 0.5, y: (options.grip.y + 0.5) * factor - 0.5 }
      : gripPoint(drawn)
  const turned = rotateAbout(drawn, grip, (options.angle ?? 0) + (options.placement.angle ?? 0))
  const pad = options.padding
  const width = body.width + pad * 2
  const height = body.height + pad * 2
  const out = Buffer.alloc(width * height * 4)
  const left = Math.round(options.placement.x - turned.pivot.x) + pad
  const top = Math.round(options.placement.y - turned.pivot.y) + pad
  let clipped = 0
  for (let y = 0; y < turned.image.height; y++) {
    for (let x = 0; x < turned.image.width; x++) {
      const from = (y * turned.image.width + x) * 4
      if (turned.image.pixels[from + 3] === 0) continue
      const tx = left + x
      const ty = top + y
      if (tx < 0 || ty < 0 || tx >= width || ty >= height) {
        clipped++
        continue
      }
      if (options.placement.behind) {
        const bx = tx - pad
        const by = ty - pad
        if (bx >= 0 && by >= 0 && bx < body.width && by < body.height && body.pixels[(by * body.width + bx) * 4 + 3]! > 0) continue
      }
      turned.image.pixels.copy(out, (ty * width + tx) * 4, from, from + 4)
    }
  }
  return { png: encodeRgbaPng(width, height, out), clipped }
}

/**
 * True for a layer made here, without a provider: an item placed and left as
 * it lands. One whose grip is redrawn (`grasp`) is placed here too, but then
 * goes to the provider like any other layer, and is not this.
 */
export function isHeldItem(spec: Pick<ResolvedSpec, "character">): boolean {
  const attach = spec.character?.layer?.attach
  return Boolean(attach && !attach.grasp)
}
