import { normalizePalette, quantize } from "../palette.ts"
import { MediaType, type MediaType as MediaKind } from "../media.ts"
import { decodePng, encodeRgbaPng } from "../png.ts"
import type { LockEntry, Postprocess, ResolvedSpec } from "../types.ts"

/**
 * What `fetch` does to a provider's bytes before they become the recorded
 * output. Today that is one thing, snapping to the style's palette when it
 * says `enforcePalette`; the record is shaped so a second step can join it.
 *
 * The rule that makes this safe to keep in the lockfile: the same raw bytes
 * and the same record always produce the same output bytes. Nothing here
 * reads the clock, the environment, or the file system.
 */

/** The post-processing a spec asks for, or undefined when it asks for none. */
export function postprocessFor(spec: Pick<ResolvedSpec, "palette" | "enforcePalette">): Postprocess | undefined {
  if (!spec.enforcePalette || spec.palette.length < 2) return undefined
  return {
    palette: {
      colors: normalizePalette(spec.palette).map((color) => color.hex),
      dither: "none",
      distance: "redmean",
    },
  }
}

/** Two records ask for the same work. Absent and empty both mean none. */
export function samePostprocess(a: Postprocess | undefined, b: Postprocess | undefined): boolean {
  const pa = a?.palette
  const pb = b?.palette
  if (!pa && !pb) return true
  if (!pa || !pb) return false
  return pa.dither === pb.dither && pa.distance === pb.distance &&
    pa.colors.length === pb.colors.length && pa.colors.every((color, i) => color === pb.colors[i])
}

/** The entry's outputs were made with the spec's post-processing. */
export function postprocessCurrent(entry: Pick<LockEntry, "postprocess">, spec: Pick<ResolvedSpec, "palette" | "enforcePalette">): boolean {
  return samePostprocess(entry.postprocess, postprocessFor(spec))
}

export interface PostprocessResult {
  bytes: Buffer
  /** False when the bytes came back unchanged, so the raw hash is the output hash. */
  changed: boolean
}

/**
 * Apply a record to raw bytes. Only PNGs are touched; a GIF or anything else
 * passes through. A PNG whose pixels already conform passes through as the
 * provider's exact bytes rather than a re-encoding of them, so an enforced
 * palette that a provider honoured leaves the file, and its hash, alone.
 */
export function applyPostprocess(bytes: Buffer, mediaType: MediaKind, record: Postprocess | undefined): PostprocessResult {
  if (!record?.palette || mediaType !== MediaType.PNG) return { bytes, changed: false }
  const png = decodePng(bytes)
  const { png: snapped, changed } = quantize(png, record.palette.colors)
  if (!changed) return { bytes, changed: false }
  return { bytes: encodeRgbaPng(snapped.width, snapped.height, snapped.pixels), changed: true }
}
