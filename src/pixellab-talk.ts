/**
 * Talking portraits: PixelLab draws a portrait's mouth positions ("visemes")
 * once, for generations, and then lip-syncs any line of text to them for
 * free, as a GIF or as a frame plan a game engine plays itself. Standalone,
 * outside the manifest: the output is a strip of mouth positions and a
 * record, not one sprite with a prompt.
 */
import { existsSync } from "node:fs"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import path from "node:path"
import type { PixelLabClient } from "./client.ts"
import { imageMetadata } from "./media.ts"
import { decodePng, encodeRgbaPng } from "./png.ts"

export const TALK_MOODS = ["neutral", "happy", "angry", "sad", "surprised"] as const
export const VISEME_COUNTS = [3, 5, 7, 12] as const
export const VISEME_ENGINES = ["v3", "pixminimax"] as const
export type TalkMood = (typeof TALK_MOODS)[number]
export type VisemeEngine = (typeof VISEME_ENGINES)[number]
export const PORTRAIT_MAX_SIDE = 256
export const TALK_MAX_TEXT = 500

/**
 * Generations for one expression's mouth positions. PixelLab publishes the
 * price for 7 positions only: `pixminimax` 3 at any size up to 256px, `v3` 3
 * at 64px, 6 at 128px and 24 at 256px. Other counts are scaled by count/7
 * and rounded up, which is this tool's guess, not PixelLab's figure. A
 * portrait of unknown size (a character's stored one) is priced at 256px.
 */
export function visemeCost(engine: VisemeEngine, side: number | "unknown", count: number): number {
  const forSeven = engine === "pixminimax" ? 3 : side === "unknown" || side > 128 ? 24 : side > 64 ? 6 : 3
  return Math.ceil((forSeven * count) / 7)
}

export function talkOutputPaths(out: string): { strip: string; record: string } {
  const base = path.resolve(out.replace(/\.(png|json)$/i, "").replace(/\.(talk|visemes)$/i, ""))
  return { strip: `${base}.visemes.png`, record: `${base}.talk.json` }
}

export interface TalkRecord {
  version: 1
  provider: "pixellab"
  tool: "vocal-animation"
  engine: VisemeEngine
  mood: string
  visemeCount: number
  /** Column order of the strip. */
  visemeOrder: string[]
  /** One mouth position's size; the strip is `visemeOrder.length` cells wide. */
  cell: { width: number; height: number }
  strip: string
  source: { portrait?: string; characterId?: string }
  /** Set for a character: every expression now stored on it, in spritesheet row order. */
  moodsOnCharacter?: string[]
  jobId: string
  usage: unknown
  createdAt: string
}

export interface MakeVisemesOptions {
  /** A local portrait PNG, up to 256x256. Nothing is stored on PixelLab. */
  portrait?: string
  /** Or a character with a stored portrait; the set is saved onto it. */
  characterId?: string
  mood?: TalkMood
  visemeCount?: number
  engine?: VisemeEngine
  seed?: number
  out: string
  force?: boolean
  onProgress?: (message: string) => void
  intervalMs?: number
  timeoutMs?: number
  sleep?: (ms: number) => Promise<void>
}

/** A portrait file's bytes and longer side, refused when it is not a PNG up to 256px. */
export function readPortrait(bytes: Buffer, label: string): { base64: string; side: number } {
  const metadata = imageMetadata(bytes)
  if (metadata?.format !== "png") throw new Error(`${label} is not a PNG`)
  const side = Math.max(metadata.width, metadata.height)
  if (side > PORTRAIT_MAX_SIDE) {
    throw new Error(`${label} is ${metadata.width}x${metadata.height}; a portrait is at most ${PORTRAIT_MAX_SIDE}x${PORTRAIT_MAX_SIDE} (crop it; never rescale pixel art)`)
  }
  return { base64: bytes.toString("base64"), side }
}

