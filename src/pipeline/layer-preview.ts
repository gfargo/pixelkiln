import { existsSync, readFileSync } from "node:fs"
import { encodeGif } from "../gif.ts"
import { currentEntryOutputPath } from "../outputs.ts"
import { dressFrame, trimBase } from "../paperdoll.ts"
import { decodePng, encodeRgbaPng, joinStripPng, type DecodedPng } from "../png.ts"
import { lockKey, type Lock, type ResolvedSpec } from "../types.ts"

/** One of a layer's sources, dressed: each frame with the layer over it, trim applied. */
export interface DressedSource {
  assetId: string
  /** A loop plays; a base's or state's rotations are a still set. */
  still: boolean
  /** The loop's rate, for a GIF. */
  fps: number
  frames: Array<{ role?: string; png: Buffer }>
  /** Base pixels the trim hid, over every frame. */
  cut: number
  /** Source frames with no layer frame over them (the layer was made before the loop was redrawn, say). */
  missing: string[]
}

/**
 * Every source frame of a downloaded layer with the layer drawn over it, as
 * `pack --flatten` would draw it: the base with the layer's trim hidden,
 * then the layer. Read from the files on disk, free and local.
 */
export function dressLayer(spec: ResolvedSpec, lock: Lock): DressedSource[] {
  const layer = spec.character?.kind === "layer" ? spec.character.layer : undefined
  if (!layer) throw new Error(`${spec.assetId} is not a paperdoll layer`)
  const entry = lock.entries[lockKey(spec.styleId, spec.assetId)]
  if (entry?.status !== "downloaded" || !entry.outputs.length) {
    throw new Error(`${spec.styleId}/${spec.assetId} has no downloaded frames yet; gen it first`)
  }
  const layerFile = new Map(entry.outputs.map((output, index) => [output.role ?? "", currentEntryOutputPath(entry, spec, index)]))
  return layer.sources.map((source) => {
    const sourceEntry = lock.entries[lockKey(source.spec.styleId, source.spec.assetId)]
    if (sourceEntry?.status !== "downloaded" || !sourceEntry.outputs.length) {
      throw new Error(`layer source ${source.spec.styleId}/${source.assetId} has no downloaded frames`)
    }
    const animation = source.spec.character?.animation
    const dressed: DressedSource = { assetId: source.assetId, still: !animation, fps: animation?.fps ?? 2, frames: [], cut: 0, missing: [] }
    for (const [index, output] of sourceEntry.outputs.entries()) {
      const baseFile = currentEntryOutputPath(sourceEntry, source.spec, index)
      if (!existsSync(baseFile)) throw new Error(`layer source frame is missing on disk: ${baseFile}`)
      const base = readFileSync(baseFile)
      const over = layerFile.get(`${source.assetId}.${output.role ?? ""}`)
      if (!over || !existsSync(over)) {
        dressed.missing.push(output.role ?? String(index))
        dressed.frames.push({ ...(output.role ? { role: output.role } : {}), png: base })
        continue
      }
      const top = readFileSync(over)
      const cut = layer.trim ? trimBase(base, [top], layer.trim) : undefined
      dressed.cut += cut?.pixels ?? 0
      dressed.frames.push({ ...(output.role ? { role: output.role } : {}), png: dressFrame(base, [top], cut) })
    }
    return dressed
  })
}

/** Frames of a source on one canvas, each centred, so a strip or a GIF can hold them. */
function common(frames: Buffer[]): DecodedPng[] {
  const decoded = frames.map((png) => decodePng(png))
  const width = Math.max(...decoded.map((image) => image.width))
  const height = Math.max(...decoded.map((image) => image.height))
  return decoded.map((image) => {
    if (image.width === width && image.height === height) return image
    const pixels = Buffer.alloc(width * height * 4)
    const ox = Math.round((width - image.width) / 2)
    const oy = Math.round((height - image.height) / 2)
    for (let y = 0; y < image.height; y++) {
      image.pixels.copy(pixels, ((y + oy) * width + ox) * 4, y * image.width * 4, (y + 1) * image.width * 4)
    }
    return { width, height, pixels }
  })
}

/** The dressed frames left to right. */
export function dressedStrip(source: DressedSource): Buffer {
  return joinStripPng(common(source.frames.map((frame) => frame.png)).map((image) => encodeRgbaPng(image.width, image.height, image.pixels)))
}

/** The dressed loop, playing at its own rate and looping. */
export function dressedGif(source: DressedSource): Buffer {
  return encodeGif(common(source.frames.map((frame) => frame.png)), { delayMs: 1000 / source.fps })
}
