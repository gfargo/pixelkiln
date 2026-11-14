/** `music` and `sfx`: PixelLab audio as loose files, outside the manifest and lockfile. */
import { readFile } from "node:fs/promises"
import path from "node:path"
import { clientFromEnv } from "../../client.ts"
import { loadEnvFiles } from "../../env.ts"
import { UsageError } from "../../errors.ts"
import {
  generateMusic,
  generateSoundEffect,
  musicCost,
  musicOutputPaths,
  soundEffectCost,
  soundEffectOutputPaths,
} from "../../pixellab-audio.ts"
import { confirm, log } from "../io.ts"
import type { Args } from "../args.ts"

function loadKeys(args: Pick<Args, "manifest">): void {
  loadEnvFiles(path.dirname(path.resolve(args.manifest)))
  loadEnvFiles(process.cwd())
}

function progress(): (status: string) => void {
  let last = ""
  return (status) => {
    if (status !== last) log(`  ${status}…`)
    last = status
  }
}

/** `music style`: expand a short idea into a full style. Prints it; writes nothing. */
async function runMusicStyle(args: Args): Promise<void> {
  if (!args.description) throw new UsageError('music style needs --description "<idea>", e.g. "spooky swamp level"')
  if (args.dryRun) {
    log("  dry run: nothing sent (about 0.05 generations)")
    return
  }
  loadKeys(args)
  const res = await clientFromEnv().improveMusicStyle({ style: args.description, instrumental: !(args.lyrics || args.autoLyrics), bpm: args.bpm })
  log(args.json ? JSON.stringify({ version: 1, ...res }, null, 2) : res.style)
}

/** `music lyrics`: two lyric drafts for a topic. Prints them; writes nothing. */
async function runMusicLyrics(args: Args): Promise<void> {
  if (!args.about) throw new UsageError('music lyrics needs --about "<topic>", e.g. "a knight\'s last stand at the castle gate"')
  if (args.dryRun) {
    log("  dry run: nothing sent (about 0.05 generations)")
    return
  }
  loadKeys(args)
  const res = await clientFromEnv().writeMusicLyrics(args.about)
  if (args.json) {
    log(JSON.stringify({ version: 1, ...res }, null, 2))
    return
  }
  for (const [i, draft] of res.lyrics.entries()) log(`--- version ${i + 1} ---\n${draft}\n`)
}

