/** Argument parsing. Strict on purpose: an unknown flag is an error, never a silently dropped filter. */
import path from "node:path"
import { UsageError } from "../errors.ts"
import type { GridConfidence } from "../types.ts"
import type { SheetFormat } from "../pipeline/sheet-formats.ts"
import type { TilesetFormat } from "../pipeline/tileset-export.ts"


export interface Args {
  command: string
  manifest: string
  lock: string
  styles: string[]
  assets: string[]
  force: boolean
  yes: boolean
  budget?: number
  /** Repeatable provider-keyed budgets used by a mixed-provider run. */
  providerBudgets: Record<string, number>
  dryRun: boolean
  all: boolean
  json: boolean
  check: boolean
  noOpen: boolean
  tag: boolean
  /** gallery: allow the page to edit manifest intent (prompts, sizes, tags, new assets). */
  edit: boolean
  /** gallery: do not offer the in-browser editor even with --edit. */
  noEditor: boolean
  /** plan/hash: fail on any invalid manifest entry instead of listing it and carrying on. */
  strict: boolean
  /** adopt: record local files as lock entries offline, with no provider key. */
  local: boolean
  /** adopt --local: where the art came from (mcp, hand, a tool name). */
  source?: string
  /** adopt --local: the tool call that made the art. */
  tool?: string
  /** adopt --local: the prompt it was rolled with. */
  importPrompt?: string
  seed?: number
  /** adopt --local: credits spent making it, in the asset's cost unit. */
  importCost?: number
  /** adopt --local: what was done after generation, in order; free text. */
  steps: string[]
  /** adopt --local: the unprocessed original PNG. */
  raw?: string
  /** adopt --local: the provider object id of the one asset being imported. */
  objectId?: string
  /** fetch: re-download downloaded outputs and replace files whose object changed upstream. */
  refresh: boolean
  from?: string
  out?: string
  generator?: string
  exclude: string[]
  name?: string
  writePrompts: boolean
  columns?: number
  port?: number
  inputs?: string
  claims: string[]
  /** `export`: generic, tiled, or godot. `pack` and `mount`: generic, aseprite, or godot. */
  format?: TilesetFormat | SheetFormat
  outputRoles: string[]
  primaryOnly: boolean
  prune: boolean
  maxDistance?: number
  minTransparency?: number
  maxColors?: number
  sigma?: number
  palette: string[]
  fixerPython?: string
  fixerRevision?: string
  minGridConfidence?: GridConfidence
  reviewer?: string
  note?: string
  /** ComfyUI `models` directory used for offline recipe model verification. */
  modelRoot?: string
  /** restore: a previous generation to bring back, 1-based newest first, or an output hash prefix. */
  generation?: string
  /** Subcommand for `quality`, `recipe`, `refine`, or `workspace`. */
  subcommand?: string
  /** Path to a workspace catalog. Defaults to `pixelkiln.workspace.json` in cwd. */
  workspace?: string
  /** Positional target for recipe and workspace subcommands. */
  target?: string
  /** Account provider selector; also the `workspace add` catalog provider hint. */
  provider?: string
  /** `workspace add`: free-form account label, e.g. distinguishing sandboxes. */
  account?: string
  /**
   * Raw `--lock` value with no manifest-relative default applied. `workspace
   * add` needs to know whether the user actually passed `--lock`, since the
   * ambient default (beside `--manifest`, which usually names an unrelated
   * project) is meaningless for the manifest being registered.
   */
  explicitLock?: string
  /** unzoom: 0 auto-detects a palette, -1 keeps every color, 2-256 quantizes to that many. */
  quantize?: number
  /** font and pixelate: the style description sent to PixelLab; vfx: the effect for the paid VFX artist. */
  description?: string
  /** vfx: lite or pro, the VFX artist that draws a --description. */
  artist?: string
  /** font: Bold or Regular. */
  weight?: string
  /** font: native glyph size, 8/16/32/64. */
  glyphPx?: number
  /** estimate-skeleton: frames to scaffold after the estimated pose, 3-15. normal-map: equal frames in the --from strip, 1-32. */
  frames?: number
  /** normal-map: opengl (green up) or directx (green down). */
  convention?: string
  /** gallery: skeleton estimates the session may make. */
  estimateLimit?: number
  /** vfx: a PixelLab VFX preset to start from. */
  preset?: string
  /** vfx: a recipe file (a bare recipe or a `.vfx.json` record) to render. */
  recipe?: string
  /** vfx: a saved My effects id to start from and export over. */
  effect?: string
  /** vfx: parts to add, in order. */
  parts: string[]
  /** vfx: the sprite the effect is built around (a file, URL, or PixelLab reference). */
  sprite?: string
  /** vfx: frames per second. */
  fps?: number
  /** vfx: also export the game-pack ZIP. */
  gamePack: boolean
  /** normal-map: lite (default) or pro. */
  mode?: string
  /** normal-map: how far every pixel tilts away from the viewer. */
  strength?: number
  /** normal-map: how much the outline rounds off, 0-3. */
  outlineRounding?: number
  /** normal-map: how much the sprite's 3D parts add, 0-2. */
  partShapes?: number
  /** normal-map: the art's light and dark as bumps, 0-2. */
  surfaceDetail?: number
  /** normal-map: how far that detail is blurred, 0.6-3 px. */
  detailSoftness?: number
  /** asset: object (default) or character. */
  kind?: string
  /** asset canvas: the new canvas, "<width>x<height>". */
  size?: string
  /** asset mirror/export: an animation group id. */
  animation?: string
  /** asset mirror: the direction to flip. asset expand: the way the object faces now. asset export gif: the direction. */
  direction?: string
  /** asset expand: keep a reviewed expansion. */
  keep: boolean
  /** asset expand: discard a pending expansion. */
  discard: boolean
  /** pixelate: use the Pro converter. */
  pro: boolean
  /** ui/asset: the PixelLab asset to work on (a template, element or state). */
  id?: string
  /** ui states: one "name=description" per state. */
  uiStates: string[]
  /** ui states: limit a template to these element ids. */
  elements: string[]
  /** ui nine-slice: one number, or "left,right,top,bottom". */
  insets?: string
  /** ui nine-slice: remove the insets. */
  clear: boolean
  /** ui split: custom crop boxes, "label:x,y,width,height". */
  boxes: string[]
  /** music: tempo, 60-180. */
  bpm?: number
  /** music: length to aim for, 10-360. sfx: clip length, 0.5-30. */
  seconds?: number
  /** music: a file of lyrics to sing (makes it a song with vocals). */
  lyrics?: string
  /** music: have the lyrics written for the song. */
  autoLyrics: boolean
  /** music: with --auto-lyrics, what the song is about. `music lyrics`: the topic. */
  about?: string
  /** music: the singing voice, e.g. "warm female voice". */
  voice?: string
  /** music: how closely to follow the style, 0-1. */
  styleWeight?: number
  /** music: also make seamless loops of take 1. */
  loop: boolean
  /** music: loop this finished song instead of making a new one. */
  loopOf?: string
  /** music: make this song again in the new style. */
  restyle?: string
  /** music: expand a short idea into a full style first. */
  improve: boolean
}

