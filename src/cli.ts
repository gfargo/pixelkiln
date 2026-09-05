#!/usr/bin/env node
import path from "node:path"
import { existsSync } from "node:fs"
import { readFile } from "node:fs/promises"
import { loadEnvFiles } from "./env.ts"
import {
  formatCost,
  measureBalanceChange,
  requireBalance,
  requireDelete,
  requireList,
} from "./provider.ts"
import {
  createProvider,
  providerFactory,
  type ProviderMode,
} from "./providers/registry.ts"
import { loadManifest, resolveSpecs } from "./manifest.ts"
import { mountStyle, packSprites, packStyle, resolvePackInputs } from "./pipeline/pack.ts"
import { loadLock, remove as removeLock, saveLock, spendByUnit, upsert as upsertLock } from "./lock.ts"
import { sha256File } from "./hash.ts"
import { lockKey, type Lock, type Manifest, type ResolvedSpec } from "./types.ts"
import { normalizeLockOutputPaths, resolveOutputPath } from "./outputs.ts"
import { buildPlan, summarize, type Plan } from "./pipeline/plan.ts"
import { submit } from "./pipeline/submit.ts"
import { poll } from "./pipeline/poll.ts"
import { fetchAssets, pushTags } from "./pipeline/fetch.ts"
import { doctor } from "./pipeline/doctor.ts"
import { adopt, formatUnmatchedRemote, tagAdopted, writePromptsBack } from "./pipeline/adopt.ts"
import { runPicker } from "./pick/server.ts"
import { scanAssets, buildManifest, writeManifestFile } from "./pipeline/init.ts"
import {
  loadClaims,
  findOrphans,
  groupOrphansByStyle,
  loadSiblingManifests,
  SALVAGED_SPEC_HASH,
} from "./pipeline/salvage.ts"
import {
  loadWorkspace,
  saveWorkspace,
  toPortablePath,
  resolveProject,
  validateWorkspace,
  type WorkspaceProject,
} from "./workspace.ts"
import { workspaceClaims, workspaceStatus } from "./pipeline/workspace.ts"
import { auditStyle, evaluateAudit, hex } from "./pipeline/audit.ts"
import { inspectCaches } from "./pipeline/cache-health.ts"
import {
  approveQualityRecord,
  checkQualityRecord,
  refineAsset,
  type GridConfidence,
} from "./pipeline/refine.ts"
import { exportTileset, type TilesetFormat } from "./pipeline/tileset-export.ts"
import { runSalvage } from "./pick/salvage-server.ts"
import type { BalanceInfo, Provider } from "./provider.ts"
import {
  writeManagedArtifactBundle,
  type ArtifactFile,
  type ArtifactSource,
} from "./artifacts.ts"
import {
  installRecipe,
  listBundledRecipes,
  resolveRecipe,
  verifyRecipe,
} from "./recipes.ts"
import {
  checkQualityBaseline,
  resolveQualityInputs,
  snapshotQualityBaseline,
} from "./pipeline/quality-regression.ts"

const log = (msg = "") => console.log(msg)

async function provenanceFile(id: string, file: string): Promise<ArtifactSource> {
  const absolute = path.resolve(file)
  return {
    id,
    path: absolute,
    sha256: existsSync(absolute) ? await sha256File(absolute) : null,
    included: true,
  }
}

interface Args {
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
  format?: TilesetFormat
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
}

const VALUE_FLAGS = [
  "--manifest", "--lock", "--style", "--only", "--budget", "--port",
  "--from", "--out", "--generator", "--exclude", "--name", "--claims", "--columns", "--inputs", "--format",
  "--output-role", "--max-distance", "--min-transparency", "--max-colors", "--sigma", "--workspace",
  "--provider", "--account", "--palette", "--fixer-python", "--fixer-revision", "--min-grid-confidence",
  "--reviewer", "--note",
  "--model-root",
] as const
const BOOL_FLAGS = [
  "--force", "--yes", "-y", "--dry-run", "--all", "--json", "--check", "--no-open", "--tag", "--write-prompts", "--primary-only", "--prune",
] as const

export const COMMANDS = [
  "init", "plan", "doctor", "gen", "submit", "poll", "pick", "fetch", "restore", "adopt", "accept",
  "salvage", "purge", "prune", "audit", "cache", "pack", "mount", "export", "tag", "balance", "status",
  "quality", "refine", "recipe", "workspace", "help", "--help", "-h", "--version", "-v",
] as const

const WORKSPACE_SUBCOMMANDS = ["add", "remove", "list", "status", "claims"] as const
const REFINE_SUBCOMMANDS = ["run", "approve", "check"] as const
const RECIPE_SUBCOMMANDS = ["list", "inspect", "install", "verify"] as const
const QUALITY_SUBCOMMANDS = ["snapshot", "check"] as const

/**
 * Strict parsing. Unknown flags are a hard error rather than being ignored,
 * because a silently-dropped filter is expensive here: `--styles neon` (plural,
 * a typo) would otherwise fall through to "no filter" and generate the entire
 * manifest instead of one style.
 */
export function parseArgs(argv: string[]): Args {
  const [command = "help"] = argv
  if (!(COMMANDS as readonly string[]).includes(command)) {
    throw new Error(`Unknown command "${command}". Run \`pixelkiln help\` for the list.`)
  }

  let rest = argv.slice(1)
  let subcommand: string | undefined
  let target: string | undefined
  if (command === "quality") {
    subcommand = rest[0]
    if (subcommand === undefined || subcommand.startsWith("-")) {
      throw new Error(`quality needs a subcommand: ${QUALITY_SUBCOMMANDS.join(", ")}`)
    }
    if (!(QUALITY_SUBCOMMANDS as readonly string[]).includes(subcommand)) {
      throw new Error(
        `Unknown quality subcommand "${subcommand}". Known: ${QUALITY_SUBCOMMANDS.join(", ")}`,
      )
    }
    rest = rest.slice(1)
  } else if (command === "recipe") {
    subcommand = rest[0]
    if (subcommand === undefined || subcommand.startsWith("-")) {
      throw new Error(`recipe needs a subcommand: ${RECIPE_SUBCOMMANDS.join(", ")}`)
    }
    if (!(RECIPE_SUBCOMMANDS as readonly string[]).includes(subcommand)) {
      throw new Error(
        `Unknown recipe subcommand "${subcommand}". Known: ${RECIPE_SUBCOMMANDS.join(", ")}`,
      )
    }
    rest = rest.slice(1)
    if (subcommand !== "list") {
      target = rest[0]
      if (target === undefined || target.startsWith("-")) {
        throw new Error(`recipe ${subcommand} needs a recipe id, selector, or path.`)
      }
      rest = rest.slice(1)
    }
  } else if (command === "workspace") {
    subcommand = rest[0]
    if (subcommand === undefined || subcommand.startsWith("-")) {
      throw new Error(`workspace needs a subcommand: ${WORKSPACE_SUBCOMMANDS.join(", ")}`)
    }
    if (!(WORKSPACE_SUBCOMMANDS as readonly string[]).includes(subcommand)) {
      throw new Error(
        `Unknown workspace subcommand "${subcommand}". Known: ${WORKSPACE_SUBCOMMANDS.join(", ")}`,
      )
    }
    rest = rest.slice(1)
    if (subcommand === "add" || subcommand === "remove") {
      target = rest[0]
      if (target === undefined || target.startsWith("-")) {
        throw new Error(
          subcommand === "add"
            ? "workspace add needs a manifest path."
            : "workspace remove needs a project id or manifest path.",
        )
      }
      rest = rest.slice(1)
    }
  } else if (command === "refine") {
    subcommand = rest[0]?.startsWith("-") || rest[0] === undefined ? "run" : rest[0]
    if (!(REFINE_SUBCOMMANDS as readonly string[]).includes(subcommand)) {
      throw new Error(
        `Unknown refine subcommand "${subcommand}". Known: ${REFINE_SUBCOMMANDS.join(", ")}`,
      )
    }
    if (rest[0] === subcommand) rest = rest.slice(1)
  }

  for (let i = 0; i < rest.length; i++) {
    const token = rest[i]!
    if (!token.startsWith("-")) {
      throw new Error(`Unexpected argument "${token}". Options must be passed with a named flag.`)
    }
    if ((BOOL_FLAGS as readonly string[]).includes(token)) continue
    if ((VALUE_FLAGS as readonly string[]).includes(token)) {
      const value = rest[i + 1]
      // A numeric token is a value even though it starts with "-", so
      // `--budget -5` reaches the range check and reports the real problem.
      const looksLikeFlag = value !== undefined && value.startsWith("-") && !Number.isFinite(Number(value))
      if (value === undefined || looksLikeFlag) {
        throw new Error(`${token} needs a value.`)
      }
      i++
      continue
    }
    throw new Error(
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
   * only `a`, silently discarding `b` — so a run that looked like it covered
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
      throw new Error(`--columns must be a whole number between 1 and 1024, got "${rawColumns}"`)
    }
  }

  const rawPort = get("--port")
  let port: number | undefined
  if (rawPort !== undefined) {
    port = Number(rawPort)
    if (!Number.isInteger(port) || port < 1 || port > 65_535) {
      throw new Error(`--port must be a whole number between 1 and 65535, got "${rawPort}"`)
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
        throw new Error(
          `--budget must be a non-negative number or provider=number, got "${rawBudget}".`,
        )
      }
      if (Object.hasOwn(providerBudgets, providerId)) {
        throw new Error(`--budget repeats provider "${providerId}".`)
      }
      providerBudgets[providerId] = amount
      continue
    }
    const amount = Number(rawBudget)
    if (!Number.isFinite(amount) || amount < 0) {
      throw new Error(`--budget must be a non-negative number, got "${rawBudget}".`)
    }
    if (budget !== undefined) throw new Error("Only one unkeyed --budget may be passed.")
    budget = amount
  }
  if (budget !== undefined && Object.keys(providerBudgets).length) {
    throw new Error("Do not mix an unkeyed --budget with provider-keyed budgets.")
  }

  const manifest = get("--manifest") ?? "pixelkiln.manifest.json"
  const rawFormat = get("--format")
  if (rawFormat && rawFormat !== "generic" && rawFormat !== "tiled" && rawFormat !== "godot") {
    throw new Error(`--format must be generic, tiled, or godot, got "${rawFormat}"`)
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
      throw new Error(`${flag} must be ${opts.integer ? "a whole number " : "a number "}${range}, got "${raw}"`)
    }
    return value
  }
  const rawGridConfidence = get("--min-grid-confidence")
  if (
    rawGridConfidence !== undefined &&
    rawGridConfidence !== "low" && rawGridConfidence !== "medium" && rawGridConfidence !== "high"
  ) {
    throw new Error(
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
    format: rawFormat as TilesetFormat | undefined,
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
    subcommand,
    workspace: get("--workspace"),
    target,
    provider: get("--provider"),
    account: get("--account"),
  }
}