export async function runMusic(args: Args): Promise<void> {
  if (args.subcommand === "style") return runMusicStyle(args)
  if (args.subcommand === "lyrics") return runMusicLyrics(args)

  if (!args.out) throw new UsageError("music needs --out <base>: <base>.mp3, <base>.take2.mp3 and <base>.music.json are written")
  if (!args.loopOf && !args.description) {
    throw new UsageError('music needs --description "<style>", e.g. "calm chiptune town theme: a soft square-wave melody over a bouncy bass"')
  }
  if (args.loopOf && (args.description || args.lyrics || args.autoLyrics || args.restyle || args.loop)) {
    throw new UsageError("--loop-of loops an existing song as it is; it takes no style, lyrics, --restyle or --loop")
  }
  if (args.lyrics && args.autoLyrics) throw new UsageError("pass --lyrics <file> or --auto-lyrics, not both")
  const vocals = Boolean(args.lyrics || args.autoLyrics)
  if (vocals && args.loop) throw new UsageError("PixelLab loops instrumental songs only; drop --loop or the lyrics")
  if (args.about && !args.autoLyrics) throw new UsageError("--about describes the song for --auto-lyrics")
  if (args.voice && !vocals) throw new UsageError("--voice applies to a song with vocals; add --lyrics <file> or --auto-lyrics")
  if (args.autoLyrics && (args.seconds !== undefined || args.styleWeight !== undefined)) {
    throw new UsageError("PixelLab fits length and style weight itself with --auto-lyrics; drop --seconds and --style-weight")
  }

  const cost = musicCost({ loop: args.loop, loopOf: args.loopOf })
  const paths = musicOutputPaths(args.out)
  const what = args.loopOf
    ? `loop of ${args.loopOf} (two loop takes)`
    : `"${args.description}"${vocals ? ", with vocals" : ", instrumental"}, two takes${args.loop ? " plus loops of take 1" : ""}`
  log(`  music: ${what} → ${path.relative(process.cwd(), args.loopOf ? paths.loops[0] : paths.takes[0])} …`)
  log(`  cost: ${cost} generations (PixelLab's published price)${args.improve ? ", plus about 0.05 for --improve" : ""}`)
  if (args.budget !== undefined && args.budget < cost) {
    throw new Error(`--budget ${args.budget} is below this run's ${cost}-generation cost`)
  }
  if (args.dryRun) {
    log("  dry run: nothing sent")
    return
  }
  if (!(await confirm(`  Spend ${cost} generations on this music?`, args.yes))) return
  loadKeys(args)
  const client = clientFromEnv()
  let style = args.description
  if (args.improve && style) {
    style = (await client.improveMusicStyle({ style, instrumental: !vocals, bpm: args.bpm })).style
    log(`  style: ${style}`)
  }
  const lyrics = args.lyrics ? await readFile(path.resolve(args.lyrics), "utf8") : undefined
  const res = await generateMusic(client, {
    style,
    lyrics,
    autoLyrics: args.autoLyrics,
    about: args.about,
    voice: args.voice,
    lengthS: args.seconds,
    bpm: args.bpm,
    exclude: args.exclude.length ? args.exclude.join(", ") : undefined,
    styleWeight: args.styleWeight,
    name: args.name,
    restyleSongId: args.restyle,
    loop: args.loop,
    loopOf: args.loopOf,
    out: args.out,
    force: args.force,
    onProgress: progress(),
  })
  if (args.json) {
    log(JSON.stringify({ version: 1, ...res }, null, 2))
    return
  }
  for (const take of res.takes) log(`  wrote ${take.file}  (${take.durationMs == null ? "?" : (take.durationMs / 1000).toFixed(1)} s, ${take.songId})`)
  for (const take of res.loops) {
    log(`  wrote ${take.file}  (loop ${take.loopStartS?.toFixed(2) ?? "?"} s to ${take.loopEndS?.toFixed(2) ?? "?"} s, ${take.songId})`)
  }
  log(`  wrote ${res.record}`)
  if (res.loops.length) log("  to loop: play to the loop end, then jump back to the loop start; the intro plays once")
}

export async function runSfx(args: Args): Promise<void> {
  if (!args.description) throw new UsageError('sfx needs --description "<sound>", e.g. "a heavy sword slash hitting metal armor"')
  if (!args.out) throw new UsageError("sfx needs --out <base>: <base>.wav and <base>.sfx.json are written")
  const seconds = args.seconds ?? 2
  const cost = soundEffectCost(seconds)
  const { wav } = soundEffectOutputPaths(args.out)
  log(`  sfx: "${args.description}", ${seconds} s → ${path.relative(process.cwd(), wav)}`)
  log(`  cost: ${cost} generation${cost === 1 ? "" : "s"} (PixelLab's published price, by length)`)
  if (args.budget !== undefined && args.budget < cost) {
    throw new Error(`--budget ${args.budget} is below this clip's ${cost}-generation cost`)
  }
  if (args.dryRun) {
    log("  dry run: nothing sent")
    return
  }
  if (!(await confirm(`  Spend ${cost} generation${cost === 1 ? "" : "s"} on this sound effect?`, args.yes))) return
  loadKeys(args)
  const res = await generateSoundEffect(clientFromEnv(), {
    prompt: args.description,
    seconds,
    name: args.name,
    out: args.out,
    force: args.force,
    onProgress: progress(),
  })
  if (args.json) {
    log(JSON.stringify({ version: 1, ...res }, null, 2))
    return
  }
  log(`  wrote ${res.file}  (${res.durationMs == null ? "?" : (res.durationMs / 1000).toFixed(1)} s, ${res.soundEffectId})`)
  log(`  wrote ${res.record}`)
}
