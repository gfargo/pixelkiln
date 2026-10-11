/**
 * PixelLab's VFX workbench (Create VFX), driven through its MCP tool.
 *
 * PixelLab added Create VFX in 0.4.128 (October 2026) and exposes it only as
 * the `vfx_workbench` MCP tool; there is no REST endpoint. It is a renderer,
 * not a model: an effect is a JSON recipe of layers (most of them dropped in
 * as tuned "parts"), rendered to crisp pixel-art frames, and nothing is
 * generated or billed (free on a subscription). Every call returns a new
 * immutable step id; `export` saves the effect to the account's "My effects"
 * (editable with sliders on pixellab.ai) and hands back a GIF, a spritesheet
 * PNG and an Aseprite-style JSON atlas, plus a game-pack ZIP on request. The
 * download URLs need no auth.
 *
 * The workbench is built for an agent that looks at every render and
 * corrects it. This module covers the repeatable part: start from a preset,
 * a saved effect, or a recipe file, optionally add parts, export, download,
 * and save the effect's final recipe beside the files so the same effect
 * can be rendered again later, byte for byte, with `recipe`.
 */
import { existsSync } from "node:fs"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import path from "node:path"
import { MAX_DOWNLOAD_BYTES } from "./client.ts"
import { fetchWithRetry } from "./http.ts"
import { imageMetadata } from "./media.ts"
import type { PixelLabMcpClient } from "./pixellab-mcp.ts"

export const VFX_TOOL = "vfx_workbench"

/** Arguments for one `add_part`; `name` is the part (see `describeVfx("parts")`), the rest its placement and sliders. */
export interface VfxPart {
  name: string
  [option: string]: unknown
}

export interface VfxExport {
  effectId: string
  editUrl: string | null
  width: number
  height: number
  frames: number
  fps: number
  loop: boolean
  anchor: { x: number; y: number } | null
  /** The folder every file below is served from, with a trailing slash. */
  downloadBase: string
  files: string[]
  imageId: string | null
}

const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}"

/** The step id a workbench reply hands back; every call that changes the effect returns a new one. */
export function parseVfxStep(text: string): string {
  const match = new RegExp(`effect step: (${UUID})`).exec(text)
  if (!match) throw new Error(`PixelLab vfx_workbench returned no step id:\n${text.slice(0, 600)}`)
  return match[1]!
}

/** The working recipe `start` prints (from a preset or a saved effect), or null when it printed none. */
export function parseVfxRecipe(text: string): Record<string, unknown> | null {
  const lines = text.split(/\r?\n/)
  const at = lines.findIndex((line) => line.trim() === "working recipe:")
  const json = at >= 0 ? lines[at + 1]?.trim() : undefined
  if (!json?.startsWith("{")) return null
  return JSON.parse(json) as Record<string, unknown>
}

/** Reads an `export` reply. The shape is plain text; every field read here was seen on a live export in October 2026. */
export function parseVfxExport(text: string): VfxExport {
  const effectId = new RegExp(`effect id (${UUID})`).exec(text)?.[1]
  const download = /download (https:\/\/\S+\/): (.+)$/m.exec(text)
  const size = /(\d+)x(\d+), (\d+) frames @ ([\d.]+) fps, ([^;\n]+)/.exec(text)
  if (!effectId || !download || !size) {
    throw new Error(`PixelLab vfx_workbench export reply was not understood:\n${text.slice(0, 600)}`)
  }
  const anchor = /anchor[^\n]*? at (-?\d+),\s*(-?\d+)/.exec(text)
  return {
    effectId,
    editUrl: /(https:\/\/pixellab\.ai\/create-vfx\?effect=[0-9a-f-]+)/.exec(text)?.[1] ?? null,
    width: Number(size[1]),
    height: Number(size[2]),
    frames: Number(size[3]),
    fps: Number(size[4]),
    loop: !/plays once/.test(size[5]!),
    anchor: anchor ? { x: Number(anchor[1]), y: Number(anchor[2]) } : null,
    downloadBase: download[1]!,
    files: download[2]!.split(",").map((file) => file.trim()).filter(Boolean),
    imageId: new RegExp(`image id: (${UUID})`).exec(text)?.[1] ?? null,
  }
}

