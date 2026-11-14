/**
 * Upkeep for characters and objects that already exist on PixelLab: canvas
 * size, a mirrored animation direction, importing your own sprite, expanding
 * a 1-direction object to 8, and the website's exports. Standalone, by
 * PixelLab id; the manifest's generators still make the assets.
 */
import { existsSync } from "node:fs"
import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises"
import path from "node:path"
import { PixelLabError, type PixelLabAssetKind, type PixelLabClient, type PixelLabExportFormat } from "./client.ts"
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

// Free imports of your own tiles, and saving edited pixels back.

export const TILESET_MODES = ["topdown", "sidescroller"] as const
export const IMPORT_TILE_TYPES = ["square_topdown", "isometric", "oblique", "hex", "hex_pointy", "octagon"] as const
export const IMPORT_TILE_VIEWS = ["top-down", "high top-down", "low top-down", "side"] as const
/** Tile sizes a sheet can be cut into. PixelLab reads a 48px compact sheet but has no way to be told 48. */
const SHEET_TILE_SIZES = [16, 24, 32, 48, 64]
export const IMPORT_MAX_TILES = 32

export interface TilesetSheetReading {
  tileSize: number
  /** `compact` is the 4-wide sheet a tileset download gives; `native` is PixelLab's 8-wide one. */
  layout: "compact" | "native"
}

/**
 * Every way PixelLab could cut a sheet of this size: 4 tiles wide (4 or 8
 * rows) or 8 wide (8 or 16 rows). 128, 192 and 256px sheets read both ways,
 * and PixelLab takes the 4-wide reading unless told the tile size (measured:
 * a 16px native sheet sent without one came back as sixteen 32px tiles).
 */
export function tilesetSheetReadings(width: number, height: number): TilesetSheetReading[] {
  if (height !== width && height !== width * 2) return []
  const readings: TilesetSheetReading[] = []
  if (SHEET_TILE_SIZES.includes(width / 4)) readings.push({ tileSize: width / 4, layout: "compact" })
  if (SHEET_TILE_SIZES.includes(width / 8)) readings.push({ tileSize: width / 8, layout: "native" })
  return readings
}

/** Pick the reading for a sheet, refusing one that is no PixelLab layout or that reads two ways with no tile size given. */
export function chooseTilesetSheetReading(file: string, width: number, height: number, tileSize?: number): TilesetSheetReading {
  const readings = tilesetSheetReadings(width, height)
  const describe = (reading: TilesetSheetReading) => `${reading.tileSize}px tiles (${reading.layout === "compact" ? "4 wide" : "8 wide"})`
  if (readings.length === 0) {
    throw new Error(
      `${file} is ${width}x${height}, not a PixelLab tileset sheet: it takes a square sheet 4 or 8 tiles wide ` +
        "(or twice as tall, for a set with transitions) of 16, 24, 32, 48 or 64px tiles",
    )
  }
  if (tileSize === undefined) {
    if (readings.length > 1) {
      throw new Error(
        `${file} is ${width}x${height}, which reads as ${readings.map(describe).join(" or ")}; ` +
          `say which with --size ${readings.map((reading) => reading.tileSize).join(" or --size ")}`,
      )
    }
    return readings[0]!
  }
  const chosen = readings.find((reading) => reading.tileSize === tileSize)
  if (!chosen) throw new Error(`${file} is ${width}x${height}, which holds ${readings.map(describe).join(" or ")}, not ${tileSize}px tiles`)
  return chosen
}

function readPng(bytes: Buffer, file: string): { width: number; height: number } {
  const metadata = imageMetadata(bytes)
  if (!metadata || metadata.format !== "png") throw new Error(`${file} is not a PNG`)
  return metadata
}

export interface ImportTilesetOptions {
  mode?: (typeof TILESET_MODES)[number]
  tileSize?: number
  lowerDescription?: string
  upperDescription?: string
  transitionDescription?: string
  name?: string
}

