import { readFile } from "node:fs/promises"
import { existsSync } from "node:fs"
import path from "node:path"
import { decodePng, extractPalette, transparencyRatio, type PaletteEntry } from "../png.ts"
import type { LoadedManifest } from "../manifest.ts"
import type { Lock, ResolvedSpec } from "../types.ts"
import { resolveSpecOutputs } from "../outputs.ts"

/**
 * Perceptual-ish distance between two colours, 0-255ish.
 *
 * "Redmean" — a cheap weighting that tracks human perception far better than
 * raw RGB euclidean and needs no colour-space conversion or dependency. Good
 * enough to rank outliers, which is all this is for; it is not colourimetry.
 */
export function colorDistance(
  a: { r: number; g: number; b: number },
  b: { r: number; g: number; b: number },
): number {
  const rmean = (a.r + b.r) / 2
  const dr = a.r - b.r
  const dg = a.g - b.g
  const db = a.b - b.b
  return Math.sqrt(
    (((512 + rmean) * dr * dr) / 256) + 4 * dg * dg + (((767 - rmean) * db * db) / 256),
  )
}

/**
 * How far an asset's palette sits from a reference palette.
 *
 * For each colour in the asset, weighted by how much of the image it covers,
 * take the distance to its nearest reference colour. An asset built entirely
 * from on-style colours scores ~0; one introducing a foreign hue scores high
 * in proportion to how much of the image that hue occupies.
 */
export function paletteDistance(asset: PaletteEntry[], reference: PaletteEntry[]): number {
  if (!asset.length || !reference.length) return 0
  let total = 0
  let weight = 0
  for (const color of asset) {
    let nearest = Infinity
    for (const ref of reference) nearest = Math.min(nearest, colorDistance(color, ref))
    total += nearest * color.weight
    weight += color.weight
  }
  return weight === 0 ? 0 : total / weight
}

/** Merge many palettes into one, summing weights for repeated colours. */
export function mergePalettes(palettes: PaletteEntry[][], topN = 24): PaletteEntry[] {
  const totals = new Map<string, PaletteEntry>()
  for (const palette of palettes) {
    for (const color of palette) {
      const key = `${color.r},${color.g},${color.b}`
      const existing = totals.get(key)
      if (existing) existing.weight += color.weight
      else totals.set(key, { ...color })
    }
  }
  const merged = [...totals.values()].sort((a, b) => b.weight - a.weight).slice(0, topN)
  const sum = merged.reduce((s, c) => s + c.weight, 0) || 1
  return merged.map((c) => ({ ...c, weight: c.weight / sum }))
}

export interface AssetAudit {
  assetId: string
  /** Present when this is one member of a structural multi-output asset. */
  outputRole?: string
  /** Stable report/atlas identity: assetId for one output, assetId/role for many. */
  id: string
  file: string
  width: number
  height: number
  /** Distance from the style's reference palette. Higher is more off-style. */
  paletteDistance: number
  /** Share of the canvas that is transparent. Very low suggests a baked background. */
  transparency: number
  /** Distinct opaque colours. Very high suggests photo-like rendering, not pixel art. */
  colorCount: number
  palette: PaletteEntry[]
}

export interface StyleAudit {
  styleId: string
  /** True when the reference came from the style's own styleImages. */
  referenceFromStyleImages: boolean
  reference: PaletteEntry[]
  assets: AssetAudit[]
  missing: string[]
  unreadable: string[]
}

/**
 * Measures how consistently a style's assets actually hold together.
 *
 * This exists to answer "is this variant working?" with a number instead of an
 * eyeball. Measured on a real neon trial, prose alone carried the style on
 * subjects with no strong inherent colour but was ignored on ones that had
 * some — a chocolate bar stayed brown, a camera stayed grey. Those are exactly
 * the assets this ranks to the top, before another 57 are generated to match.
 *
 * Reference palette comes from the style's `styleImages` when set, since those
 * are the declared intent. Otherwise the assets are compared against their own
 * collective palette, which still surfaces outliers but cannot tell you the
 * whole set has drifted together.
 */
