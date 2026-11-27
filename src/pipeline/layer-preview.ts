/**
 * `layer preview`: builds a drawn paperdoll layer's sheet, keyed sheet and
 * mask exactly as submit would, and writes them, with each frame's own crop
 * and an overlay of the mask, without calling any provider. A mask that
 * leaves the chest out is then seen before the inpaint is paid for.
 */
import { mkdir, rm, writeFile } from "node:fs/promises"
import path from "node:path"
import { currentEntryOutputPath } from "../outputs.ts"
import { unpackSheet, type NeckReport } from "../paperdoll.ts"
import { decodePng, encodeRgbaPng } from "../png.ts"
import { layerSheetFor, layerWorkDir } from "../providers/pixellab.ts"
import type { SubmitContext } from "../provider.ts"
import { lockKey, proTierCost, type Lock, type ResolvedSpec } from "../types.ts"
import { requireRevisionReady } from "./revision.ts"

/** Every frame of every source of a layer, in `of` order: what submit hands the provider. The sources must be downloaded. */
export function layerSourceOutputs(spec: ResolvedSpec, lock: Lock): NonNullable<SubmitContext["parentOutputs"]> {
  return spec.character!.layer!.sources.flatMap((source) => {
    const sourceEntry = lock.entries[lockKey(source.spec.styleId, source.spec.assetId)]!
    return sourceEntry.outputs.map((output, index) => ({
      path: currentEntryOutputPath(sourceEntry, source.spec, index),
      role: output.role,
      assetId: source.assetId,
      still: source.spec.character?.kind !== "animation",
    }))
  })
}

export interface LayerPreviewFrame {
  /** `<source asset>.<role>`, the name the layer's own frame will have. */
  name: string
  /** Null when the mask or keyed sheet was supplied, or the frame is empty. */
  neck: NeckReport | null
  /** Pixels of the frame the provider may repaint. */
  masked: number
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

export async function previewLayer(spec: ResolvedSpec, lock: Lock): Promise<LayerPreview> {
  const label = `${spec.styleId}/${spec.assetId}`
  const layer = spec.character?.kind === "layer" ? spec.character.layer : undefined
  if (!layer) throw new Error(`${label} is not a paperdoll layer`)
  if (layer.attach) throw new Error(`${label} is a held item, placed rather than inpainted; it has no mask to preview`)
  await requireRevisionReady(spec, lock)
  const built = layerSheetFor(spec, layerSourceOutputs(spec, lock))
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
    frames.push({ name, neck: built.necks?.[index] ?? null, masked })
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
  }
}
