/** `unzoom`, `pixelate`, `normal-map`, `vfx`, and `font`: PixelLab utilities on loose files, outside the manifest and lockfile. */
import path from "node:path"
import { clientFromEnv, type NormalMapConvention } from "../../client.ts"
import { loadEnvFiles } from "../../env.ts"
import { UsageError } from "../../errors.ts"
import { mcpClientFromEnv } from "../../pixellab-mcp.ts"
import { describeVfx, makeVfx, readVfxRecipe, vfxOutputPaths } from "../../pixellab-vfx.ts"
import {
  defaultNormalMapOut,
  defaultPixelateOut,
  defaultUnzoomOut,
  FONT_COST_GENERATIONS,
  FONT_GLYPH_SIZES,
  FONT_WEIGHTS,
  fontOutputPaths,
  generateFont,
  NORMAL_MAP_CONVENTIONS,
  NORMAL_MAP_COST_GENERATIONS,
  normalMapFile,
  PIXELATE_COST_GENERATIONS,
  PIXELATE_MAX_SIDE,
  pixelateFile,
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

export async function runPixelate(args: Args): Promise<void> {
  if (!args.from) throw new UsageError("pixelate needs --from <image>: the photo, painting, or render to convert")
  const out = args.out ?? defaultPixelateOut(args.from)
  log(`  pixelate ${args.from} → ${out}${args.description ? ` ("${args.description}")` : ""}; PixelLab picks the output size`)
  log(`  cost: ${PIXELATE_COST_GENERATIONS} generations (Image to Pixel Art Pro Flash, flat)`)
  if (args.budget !== undefined && args.budget < PIXELATE_COST_GENERATIONS) {
    throw new Error(`--budget ${args.budget} is below this conversion's ${PIXELATE_COST_GENERATIONS}-generation cost`)
  }
  if (args.dryRun) {
    log("  dry run: nothing sent")
    return
  }
  if (!(await confirm(`  Spend ${PIXELATE_COST_GENERATIONS} generations on this conversion?`, args.yes))) return
  loadKeys(args)
  let last = ""
  const res = await pixelateFile(clientFromEnv(), args.from, {
    out,
    description: args.description,
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
  const scaled = Math.max(res.original.width, res.original.height) > PIXELATE_MAX_SIDE ? " (scaled down upstream first)" : ""
  log(
    `  ${res.original.width}x${res.original.height}${scaled} → ${res.pixelated.width}x${res.pixelated.height}; wrote ${res.out}`,
  )
}

export async function runNormalMap(args: Args): Promise<void> {
  if (!args.from) throw new UsageError("normal-map needs --from <png>: the sprite, or a horizontal strip of --frames equal frames")
  const convention = (args.convention ?? "opengl") as NormalMapConvention
  if (!(NORMAL_MAP_CONVENTIONS as readonly string[]).includes(convention)) {
    throw new UsageError(`--convention must be ${NORMAL_MAP_CONVENTIONS.join(" or ")}, got "${args.convention}"`)
  }
  const frames = args.frames ?? 1
  const out = args.out ?? defaultNormalMapOut(args.from)
  log(
    `  normal-map ${args.from}${frames > 1 ? ` (a strip of ${frames} frames)` : ""} → ${out}, ` +
      `${convention} (green ${convention === "opengl" ? "up" : "down"})`,
  )
  log(`  cost: ${NORMAL_MAP_COST_GENERATIONS} generation (PixelLab's documented price, charged on delivery)`)
  if (args.budget !== undefined && args.budget < NORMAL_MAP_COST_GENERATIONS) {
    throw new Error(`--budget ${args.budget} is below this normal map's ${NORMAL_MAP_COST_GENERATIONS}-generation cost`)
  }
  if (args.dryRun) {
    log("  dry run: nothing sent")
    return
  }
  if (!(await confirm(`  Spend ${NORMAL_MAP_COST_GENERATIONS} generation on this normal map?`, args.yes))) return
  loadKeys(args)
  let last = ""
  const res = await normalMapFile(clientFromEnv(), args.from, {
    out,
    frames,
    convention: args.convention ? convention : undefined,
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
  log(`  ${res.width}x${res.height}${res.frames > 1 ? `, ${res.frames} frames` : ""}; wrote ${res.out}`)
}

export async function runVfx(args: Args): Promise<void> {
  if (args.subcommand === "presets" || args.subcommand === "parts") {
    if (args.dryRun) {
      log(`  would list PixelLab's VFX ${args.subcommand}; nothing sent`)
      return
    }
    loadKeys(args)
    log(await describeVfx(mcpClientFromEnv(), args.subcommand))
    return
  }
  if (!args.out) throw new UsageError("vfx needs --out <base>: <base>.png, .gif, .json, and .vfx.json are written")
  const starts = [args.preset, args.recipe, args.effect].filter(Boolean)
  if (starts.length > 1) throw new UsageError("vfx takes one of --preset, --recipe, or --effect, not several")
  if (starts.length === 0 && args.parts.length === 0) {
    throw new UsageError("vfx needs something to start from: --preset <name>, --recipe <file>, --effect <id>, or --part <name>")
  }
  const paths = vfxOutputPaths(args.out)
  const fromRecipe = args.recipe ? await readVfxRecipe(args.recipe) : undefined
  const sprite = args.sprite ?? fromRecipe?.sprite
  const recipeName = typeof fromRecipe?.recipe.name === "string" ? fromRecipe.recipe.name : undefined
  const name = args.name ?? (args.effect ? undefined : recipeName ?? args.preset ?? path.basename(paths.sheet, ".png"))
  const from = args.preset ? `preset ${args.preset}` : args.recipe ? `recipe ${args.recipe}` : args.effect ? `saved effect ${args.effect}` : "nothing"
  log(
    `  vfx ${name ? `"${name}"` : "(keeping its saved name)"} from ${from}` +
      `${args.parts.length ? ` + ${args.parts.join(", ")}` : ""}${sprite ? ` around ${sprite}` : ""}` +
      ` → ${paths.sheet} (+ .gif, .json, .vfx.json${args.gamePack ? ", -game.zip" : ""})`,
  )
  log("  cost: free on a PixelLab subscription (a renderer, not a generation); saved to your My effects")
  if (args.dryRun) {
    log("  dry run: nothing sent")
    return
  }
  if (fromRecipe?.sprite && !args.sprite) log(`  using the sprite the record names: ${fromRecipe.sprite}`)
  loadKeys(args)
  const res = await makeVfx(mcpClientFromEnv(), {
    preset: args.preset,
    recipe: fromRecipe?.recipe,
    effect: args.effect,
    parts: args.parts.map((part) => ({ name: part })),
    sprite,
    fps: args.fps,
    name: args.name,
    out: args.out,
    gamePack: args.gamePack,
    force: args.force,
    onProgress: (message) => log(`  ${message}…`),
  })
  if (args.json) {
    log(JSON.stringify({ version: 1, ...res }, null, 2))
    return
  }
  log(`  ${res.width}x${res.height}, ${res.frames} frames @ ${res.fps} fps, ${res.loop ? "loops" : "plays once"}`)
  for (const file of [res.paths.sheet, res.paths.gif, res.paths.atlas, res.paths.gamePack, res.paths.provenance]) {
    if (file) log(`  wrote ${file}`)
  }
  if (res.editUrl) log(`  tweak it with sliders: ${res.editUrl} (then: pixelkiln vfx --effect ${res.effectId} --out ${args.out} --force)`)
}