export async function auditStyle(
  loaded: LoadedManifest,
  specs: ResolvedSpec[],
  styleId: string,
  lock?: Lock,
): Promise<StyleAudit> {
  const style = loaded.manifest.styles[styleId]
  if (!style) throw new Error(`Unknown style "${styleId}"`)

  const mine = specs.filter((s) => s.styleId === styleId)
  const assets: AssetAudit[] = []
  const missing: string[] = []
  const unreadable: string[] = []

  for (const spec of mine) {
    for (const output of resolveSpecOutputs(spec, lock, loaded.root)) {
      if (!existsSync(output.absolutePath)) {
        missing.push(output.id)
        continue
      }
      try {
        const png = decodePng(await readFile(output.absolutePath))
        const palette = extractPalette(png, 12)
        assets.push({
          assetId: spec.assetId,
          ...(output.role ? { outputRole: output.role } : {}),
          id: output.id,
          file: output.absolutePath,
          width: png.width,
          height: png.height,
          paletteDistance: 0, // filled once the reference is known
          transparency: transparencyRatio(png),
          colorCount: countColors(png),
          palette,
        })
      } catch (err) {
        unreadable.push(`${output.id}: ${err instanceof Error ? err.message : String(err)}`)
      }
    }
  }

  // Prefer the declared intent over the set's own average.
  let reference: PaletteEntry[] = []
  let referenceFromStyleImages = false
  const refPalettes: PaletteEntry[][] = []
  for (const img of style.styleImages) {
    const abs = path.resolve(loaded.root, img.path)
    if (!existsSync(abs)) continue
    try {
      refPalettes.push(extractPalette(decodePng(await readFile(abs)), 12))
    } catch {
      // A malformed reference should not sink the audit.
    }
  }
  if (refPalettes.length) {
    reference = mergePalettes(refPalettes)
    referenceFromStyleImages = true
    for (const asset of assets) {
      asset.paletteDistance = paletteDistance(asset.palette, reference)
    }
  } else {
    // Reported reference is the whole set, but each asset is scored against
    // the set MINUS itself. Including an asset in its own reference lets it
    // match perfectly, which would make the most divergent asset — the one
    // worth finding — score zero.
    reference = mergePalettes(assets.map((a) => a.palette))
    for (const asset of assets) {
      const others = assets.filter((a) => a !== asset).map((a) => a.palette)
      asset.paletteDistance = others.length
        ? paletteDistance(asset.palette, mergePalettes(others))
        : 0
    }
  }
  assets.sort((a, b) => b.paletteDistance - a.paletteDistance)

  return { styleId, referenceFromStyleImages, reference, assets, missing, unreadable }
}

function countColors(png: { pixels: Buffer }): number {
  const seen = new Set<number>()
  for (let i = 0; i < png.pixels.length; i += 4) {
    if (png.pixels[i + 3]! < 128) continue
    seen.add((png.pixels[i]! << 16) | (png.pixels[i + 1]! << 8) | png.pixels[i + 2]!)
  }
  return seen.size
}

/** Assets more than `sigma` standard deviations off the mean distance. */
export function outliers(audit: StyleAudit, sigma = 1.5): AssetAudit[] {
  const n = audit.assets.length
  if (n < 3) return []
  const mean = audit.assets.reduce((s, a) => s + a.paletteDistance, 0) / n
  const variance = audit.assets.reduce((s, a) => s + (a.paletteDistance - mean) ** 2, 0) / n
  const sd = Math.sqrt(variance)
  if (sd === 0) return []
  return audit.assets.filter((a) => a.paletteDistance > mean + sigma * sd)
}

export function hex(c: { r: number; g: number; b: number }): string {
  return `#${[c.r, c.g, c.b].map((v) => v.toString(16).padStart(2, "0")).join("")}`
}