/** Import a Wang sheet as a completed tileset. Free; the sheet is cut into its 16 (or 25) tiles with new ids. */
export async function importTilesetFile(
  client: Pick<PixelLabClient, "importTileset">,
  file: string,
  opts: ImportTilesetOptions = {},
): Promise<{ tilesetId: string; mode: (typeof TILESET_MODES)[number]; tileSize: number; layout: TilesetSheetReading["layout"] }> {
  const bytes = await readFile(file)
  const { width, height } = readPng(bytes, file)
  const reading = chooseTilesetSheetReading(file, width, height, opts.tileSize)
  const mode = opts.mode ?? "topdown"
  if (mode === "sidescroller" && opts.upperDescription) throw new Error("a sidescroller tileset has one terrain, the platform; drop the upper description")
  const res = await client.importTileset({
    spritesheet: { base64: bytes.toString("base64"), format: "png" },
    mode,
    // PixelLab cannot be told 48, and a 4-wide reading is the one it takes unprompted.
    tileSize: reading.tileSize === 48 ? undefined : reading.tileSize,
    lowerDescription: opts.lowerDescription,
    upperDescription: opts.upperDescription,
    transitionDescription: opts.transitionDescription,
    name: opts.name,
  })
  return { tilesetId: res.tileset_id, mode, tileSize: reading.tileSize, layout: reading.layout }
}

/** The PNGs `from` names, in name order: the file itself, or every PNG in a directory. */
export async function pngFilesAt(from: string): Promise<string[]> {
  if (!existsSync(from)) throw new Error(`${from} does not exist`)
  if (!(await stat(from)).isDirectory()) return [from]
  const names = (await readdir(from)).filter((name) => /\.png$/i.test(name)).sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
  if (names.length === 0) throw new Error(`${from} holds no PNG files`)
  return names.map((name) => path.join(from, name))
}

/**
 * The height a tile of this type may have, by PixelLab's import rule: square
 * and octagon tiles are exactly the tile size, isometric and hex tiles half
 * to twice it, oblique tiles one to twice it. Every tile is the tile size wide.
 */
export function importTileHeights(tileType: string, tileSize: number): { min: number; max: number } {
  if (tileType === "square_topdown" || tileType === "octagon") return { min: tileSize, max: tileSize }
  if (tileType === "oblique") return { min: tileSize, max: tileSize * 2 }
  return { min: tileSize / 2, max: tileSize * 2 }
}

/** Import tile PNGs (a file, or a directory's PNGs in name order) as one completed tile group. Free. */
export async function importTilesFiles(
  client: Pick<PixelLabClient, "importTilesPro">,
  from: string,
  opts: { tileType: string; tileSize: number; description?: string; tileView?: string },
): Promise<{ tileId: string; tiles: number; files: string[] }> {
  if (!(IMPORT_TILE_TYPES as readonly string[]).includes(opts.tileType)) throw new Error(`tile type must be one of ${IMPORT_TILE_TYPES.join(", ")}`)
  if (!Number.isInteger(opts.tileSize) || opts.tileSize < 16 || opts.tileSize > 256) throw new Error("tile size is a whole number from 16 to 256")
  const files = await pngFilesAt(from)
  if (files.length > IMPORT_MAX_TILES) throw new Error(`${from} holds ${files.length} PNGs; PixelLab imports at most ${IMPORT_MAX_TILES} tiles in one group`)
  const heights = importTileHeights(opts.tileType, opts.tileSize)
  const frames = []
  for (const file of files) {
    const bytes = await readFile(file)
    const { width, height } = readPng(bytes, file)
    if (width !== opts.tileSize || height < heights.min || height > heights.max) {
      const tall = heights.min === heights.max ? `${heights.min}` : `${heights.min} to ${heights.max}`
      throw new Error(`${file} is ${width}x${height}; a ${opts.tileSize}px ${opts.tileType} tile is ${opts.tileSize} wide and ${tall} tall`)
    }
    frames.push({ base64: bytes.toString("base64"), format: "png" as const })
  }
  const res = await client.importTilesPro({ frames, tileType: opts.tileType, tileSize: opts.tileSize, description: opts.description, tileView: opts.tileView })
  return { tileId: res.tile_id, tiles: files.length, files }
}

/** `character:<id>:<direction>`, `object:<id>[:<direction>]`, either with `:<group id>`, `gallery:<id>`, `gallery:new`, or `tileset:<id>`. */
export function checkSaveTarget(target: string): void {
  if (!/^(character:[^:]+:[^:]+(:[^:]+)?|object:[^:]+(:[^:]+){0,2}|gallery:[^:]+|tileset:[^:]+)$/.test(target)) {
    throw new Error(
      `--target "${target}" is not a place PixelLab can save to. Use character:<id>:<direction>, object:<id>[:<direction>], ` +
        "either with :<animation group id> added, gallery:<id>, gallery:new, or tileset:<id>",
    )
  }
}