/** The workbench's own guide to a topic: `presets`, `parts`, `start`, `recipe`, `edits`, and so on. Free. */
export async function describeVfx(client: Pick<PixelLabMcpClient, "callTool">, topic: string): Promise<string> {
  return (await client.callTool(VFX_TOOL, { argv: ["describe", topic] })).text
}

/** `<out>.png`, `.gif`, `.json`, `.vfx.json`, and `-game.zip`, with a trailing extension on `out` treated as the base's own. */
export function vfxOutputPaths(out: string): { sheet: string; gif: string; atlas: string; provenance: string; gamePack: string } {
  const base = path.resolve(out.replace(/\.(png|gif|json|zip)$/i, "").replace(/\.vfx$/i, ""))
  return {
    sheet: `${base}.png`,
    gif: `${base}.gif`,
    atlas: `${base}.json`,
    provenance: `${base}.vfx.json`,
    gamePack: `${base}-game.zip`,
  }
}

/** A PixelLab reference or a URL, as opposed to a local file. */
export function isVfxReference(sprite: string): boolean {
  return /^(character|object|gallery):/.test(sprite) || /^(https?|data):/.test(sprite)
}

/**
 * A `--sprite` value as the workbench takes it. PixelLab references
 * (`character:<id>:<direction>`, `object:<id>`, `gallery:<id>`) and URLs pass
 * through; anything else is read as a local PNG or JPEG and sent inline.
 */
export async function resolveVfxSprite(sprite: string): Promise<string> {
  if (isVfxReference(sprite)) return sprite
  const bytes = await readFile(sprite)
  const metadata = imageMetadata(bytes)
  if (!metadata) throw new Error(`${sprite} is not a readable PNG or JPEG`)
  return `data:image/${metadata.format};base64,${bytes.toString("base64")}`
}

/**
 * A recipe file: either a bare recipe or the `.vfx.json` record `makeVfx`
 * writes. From a record, the sprite it was built around comes back too: a
 * recipe stores only where the sprite stands (`subject`), not its pixels,
 * so it has to be sent again to render the same effect.
 */
export async function readVfxRecipe(file: string): Promise<{ recipe: Record<string, unknown>; sprite?: string }> {
  const parsed = JSON.parse(await readFile(file, "utf8")) as Record<string, unknown>
  const record = parsed.tool === VFX_TOOL && parsed.recipe && typeof parsed.recipe === "object"
  const recipe = (record ? parsed.recipe : parsed) as Record<string, unknown>
  if (!Array.isArray(recipe.layers)) throw new Error(`${file} is not a VFX recipe: it has no "layers" list`)
  const recorded = record ? (parsed.source as { sprite?: unknown } | undefined)?.sprite : undefined
  if (typeof recorded !== "string") return { recipe }
  // A local sprite is recorded relative to the record itself, so the pair can move together.
  const sprite = isVfxReference(recorded) ? recorded : path.resolve(path.dirname(path.resolve(file)), recorded)
  return { recipe, sprite }
}

export interface MakeVfxOptions {
  /** Start from one of PixelLab's whole-effect presets (`describeVfx("presets")`). */
  preset?: string
  /** Start from a full recipe, e.g. one a previous run saved. Rendered exactly as given. */
  recipe?: Record<string, unknown>
  /** Start from an effect saved in the account's My effects, with any slider changes made on pixellab.ai. Exported over itself. */
  effect?: string
  /** Parts added on top of whatever the effect started from; alone, the first one starts the effect. */
  parts?: VfxPart[]
  /** The character the effect is built around: a local image, a URL, or a PixelLab reference. */
  sprite?: string
  fps?: number
  /**
   * The name saved to My effects. Defaults to the saved effect's own name
   * when starting from one (so exporting over it does not rename it), or the
   * recipe's, then the preset, then the output's file name.
   */
  name?: string
  /** Output base; see `vfxOutputPaths`. */
  out: string
  /** Also export a ZIP with every piece as its own clip plus a manifest, for a game engine. */
  gamePack?: boolean
  /** A My effects id to overwrite instead of saving a new effect. Defaults to `effect` when starting from one. */
  replace?: string
  force?: boolean
  onProgress?: (message: string) => void
  /** Replaced in tests. Defaults to a size-limited, retrying fetch. */
  download?: (url: string) => Promise<Buffer>
}