const HELP = `pixelkiln — manifest-driven pixel art generation

  pixelkiln <command> [options]

Commands
  init      Scaffold a manifest from an existing tree of PNGs.
  plan      Diff manifest against lockfile and disk. Costs nothing. Start here.
  doctor    Validate project state, recovery paths, and provider connectivity.
  gen       Full run: submit → poll → pick → fetch. The everyday command.
  submit    Queue generation jobs only.
  poll      Advance in-flight jobs to their settled state.
  pick      Open the contact sheet to choose among candidates.
  fetch     Download selected objects to their manifest paths.
  restore   Re-download missing generated files without generating new art.
  adopt     Match existing account objects to files already in the repo.
  accept    Keep existing art after a style reword — re-baseline, do not regenerate.
  salvage   Triage account objects no lockfile claims. Recovers usable art.
            One session per matching style unless --style forces a single one.
  audit     Measure how consistently a style's assets hold together. Offline.
  refine    Recover a native pixel grid, enforce a final palette, audit it,
            and attach a verifiable human approval. run/approve/check. Offline.
  recipe    List, inspect, install, or verify versioned workflow packs. Offline.
  quality   Snapshot or check measurable image regressions. Offline.
  cache     Inspect local recovery/object-hash caches; optionally verify or prune.
  pack      Composite sprites into a PNG/atlas/provenance bundle. Offline.
  mount     Write a style's sprites into their declared cells of an existing
            sheet, leaving every other pixel untouched. Offline.
  export    Build a tile atlas, engine metadata, and offline provenance record.
  purge     Delete objects previously tagged discard. Irreversible; asks first.
  prune     Drop lock entries the manifest no longer declares. Offline; asks
            first. Local art is untouched.
  tag       Push manifest tags to the objects upstream (free).
  balance   Show the provider's remaining balance.
  status    Summarise the lockfile.
  workspace Register sibling projects and derive account-wide claims/status.
            add/remove/list/status/claims. Offline.

Options
  --columns <n>       pack/export: sprites or tiles per row (default: near-square)
  --port <n>          Local review-server port (default: choose a free port)
  --inputs <path>     pack/quality snapshot: JSON input list; needs --out
  --format <format>   export: generic (default), tiled, or godot
  --output-role <r>   pack: include only this output role (repeatable)
  --primary-only      pack: include only unambiguous primary/single outputs
  --max-distance <n>  audit: maximum palette distance
  --min-transparency <0..1>  audit: minimum transparent canvas share
  --max-colors <n>    audit: maximum distinct opaque colors
  --sigma <n>         audit: relative outlier cutoff (default: 1.5)
  --palette <hexes>   refine: final comma-separated #rrggbb colors (repeatable)
  --fixer-python <path>  refine: Python with Pixel Art Fixer installed
  --fixer-revision <sha>  refine: Pixel Art Fixer revision to record
  --min-grid-confidence <level>  refine: high (default), medium, or low
  --reviewer <name>   refine approve: human reviewer recorded in provenance
  --note <text>       refine approve: optional review note
  --model-root <dir>  recipe verify: also hash required local model files
  --prune             cache: remove invalid/unreferenced local cache data
  --manifest <path>   Default: pixelkiln.manifest.json
  --lock <path>       Default: pixelkiln.lock.json beside the manifest
  --style a,b         Restrict to these styles
  --only id1,id2      Restrict to these asset ids
  --budget <n|provider=n>  Refuse to exceed one provider ceiling; repeat keyed budgets
                           for a mixed-provider run
  --provider <id>     Choose the account for balance/adopt/salvage/purge in a mixed manifest
  --force             Regenerate; also replace changed recipe files or quality baselines
  --dry-run           Never spend; doctor also skips provider connectivity
  --all               salvage --dry-run: list every unclaimed object, not just the first 30
  --json              Machine-readable output where supported, including quality checks
  --check             plan/audit/cache: exit nonzero when the selected state is unsafe
  --yes, -y           Skip the confirmation prompt
  --no-open           Do not auto-open the browser during pick
  --tag               Also push tags upstream after fetch
  --claims a.json,b   Other projects' lockfiles (salvage; required if account is shared)
  --workspace <path>  Workspace catalog (default: pixelkiln.workspace.json). Also
                       derives salvage's claim set instead of repeated --claims.
  --from <path>       Source for init/refine, or baseline for quality check
  --write-prompts     adopt: recover prompts into the manifest

Examples
  pixelkiln plan
  pixelkiln gen --style heybud-premium --budget 400
  pixelkiln gen --only first_review --force
  pixelkiln adopt --tag
  pixelkiln pack --style heybud-premium
  pixelkiln pack --inputs sprites.json --out dist/sheet   # no manifest needed
  pixelkiln mount --style ground
  pixelkiln export --style ground --only terrain --format tiled
  pixelkiln refine --from source.png --out final.png --palette "#101820,#f2aa4c"
  pixelkiln refine approve --from final.pixelkiln.json --reviewer "Your Name"
  pixelkiln refine check --from final.pixelkiln.json
  pixelkiln recipe list
  pixelkiln recipe install comfyui/pixel-art-xl-environment
  pixelkiln recipe verify pixelkiln-recipes/comfyui/pixel-art-xl-environment/1.0.0 --model-root /path/to/ComfyUI/models
  pixelkiln quality snapshot --inputs quality-inputs.json --out pixelkiln.quality.json
  pixelkiln quality check --from pixelkiln.quality.json
  pixelkiln workspace add ../other-game/pixelkiln.manifest.json
  pixelkiln workspace status --json
  pixelkiln salvage --workspace pixelkiln.workspace.json
`

function printPlan(plan: Plan): void {
  const counts = summarize(plan)
  const order = ["missing", "untracked", "stale", "failed", "recoverable", "in-flight", "orphaned", "ok"] as const
  for (const state of order) {
    const items = plan.items.filter((i) => i.state === state)
    if (!items.length) continue
    log(`\n  ${state}  (${items.length})`)
    for (const item of items.slice(0, 40)) {
      log(`    ${item.key.padEnd(42)} ${item.reason}`)
    }
    if (items.length > 40) log(`    … and ${items.length - 40} more`)
  }
  log(
    `\n  totals: ${counts.ok} ok · ${counts.missing} missing · ${counts.untracked} untracked · ` +
      `${counts.stale} stale · ${counts["in-flight"]} in-flight · ${counts.orphaned} orphaned · ` +
      `${counts.recoverable} recoverable · ${counts.failed} failed`,
  )
  if (plan.actionable.length) {
    for (const group of plan.groups) {
      log(
        `  ${group.provider}: ${group.actionable.length} asset(s) — ` +
          `${formatCost(group.costUnit, group.cost)}, ` +
          `${group.candidates} candidate/output image(s)`,
      )
    }
  } else {
    log(`  nothing to generate`)
  }
}

function manifestProviderIds(manifest: Manifest): string[] {
  return [...new Set(
    Object.values(manifest.styles).map((style) => style.provider ?? manifest.provider),
  )].sort()
}

function specsByRecordedProvider(specs: ResolvedSpec[], lock: Lock): Map<string, ResolvedSpec[]> {
  const grouped = new Map<string, ResolvedSpec[]>()
  for (const spec of specs) {
    const key = lockKey(spec.styleId, spec.assetId)
    const provider = lock.entries[key]?.provider ?? spec.provider
    grouped.set(provider, [...(grouped.get(provider) ?? []), spec])
  }
  return grouped
}

function accountProviderId(manifest: Manifest, requested: string | undefined, command: string): string {
  const providers = manifestProviderIds(manifest)
  if (requested) {
    if (!providers.includes(requested)) {
      throw new Error(
        `Provider "${requested}" is not used by this manifest. Used: ${providers.join(", ")}.`,
      )
    }
    return requested
  }
  if (providers.length > 1) {
    throw new Error(
      `${command} is account-scoped and this manifest uses ${providers.join(", ")}. ` +
        `Pass --provider <id>.`,
    )
  }
  return providers[0] ?? manifest.provider
}

function budgetsForPlan(plan: Plan, args: Args): Map<string, number | undefined> {
  const providerIds = new Set(plan.groups.map((group) => group.provider))
  const keyed = Object.entries(args.providerBudgets)
  for (const [provider] of keyed) {
    if (!providerIds.has(provider)) {
      throw new Error(
        `Budget names provider "${provider}", but this run has work only for ` +
          `${[...providerIds].join(", ") || "no providers"}.`,
      )
    }
  }
  if (plan.groups.length > 1 && args.budget !== undefined) {
    throw new Error(
      "A mixed-provider run needs provider-keyed budgets, for example " +
        "--budget pixellab=40 --budget retrodiffusion=1.25.",
    )
  }
  const out = new Map<string, number | undefined>()
  for (const group of plan.groups) {
    const ceiling = args.providerBudgets[group.provider]
    if (
      plan.groups.length > 1 &&
      group.costUnit !== "free" &&
      group.cost > 0 &&
      ceiling === undefined
    ) {
      throw new Error(
        `Mixed-provider run is missing --budget ${group.provider}=<amount> for ` +
          `${formatCost(group.costUnit, group.cost)} of planned work.`,
      )
    }
    out.set(group.provider, ceiling ?? (plan.groups.length === 1 ? args.budget : undefined))
  }
  return out
}