/** Where the replaced frames go when `--out` names no directory: beside the work, named for the target and the time. */
export function saveUndoDir(target: string, now = new Date()): string {
  const stamp = now.toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z")
  return path.resolve("pixelkiln-undo", `${target.replace(/[^a-zA-Z0-9-]+/g, "_")}-${stamp}`)
}

export interface SaveToAssetResult {
  action: "saved" | "added" | "unchanged"
  target: string
  kind: string
  width: number
  height: number
  frames: number
  changedPixels: number
  /** The replaced frames as written to disk, in order; empty for a new image or an unchanged save. */
  undo: string[]
  note: string | null
  maps: string | null
}

async function writeUndo(frames: Array<{ base64: string }>, dir: string): Promise<string[]> {
  await mkdir(dir, { recursive: true })
  const files: string[] = []
  for (const [index, frame] of frames.entries()) {
    const file = path.join(dir, frames.length === 1 ? "previous.png" : `previous-${String(index).padStart(2, "0")}.png`)
    await writeFile(file, Buffer.from(frame.base64, "base64"))
    files.push(file)
  }
  return files
}

/**
 * Save a PNG, a GIF, or a directory of PNG frames into `target`, and write
 * what it replaced to `undoDir` before returning. A save that fails partway
 * (PixelLab's 500) still hands back the old frames; they are written too,
 * and the error names where.
 */
export async function saveToAssetFile(
  client: Pick<PixelLabClient, "saveToAsset">,
  target: string,
  from: string,
  opts: { name?: string; description?: string; undoDir?: string } = {},
): Promise<SaveToAssetResult> {
  checkSaveTarget(target)
  if ((opts.name || opts.description) && target !== "gallery:new") throw new Error("a name and a description belong to a new gallery image: --target gallery:new")
  const files = await pngFilesAt(from).catch(async (error: unknown) => {
    // A single GIF is the other accepted form.
    if (existsSync(from) && /\.gif$/i.test(from)) return [from]
    throw error
  })
  let image: { base64: string; format: "png" | "gif" } | undefined
  let frames: Array<{ base64: string; format: "png" }> | undefined
  if (files.length === 1) {
    const bytes = await readFile(files[0]!)
    const gif = bytes.subarray(0, 4).toString("ascii") === "GIF8"
    if (!gif) readPng(bytes, files[0]!)
    image = { base64: bytes.toString("base64"), format: gif ? "gif" : "png" }
  } else {
    if (files.length > 128) throw new Error(`${from} holds ${files.length} PNGs; PixelLab takes at most 128 frames`)
    let size: string | undefined
    frames = []
    for (const file of files) {
      const bytes = await readFile(file)
      const { width, height } = readPng(bytes, file)
      if (size && size !== `${width}x${height}`) throw new Error(`${file} is ${width}x${height}, but the frames before it are ${size}; an animation's frames share one size`)
      size = `${width}x${height}`
      frames.push({ base64: bytes.toString("base64"), format: "png" })
    }
  }
  const undoDir = opts.undoDir ? path.resolve(opts.undoDir) : saveUndoDir(target)
  let res: Awaited<ReturnType<PixelLabClient["saveToAsset"]>>
  try {
    res = await client.saveToAsset({ target, image, frames, name: opts.name, description: opts.description })
  } catch (error) {
    if (error instanceof PixelLabError && error.body.startsWith("{")) {
      let previous: unknown
      try {
        previous = (JSON.parse(error.body) as { detail?: { previous_frames?: unknown } }).detail?.previous_frames
      } catch {
        previous = undefined
      }
      if (Array.isArray(previous) && previous.length && previous.every((frame) => typeof (frame as { base64?: unknown })?.base64 === "string")) {
        const written = await writeUndo(previous as Array<{ base64: string }>, undoDir)
        throw new Error(`${error.message}. The save failed partway; what was stored before is in ${undoDir} (${written.length} frame(s)). Save it back to ${target} to restore it`)
      }
    }
    throw error
  }
  const undo = res.action === "saved" && res.previous_frames?.length ? await writeUndo(res.previous_frames, undoDir) : []
  return {
    action: res.action,
    target: res.target,
    kind: res.kind,
    width: res.width,
    height: res.height,
    frames: res.frame_count,
    changedPixels: res.changed_pixels,
    undo,
    note: res.note ?? null,
    maps: res.maps ?? null,
  }
}
