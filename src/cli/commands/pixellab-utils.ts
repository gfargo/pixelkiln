/** `unzoom`, `pixelate`, `normal-map`, `vfx`, and `font`: PixelLab utilities on loose files, outside the manifest and lockfile. */
import { readFile } from "node:fs/promises"
import path from "node:path"
import { clientFromEnv, NORMAL_MAP_KINDS, NORMAL_MAP_MODES, type NormalMapConvention, type NormalMapKind, type NormalMapMode } from "../../client.ts"
import { loadEnvFiles } from "../../env.ts"
import { UsageError } from "../../errors.ts"
import { mcpClientFromEnv } from "../../pixellab-mcp.ts"
import {
  checkCodexRecipe,
  CODEX_CAMERAS,
    formatCodexEffects,
  listCodexEffects,
  loadCodex,
  makeCodexVfx,
  planCodex,
  readCodexRecipe,
  type CodexRecipe,
} from "../../codex-vfx.ts"
import {
  checkPixelfxRecipe,
  formatPixelfxEffects,
  listPixelfxEffects,
  loadPixelfx,
  makePixelfxVfx,
  readPixelfxRecipe,
  type PixelfxRecipe,
} from "../../pixelfx-vfx.ts"
import {
  describeVfx,
  isVfxReference,
  makeVfx,
  makeVfxWithArtist,
  readVfxConversation,
  readVfxRecipe,
  VFX_ARTISTS,
  vfxArtistCeiling,
  vfxArtistQuote,
  vfxArtistSprite,
  vfxOutputPaths,
  type VfxArtist,
} from "../../pixellab-vfx.ts"
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
  normalMapCost,
  normalMapFile,
  PIXELATE_COST_GENERATIONS,
  PIXELATE_MAX_SIDE,
  PIXELATE_PRO_COST_GENERATIONS,
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
  const cost = args.pro ? PIXELATE_PRO_COST_GENERATIONS : PIXELATE_COST_GENERATIONS
  if (!args.pro && (args.palette.length || args.maxColors !== undefined)) {
    throw new UsageError("--palette and --max-colors need the Pro converter; add --pro")
  }
  log(`  cost: ${cost} generations (Image to Pixel Art ${args.pro ? "Pro" : "Pro Flash"}, flat)`)
  if (args.budget !== undefined && args.budget < cost) {
    throw new Error(`--budget ${args.budget} is below this conversion's ${cost}-generation cost`)
  }
  if (args.dryRun) {
    log("  dry run: nothing sent")
    return
  }
  if (!(await confirm(`  Spend ${cost} generations on this conversion?`, args.yes))) return
  loadKeys(args)
  let last = ""
  const res = await pixelateFile(clientFromEnv(), args.from, {
    out,
    description: args.description,
    pro: args.pro,
    palette: args.palette,
    maxColors: args.maxColors,
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
  if (res.quantized) {
    log(`  wrote ${res.quantized.out}: the same image on ${res.quantized.colors ?? "fewer"} colors${res.colors ? ` (the main result has ${res.colors})` : ""}`)
  }
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
  if (args.mode !== undefined && !(NORMAL_MAP_MODES as readonly string[]).includes(args.mode)) {
    throw new UsageError(`--mode must be ${NORMAL_MAP_MODES.join(" or ")}, got "${args.mode}"`)
  }
  if (args.kind !== undefined && !(NORMAL_MAP_KINDS as readonly string[]).includes(args.kind)) {
    throw new UsageError(`--kind must be one of ${NORMAL_MAP_KINDS.join(", ")}, got "${args.kind}"`)
  }
  const mode = args.mode as NormalMapMode | undefined
  const cost = normalMapCost(mode)
  log(`  cost: ${cost} generation (${mode === "pro" ? "pro" : "lite, PixelLab's default; --mode pro is 0.5"}, charged on delivery)`)
  if (args.budget !== undefined && args.budget < cost) {
    throw new Error(`--budget ${args.budget} is below this normal map's ${cost}-generation cost`)
  }
  if (args.dryRun) {
    log("  dry run: nothing sent")
    return
  }
  if (!(await confirm(`  Spend ${cost} generation on this normal map?`, args.yes))) return
  loadKeys(args)
  let last = ""
  const res = await normalMapFile(clientFromEnv(), args.from, {
    out,
    frames,
    convention: args.convention ? convention : undefined,
    mode,
    kind: args.kind as NormalMapKind | undefined,
    shape: {
      strength: args.strength,
      outlineRounding: args.outlineRounding,
      partShapes: args.partShapes,
      surfaceDetail: args.surfaceDetail,
      detailSoftness: args.detailSoftness,
    },
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

const VFX_LIBS = ["pixellab", "pixelfx", "codex"] as const

/** A recipe file for one of the local sources: a record says which by itself; a bare recipe is pixelfx's unless `--lib codex`. */
async function readLocalRecipe(
  file: string,
  lib: string | undefined,
): Promise<{ lib: "pixelfx"; read: NonNullable<Awaited<ReturnType<typeof readPixelfxRecipe>>> } | { lib: "codex"; read: NonNullable<Awaited<ReturnType<typeof readCodexRecipe>>> } | null> {
  const codex = await readCodexRecipe(file, { bare: lib === "codex" })
  if (codex) {
    if (lib === "pixelfx") throw new UsageError(`${file} is a record from pixel-vfx-codex; drop --lib pixelfx, or use --lib codex`)
    return { lib: "codex", read: codex }
  }
  if (lib === "codex") return null
  const pixelfx = await readPixelfxRecipe(file)
  if (pixelfx) return { lib: "pixelfx", read: pixelfx }
  return null
}

/** Flags that only the pixelfx source takes. */
function pixelfxOnly(args: Args) {
  return [["--seed", args.seed], ["--palette", args.palette.length ? args.palette : undefined]] as const
}

/** `name=value` flags as numbers, for `--param` and `--tune`. */
function numberPairs(flag: string, pairs: string[]): Record<string, number> {
  const out: Record<string, number> = {}
  for (const pair of pairs) {
    const [key, raw, ...rest] = pair.split("=")
    const value = Number(raw)
    if (!key || raw === undefined || rest.length || raw.trim() === "" || !Number.isFinite(value)) {
      throw new UsageError(`${flag} takes name=number, got "${pair}"`)
    }
    out[key] = value
  }
  return out
}

export async function runVfx(args: Args): Promise<void> {
  if (args.lib !== undefined && !(VFX_LIBS as readonly string[]).includes(args.lib)) {
    throw new UsageError(`--lib must be ${VFX_LIBS.join(", ")}, got "${args.lib}"`)
  }
  const pixelfxOnly_ = pixelfxOnly(args)
  const codexOnly = [
    ["--camera", args.camera],
    ["--hue", args.hue],
    ["--param", args.param.length ? args.param : undefined],
    ["--tune", args.tune.length ? args.tune : undefined],
  ] as const
  const listsLocal = args.subcommand === "effects" || ((args.lib === "pixelfx" || args.lib === "codex") && args.subcommand === "presets")
  if (listsLocal) {
    if (args.lib === "pixellab") throw new UsageError("vfx effects lists a local library's effects; PixelLab's lists are vfx presets and vfx parts")
    if (args.lib === "codex") {
      const lib = loadCodex()
      if (args.json) {
        log(JSON.stringify({ version: 1, library: { name: "pixel-vfx-codex", version: lib.version, engineSha256: lib.engineSha256 }, effects: listCodexEffects(lib) }, null, 2))
        return
      }
      log(formatCodexEffects(lib))
      return
    }
    const lib = await loadPixelfx()
    if (args.json) {
      log(JSON.stringify({ version: 1, library: { name: "pixelfx", version: lib.version }, categories: lib.categories, effects: listPixelfxEffects(lib) }, null, 2))
      return
    }
    log(formatPixelfxEffects(lib))
    return
  }
  if (args.subcommand === "parts" && (args.lib === "pixelfx" || args.lib === "codex")) {
    throw new UsageError(`${args.lib} has no parts: its effects are whole; list them with vfx effects --lib ${args.lib}`)
  }
  if (args.subcommand === "make") {
    // A record passed back as --recipe needs no --lib: the file says what made it.
    const local = args.recipe && args.lib !== "pixellab" ? await readLocalRecipe(args.recipe, args.lib) : null
    const source = local?.lib ?? (args.lib === "pixelfx" || args.lib === "codex" ? args.lib : null)
    if (source === "pixelfx") return runPixelfxVfx(args, local?.lib === "pixelfx" ? local.read : null)
    if (source === "codex") return runCodexVfx(args, local?.lib === "codex" ? local.read : null)
  }
  for (const [flag, value] of [...pixelfxOnly_, ...codexOnly, ["--margin", args.margin]] as const) {
    if (value !== undefined) throw new UsageError(`vfx takes ${flag} only with --lib pixelfx or --lib codex`)
  }
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
  if (args.description !== undefined) return runVfxArtist(args, args.out)
  if (args.artist) throw new UsageError("--artist picks who draws a vfx --description; add one")
  if (args.spriteFrames !== undefined || args.spriteFps !== undefined) {
    throw new UsageError("--sprite-frames and --sprite-fps describe the sprite sent to PixelLab's VFX artist; add a --description")
  }
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

/** `vfx --lib pixelfx`: an effect from the pixelfx library, rendered on this machine. */
async function runPixelfxVfx(args: Args, fromFile: Awaited<ReturnType<typeof readPixelfxRecipe>>): Promise<void> {
  if (!args.out) throw new UsageError("vfx needs --out <base>: <base>.png, .json, and .vfx.json are written")
  const pixellabOnly = [
    ["--preset", args.preset],
    ["--part", args.parts.length ? args.parts : undefined],
    ["--sprite", args.sprite],
    ["--description", args.description],
    ["--artist", args.artist],
    ["--sprite-frames", args.spriteFrames],
    ["--sprite-fps", args.spriteFps],
    ["--game-pack", args.gamePack || undefined],
  ] as const
  for (const [flag, value] of pixellabOnly) {
    if (value !== undefined) throw new UsageError(`${flag} is for PixelLab's VFX tools; a pixelfx effect takes --effect, --palette, --seed, --fps and --margin`)
  }
  for (const [flag, value] of [["--camera", args.camera], ["--hue", args.hue], ["--param", args.param.length ? args.param : undefined], ["--tune", args.tune.length ? args.tune : undefined]] as const) {
    if (value !== undefined) throw new UsageError(`${flag} is for --lib codex; a pixelfx effect takes --effect, --palette, --seed, --fps and --margin`)
  }
  if (args.recipe && !fromFile) throw new UsageError(`${args.recipe} is not a pixelfx recipe: it names no pixelfx effect`)
  if (args.recipe && args.effect) throw new UsageError("vfx takes one of --effect or --recipe, not both")
  const effect = fromFile?.recipe.effect ?? args.effect
  if (!effect) throw new UsageError("vfx --lib pixelfx needs --effect <category>/<name> (vfx effects lists them) or --recipe <file>")
  // Flags override what a recipe file recorded, one option at a time.
  const options = {
    ...(fromFile?.recipe.options ?? {}),
    ...(args.palette.length ? { palette: args.palette } : {}),
    ...(args.seed !== undefined ? { seed: args.seed } : {}),
  }
  const recipe: PixelfxRecipe = {
    effect,
    fps: args.fps ?? fromFile?.recipe.fps,
    margin: args.margin ?? fromFile?.recipe.margin,
    ...(Object.keys(options).length ? { options } : {}),
  }
  const lib = await loadPixelfx()
  const info = checkPixelfxRecipe(lib, recipe)
  const paths = vfxOutputPaths(args.out)
  const fps = recipe.fps ?? info.fps
  const margin = recipe.margin ?? 0
  const frames = Math.max(1, Math.round(info.duration * fps) + (info.loop ? 0 : 1))
  log(
    `  vfx "${args.name ?? info.name}" from pixelfx ${lib.version} ${effect}${args.recipe ? ` (recipe ${args.recipe})` : ""}` +
      ` → ${paths.sheet} (+ .json, .vfx.json)`,
  )
  log(`  ${info.width + margin * 2}x${info.height + margin * 2}, ${frames} frames @ ${fps} fps, ${info.loop ? "loops" : "plays once"}`)
  log("  cost: free; rendered on this machine, nothing sent")
  if (fromFile?.libraryVersion && fromFile.libraryVersion !== lib.version) {
    log(`  note: the record was rendered with pixelfx ${fromFile.libraryVersion}; ${lib.version} may draw it differently`)
  }
  if (args.dryRun) {
    log("  dry run: nothing written")
    return
  }
  const res = await makePixelfxVfx(lib, { ...recipe, out: args.out, name: args.name, force: args.force })
  if (args.json) {
    log(JSON.stringify({ version: 1, ...res }, null, 2))
    return
  }
  for (const file of [res.paths.sheet, res.paths.atlas, res.paths.provenance]) log(`  wrote ${file}`)
  log(`  render it again: pixelkiln vfx --recipe ${res.paths.provenance} --out <base>`)
}

/** `vfx --lib codex`: an effect from pixel-vfx-codex, rendered on this machine. */
async function runCodexVfx(args: Args, fromFile: Awaited<ReturnType<typeof readCodexRecipe>>): Promise<void> {
  if (!args.out) throw new UsageError("vfx needs --out <base>: <base>.png, .json, and .vfx.json are written")
  const refused = [
    ["--preset", args.preset],
    ["--part", args.parts.length ? args.parts : undefined],
    ["--sprite", args.sprite],
    ["--description", args.description],
    ["--artist", args.artist],
    ["--sprite-frames", args.spriteFrames],
    ["--sprite-fps", args.spriteFps],
    ["--game-pack", args.gamePack || undefined],
  ] as const
  for (const [flag, value] of refused) {
    if (value !== undefined) throw new UsageError(`${flag} is for PixelLab's VFX tools; a codex effect takes --effect, --camera, --fps, --margin, --hue, --param and --tune`)
  }
  for (const [flag, value] of pixelfxOnly(args)) {
    if (value !== undefined) throw new UsageError(`${flag} is for --lib pixelfx: codex effects take no seed or palette (they are pure functions of time; recolour with --hue)`)
  }
  if (args.recipe && !fromFile) throw new UsageError(`${args.recipe} is not a codex recipe: it names no pixel-vfx-codex effect`)
  if (args.recipe && args.effect) throw new UsageError("vfx takes one of --effect or --recipe, not both")
  const effect = fromFile?.recipe.effect ?? args.effect
  if (!effect) throw new UsageError("vfx --lib codex needs --effect <id> (vfx effects --lib codex lists them) or --recipe <file>")
  // Flags override what a recipe file recorded, one setting at a time.
  const params = { ...(fromFile?.recipe.params ?? {}), ...numberPairs("--param", args.param) }
  const tune = { ...(fromFile?.recipe.tune ?? {}), ...numberPairs("--tune", args.tune) }
  const camera = (args.camera ?? fromFile?.recipe.camera) as CodexRecipe["camera"]
  if (args.camera !== undefined && !(CODEX_CAMERAS as readonly string[]).includes(args.camera)) {
    throw new UsageError(`--camera must be ${CODEX_CAMERAS.join(", ")}, got "${args.camera}"`)
  }
  const recipe: CodexRecipe = {
    effect,
    ...(camera ? { camera } : {}),
    ...((args.fps ?? fromFile?.recipe.fps) !== undefined ? { fps: args.fps ?? fromFile?.recipe.fps } : {}),
    ...((args.margin ?? fromFile?.recipe.margin) !== undefined ? { margin: args.margin ?? fromFile?.recipe.margin } : {}),
    ...((args.hue ?? fromFile?.recipe.hue) !== undefined ? { hue: args.hue ?? fromFile?.recipe.hue } : {}),
    ...(Object.keys(params).length ? { params } : {}),
    ...(Object.keys(tune).length ? { tune } : {}),
  }
  const lib = loadCodex()
  const info = checkCodexRecipe(lib, recipe)
  const plan = planCodex(lib, recipe)
  const paths = vfxOutputPaths(args.out)
  log(
    `  vfx "${args.name ?? info.en}" from pixel-vfx-codex ${lib.version} ${effect}${args.recipe ? ` (recipe ${args.recipe})` : ""}` +
      ` → ${paths.sheet} (+ .json, .vfx.json)`,
  )
  log(`  ${plan.camera} camera, about ${plan.frames} frames @ ${plan.fps} fps over ${plan.seconds.toFixed(1)} s, cropped to the effect; loops`)
  log("  cost: free; rendered on this machine, nothing sent")
  if (fromFile?.engineSha256 && fromFile.engineSha256 !== lib.engineSha256) {
    log(`  note: the record was rendered with engine ${fromFile.engineSha256}; this install is ${lib.engineSha256}, so it may draw the effect differently`)
  }
  if (args.dryRun) {
    log("  dry run: nothing written")
    return
  }
  const res = await makeCodexVfx(lib, { ...recipe, out: args.out, name: args.name, force: args.force })
  if (args.json) {
    log(JSON.stringify({ version: 1, ...res }, null, 2))
    return
  }
  log(`  ${res.width}x${res.height}, ${res.frames} frames @ ${res.fps} fps`)
  for (const file of [res.paths.sheet, res.paths.atlas, res.paths.provenance]) log(`  wrote ${file}`)
  log(`  render it again: pixelkiln vfx --recipe ${res.paths.provenance} --out <base>`)
}

/** `vfx --description`: PixelLab's paid VFX artist (`POST /vfx`) instead of the free workbench. */
async function runVfxArtist(args: Args, out: string): Promise<void> {
  const description = args.description!.trim()
  if (!description) throw new UsageError('vfx --description needs the effect in words, e.g. "a blue lightning strike that leaves sparks"')
  const workbenchOnly = [
    ["--preset", args.preset],
    ["--recipe", args.recipe],
    ["--part", args.parts.length ? args.parts : undefined],
    ["--fps", args.fps],
  ] as const
  for (const [flag, value] of workbenchOnly) {
    if (value !== undefined) {
      throw new UsageError(`vfx --description asks PixelLab's VFX artist, which takes no ${flag}; ${flag} is for the free workbench`)
    }
  }
  const artist = (args.artist ?? "lite") as VfxArtist
  if (!(VFX_ARTISTS as readonly string[]).includes(artist)) {
    throw new UsageError(`--artist must be ${VFX_ARTISTS.join(" or ")}, got "${args.artist}"`)
  }
  if (args.sprite && isVfxReference(args.sprite)) {
    throw new UsageError("vfx --description takes --sprite as a local PNG; PixelLab's VFX artist takes pixels, not a reference or URL")
  }
  if (args.name && args.name.length > 80) throw new UsageError("vfx --description takes a --name of at most 80 characters")
  const paths = vfxOutputPaths(out)
  if ((args.spriteFrames !== undefined || args.spriteFps !== undefined) && !args.sprite) {
    throw new UsageError("--sprite-frames and --sprite-fps describe a --sprite; add one")
  }
  const taken = args.sprite ? vfxArtistSprite(await readFile(args.sprite), args.sprite, args.spriteFrames ?? 1) : undefined
  if (args.spriteFps !== undefined && !taken?.animated) {
    throw new UsageError("--sprite-fps is the speed of an animated sprite: a GIF, or a PNG strip with --sprite-frames 2 or more")
  }
  const side = taken?.side ?? "none"
  const conversation = args.effect ? await readVfxConversation(paths.provenance, args.effect) : undefined
  // A change keeps the saved effect's own sprite, whose size is not known here.
  const quote = vfxArtistQuote(artist, args.effect && !args.sprite ? "unknown" : side, Boolean(conversation), Boolean(taken?.animated))
  const ceiling = vfxArtistCeiling(quote)
  log(
    `  vfx by PixelLab's ${artist} artist: "${description}"${args.sprite ? ` around ${args.sprite}` : ""}` +
      `${taken?.animated ? (taken.image.format === "gif" ? " (an animated GIF)" : ` (a strip of ${args.spriteFrames} frames)`) : ""}` +
      ` → ${paths.sheet} (+ .gif, .json, .vfx.json${args.gamePack ? ", -game.zip" : ""})`,
  )
  if (args.effect) {
    log(
      `  changes saved effect ${args.effect} in place` +
        (conversation
          ? `, priced as a change (its conversation is in ${path.basename(paths.provenance)})`
          : `; ${path.basename(paths.provenance)} holds no conversation for it, so PixelLab prices it as a new effect`),
    )
  }
  log(`  cost: about ${quote} generations by PixelLab's table, billed on delivery; at most ${ceiling} if the effect runs long`)
  if (args.budget !== undefined && args.budget < ceiling) {
    throw new Error(`--budget ${args.budget} is below this effect's ${ceiling}-generation ceiling`)
  }
  if (args.dryRun) {
    log("  dry run: nothing sent")
    return
  }
  if (!(await confirm(`  Spend up to ${ceiling} generations on this effect?`, args.yes))) return
  loadKeys(args)
  let last = ""
  const res = await makeVfxWithArtist(clientFromEnv(), {
    description,
    artist,
    sprite: args.sprite,
    spriteFrames: args.spriteFrames,
    spriteFps: args.spriteFps,
    effect: args.effect,
    conversation,
    name: args.name,
    out,
    gamePack: args.gamePack,
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
  log(
    `  ${res.width}x${res.height}, ${res.frames} frames` +
      `${res.fps ? ` @ ${res.fps} fps` : ""}${res.loop === null ? "" : res.loop ? ", loops" : ", plays once"}`,
  )
  if (res.message) log(`  the artist: ${res.message}`)
  for (const file of [res.paths.sheet, res.paths.gif, res.paths.atlas, res.paths.gamePack, res.paths.normals, res.paths.provenance]) {
    if (file) log(`  wrote ${file}`)
  }
  const usage = res.usage as { generations?: unknown } | null
  if (typeof usage?.generations === "number") log(`  billed ${usage.generations} generations (quoted ${res.quotedGenerations ?? "?"})`)
  if (res.editUrl) log(`  tweak it with sliders: ${res.editUrl}`)
  log(`  change it: pixelkiln vfx --description "<what to change>" --effect ${res.effectId} --out ${out} --force`)
  log(`  render it again for free with the workbench: pixelkiln vfx --effect ${res.effectId} --out <base>`)
}
