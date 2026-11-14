/**
 * Upkeep for characters and objects that already exist on PixelLab: canvas
 * size, a mirrored animation direction, importing your own sprite, expanding
 * a 1-direction object to 8, and the website's exports. Standalone, by
 * PixelLab id; the manifest's generators still make the assets.
 */
import { existsSync } from "node:fs"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import path from "node:path"
import type { PixelLabAssetKind, PixelLabClient, PixelLabExportFormat } from "./client.ts"
import { imageMetadata, MediaType, validateMedia } from "./media.ts"

export const ASSET_KINDS = ["object", "character"] as const
export const EXPORT_FORMATS = ["zip", "spritesheet", "aseprite", "gif"] as const
export const MIRROR_DIRECTIONS = ["east", "west", "south-east", "south-west", "north-east", "north-west"] as const
export const EXPAND_DIRECTIONS = ["south", "south-east", "east", "north-east", "north", "north-west", "west", "south-west"] as const
/** PixelLab's published range for one expansion, by the padded canvas. */
export const EXPAND_MIN_COST = 10
export const EXPAND_MAX_COST = 25
export const IMPORT_MAX_SIDE = 256

/** `"48x64"` as a canvas size: whole multiples of 4, from 8 up to 256 (characters) or 400 (objects). */
export function parseCanvasSize(text: string, kind: PixelLabAssetKind): { width: number; height: number } {
  const match = /^(\d+)\s*x\s*(\d+)$/i.exec(text.trim())
  const max = kind === "object" ? 400 : 256
  const width = Number(match?.[1])
  const height = Number(match?.[2])
  if (!match || [width, height].some((side) => side < 8 || side > max || side % 4 !== 0)) {
    throw new Error(`--size is <width>x<height> in multiples of 4, from 8 to ${max} for a ${kind}, e.g. 64x64; got "${text}"`)
  }
  return { width, height }
}

/** The file an export is written to when `--out` has no extension of its own. A spritesheet arrives as a ZIP of a PNG and its layout JSON. */
export function exportOutPath(out: string, format: PixelLabExportFormat): string {
  const extension = format === "aseprite" ? ".aseprite" : format === "gif" ? ".gif" : ".zip"
  return path.extname(out) ? path.resolve(out) : path.resolve(`${out}${extension}`)
}

/** Refuse an error page saved as an export: a ZIP starts `PK`, a GIF `GIF8`, and an .aseprite file carries 0xA5E0 at offset 4. */
export function checkExportBytes(bytes: Buffer, format: PixelLabExportFormat): void {
  const ok =
    format === "gif" ? bytes.subarray(0, 4).toString("ascii") === "GIF8"
    : format === "aseprite" ? bytes.length > 6 && bytes.readUInt16LE(4) === 0xa5e0
    : bytes.subarray(0, 2).toString("ascii") === "PK"
  if (!ok) throw new Error(`PixelLab's ${format} export was not a ${format === "spritesheet" ? "ZIP" : format} file (${bytes.length} bytes)`)
}

export async function exportAssetFile(
  client: Pick<PixelLabClient, "exportAsset">,
  kind: PixelLabAssetKind,
  id: string,
  format: PixelLabExportFormat,
  opts: { out: string; animationGroupId?: string; direction?: string; force?: boolean },
): Promise<{ out: string; bytes: number }> {
  const out = exportOutPath(opts.out, format)
  if (existsSync(out) && !opts.force) throw new Error(`${out} already exists; pass --force to replace it`)
  const bytes = await client.exportAsset(kind, id, format, { animationGroupId: opts.animationGroupId, direction: opts.direction })
  checkExportBytes(bytes, format)
  await mkdir(path.dirname(out), { recursive: true })
  await writeFile(out, bytes)
  return { out, bytes: bytes.length }
}

