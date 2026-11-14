/**
 * PixelLab music and sound effects: loose files beside a small provenance
 * record, like `font` and `vfx`. Nothing here touches the manifest or the
 * lockfile, whose outputs are images.
 */
import { existsSync } from "node:fs"
import { mkdir, writeFile } from "node:fs/promises"
import path from "node:path"
import type { PixelLabClient, PixelLabSong } from "./client.ts"
import { sha256 } from "./hash.ts"

/** PixelLab's published price for one `/music` request (two takes), on a subscription. */
export const MUSIC_COST_GENERATIONS = 10
/** PixelLab's published price for one `/music/{id}/loop` request (two loop takes). */
export const MUSIC_LOOP_COST_GENERATIONS = 4
/**
 * A loop needs at least this much music between the song's intro and its
 * ending. Not in PixelLab's docs; the API refused a 30 s song with exactly
 * this figure (November 2026). The song itself must be longer still.
 */
export const MUSIC_LOOP_MIN_BODY_SECONDS = 36
export const MUSIC_MIN_SECONDS = 10
export const MUSIC_MAX_SECONDS = 360
export const MUSIC_MIN_BPM = 60
export const MUSIC_MAX_BPM = 180
export const SFX_MIN_SECONDS = 0.5
export const SFX_MAX_SECONDS = 30

/**
 * PixelLab's published sound-effect price: 0.614 generations per second,
 * rounded up, at least 1. Their own table (1 up to 1.6 s, 2 up to 3.2 s, 4 at
 * 6 s, 7 at 10 s, 19 at 30 s) is this formula.
 */
export function soundEffectCost(seconds: number): number {
  return Math.max(1, Math.ceil(0.614 * seconds - 1e-9))
}

export type AudioFormat = "mp3" | "wav"

/** MP3 (an ID3 tag or a frame sync) or WAV (RIFF/WAVE) by its first bytes, else null. */
export function detectAudioFormat(bytes: Buffer): AudioFormat | null {
  if (bytes.length >= 12 && bytes.subarray(0, 4).toString("ascii") === "RIFF" && bytes.subarray(8, 12).toString("ascii") === "WAVE") {
    return "wav"
  }
  if (bytes.length >= 3 && bytes.subarray(0, 3).toString("ascii") === "ID3") return "mp3"
  if (bytes.length >= 2 && bytes[0] === 0xff && (bytes[1]! & 0xe0) === 0xe0) return "mp3"
  return null
}

/** Refuse an error page or a truncated body before it is written as audio. */
export function validateAudio(bytes: Buffer, expected: AudioFormat): void {
  const actual = detectAudioFormat(bytes)
  if (actual !== expected) {
    throw new Error(`PixelLab returned ${actual ?? `${bytes.length} bytes that are not audio`}, expected ${expected}`)
  }
}

interface WaitOptions {
  /** Poll interval and ceiling. */
  intervalMs?: number
  timeoutMs?: number
  onProgress?: (status: string) => void
  sleep?: (ms: number) => Promise<void>
}

async function waitFor<T extends { status: string; error?: string | null }>(
  what: string,
  read: () => Promise<T>,
  opts: WaitOptions,
  defaults: { intervalMs: number; timeoutMs: number },
): Promise<T> {
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)))
  const interval = opts.intervalMs ?? defaults.intervalMs
  const timeout = opts.timeoutMs ?? defaults.timeoutMs
  const started = Date.now()
  for (;;) {
    const item = await read()
    opts.onProgress?.(item.status)
    if (item.status === "failed") throw new Error(`PixelLab ${what} failed upstream${item.error ? `: ${item.error}` : ""}`)
    if (item.status === "completed") return item
    if (Date.now() - started > timeout) {
      throw new Error(
        `PixelLab ${what} is still ${item.status} after ${Math.round(timeout / 1000)} s; ` +
          "it keeps running upstream and stays in your PixelLab library, but this command has stopped waiting",
      )
    }
    await sleep(interval)
  }
}

/** PixelLab's own explanation from a 4xx body (`{"detail": "..."}`), or null. */
function refusalDetail(error: unknown): string | null {
  const body = (error as { body?: unknown } | null)?.body
  if (typeof body !== "string" || !body) return null
  try {
    const detail = (JSON.parse(body) as { detail?: unknown }).detail
    return typeof detail === "string" ? detail : null
  } catch {
    return null
  }
}

