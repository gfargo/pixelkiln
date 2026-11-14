/** `asset`: upkeep for a PixelLab character or object by id: canvas, mirror, import, expand, export. */
import path from "node:path"
import { clientFromEnv, type PixelLabAssetKind, type PixelLabExportFormat } from "../../client.ts"
import { loadEnvFiles } from "../../env.ts"
import { UsageError } from "../../errors.ts"
import {
  ASSET_KINDS,
  EXPAND_DIRECTIONS,
  EXPAND_MAX_COST,
  EXPAND_MIN_COST,
  EXPORT_FORMATS,
  expandObject,
  exportAssetFile,
  exportOutPath,
  importObjectFile,
  MIRROR_DIRECTIONS,
  parseCanvasSize,
  pullExpansionReview,
} from "../../pixellab-assets.ts"
import { confirm, log } from "../io.ts"
import type { Args } from "../args.ts"

function loadKeys(args: Pick<Args, "manifest">): void {
  loadEnvFiles(path.dirname(path.resolve(args.manifest)))
  loadEnvFiles(process.cwd())
}

function kindOf(args: Args): PixelLabAssetKind {
  const kind = args.kind ?? "object"
  if (!(ASSET_KINDS as readonly string[]).includes(kind)) throw new UsageError(`--kind must be ${ASSET_KINDS.join(" or ")}, got "${args.kind}"`)
  return kind as PixelLabAssetKind
}

function requireId(args: Args): string {
  if (!args.id) throw new UsageError(`asset ${args.subcommand} needs --id <PixelLab object or character id> (a lock entry's objectId)`)
  return args.id
}

