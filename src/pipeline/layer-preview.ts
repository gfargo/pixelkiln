/**
 * `layer preview`: builds a drawn paperdoll layer's sheet, keyed sheet and
 * mask exactly as submit would, and writes them, with each frame's own crop
 * and an overlay of the mask, without calling any provider. A mask that
 * leaves the chest out is then seen before the inpaint is paid for.
 *
 * With `--gif`, once the layer is made, it also draws the layer over every
 * frame it dresses the way `pack --flatten` does, trim applied: a strip per
 * still set and a GIF per loop. A fringe, or a seam between two layers, is
 * easier to judge moving.
 */
import { existsSync, readFileSync } from "node:fs"
import { mkdir, rm, writeFile } from "node:fs/promises"
import path from "node:path"
import { encodeGif } from "../gif.ts"
import { currentEntryOutputPath } from "../outputs.ts"
import { dressFrame, trimBase, unpackSheet, type NeckReport } from "../paperdoll.ts"
import { decodePng, encodeRgbaPng, joinStripPng, type DecodedPng } from "../png.ts"
import { layerSheetFor, layerWorkDir } from "../providers/pixellab.ts"
import type { SubmitContext } from "../provider.ts"
import { lockKey, proTierCost, type Lock, type ResolvedSpec } from "../types.ts"
import { anchorGuides } from "./layer-anchor.ts"
import { requireRevisionReady } from "./revision.ts"

/**
 * What submit hands the provider for a layer: an anchor's guide frames first
 * (each a base frame with the anchor's finished layer to paint over it), then
 * every frame of every source, in `of` order. The sources must be downloaded.
 */
export function layerSourceOutputs(spec: ResolvedSpec, lock: Lock): NonNullable<SubmitContext["parentOutputs"]> {
  return [...layerGuideOutputs(spec, lock), ...spec.character!.layer!.sources.flatMap((source) => {
    const sourceEntry = lock.entries[lockKey(source.spec.styleId, source.spec.assetId)]!
    return sourceEntry.outputs.map((output, index) => ({
      path: currentEntryOutputPath(sourceEntry, source.spec, index),
      role: output.role,
      assetId: source.assetId,
      still: source.spec.character?.kind !== "animation",
    }))
  })]
}

function layerGuideOutputs(spec: ResolvedSpec, lock: Lock): NonNullable<SubmitContext["parentOutputs"]> {
  if (!spec.character?.layer?.anchor) return []
  const guides = anchorGuides(spec, lock)
  if (!guides.ok) throw new Error(`${spec.styleId}/${spec.assetId}: ${guides.reason}`)
  return guides.guides.map((guide) => ({ path: guide.basePath, role: guide.role, assetId: guide.assetId, still: true, guide: guide.layer }))
}

export interface LayerPreviewFrame {
  /** `<source asset>.<role>`, the name the layer's own frame will have. */
  name: string
  /** Null when the mask or keyed sheet was supplied, or the frame is empty. */
  neck: NeckReport | null
  /** Pixels of the frame the provider may repaint. */
  masked: number
  /** An anchor's guide: already dressed, masked shut, cut from nothing. */
  guide?: true
}

export interface LayerPreview {
  dir: string
  sheet: { width: number; height: number }
  /** Generations the inpaint would cost at this sheet size. */
  cost: number
  frames: LayerPreviewFrame[]
  /** Whether the mask, and the keyed sheet, came from files the manifest names. */
  supplied: { mask: boolean; keyed: boolean }
  /** Pinholes keyed shut; absent when the keyed sheet was supplied. */
  closed?: number
  cleaned: number
  written: string[]
  /** With `gif`: each source dressed by the made layer, and the file it went to. */
  dressed?: Array<DressedSource & { file: string }>
}