/** Lay equal-sized PNGs side by side, in order. */
export function joinStrip(cells: Buffer[]): { png: Buffer; width: number; height: number } {
  const decoded = cells.map((cell) => decodePng(cell))
  const { width, height } = decoded[0]!
  if (decoded.some((cell) => cell.width !== width || cell.height !== height)) throw new Error("PixelLab's mouth positions came back in different sizes")
  const out = Buffer.alloc(width * decoded.length * height * 4)
  for (const [index, cell] of decoded.entries()) {
    for (let y = 0; y < height; y++) {
      Buffer.from(cell.pixels.buffer, cell.pixels.byteOffset + y * width * 4, width * 4).copy(out, (y * width * decoded.length + index * width) * 4)
    }
  }
  return { png: encodeRgbaPng(width * decoded.length, height, out), width, height }
}

/** Cut a strip (or one row of a character's grid) back into its cells. */
export function cutStrip(strip: Buffer, columns: number, cell: { width: number; height: number }, row = 0): Buffer[] {
  const sheet = decodePng(strip)
  if (sheet.width !== cell.width * columns || sheet.height < cell.height * (row + 1)) {
    throw new Error(`the mouth-position strip is ${sheet.width}x${sheet.height}, not ${columns} cells of ${cell.width}x${cell.height}; it was changed after it was made`)
  }
  const pixels = Buffer.from(sheet.pixels.buffer, sheet.pixels.byteOffset, sheet.pixels.byteLength)
  return Array.from({ length: columns }, (_, index) => {
    const out = Buffer.alloc(cell.width * cell.height * 4)
    for (let y = 0; y < cell.height; y++) {
      pixels.copy(out, y * cell.width * 4, ((row * cell.height + y) * sheet.width + index * cell.width) * 4, ((row * cell.height + y) * sheet.width + (index + 1) * cell.width) * 4)
    }
    return encodeRgbaPng(cell.width, cell.height, out)
  })
}

/**
 * Generate one expression's mouth positions, wait for them, and write the
 * strip and its record. Paid: the caller prices it first with `visemeCost`.
 */
export async function makeVisemes(
  client: Pick<PixelLabClient, "createVocalAnimation" | "getVocalAnimation" | "getBackgroundJob" | "download">,
  opts: MakeVisemesOptions,
): Promise<TalkRecord & { paths: { strip: string; record: string } }> {
  if (Boolean(opts.portrait) === Boolean(opts.characterId)) throw new Error("give a portrait file or a character id, not both")
  const paths = talkOutputPaths(opts.out)
  if (!opts.force) for (const file of [paths.strip, paths.record]) if (existsSync(file)) throw new Error(`${file} already exists; pass --force to replace it`)
  const progress = opts.onProgress ?? (() => {})
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)))
  const interval = opts.intervalMs ?? 8000
  const timeout = opts.timeoutMs ?? 10 * 60_000
  const portrait = opts.portrait ? readPortrait(await readFile(opts.portrait), opts.portrait) : undefined
  const engine = opts.engine ?? "v3"
  const visemeCount = opts.visemeCount ?? 7

  const submitted = await client.createVocalAnimation({
    portrait: portrait ? { base64: portrait.base64, format: "png" } : undefined,
    characterId: opts.characterId,
    mood: opts.mood,
    visemeCount,
    engine,
    seed: opts.seed,
  })
  const jobId = submitted.background_job_id
  progress(`submitted job ${jobId}`)
  const started = Date.now()
  let job: Awaited<ReturnType<PixelLabClient["getVocalAnimation"]>>
  for (;;) {
    job = await client.getVocalAnimation(jobId)
    if (job.status === "completed") break
    if (job.status === "failed") throw new Error(`PixelLab vocal-animation job ${jobId} failed upstream`)
    if (Date.now() - started > timeout) {
      throw new Error(`PixelLab vocal-animation job ${jobId} is still ${job.status} after ${Math.round(timeout / 1000)} s; it keeps running upstream, but this command has stopped waiting`)
    }
    progress(`${job.completed_visemes.length} of ${visemeCount} mouth positions`)
    await sleep(interval)
  }

  let strip: Buffer
  let visemeOrder: string[]
  let cell: { width: number; height: number }
  if (job.visemes) {
    // The stateless form: frames inline. `completed_visemes` is the order they were drawn in, which is the preset's column order.
    visemeOrder = job.completed_visemes.filter((id) => job.visemes![id])
    if (visemeOrder.length !== Object.keys(job.visemes).length) visemeOrder = Object.keys(job.visemes)
    const joined = joinStrip(visemeOrder.map((id) => Buffer.from(job.visemes![id]!.base64, "base64")))
    strip = joined.png
    cell = { width: joined.width, height: joined.height }
  } else if (job.grid_url && job.viseme_order?.length) {
    // The character form: the whole stored grid, one row per expression.
    strip = await client.download(job.grid_url)
    visemeOrder = job.viseme_order
    const sheet = imageMetadata(strip)
    if (!sheet) throw new Error(`PixelLab's mouth-position sheet for job ${jobId} is not a readable image`)
    const rows = Math.max(1, job.moods_on_character?.length ?? 1)
    cell = { width: sheet.width / visemeOrder.length, height: sheet.height / rows }
  } else {
    throw new Error(`PixelLab vocal-animation job ${jobId} finished with no mouth positions and no spritesheet`)
  }
  // The bill is on the shared job record, not on the vocal-animation reply.
  const usage = (await client.getBackgroundJob(jobId).catch(() => null))?.usage ?? job.usage ?? null

  await mkdir(path.dirname(paths.strip), { recursive: true })
  await writeFile(paths.strip, strip)
  const record: TalkRecord = {
    version: 1,
    provider: "pixellab",
    tool: "vocal-animation",
    engine,
    mood: job.mood ?? opts.mood ?? "neutral",
    visemeCount,
    visemeOrder,
    cell,
    strip: path.basename(paths.strip),
    source: opts.portrait
      ? { portrait: path.relative(path.dirname(paths.record), path.resolve(opts.portrait)).split(path.sep).join("/") }
      : { characterId: opts.characterId },
    ...(job.moods_on_character ? { moodsOnCharacter: job.moods_on_character } : {}),
    jobId,
    usage,
    createdAt: new Date().toISOString(),
  }
  await writeFile(paths.record, `${JSON.stringify(record, null, 2)}\n`)
  return { ...record, paths }
}

