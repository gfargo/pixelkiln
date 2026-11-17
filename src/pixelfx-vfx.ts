/**
 * pixelfx as a second, fully local source for `pixelkiln vfx`.
 *
 * pixelfx (https://github.com/patch-gg/pixelfx, MIT, Copyright (c) 2026 Patch
 * and Hugo Duprez) is a library of code-drawn pixel-art effects: each effect
 * is a module that draws into a frame, with seeded randomness, so the same
 * options render the same pixels every time. Nothing is generated, sent, or
 * billed.
 *
 * It is not published to the npm registry, so PixelKiln does not depend on
 * it. It is found at run time (`loadPixelfx`) in the project PixelKiln runs
 * in, and a run without it fails with the install line. Everything below the
 * loader takes the library as a value, which is also how the tests run
 * without it.
 *
 * Frames are rendered in process through pixelfx's own frame API
 * (`createFrame`, `createFx`, `composite`) and written with PixelKiln's PNG
 * encoder. The loop that steps an effect and the glow fade at the canvas edge
 * follow `renderFrames` and `edgeFade` in pixelfx's `tools/lib/fxlib.mjs`,
 * which the package does not export. A sheet from here has the same frames
 * as one from its `tools/render.mjs --sheet`, with one difference: that tool
 * multiplies translucent colors by their alpha as it pastes them, and this
 * keeps `composite`'s straight alpha, which is what a PNG holds.
 */
import { existsSync, readFileSync } from "node:fs"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { createRequire } from "node:module"
import path from "node:path"
import { pathToFileURL } from "node:url"
import { PixelKilnError, UsageError } from "./errors.ts"
import { sha256 } from "./hash.ts"
import { encodeRgbaPng } from "./png.ts"
import { vfxOutputPaths } from "./pixellab-vfx.ts"

export const PIXELFX_TOOL = "pixelfx"
export const PIXELFX_REPOSITORY = "https://github.com/patch-gg/pixelfx"
export const PIXELFX_INSTALL = "npm i github:patch-gg/pixelfx"

/** A pixelfx frame: opaque pixels in `color`, additive glow in `light`, both ABGR words. */
export interface PixelfxFrame {
  w: number
  h: number
  ox: number
  oy: number
  color: Uint32Array
  light: Uint32Array
}

export interface PixelfxMeta {
  name?: string
  desc?: string
  tags?: string[]
  /** The effect's canvas, `[width, height]`. */
  size: [number, number]
  /** Where the effect's origin sits on that canvas: the pivot. */
  origin: [number, number]
  duration?: number
  loop?: boolean
  fps?: number
  /** Set on effects drawn around pixelfx's stock character. */
  actor?: number | boolean
  options?: Record<string, unknown>
}

export interface PixelfxModule {
  meta?: PixelfxMeta
  draw?: unknown
  create?: unknown
}

interface PixelfxInstance {
  update(dt: number): void
  draw(frame: PixelfxFrame, layer?: "back" | "front"): void
}

/** The part of pixelfx's core (`pixelfx`) this module calls. */
export interface PixelfxCore {
  createFrame(w: number, h: number, ox?: number, oy?: number): PixelfxFrame
  clearFrame(frame: PixelfxFrame): PixelfxFrame
  createFx(mod: PixelfxModule, options?: Record<string, unknown>): PixelfxInstance
  composite(frame: PixelfxFrame, out: Uint8ClampedArray | Buffer, bg?: null): Uint8ClampedArray | Buffer
}

export interface PixelfxCategory {
  id: string
  name: string
  blurb?: string
}

export interface PixelfxLibrary {
  version: string
  core: PixelfxCore
  /** Every effect by id, `<category>/<name>` (pixelfx's `pixelfx/fx/index`). */
  effects: Record<string, PixelfxModule>
  categories: PixelfxCategory[]
}

