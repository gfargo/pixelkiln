/**
 * PixelLab's VFX workbench (Create VFX), driven through its MCP tool.
 *
 * PixelLab added Create VFX in 0.4.128 (October 2026) and exposes the
 * workbench only as the `vfx_workbench` MCP tool. It is a renderer,
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
 *
 * 0.4.130 added the paid side over REST: `POST /vfx`, an effects artist that
 * builds an effect from a plain-language description (the website's VFX
 * creator), renders it, checks it, and saves it to My effects. The second
 * half of this file drives it; its results are the same kind of export.
 */
import { existsSync } from "node:fs"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import path from "node:path"
import { MAX_DOWNLOAD_BYTES, type PixelLabClient } from "./client.ts"
import { sha256 } from "./hash.ts"
import { fetchWithRetry } from "./http.ts"
import { imageMetadata } from "./media.ts"
import { decodePng, encodeRgbaPng } from "./png.ts"
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

/** `<out>.png`, `.gif`, `.json`, `.vfx.json`, `-game.zip`, and the artist's `-normals.png`, with a trailing extension on `out` treated as the base's own. */
export function vfxOutputPaths(out: string): {
  sheet: string
  gif: string
  atlas: string
  provenance: string
  gamePack: string
  normals: string
} {
  const base = path.resolve(out.replace(/\.(png|gif|json|zip)$/i, "").replace(/\.vfx$/i, ""))
  return {
    sheet: `${base}.png`,
    gif: `${base}.gif`,
    atlas: `${base}.json`,
    provenance: `${base}.vfx.json`,
    gamePack: `${base}-game.zip`,
    normals: `${base}-normals.png`,
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

export interface VfxWorkbenchOptions {
  preset?: string
  recipe?: Record<string, unknown>
  effect?: string
  parts?: VfxPart[]
  /** Already in the form the workbench takes: see `resolveVfxSprite`. */
  sprite?: string
  fps?: number
  /** The My effects name; defaults to the saved effect's or recipe's own, then `defaultName`. */
  name?: string
  defaultName: string
  /** A My effects id to export over instead of saving a new effect. */
  replace?: string
  gamePack?: boolean
  /** Stored with each step by PixelLab, to improve its tools. */
  notes?: string
  onProgress?: (message: string) => void
  /** Called as soon as the export lands, before the recipe is read back, so a caller can checkpoint it. */
  onExported?: (exported: VfxExport, name: string) => void | Promise<void>
}

/**
 * The workbench calls for one effect: start, render a recipe, add parts,
 * set fps, export, then read the saved effect's recipe back (the export reply
 * carries none). Downloads nothing.
 */
export async function runVfxWorkbench(
  client: Pick<PixelLabMcpClient, "callTool">,
  opts: VfxWorkbenchOptions,
): Promise<{ exported: VfxExport; recipe: Record<string, unknown> | null; name: string }> {
  const starts = [opts.preset, opts.recipe, opts.effect].filter((value) => value !== undefined).length
  if (starts > 1) throw new Error("Start a VFX from one of a preset, a recipe, or a saved effect, not several")
  if (starts === 0 && !opts.parts?.length) {
    throw new Error("A VFX needs something to start from: a preset, a recipe, a saved effect, or at least one part")
  }
  const progress = opts.onProgress ?? (() => {})
  const call = async (argv: string[]) => (await client.callTool(VFX_TOOL, { argv, ...(opts.notes ? { notes: opts.notes } : {}) })).text

  const startArgv = ["start"]
  if (opts.sprite) startArgv.push("--sprite", opts.sprite)
  if (opts.preset) startArgv.push("--preset", opts.preset)
  if (opts.effect) startArgv.push("--effect", opts.effect)
  progress(opts.preset ? `starting from preset ${opts.preset}` : opts.effect ? `starting from saved effect ${opts.effect}` : "starting")
  const started = await call(startArgv)
  let step = parseVfxStep(started)
  const savedName = opts.effect ? parseVfxRecipe(started)?.name : opts.recipe?.name
  const name = opts.name ?? (typeof savedName === "string" ? savedName : undefined) ?? opts.defaultName

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
  if (opts.replace) exportArgv.push("--replace", opts.replace)
  if (opts.gamePack) exportArgv.push("--game-pack")
  progress(opts.gamePack ? "exporting with a game pack" : "exporting")
  const exported = parseVfxExport(await call(exportArgv))
  await opts.onExported?.(exported, name)

  progress("reading the saved recipe")
  const recipe = parseVfxRecipe(await call(["start", "--effect", exported.effectId]))
  return { exported, recipe, name }
}

/** The saved effect's recipe, or null when the account no longer has it (PixelLab: "No saved effect … in your library"). */
export async function readSavedVfxRecipe(
  client: Pick<PixelLabMcpClient, "callTool">,
  effectId: string,
): Promise<Record<string, unknown> | null> {
  try {
    return parseVfxRecipe((await client.callTool(VFX_TOOL, { argv: ["start", "--effect", effectId] })).text)
  } catch (error) {
    if (error instanceof Error && /no saved effect/i.test(error.message)) return null
    throw error
  }
}

/**
 * A recipe's identity: what renders, not what it is called. `name` and
 * `notes` change with an export's name and never reach a pixel, so two
 * recipes that differ only there hash the same.
 */
export function vfxRecipeSha256(recipe: Record<string, unknown>): string {
  const { name: _name, notes: _notes, ...rest } = recipe
  return sha256(JSON.stringify(rest))
}

type FrameRect = { x: number; y: number; w: number; h: number }

/**
 * An atlas's frame rectangles in order, from an Aseprite-style `frames` list
 * or hash, or null when any entry lacks a numeric `frame` rectangle.
 */
export function vfxAtlasFrames(atlas: unknown): FrameRect[] | null {
  const listed = (atlas as { frames?: unknown } | undefined)?.frames
  const entries = Array.isArray(listed) ? listed : listed && typeof listed === "object" ? Object.values(listed) : null
  if (!entries?.length) return null
  const rects = entries.map((entry) => (entry as { frame?: Partial<FrameRect> } | null)?.frame)
  return rects.every((rect) => rect && [rect.x, rect.y, rect.w, rect.h].every((n) => typeof n === "number"))
    ? (rects as FrameRect[])
    : null
}

/**
 * Cut an exported spritesheet into its frames. The atlas's frame rectangles
 * are used when it lists one per frame; otherwise the sheet is read as a
 * row-major grid of `width`x`height` cells, which is how PixelLab lays it out.
 */
export function sliceVfxSheet(
  sheet: Buffer,
  facts: { width: number; height: number; frames: number },
  atlas?: unknown,
): Buffer[] {
  const image = decodePng(sheet)
  const listed = vfxAtlasFrames(atlas)
  const rects = listed && listed.length === facts.frames
    ? listed
    : Array.from({ length: facts.frames }, (_, index) => {
        const columns = Math.max(1, Math.floor(image.width / facts.width))
        return { x: (index % columns) * facts.width, y: Math.floor(index / columns) * facts.height, w: facts.width, h: facts.height }
      })
  return rects.map((rect, index) => {
    if (rect.x < 0 || rect.y < 0 || rect.x + rect.w > image.width || rect.y + rect.h > image.height) {
      throw new Error(
        `VFX frame ${index + 1} (${rect.w}x${rect.h} at ${rect.x},${rect.y}) falls outside the ${image.width}x${image.height} sheet`,
      )
    }
    const out = Buffer.alloc(rect.w * rect.h * 4)
    for (let y = 0; y < rect.h; y++) {
      const from = ((rect.y + y) * image.width + rect.x) * 4
      image.pixels.copy(out, y * rect.w * 4, from, from + rect.w * 4)
    }
    return encodeRgbaPng(rect.w, rect.h, out)
  })
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
  const { exported, recipe, name } = await runVfxWorkbench(client, {
    preset: opts.preset,
    recipe: opts.recipe,
    effect: opts.effect,
    parts: opts.parts,
    sprite: opts.sprite ? await resolveVfxSprite(opts.sprite) : undefined,
    fps: opts.fps,
    name: opts.name,
    defaultName: opts.preset ?? path.basename(paths.sheet, ".png"),
    replace: opts.replace ?? opts.effect,
    gamePack: opts.gamePack,
    notes: "pixelkiln vfx",
    onProgress: progress,
  })

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

// The VFX artist: `POST /vfx` over REST, paid.

export type VfxArtist = "lite" | "pro"
export const VFX_ARTISTS = ["lite", "pro"] as const
/** The artist takes a sprite up to this many pixels per side (per frame). */
export const VFX_ARTIST_MAX_SPRITE = 512

/**
 * PixelLab's quote for one `POST /vfx`, in generations, from the table in
 * its OpenAPI description (0.4.130; no live bill seen yet). `sprite` is the
 * sprite's longer side, `"none"` without one, or `"unknown"` for a file that
 * does not exist yet, which is priced at the top (512px) tier. A `change` is
 * a request with an `effect_id` and that effect's `conversation`; without
 * the conversation PixelLab prices a change as a new effect.
 */
export function vfxArtistQuote(artist: VfxArtist, sprite: number | "none" | "unknown", change = false): number {
  // Columns: no sprite, a sprite up to 128px, up to 256px, up to 512px.
  const table = {
    lite: { new: [1, 1, 3, 5], change: [1, 1, 2, 2] },
    pro: { new: [6, 8, 14, 28], change: [4, 4, 5, 8] },
  }
  const tier = sprite === "none" ? 0 : sprite === "unknown" ? 3 : sprite <= 128 ? 1 : sprite <= 256 ? 2 : 3
  return table[artist][change ? "change" : "new"][tier]!
}

/**
 * The most one artist job can bill. PixelLab charges the quote, more when
 * the effect took much longer, and never more than twice the quote, so
 * plans and `--budget` count twice the quote: a run never spends past what
 * its budget let through. The bill is read back from the finished job.
 */
export function vfxArtistCeiling(quote: number): number {
  return quote * 2
}

/** A sprite file's bytes as the artist takes them: a PNG up to 512px a side. */
export function vfxArtistSprite(bytes: Buffer, label: string): { image: { base64: string; format: "png" }; side: number } {
  const metadata = imageMetadata(bytes)
  if (metadata?.format !== "png") throw new Error(`${label}: PixelLab's VFX artist takes a PNG sprite`)
  const side = Math.max(metadata.width, metadata.height)
  if (side > VFX_ARTIST_MAX_SPRITE) {
    throw new Error(
      `${label} is ${metadata.width}x${metadata.height}; PixelLab's VFX artist takes up to ${VFX_ARTIST_MAX_SPRITE}x${VFX_ARTIST_MAX_SPRITE} ` +
        "(crop or pad it; never rescale pixel art)",
    )
  }
  return { image: { base64: bytes.toString("base64"), format: "png" }, side }
}

export interface VfxArtistFile {
  name: string
  url: string
}

/**
 * `last_response.files` as name and URL pairs. The shape is undocumented, so
 * a list of URLs, a list of `{name, url}` records, and a name-to-URL map are
 * all read; a file's name falls back to its URL's last path segment.
 */
export function vfxArtistFiles(raw: unknown): VfxArtistFile[] {
  const urlOf = (value: unknown): string | null => {
    if (typeof value === "string") return /^https?:\/\//i.test(value) ? value : null
    if (!value || typeof value !== "object") return null
    for (const key of ["url", "download_url", "href"]) {
      const url = (value as Record<string, unknown>)[key]
      if (typeof url === "string" && /^https?:\/\//i.test(url)) return url
    }
    return null
  }
  const nameOf = (value: unknown, url: string, key: string | undefined): string => {
    if (value && typeof value === "object") {
      for (const field of ["name", "filename", "file"]) {
        const name = (value as Record<string, unknown>)[field]
        if (typeof name === "string" && name) return name
      }
    }
    if (key && /\.[a-z0-9]+$/i.test(key)) return key
    return decodeURIComponent(new URL(url).pathname.split("/").pop() ?? "")
  }
  const entries: Array<[string | undefined, unknown]> = Array.isArray(raw)
    ? raw.map((value) => [undefined, value])
    : raw && typeof raw === "object"
      ? Object.entries(raw)
      : []
  const files: VfxArtistFile[] = []
  for (const [key, value] of entries) {
    const url = urlOf(value)
    if (url) files.push({ name: nameOf(value, url, key), url })
  }
  return files
}

export interface VfxArtistResult {
  effectId: string
  name: string | null
  editUrl: string | null
  /** What the artist says it made. */
  message: string | null
  width: number | null
  height: number | null
  frames: number | null
  fps: number | null
  loop: boolean | null
  anchor: { kind: string | null; x: number; y: number } | null
  parts: unknown
  /** Passed back with `effect_id` to price a change as a change. */
  conversation: string | null
  files: VfxArtistFile[]
  sheet: VfxArtistFile
  atlas: VfxArtistFile | null
  gif: VfxArtistFile | null
  gamePack: VfxArtistFile | null
  /** The sprite's normal map, when a light in the effect made one. */
  normals: VfxArtistFile | null
}

/**
 * A completed `/vfx` job's `last_response`. Every field named here is from
 * PixelLab's OpenAPI description, not a live job; a reply with no effect id
 * or no spritesheet fails naming the keys it did have.
 */
export function parseVfxArtistResult(done: Record<string, unknown>, jobId: string): VfxArtistResult {
  const files = vfxArtistFiles(done.files)
  const pick = (test: RegExp, skip?: RegExp) => files.find((file) => test.test(file.name) && !skip?.test(file.name)) ?? null
  const normals = /-normals?\.png$/i
  const sheet = pick(/\.png$/i, normals)
  const effectId = typeof done.effect_id === "string" && done.effect_id ? done.effect_id : null
  if (!effectId || !sheet) {
    throw new Error(
      `Invalid PixelLab response for vfx job ${jobId}: completed without ${effectId ? "a spritesheet among its files" : "an effect_id"} ` +
        `(last_response keys: ${Object.keys(done).join(", ") || "none"}; files: ${JSON.stringify(done.files ?? null).slice(0, 400)}); ` +
        "update parseVfxArtistResult in src/pixellab-vfx.ts with the real shape",
    )
  }
  const number = (value: unknown) => (typeof value === "number" && Number.isFinite(value) ? value : null)
  const text = (value: unknown) => (typeof value === "string" && value ? value : null)
  const canvas = (done.canvas ?? {}) as { w?: unknown; h?: unknown }
  const anchor = done.anchor as { kind?: unknown; x?: unknown; y?: unknown } | undefined
  return {
    effectId,
    name: text(done.name),
    editUrl: text(done.edit_url),
    message: text(done.message),
    width: number(canvas.w),
    height: number(canvas.h),
    frames: number(done.frames),
    fps: number(done.fps),
    loop: typeof done.loop === "boolean" ? done.loop : null,
    anchor: anchor && number(anchor.x) !== null && number(anchor.y) !== null
      ? { kind: text(anchor.kind), x: anchor.x as number, y: anchor.y as number }
      : null,
    parts: done.parts ?? null,
    conversation: text(done.conversation),
    files,
    sheet,
    atlas: pick(/\.json$/i),
    gif: pick(/\.gif$/i),
    gamePack: pick(/\.zip$/i),
    normals: pick(normals),
  }
}

/** The frame size and count the result states, filled in from the atlas where it is silent. */
export function vfxArtistFrameFacts(
  result: Pick<VfxArtistResult, "width" | "height" | "frames" | "effectId">,
  atlas: unknown,
): { width: number; height: number; frames: number } {
  const rects = vfxAtlasFrames(atlas)
  const frames = result.frames ?? rects?.length ?? null
  const width = result.width ?? rects?.[0]?.w ?? null
  const height = result.height ?? rects?.[0]?.h ?? null
  if (!frames || !width || !height) {
    throw new Error(`PixelLab vfx effect ${result.effectId} came back with no frame size or count, in the result or its atlas`)
  }
  return { width, height, frames }
}

export interface MakeVfxWithArtistOptions {
  description: string
  artist?: VfxArtist
  /** A local PNG the effect is built around, up to 512px a side. */
  sprite?: string
  /** A My effects id to change in place; `description` then says what to change. */
  effect?: string
  /** The `conversation` an earlier result for `effect` handed back; prices the change as a change. */
  conversation?: string
  name?: string
  out: string
  gamePack?: boolean
  force?: boolean
  onProgress?: (message: string) => void
  /** Poll interval and ceiling. PixelLab documents 30-90 s. */
  intervalMs?: number
  timeoutMs?: number
  sleep?: (ms: number) => Promise<void>
}

export interface VfxArtistProvenance {
  version: 1
  provider: "pixellab"
  tool: "vfx"
  artist: VfxArtist
  description: string
  name: string | null
  effectId: string
  editUrl: string | null
  message: string | null
  source: { sprite?: string; changed?: string }
  width: number
  height: number
  frames: number
  fps: number | null
  loop: boolean | null
  anchor: VfxArtistResult["anchor"]
  parts: unknown
  files: { sheet: string; gif?: string; atlas?: string; gamePack?: string; normals?: string }
  quotedGenerations: number | null
  usage: unknown
  /** Passed back with `--effect` to change this effect at the change price; `pixelkiln vfx` reads it from here. */
  conversation: string | null
  exportedAt: string
}

export interface MakeVfxWithArtistResult {
  jobId: string
  effectId: string
  editUrl: string | null
  name: string | null
  message: string | null
  width: number
  height: number
  frames: number
  fps: number | null
  loop: boolean | null
  anchor: VfxArtistResult["anchor"]
  quotedGenerations: number | null
  usage: unknown
  paths: { sheet: string; provenance: string; gif?: string; atlas?: string; gamePack?: string; normals?: string }
}

/**
 * Ask PixelLab's VFX artist for one effect, wait for it, download its files,
 * and write `<out>.vfx.json`. Paid: the caller prices it first with
 * `vfxArtistQuote` and `vfxArtistCeiling`.
 */
export async function makeVfxWithArtist(
  client: Pick<PixelLabClient, "createVfx" | "getBackgroundJob" | "download">,
  opts: MakeVfxWithArtistOptions,
): Promise<MakeVfxWithArtistResult> {
  const paths = vfxOutputPaths(opts.out)
  if (!opts.force) {
    for (const file of [paths.sheet, paths.gif, paths.atlas, paths.provenance, ...(opts.gamePack ? [paths.gamePack] : [])]) {
      if (existsSync(file)) throw new Error(`${file} already exists; pass --force to replace it`)
    }
  }
  const progress = opts.onProgress ?? (() => {})
  const sprite = opts.sprite ? vfxArtistSprite(await readFile(opts.sprite), opts.sprite).image : undefined
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)))
  const interval = opts.intervalMs ?? 6000
  const timeout = opts.timeoutMs ?? 10 * 60_000

  const submitted = await client.createVfx({
    description: opts.description,
    artist: opts.artist,
    sprite,
    effectId: opts.effect,
    conversation: opts.effect ? opts.conversation : undefined,
    name: opts.name,
    gamePack: opts.gamePack,
  })
  const jobId = submitted.background_job_id
  progress(`submitted job ${jobId}, quoted ${submitted.quoted_generations ?? "?"} generations`)
  const started = Date.now()
  let job: Awaited<ReturnType<PixelLabClient["getBackgroundJob"]>>
  for (;;) {
    job = await client.getBackgroundJob(jobId)
    if (job.status === "completed") break
    if (job.status === "failed") throw new Error(`PixelLab vfx job ${jobId} failed upstream${vfxJobFailure(job.last_response)}`)
    if (Date.now() - started > timeout) {
      throw new Error(
        `PixelLab vfx job ${jobId} is still ${job.status} after ${Math.round(timeout / 1000)} s; ` +
          "it keeps running upstream (and bills when delivered), but this command has stopped waiting",
      )
    }
    progress(job.status)
    await sleep(interval)
  }
  const result = parseVfxArtistResult(job.last_response ?? {}, jobId)

  await mkdir(path.dirname(paths.sheet), { recursive: true })
  const written: MakeVfxWithArtistResult["paths"] = { sheet: paths.sheet, provenance: paths.provenance }
  await writeFile(paths.sheet, await client.download(result.sheet.url))
  let atlas: unknown
  if (result.atlas) {
    // The atlas names its sheet by PixelLab's file name; point it at ours.
    atlas = JSON.parse((await client.download(result.atlas.url)).toString("utf8"))
    const meta = (atlas as { meta?: Record<string, unknown> }).meta
    if (meta) meta.image = path.basename(paths.sheet)
    await writeFile(paths.atlas, `${JSON.stringify(atlas, null, 2)}\n`)
    written.atlas = paths.atlas
  }
  for (const [file, target, key] of [
    [result.gif, paths.gif, "gif"],
    [result.gamePack, paths.gamePack, "gamePack"],
    [result.normals, paths.normals, "normals"],
  ] as const) {
    if (!file) continue
    await writeFile(target, await client.download(file.url))
    written[key] = target
  }
  const facts = vfxArtistFrameFacts(result, atlas)

  const usage = job.usage ?? null
  const provenance: VfxArtistProvenance = {
    version: 1,
    provider: "pixellab",
    tool: "vfx",
    artist: opts.artist ?? "lite",
    description: opts.description,
    name: result.name,
    effectId: result.effectId,
    editUrl: result.editUrl,
    message: result.message,
    source: {
      ...(opts.sprite ? { sprite: path.relative(path.dirname(paths.provenance), path.resolve(opts.sprite)).split(path.sep).join("/") } : {}),
      ...(opts.effect ? { changed: opts.effect } : {}),
    },
    ...facts,
    fps: result.fps,
    loop: result.loop,
    anchor: result.anchor,
    parts: result.parts,
    files: Object.fromEntries(
      (["sheet", "gif", "atlas", "gamePack", "normals"] as const)
        .filter((key) => written[key])
        .map((key) => [key, path.basename(written[key]!)]),
    ) as VfxArtistProvenance["files"],
    quotedGenerations: submitted.quoted_generations ?? null,
    usage,
    conversation: result.conversation,
    exportedAt: new Date().toISOString(),
  }
  await writeFile(paths.provenance, `${JSON.stringify(provenance, null, 2)}\n`)
  return {
    jobId,
    effectId: result.effectId,
    editUrl: result.editUrl,
    name: result.name,
    message: result.message,
    ...facts,
    fps: result.fps,
    loop: result.loop,
    anchor: result.anchor,
    quotedGenerations: submitted.quoted_generations ?? null,
    usage,
    paths: written,
  }
}

/** `: <reason>` from a failed job's `last_response`, or nothing when it gives none. */
export function vfxJobFailure(done: Record<string, unknown> | null | undefined): string {
  for (const key of ["error", "detail", "message"]) {
    const value = done?.[key]
    if (typeof value === "string" && value) return `: ${value}`
  }
  return ""
}

/** The `conversation` an earlier `.vfx.json` record kept, when it is the record of `effectId`. */
export async function readVfxConversation(file: string, effectId: string): Promise<string | undefined> {
  if (!existsSync(file)) return undefined
  try {
    const record = JSON.parse(await readFile(file, "utf8")) as { effectId?: unknown; conversation?: unknown }
    return record.effectId === effectId && typeof record.conversation === "string" ? record.conversation : undefined
  } catch {
    return undefined
  }
}
