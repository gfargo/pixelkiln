import { normalizePalette, quantize } from "../palette.ts"
import { MediaType, type MediaType as MediaKind } from "../media.ts"
import { despeckle, shiftPixels } from "../paperdoll.ts"
import { decodePng, encodeRgbaPng } from "../png.ts"
import type { LockEntry, Postprocess, ResolvedSpec } from "../types.ts"

/**
 * What `fetch` does to a provider's bytes before they become the recorded
 * output: removing animation ghosts from a loop that asks for `clean`, then
 * snapping to the style's palette when it says `enforcePalette`.
 *
 * The rule that makes this safe to keep in the lockfile: the same raw bytes,
 * the same record, and the same reference stills always produce the same
 * output bytes. Nothing here reads the clock, the environment, or the file
 * system; the caller reads the stills and passes their bytes in.
 */

type PostprocessSpec = Pick<ResolvedSpec, "palette" | "enforcePalette"> & Partial<Pick<ResolvedSpec, "character">>

/** The post-processing a spec asks for, or undefined when it asks for none. */
export function postprocessFor(spec: PostprocessSpec): Postprocess | undefined {
  const character = spec.character
  const clean = character?.kind === "animation" && character.animation?.clean && character.parentAssetId
    ? { despeckle: { of: character.parentAssetId } }
    : {}
  // A drawn layer's nudge. A held item's offset moves it on the hand when it is placed instead.
  const layer = character?.kind === "layer" && !character.layer?.attach ? character.layer : undefined
  const offset = layer?.offset ? { offset: layer.offset } : {}
  const palette = spec.enforcePalette && spec.palette.length >= 2
    ? {
        palette: {
          colors: normalizePalette(spec.palette).map((color) => color.hex),
          dither: "none" as const,
          distance: "redmean" as const,
        },
      }
    : {}
  const record = { ...clean, ...offset, ...palette }
  return Object.keys(record).length ? record : undefined
}

/** A layer offset as one comparable string; no offset and all zeroes read the same. */
export function offsetKey(offset: Postprocess["offset"]): string {
  const per = Object.entries(offset?.per ?? {})
    .filter(([, pair]) => pair.x !== (offset?.x ?? 0) || pair.y !== (offset?.y ?? 0))
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([id, pair]) => `${id}:${pair.x},${pair.y}`)
  return [`${offset?.x ?? 0},${offset?.y ?? 0}`, ...per].join("|")
}

/** Two records ask for the same work. Absent and empty both mean none. */
export function samePostprocess(a: Postprocess | undefined, b: Postprocess | undefined): boolean {
  if (a?.despeckle?.of !== b?.despeckle?.of) return false
  if (offsetKey(a?.offset) !== offsetKey(b?.offset)) return false
  const pa = a?.palette
  const pb = b?.palette
  if (!pa && !pb) return true
  if (!pa || !pb) return false
  return pa.dither === pb.dither && pa.distance === pb.distance &&
    pa.colors.length === pb.colors.length && pa.colors.every((color, i) => color === pb.colors[i])
}

/** The entry's outputs were made with the spec's post-processing. */
export function postprocessCurrent(entry: Pick<LockEntry, "postprocess">, spec: PostprocessSpec): boolean {
  return samePostprocess(entry.postprocess, postprocessFor(spec))
}

export interface PostprocessResult {
  bytes: Buffer
  /** False when the bytes came back unchanged, so the raw hash is the output hash. */
  changed: boolean
  /** Ghost pixels removed, when the record asked for cleaning and found some. */
  removed?: number
  /** With `removed`: the frame's opaque pixels before cleaning, to judge whether the cleaning took part of the figure. */
  opaque?: number
  /** True when the palette snap moved at least one pixel. */
  snapped?: boolean
  /** Set when the record moved the layer: how many pixels fell off the canvas. */
  moved?: { clipped: number }
}

/**
 * Apply a record to raw bytes. Only PNGs are touched; a GIF or anything else
 * passes through. A PNG a step leaves alone passes through as the provider's
 * exact bytes rather than a re-encoding of them, so a clean frame, or an
 * enforced palette that a provider honoured, leaves the file and its hash
 * alone. `reference` holds the stills a `despeckle` record judges against;
 * the record is refused without them rather than recorded as done.
 */
export function applyPostprocess(
  bytes: Buffer,
  mediaType: MediaKind,
  record: Postprocess | undefined,
  reference: Buffer[] = [],
  /** The output's role. A layer's is `<source asset>.<frame>`, which picks a per-asset offset. */
  role?: string,
): PostprocessResult {
  if (mediaType !== MediaType.PNG || (!record?.palette && !record?.despeckle && !record?.offset)) return { bytes, changed: false }
  let out = bytes
  let removed = 0
  let opaque = 0
  if (record.despeckle) {
    if (!reference.length) throw new Error(`cleaning needs the rotations of ${record.despeckle.of}, and none were given`)
    const cleaned = despeckle(out, { reference })
    if (cleaned.removed) {
      const { pixels } = decodePng(out)
      for (let i = 3; i < pixels.length; i += 4) if (pixels[i]! > 0) opaque++
      out = cleaned.png
      removed = cleaned.removed
    }
  }
  let moved: { clipped: number } | undefined
  if (record.offset) {
    // The longest source asset id the role starts with, so `hero.walk.south.frame-00` is not taken for `hero`.
    const owner = Object.keys(record.offset.per ?? {})
      .filter((id) => role?.startsWith(`${id}.`))
      .sort((a, b) => b.length - a.length)[0]
    const pair = (owner && record.offset.per![owner]) || record.offset
    const shifted = shiftPixels(out, pair.x, pair.y)
    if (shifted.png !== out) {
      out = shifted.png
      moved = { clipped: shifted.clipped }
    }
  }
  let snapped = false
  if (record.palette) {
    const result = quantize(decodePng(out), record.palette.colors)
    if (result.changed) {
      out = encodeRgbaPng(result.png.width, result.png.height, result.png.pixels)
      snapped = true
    }
  }
  if (!removed && !snapped && !moved) return { bytes, changed: false }
  return { bytes: out, changed: true, ...(removed ? { removed, opaque } : {}), ...(snapped ? { snapped } : {}), ...(moved ? { moved } : {}) }
}

/**
 * Ghosts are specks and arcs; a frame that loses more than this share of its
 * opaque pixels to cleaning has more likely lost part of the figure.
 */
export const CLEAN_DAMAGE_SHARE = 0.03