async function confirm(question: string, auto: boolean): Promise<boolean> {
  if (auto) return true
  if (!process.stdin.isTTY) {
    log(`  (non-interactive; pass --yes to proceed)`)
    return false
  }
  process.stdout.write(`${question} [y/N] `)
  const answer = await new Promise<string>((resolve) => {
    process.stdin.setEncoding("utf8")
    process.stdin.once("data", (d) => resolve(String(d).trim().toLowerCase()))
  })
  process.stdin.pause()
  return answer === "y" || answer === "yes"
}

/**
 * Loads a workspace catalog and derives its complete claim set, refusing when
 * the catalog itself is unsafe — missing entirely, or containing duplicate
 * ids/locks, or a registered manifest or lock that does not exist — rather
 * than silently deriving a partial (or empty) claim set. `loadWorkspace`
 * treats a missing file as an empty catalog because that's the right
 * behavior for `workspace add` (creating one for the first time); a claim
 * consumer needs the opposite default, the same way `--claims` treats a
 * missing lockfile path as a hard error (`loadClaims`,
 * `src/pipeline/salvage.ts`) rather than skipping it. `workspaceClaims`
 * separately guards against an unreadable lock that passed the existence
 * check.
 */
async function requireCompleteWorkspaceClaims(workspacePath: string) {
  if (!existsSync(workspacePath)) {
    throw new Error(`Workspace catalog not found: ${workspacePath}`)
  }
  const dir = path.dirname(path.resolve(workspacePath))
  const ws = await loadWorkspace(workspacePath)
  const diagnostics = validateWorkspace(ws, dir)
  const errors = diagnostics.filter((d) => d.level === "error")
  if (errors.length) {
    throw new Error(
      `Workspace catalog at ${workspacePath} is not safe to derive a claim set from:\n` +
        errors.map((d) => `  ${d.id}: ${d.message}`).join("\n"),
    )
  }
  const claims = await workspaceClaims(ws, dir)
  return { ws, dir, diagnostics, claims }
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  if (args.command === "help" || args.command === "--help" || args.command === "-h") {
    log(HELP)
    return
  }

  if (args.command === "--version" || args.command === "-v") {
    const pkg = JSON.parse(
      await readFile(new URL("../package.json", import.meta.url), "utf8"),
    ) as { name: string; version: string }
    log(`${pkg.name} ${pkg.version}`)
    return
  }

  if (args.command === "quality") {
    if (args.subcommand === "snapshot") {
      if (!args.inputs) throw new Error("quality snapshot needs --inputs <quality-inputs.json>.")
      if (!args.out) throw new Error("quality snapshot needs --out <pixelkiln.quality.json>.")
      let raw: unknown
      try {
        raw = JSON.parse(await readFile(path.resolve(args.inputs), "utf8"))
      } catch (error) {
        throw new Error(
          `Could not read quality inputs ${path.resolve(args.inputs)}: ` +
            `${error instanceof Error ? error.message : String(error)}`,
          { cause: error },
        )
      }
      const inputs = resolveQualityInputs(raw, args.inputs)
      if (path.resolve(args.inputs) === path.resolve(args.out)) {
        throw new Error("quality snapshot --out must not overwrite its --inputs file.")
      }
      const result = await snapshotQualityBaseline(inputs, args.out, { force: args.force })
      if (args.json) {
        log(JSON.stringify({
          version: 1,
          path: result.path,
          changed: result.changed,
          baseline: result.baseline,
        }, null, 2))
      } else {
        log(
          `  ${result.changed ? "wrote" : "unchanged"} ` +
            `${path.relative(process.cwd(), result.path)} (${result.baseline.cases.length} case(s))`,
        )
        log(`  Review the tolerances, commit the baseline, then run quality check in CI.`)
      }
      return
    }

    if (!args.from) throw new Error("quality check needs --from <pixelkiln.quality.json>.")
    const report = await checkQualityBaseline(args.from)
    if (args.json) {
      log(JSON.stringify(report, null, 2))
    } else {
      for (const entry of report.cases) {
        log(`  ${entry.status === "pass" ? "ok" : "ERROR"}  ${entry.id}`)
        for (const violation of entry.violations) log(`         ${violation}`)
        for (const warning of entry.warnings) log(`  WARN   ${warning}`)
      }
      log(
        `\n  ${report.summary.passed}/${report.summary.total} passed` +
          (report.summary.changed ? ` · ${report.summary.changed} image hash(es) changed` : ""),
      )
      log(`  Metrics catch structural regressions; they do not replace art review.`)
    }
    if (!report.safe) process.exitCode = 1
    return
  }

  if (args.command === "recipe") {
    if (args.subcommand === "list") {
      const recipes = await listBundledRecipes()
      if (args.json) {
        log(JSON.stringify({
          version: 1,
          recipes: recipes.map(({ recipe }) => ({
            id: recipe.id,
            version: recipe.version,
            provider: recipe.provider,
            summary: recipe.summary,
            selector: `${recipe.id}@${recipe.version}`,
          })),
        }, null, 2))
      } else {
        log(`  ${recipes.length} bundled recipe(s):`)
        for (const { recipe } of recipes) {
          log(`    ${(recipe.id + "@" + recipe.version).padEnd(52)} ${recipe.summary}`)
        }
      }
      return
    }

    const target = args.target!
    if (args.subcommand === "inspect") {
      const { recipe, path: recipePath, bundled } = await resolveRecipe(target)
      if (args.json) {
        log(JSON.stringify({ ...recipe, path: recipePath, bundled }, null, 2))
      } else {
        log(`  ${recipe.id}@${recipe.version}`)
        log(`  ${recipe.summary}`)
        log(`  provider: ${recipe.provider} · style: ${recipe.styleId} · stage: ${recipe.quality.stage}`)
        log(
          `  native target: ${recipe.quality.recommendedNativeSize.min}–` +
            `${recipe.quality.recommendedNativeSize.max}px · palette: ` +
            `${recipe.quality.paletteColors.min}–${recipe.quality.paletteColors.max} colors`,
        )
        if (recipe.workflow) log(`  workflow: ${recipe.workflow.path} · ${recipe.workflow.numImages} candidate(s)`)
        for (const model of recipe.models) log(`  model: ${model.path} · ${model.license}`)
        log(`  source: ${recipePath}${bundled ? " (bundled)" : ""}`)
      }
      return
    }

    if (args.subcommand === "verify") {
      const report = await verifyRecipe(target, { modelRoot: args.modelRoot })
      if (args.json) {
        log(JSON.stringify(report, null, 2))
      } else {
        log(`  ${report.ok ? "ok" : "ERROR"}  ${report.recipe.id}@${report.recipe.version}`)
        log(`  ${report.integrity.status.padEnd(9)} recipe metadata`)
        for (const file of report.files) log(`  ${file.status.padEnd(9)} ${file.path}`)
        for (const model of report.models) log(`  ${model.status.padEnd(9)} ${model.path}`)
        if (!report.modelRoot && report.models.length) {
          log(`  models were not checked; pass --model-root <ComfyUI/models> to verify this workstation`)
        }
      }
      if (!report.ok) process.exitCode = 1
      return
    }

    if (args.subcommand === "install") {
      const result = await installRecipe(target, { out: args.out, force: args.force })
      if (args.json) {
        log(JSON.stringify({
          version: 1,
          recipe: `${result.recipe.id}@${result.recipe.version}`,
          destination: result.destination,
          changed: result.changed,
          unchanged: result.unchanged,
          styleId: result.styleId,
          style: result.style,
        }, null, 2))
      } else {
        log(`  installed ${result.recipe.id}@${result.recipe.version}`)
        log(`  ${path.relative(process.cwd(), result.destination) || "."}`)
        log(`\n  Add this entry under your manifest's styles object:`)
        log(JSON.stringify({ [result.styleId]: result.style }, null, 2))
        if (result.recipe.models.length) {
          log(`\n  Models are not downloaded automatically. Verify them with:`)
          log(`  pixelkiln recipe verify ${path.relative(process.cwd(), result.destination)} --model-root <ComfyUI/models>`)
        }
      }
      return
    }
  }

  if (args.command === "refine") {
    if (!args.from) {
      throw new Error(
        args.subcommand === "run"
          ? "refine needs --from <source.png>."
          : `refine ${args.subcommand} needs --from <output.pixelkiln.json>.`,
      )
    }

    if (args.subcommand === "run") {
      if (!args.out) throw new Error("refine needs --out <final.png>.")
      if (!args.palette.length) {
        throw new Error("refine needs an explicit final palette via --palette <#rrggbb,...>.")
      }
      const result = await refineAsset({
        source: args.from,
        output: args.out,
        palette: args.palette,
        fixerPython: args.fixerPython,
        fixerRevision: args.fixerRevision,
        minGridConfidence: args.minGridConfidence,
        minTransparency: args.minTransparency,
        force: args.force,
      })
      if (args.json) {
        log(JSON.stringify(result, null, 2))
      } else {
        log(
          `  recovered ${result.detection.columns}x${result.detection.rows} native grid ` +
            `(${result.detection.confidence}: ${result.detection.consensus})`,
        )
        log(`  enforced ${result.palette.length}-color palette without dithering`)
        log(`  wrote ${path.relative(process.cwd(), result.output)}`)
        log(`  quality record: ${path.relative(process.cwd(), result.record)}`)
        log(`\n  Automated checks passed. Human 1× review is still required:`)
        log(
          `    pixelkiln refine approve --from ${path.relative(process.cwd(), result.record)} ` +
            `--reviewer "Your Name"`,
        )
      }
      return
    }

    if (args.subcommand === "approve") {
      if (!args.reviewer?.trim()) {
        throw new Error("refine approve needs --reviewer <name>.")
      }
      log(`  Inspect the final PNG at 1× and integer zoom.`)
      log(`  Confirm crisp edges, readable forms, palette separation, alpha, and seams.`)
      if (!(await confirm("  Record this asset as human-approved?", args.yes))) {
        log("  approval not recorded")
        return
      }
      const result = await approveQualityRecord(args.from, {
        reviewer: args.reviewer,
        note: args.note,
      })
      if (args.json) log(JSON.stringify(result, null, 2))
      else log(`  approved ${path.relative(process.cwd(), result.output)} by ${args.reviewer.trim()}`)
      return
    }

    const result = await checkQualityRecord(args.from)
    if (args.json) {
      log(JSON.stringify(result, null, 2))
    } else {
      log(`  ${result.safe ? "release-ready" : "not release-ready"}: ${path.relative(process.cwd(), result.output || result.record)}`)
      for (const reason of result.reasons) log(`    ${reason}`)
    }
    if (!result.safe) process.exitCode = 1
    return
  }

  if (args.command === "balance") {
    loadEnvFiles(path.dirname(path.resolve(args.manifest)))
    loadEnvFiles(process.cwd())
    const loaded = await loadManifest(args.manifest)
    const selectedProvider = accountProviderId(loaded.manifest, args.provider, "balance")
    const p = createProvider(selectedProvider, "online")
    const b = await requireBalance(p)()
    log(`  provider:  ${p.id}`)
    log(`  plan:      ${b.plan ?? "n/a"}`)
    log(`  remaining: ${formatCost(b.unit, b.remaining)}${b.total ? ` of ${b.total}` : ""}`)
    return
  }

  if (args.command === "init") {
    if (!args.from) throw new Error("init needs --from <dir> pointing at your existing PNGs.")
    const root = path.resolve(args.from)
    if (!existsSync(root)) throw new Error(`No directory at ${root}`)

    const generator = (args.generator ?? "map") as "1dir" | "map"
    if (generator !== "1dir" && generator !== "map") {
      throw new Error(`--generator must be "1dir" or "map", got "${args.generator}".`)
    }

    const target = path.resolve(args.out ?? "pixelkiln.manifest.json")
    const { assets, skipped } = await scanAssets(root, { exclude: args.exclude })
    if (!assets.length) throw new Error(`No PNGs found under ${root}`)

    const manifest = buildManifest(
      args.name ?? path.basename(path.dirname(target)),
      args.styles[0] ?? "base",
      generator,
      path.relative(path.dirname(target), root) || ".",
      assets,
    )
    await writeManifestFile(target, manifest)

    log(`  scanned ${assets.length} PNG(s) under ${path.relative(process.cwd(), root)}`)
    if (skipped.length) log(`  skipped ${skipped.length} unreadable file(s)`)
    log(`  wrote ${path.relative(process.cwd(), target)}`)
    log(`\n  Prompts are intentionally empty. To recover the real ones from your`)
    log(`  PixelLab account instead of inventing them:`)
    log(`\n    pixelkiln adopt --manifest ${path.relative(process.cwd(), target)} --write-prompts\n`)
    return
  }

  if (args.command === "cache") {
    const lock = await loadLock(args.lock)
    const report = await inspectCaches(lock, args.lock, { prune: args.prune })
    if (args.json) {
      log(JSON.stringify(report, null, 2))
    } else {
      const size = report.content.bytes < 1024
        ? `${report.content.bytes} B`
        : `${(report.content.bytes / 1024).toFixed(1)} KB`
      log(`  content cache: ${report.content.path}`)
      log(
        report.content.exists
          ? `    ${report.content.valid} valid PNG(s), ${report.content.referenced} referenced, ` +
            `${report.content.unreferenced.length} unreferenced — ${size}`
          : "    not created yet",
      )
      if (report.content.missingReferenced.length) {
        log(`    ${report.content.missingReferenced.length} lockfile hash(es) are not locally cached`)
      }
      for (const issue of report.content.invalid.slice(0, 10)) {
        log(`    invalid ${issue.name}: ${issue.reason}`)
      }
      if (report.content.invalid.length > 10) {
        log(`    … and ${report.content.invalid.length - 10} more invalid entr(ies)`)
      }

      log(`  remote object-hash cache: ${report.remoteHashes.path}`)
      if (!report.remoteHashes.exists) log("    not created yet")
      else if (report.remoteHashes.error) {
        log(`    invalid cache: ${report.remoteHashes.error.split("\n")[0]}`)
      } else {
        log(
          `    ${report.remoteHashes.valid} valid entr(ies), ` +
            `${report.remoteHashes.invalidIds.length} invalid`,
        )
      }
      if (args.prune) {
        log(
          `  pruned ${report.removed.contentFiles} content file(s), ` +
            `${report.removed.remoteHashEntries} invalid remote hash entr(ies)` +
            (report.removed.resetRemoteHashCache ? "; rebuilt malformed remote cache" : ""),
        )
      }
      log(`  ${report.safe ? "cache integrity is healthy" : "cache integrity needs attention"}`)
    }
    if (args.check && !report.safe) process.exitCode = 1
    return
  }

  if (args.command === "pack" && args.inputs) {
    // Handled before the manifest-required check below, deliberately: the
    // whole point of `--inputs` is packing sprites that were never part of a
    // pixelkiln manifest at all. Requiring one anyway — as this did until a
    // manual smoke test caught it — defeated the feature for exactly the
    // no-manifest consumer it was built for; heybud-admin's sync script never
    // noticed because it happens to run from a directory that has its own
    // manifest for an unrelated reason.
    if (!args.out) throw new Error("--inputs requires --out")
    if (args.primaryOnly || args.outputRoles.length) {
      throw new Error("--primary-only and --output-role require manifest-driven pack")
    }

    const raw = JSON.parse(await readFile(path.resolve(args.inputs), "utf8")) as unknown
    const inputs = resolvePackInputs(raw, args.inputs)

    const { png, atlas, skipped, sources } = packSprites(inputs, { columns: args.columns })
    const base = path.resolve(args.out.replace(/\.png$/, ""))
    const outputs: ArtifactFile[] = [
      { path: `${base}.png`, data: png },
      { path: `${base}.json`, data: JSON.stringify(atlas, null, 2) + "\n" },
    ]
    await writeManagedArtifactBundle(`${base}.pixelkiln.json`, outputs, {
      kind: "pack",
      sources: [await provenanceFile("$inputs", args.inputs), ...sources],
      options: { columns: args.columns ?? null, order: "id", style: null },
    }, { force: args.force })
    log(
      `  ${atlas.frames.length} sprite(s), ${atlas.sheet.width}x${atlas.sheet.height} ` +
        `in ${atlas.columns} column(s) — ${(png.length / 1024).toFixed(1)} KB`,
    )
    log(`    ${path.relative(process.cwd(), base)}.png + .json + .pixelkiln.json`)
    for (const s of skipped) log(`    skipped ${s.id}: ${s.reason}`)
    return
  }

  if (args.command === "workspace") {
    // No manifest is required in cwd for any of these — a catalog is meant to
    // be operated on from outside any one project.
    const workspacePath = path.resolve(args.workspace ?? "pixelkiln.workspace.json")
    const dir = path.dirname(workspacePath)

    if (args.subcommand === "add") {
      const manifestPath = path.resolve(args.target!)
      const loadedTarget = await loadManifest(manifestPath)
      const lockPath = args.explicitLock
        ? path.resolve(args.explicitLock)
        : path.join(path.dirname(manifestPath), "pixelkiln.lock.json")

      const ws = await loadWorkspace(workspacePath)
      const id = args.name ?? loadedTarget.manifest.name
      if (ws.projects.some((p) => p.id === id)) {
        throw new Error(
          `Project id "${id}" is already registered in ${workspacePath}. Pass --name for a different id.`,
        )
      }
      const lockOwner = ws.projects.find((p) => resolveProject(dir, p).lockPath === lockPath)
      if (lockOwner) {
        throw new Error(`Lockfile ${lockPath} is already registered under project id "${lockOwner.id}".`)
      }

      const project: WorkspaceProject = {
        id,
        manifest: toPortablePath(dir, manifestPath),
        lock: toPortablePath(dir, lockPath),
        provider: args.provider ?? loadedTarget.manifest.provider,
        ...(args.account ? { account: args.account } : {}),
      }
      await saveWorkspace(workspacePath, { version: 1, projects: [...ws.projects, project] })
      log(`  registered "${id}" in ${path.relative(process.cwd(), workspacePath)}`)
      log(`    manifest: ${project.manifest}`)
      log(`    lock:     ${project.lock}`)
      if (!existsSync(lockPath)) {
        log(
          `  warning: no lockfile there yet — this project contributes no claims until one is generated`,
        )
      }
      return
    }

    if (args.subcommand === "remove") {
      const ws = await loadWorkspace(workspacePath)
      const resolvedTarget = path.resolve(args.target!)
      const match = ws.projects.find(
        (p) => p.id === args.target || resolveProject(dir, p).manifestPath === resolvedTarget,
      )
      if (!match) {
        throw new Error(`No registered project matches "${args.target}" (checked id and manifest path).`)
      }
      await saveWorkspace(workspacePath, {
        version: 1,
        projects: ws.projects.filter((p) => p !== match),
      })
      log(`  removed "${match.id}" from ${path.relative(process.cwd(), workspacePath)}`)
      return
    }

    if (args.subcommand === "list") {
      if (!existsSync(workspacePath)) {
        throw new Error(`Workspace catalog not found: ${workspacePath}`)
      }
      const ws = await loadWorkspace(workspacePath)
      const diagnostics = validateWorkspace(ws, dir)
      if (args.json) {
        log(JSON.stringify({ version: 1, workspace: workspacePath, projects: ws.projects, diagnostics }, null, 2))
      } else if (!ws.projects.length) {
        log(`  no projects registered in ${path.relative(process.cwd(), workspacePath)}`)
      } else {
        log(`  ${ws.projects.length} project(s) in ${path.relative(process.cwd(), workspacePath)}:`)
        for (const p of ws.projects) {
          log(`    ${p.id.padEnd(24)} ${p.manifest.padEnd(40)} (${p.provider}${p.account ? `, ${p.account}` : ""})`)
        }
        for (const d of diagnostics) log(`  ${d.level === "error" ? "ERROR" : "WARN "} ${d.id.padEnd(18)} ${d.message}`)
      }
      if (args.check && diagnostics.some((d) => d.level === "error")) process.exitCode = 1
      return
    }

    if (args.subcommand === "status") {
      if (!existsSync(workspacePath)) {
        throw new Error(`Workspace catalog not found: ${workspacePath}`)
      }
      const ws = await loadWorkspace(workspacePath)
      const report = await workspaceStatus(ws, dir)
      if (args.json) {
        log(JSON.stringify({ ...report, workspace: workspacePath }, null, 2))
      } else {
        log(`  workspace: ${path.relative(process.cwd(), workspacePath)}`)
        for (const p of report.projects) {
          if (p.error) {
            log(`\n  ${p.id} — ERROR: ${p.error}`)
            continue
          }
          log(
            `\n  ${p.id}  (${p.providers.join(" + ")}` +
              `${p.account ? `, ${p.account}` : ""})`,
          )
          log(`    ${p.entries} lock entries`)
          for (const [state, n] of Object.entries(p.byState)) if (n) log(`      ${state.padEnd(12)} ${n}`)
          for (const [unit, amount] of Object.entries(p.spendByUnit).sort()) {
            if (amount) log(`    spend: ${formatCost(unit, amount)}`)
          }
        }
        log(`\n  totals:`)
        for (const [state, n] of Object.entries(report.totals.byState)) if (n) log(`    ${state.padEnd(12)} ${n}`)
        for (const [unit, amount] of Object.entries(report.totals.spendByUnit).sort()) {
          if (amount) log(`    spend: ${formatCost(unit, amount)}`)
        }
        log(`    claims: ${report.totals.claims}`)
        for (const d of report.diagnostics) log(`  ${d.level === "error" ? "ERROR" : "WARN "} ${d.id.padEnd(18)} ${d.message}`)
      }
      if (args.check && !report.safe) process.exitCode = 1
      return
    }

    if (args.subcommand === "claims") {
      const { claims, diagnostics } = await requireCompleteWorkspaceClaims(workspacePath)
      if (args.json) {
        log(JSON.stringify({
          version: 1,
          claimed: [...claims.claimed].sort(),
          byProject: claims.byProject,
          lockPaths: claims.lockPaths,
        }, null, 2))
      } else {
        log(`  ${claims.claimed.size} claimed id(s) across ${claims.lockPaths.length} lockfile(s):`)
        for (const [id, n] of Object.entries(claims.byProject).sort()) log(`    ${id.padEnd(24)} ${n}`)
        for (const d of diagnostics) log(`  WARN  ${d.id.padEnd(18)} ${d.message}`)
      }
      return
    }
  }

  if (!existsSync(path.resolve(args.manifest))) {
    throw new Error(
      `No manifest at ${path.resolve(args.manifest)}. Pass --manifest, or run \`pixelkiln init --from <dir>\`.`,
    )
  }

  // Load env before any provider is constructed, from the manifest's directory
  // and the cwd — the key belongs with the project, not the tool.
  const manifestDir = path.dirname(path.resolve(args.manifest))
  const envFiles = [...loadEnvFiles(manifestDir)]
  if (path.resolve(process.cwd()) !== manifestDir) envFiles.push(...loadEnvFiles(process.cwd()))

  const loaded = await loadManifest(args.manifest)
  let specs = await resolveSpecs(loaded, {
    styles: args.styles,
    assets: args.assets,
  })
  const accountCommands = new Set(["adopt", "salvage", "purge"])
  const selectedAccountProvider = accountCommands.has(args.command)
    ? accountProviderId(loaded.manifest, args.provider, args.command)
    : undefined
  if (args.provider && !selectedAccountProvider) {
    throw new Error(
      "--provider is only used by balance, adopt, salvage, purge, or workspace add.",
    )
  }
  if (selectedAccountProvider) {
    specs = specs.filter((spec) => spec.provider === selectedAccountProvider)
  }
  const accountManifest: Manifest = selectedAccountProvider
    ? {
        ...loaded.manifest,
        provider: selectedAccountProvider,
        styles: Object.fromEntries(
          Object.entries(loaded.manifest.styles).filter(
            ([, style]) => (style.provider ?? loaded.manifest.provider) === selectedAccountProvider,
          ),
        ),
      }
    : loaded.manifest
  if (
    selectedAccountProvider &&
    args.styles.some((styleId) => !accountManifest.styles[styleId])
  ) {
    throw new Error(
      `Selected style is not assigned to provider "${selectedAccountProvider}".`,
    )
  }
  const lock = await loadLock(args.lock)
  normalizeLockOutputPaths(lock, specs)

  if (args.command === "status") {
    const byStatus: Record<string, number> = {}
    for (const e of Object.values(lock.entries)) byStatus[e.status] = (byStatus[e.status] ?? 0) + 1
    if (args.json) {
      log(JSON.stringify({ entries: Object.keys(lock.entries).length, byStatus, spendByUnit: spendByUnit(lock) }, null, 2))
      return
    }
    log(`  ${Object.keys(lock.entries).length} lock entries`)
    for (const [s, n] of Object.entries(byStatus).sort()) log(`    ${s.padEnd(12)} ${n}`)
    const spend = spendByUnit(lock)
    let reported = false
    for (const [unit, amount] of Object.entries(spend).sort()) {
      if (amount) {
        log(`  recorded successful submissions: ${formatCost(unit, amount)}`)
        reported = true
      }
    }
    if (!reported) log(`  no successful submission cost recorded`)
    return
  }

  const plan = await buildPlan(specs, lock, { force: args.force })

  if (args.command === "doctor") {
    const selectedStyleIds = args.styles.length
      ? args.styles
      : Object.keys(loaded.manifest.styles)
    const providerIds = [...new Set(
      selectedStyleIds.map((styleId) =>
        loaded.manifest.styles[styleId]?.provider ?? loaded.manifest.provider),
    )].sort()
    const providers = providerIds.map((id) => {
      const factory = providerFactory(id)
      const apiKeyPresent = !factory.credentialEnv || Boolean(process.env[factory.credentialEnv])
      return {
        id,
        apiKeyPresent,
        credentialEnv: factory.credentialEnv,
        provider: !args.dryRun && apiKeyPresent ? createProvider(id, "online") : undefined,
      }
    })
    const report = await doctor(loaded, specs, lock, args.lock, {
      providers,
      offline: args.dryRun,
    })
    if (args.json) {
      log(JSON.stringify(report, null, 2))
    } else {
      for (const check of report.checks) {
        const icon = check.level === "ok" ? "ok" : check.level === "warning" ? "WARN" : "ERROR"
        log(`  ${icon.padEnd(5)} ${check.id.padEnd(14)} ${check.message}`)
      }
    }
    if (!report.ok) process.exitCode = 1
    return
  }

  if (args.command === "plan") {
    if (args.json) {
      log(JSON.stringify({
        totals: summarize(plan),
        cost: plan.cost,
        costUnit: plan.costUnit,
        candidates: plan.candidates,
        groups: plan.groups.map((group) => ({
          provider: group.provider,
          cost: group.cost,
          costUnit: group.costUnit,
          candidates: group.candidates,
          actionable: group.actionable.map((item) => item.key),
        })),
        actionable: plan.actionable.map((i) => i.key),
        items: plan.items.map(({ key, state, reason }) => ({ key, state, reason })),
      }, null, 2))
    } else {
      printPlan(plan)
    }
    if (args.check && plan.items.some((i) => i.state !== "ok")) process.exitCode = 1
    return
  }

  if (args.command === "accept") {
    // Re-baselines stale entries against the current spec without regenerating.
    // For when the style prose was reworded but the existing art is still wanted.
    let accepted = 0
    for (const item of plan.items) {
      if (item.state !== "stale") continue
      const entry = lock.entries[item.key]
      // Accepting new wording is safe; accepting a provider change would
      // relabel old remote work as if the new backend produced it.
      if (!entry || entry.provider !== item.spec.provider || entry.outputs.length === 0) continue
      let intact = true
      for (const output of entry.outputs) {
        const file = resolveOutputPath(output.path, item.spec.root)
        if (!existsSync(file) || (await sha256File(file)) !== output.sha256) {
          intact = false
          break
        }
      }
      if (!intact) continue
      upsertLock(lock, item.key, { specHash: item.spec.specHash })
      accepted++
    }
    await saveLock(args.lock, lock)
    log(`  accepted ${accepted} existing file(s) as satisfying the current spec`)
    log(`  (their artwork is unchanged; only the recorded spec hash moved)`)
    return
  }

  if (args.command === "prune") {
    // Removes lock entries no style/asset pair in the manifest resolves to.
    // These accumulate when an asset is renamed or moved between styles: the
    // old entry keeps claiming the output path the new one now owns, which is
    // `doctor`'s lock-outputs error. Until `remove` existed there was no way
    // to clear one short of hand-editing the lockfile.
    //
    // Deliberately resolved from the whole manifest rather than the filtered
    // `specs`: under `--style base` every other style's entries would look
    // undeclared, and prune would delete the lot.
    if (args.styles.length || args.assets.length) {
      throw new Error(
        "prune compares the lockfile against the entire manifest, so --style " +
          "and --only would make it delete the entries they filter out. Run it unfiltered.",
      )
    }
    const declared = new Set((await resolveSpecs(loaded)).map((s) => lockKey(s.styleId, s.assetId)))
    const orphans = Object.keys(lock.entries).filter((key) => !declared.has(key)).sort()
    if (!orphans.length) {
      log(`  every lock entry is declared by the manifest — nothing to prune`)
      return
    }

    log(`
  ${orphans.length} lock entr(ies) the manifest no longer declares:`)
    for (const key of orphans.slice(0, 20)) {
      const outputs = lock.entries[key]?.outputs ?? []
      const where = outputs[0]?.path ?? "no recorded output"
      log(`    ${key.padEnd(44)} ${where}`)
    }
    if (orphans.length > 20) log(`    … and ${orphans.length - 20} more`)

    if (args.dryRun) {
      log(`
  --dry-run: nothing removed.`)
      return
    }
    log(`
  This drops their provenance from the lockfile. The art on disk is`)
    log(`  untouched, and nothing is deleted from your provider account — but`)
    log(`  the link from those files back to the objects that made them is gone,`)
    log(`  and the objects will read as unclaimed the next time you run salvage.`)
    if (!(await confirm(`  Remove ${orphans.length} lock entr(ies)?`, args.yes))) {
      log(`  aborted`)
      return
    }

    let removed = 0
    for (const key of orphans) if (removeLock(lock, key)) removed++
    await saveLock(args.lock, lock)
    log(`  removed ${removed} lock entr(ies); ${Object.keys(lock.entries).length} remain`)
    return
  }

  if (args.command === "pack") {
    // The --inputs form is handled earlier, before the manifest is required
    // at all — reaching here means the manifest-driven (lockfile) form.
    if (args.primaryOnly && args.outputRoles.length) {
      throw new Error("pack accepts either --primary-only or --output-role, not both")
    }
    const manifestDir = path.dirname(path.resolve(args.manifest))
    const styleIds = args.styles.length ? args.styles : Object.keys(loaded.manifest.styles)

    for (const styleId of styleIds) {
      const { png, atlas, skipped, sources } = packStyle(lock, styleId, manifestDir, {
        columns: args.columns,
        outputRoles: args.outputRoles,
        primaryOnly: args.primaryOnly,
      })

      // Default beside the style's own output tree, so sheets for different
      // styles cannot overwrite each other when --out is omitted.
      const style = loaded.manifest.styles[styleId]
      const base = args.out
        ? path.resolve(args.out.replace(/\.png$/, ""))
        : path.resolve(manifestDir, style!.outDir, `${styleId}-sheet`)

      const outputs: ArtifactFile[] = [
        { path: `${base}.png`, data: png },
        { path: `${base}.json`, data: JSON.stringify(atlas, null, 2) + "\n" },
      ]
      await writeManagedArtifactBundle(`${base}.pixelkiln.json`, outputs, {
        kind: "pack",
        sources: [
          await provenanceFile("$manifest", args.manifest),
          await provenanceFile("$lock", args.lock),
          ...sources,
        ],
        options: {
          columns: args.columns ?? null,
          order: "id",
          outputRoles: [...args.outputRoles].sort(),
          primaryOnly: args.primaryOnly,
          style: styleId,
        },
      }, { force: args.force })

      log(
        `  ${styleId} — ${atlas.frames.length} sprite(s), ` +
          `${atlas.sheet.width}x${atlas.sheet.height} in ${atlas.columns} column(s)`,
      )
      log(`    ${path.relative(process.cwd(), base)}.png + .json + .pixelkiln.json`)
      for (const s of skipped) log(`    skipped ${s.id}: ${s.reason}`)
    }
    return
  }

  if (args.command === "mount") {
    const manifestDir = path.dirname(path.resolve(args.manifest))
    const styleIds = args.styles.length ? args.styles : Object.keys(loaded.manifest.styles)

    for (const styleId of styleIds) {
      const style = loaded.manifest.styles[styleId]
      if (!style?.mount) {
        // Not an error when the caller did not name a style — `mount` with no
        // --style should do the mounted ones and stay quiet about the rest.
        if (args.styles.length) {
          throw new Error(
            `Style "${styleId}" has no \`mount\` block. Add one, or use \`pack\` ` +
              `to let pixelkiln choose the layout.`,
          )
        }
        continue
      }

      const cells: Record<string, [number, number]> = {}
      const sources: Record<string, string> = {}
      const outputRoles: Record<string, string> = {}
      for (const [assetId, asset] of Object.entries(loaded.manifest.assets)) {
        if (!asset.cell) continue
        cells[assetId] = asset.cell
        if (asset.source) sources[assetId] = asset.source
        if (asset.outputRole) outputRoles[assetId] = asset.outputRole
      }

      const { png, atlas, skipped, overBase, sources: artifactSources } = mountStyle(
        lock,
        styleId,
        manifestDir,
        style.mount,
        cells,
        sources,
        outputRoles,
      )

      const out = path.resolve(manifestDir, style.mount.out)
      const metadata = out.replace(/\.png$/, "") + ".json"
      const companion = out.replace(/\.png$/, "") + ".pixelkiln.json"
      const outputs: ArtifactFile[] = [
        { path: out, data: png },
        { path: metadata, data: JSON.stringify(atlas, null, 2) + "\n" },
      ]
      await writeManagedArtifactBundle(companion, outputs, {
        kind: "mount",
        sources: [
          await provenanceFile("$manifest", args.manifest),
          await provenanceFile("$lock", args.lock),
          ...artifactSources.filter(
            (source) => source.id !== "$base" || path.resolve(source.path) !== out,
          ),
        ],
        options: {
          cellHeight: style.mount.cellHeight,
          cellWidth: style.mount.cellWidth,
          cells: Object.entries(cells).sort(([a], [b]) => a.localeCompare(b)),
          style: styleId,
        },
      }, { force: args.force })

      log(
        `  ${styleId} — ${atlas.frames.length} cell(s) into ` +
          `${atlas.sheet.width}x${atlas.sheet.height}` +
          (overBase ? ` over ${style.mount.base}` : " (new sheet)"),
      )
      log(`    ${path.relative(process.cwd(), out)} + atlas/provenance JSON`)
      for (const s of skipped) log(`    skipped ${s.id}: ${s.reason}`)
    }
    return
  }

  if (args.command === "audit") {
    const styleIds = args.styles.length ? args.styles : Object.keys(loaded.manifest.styles)
    const reports: Array<{
      audit: Awaited<ReturnType<typeof auditStyle>>
      evaluation: ReturnType<typeof evaluateAudit>
    }> = []
    for (const styleId of styleIds) {
      const audit = await auditStyle(loaded, specs, styleId, lock)
      const evaluation = evaluateAudit(audit, {
        maxDistance: args.maxDistance,
        minTransparency: args.minTransparency,
        maxColors: args.maxColors,
        sigma: args.sigma,
      })
      reports.push({ audit, evaluation })
      if (args.json) continue
      log(`\n  ${styleId} — ${audit.assets.length} asset(s) measured`)
      log(
        `  reference palette: ${audit.referenceFromStyleImages ? "style images" : "the set's own average"}` +
          `  ${audit.reference.slice(0, 6).map(hex).join(" ")}`,
      )
      if (!audit.referenceFromStyleImages) {
        log(`  (no styleImages set — this finds outliers but cannot tell you the whole set drifted)`)
      }

      const offIds = new Set(evaluation.outliers)
      log(`\n  most off-style first:`)
      for (const asset of audit.assets.slice(0, 12)) {
        const flag = offIds.has(asset.id) ? " ← outlier" : ""
        log(
          `    ${asset.id.padEnd(28)} dist ${asset.paletteDistance.toFixed(1).padStart(6)}` +
            `  colours ${String(asset.colorCount).padStart(4)}` +
            `  transparent ${(asset.transparency * 100).toFixed(0).padStart(3)}%` +
            `  ${asset.palette.slice(0, 3).map(hex).join(" ")}${flag}`,
        )
      }
      if (audit.assets.length > 12) log(`    … and ${audit.assets.length - 12} more`)
      log(`\n  ${evaluation.outliers.length} outlier(s) beyond ${evaluation.thresholds.sigma} sd`)
      if (audit.missing.length) log(`  ${audit.missing.length} asset(s) not on disk`)
      for (const u of audit.unreadable) log(`  unreadable ${u}`)
      for (const violation of evaluation.violations) {
        log(`  check ${violation.id}: ${violation.reasons.join("; ")}`)
      }
    }
    if (args.json) {
      log(JSON.stringify({
        version: 1,
        safe: reports.every((report) => report.evaluation.safe),
        styles: reports.map(({ audit, evaluation }) => ({ ...audit, evaluation })),
      }, null, 2))
    }
    if (args.check && reports.some((report) => !report.evaluation.safe)) process.exitCode = 1
    return
  }

  if (args.command === "export") {
    const format = args.format ?? "generic"
    const manifestDir = path.dirname(path.resolve(args.manifest))
    const selected = specs.filter((spec) => {
      if (spec.generator !== "tiles") return false
      if (args.styles.length && !args.styles.includes(spec.styleId)) return false
      if (args.assets.length && !args.assets.includes(spec.assetId)) return false
      return Boolean(lock.entries[lockKey(spec.styleId, spec.assetId)])
    })
    if (!selected.length) {
      throw new Error("No downloaded tiles entries match the requested --style/--only filters.")
    }
    if (args.out && selected.length > 1) {
      throw new Error("--out can name one tileset only; add --style/--only to select one asset.")
    }

    for (const spec of selected) {
      const entry = lock.entries[lockKey(spec.styleId, spec.assetId)]!
      const style = loaded.manifest.styles[spec.styleId]!
      const defaultBase = path.resolve(manifestDir, style.outDir, `${spec.assetId}-tileset`)
      const base = args.out
        ? path.resolve(args.out.replace(/\.(?:png|json|tsj|tres)$/i, ""))
        : defaultBase
      const result = exportTileset(entry, spec, {
        format,
        manifestDir,
        imageName: path.basename(`${base}.png`),
        columns: args.columns,
      })
      const outputs: ArtifactFile[] = [
        { path: `${base}.png`, data: result.png },
        { path: `${base}${result.extension}`, data: result.document },
      ]
      await writeManagedArtifactBundle(`${base}.pixelkiln.json`, outputs, {
        kind: "tileset",
        sources: [
          await provenanceFile("$manifest", args.manifest),
          await provenanceFile("$lock", args.lock),
          ...result.sources,
        ],
        options: {
          asset: spec.assetId,
          columns: args.columns ?? null,
          format,
          image: path.basename(`${base}.png`),
          providerRules: result.generic.providerRules,
          style: spec.styleId,
          tileType: spec.tileType ?? null,
        },
      }, { force: args.force })
      log(
        `  ${spec.styleId}/${spec.assetId} — ${result.generic.tiles.length} tile(s), ` +
          `${result.generic.sheet.width}x${result.generic.sheet.height} (${format})`,
      )
      log(
        `    ${path.relative(process.cwd(), base)}.png + ` +
          `${path.basename(base)}${result.extension} + .pixelkiln.json`,
      )
    }
    return
  }

  const providerMode: ProviderMode =
    args.command === "restore" || (args.command === "fetch" && !args.tag)
      ? "downloads"
      : "online"
  const providers = new Map<string, Provider>()
  const providerFor = (id: string) => {
    let resolved = providers.get(id)
    if (!resolved) {
      resolved = createProvider(id, providerMode)
      providers.set(id, resolved)
    }
    return resolved
  }
  if (args.command === "adopt") {
    const provider = providerFor(selectedAccountProvider!)
    log(`\n  Reconciling account objects against files already on disk…`)
    const res = await adopt(provider, specs, lock, args.lock, { onProgress: log })
    log(`\n  scanned ${res.scanned} remote object(s), adopted ${res.matched}`)
    if (res.ambiguous.length) {
      log(`\n  ambiguous (${res.ambiguous.length}):`)
      for (const a of res.ambiguous.slice(0, 10)) log(`    ${a}`)
    }
    if (res.unmatchedLocal.length) {
      log(`\n  local files with no matching remote object (${res.unmatchedLocal.length}):`)
      for (const u of res.unmatchedLocal.slice(0, 15)) log(`    ${u}`)
    }
    if (res.unmatchedRemote.length) {
      log(`\n  remote objects not matched by THIS manifest (${res.unmatchedRemote.length}):`)
      log(formatUnmatchedRemote(res.unmatchedRemote))
      log(
        `\n  One account is shared across projects, so this list mixes discarded\n` +
          `  candidates with assets belonging to other manifests. Do not bulk-delete\n` +
          `  it — run adopt from each project first, then \`pixelkiln salvage\` to\n` +
          `  triage what is left over.`,
      )
    }
    if (args.tag) {
      const n = await tagAdopted(provider, specs, lock, { onProgress: log })
      log(`\n  tagged ${n} object(s) upstream`)
    }
    if (args.writePrompts) {
      const { filled, stillEmpty } = await writePromptsBack(path.resolve(args.manifest), lock, {
        onProgress: log,
        provider: provider.id,
        assetIds: specs.map((spec) => spec.assetId),
      })
      log(`  recovered ${filled} prompt(s) into ${path.relative(process.cwd(), args.manifest)}`)

      // Writing prompts rewrites the manifest, which changes every spec hash.
      // Without re-baselining, an adopt that recovered the true prompts would
      // report all of its own work as stale and offer to regenerate it.
      const reloaded = await loadManifest(args.manifest)
      const rebased = (await resolveSpecs(reloaded, {
        styles: args.styles,
        assets: args.assets,
      })).filter((spec) => spec.provider === provider.id)
      let n = 0
      for (const spec of rebased) {
        const key = lockKey(spec.styleId, spec.assetId)
        if (lock.entries[key]?.status !== "downloaded") continue
        upsertLock(lock, key, { specHash: spec.specHash })
        n++
      }
      await saveLock(args.lock, lock)
      log(`  re-baselined ${n} entr(ies) against the recovered prompts`)
      if (stillEmpty.length) {
        log(`  ${stillEmpty.length} asset(s) still have no prompt (not matched upstream):`)
        for (const id of stillEmpty.slice(0, 10)) log(`    ${id}`)
        if (stillEmpty.length > 10) log(`    … and ${stillEmpty.length - 10} more`)
      }
    }
    log(`\n  lockfile written: ${args.lock}`)
    return
  }

  if (args.command === "salvage") {
    const provider = providerFor(selectedAccountProvider!)
    // --json is a machine-readable contract: stdout must be the JSON array
    // and nothing else, so `pixelkiln salvage --dry-run --json | jq` works.
    // Every human-oriented line below goes through `diag` instead of `log` so
    // it lands on stderr — visible in a terminal, invisible to a pipe — and
    // only the final JSON.stringify call ever reaches console.log.
    const jsonMode = args.dryRun && args.json
    const diag = jsonMode ? (msg = "") => console.error(msg) : log

    // Correctness depends on a complete claim set. Missing a lockfile makes
    // another project's shipped art look unclaimed, so this is stated loudly.
    // This project's own lockfile is optional — salvage is a reasonable first
    // command in a fresh project, which has none yet. Paths given via --claims
    // are required, because a typo there silently widens the orphan set.
    const ownLock = path.resolve(args.lock)
    let workspaceProjects: WorkspaceProject[] = []
    let workspaceDir = ""
    if (args.workspace) {
      const workspacePath = path.resolve(args.workspace)
      workspaceDir = path.dirname(workspacePath)
      const complete = await requireCompleteWorkspaceClaims(workspacePath)
      workspaceProjects = complete.ws.projects
      for (const d of complete.diagnostics) diag(`  WARN  ${d.id}: ${d.message}`)
    }
    const workspaceLockPaths = workspaceProjects.map((p) => resolveProject(workspaceDir, p).lockPath)
    const lockPaths = [
      ...new Set([
        ...workspaceLockPaths,
        ...(existsSync(ownLock) ? [ownLock] : []),
        ...args.claims.map((c) => path.resolve(c)),
      ]),
    ]
    diag(`  claim set (${lockPaths.length} lockfile(s)):`)
    for (const p of lockPaths) diag(`    ${path.relative(process.cwd(), p)}`)
    if (!args.claims.length && !args.workspace) {
      diag(
        `\n  Only this project's lockfile was consulted. If the account is shared,\n` +
          `  pass every other project's lockfile via --claims a.json,b.json, or\n` +
          `  register every project in a workspace catalog and pass --workspace.`,
      )
    } else if (
      args.workspace &&
      !workspaceProjects.some((p) => resolveProject(workspaceDir, p).manifestPath === path.resolve(args.manifest))
    ) {
      diag(
        `\n  This project's manifest is not registered in the workspace catalog. Its own\n` +
          `  lockfile is still included above, so this run's claim set is complete — but\n` +
          `  \`pixelkiln workspace add ${args.manifest}\` would keep it aggregated too.`,
      )
    }

    const claimed = await loadClaims(lockPaths, { provider: provider.id })
    const { orphans, total } = await findOrphans(provider, claimed, { onProgress: diag })
    diag(`  ${claimed.size} claimed · ${orphans.length} unclaimed of ${total}`)
    if (!orphans.length) {
      if (jsonMode) log("[]")
      else log(`\n  nothing to triage`)
      return
    }

    // Each sibling project's manifest, loaded purely so a single-style
    // manifest — which has no pattern of its own to check against — can still
    // recognise "this looks like project X's art" instead of silently
    // claiming everything by default.
    const siblings = await loadSiblingManifests(
      args.manifest,
      workspaceProjects.map((p) => resolveProject(workspaceDir, p).manifestPath),
      args.claims,
    )

    // Which style each orphan's prompt was most likely generated from, so a
    // shared account's orphan pool doesn't get triaged as one undifferentiated
    // blob under whichever style happens to be first in the manifest.
    const { matched, unmatched, elsewhere } = groupOrphansByStyle(orphans, accountManifest, siblings)
    const multiStyle = Object.keys(accountManifest.styles).length > 1
    if (multiStyle) {
      diag(`\n  by style (matched against each style's prompt prefix/suffix):`)
      for (const [id, list] of matched) diag(`    ${id.padEnd(24)} ${list.length}`)
      if (unmatched.length) diag(`    ${"(no style match)".padEnd(24)} ${unmatched.length}`)
    }
    if (elsewhere.size) {
      diag(`\n  matched a sibling project's own style instead of this one:`)
      for (const [label, list] of elsewhere) diag(`    ${label.padEnd(28)} ${list.length}`)
      diag(`  excluded from every session below — not this project's art.`)
    }
    if (unmatched.length) {
      diag(
        `\n  ${unmatched.length} object(s) don't match any known style pattern.\n` +
          `  If the account is shared, they may belong to a different project — check\n` +
          `  you've passed every sibling project's lockfile via --claims. They're left\n` +
          `  out of the sessions below; force them into one style with --style <id>.`,
      )
    }

    if (args.dryRun) {
      if (args.json) {
        log(JSON.stringify(orphans, null, 2))
      } else {
        const shown = args.all ? orphans : orphans.slice(0, 30)
        for (const o of shown) {
          log(`    ${o.id}  ${o.width}x${o.height}  ${o.createdAt.slice(0, 10)}  ${o.prompt.slice(0, 50)}`)
        }
        if (!args.all && orphans.length > 30) {
          log(`    … and ${orphans.length - 30} more (--all for the full list, --json for machine-readable)`)
        }
      }
      diag(`\n  --dry-run: nothing changed.`)
      return
    }

    const rebaseline = async () => {
      // Imports append to the manifest, so their spec hashes only exist after
      // it is rewritten. Without this every salvaged asset reports `stale` on
      // the next plan and offers to regenerate art that was just recovered —
      // which would re-pay for all of it.
      const reloaded = await loadManifest(args.manifest)
      const rebased = (await resolveSpecs(reloaded)).filter((spec) => spec.provider === provider.id)
      let n = 0
      for (const spec of rebased) {
        const key = lockKey(spec.styleId, spec.assetId)
        const entry = lock.entries[key]
        if (entry?.status !== "downloaded" || entry.specHash !== SALVAGED_SPEC_HASH) continue
        upsertLock(lock, key, { specHash: spec.specHash })
        n++
      }
      await saveLock(args.lock, lock)
      if (n) log(`  baselined ${n} imported asset(s) against the manifest`)
    }

    const runOne = async (styleId: string, list: typeof orphans) => {
      const style = accountManifest.styles[styleId]!
      const res = await runSalvage(
        provider,
        list,
        {
          manifestPath: loaded.path,
          manifest: accountManifest,
          styleId,
          importDir: path.resolve(loaded.root, style.outDir),
          lock,
          lockPath: args.lock,
        },
        { port: args.port, open: !args.noOpen, onProgress: log },
      )
      log(
        `  imported ${res.imported} · kept ${res.kept} · tagged-discard ${res.discarded}` +
          (res.failed ? ` · failed ${res.failed}` : ""),
      )
      if (res.imported > 0) await rebaseline()
      return res
    }

    // An explicit --style bypasses grouping entirely and runs one session
    // across every unclaimed object, same as before grouping existed — for
    // when the auto-match misses a real candidate and a human already knows
    // where it belongs.
    if (args.styles.length) {
      const res = await runOne(args.styles[0]!, orphans)
      if (res.discarded) {
        log(`\n  Nothing was deleted. To actually remove the discarded objects:`)
        log(`    pixelkiln purge\n`)
      }
      return
    }

    if (!matched.size) {
      log(`\n  nothing matched a known style — nothing to triage`)
      return
    }

    log(`\n  ${matched.size} session(s), one style at a time:`)
    let totalDiscarded = 0
    for (const [styleId, list] of matched) {
      log(`\n  — ${styleId} (${list.length}) —`)
      const res = await runOne(styleId, list)
      totalDiscarded += res.discarded
    }
    if (totalDiscarded) {
      log(`\n  Nothing was deleted. To actually remove the discarded objects:`)
      log(`    pixelkiln purge\n`)
    }
    return
  }

  if (args.command === "purge") {
    const provider = providerFor(selectedAccountProvider!)
    const doomed: { id: string; prompt: string }[] = []
    for await (const obj of requireList(provider)()) {
      if (obj.tags.includes("pixelkiln:discard")) {
        doomed.push({ id: obj.id, prompt: obj.prompt })
      }
    }
    if (!doomed.length) {
      log(`  nothing tagged pixelkiln:discard — run \`pixelkiln salvage\` first`)
      return
    }
    log(`\n  ${doomed.length} object(s) tagged for discard:`)
    for (const d of doomed.slice(0, 20)) log(`    ${d.id}  ${d.prompt.slice(0, 60)}`)
    if (doomed.length > 20) log(`    … and ${doomed.length - 20} more`)

    if (args.dryRun) {
      log(`\n  --dry-run: nothing deleted.`)
      return
    }
    log(`\n  This permanently deletes them from your ${provider.id} account.`)
    log(`  Any local files already downloaded are untouched, but the objects`)
    log(`  and their URLs are gone and cannot be re-downloaded.`)
    if (!(await confirm(`  Delete ${doomed.length} object(s)?`, args.yes))) {
      log(`  aborted`)
      return
    }

    let deleted = 0
    let failed = 0
    for (const d of doomed) {
      try {
        await requireDelete(provider)(d.id)
        deleted++
      } catch (err) {
        failed++
        log(`  delete failed ${d.id}: ${err instanceof Error ? err.message : String(err)}`)
      }
    }
    log(`\n  deleted ${deleted}${failed ? `, failed ${failed}` : ""}`)
    return
  }

  if (args.command === "tag") {
    let tagged = 0
    for (const [providerId, providerSpecsForRun] of specsByRecordedProvider(specs, lock)) {
      tagged += await pushTags(providerFor(providerId), providerSpecsForRun, lock, {
        onProgress: log,
      })
    }
    log(`  tagged ${tagged} object(s)`)
    return
  }

  if (args.command === "submit" || args.command === "gen") {
    printPlan(plan)
    if (args.dryRun) {
      log(`\n  --dry-run: stopping before any spend.`)
      return
    }
    if (plan.actionable.length) {
      const budgets = budgetsForPlan(plan, args)
      const balances = new Map<string, BalanceInfo | null>()
      // Validate every ceiling and available balance before the first provider
      // can spend. A later group must never reveal that the whole run was
      // unaffordable only after an earlier group already submitted work.
      for (const group of plan.groups) {
        const groupProvider = providerFor(group.provider)
        const balance = groupProvider.balance ? await groupProvider.balance() : null
        balances.set(group.provider, balance)
        if (balance) {
          log(
            `\n  balance: ${formatCost(balance.unit, balance.remaining)} remaining ` +
              `(${group.provider})`,
          )
          if (balance.unit !== group.costUnit) {
            throw new Error(
              `Provider ${group.provider} estimate unit ${group.costUnit} does not match ` +
                `balance unit ${balance.unit}.`,
            )
          }
          if (balance.unit !== "free" && group.cost > balance.remaining) {
            throw new Error(
              `${group.provider} needs ${formatCost(balance.unit, group.cost)} but only ` +
                `${formatCost(balance.unit, balance.remaining)} remain.`,
            )
          }
        } else {
          log(
            `\n  ${group.provider} does not expose an account balance; ` +
              `enforcing its run budget`,
          )
        }
        const ceiling = budgets.get(group.provider)
        if (ceiling !== undefined && group.cost > ceiling) {
          throw new Error(
            `${group.provider} would spend ${formatCost(group.costUnit, group.cost)} but its ` +
              `budget is ${formatCost(group.costUnit, ceiling)}.`,
          )
        }
      }
      const spendSummary = plan.groups
        .map((group) => `${group.provider} ${formatCost(group.costUnit, group.cost)}`)
        .join("; ")
      const ok = await confirm(
        `  Spend ${spendSummary} on ${plan.actionable.length} asset(s)?`,
        args.yes,
      )
      if (!ok) {
        log(`  aborted`)
        return
      }
      log(`\n  submitting…`)
      for (const group of plan.groups) {
        const groupProvider = providerFor(group.provider)
        const res = await submit(groupProvider, loaded, group.actionable, lock, args.lock, {
          budget: budgets.get(group.provider),
          onProgress: log,
        })
        log(
          `\n  ${group.provider}: submitted ${res.submitted}, failed ${res.failed}, ` +
            `estimated ${formatCost(res.unit, res.spent)}`,
        )
        try {
          const before = balances.get(group.provider)
          const after = before && groupProvider.balance ? await groupProvider.balance() : null
          if (!before || !after) throw new Error("balance reporting is unsupported")
          const measured = measureBalanceChange(before, after)
          if (measured) {
            const movement = measured.credited
              ? `${formatCost(measured.unit, measured.credited)} credited`
              : `${formatCost(measured.unit, measured.spent)} consumed`
            log(`  ${group.provider} balance change: ${movement}`)
          } else {
            log(`  ${group.provider} changed balance units; no delta reported`)
          }
        } catch (err) {
          log(
            `  ${group.provider} balance recheck unavailable: ` +
              `${err instanceof Error ? err.message : String(err)}`,
          )
        }
        if (res.failed) process.exitCode = 1
      }
    }
    if (args.command === "submit") return
  }

  if (args.command === "poll" || args.command === "gen") {
    log(`\n  polling…`)
    const total = { completed: 0, review: 0, failed: 0, stillRunning: 0 }
    for (const [providerId, providerSpecsForRun] of specsByRecordedProvider(specs, lock)) {
      const res = await poll(providerFor(providerId), lock, args.lock, {
        onProgress: log,
        specs: providerSpecsForRun,
      })
      total.completed += res.completed
      total.review += res.review
      total.failed += res.failed
      total.stillRunning += res.stillRunning
    }
    log(
      `\n  ${total.completed} ready · ${total.review} awaiting selection · ` +
        `${total.failed} failed`,
    )
    if (total.failed || total.stillRunning) process.exitCode = 1
    if (args.command === "poll") return
  }

  if (args.command === "pick" || args.command === "gen") {
    const total = { selected: 0, skipped: 0 }
    for (const [providerId, providerSpecsForRun] of specsByRecordedProvider(specs, lock)) {
      const res = await runPicker(providerFor(providerId), lock, args.lock, {
        port: args.port,
        open: !args.noOpen,
        onProgress: log,
        keys: providerSpecsForRun.map((spec) => lockKey(spec.styleId, spec.assetId)),
      })
      total.selected += res.selected
      total.skipped += res.skipped
    }
    if (total.selected === 0 && total.skipped === 0) {
      log(`  nothing awaiting selection`)
    } else {
      log(`\n  selected ${total.selected}, left in review ${total.skipped}`)
    }
    if (args.command === "gen" && total.skipped) process.exitCode = 1
    if (args.command === "pick") return
  }

  if (args.command === "fetch" || args.command === "restore" || args.command === "gen") {
    log(`\n  downloading…`)
    const total = { downloaded: 0, skipped: 0, failed: 0, tagged: 0 }
    for (const [providerId, providerSpecsForRun] of specsByRecordedProvider(specs, lock)) {
      const groupProvider = providerFor(providerId)
      const res = await fetchAssets(groupProvider, providerSpecsForRun, lock, args.lock, {
        onProgress: log,
        repair: args.command === "restore",
      })
      total.downloaded += res.downloaded
      total.skipped += res.skipped
      total.failed += res.failed
      if (args.tag) {
        total.tagged += await pushTags(groupProvider, providerSpecsForRun, lock, {
          onProgress: log,
        })
      }
    }
    log(
      `\n  downloaded ${total.downloaded}, skipped ${total.skipped}, failed ${total.failed}`,
    )
    if (total.failed) process.exitCode = 1
    if (args.tag) log(`  tagged ${total.tagged} object(s) upstream`)
    await saveLock(args.lock, lock)
    log(`  lockfile written: ${args.lock}`)
    return
  }

  log(HELP)
}

main().catch((err) => {
  console.error(`\n  error: ${err instanceof Error ? err.message : String(err)}\n`)
  process.exit(1)
})