function missingPixelfx(cause?: unknown): PixelKilnError {
  return new PixelKilnError(
    "pixelfx is not installed, so there is nothing to render local effects with",
    "capability",
    { hint: `Install it beside your project: ${PIXELFX_INSTALL}  (${PIXELFX_REPOSITORY}, MIT; it is not on the npm registry)`, cause },
  )
}

/** The `version` in the package.json above a resolved pixelfx file. */
function pixelfxVersion(entry: string): string {
  for (let dir = path.dirname(entry); dir !== path.dirname(dir); dir = path.dirname(dir)) {
    const file = path.join(dir, "package.json")
    if (!existsSync(file)) continue
    const pkg = JSON.parse(readFileSync(file, "utf8")) as { name?: unknown; version?: unknown }
    if (pkg.name === "pixelfx") return typeof pkg.version === "string" ? pkg.version : "unknown"
  }
  return "unknown"
}

/**
 * Find and import pixelfx. It is looked for from each of `from` in turn (a
 * directory, or a file in one): by default the working directory, so a
 * project's own install wins, then PixelKiln's install. Throws a
 * `capability` error carrying the install line when it is nowhere.
 */
export async function loadPixelfx(from?: string[]): Promise<PixelfxLibrary> {
  const bases = from?.map((base) => pathToFileURL(path.resolve(base)).href) ?? [
    pathToFileURL(path.join(process.cwd(), "package.json")).href,
    import.meta.url,
  ]
  let resolved: { core: string; index: string } | undefined
  let failure: unknown
  for (const base of bases) {
    try {
      const require = createRequire(base)
      resolved = { core: require.resolve("pixelfx"), index: require.resolve("pixelfx/fx/index") }
      break
    } catch (error) {
      failure = error
    }
  }
  if (!resolved) throw missingPixelfx(failure)
  const core = (await import(pathToFileURL(resolved.core).href)) as Partial<PixelfxCore>
  const index = (await import(pathToFileURL(resolved.index).href)) as {
    effects?: Record<string, PixelfxModule>
    categories?: PixelfxCategory[]
  }
  const version = pixelfxVersion(resolved.core)
  for (const name of ["createFrame", "clearFrame", "createFx", "composite"] as const) {
    if (typeof core[name] !== "function") {
      throw new PixelKilnError(
        `The installed pixelfx (${version}) has no ${name}(); PixelKiln was written against pixelfx 0.3`,
        "capability",
      )
    }
  }
  if (!index.effects || typeof index.effects !== "object") {
    throw new PixelKilnError(`The installed pixelfx (${version}) lists no effects in pixelfx/fx/index`, "capability")
  }
  return { version, core: core as PixelfxCore, effects: index.effects, categories: index.categories ?? [] }
}

export interface PixelfxEffectInfo {
  id: string
  category: string
  name: string
  description: string
  width: number
  height: number
  duration: number
  loop: boolean
  fps: number
  /** Drawn around pixelfx's stock character; `renderPixelfx` refuses these. */
  needsCharacter: boolean
  /** The options the effect declares, with their defaults. */
  options: Record<string, unknown>
}

function describeEffect(id: string, mod: PixelfxModule): PixelfxEffectInfo | null {
  const meta = mod.meta
  if (!meta || !Array.isArray(meta.size) || !Array.isArray(meta.origin)) return null
  return {
    id,
    category: id.split("/")[0]!,
    name: meta.name ?? id,
    description: meta.desc ?? "",
    width: meta.size[0],
    height: meta.size[1],
    duration: meta.duration ?? 1,
    loop: meta.loop ?? false,
    fps: meta.fps ?? 30,
    needsCharacter: Boolean(meta.actor),
    options: meta.options ?? {},
  }
}

/** Every effect the library has, in its own (gallery) order. */
export function listPixelfxEffects(lib: PixelfxLibrary): PixelfxEffectInfo[] {
  return Object.entries(lib.effects).flatMap(([id, mod]) => describeEffect(id, mod) ?? [])
}

