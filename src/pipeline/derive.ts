import { existsSync } from "node:fs"
import { mkdir, readFile, rename, writeFile } from "node:fs/promises"
import path from "node:path"
import { sha256, sha256File } from "../hash.ts"
import { saveLock, upsert } from "../lock.ts"
import { MediaType } from "../media.ts"
import { currentEntryOutputPath, expectedOutputPath, portableOutputPath } from "../outputs.ts"
import { normalizePalette, quantize } from "../palette.ts"
import { decodePng, encodeRgbaPng, parseHex } from "../png.ts"
import { lockKey, type Lock, type LockEntry, type ResolvedDerive, type ResolvedSpec } from "../types.ts"

/**
 * A derived asset is existing pixels put through one local transform. Nothing
 * here talks to a provider. Like a mirror it is made in the submit phase, so
 * `gen` picks it up in the wave after its source lands, and it costs nothing.
 *
 * Every transform is a pure function of the input bytes and the manifest's
 * parameters, so the recorded output hash can be reproduced and a changed
 * input or parameter is what the plan reports.
 */

const key = (r: number, g: number, b: number) => (r << 16) | (g << 8) | b

/** Replace exact colors. Alpha is untouched and unmapped colors stay. */
export function recolor(png: Buffer, map: Record<string, string>): Buffer {
  const { width, height, pixels } = decodePng(png)
  const table = new Map<number, [number, number, number]>()
  for (const [from, to] of Object.entries(map)) {
    const a = parseHex(from)
    const b = parseHex(to)
    table.set(key(a.r, a.g, a.b), [b.r, b.g, b.b])
  }
  const out = Buffer.from(pixels)
  for (let i = 0; i < out.length; i += 4) {
    if (out[i + 3] === 0) continue
    const hit = table.get(key(out[i]!, out[i + 1]!, out[i + 2]!))
    if (hit) {
      out[i] = hit[0]
      out[i + 1] = hit[1]
      out[i + 2] = hit[2]
    }
  }
  return encodeRgbaPng(width, height, out)
}

/** Snap every visible pixel to the nearest color of a closed palette. */
export function paletteSnap(png: Buffer, palette: string[]): Buffer {
  const snapped = quantize(decodePng(png), normalizePalette(palette).map((color) => color.hex)).png
  return encodeRgbaPng(snapped.width, snapped.height, snapped.pixels)
}

/**
 * Resize to an exact size. `nearest` samples the source cell under each output
 * pixel; `box` averages the source pixels it covers, weighting color by alpha
 * so a transparent edge does not bleed in.
 */
export function scale(png: Buffer, width: number, height: number, mode: "nearest" | "box" = "nearest"): Buffer {
  const src = decodePng(png)
  const out = Buffer.alloc(width * height * 4)
  for (let y = 0; y < height; y++) {
    const y0 = Math.floor((y * src.height) / height)
    const y1 = Math.max(y0 + 1, Math.ceil(((y + 1) * src.height) / height))
    for (let x = 0; x < width; x++) {
      const x0 = Math.floor((x * src.width) / width)
      const x1 = Math.max(x0 + 1, Math.ceil(((x + 1) * src.width) / width))
      const at = (y * width + x) * 4
      if (mode === "nearest") {
        src.pixels.copy(out, at, (y0 * src.width + x0) * 4, (y0 * src.width + x0) * 4 + 4)
        continue
      }
      let a = 0
      let r = 0
      let g = 0
      let b = 0
      let n = 0
      for (let sy = y0; sy < Math.min(y1, src.height); sy++) {
        for (let sx = x0; sx < Math.min(x1, src.width); sx++) {
          const i = (sy * src.width + sx) * 4
          const alpha = src.pixels[i + 3]!
          a += alpha
          r += src.pixels[i]! * alpha
          g += src.pixels[i + 1]! * alpha
          b += src.pixels[i + 2]! * alpha
          n++
        }
      }
      if (a > 0) {
        out[at] = Math.round(r / a)
        out[at + 1] = Math.round(g / a)
        out[at + 2] = Math.round(b / a)
      }
      out[at + 3] = Math.round(a / Math.max(1, n))
    }
  }
  return encodeRgbaPng(width, height, out)
}

export function applyDerive(png: Buffer, derive: Pick<ResolvedDerive, "transform" | "map" | "palette" | "width" | "height" | "mode">): Buffer {
  switch (derive.transform) {
    case "recolor": return recolor(png, derive.map!)
    case "palette-snap": return paletteSnap(png, derive.palette!)
    case "scale": return scale(png, derive.width!, derive.height!, derive.mode)
  }
}

