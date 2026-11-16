import { existsSync } from "node:fs"
import { mkdir, readFile, rename, writeFile } from "node:fs/promises"
import path from "node:path"
import { sha256, sha256File } from "../hash.ts"
import { saveLock, upsert } from "../lock.ts"
import { MediaType } from "../media.ts"
import { currentEntryOutputPath, expectedOutputPath, portableOutputPath } from "../outputs.ts"
import { normalizePalette, quantize } from "../palette.ts"
import { despeckle, keySkin } from "../paperdoll.ts"
import { decodePng, encodeRgbaPng, parseHex } from "../png.ts"
import { lockKey, type Lock, type LockEntry, type LockOutput, type ResolvedDerive, type ResolvedSpec } from "../types.ts"
import { mirrorSourceHash } from "./mirror.ts"

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

/** The transforms that treat every pixel alike, and so can be run over every image of a set. */
export const SET_DERIVES: ReadonlyArray<ResolvedDerive["transform"]> = ["recolor", "palette-snap", "hue-shift"]

export interface HueShift {
  degrees?: number
  /** `[from, to]` in degrees, clockwise; a window that crosses 0 (the reds) is `[330, 30]`. */
  hue?: [number, number]
  saturation?: number
  brightness?: number
}

/** Below this saturation or brightness a pixel is a grey or an outline, and has no hue worth turning. */
const HUELESS = 0.12

/**
 * Turns hue, and scales saturation and brightness, of every visible pixel
 * whose hue is in the window (all of them, without one). Greys and
 * near-blacks are never touched, so an outline and a steel buckle stay as
 * they are while the cloth around them changes colour. Shading survives:
 * each pixel keeps its own distance from its neighbours in brightness.
 */
export function hueShift(png: Buffer, options: HueShift): Buffer {
  const { width, height, pixels } = decodePng(png)
  const out = Buffer.from(pixels)
  const turn = options.degrees ?? 0
  const within = (h: number) => {
    if (!options.hue) return true
    const [from, to] = options.hue
    return from <= to ? h >= from && h <= to : h >= from || h <= to
  }
  for (let i = 0; i < out.length; i += 4) {
    if (out[i + 3] === 0) continue
    const r = out[i]! / 255, g = out[i + 1]! / 255, b = out[i + 2]! / 255
    const max = Math.max(r, g, b), min = Math.min(r, g, b)
    const delta = max - min
    const s = max === 0 ? 0 : delta / max
    if (s < HUELESS || max < HUELESS) continue
    let h = max === r ? ((g - b) / delta) % 6 : max === g ? (b - r) / delta + 2 : (r - g) / delta + 4
    h = (h * 60 + 360) % 360
    if (!within(h)) continue
    const nh = (((h + turn) % 360) + 360) % 360
    const ns = Math.min(1, s * (options.saturation ?? 1))
    const nv = Math.min(1, max * (options.brightness ?? 1))
    const c = nv * ns
    const x = c * (1 - Math.abs(((nh / 60) % 2) - 1))
    const m = nv - c
    const [rr, gg, bb] = nh < 60 ? [c, x, 0] : nh < 120 ? [x, c, 0] : nh < 180 ? [0, c, x] : nh < 240 ? [0, x, c] : nh < 300 ? [x, 0, c] : [c, 0, x]
    out[i] = Math.round((rr + m) * 255)
    out[i + 1] = Math.round((gg + m) * 255)
    out[i + 2] = Math.round((bb + m) * 255)
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

export function applyDerive(
  png: Buffer,
  derive: Pick<ResolvedDerive, "transform" | "map" | "palette" | "degrees" | "hue" | "saturation" | "brightness" | "width" | "height" | "mode" | "skin" | "key" | "tolerance">,
  /** despeckle: the reference stills' bytes, read by the caller. */
  reference: Buffer[] = [],
): Buffer {
  switch (derive.transform) {
    case "recolor": return recolor(png, derive.map!)
    case "palette-snap": return paletteSnap(png, derive.palette!)
    case "hue-shift": return hueShift(png, derive)
    case "scale": return scale(png, derive.width!, derive.height!, derive.mode)
    case "key-skin": return keySkin(png, { skin: derive.skin, key: derive.key, tolerance: derive.tolerance })
    case "despeckle": return despeckle(png, { reference, tolerance: derive.tolerance }).png
  }
}

/** What a derived asset's record hashes of its source: the one output's hash, or a hash over a set's. */
function recordedSource(entry: Pick<LockEntry, "outputs">): string {
  return entry.outputs.length === 1 ? entry.outputs[0]!.sha256 : mirrorSourceHash(entry)
}

/** The files a derived asset reads (one, or every member of a set), or why they cannot be read yet. */
async function sourceFiles(
  spec: ResolvedSpec,
  lock: Lock,
): Promise<{ files: Array<{ file: string; role?: string }>; recorded: string } | { notReady: string }> {
  const derive = spec.derive!
  if (derive.source.kind === "file") {
    const file = path.resolve(spec.root, derive.source.file)
    return existsSync(file)
      ? { files: [{ file }], recorded: await sha256File(file) }
      : { notReady: `source file ${derive.source.file} does not exist` }
  }
  const sourceKey = lockKey(spec.styleId, derive.source.assetId)
  const entry = lock.entries[sourceKey]
  if (!entry || entry.status !== "downloaded" || !entry.outputs.length) {
    return { notReady: `source ${sourceKey} has no downloaded output` }
  }
  if (entry.outputs.length !== 1 && !SET_DERIVES.includes(derive.transform)) {
    return { notReady: `source ${sourceKey} has ${entry.outputs.length} outputs; ${derive.transform} takes a single image` }
  }
  const files: Array<{ file: string; role?: string }> = []
  for (const [index, output] of entry.outputs.entries()) {
    const file = currentEntryOutputPath(entry, derive.source.spec, index)
    if (!existsSync(file)) return { notReady: `source ${sourceKey} is missing on disk: ${file}` }
    files.push({ file, ...(output.role ? { role: output.role } : {}) })
  }
  return { files, recorded: recordedSource(entry) }
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
  const current = source?.outputs.length ? recordedSource(source) : undefined
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
  const source = await sourceFiles(spec, lock)
  if ("notReady" in source) throw new Error(source.notReady)

  const reference: Buffer[] = []
  for (const still of derive.reference ?? []) {
    const file = path.resolve(spec.root, still.file)
    if (!existsSync(file)) throw new Error(`reference still ${still.file} does not exist`)
    reference.push(await readFile(file))
  }
  // One output per source image, under the source's own roles, so a recoloured
  // layer's frames pair with the frames they sit over exactly as the layer's do.
  const outputs: LockOutput[] = []
  let out = { width: spec.width, height: spec.height }
  for (const [index, member] of source.files.entries()) {
    const bytes = applyDerive(await readFile(member.file), derive, reference)
    const target = expectedOutputPath(spec, member.role, index, source.files.length, MediaType.PNG)
    await mkdir(path.dirname(target), { recursive: true })
    const tmp = `${target}.pixelkiln.tmp`
    await writeFile(tmp, bytes)
    await rename(tmp, target)
    if (index === 0) out = decodePng(bytes)
    outputs.push({
      path: portableOutputPath(target, spec.root),
      sha256: sha256(bytes),
      ...(member.role ? { role: member.role } : {}),
      mediaType: MediaType.PNG,
    })
  }

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
    outputs,
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