/** What `pixelkiln vfx effects` prints: the effects under their categories. */
export function formatPixelfxEffects(lib: PixelfxLibrary): string {
  const effects = listPixelfxEffects(lib)
  const known = lib.categories.map((category) => category.id)
  const ids = [...known, ...new Set(effects.map((effect) => effect.category).filter((id) => !known.includes(id)))]
  const lines = [`pixelfx ${lib.version}: ${effects.length} effects (${PIXELFX_REPOSITORY}, MIT)`]
  for (const id of ids) {
    const inCategory = effects.filter((effect) => effect.category === id)
    if (!inCategory.length) continue
    const category = lib.categories.find((entry) => entry.id === id)
    lines.push("", `${id}${category?.blurb ? `: ${category.blurb}` : ""}`)
    for (const effect of inCategory) {
      const kind = `${effect.loop ? "loop" : "once"} ${Number(effect.duration.toFixed(2))}s`
      const note = effect.needsCharacter ? "  (needs a character: not supported)" : ""
      lines.push(`  ${effect.id.padEnd(32)} ${`${effect.width}x${effect.height}`.padEnd(8)} ${kind}${note}`)
    }
  }
  const skipped = effects.filter((effect) => effect.needsCharacter).length
  if (skipped) lines.push("", `${skipped} effects are drawn around pixelfx's stock character and are not rendered by pixelkiln.`)
  return lines.join("\n")
}

/** What renders: everything `--recipe` needs to produce the same pixels again. */
export interface PixelfxRecipe {
  effect: string
  /** Frames per second; the effect's own when absent. */
  fps?: number
  /** Transparent pixels added on every side of the effect's canvas. */
  margin?: number
  /** Passed to the effect over its defaults: `palette`, `seed`, `flip`, `angle`, `light`, and its own. */
  options?: Record<string, unknown>
}

export interface PixelfxRender {
  effect: PixelfxEffectInfo
  width: number
  height: number
  fps: number
  loop: boolean
  /** The effect's pivot on a frame. */
  anchor: { x: number; y: number }
  /** One RGBA buffer per frame, `width * height * 4` bytes, on transparency. */
  frames: Buffer[]
}

const HEX_COLOR = /^#(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i

function findEffect(lib: PixelfxLibrary, id: string): { mod: PixelfxModule; info: PixelfxEffectInfo } {
  const mod = Object.hasOwn(lib.effects, id) ? lib.effects[id] : undefined
  const info = mod ? describeEffect(id, mod) : null
  if (!mod || !info) {
    const all = Object.keys(lib.effects)
    const category = id.split("/")[0]!
    const near = all.filter((other) => other.startsWith(`${category}/`) || other.endsWith(`/${id.split("/").pop()}`))
    throw new UsageError(
      `pixelfx ${lib.version} has no effect "${id}"` +
        (near.length ? `; close: ${near.slice(0, 12).join(", ")}` : ""),
      { hint: "List them with: pixelkiln vfx effects" },
    )
  }
  if (typeof mod.draw !== "function" && typeof mod.create !== "function") {
    throw new PixelKilnError(`pixelfx effect ${id} exports neither draw nor create`, "capability")
  }
  return { mod, info }
}

