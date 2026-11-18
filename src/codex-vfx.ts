/**
 * pixel-vfx-codex as a third local source for `pixelkiln vfx`.
 *
 * pixel-vfx-codex (https://github.com/888wing/pixel-vfx-codex, MIT, by
 * 888wing and contributors) defines 138 effects as pure functions of time in
 * a small software renderer. The same definition renders through a 2D, a
 * 2.5D and an orbiting 3D camera. Nothing is generated, sent, or billed.
 *
 * It is not on the npm registry and is not a package with exports: an engine
 * file and one script per effect that register themselves on a global. So
 * PixelKiln does not depend on it. `loadCodex` finds an install of it (the
 * line in CODEX_INSTALL) and evaluates its files in a separate `vm` context,
 * so its global never reaches this process. A vm context is not a security
 * boundary; the code is as trusted as any package you install.
 *
 * The frame loop follows the library's own `tools/snap.mjs`: the effect's
 * `timing` layer (hit-stop, pacing), `frameTime` for the camera's step rate,
 * and `renderAt` into a transparent buffer with the diorama props off.
 */
import { createHash } from "node:crypto"
import { existsSync, readFileSync, readdirSync } from "node:fs"
import { readFile } from "node:fs/promises"
import { createRequire } from "node:module"
import path from "node:path"
import { pathToFileURL } from "node:url"
import vm from "node:vm"
import { PixelKilnError, UsageError } from "./errors.ts"
import { assertFreshOutputs, writeLocalVfx, type LocalRender } from "./local-vfx.ts"

export const CODEX_ID = "codex"
export const CODEX_PACKAGE = "pixel-vfx-codex"
export const CODEX_REPOSITORY = "https://github.com/888wing/pixel-vfx-codex"
export const CODEX_INSTALL = "npm i github:888wing/pixel-vfx-codex"

export const CODEX_CAMERAS = ["2d", "25d", "3d"] as const
export type CodexCamera = (typeof CODEX_CAMERAS)[number]

/** The canvas each camera renders to, in pixels. */
const CANVAS: Record<CodexCamera, [number, number]> = { "2d": [160, 100], "25d": [240, 150], "3d": [240, 150] }
/** The shared knobs `tune` accepts (the engine's own list, less `guide`, a drawing aid). */
export const CODEX_TUNE_KEYS = ["size", "gain", "density", "dither", "outline", "hitstop", "shake", "flash", "snap"] as const

interface CodexParam {
  en?: string
  min: number
  max: number
  step?: number
  value: number
}
interface CodexDef {
  id: string
  loop: number
  params?: Record<string, CodexParam>
}
interface CodexView {
  mode: string
  night: boolean
  hue: number
  params: Record<string, unknown>
  tune: Record<string, unknown>
  transparent: boolean
  noProps: boolean
  shakeX: number
  shakeY: number
  px: number
  py: number
  pix: Uint32Array
  camera(def: CodexDef): void
  P(x: number, y: number, z: number): boolean
  renderAt(def: CodexDef, t: number, timing: unknown): void
}
interface CodexEngine {
  View: new (canvas: null, width: number, height: number) => CodexView
  MODES: Record<string, { fps: number }>
  timing(def: CodexDef, tune: Record<string, unknown>): { length: number }
  frameTime(t: number, mode: string): number
  get(id: string): CodexDef | undefined
  all(): CodexDef[]
}

export interface CodexCatalogEntry {
  id: string
  en: string
  descEn: string
  category: string
  schools: string[]
}

export interface CodexLibrary {
  /** `version` in the installed package.json. */
  version: string
  /** The first 12 hex digits of the engine's SHA-256: the package's version stays 1.0.0 while its code changes. */
  engineSha256: string
  engine: CodexEngine
  catalogue: CodexCatalogEntry[]
  /** Effect files that failed to load, with the reason. */
  loadErrors: string[]
}

function missingCodex(cause?: unknown): PixelKilnError {
  return new PixelKilnError(
    "pixel-vfx-codex is not installed, so there is nothing to render these effects with",
    "capability",
    { hint: `Install it beside your project: ${CODEX_INSTALL}  (${CODEX_REPOSITORY}, MIT; it is not on the npm registry)`, cause },
  )
}

