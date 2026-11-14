/** `talk`: a portrait's mouth positions (paid, once), then free lip-sync as a GIF or a frame plan. */
import { existsSync } from "node:fs"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import path from "node:path"
import { clientFromEnv } from "../../client.ts"
import { loadEnvFiles } from "../../env.ts"
import { UsageError } from "../../errors.ts"
import {
  makeTalkingGif,
  makeVisemes,
  planLipSync,
  readPortrait,
  TALK_MAX_TEXT,
  TALK_MOODS,
  talkOutputPaths,
  visemeCost,
  VISEME_COUNTS,
  VISEME_ENGINES,
  type TalkMood,
  type VisemeEngine,
} from "../../pixellab-talk.ts"
import { confirm, log } from "../io.ts"
import type { Args } from "../args.ts"

function loadKeys(args: Pick<Args, "manifest">): void {
  loadEnvFiles(path.dirname(path.resolve(args.manifest)))
  loadEnvFiles(process.cwd())
}

function moodOf(args: Args): TalkMood | undefined {
  if (args.mood === undefined) return undefined
  if (!(TALK_MOODS as readonly string[]).includes(args.mood)) throw new UsageError(`--mood must be one of ${TALK_MOODS.join(", ")}, got "${args.mood}"`)
  return args.mood as TalkMood
}

function countOf(args: Args): number | undefined {
  if (args.visemes !== undefined && !(VISEME_COUNTS as readonly number[]).includes(args.visemes)) {
    throw new UsageError(`--visemes must be ${VISEME_COUNTS.join(", ")}, got ${args.visemes}`)
  }
  return args.visemes
}

function textOf(args: Args): string {
  const text = args.text?.trim()
  if (!text) throw new UsageError(`talk ${args.subcommand} needs --text "<the line of dialogue>"`)
  if (text.length > TALK_MAX_TEXT) throw new UsageError(`--text is ${text.length} characters; PixelLab lip-syncs at most ${TALK_MAX_TEXT}. Split it into shorter lines`)
  return text
}

/** `--from` is a `.talk.json` record for gif and plan; `--id` is a character. */
function sourceOf(args: Args): { record?: string; characterId?: string } {
  if (args.from && args.id) throw new UsageError("pass --from <record.talk.json> or --id <character id>, not both")
  if (args.from && !existsSync(args.from)) throw new UsageError(`${args.from} does not exist; --from is the .talk.json record talk visemes wrote`)
  return { record: args.from, characterId: args.id }
}

async function runVisemes(args: Args): Promise<void> {
  if (Boolean(args.from) === Boolean(args.id)) {
    throw new UsageError("talk visemes needs --from <portrait.png> (nothing is stored on PixelLab) or --id <character id> (saved onto the character), one of them")
  }
  if (!args.out) throw new UsageError("talk visemes needs --out <base>: it writes <base>.visemes.png and <base>.talk.json")
  if (args.text) throw new UsageError("talk visemes draws the mouth positions; lip-sync a line to them with talk gif --text")
  const engine = (args.engine ?? "v3") as VisemeEngine
  if (!(VISEME_ENGINES as readonly string[]).includes(engine)) throw new UsageError(`--engine must be ${VISEME_ENGINES.join(" or ")}, got "${args.engine}"`)
  const mood = moodOf(args)
  const count = countOf(args) ?? 7
  const paths = talkOutputPaths(args.out)
  let side: number | "unknown" = "unknown"
  if (args.from) {
    if (!existsSync(args.from)) throw new UsageError(`${args.from} does not exist`)
    try {
      side = readPortrait(await readFile(args.from), args.from).side
    } catch (error) {
      throw new UsageError(error instanceof Error ? error.message : String(error))
    }
  }
  const cost = visemeCost(engine, side, count)
  log(
    `  ${count} mouth positions, ${mood ?? "neutral"}, by ${engine}, from ${args.from ?? `character ${args.id}'s stored portrait`}` +
      ` → ${paths.strip} (+ .talk.json)`,
  )
  log(
    `  cost: about ${cost} generations` +
      (count === 7 ? " (PixelLab's published price)" : " (scaled from PixelLab's price for 7 positions; an estimate)") +
      (side === "unknown" && engine === "v3" ? "; priced as a 256px portrait, since the stored one's size is not known here" : ""),
  )
  if (args.id) log("  the set is saved onto the character; every expression on one character must use the same --visemes")
  if (args.budget !== undefined && args.budget < cost) throw new Error(`--budget ${args.budget} is below the ${cost} generations these mouth positions can cost`)
  if (args.dryRun) {
    log("  dry run: nothing sent")
    return
  }
  if (!(await confirm(`  Spend about ${cost} generations on these mouth positions?`, args.yes))) return
  loadKeys(args)
  let last = ""
  const res = await makeVisemes(clientFromEnv(), {
    portrait: args.from,
    characterId: args.id,
    mood,
    visemeCount: count,
    engine,
    seed: args.seed,
    out: args.out,
    force: args.force,
    onProgress: (status) => {
      if (status !== last) log(`  ${status}…`)
      last = status
    },
  })
  if (args.json) {
    log(JSON.stringify(res, null, 2))
    return
  }
  log(`  wrote ${res.paths.strip}  (${res.visemeOrder.length} cells of ${res.cell.width}x${res.cell.height}: ${res.visemeOrder.join(", ")})`)
  log(`  wrote ${res.paths.record}`)
  const usage = res.usage as { generations?: unknown } | null
  if (typeof usage?.generations === "number") log(`  billed ${usage.generations} generations`)
  log(`  now free: pixelkiln talk gif --from ${res.paths.record} --text "<a line>" --out <file>`)
}