/** A recipe checked against the effect it names; throws a usage error on anything the effect cannot take. */
export function checkPixelfxRecipe(lib: PixelfxLibrary, recipe: PixelfxRecipe): PixelfxEffectInfo {
  const { info } = findEffect(lib, recipe.effect)
  if (info.needsCharacter) {
    throw new UsageError(
      `pixelfx effect ${recipe.effect} is drawn around pixelfx's stock character, which pixelkiln does not render; ` +
        "pick an effect that stands on its own",
      { hint: "pixelkiln vfx effects marks the ones that need a character" },
    )
  }
  const { fps, margin, options = {} } = recipe
  if (fps !== undefined && (!Number.isInteger(fps) || fps < 1 || fps > 60)) {
    throw new UsageError(`pixelfx fps must be a whole number 1 to 60, got ${fps}`)
  }
  if (margin !== undefined && (!Number.isInteger(margin) || margin < 0 || margin > 256)) {
    throw new UsageError(`pixelfx margin must be a whole number 0 to 256, got ${margin}`)
  }
  if (options.palette !== undefined) {
    if (!Array.isArray(info.options.palette)) throw new UsageError(`pixelfx effect ${recipe.effect} takes no palette`)
    const palette = options.palette
    if (!Array.isArray(palette) || palette.length < 2 || !palette.every((color) => typeof color === "string" && HEX_COLOR.test(color))) {
      throw new UsageError("a pixelfx palette is a dark-to-bright ramp of at least two hex colors, e.g. #102,#43a,#8cf,#fff")
    }
  }
  if (options.seed !== undefined && (typeof options.seed !== "number" || !Number.isFinite(options.seed))) {
    throw new UsageError(`a pixelfx seed is a number, got ${JSON.stringify(options.seed)}`)
  }
  if (options.actor !== undefined) throw new UsageError("pixelkiln does not pass an actor to pixelfx effects")
  return info
}

/** Full-screen effects (transitions, weather) fill their canvas, so their glow is not faded at the edge. */
const isScreen = (width: number, height: number) => width >= 320 && Math.abs(width / height - 16 / 9) < 0.05

/**
 * Ease the glow out over the last `edge` pixels of the canvas, so light cut
 * off by the frame does not show as a box in a game. Color is left alone.
 * After `edgeFade` in pixelfx's tools/lib/fxlib.mjs (MIT, Copyright (c) 2026 Patch).
 */
function fadeLightAtEdges(frame: PixelfxFrame, edge = 8): void {
  const { w, h, light } = frame
  for (let y = 0; y < h; y++) {
    const fromY = Math.min(y, h - 1 - y)
    for (let x = 0; x < w; x++) {
      const distance = Math.min(fromY, x, w - 1 - x)
      if (distance >= edge) continue
      const index = y * w + x
      const value = light[index]!
      if (!(value & 0xffffff)) continue
      const u = (distance + 0.5) / edge
      const k = u * u * (3 - 2 * u)
      light[index] =
        ((value & 0xff000000) |
          Math.round((value & 255) * k) |
          (Math.round(((value >>> 8) & 255) * k) << 8) |
          (Math.round(((value >>> 16) & 255) * k) << 16)) >>> 0
    }
  }
}

/** Render a recipe's frames in process. Same library version and recipe, same bytes. */
export function renderPixelfx(lib: PixelfxLibrary, recipe: PixelfxRecipe): PixelfxRender {
  const info = checkPixelfxRecipe(lib, recipe)
  const mod = lib.effects[recipe.effect]!
  const meta = mod.meta!
  const margin = recipe.margin ?? 0
  const fps = recipe.fps ?? info.fps
  const width = info.width + margin * 2
  const height = info.height + margin * 2
  const count = Math.max(1, Math.round(info.duration * fps) + (info.loop ? 0 : 1))
  const frame = lib.core.createFrame(width, height, -margin, -margin)
  const instance = lib.core.createFx(mod, { x: meta.origin[0], y: meta.origin[1], ...(recipe.options ?? {}) })
  const fade = margin === 0 && !isScreen(info.width, info.height)
  const frames: Buffer[] = []
  for (let i = 0; i < count; i++) {
    if (i > 0) instance.update(1 / fps)
    lib.core.clearFrame(frame)
    instance.draw(frame)
    if (fade) fadeLightAtEdges(frame)
    // composite() rounds through a clamped array; a Buffer would truncate instead.
    const rgba = new Uint8ClampedArray(width * height * 4)
    lib.core.composite(frame, rgba, null)
    frames.push(Buffer.from(rgba.buffer, rgba.byteOffset, rgba.byteLength))
  }
  return {
    effect: info,
    width,
    height,
    fps,
    loop: info.loop,
    anchor: { x: meta.origin[0] + margin, y: meta.origin[1] + margin },
    frames,
  }
}