/** The billed amount from a finished background job, or null when it cannot be read. Never fails the command. */
async function billedUsage(client: Pick<PixelLabClient, "getBackgroundJob">, jobId: string): Promise<unknown> {
  try {
    return (await client.getBackgroundJob(jobId)).usage ?? null
  } catch {
    return null
  }
}

export interface MusicTake {
  songId: string
  take: number
  file: string
  sha256: string
  durationMs: number | null
  /** Set on a loop take: play to `loopEndS`, then jump back to `loopStartS`. */
  loopStartS?: number
  loopEndS?: number
}

export interface GenerateMusicOptions extends WaitOptions {
  /** What the music sounds like. Not needed with `loopOf`. */
  style?: string
  /** Vocals are sung only with `lyrics` or `autoLyrics`; otherwise the song is instrumental. */
  lyrics?: string
  autoLyrics?: boolean
  about?: string
  voice?: string
  lengthS?: number
  bpm?: number
  exclude?: string
  styleWeight?: number
  name?: string
  /** Make one of your songs again in `style`. */
  restyleSongId?: string
  /** After the takes are made, also make seamless loops of take 1. Instrumentals only. */
  loop?: boolean
  /** Skip creation and loop this finished instrumental song. */
  loopOf?: string
  /** Output base: `<out>.mp3`, `<out>.take2.mp3`, loops as `<out>.loop.mp3`, and `<out>.music.json`. */
  out: string
  force?: boolean
}

export interface GenerateMusicResult {
  record: string
  takes: MusicTake[]
  loops: MusicTake[]
  style: string
  instrumental: boolean
  lyrics: string
  quotedGenerations: number | null
  usage: unknown[]
}

export interface MusicOutputPaths {
  takes: [string, string]
  loops: [string, string]
  record: string
}

/** Where `music` writes, with a trailing `.mp3` or `.music.json` on `out` treated as the base's own. */
export function musicOutputPaths(out: string): MusicOutputPaths {
  const base = path.resolve(out.replace(/\.(music\.json|mp3)$/i, ""))
  return {
    takes: [`${base}.mp3`, `${base}.take2.mp3`],
    loops: [`${base}.loop.mp3`, `${base}.loop.take2.mp3`],
    record: `${base}.music.json`,
  }
}

/** What one `music` run costs at PixelLab's published prices. */
export function musicCost(opts: Pick<GenerateMusicOptions, "loop" | "loopOf">): number {
  if (opts.loopOf) return MUSIC_LOOP_COST_GENERATIONS
  return MUSIC_COST_GENERATIONS + (opts.loop ? MUSIC_LOOP_COST_GENERATIONS : 0)
}

type MusicClient = Pick<PixelLabClient, "createMusic" | "getMusic" | "loopMusic" | "download" | "getBackgroundJob">

async function collectTakes(
  client: MusicClient,
  songs: PixelLabSong[],
  files: readonly string[],
  what: string,
  opts: GenerateMusicOptions,
): Promise<{ takes: MusicTake[]; finished: PixelLabSong[] }> {
  const takes: MusicTake[] = []
  const finished: PixelLabSong[] = []
  const ordered = [...songs].sort((a, b) => a.take - b.take)
  for (const [index, pending] of ordered.entries()) {
    const file = files[index]
    if (!file) break
    const song = await waitFor(`${what} ${pending.id}`, () => client.getMusic(pending.id), opts, { intervalMs: 10_000, timeoutMs: 6 * 60_000 })
    if (!song.audio_url) throw new Error(`PixelLab ${what} ${song.id} completed without an audio URL`)
    const bytes = await client.download(song.audio_url)
    validateAudio(bytes, "mp3")
    await mkdir(path.dirname(file), { recursive: true })
    await writeFile(file, bytes)
    finished.push(song)
    takes.push({
      songId: song.id,
      take: song.take,
      file,
      sha256: sha256(bytes),
      durationMs: song.duration_ms ?? null,
      ...(song.loop_start_s != null ? { loopStartS: song.loop_start_s } : {}),
      ...(song.loop_end_s != null ? { loopEndS: song.loop_end_s } : {}),
    })
  }
  return { takes, finished }
}