const VALUE_FLAGS = [
  "--manifest", "--lock", "--style", "--only", "--budget", "--port",
  "--from", "--out", "--generator", "--exclude", "--name", "--claims", "--columns", "--inputs", "--format",
  "--output-role", "--max-distance", "--min-transparency", "--max-colors", "--sigma", "--workspace",
  "--provider", "--account", "--palette", "--fixer-python", "--fixer-revision", "--min-grid-confidence",
  "--reviewer", "--note", "--source", "--object-id", "--tool", "--prompt", "--seed", "--cost", "--step", "--raw",
  "--model-root", "--generation",
  "--quantize", "--description", "--weight", "--glyph-px", "--frames", "--estimate-limit",
  "--preset", "--recipe", "--effect", "--part", "--sprite", "--fps", "--artist", "--convention",
  "--id", "--state", "--element", "--insets", "--box", "--kind", "--size", "--animation", "--direction",
  "--outline-rounding", "--part-shapes", "--surface-detail", "--detail-softness", "--mode", "--strength",
  "--bpm", "--seconds", "--lyrics", "--about", "--voice", "--style-weight", "--loop-of", "--restyle",
] as const
const BOOL_FLAGS = [
  "--force", "--yes", "-y", "--dry-run", "--all", "--json", "--check", "--no-open", "--tag", "--write-prompts", "--primary-only", "--prune",
  "--edit", "--refresh", "--no-editor", "--game-pack", "--local", "--strict", "--auto-lyrics", "--loop", "--improve", "--clear", "--keep", "--discard", "--pro",
] as const