/** The frames in a row-major grid, in pixelfx's own near-square layout. */
export function pixelfxSheet(render: Pick<PixelfxRender, "width" | "height" | "frames">): {
  png: Buffer
  columns: number
  rows: number
  rects: Array<{ x: number; y: number; w: number; h: number }>
} {
  const { width, height, frames } = render
  const columns = Math.min(frames.length, Math.max(1, Math.ceil(Math.sqrt((frames.length * height) / width))))
  const rows = Math.ceil(frames.length / columns)
  const sheet = Buffer.alloc(columns * width * rows * height * 4)
  const rects = frames.map((rgba, index) => {
    const x = (index % columns) * width
    const y = Math.floor(index / columns) * height
    for (let row = 0; row < height; row++) {
      rgba.copy(sheet, ((y + row) * columns * width + x) * 4, row * width * 4, (row + 1) * width * 4)
    }
    return { x, y, w: width, h: height }
  })
  return { png: encodeRgbaPng(columns * width, rows * height, sheet), columns, rows, rects }
}

export interface PixelfxProvenance {
  version: 1
  provider: "pixelfx"
  tool: typeof PIXELFX_TOOL
  library: { name: "pixelfx"; version: string; repository: string; license: "MIT" }
  name: string
  effect: string
  width: number
  height: number
  frames: number
  fps: number
  loop: boolean
  anchor: { kind: "origin"; x: number; y: number }
  files: { sheet: string; atlas: string }
  /** Of the spritesheet's bytes; a re-render with the same library version matches it. */
  sheetSha256: string
  exportedAt: string
  /** Feed this file back as `--recipe` to render the effect again. */
  recipe: PixelfxRecipe
}

/**
 * A pixelfx recipe from a file: the `.vfx.json` record `makePixelfxVfx`
 * writes, or a bare recipe (an object with an `effect` id and no PixelLab
 * `layers`). Null when the file is something else, such as a PixelLab recipe.
 */
export async function readPixelfxRecipe(file: string): Promise<{ recipe: PixelfxRecipe; libraryVersion?: string } | null> {
  const parsed = JSON.parse(await readFile(file, "utf8")) as Record<string, unknown>
  const record = parsed.tool === PIXELFX_TOOL
  const raw = (record ? parsed.recipe : parsed) as Record<string, unknown> | undefined
  if (!raw || typeof raw !== "object" || typeof raw.effect !== "string" || Array.isArray(raw.layers)) {
    if (record) throw new Error(`${file} is a pixelfx record with no recipe naming an effect`)
    return null
  }
  if (!record && parsed.tool !== undefined) return null
  const options = raw.options
  if (options !== undefined && (typeof options !== "object" || options === null || Array.isArray(options))) {
    throw new Error(`${file}: a pixelfx recipe's options is an object`)
  }
  const recipe: PixelfxRecipe = {
    effect: raw.effect,
    ...(typeof raw.fps === "number" ? { fps: raw.fps } : {}),
    ...(typeof raw.margin === "number" ? { margin: raw.margin } : {}),
    ...(options ? { options: options as Record<string, unknown> } : {}),
  }
  const version = record ? (parsed.library as { version?: unknown } | undefined)?.version : undefined
  return { recipe, ...(typeof version === "string" ? { libraryVersion: version } : {}) }
}

export interface MakePixelfxVfxOptions extends PixelfxRecipe {
  /** Output base; see `vfxOutputPaths`. `<base>.png`, `.json`, and `.vfx.json` are written. */
  out: string
  /** The name in the atlas and the record; defaults to the effect's own. */
  name?: string
  force?: boolean
}

export interface MakePixelfxVfxResult {
  provider: "pixelfx"
  library: { name: "pixelfx"; version: string }
  effect: string
  name: string
  width: number
  height: number
  frames: number
  fps: number
  loop: boolean
  anchor: { kind: "origin"; x: number; y: number }
  columns: number
  sheetSha256: string
  paths: { sheet: string; atlas: string; provenance: string }
  recipe: PixelfxRecipe
}

