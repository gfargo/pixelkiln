import { existsSync, readFileSync } from "node:fs"
import { isHeldItem } from "../attach.ts"
import { currentEntryOutputPath } from "../outputs.ts"
import { chooseLayerColumns, layerFitProblem, layerSheetFit, LAYER_SHEET_MAX_SIDE, type LayerSheetFit } from "../paperdoll.ts"
import { lockKey, type Lock, type ResolvedSpec } from "../types.ts"
import { anchorGuides } from "./layer-anchor.ts"

/**
 * Whether a paperdoll layer's frames fit the one sheet its inpaint is drawn
 * on, read from the sources' frames on disk before anything is paid for.
 *
 * - `fits` / `too-big`: every source is downloaded, so this is the sheet
 *   `gen` would build, cleaning included.
 * - `estimate`: some sources are not made yet. The cell is measured on the
 *   frames that exist (the base's rotations, usually) and the frame count
 *   taken from the manifest; a loop sways wider than its rotations, so the
 *   real cell is at least this big and the count that fits at most this.
 */
export type LayerFitInspection =
  | { state: "fits" | "too-big"; fit: LayerSheetFit; detail: string }
  | { state: "estimate"; fit: LayerSheetFit; detail: string; over: boolean }

/** Frames a source will have once made: a still's rotations, a loop's frames (plus the first, when kept). */
function expectedFrames(spec: ResolvedSpec): number | null {
  const character = spec.character
  if (!character) return null
  if (character.animation) {
    // A template loop's length is the template's, which the manifest does not say.
    if (character.animation.mode === "template") return null
    return character.animation.frames + (character.animation.keepFirstFrame ? 1 : 0)
  }
  return character.directions
}

/** "4 columns of 121x247 on a 484x494 sheet, room for 8": the layout in plan's words. */
function describe(fit: LayerSheetFit): string {
  const layout = fit.columns
    ? `${fit.columns} column${fit.columns === 1 ? "" : "s"} of ${fit.cellWidth}x${fit.cellHeight} on a ${fit.width}x${fit.height} sheet`
    : `cells of ${fit.cellWidth}x${fit.cellHeight}`
  const asked = fit.requestedColumns !== undefined && fit.columns !== null ? ` (columns ${fit.requestedColumns} does not fit)` : ""
  return `${fit.frames} frames, ${layout}${asked}, room for ${fit.maxFrames}`
}

/**
 * What to regenerate at: with the stills kept, the frames each loop can have
 * so the whole set fits, stored without the repeated first frame.
 */
function suggestion(fit: LayerSheetFit, stills: number, loops: number): string {
  const room = fit.maxFrames - stills
  if (loops && room >= loops) {
    const each = Math.floor(room / loops)
    return `; regenerate the loop${loops === 1 ? "" : "s"} at ${each} frame${each === 1 ? "" : "s"}${loops === 1 ? "" : " each"} with keepFirstFrame: false, or split \`of\` across layers`
  }
  return "; split `of` across layers"
}

export function inspectLayerFit(spec: ResolvedSpec, lock: Lock): LayerFitInspection | null {
  const layer = spec.character?.kind === "layer" ? spec.character.layer : undefined
  // A held item is placed frame by frame; only a grip pass draws a sheet.
  if (!layer || isHeldItem(spec)) return null
  const known: Array<{ assetId: string; role?: string; png: Buffer; still: boolean }> = []
  let pending = 0
  let unknownCount = false
  let stills = 0
  let loops = 0
  for (const source of layer.sources) {
    const still = source.spec.character?.kind !== "animation"
    const entry = lock.entries[lockKey(source.spec.styleId, source.spec.assetId)]
    const files = entry?.status === "downloaded" && entry.outputs.length
      ? entry.outputs.map((_output, index) => currentEntryOutputPath(entry, source.spec, index))
      : []
    if (files.length && files.every((file) => existsSync(file))) {
      for (const [index, file] of files.entries()) {
        known.push({ assetId: source.assetId, role: entry!.outputs[index]!.role, png: readFileSync(file), still })
      }
      if (still) stills += files.length
      else loops++
      continue
    }
    const count = expectedFrames(source.spec)
    if (count === null) unknownCount = true
    else pending += count
    if (still) stills += count ?? 0
    else loops++
  }
  // An anchor's guides each take a cell, ahead of the layer's own frames.
  if (layer.anchor) {
    const guides = anchorGuides(spec, lock)
    if (guides.ok) {
      for (const guide of guides.guides) known.unshift({ assetId: guide.assetId, role: guide.role, png: readFileSync(guide.basePath), still: true })
      stills += guides.guides.length
    } else {
      pending += layer.anchor.frames?.length ?? 1
      stills += layer.anchor.frames?.length ?? 1
    }
  }
  if (!known.length) return null
  const options = {
    maxSide: LAYER_SHEET_MAX_SIDE,
    columns: layer.columns,
    padding: layer.padding,
    reference: layer.clean ? known.filter((frame) => frame.still).map((frame) => frame.png) : [],
  }
  let fit: LayerSheetFit
  try {
    fit = layerSheetFit(known, options)
  } catch {
    // Frames that cannot be measured (all transparent, unreadable) are gen's to report.
    return null
  }
  if (!pending && !unknownCount) {
    return fit.columns === null
      ? { state: "too-big", fit, detail: `${layerFitProblem(fit)}${suggestion(fit, stills, loops)}` }
      : { state: "fits", fit, detail: describe(fit) }
  }
  // The measured cell, the full count: a lower bound on the cell, so an upper bound on what fits.
  const total = fit.frames + pending
  const estimate = chooseLayerColumns(total, fit.cellWidth, fit.cellHeight, fit.maxSide, layer.columns)
  const counted = unknownCount ? `at least ${total}` : `${total}`
  const over = !unknownCount && total > estimate.maxFrames
  return {
    state: "estimate",
    fit: estimate,
    over,
    detail:
      `at the measured frames' size (${fit.cellWidth}x${fit.cellHeight}) a sheet holds at most ${estimate.maxFrames}; ` +
      `this layer will have ${counted}` +
      (over ? `, which does not fit${suggestion(estimate, stills, loops)}` : "; loops sway wider than their rotations, so the real limit can be lower"),
  }
}