export async function runAsset(args: Args): Promise<void> {
  const emit = (value: Record<string, unknown>) => log(JSON.stringify({ version: 1, ...value }, null, 2))

  if (args.subcommand === "import") {
    if (!args.from) throw new UsageError("asset import needs --from <png>: your own sprite, at most 256x256")
    if (args.dryRun) {
      log(`  would import ${args.from} as a 1-direction object; nothing sent`)
      return
    }
    loadKeys(args)
    const res = await importObjectFile(clientFromEnv(), args.from, { name: args.name })
    if (args.json) emit(res)
    else log(`  imported ${args.from} as object ${res.objectId} (${res.size.width}x${res.size.height}, free)`)
    return
  }

  const id = requireId(args)
  const kind = kindOf(args)

  if (args.subcommand === "canvas") {
    if (!args.size) throw new UsageError("asset canvas needs --size <width>x<height>, e.g. --size 64x64")
    const size = parseCanvasSize(args.size, kind)
    if (args.dryRun) {
      log(`  would set ${kind} ${id}'s canvas to ${size.width}x${size.height}; nothing sent`)
      return
    }
    loadKeys(args)
    const res = await clientFromEnv().setCanvasSize(kind, id, size)
    if (args.json) emit(res)
    else {
      log(`  ${kind} ${id}: canvas ${res.previous.width}x${res.previous.height} → ${res.canvas.width}x${res.canvas.height}, ` +
        `${res.rotations_moved} rotation(s) re-centred (free)${res.placements_moved ? `, ${res.placements_moved} map placement(s) moved` : ""}`)
      log("  the art is not scaled or cropped; existing animations keep the canvas they were made on")
    }
    return
  }

  if (args.subcommand === "mirror") {
    if (!args.animation) throw new UsageError("asset mirror needs --animation <animation group id>")
    if (!args.direction || !(MIRROR_DIRECTIONS as readonly string[]).includes(args.direction)) {
      throw new UsageError(`asset mirror needs --direction, one of ${MIRROR_DIRECTIONS.join(", ")} (south and north have no mirror)`)
    }
    if (args.dryRun) {
      log(`  would flip ${kind} ${id}'s ${args.direction} frames of ${args.animation} into the opposite direction; nothing sent`)
      return
    }
    loadKeys(args)
    const res = await clientFromEnv().mirrorAnimation(kind, id, args.animation, args.direction)
    if (args.json) emit(res)
    else log(`  ${kind} ${id}: ${res.source_direction} flipped into ${res.target_direction}, ${res.frames_created} frame(s) (free)`)
    return
  }

  if (args.subcommand === "expand") {
    if (kind !== "object") throw new UsageError("asset expand works on objects; a character is created with its directions")
    if (args.keep && args.discard) throw new UsageError("pass --keep or --discard, not both")
    if (args.keep || args.discard) {
      if (args.dryRun) {
        log(`  would ${args.keep ? "keep" : "discard"} object ${id}'s reviewed directions; nothing sent`)
        return
      }
      loadKeys(args)
      const client = clientFromEnv()
      if (args.keep) await client.acceptObjectExpansion(id)
      else await client.dismissObjectReview(id)
      log(args.keep ? `  object ${id} is now 8-direction` : `  object ${id}'s new directions were discarded; it is unchanged`)
      return
    }
    if (!args.direction || !(EXPAND_DIRECTIONS as readonly string[]).includes(args.direction)) {
      throw new UsageError(`asset expand needs --direction: the way the object's image faces now, one of ${EXPAND_DIRECTIONS.join(", ")}`)
    }
    log(`  expand object ${id} to 8 directions; its image is kept as ${args.direction}`)
    log(`  cost: ${EXPAND_MIN_COST} to ${EXPAND_MAX_COST} generations, by the padded canvas (PixelLab's published range)`)
    if (args.budget !== undefined && args.budget < EXPAND_MAX_COST) {
      throw new Error(`--budget ${args.budget} is below the ${EXPAND_MAX_COST} generations this expansion can cost`)
    }
    if (args.dryRun) {
      log("  dry run: nothing sent")
      return
    }
    if (!(await confirm(`  Spend up to ${EXPAND_MAX_COST} generations on this expansion?`, args.yes))) return
    loadKeys(args)
    let last = ""
    const res = await expandObject(clientFromEnv(), id, {
      existingDirection: args.direction,
      description: args.description,
      onQuote: (min, max) => log(`  quoted ${min === max ? min : `${min} to ${max}`} generations`),
      onProgress: (status) => {
        if (status !== last) log(`  ${status}…`)
        last = status
      },
    })
    if (args.json) emit({ ...res })
    else if (res.status === "review-expansion") {
      log(`  the 7 new directions are ready for review on PixelLab; the object is still 1-direction`)
      log(`  look first: pixelkiln asset review --id ${id} --out <dir>`)
      log(`  keep them: pixelkiln asset expand --id ${id} --keep     discard: pixelkiln asset expand --id ${id} --discard`)
    } else log(`  object ${id} is ${res.status}`)
    return
  }

  if (args.subcommand === "review") {
    if (!args.out) throw new UsageError("asset review needs --out <dir>: one PNG per direction is written there")
    loadKeys(args)
    const res = await pullExpansionReview(clientFromEnv(), id, { out: args.out, force: args.force })
    if (args.json) emit(res)
    else {
      for (const file of res.files) log(`  wrote ${path.join(args.out, `${file.direction}.png`)}${file.direction === res.existingDirection ? "  (your image, unchanged)" : ""}`)
      log(`  keep them: pixelkiln asset expand --id ${id} --keep     discard: pixelkiln asset expand --id ${id} --discard`)
    }
    return
  }

  // export
  const format = (args.format ?? "zip") as PixelLabExportFormat
  if (!(EXPORT_FORMATS as readonly string[]).includes(format)) throw new UsageError(`--format must be one of ${EXPORT_FORMATS.join(", ")}`)
  if (!args.out) throw new UsageError("asset export needs --out <file>")
  if ((args.animation || args.direction) && format !== "gif") throw new UsageError("--animation and --direction choose a loop for --format gif")
  if (args.dryRun) {
    log(`  would export ${kind} ${id} as ${format} → ${exportOutPath(args.out, format)}; nothing sent`)
    return
  }
  loadKeys(args)
  const res = await exportAssetFile(clientFromEnv(), kind, id, format, {
    out: args.out,
    animationGroupId: args.animation,
    direction: args.direction,
    force: args.force,
  })
  if (args.json) emit({ ...res, format })
  else log(`  wrote ${res.out}  (${format}, ${res.bytes} bytes, free)`)
}
