import { encodeRgbaPng, type DecodedPng } from "./png.ts"
import { SKELETON_BONES, type SkeletonKeypoint, type SkeletonSet } from "./skeleton.ts"

/**
 * A contact sheet of a keypoints file: one cell per pose, the pose the image
 * is already in first, then each frame, every bone drawn over the source
 * image. Local and free, so a bad pose is seen before `animate-skeleton` is
 * paid for — the check the docs otherwise leave to the author's reading of
 * raw fractions.
 *
 * Right-side bones are orange, left-side blue, the head and spine white;
 * the first cell's source is at full strength and the frames' dimmed, so the
 * difference between "the pose the image is in" and "the motion" reads at a
 * glance. Coordinates are fractions of the source, as PixelLab's are.
 */
export interface SkeletonSheetOptions {
  /** The image the poses belong to. Without one, cells are a flat dark ground. */
  source?: DecodedPng
  /** Cell edge in pixels when there is no source; default 192. */
  cellSize?: number
  /** Cells per row before wrapping; default 8. */
  columns?: number
}

const RIGHT: Rgba = [255, 140, 40, 255]
const LEFT: Rgba = [60, 150, 255, 255]
const CENTER: Rgba = [240, 240, 240, 255]
const GROUND: Rgba = [28, 28, 34, 255]
const OUTLINE: Rgba = [0, 0, 0, 255]
const GUTTER = 4
/** Upscale small sprites so a 1px bone is not wider than the art's own pixels. */
const MIN_CELL = 192

type Rgba = [number, number, number, number]

export function renderSkeletonSheet(set: SkeletonSet, options: SkeletonSheetOptions = {}): Buffer {
  const poses = [set.firstFrameKeypoints, ...set.frames]
  const source = options.source
  const scale = source ? Math.max(1, Math.ceil(MIN_CELL / Math.max(source.width, source.height))) : 1
  const cellW = source ? source.width * scale : options.cellSize ?? MIN_CELL
  const cellH = source ? source.height * scale : options.cellSize ?? MIN_CELL
  const columns = Math.min(options.columns ?? 8, poses.length)
  const rows = Math.ceil(poses.length / columns)
  const width = columns * cellW + (columns + 1) * GUTTER
  const height = rows * cellH + (rows + 1) * GUTTER
  const canvas = new Canvas(width, height)
  canvas.fill(0, 0, width, height, [12, 12, 16, 255])

  poses.forEach((pose, index) => {
    const left = GUTTER + (index % columns) * (cellW + GUTTER)
    const top = GUTTER + Math.floor(index / columns) * (cellH + GUTTER)
    canvas.fill(left, top, cellW, cellH, GROUND)
    if (source) canvas.drawImage(source, left, top, scale, index === 0 ? 1 : 0.45)
    drawPose(canvas, pose, left, top, cellW, cellH, Math.max(1, Math.round(Math.min(cellW, cellH) / 128)))
  })
  return encodeRgbaPng(width, height, canvas.data)
}

function drawPose(canvas: Canvas, pose: SkeletonKeypoint[], left: number, top: number, w: number, h: number, stroke: number): void {
  const at = new Map(pose.map((joint) => [joint.label, joint]))
  const point = (joint: SkeletonKeypoint) => [left + joint.x * (w - 1), top + joint.y * (h - 1)] as const
  // Everything twice: a dark outline first, then the colour, so an orange
  // bone still reads over an orange sprite.
  for (const outline of [true, false]) {
    for (const [from, to] of SKELETON_BONES) {
      const a = at.get(from)
      const b = at.get(to)
      if (!a || !b) continue
      const [x0, y0] = point(a)
      const [x1, y1] = point(b)
      canvas.line(x0, y0, x1, y1, outline ? OUTLINE : colorOf(to), outline ? stroke + 2 : stroke)
    }
    for (const joint of pose) {
      const [x, y] = point(joint)
      canvas.dot(x, y, outline ? stroke + 3 : stroke + 1, outline ? OUTLINE : colorOf(joint.label))
    }
  }
}

function colorOf(label: string): Rgba {
  if (label.startsWith("RIGHT")) return RIGHT
  if (label.startsWith("LEFT")) return LEFT
  return CENTER
}

class Canvas {
  readonly data: Buffer
  constructor(readonly width: number, readonly height: number) {
    this.data = Buffer.alloc(width * height * 4)
  }

  set(x: number, y: number, [r, g, b, a]: Rgba): void {
    const px = Math.round(x)
    const py = Math.round(y)
    if (px < 0 || py < 0 || px >= this.width || py >= this.height) return
    const i = (py * this.width + px) * 4
    this.data[i] = r
    this.data[i + 1] = g
    this.data[i + 2] = b
    this.data[i + 3] = a
  }

  fill(x: number, y: number, w: number, h: number, color: Rgba): void {
    for (let dy = 0; dy < h; dy++) for (let dx = 0; dx < w; dx++) this.set(x + dx, y + dy, color)
  }

  /** Nearest-neighbour upscale, composited over what is there, at `strength`. */
  drawImage(image: DecodedPng, left: number, top: number, scale: number, strength: number): void {
    for (let y = 0; y < image.height; y++) {
      for (let x = 0; x < image.width; x++) {
        const i = (y * image.width + x) * 4
        const alpha = image.pixels[i + 3]! / 255 * strength
        if (alpha === 0) continue
        const src = [image.pixels[i]!, image.pixels[i + 1]!, image.pixels[i + 2]!]
        for (let dy = 0; dy < scale; dy++) {
          for (let dx = 0; dx < scale; dx++) {
            const o = ((top + y * scale + dy) * this.width + left + x * scale + dx) * 4
            for (let c = 0; c < 3; c++) this.data[o + c] = Math.round(src[c]! * alpha + this.data[o + c]! * (1 - alpha))
          }
        }
      }
    }
  }

  line(x0: number, y0: number, x1: number, y1: number, color: Rgba, stroke: number): void {
    const steps = Math.max(1, Math.ceil(Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0))))
    for (let step = 0; step <= steps; step++) {
      const t = step / steps
      this.dot(x0 + (x1 - x0) * t, y0 + (y1 - y0) * t, stroke, color)
    }
  }

  /** A filled square `size` wide centred on (x, y): crisp at pixel-art scale. */
  dot(x: number, y: number, size: number, color: Rgba): void {
    const half = Math.floor(size / 2)
    for (let dy = -half; dy < size - half; dy++) for (let dx = -half; dx < size - half; dx++) this.set(x + dx, y + dy, color)
  }
}