/**
 * Render one pixelfx effect and write `<out>.png` (spritesheet), `<out>.json`
 * (an Aseprite-style atlas with the pivot in `meta.anchor`), and
 * `<out>.vfx.json` (the record, whose recipe renders it again). No GIF is
 * written: PixelKiln has no GIF encoder, and PixelLab's GIFs are downloads.
 */
export async function makePixelfxVfx(lib: PixelfxLibrary, opts: MakePixelfxVfxOptions): Promise<MakePixelfxVfxResult> {
  const paths = vfxOutputPaths(opts.out)
  const recipe: PixelfxRecipe = {
    effect: opts.effect,
    ...(opts.fps !== undefined ? { fps: opts.fps } : {}),
    ...(opts.margin ? { margin: opts.margin } : {}),
    ...(opts.options && Object.keys(opts.options).length ? { options: opts.options } : {}),
  }
  checkPixelfxRecipe(lib, recipe)
  if (!opts.force) {
    for (const file of [paths.sheet, paths.atlas, paths.provenance]) {
      if (existsSync(file)) throw new Error(`${file} already exists; pass --force to replace it`)
    }
  }
  const render = renderPixelfx(lib, recipe)
  const sheet = pixelfxSheet(render)
  const name = opts.name ?? render.effect.name
  const clip = path.basename(paths.sheet, ".png")
  const anchor = { kind: "origin" as const, ...render.anchor }
  const size = { w: render.width, h: render.height }
  const atlas = {
    frames: sheet.rects.map((frame, index) => ({
      filename: `${clip} ${index}`,
      frame,
      rotated: false,
      trimmed: false,
      spriteSourceSize: { x: 0, y: 0, ...size },
      sourceSize: size,
      duration: Math.round(1000 / render.fps),
    })),
    meta: {
      app: "pixelkiln",
      version: "1",
      image: path.basename(paths.sheet),
      format: "RGBA8888",
      size: { w: sheet.columns * render.width, h: sheet.rows * render.height },
      scale: "1",
      frameTags: [{ name: clip, from: 0, to: render.frames.length - 1, direction: "forward" }],
      anchor,
      pixelfx: {
        id: opts.effect,
        name,
        version: lib.version,
        fps: render.fps,
        loop: render.loop,
        frames: render.frames.length,
        frameSize: [render.width, render.height],
        pivot: [anchor.x, anchor.y],
        columns: sheet.columns,
      },
    },
  }
  const sheetSha256 = sha256(sheet.png)
  const facts = {
    name,
    effect: opts.effect,
    width: render.width,
    height: render.height,
    frames: render.frames.length,
    fps: render.fps,
    loop: render.loop,
    anchor,
  }
  const provenance: PixelfxProvenance = {
    version: 1,
    provider: "pixelfx",
    tool: PIXELFX_TOOL,
    library: { name: "pixelfx", version: lib.version, repository: PIXELFX_REPOSITORY, license: "MIT" },
    ...facts,
    files: { sheet: path.basename(paths.sheet), atlas: path.basename(paths.atlas) },
    sheetSha256,
    exportedAt: new Date().toISOString(),
    recipe,
  }
  await mkdir(path.dirname(paths.sheet), { recursive: true })
  await writeFile(paths.sheet, sheet.png)
  await writeFile(paths.atlas, `${JSON.stringify(atlas, null, 2)}\n`)
  await writeFile(paths.provenance, `${JSON.stringify(provenance, null, 2)}\n`)
  return {
    provider: "pixelfx",
    library: { name: "pixelfx", version: lib.version },
    ...facts,
    columns: sheet.columns,
    sheetSha256,
    paths: { sheet: paths.sheet, atlas: paths.atlas, provenance: paths.provenance },
    recipe,
  }
}