/** Import a PNG as a completed 1-direction object. PNG only, at most 256x256; stored exactly. */
export async function importObjectFile(
  client: Pick<PixelLabClient, "importObject">,
  file: string,
  opts: { name?: string } = {},
): Promise<{ objectId: string; name: string | null; size: { width: number; height: number }; imageUrl: string }> {
  const bytes = await readFile(file)
  const metadata = imageMetadata(bytes)
  if (!metadata || metadata.format !== "png") throw new Error(`${file} is not a PNG; PixelLab imports PNG only (JPEG compression would be stored as pixels)`)
  if (metadata.width > IMPORT_MAX_SIDE || metadata.height > IMPORT_MAX_SIDE) {
    throw new Error(`${file} is ${metadata.width}x${metadata.height}; PixelLab imports at most ${IMPORT_MAX_SIDE}x${IMPORT_MAX_SIDE}`)
  }
  const res = await client.importObject({ image: { base64: bytes.toString("base64"), format: "png" }, name: opts.name })
  return { objectId: res.object_id, name: res.name ?? null, size: { width: res.size.width, height: res.size.height }, imageUrl: res.image_url }
}

export interface ExpandObjectOptions {
  existingDirection: string
  description?: string
  intervalMs?: number
  timeoutMs?: number
  onProgress?: (status: string) => void
  onQuote?: (min: number, max: number) => void
  sleep?: (ms: number) => Promise<void>
}

export interface ExpandObjectResult {
  objectId: string
  jobId: string
  minGenerations: number
  maxGenerations: number
  /** The object's status once the wait ended: `review-expansion` when the new directions are ready to keep or discard. */
  status: string
  usage: unknown
}

/**
 * Ask for a 1-direction object's 7 missing directions and wait until they are
 * ready for review. The object stays 1-direction until the review is accepted.
 */
export async function expandObject(
  client: Pick<PixelLabClient, "expandObjectRotations" | "getObject" | "getBackgroundJob">,
  id: string,
  opts: ExpandObjectOptions,
): Promise<ExpandObjectResult> {
  const submitted = await client.expandObjectRotations(id, { existingDirection: opts.existingDirection, description: opts.description })
  opts.onQuote?.(submitted.min_generations, submitted.max_generations)
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)))
  const interval = opts.intervalMs ?? 10_000
  const timeout = opts.timeoutMs ?? 10 * 60_000
  const started = Date.now()
  for (;;) {
    const object = await client.getObject(id)
    const status = object.status ?? "unknown"
    opts.onProgress?.(status)
    if (status === "failed") throw new Error(`PixelLab could not expand object ${id}`)
    if (status !== "expanding") {
      let usage: unknown = null
      try {
        usage = (await client.getBackgroundJob(submitted.background_job_id)).usage ?? null
      } catch {
        usage = null
      }
      return { objectId: id, jobId: submitted.background_job_id, minGenerations: submitted.min_generations, maxGenerations: submitted.max_generations, status, usage }
    }
    if (Date.now() - started > timeout) {
      throw new Error(`object ${id} is still expanding after ${Math.round(timeout / 1000)} s; it keeps running upstream, and asset expand --keep or --discard finishes it later`)
    }
    await sleep(interval)
  }
}

/**
 * Download the directions an expansion is waiting to have reviewed, one PNG
 * per direction, so they can be looked at before `--keep` or `--discard`.
 */
export async function pullExpansionReview(
  client: Pick<PixelLabClient, "getObject" | "download">,
  id: string,
  opts: { out: string; force?: boolean },
): Promise<{ dir: string; existingDirection: string | null; files: Array<{ direction: string; file: string }> }> {
  const object = (await client.getObject(id)) as { status?: string | null; expansion_review?: unknown }
  const review = object.expansion_review as { existing_direction?: string; rotation_urls?: Record<string, string | null> } | null | undefined
  if (object.status !== "review-expansion" || !review?.rotation_urls) {
    throw new Error(`object ${id} is ${object.status ?? "unknown"}; there is no expansion waiting for review`)
  }
  const dir = path.resolve(opts.out)
  const entries = Object.entries(review.rotation_urls).filter((entry): entry is [string, string] => typeof entry[1] === "string")
  const files = entries.map(([direction]) => ({ direction, file: path.join(dir, `${direction}.png`) }))
  if (!opts.force) {
    for (const { file } of files) if (existsSync(file)) throw new Error(`${file} already exists; pass --force to replace it`)
  }
  await mkdir(dir, { recursive: true })
  for (const [index, [, url]] of entries.entries()) {
    const bytes = await client.download(url)
    validateMedia(bytes, MediaType.PNG)
    await writeFile(files[index]!.file, bytes)
  }
  return { dir, existingDirection: review.existing_direction ?? null, files }
}