/** Read a `.talk.json` record and the mouth positions its strip holds, keyed by id. */
export async function readTalkRecord(file: string): Promise<{ record: TalkRecord; visemes: Record<string, { base64: string; format: "png" }> }> {
  let record: TalkRecord
  try {
    record = JSON.parse(await readFile(file, "utf8")) as TalkRecord
  } catch (error) {
    throw new Error(`${file} is not a readable .talk.json record: ${error instanceof Error ? error.message : String(error)}`)
  }
  if (record?.tool !== "vocal-animation" || !Array.isArray(record.visemeOrder) || !record.cell || !record.strip) {
    throw new Error(`${file} is not a .talk.json record from pixelkiln talk visemes`)
  }
  const stripFile = path.resolve(path.dirname(path.resolve(file)), record.strip)
  if (!existsSync(stripFile)) throw new Error(`${file} names ${record.strip}, which is missing beside it`)
  // A character's grid holds one row per expression; this record's own mood picks the row.
  const row = Math.max(0, record.moodsOnCharacter?.indexOf(record.mood) ?? 0)
  const cells = cutStrip(await readFile(stripFile), record.visemeOrder.length, record.cell, row)
  const visemes = Object.fromEntries(record.visemeOrder.map((id, index) => [id, { base64: cells[index]!.toString("base64"), format: "png" as const }]))
  return { record, visemes }
}

export interface TalkSource {
  /** A `.talk.json` record: its mouth positions are sent with the request. */
  record?: string
  /** Or a character whose mouth positions are stored on PixelLab. */
  characterId?: string
  mood?: TalkMood
}

function checkText(text: string): string {
  const line = text.trim()
  if (!line) throw new Error("the line of dialogue is empty")
  if (line.length > TALK_MAX_TEXT) throw new Error(`the line is ${line.length} characters; PixelLab lip-syncs at most ${TALK_MAX_TEXT}. Split it into shorter lines`)
  return line
}