/**
 * Make a song (two takes), optionally loop it, download every take, and write
 * a record beside them. With `loopOf`, only the loop of an existing song is
 * made. Each MP3 URL is no-auth, like every other PixelLab storage URL.
 */
export async function generateMusic(client: MusicClient, opts: GenerateMusicOptions): Promise<GenerateMusicResult> {
  const paths = musicOutputPaths(opts.out)
  const instrumental = !(opts.lyrics || opts.autoLyrics)
  const wantsLoop = Boolean(opts.loop || opts.loopOf)
  if (!opts.loopOf && !opts.style) throw new Error("music needs a style description")
  if (wantsLoop && !opts.loopOf && !instrumental) throw new Error("PixelLab loops instrumental songs only; drop the lyrics or the loop")
  if (opts.loop && opts.lengthS != null && opts.lengthS <= MUSIC_LOOP_MIN_BODY_SECONDS) {
    throw new Error(
      `a loop needs at least ${MUSIC_LOOP_MIN_BODY_SECONDS} s of music between the intro and the ending, so a ${opts.lengthS} s song cannot be looped; ` +
        "ask for a longer song (60 s or more is safe) or leave the length to PixelLab",
    )
  }
  const writes = [paths.record, ...(opts.loopOf ? [] : paths.takes), ...(wantsLoop ? paths.loops : [])]
  if (!opts.force) {
    for (const file of writes) if (existsSync(file)) throw new Error(`${file} already exists; pass --force to replace it`)
  }

  const usage: unknown[] = []
  let quoted: number | null = null
  let takes: MusicTake[] = []
  let source: PixelLabSong | undefined
  if (!opts.loopOf) {
    const submitted = await client.createMusic({
      style: opts.style!,
      instrumental,
      lyrics: opts.lyrics,
      autoLyrics: opts.autoLyrics,
      about: opts.about,
      lengthS: opts.lengthS,
      bpm: opts.bpm,
      voice: opts.voice,
      exclude: opts.exclude,
      styleWeight: opts.styleWeight,
      name: opts.name,
      restyleSongId: opts.restyleSongId,
    })
    quoted = submitted.quoted_generations ?? null
    const made = await collectTakes(client, submitted.songs, paths.takes, "song", opts)
    takes = made.takes
    source = made.finished[0]
    usage.push(await billedUsage(client, submitted.background_job_id))
  }

  let loops: MusicTake[] = []
  const snapshot = (): GenerateMusicResult => ({
    record: paths.record,
    takes,
    loops,
    style: source?.style ?? opts.style ?? "",
    instrumental: source?.instrumental ?? instrumental,
    lyrics: source?.lyrics ?? opts.lyrics ?? "",
    quotedGenerations: quoted,
    usage,
  })
  const relative = (take: MusicTake) => ({ ...take, file: path.basename(take.file) })
  const writeRecord = async (result: GenerateMusicResult) => {
    await mkdir(path.dirname(paths.record), { recursive: true })
    await writeFile(
      paths.record,
      JSON.stringify(
        {
          schema: "pixelkiln-music",
          version: 1,
          provider: "pixellab",
          createdAt: new Date().toISOString(),
          request: {
            ...(opts.style ? { style: opts.style } : {}),
            ...(opts.bpm != null ? { bpm: opts.bpm } : {}),
            ...(opts.lengthS != null ? { lengthS: opts.lengthS } : {}),
            ...(opts.exclude ? { exclude: opts.exclude } : {}),
            ...(opts.styleWeight != null ? { styleWeight: opts.styleWeight } : {}),
            ...(opts.voice ? { voice: opts.voice } : {}),
            ...(opts.autoLyrics ? { autoLyrics: true, ...(opts.about ? { about: opts.about } : {}) } : {}),
            ...(opts.restyleSongId ? { restyleSongId: opts.restyleSongId } : {}),
            ...(opts.loopOf ? { loopOf: opts.loopOf } : {}),
          },
          style: result.style,
          instrumental: result.instrumental,
          ...(result.lyrics ? { lyrics: result.lyrics } : {}),
          takes: result.takes.map(relative),
          loops: result.loops.map(relative),
          quotedGenerations: result.quotedGenerations,
          usage: result.usage,
        },
        null,
        2,
      ) + "\n",
    )
  }
  // The takes are paid for the moment they exist, so their record is written
  // before the loop is asked for: a refused or failed loop must not lose it.
  if (takes.length) await writeRecord(snapshot())

  if (wantsLoop) {
    const loopSource = opts.loopOf ?? source!.id
    let submitted: Awaited<ReturnType<MusicClient["loopMusic"]>>
    try {
      submitted = await client.loopMusic(loopSource)
    } catch (error) {
      const detail = refusalDetail(error)
      const kept = takes.length ? ` The song's takes are saved (${path.basename(paths.record)}); nothing was charged for the loop.` : ""
      throw new Error(`PixelLab refused to loop ${loopSource}: ${detail ?? (error instanceof Error ? error.message : String(error))}${kept}`, { cause: error })
    }
    quoted = (quoted ?? 0) + (submitted.quoted_generations ?? 0)
    const made = await collectTakes(client, submitted.songs, paths.loops, "loop", opts)
    loops = made.takes
    source ??= made.finished[0]
    usage.push(await billedUsage(client, submitted.background_job_id))
  }

  const result = snapshot()
  await writeRecord(result)
  return result
}