export interface VfxProvenance {
  version: 1
  provider: "pixellab"
  tool: typeof VFX_TOOL
  name: string
  effectId: string
  editUrl: string | null
  source: { preset?: string; effect?: string; recipeFile?: boolean; parts?: VfxPart[]; sprite?: string }
  width: number
  height: number
  frames: number
  fps: number
  loop: boolean
  anchor: { x: number; y: number } | null
  files: { sheet: string; gif: string; atlas: string; gamePack?: string }
  exportedAt: string
  /** The effect's recipe as PixelLab saved it; feed this file back as `--recipe` to render it again. */
  recipe: Record<string, unknown> | null
}

export interface MakeVfxResult extends VfxExport {
  paths: { sheet: string; gif: string; atlas: string; provenance: string; gamePack?: string }
  recipe: Record<string, unknown> | null
}

async function defaultDownload(url: string): Promise<Buffer> {
  const http = fetchWithRetry()
  const res = await http(url)
  if (!res.ok) throw new Error(`download ${url} → ${res.status}`)
  const buf = Buffer.from(await res.arrayBuffer())
  if (buf.length > MAX_DOWNLOAD_BYTES) throw new Error(`download ${url} exceeds the ${MAX_DOWNLOAD_BYTES}-byte safety limit`)
  return buf
}

/** Which local path a served file lands on, by its suffix. */
function localPathFor(file: string, paths: ReturnType<typeof vfxOutputPaths>): string | null {
  if (/-game\.zip$/i.test(file)) return paths.gamePack
  if (/\.gif$/i.test(file)) return paths.gif
  if (/\.json$/i.test(file)) return paths.atlas
  if (/\.png$/i.test(file)) return paths.sheet
  return null
}

/**
 * Build, export, and download one effect: start (preset, saved effect,
 * recipe, or nothing), add parts, export to My effects, download the files,
 * then read the saved effect's final recipe back and write it with the
 * export's facts to `<out>.vfx.json`.
 */