export const COMMANDS = [
  "init", "plan", "hash", "doctor", "gen", "submit", "poll", "pick", "fetch", "restore", "adopt", "accept",
  "salvage", "purge", "prune", "audit", "cache", "pack", "mount", "export", "tag", "balance", "status",
  "gallery", "edit", "tools", "history", "quality", "refine", "recipe", "workspace", "estimate-skeleton",
  "skeleton-preview", "unzoom", "pixelate", "normal-map", "vfx", "font", "music", "sfx", "ui", "asset", "help", "--help", "-h", "--version", "-v",
] as const

const WORKSPACE_SUBCOMMANDS = ["add", "remove", "list", "status", "claims"] as const
const REFINE_SUBCOMMANDS = ["run", "approve", "check"] as const
const RECIPE_SUBCOMMANDS = ["list", "inspect", "install", "verify"] as const
const QUALITY_SUBCOMMANDS = ["snapshot", "check"] as const
const EDIT_SUBCOMMANDS = ["start", "detach"] as const
const TOOLS_SUBCOMMANDS = ["status", "install"] as const
const TOOLS = ["editor"] as const
const VFX_SUBCOMMANDS = ["make", "presets", "parts"] as const
const MUSIC_SUBCOMMANDS = ["make", "style", "lyrics"] as const
const ASSET_SUBCOMMANDS = ["canvas", "mirror", "import", "expand", "review", "export"] as const
const UI_SUBCOMMANDS = ["show", "split", "states", "nine-slice", "pull"] as const

/**
 * Strict parsing. Unknown flags are a hard error rather than being ignored,
 * because a silently-dropped filter is expensive here: `--styles neon` (plural,
 * a typo) would otherwise fall through to "no filter" and generate the entire
 * manifest instead of one style.
 */