/** The mask laid over the sheet: what may be repainted shows in magenta, the rest dimmed. */
function overlay(sheet: Buffer, mask: Buffer): Buffer {
  const image = decodePng(sheet)
  const allowed = decodePng(mask)
  const out = Buffer.from(image.pixels)
  for (let i = 0; i < out.length; i += 4) {
    if (allowed.pixels[i] === 255) {
      out[i] = Math.round(out[i]! * 0.4 + 255 * 0.6)
      out[i + 1] = Math.round(out[i + 1]! * 0.4)
      out[i + 2] = Math.round(out[i + 2]! * 0.4 + 255 * 0.6)
      out[i + 3] = 255
    } else if (out[i + 3]) {
      out[i + 3] = 110
    }
  }
  return encodeRgbaPng(image.width, image.height, out)
}

export async function previewLayer(spec: ResolvedSpec, lock: Lock, options: { gif?: boolean } = {}): Promise<LayerPreview> {
  const label = `${spec.styleId}/${spec.assetId}`
  const layer = spec.character?.kind === "layer" ? spec.character.layer : undefined
  if (!layer) throw new Error(`${label} is not a paperdoll layer`)
  if (layer.attach) throw new Error(`${label} is a held item, placed rather than inpainted; it has no mask to preview`)
  await requireRevisionReady(spec, lock)
  const outputs = layerSourceOutputs(spec, lock)
  const built = layerSheetFor(spec, outputs)
  // Read before anything is written: a layer not made yet has nothing to dress.
  const dressed = options.gif ? dressLayer(spec, lock) : undefined
  const { width, height } = decodePng(built.keyed)
  const dir = path.join(layerWorkDir(spec), "preview")
  // Only this command writes here; last time's frames would mislead if the layer now has fewer.
  await rm(dir, { recursive: true, force: true })
  await mkdir(path.join(dir, "frames"), { recursive: true })
  const written: string[] = []
  const put = async (name: string, png: Buffer) => {
    const file = path.join(dir, name)
    await writeFile(file, png)
    written.push(file)
  }
  await put("sheet.png", built.sheet)
  await put("keyed.png", built.keyed)
  await put("mask.png", built.mask)
  await put("overlay.png", overlay(built.sheet, built.mask))
  const cells = built.frames.map((frame) => frame.cell)
  const keyedCells = unpackSheet(built.keyed, cells)
  const maskCells = unpackSheet(built.mask, cells)
  const frames: LayerPreviewFrame[] = []
  for (const [index, frame] of built.frames.entries()) {
    const name = `${frame.assetId}.${frame.role ?? String(index).padStart(2, "0")}`
    const stem = `${String(index).padStart(3, "0")}-${name.replace(/[^A-Za-z0-9._-]/g, "_")}`
    await put(path.join("frames", `${stem}.keyed.png`), keyedCells[index]!)
    await put(path.join("frames", `${stem}.mask.png`), maskCells[index]!)
    const { pixels } = decodePng(maskCells[index]!)
    let masked = 0
    for (let i = 0; i < pixels.length; i += 4) if (pixels[i] === 255) masked++
    frames.push({ name, neck: built.necks?.[index] ?? null, masked, ...(outputs[index]?.guide ? { guide: true as const } : {}) })
  }
  const shown: LayerPreview["dressed"] = []
  if (dressed) {
    await mkdir(path.join(dir, "dressed"), { recursive: true })
    for (const source of dressed) {
      const gif = !source.still
      const name = path.join("dressed", `${source.assetId.replace(/[^A-Za-z0-9._-]/g, "_")}.${gif ? "gif" : "png"}`)
      await put(name, gif ? dressedGif(source) : dressedStrip(source))
      shown.push({ ...source, file: path.join(dir, name) })
    }
  }
  return {
    dir,
    sheet: { width, height },
    cost: proTierCost(width, height),
    frames,
    supplied: { mask: Boolean(layer.mask), keyed: Boolean(layer.keyed) },
    ...(built.closed !== undefined ? { closed: built.closed } : {}),
    cleaned: built.cleaned,
    written,
    ...(dressed ? { dressed: shown } : {}),
  }
}

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