/** Where the package's files are, found as `loadPixelfx` finds pixelfx: from the working directory, then from PixelKiln's install. */
function findCodexRoot(from?: string[]): string {
  const bases = from?.map((base) => pathToFileURL(path.resolve(base, "package.json")).href) ?? [
    pathToFileURL(path.join(process.cwd(), "package.json")).href,
    import.meta.url,
  ]
  let failure: unknown
  for (const base of bases) {
    try {
      return path.dirname(createRequire(base).resolve(`${CODEX_PACKAGE}/package.json`))
    } catch (error) {
      failure = error
    }
  }
  throw missingCodex(failure)
}

/**
 * Find, read, and evaluate pixel-vfx-codex. Throws a `capability` error with
 * the install line when it is nowhere, or when an install lacks the files and
 * calls this module needs.
 */
export function loadCodex(from?: string[]): CodexLibrary {
  const root = findCodexRoot(from)
  const read = (...parts: string[]) => readFileSync(path.join(root, ...parts), "utf8")
  const pkg = JSON.parse(read("package.json")) as { version?: unknown }
  const version = typeof pkg.version === "string" ? pkg.version : "unknown"
  for (const required of ["engine/pxfx.js", "engine/kit.js", "fx", "data/meta.json"]) {
    if (!existsSync(path.join(root, required))) {
      throw new PixelKilnError(`The installed ${CODEX_PACKAGE} (${version}) has no ${required}; PixelKiln was written against its 1.0.0 layout`, "capability")
    }
  }
  const sources = [read("engine", "pxfx.js"), read("engine", "kit.js")]
  const context = vm.createContext({ console })
  sources.forEach((source, index) => vm.runInContext(source, context, { filename: index ? "engine/kit.js" : "engine/pxfx.js" }))
  const engine = (context as { PXFX?: CodexEngine }).PXFX
  if (!engine || typeof engine.View !== "function" || typeof engine.get !== "function") {
    throw new PixelKilnError(`The installed ${CODEX_PACKAGE} (${version}) does not define PXFX.View and PXFX.get`, "capability")
  }
  const loadErrors: string[] = []
  for (const file of readdirSync(path.join(root, "fx")).filter((name) => name.endsWith(".js")).sort()) {
    try {
      vm.runInContext(read("fx", file), context, { filename: `fx/${file}` })
    } catch (error) {
      loadErrors.push(`${file}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  const meta = JSON.parse(read("data", "meta.json")) as Array<Record<string, unknown>>
  const catalogue = meta.flatMap((entry): CodexCatalogEntry[] =>
    typeof entry.id === "string" && engine.get(entry.id)
      ? [{
          id: entry.id,
          en: typeof entry.en === "string" ? entry.en : entry.id,
          descEn: typeof entry.descEn === "string" ? entry.descEn : "",
          category: typeof entry.category === "string" ? entry.category : "other",
          schools: Array.isArray(entry.schools) ? entry.schools.filter((school): school is string => typeof school === "string") : [],
        }]
      : [],
  )
  if (!catalogue.length) throw new PixelKilnError(`The installed ${CODEX_PACKAGE} (${version}) loaded no effects`, "capability")
  const engineSha256 = createHash("sha256").update(sources.join("\n")).digest("hex").slice(0, 12)
  return { version, engineSha256, engine, catalogue, loadErrors }
}

export interface CodexEffectInfo extends CodexCatalogEntry {
  /** Seconds one cast takes before the timing layer's hit-stop and pacing. */
  loopSeconds: number
  /** The effect's own parameters, with their range and default. */
  params: Record<string, { label: string; min: number; max: number; value: number }>
}

export function listCodexEffects(lib: CodexLibrary): CodexEffectInfo[] {
  return lib.catalogue.map((entry) => {
    const def = lib.engine.get(entry.id)!
    return {
      ...entry,
      loopSeconds: def.loop,
      params: Object.fromEntries(
        Object.entries(def.params ?? {}).map(([key, param]) => [key, { label: param.en ?? key, min: param.min, max: param.max, value: param.value }]),
      ),
    }
  })
}

/** What `pixelkiln vfx effects --lib codex` prints: the effects under their categories. */
export function formatCodexEffects(lib: CodexLibrary): string {
  const effects = listCodexEffects(lib)
  const categories = [...new Set(effects.map((effect) => effect.category))]
  const lines = [`pixel-vfx-codex ${lib.version}: ${effects.length} effects (${CODEX_REPOSITORY}, MIT)`]
  for (const category of categories) {
    const inCategory = effects.filter((effect) => effect.category === category)
    lines.push("", `${category} (${inCategory.length})`)
    for (const effect of inCategory) lines.push(`  ${effect.id.padEnd(28)} ${effect.en}`)
  }
  lines.push("", "--json lists every effect's parameters, with their ranges.")
  return lines.join("\n")
}

/** What renders: everything `--recipe` needs to produce the same pixels again. */
export interface CodexRecipe {
  effect: string
  /** Defaults to 2d. */
  camera?: CodexCamera
  /** Frames per second; the camera's own step rate when absent (2d 12, 2.5d 20, 3d 30). */
  fps?: number
  /** Transparent pixels added on every side of the cropped effect. */
  margin?: number
  /** Degrees to turn the effect's colors around the color wheel. */
  hue?: number
  /** The effect's parameters, by name (`vfx effects --json` lists them). */
  params?: Record<string, number>
  /** The shared knobs: size, gain, density, dither, outline, hitstop, shake, flash, snap. */
  tune?: Record<string, number>
}

export interface CodexRender extends LocalRender {
  effect: CodexEffectInfo
}

function findDef(lib: CodexLibrary, id: string): { def: CodexDef; info: CodexEffectInfo } {
  const info = listCodexEffects(lib).find((entry) => entry.id === id)
  if (!info) {
    const near = lib.catalogue.map((entry) => entry.id).filter((other) => other.includes(id) || id.includes(other))
    throw new UsageError(
      `pixel-vfx-codex ${lib.version} has no effect "${id}"` + (near.length ? `; close: ${near.slice(0, 10).join(", ")}` : ""),
      { hint: "List them with: pixelkiln vfx effects --lib codex" },
    )
  }
  return { def: lib.engine.get(id)!, info }
}

/** A recipe checked against the effect it names; throws a usage error on anything the effect cannot take. */
export function checkCodexRecipe(lib: CodexLibrary, recipe: CodexRecipe): CodexEffectInfo {
  const { info } = findDef(lib, recipe.effect)
  const { camera, fps, margin, hue, params = {}, tune = {} } = recipe
  if (camera !== undefined && !(CODEX_CAMERAS as readonly string[]).includes(camera)) {
    throw new UsageError(`--camera must be ${CODEX_CAMERAS.join(", ")}, got "${camera}"`)
  }
  if (fps !== undefined && (!Number.isInteger(fps) || fps < 1 || fps > 60)) throw new UsageError(`codex fps must be a whole number 1 to 60, got ${fps}`)
  if (margin !== undefined && (!Number.isInteger(margin) || margin < 0 || margin > 64)) {
    throw new UsageError(`codex margin must be a whole number 0 to 64, got ${margin}`)
  }
  if (hue !== undefined && (typeof hue !== "number" || !Number.isFinite(hue) || hue < -360 || hue > 360)) {
    throw new UsageError(`codex hue is degrees from -360 to 360, got ${JSON.stringify(hue)}`)
  }
  for (const [key, value] of Object.entries(params)) {
    const param = info.params[key]
    if (!param) {
      const known = Object.keys(info.params)
      throw new UsageError(`${recipe.effect} has no parameter "${key}"${known.length ? `; it has ${known.join(", ")}` : " (it takes none)"}`)
    }
    if (typeof value !== "number" || !Number.isFinite(value) || value < param.min || value > param.max) {
      throw new UsageError(`${recipe.effect} ${key} is a number from ${param.min} to ${param.max}, got ${JSON.stringify(value)}`)
    }
  }
  for (const [key, value] of Object.entries(tune)) {
    if (!(CODEX_TUNE_KEYS as readonly string[]).includes(key)) throw new UsageError(`unknown tune knob "${key}"; they are ${CODEX_TUNE_KEYS.join(", ")}`)
    if (typeof value !== "number" || !Number.isFinite(value)) throw new UsageError(`tune ${key} is a number, got ${JSON.stringify(value)}`)
  }
  return info
}

/** Crop every frame to the box that holds all of them and the pivot, plus `margin` on each side. */
function cropFrames(frames: Buffer[], width: number, height: number, pivot: { x: number; y: number }, margin: number) {
  let x0 = Math.floor(pivot.x), x1 = Math.floor(pivot.x), y0 = Math.floor(pivot.y), y1 = Math.floor(pivot.y)
  x0 = Math.max(0, Math.min(x0, width - 1)); x1 = Math.max(0, Math.min(x1, width - 1))
  y0 = Math.max(0, Math.min(y0, height - 1)); y1 = Math.max(0, Math.min(y1, height - 1))
  for (const frame of frames) {
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        if (frame[(y * width + x) * 4 + 3]) {
          if (x < x0) x0 = x
          if (x > x1) x1 = x
          if (y < y0) y0 = y
          if (y > y1) y1 = y
        }
      }
    }
  }
  const cropWidth = x1 - x0 + 1 + margin * 2
  const cropHeight = y1 - y0 + 1 + margin * 2
  const cropped = frames.map((frame) => {
    const out = Buffer.alloc(cropWidth * cropHeight * 4)
    for (let y = 0; y < cropHeight; y++) {
      const sy = y0 - margin + y
      if (sy < 0 || sy >= height) continue
      for (let x = 0; x < cropWidth; x++) {
        const sx = x0 - margin + x
        if (sx < 0 || sx >= width) continue
        frame.copy(out, (y * cropWidth + x) * 4, (sy * width + sx) * 4, (sy * width + sx) * 4 + 4)
      }
    }
    return out
  })
  return { width: cropWidth, height: cropHeight, frames: cropped, anchor: { x: pivot.x - x0 + margin, y: pivot.y - y0 + margin } }
}

/** What a recipe will render, without rendering it: the camera, step rate, and frame count. */
export function planCodex(lib: CodexLibrary, recipe: CodexRecipe): { camera: CodexCamera; fps: number; frames: number; seconds: number } {
  checkCodexRecipe(lib, recipe)
  const camera = recipe.camera ?? "2d"
  const fps = recipe.fps ?? lib.engine.MODES[camera]?.fps ?? 12
  const seconds = lib.engine.timing(lib.engine.get(recipe.effect)!, { ...(recipe.tune ?? {}) }).length
  return { camera, fps, frames: Math.max(1, Math.round(seconds * fps)), seconds }
}

/** Render a recipe's frames in process. Same package files and recipe, same bytes. */
export function renderCodex(lib: CodexLibrary, recipe: CodexRecipe): CodexRender {
  const info = checkCodexRecipe(lib, recipe)
  const def = lib.engine.get(recipe.effect)!
  const camera = recipe.camera ?? "2d"
  const [canvasWidth, canvasHeight] = CANVAS[camera]
  const fps = recipe.fps ?? lib.engine.MODES[camera]?.fps ?? 12
  const view = new lib.engine.View(null, canvasWidth, canvasHeight)
  view.mode = camera
  view.night = false
  view.hue = recipe.hue ?? 0
  view.params = { ...(recipe.params ?? {}) }
  view.tune = { ...(recipe.tune ?? {}) }
  view.transparent = true
  view.noProps = true
  // The pivot is the world origin, where the effect is authored around, found with no screen shake applied.
  view.shakeX = 0
  view.shakeY = 0
  view.camera(def)
  view.P(0, 0, 0)
  const pivot = { x: Math.round(view.px), y: Math.round(view.py) }
  const timing = lib.engine.timing(def, view.tune)
  const count = Math.max(1, Math.round(timing.length * fps))
  const frames: Buffer[] = []
  for (let index = 0; index < count; index++) {
    view.renderAt(def, lib.engine.frameTime((index / count) * timing.length, camera), timing)
    frames.push(Buffer.from(view.pix.buffer.slice(0)))
  }
  const cropped = cropFrames(frames, canvasWidth, canvasHeight, pivot, recipe.margin ?? 0)
  // Every effect is one cast that ends where it began, so it loops.
  return { effect: info, fps, loop: true, ...cropped }
}

export interface CodexProvenance {
  version: 1
  provider: typeof CODEX_ID
  tool: typeof CODEX_ID
  library: { name: typeof CODEX_PACKAGE; version: string; engineSha256: string; repository: string; license: "MIT" }
  name: string
  effect: string
  width: number
  height: number
  frames: number
  fps: number
  loop: boolean
  anchor: { kind: "origin"; x: number; y: number }
  files: { sheet: string; atlas: string }
  sheetSha256: string
  exportedAt: string
  /** Feed this file back as `--recipe` to render the effect again. */
  recipe: CodexRecipe
}

/**
 * A codex recipe from a file: the `.vfx.json` record `makeCodexVfx` writes,
 * or, with `bare`, a plain recipe object with an `effect` id. Null when the
 * file is something else (a record from another source, or a PixelLab recipe).
 */
export async function readCodexRecipe(
  file: string,
  opts: { bare?: boolean } = {},
): Promise<{ recipe: CodexRecipe; libraryVersion?: string; engineSha256?: string } | null> {
  const parsed = JSON.parse(await readFile(file, "utf8")) as Record<string, unknown>
  const record = parsed.tool === CODEX_ID
  if (!record && !(opts.bare && parsed.tool === undefined)) return null
  const raw = (record ? parsed.recipe : parsed) as Record<string, unknown> | undefined
  if (!raw || typeof raw !== "object" || typeof raw.effect !== "string" || Array.isArray(raw.layers)) {
    if (record) throw new Error(`${file} is a codex record with no recipe naming an effect`)
    return null
  }
  const recipe: CodexRecipe = { effect: raw.effect }
  if (raw.camera !== undefined) recipe.camera = raw.camera as CodexCamera
  for (const key of ["fps", "margin", "hue"] as const) if (raw[key] !== undefined) recipe[key] = raw[key] as number
  for (const key of ["params", "tune"] as const) {
    const value = raw[key]
    if (value === undefined) continue
    if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error(`${file}: a codex recipe's ${key} is an object`)
    recipe[key] = value as Record<string, number>
  }
  const library = record ? (parsed.library as { version?: unknown; engineSha256?: unknown } | undefined) : undefined
  return {
    recipe,
    ...(typeof library?.version === "string" ? { libraryVersion: library.version } : {}),
    ...(typeof library?.engineSha256 === "string" ? { engineSha256: library.engineSha256 } : {}),
  }
}

export interface MakeCodexVfxOptions extends CodexRecipe {
  /** Output base; see `vfxOutputPaths`. `<base>.png`, `.json`, and `.vfx.json` are written. */
  out: string
  /** The name in the atlas and the record; defaults to the effect's own. */
  name?: string
  force?: boolean
}

export interface MakeCodexVfxResult {
  provider: typeof CODEX_ID
  library: { name: typeof CODEX_PACKAGE; version: string; engineSha256: string }
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
  recipe: CodexRecipe
}

/**
 * Render one codex effect and write `<out>.png` (spritesheet), `<out>.json`
 * (an Aseprite-style atlas with the pivot in `meta.anchor`), and
 * `<out>.vfx.json` (the record, whose recipe renders it again).
 */
export async function makeCodexVfx(lib: CodexLibrary, opts: MakeCodexVfxOptions): Promise<MakeCodexVfxResult> {
  const recipe: CodexRecipe = {
    effect: opts.effect,
    ...(opts.camera && opts.camera !== "2d" ? { camera: opts.camera } : {}),
    ...(opts.fps !== undefined ? { fps: opts.fps } : {}),
    ...(opts.margin ? { margin: opts.margin } : {}),
    ...(opts.hue ? { hue: opts.hue } : {}),
    ...(opts.params && Object.keys(opts.params).length ? { params: opts.params } : {}),
    ...(opts.tune && Object.keys(opts.tune).length ? { tune: opts.tune } : {}),
  }
  checkCodexRecipe(lib, recipe)
  const paths = assertFreshOutputs(opts.out, opts.force)
  const render = renderCodex(lib, recipe)
  const library = { name: CODEX_PACKAGE as typeof CODEX_PACKAGE, version: lib.version, engineSha256: lib.engineSha256 }
  const written = await writeLocalVfx({
    paths,
    name: opts.name ?? render.effect.en,
    effect: opts.effect,
    render,
    atlasKey: CODEX_ID,
    atlasFacts: { version: lib.version, engineSha256: lib.engineSha256, camera: recipe.camera ?? "2d" },
    record: { provider: CODEX_ID, tool: CODEX_ID, library: { ...library, repository: CODEX_REPOSITORY, license: "MIT" } },
    recipe,
  })
  return {
    provider: CODEX_ID,
    library,
    ...written.facts,
    columns: written.columns,
    sheetSha256: written.sheetSha256,
    paths: written.paths,
    recipe,
  }
}