export interface TalkingGifResult {
  out: string
  frames: number
  durationMs: number
  frameMs: number
  holdMs: number
  width: number
  height: number
  bytes: number
}

/** Lip-sync a line to a GIF. Free: it only reorders mouth positions already made. */
export async function makeTalkingGif(
  client: Pick<PixelLabClient, "createTalkingGif">,
  text: string,
  source: TalkSource,
  opts: { out: string; frameMs?: number; holdMs?: number; force?: boolean },
): Promise<TalkingGifResult> {
  if (Boolean(source.record) === Boolean(source.characterId)) throw new Error("give a .talk.json record or a character id, not both")
  if (source.record && source.mood) throw new Error("a record holds one expression; --mood picks among a character's stored ones")
  const out = path.extname(opts.out) ? path.resolve(opts.out) : path.resolve(`${opts.out}.gif`)
  if (existsSync(out) && !opts.force) throw new Error(`${out} already exists; pass --force to replace it`)
  const line = checkText(text)
  const visemes = source.record ? (await readTalkRecord(source.record)).visemes : undefined
  const res = await client.createTalkingGif({ text: line, visemes, characterId: source.characterId, mood: source.mood, frameMs: opts.frameMs, holdMs: opts.holdMs })
  const bytes = Buffer.from(res.gif_base64, "base64")
  if (bytes.subarray(0, 4).toString("ascii") !== "GIF8") throw new Error(`PixelLab's talking GIF was not a GIF (${bytes.length} bytes)`)
  await mkdir(path.dirname(out), { recursive: true })
  await writeFile(out, bytes)
  return { out, frames: res.frames, durationMs: res.duration_ms, frameMs: res.frame_ms, holdMs: res.hold_ms, width: res.width, height: res.height, bytes: bytes.length }
}

export interface LipSyncPlan {
  version: 1
  text: string
  totalMs: number
  visemeOrder: string[]
  /** `column` is the cell of the strip to show; `textOffset` is how many characters have been spoken by the end of the frame. */
  frames: Array<{ viseme: string; column: number; durationMs: number; textOffset: number }>
  mood: string | null
  /** The strip beside the record, for a record; the character's stored grid URL otherwise. */
  strip: string | null
  /** The row of `mood` in a character's grid; 0 for a record's own strip. */
  row: number
  cell: { width: number; height: number } | null
}

/** The frame-by-frame plan for a line, for an engine that draws the mouth itself. Free; nothing is rendered. */
export async function planLipSync(
  client: Pick<PixelLabClient, "getLipSync">,
  text: string,
  source: TalkSource & { visemeCount?: number },
  opts: { frameMs?: number; holdMs?: number } = {},
): Promise<LipSyncPlan> {
  const given = [source.record, source.characterId, source.visemeCount].filter((value) => value !== undefined).length
  if (given !== 1) throw new Error("give one of a .talk.json record, a character id, or a mouth-position count")
  const line = checkText(text)
  const record = source.record ? (await readTalkRecord(source.record)).record : undefined
  const res = await client.getLipSync({
    text: line,
    characterId: source.characterId,
    mood: source.characterId ? source.mood : undefined,
    visemeCount: record?.visemeCount ?? source.visemeCount,
    frameMs: opts.frameMs,
    holdMs: opts.holdMs,
  })
  // A record's strip is in its own column order, which a plan against the bare preset might not share.
  const column = record ? (id: string, fallback: number) => (record.visemeOrder.includes(id) ? record.visemeOrder.indexOf(id) : fallback) : (_id: string, fallback: number) => fallback
  return {
    version: 1,
    text: res.text,
    totalMs: res.total_ms,
    visemeOrder: record?.visemeOrder ?? res.viseme_order,
    frames: res.frames.map((frame) => ({ viseme: frame.viseme, column: column(frame.viseme, frame.column), durationMs: frame.duration_ms, textOffset: frame.text_offset })),
    mood: record?.mood ?? res.mood ?? null,
    strip: record ? record.strip : res.grid_url ?? null,
    row: record ? Math.max(0, record.moodsOnCharacter?.indexOf(record.mood) ?? 0) : res.row ?? 0,
    cell: record?.cell ?? null,
  }
}
