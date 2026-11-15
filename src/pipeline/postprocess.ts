import { normalizePalette, quantize } from "../palette.ts"
import { MediaType, type MediaType as MediaKind } from "../media.ts"
import { despeckle } from "../paperdoll.ts"
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
  const palette = spec.enforcePalette && spec.palette.length >= 2
    ? {
        palette: {
          colors: normalizePalette(spec.palette).map((color) => color.hex),
          dither: "none" as const,
          distance: "redmean" as const,
        },
      }
    : {}
  const record = { ...clean, ...palette }
  return Object.keys(record).length ? record : undefined
}

/** Two records ask for the same work. Absent and empty both mean none. */
export function samePostprocess(a: Postprocess | undefined, b: Postprocess | undefined): boolean {
  if (a?.despeckle?.of !== b?.despeckle?.of) return false
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
  /** True when the palette snap moved at least one pixel. */
  snapped?: boolean
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
): PostprocessResult {
  if (mediaType !== MediaType.PNG || (!record?.palette && !record?.despeckle)) return { bytes, changed: false }
  let out = bytes
  let removed = 0
  if (record.despeckle) {
    if (!reference.length) throw new Error(`cleaning needs the rotations of ${record.despeckle.of}, and none were given`)
    const cleaned = despeckle(out, { reference })
    if (cleaned.removed) {
      out = cleaned.png
      removed = cleaned.removed
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
  if (!removed && !snapped) return { bytes, changed: false }
  return { bytes: out, changed: true, ...(removed ? { removed } : {}), ...(snapped ? { snapped } : {}) }
}