export function parseArgs(argv: string[]): Args {
  const [command = "help"] = argv
  if (!(COMMANDS as readonly string[]).includes(command)) {
    throw new UsageError(`Unknown command "${command}". Run \`pixelkiln help\` for the list.`)
  }

  let rest = argv.slice(1)
  let subcommand: string | undefined
  let target: string | undefined
  if (command === "quality") {
    subcommand = rest[0]
    if (subcommand === undefined || subcommand.startsWith("-")) {
      throw new UsageError(`quality needs a subcommand: ${QUALITY_SUBCOMMANDS.join(", ")}`)
    }
    if (!(QUALITY_SUBCOMMANDS as readonly string[]).includes(subcommand)) {
      throw new UsageError(
        `Unknown quality subcommand "${subcommand}". Known: ${QUALITY_SUBCOMMANDS.join(", ")}`,
      )
    }
    rest = rest.slice(1)
  } else if (command === "recipe") {
    subcommand = rest[0]
    if (subcommand === undefined || subcommand.startsWith("-")) {
      throw new UsageError(`recipe needs a subcommand: ${RECIPE_SUBCOMMANDS.join(", ")}`)
    }
    if (!(RECIPE_SUBCOMMANDS as readonly string[]).includes(subcommand)) {
      throw new UsageError(
        `Unknown recipe subcommand "${subcommand}". Known: ${RECIPE_SUBCOMMANDS.join(", ")}`,
      )
    }
    rest = rest.slice(1)
    if (subcommand !== "list") {
      target = rest[0]
      if (target === undefined || target.startsWith("-")) {
        throw new UsageError(`recipe ${subcommand} needs a recipe id, selector, or path.`)
      }
      rest = rest.slice(1)
    }
  } else if (command === "workspace") {
    subcommand = rest[0]
    if (subcommand === undefined || subcommand.startsWith("-")) {
      throw new UsageError(`workspace needs a subcommand: ${WORKSPACE_SUBCOMMANDS.join(", ")}`)
    }
    if (!(WORKSPACE_SUBCOMMANDS as readonly string[]).includes(subcommand)) {
      throw new UsageError(
        `Unknown workspace subcommand "${subcommand}". Known: ${WORKSPACE_SUBCOMMANDS.join(", ")}`,
      )
    }
    rest = rest.slice(1)
    if (subcommand === "add" || subcommand === "remove") {
      target = rest[0]
      if (target === undefined || target.startsWith("-")) {
        throw new UsageError(
          subcommand === "add"
            ? "workspace add needs a manifest path."
            : "workspace remove needs a project id or manifest path.",
        )
      }
      rest = rest.slice(1)
    }
  } else if (command === "edit") {
    subcommand = rest[0]?.startsWith("-") || rest[0] === undefined ? "start" : rest[0]
    if (!(EDIT_SUBCOMMANDS as readonly string[]).includes(subcommand)) {
      throw new UsageError(`Unknown edit subcommand "${subcommand}". Known: ${EDIT_SUBCOMMANDS.join(", ")}`)
    }
    if (rest[0] === subcommand) rest = rest.slice(1)
  } else if (command === "tools") {
    subcommand = rest[0]?.startsWith("-") || rest[0] === undefined ? "status" : rest[0]
    if (!(TOOLS_SUBCOMMANDS as readonly string[]).includes(subcommand)) {
      throw new UsageError(`Unknown tools subcommand "${subcommand}". Known: ${TOOLS_SUBCOMMANDS.join(", ")}`)
    }
    if (rest[0] === subcommand) rest = rest.slice(1)
    target = rest[0]?.startsWith("-") ? undefined : rest[0]
    if (subcommand === "install" && target === undefined) {
      throw new UsageError(`tools install needs a tool name: ${TOOLS.join(", ")}`)
    }
    if (target !== undefined) {
      if (!(TOOLS as readonly string[]).includes(target)) {
        throw new UsageError(`Unknown tool "${target}". Known: ${TOOLS.join(", ")}`)
      }
      rest = rest.slice(1)
    }
  } else if (command === "estimate-skeleton") {
    target = rest[0]?.startsWith("-") ? undefined : rest[0]
    if (target === undefined) throw new UsageError("estimate-skeleton needs an image path")
    rest = rest.slice(1)
  } else if (command === "skeleton-preview") {
    target = rest[0]?.startsWith("-") ? undefined : rest[0]
    if (target === undefined) {
      throw new UsageError("skeleton-preview needs a keypoints file or an animate-skeleton asset id")
    }
    rest = rest.slice(1)
  } else if (command === "vfx") {
    subcommand = rest[0]?.startsWith("-") || rest[0] === undefined ? "make" : rest[0]
    if (!(VFX_SUBCOMMANDS as readonly string[]).includes(subcommand)) {
      throw new UsageError(`Unknown vfx subcommand "${subcommand}". Known: ${VFX_SUBCOMMANDS.join(", ")}`)
    }
    if (rest[0] === subcommand) rest = rest.slice(1)
  } else if (command === "asset") {
    subcommand = rest[0]
    if (subcommand === undefined || subcommand.startsWith("-")) {
      throw new UsageError(`asset needs a subcommand: ${ASSET_SUBCOMMANDS.join(", ")}`)
    }
    if (!(ASSET_SUBCOMMANDS as readonly string[]).includes(subcommand)) {
      throw new UsageError(`Unknown asset subcommand "${subcommand}". Known: ${ASSET_SUBCOMMANDS.join(", ")}`)
    }
    rest = rest.slice(1)
  } else if (command === "ui") {
    subcommand = rest[0]
    if (subcommand === undefined || subcommand.startsWith("-")) {
      throw new UsageError(`ui needs a subcommand: ${UI_SUBCOMMANDS.join(", ")}`)
    }
    if (!(UI_SUBCOMMANDS as readonly string[]).includes(subcommand)) {
      throw new UsageError(`Unknown ui subcommand "${subcommand}". Known: ${UI_SUBCOMMANDS.join(", ")}`)
    }
    rest = rest.slice(1)
  } else if (command === "music") {
    subcommand = rest[0]?.startsWith("-") || rest[0] === undefined ? "make" : rest[0]
    if (!(MUSIC_SUBCOMMANDS as readonly string[]).includes(subcommand)) {
      throw new UsageError(`Unknown music subcommand "${subcommand}". Known: ${MUSIC_SUBCOMMANDS.join(", ")}`)
    }
    if (rest[0] === subcommand) rest = rest.slice(1)
  } else if (command === "refine") {
    subcommand = rest[0]?.startsWith("-") || rest[0] === undefined ? "run" : rest[0]
    if (!(REFINE_SUBCOMMANDS as readonly string[]).includes(subcommand)) {
      throw new UsageError(
        `Unknown refine subcommand "${subcommand}". Known: ${REFINE_SUBCOMMANDS.join(", ")}`,
      )
    }
    if (rest[0] === subcommand) rest = rest.slice(1)
  }

  for (let i = 0; i < rest.length; i++) {
    const token = rest[i]!
    if (!token.startsWith("-")) {
      throw new UsageError(`Unexpected argument "${token}". Options must be passed with a named flag.`)
    }
    if ((BOOL_FLAGS as readonly string[]).includes(token)) continue
    if ((VALUE_FLAGS as readonly string[]).includes(token)) {
      const value = rest[i + 1]
      // A numeric token is a value even though it starts with "-", so
      // `--budget -5` reaches the range check and reports the real problem.
      const looksLikeFlag = value !== undefined && value.startsWith("-") && !Number.isFinite(Number(value))
      if (value === undefined || looksLikeFlag) {
        throw new UsageError(`${token} needs a value.`)
      }
      i++
      continue
    }
    throw new UsageError(
      `Unknown flag "${token}". Known flags: ${[...VALUE_FLAGS, ...BOOL_FLAGS].join(", ")}`,
    )
  }

  const get = (flag: string) => {
    const i = rest.indexOf(flag)
    return i >= 0 ? rest[i + 1] : undefined
  }
  /**
   * Collects every occurrence of a list flag, not just the first.
   *
   * `--style a --style b` is the natural way to write this and previously kept
   * only `a`, silently discarding `b`, so a run that looked like it covered
   * two styles covered one, and `plan` quoted a cost for work it would not do.
   * Repeated flags now accumulate; commas still work within each occurrence.
   */
  const list = (flag: string) => {
    const out: string[] = []
    for (let i = 0; i < rest.length; i++) {
      if (rest[i] !== flag) continue
      for (const part of (rest[i + 1] ?? "").split(",")) {
        const v = part.trim()
        if (v) out.push(v)
      }
    }
    return [...new Set(out)]
  }

  const rawColumns = get("--columns")
  let columns: number | undefined
  if (rawColumns !== undefined) {
    columns = Number(rawColumns)
    // Same guard as --budget: NaN would silently fall through to the default
    // and quietly produce a differently-shaped sheet than asked for.
    if (!Number.isInteger(columns) || columns < 1 || columns > 1024) {
      throw new UsageError(`--columns must be a whole number between 1 and 1024, got "${rawColumns}"`)
    }
  }

  const rawPort = get("--port")
  let port: number | undefined
  if (rawPort !== undefined) {
    port = Number(rawPort)
    if (!Number.isInteger(port) || port < 1 || port > 65_535) {
      throw new UsageError(`--port must be a whole number between 1 and 65535, got "${rawPort}"`)
    }
  }

  let budget: number | undefined
  // A registry id is intentionally only constrained to non-empty text. Use a
  // null-prototype dictionary so ids such as "constructor" cannot interact
  // with Object.prototype while budgets are parsed.
  const providerBudgets: Record<string, number> = Object.create(null)
  const rawBudgets = rest.flatMap((token, index) => token === "--budget" ? [rest[index + 1]!] : [])
  for (const rawBudget of rawBudgets) {
    const separator = rawBudget.indexOf("=")
    if (separator >= 0) {
      const providerId = rawBudget.slice(0, separator).trim()
      const rawAmount = rawBudget.slice(separator + 1).trim()
      const amount = Number(rawAmount)
      if (!providerId || /[=\s]/.test(providerId) || !Number.isFinite(amount) || amount < 0) {
        throw new UsageError(
          `--budget must be a non-negative number or provider=number, got "${rawBudget}".`,
        )
      }
      if (Object.hasOwn(providerBudgets, providerId)) {
        throw new UsageError(`--budget repeats provider "${providerId}".`)
      }
      providerBudgets[providerId] = amount
      continue
    }
    const amount = Number(rawBudget)
    if (!Number.isFinite(amount) || amount < 0) {
      throw new UsageError(`--budget must be a non-negative number, got "${rawBudget}".`)
    }
    if (budget !== undefined) throw new UsageError("Only one unkeyed --budget may be passed.")
    budget = amount
  }
  if (budget !== undefined && Object.keys(providerBudgets).length) {
    throw new UsageError("Do not mix an unkeyed --budget with provider-keyed budgets.")
  }

  const manifest = get("--manifest") ?? "pixelkiln.manifest.json"
  // Tilesets take generic, tiled, or godot; sheets take generic, aseprite,
  // or godot. Each command checks its own set once it knows what it is.
  const rawFormat = get("--format")
  const formats = command === "export" ? ["generic", "tiled", "godot"]
    : command === "asset" ? ["zip", "spritesheet", "aseprite", "gif"]
    : ["generic", "aseprite", "godot"]
  if (rawFormat && !formats.includes(rawFormat)) {
    throw new UsageError(`--format must be ${formats.slice(0, -1).join(", ")}, or ${formats.at(-1)}, got "${rawFormat}"`)
  }
  const numberOption = (
    flag: string,
    opts: { min: number; max?: number; integer?: boolean },
  ): number | undefined => {
    const raw = get(flag)
    if (raw === undefined) return undefined
    const value = Number(raw)
    if (
      !Number.isFinite(value) ||
      value < opts.min ||
      (opts.max !== undefined && value > opts.max) ||
      (opts.integer && !Number.isInteger(value))
    ) {
      const range = opts.max === undefined ? `at least ${opts.min}` : `${opts.min} to ${opts.max}`
      throw new UsageError(`${flag} must be ${opts.integer ? "a whole number " : "a number "}${range}, got "${raw}"`)
    }
    return value
  }
  const rawGridConfidence = get("--min-grid-confidence")
  if (
    rawGridConfidence !== undefined &&
    rawGridConfidence !== "low" && rawGridConfidence !== "medium" && rawGridConfidence !== "high"
  ) {
    throw new UsageError(
      `--min-grid-confidence must be low, medium, or high, got "${rawGridConfidence}"`,
    )
  }
  return {
    command,
    manifest,
    lock: get("--lock") ?? path.join(path.dirname(path.resolve(manifest)), "pixelkiln.lock.json"),
    explicitLock: get("--lock"),
    styles: list("--style"),
    assets: list("--only"),
    force: rest.includes("--force"),
    yes: rest.includes("--yes") || rest.includes("-y"),
    budget,
    providerBudgets,
    dryRun: rest.includes("--dry-run"),
    all: rest.includes("--all"),
    json: rest.includes("--json"),
    check: rest.includes("--check"),
    noOpen: rest.includes("--no-open"),
    tag: rest.includes("--tag"),
    edit: rest.includes("--edit"),
    noEditor: rest.includes("--no-editor"),
    refresh: rest.includes("--refresh"),
    local: rest.includes("--local"),
    strict: rest.includes("--strict"),
    source: get("--source"),
    objectId: get("--object-id"),
    tool: get("--tool"),
    importPrompt: get("--prompt"),
    seed: numberOption("--seed", { min: 0, integer: true }),
    importCost: numberOption("--cost", { min: 0 }),
    // Steps are free text that may contain commas, so they are not split.
    steps: rest.flatMap((token, i) => (token === "--step" && rest[i + 1] ? [rest[i + 1]!.trim()] : [])).filter(Boolean),
    raw: get("--raw"),
    from: get("--from"),
    out: get("--out"),
    generator: get("--generator"),
    exclude: list("--exclude"),
    name: get("--name"),
    writePrompts: rest.includes("--write-prompts"),
    columns,
    port,
    inputs: get("--inputs"),
    claims: list("--claims"),
    format: rawFormat as TilesetFormat | SheetFormat | undefined,
    outputRoles: list("--output-role"),
    primaryOnly: rest.includes("--primary-only"),
    prune: rest.includes("--prune"),
    maxDistance: numberOption("--max-distance", { min: 0 }),
    minTransparency: numberOption("--min-transparency", { min: 0, max: 1 }),
    maxColors: numberOption("--max-colors", { min: 1, integer: true }),
    sigma: numberOption("--sigma", { min: Number.EPSILON }),
    palette: list("--palette"),
    fixerPython: get("--fixer-python"),
    fixerRevision: get("--fixer-revision"),
    minGridConfidence: rawGridConfidence as GridConfidence | undefined,
    reviewer: get("--reviewer"),
    note: get("--note"),
    modelRoot: get("--model-root"),
    generation: get("--generation"),
    subcommand,
    workspace: get("--workspace"),
    target,
    provider: get("--provider"),
    account: get("--account"),
    quantize: numberOption("--quantize", { min: -1, max: 256, integer: true }),
    description: get("--description"),
    artist: get("--artist"),
    weight: get("--weight"),
    glyphPx: numberOption("--glyph-px", { min: 8, max: 64, integer: true }),
    frames: command === "normal-map"
      ? numberOption("--frames", { min: 1, max: 32, integer: true })
      : numberOption("--frames", { min: 3, max: 15, integer: true }),
    convention: get("--convention"),
    estimateLimit: numberOption("--estimate-limit", { min: 0, max: 1000, integer: true }),
    preset: get("--preset"),
    recipe: get("--recipe"),
    effect: get("--effect"),
    parts: list("--part"),
    sprite: get("--sprite"),
    fps: numberOption("--fps", { min: 1, max: 60, integer: true }),
    gamePack: rest.includes("--game-pack"),
    mode: get("--mode"),
    strength: numberOption("--strength", { min: 0, max: 2 }),
    outlineRounding: numberOption("--outline-rounding", { min: 0, max: 3 }),
    partShapes: numberOption("--part-shapes", { min: 0, max: 2 }),
    surfaceDetail: numberOption("--surface-detail", { min: 0, max: 2 }),
    detailSoftness: numberOption("--detail-softness", { min: 0.6, max: 3 }),
    kind: get("--kind"),
    size: get("--size"),
    animation: get("--animation"),
    direction: get("--direction"),
    keep: rest.includes("--keep"),
    discard: rest.includes("--discard"),
    pro: rest.includes("--pro"),
    id: get("--id"),
    // Free text with commas and "=" of its own, so neither is split.
    uiStates: rest.flatMap((token, i) => (token === "--state" && rest[i + 1] ? [rest[i + 1]!.trim()] : [])),
    elements: list("--element"),
    insets: get("--insets"),
    clear: rest.includes("--clear"),
    boxes: rest.flatMap((token, i) => (token === "--box" && rest[i + 1] ? [rest[i + 1]!.trim()] : [])),
    bpm: numberOption("--bpm", { min: 60, max: 180, integer: true }),
    seconds: command === "music"
      ? numberOption("--seconds", { min: 10, max: 360, integer: true })
      : numberOption("--seconds", { min: 0.5, max: 30 }),
    lyrics: get("--lyrics"),
    autoLyrics: rest.includes("--auto-lyrics"),
    about: get("--about"),
    voice: get("--voice"),
    styleWeight: numberOption("--style-weight", { min: 0, max: 1 }),
    loop: rest.includes("--loop"),
    loopOf: get("--loop-of"),
    restyle: get("--restyle"),
    improve: rest.includes("--improve"),
  }
}