/** The file a derived asset reads, or why it cannot be read yet. */
async function sourceFile(spec: ResolvedSpec, lock: Lock): Promise<{ file: string; recorded: string } | { notReady: string }> {
  const derive = spec.derive!
  if (derive.source.kind === "file") {
    const file = path.resolve(spec.root, derive.source.file)
    return existsSync(file) ? { file, recorded: await sha256File(file) } : { notReady: `source file ${derive.source.file} does not exist` }
  }
  const sourceKey = lockKey(spec.styleId, derive.source.assetId)
  const entry = lock.entries[sourceKey]
  if (!entry || entry.status !== "downloaded" || !entry.outputs.length) {
    return { notReady: `source ${sourceKey} has no downloaded output` }
  }
  if (entry.outputs.length !== 1) {
    return { notReady: `source ${sourceKey} has ${entry.outputs.length} outputs; derive takes a single image` }
  }
  const file = currentEntryOutputPath(entry, derive.source.spec, 0)
  if (!existsSync(file)) return { notReady: `source ${sourceKey} is missing on disk: ${file}` }
  return { file, recorded: entry.outputs[0]!.sha256 }
}

/** Why a derived asset's record no longer matches its input, or null when it does. */
export async function deriveStale(spec: ResolvedSpec, entry: LockEntry, lock: Lock): Promise<string | null> {
  const derive = spec.derive!
  if (derive.source.kind === "file") {
    // The file's bytes are in the spec hash already; this catches a file that
    // went missing or changed after the entry was written.
    const file = path.resolve(spec.root, derive.source.file)
    if (!existsSync(file)) return `source file ${derive.source.file} is missing`
    return entry.derive?.sourceSha256 === (await sha256File(file)) ? null : `source file ${derive.source.file} changed`
  }
  const source = lock.entries[lockKey(spec.styleId, derive.source.assetId)]
  const current = source?.outputs.length === 1 ? source.outputs[0]!.sha256 : undefined
  return entry.derive?.sourceSha256 && entry.derive.sourceSha256 === current ? null : `source ${derive.source.assetId} changed`
}

export interface DeriveOptions {
  onProgress?: (msg: string) => void
}

/** Write a derived asset's file from its input and record it as downloaded. */
export async function deriveAsset(
  spec: ResolvedSpec,
  lock: Lock,
  lockPath: string,
  opts: DeriveOptions = {},
): Promise<LockEntry> {
  const log = opts.onProgress ?? (() => {})
  const derive = spec.derive!
  const entryKey = lockKey(spec.styleId, spec.assetId)
  const source = await sourceFile(spec, lock)
  if ("notReady" in source) throw new Error(source.notReady)

  const bytes = applyDerive(await readFile(source.file), derive)
  const target = expectedOutputPath(spec, undefined, 0, 1, MediaType.PNG)
  await mkdir(path.dirname(target), { recursive: true })
  const tmp = `${target}.pixelkiln.tmp`
  await writeFile(tmp, bytes)
  await rename(tmp, target)
  const out = decodePng(bytes)

  const now = new Date().toISOString()
  const entry = upsert(lock, entryKey, {
    styleId: spec.styleId,
    assetId: spec.assetId,
    specHash: spec.specHash,
    generator: spec.generator,
    tileFeature: null,
    prompt: "",
    width: out.width,
    height: out.height,
    revision: null,
    derive: derive.source.kind === "asset"
      ? { sourceAssetId: derive.source.assetId, sourceSha256: source.recorded }
      : { sourceFile: derive.source.file, sourceSha256: source.recorded },
    supersededOutputs: [],
    jobId: null,
    submissionComplete: undefined,
    reviewObjectId: null,
    objectId: null,
    candidateIndex: null,
    status: "downloaded",
    error: null,
    outputs: [{ path: portableOutputPath(target, spec.root), sha256: sha256(bytes), mediaType: MediaType.PNG }],
    sourceUrl: null,
    sourceUrls: [],
    submittedAt: now,
    downloadedAt: now,
    history: [],
    cost: 0,
    costUnit: spec.costUnit,
    provider: spec.provider,
    postprocess: undefined,
  })
  await saveLock(lockPath, lock)
  log(`  derive  ${entryKey} ← ${derive.source.kind === "asset" ? derive.source.assetId : derive.source.file} (${derive.transform}, no generation cost)`)
  return entry
}