export async function makeVfx(client: Pick<PixelLabMcpClient, "callTool">, opts: MakeVfxOptions): Promise<MakeVfxResult> {
  const starts = [opts.preset, opts.recipe, opts.effect].filter((value) => value !== undefined).length
  if (starts > 1) throw new Error("Start a VFX from one of a preset, a recipe, or a saved effect, not several")
  if (starts === 0 && !opts.parts?.length) {
    throw new Error("A VFX needs something to start from: a preset, a recipe, a saved effect, or at least one part")
  }
  const paths = vfxOutputPaths(opts.out)
  const wanted = [paths.sheet, paths.gif, paths.atlas, paths.provenance, ...(opts.gamePack ? [paths.gamePack] : [])]
  if (!opts.force) {
    for (const file of wanted) {
      if (existsSync(file)) throw new Error(`${file} already exists; pass --force to replace it`)
    }
  }
  const progress = opts.onProgress ?? (() => {})
  const call = async (argv: string[]) => (await client.callTool(VFX_TOOL, { argv, notes: "pixelkiln vfx" })).text

  const startArgv = ["start"]
  if (opts.sprite) startArgv.push("--sprite", await resolveVfxSprite(opts.sprite))
  if (opts.preset) startArgv.push("--preset", opts.preset)
  if (opts.effect) startArgv.push("--effect", opts.effect)
  progress(opts.preset ? `starting from preset ${opts.preset}` : opts.effect ? `starting from saved effect ${opts.effect}` : "starting")
  const started = await call(startArgv)
  let step = parseVfxStep(started)
  const savedName = opts.effect ? parseVfxRecipe(started)?.name : opts.recipe?.name
  const name = opts.name ?? (typeof savedName === "string" ? savedName : undefined) ?? opts.preset ?? path.basename(paths.sheet, ".png")

  if (opts.recipe) {
    progress("rendering the recipe")
    step = parseVfxStep(await call([step, "render", JSON.stringify({ recipe: opts.recipe })]))
  }
  if (opts.parts?.length) {
    progress(`adding ${opts.parts.map((part) => part.name).join(", ")}`)
    step = parseVfxStep(await call([step, "add_part", JSON.stringify({ parts: opts.parts })]))
  }
  if (opts.fps !== undefined) {
    // `start --fps` is ignored when a preset or saved effect brings its own
    // (checked live); a patch on the working recipe is what sets it.
    progress(`setting ${opts.fps} fps`)
    step = parseVfxStep(await call([step, "render", JSON.stringify({ patch: [{ op: "set", path: "fps", value: opts.fps }] })]))
  }

  const exportArgv = [step, "export", "--name", name]
  const replace = opts.replace ?? opts.effect
  if (replace) exportArgv.push("--replace", replace)
  if (opts.gamePack) exportArgv.push("--game-pack")
  progress(opts.gamePack ? "exporting with a game pack" : "exporting")
  const exported = parseVfxExport(await call(exportArgv))

  const download = opts.download ?? defaultDownload
  const written: MakeVfxResult["paths"] = { sheet: paths.sheet, gif: paths.gif, atlas: paths.atlas, provenance: paths.provenance }
  await mkdir(path.dirname(paths.sheet), { recursive: true })
  for (const file of exported.files) {
    const target = localPathFor(file, paths)
    if (!target) continue
    let bytes = await download(`${exported.downloadBase}${encodeURIComponent(file)}`)
    if (target === paths.atlas) {
      // The atlas names its sheet by PixelLab's file name; point it at ours.
      const atlas = JSON.parse(bytes.toString("utf8")) as { meta?: Record<string, unknown> }
      if (atlas.meta) atlas.meta.image = path.basename(paths.sheet)
      bytes = Buffer.from(`${JSON.stringify(atlas, null, 2)}\n`)
    }
    await writeFile(target, bytes)
    if (target === paths.gamePack) written.gamePack = target
  }
  for (const file of [paths.sheet, paths.gif, paths.atlas]) {
    if (!existsSync(file)) throw new Error(`PixelLab's export listed no file for ${path.basename(file)}: ${exported.files.join(", ")}`)
  }

  // The export reply carries no recipe; the saved effect does, sliders and all.
  progress("reading the saved recipe")
  const recipe = parseVfxRecipe(await call(["start", "--effect", exported.effectId]))
  const spriteRecord = !opts.sprite || /^data:/.test(opts.sprite)
    ? undefined
    : isVfxReference(opts.sprite)
      ? opts.sprite
      : path.relative(path.dirname(paths.provenance), path.resolve(opts.sprite)).split(path.sep).join("/")
  const provenance: VfxProvenance = {
    version: 1,
    provider: "pixellab",
    tool: VFX_TOOL,
    name,
    effectId: exported.effectId,
    editUrl: exported.editUrl,
    source: {
      ...(opts.preset ? { preset: opts.preset } : {}),
      ...(opts.effect ? { effect: opts.effect } : {}),
      ...(opts.recipe ? { recipeFile: true } : {}),
      ...(opts.parts?.length ? { parts: opts.parts } : {}),
      ...(spriteRecord ? { sprite: spriteRecord } : {}),
    },
    width: exported.width,
    height: exported.height,
    frames: exported.frames,
    fps: exported.fps,
    loop: exported.loop,
    anchor: exported.anchor,
    files: {
      sheet: path.basename(paths.sheet),
      gif: path.basename(paths.gif),
      atlas: path.basename(paths.atlas),
      ...(written.gamePack ? { gamePack: path.basename(written.gamePack) } : {}),
    },
    exportedAt: new Date().toISOString(),
    recipe,
  }
  await writeFile(paths.provenance, `${JSON.stringify(provenance, null, 2)}\n`)
  return { ...exported, paths: written, recipe }
}