async function runGif(args: Args): Promise<void> {
  const text = textOf(args)
  const source = sourceOf(args)
  if (!source.record && !source.characterId) throw new UsageError("talk gif needs --from <record.talk.json> or --id <character id>")
  if (!args.out) throw new UsageError("talk gif needs --out <file.gif>")
  if (args.visemes !== undefined) throw new UsageError("--visemes belongs to talk visemes and talk plan; a GIF uses the positions already made")
  const mood = moodOf(args)
  if (source.record && mood) throw new UsageError("a record holds one expression; --mood picks among a character's stored ones (--id)")
  if (args.dryRun) {
    log(`  would lip-sync ${text.length} characters to a GIF (free); nothing sent`)
    return
  }
  loadKeys(args)
  const res = await makeTalkingGif(clientFromEnv(), text, { ...source, mood }, { out: args.out, frameMs: args.frameMs, holdMs: args.holdMs, force: args.force })
  if (args.json) log(JSON.stringify({ version: 1, ...res }, null, 2))
  else log(`  wrote ${res.out}  (${res.width}x${res.height}, ${res.frames} frames, ${(res.durationMs / 1000).toFixed(2)} s, ${res.frameMs} ms a frame, free)`)
}

async function runPlan(args: Args): Promise<void> {
  const text = textOf(args)
  const source = sourceOf(args)
  const count = countOf(args)
  if ([source.record, source.characterId, count].filter((value) => value !== undefined).length !== 1) {
    throw new UsageError("talk plan needs one of --from <record.talk.json>, --id <character id>, or --visemes <n> for a bare preset")
  }
  const mood = moodOf(args)
  if (mood && !source.characterId) throw new UsageError("--mood picks among a character's stored expressions (--id)")
  if (args.dryRun) {
    log(`  would plan ${text.length} characters of lip-sync (free); nothing sent`)
    return
  }
  loadKeys(args)
  const plan = await planLipSync(clientFromEnv(), text, { ...source, mood, visemeCount: count }, { frameMs: args.frameMs, holdMs: args.holdMs })
  const json = `${JSON.stringify(plan, null, 2)}\n`
  if (!args.out) {
    log(json.trimEnd())
    return
  }
  const out = path.extname(args.out) ? path.resolve(args.out) : path.resolve(`${args.out}.json`)
  if (existsSync(out) && !args.force) throw new Error(`${out} already exists; pass --force to replace it`)
  await mkdir(path.dirname(out), { recursive: true })
  await writeFile(out, json)
  if (args.json) log(json.trimEnd())
  else log(`  wrote ${out}  (${plan.frames.length} frames, ${(plan.totalMs / 1000).toFixed(2)} s, free)`)
}

export async function runTalk(args: Args): Promise<void> {
  if (args.subcommand === "visemes") return runVisemes(args)
  if (args.subcommand === "gif") return runGif(args)
  return runPlan(args)
}
