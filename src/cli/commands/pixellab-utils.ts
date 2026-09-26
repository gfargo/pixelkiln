/** `unzoom` and `font`: PixelLab utilities on loose files, outside the manifest and lockfile. */
import path from "node:path"
import { clientFromEnv } from "../../client.ts"
import { loadEnvFiles } from "../../env.ts"
import { UsageError } from "../../errors.ts"
import {
  defaultUnzoomOut,
  FONT_COST_GENERATIONS,
  FONT_GLYPH_SIZES,
  FONT_WEIGHTS,
  fontOutputPaths,
  generateFont,
  unzoomFile,
  type FontGlyphSize,
  type FontWeight,
} from "../../pixellab-utils.ts"
import { confirm, log } from "../io.ts"
import type { Args } from "../args.ts"

/** The key can live in a .env beside the manifest, as for every other command, or in the working directory. */
function loadKeys(args: Pick<Args, "manifest">): void {
  loadEnvFiles(path.dirname(path.resolve(args.manifest)))
  loadEnvFiles(process.cwd())
}

export async function runUnzoom(args: Args): Promise<void> {
  if (!args.from) throw new UsageError("unzoom needs --from <image>: the upscaled PNG or JPEG to shrink back to its native grid")
  const out = args.out ?? defaultUnzoomOut(args.from)
  if (args.dryRun) {
    log(`  would unzoom ${args.from} → ${out}${args.quantize === undefined ? "" : ` (quantize ${args.quantize})`}; nothing sent`)
    return
  }
  loadKeys(args)
  const res = await unzoomFile(clientFromEnv(), args.from, { out, quantize: args.quantize, force: args.force })
  if (args.json) {
    log(JSON.stringify({ version: 1, ...res }, null, 2))
    return
  }
  log(
    `  ${res.original.width}x${res.original.height} → ${res.unzoomed.width}x${res.unzoomed.height} ` +
      `(each art pixel was ${res.zoomFactor}x${res.zoomFactor}); wrote ${res.out}`,
  )
  log("  the result is opaque: PixelLab composites transparency onto white first")
}

export async function runFont(args: Args): Promise<void> {
  if (!args.description) throw new UsageError('font needs --description "<style>", e.g. "warm orange arcade font"')
  if (!args.out) throw new UsageError("font needs --out <base>: <base>.ttf and <base>.png are written")
  const weight = (args.weight ?? "Regular") as FontWeight
  if (!(FONT_WEIGHTS as readonly string[]).includes(weight)) {
    throw new UsageError(`--weight must be ${FONT_WEIGHTS.join(" or ")}, got "${args.weight}"`)
  }
  const glyphPx = (args.glyphPx ?? 16) as FontGlyphSize
  if (!(FONT_GLYPH_SIZES as readonly number[]).includes(glyphPx)) {
    throw new UsageError(`--glyph-px must be ${FONT_GLYPH_SIZES.join(", ")}, got "${args.glyphPx}"`)
  }
  const { ttf, atlas } = fontOutputPaths(args.out)
  log(`  font: "${args.description}", ${weight}, ${glyphPx}px glyphs → ${ttf} + ${atlas}`)
  log(`  cost: ${FONT_COST_GENERATIONS} generations (PixelLab's documented price)`)
  if (args.budget !== undefined && args.budget < FONT_COST_GENERATIONS) {
    throw new Error(`--budget ${args.budget} is below this font's ${FONT_COST_GENERATIONS}-generation cost`)
  }
  if (args.dryRun) {
    log("  dry run: nothing sent")
    return
  }
  if (!(await confirm(`  Spend ${FONT_COST_GENERATIONS} generations on this font?`, args.yes))) return
  loadKeys(args)
  let last = ""
  const res = await generateFont(clientFromEnv(), {
    description: args.description,
    weight,
    glyphPx,
    fontName: args.name,
    out: args.out,
    force: args.force,
    onProgress: (status) => {
      if (status !== last) log(`  ${status}…`)
      last = status
    },
  })
  if (args.json) {
    log(JSON.stringify({ version: 1, ...res }, null, 2))
    return
  }
  log(`  wrote ${res.ttf}`)
  log(`  wrote ${res.atlas}`)
}