export interface GenerateSoundEffectOptions extends WaitOptions {
  prompt: string
  seconds?: number
  name?: string
  /** Output base: `<out>.wav` and `<out>.sfx.json`. */
  out: string
  force?: boolean
}

export interface GenerateSoundEffectResult {
  soundEffectId: string
  file: string
  record: string
  sha256: string
  durationMs: number | null
  seconds: number
  quotedGenerations: number | null
  usage: unknown
}

/** Where `sfx` writes, with a trailing `.wav` or `.sfx.json` on `out` treated as the base's own. */
export function soundEffectOutputPaths(out: string): { wav: string; record: string } {
  const base = path.resolve(out.replace(/\.(sfx\.json|wav)$/i, ""))
  return { wav: `${base}.wav`, record: `${base}.sfx.json` }
}

/** Make one sound effect, download the WAV, and write a record beside it. */
export async function generateSoundEffect(
  client: Pick<PixelLabClient, "createSoundEffect" | "getSoundEffect" | "download" | "getBackgroundJob">,
  opts: GenerateSoundEffectOptions,
): Promise<GenerateSoundEffectResult> {
  const { wav, record } = soundEffectOutputPaths(opts.out)
  if (!opts.force) {
    for (const file of [wav, record]) if (existsSync(file)) throw new Error(`${file} already exists; pass --force to replace it`)
  }
  const seconds = opts.seconds ?? 2
  const submitted = await client.createSoundEffect({ prompt: opts.prompt, seconds, name: opts.name })
  const id = submitted.sound_effect.id
  const clip = await waitFor(`sound effect ${id}`, () => client.getSoundEffect(id), opts, { intervalMs: 4000, timeoutMs: 4 * 60_000 })
  if (!clip.audio_url) throw new Error(`PixelLab sound effect ${id} completed without an audio URL`)
  const bytes = await client.download(clip.audio_url)
  validateAudio(bytes, "wav")
  await mkdir(path.dirname(wav), { recursive: true })
  await writeFile(wav, bytes)
  const result: GenerateSoundEffectResult = {
    soundEffectId: id,
    file: wav,
    record,
    sha256: sha256(bytes),
    durationMs: clip.duration_ms ?? null,
    seconds,
    quotedGenerations: submitted.quoted_generations ?? null,
    usage: await billedUsage(client, submitted.background_job_id),
  }
  await writeFile(
    record,
    JSON.stringify(
      {
        schema: "pixelkiln-sfx",
        version: 1,
        provider: "pixellab",
        createdAt: new Date().toISOString(),
        prompt: opts.prompt,
        seconds,
        soundEffectId: id,
        file: path.basename(wav),
        sha256: result.sha256,
        durationMs: result.durationMs,
        quotedGenerations: result.quotedGenerations,
        usage: result.usage,
      },
      null,
      2,
    ) + "\n",
  )
  return result
}
