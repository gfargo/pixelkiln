#!/usr/bin/env node
import path from "node:path"
import { existsSync, mkdirSync, writeFileSync } from "node:fs"
import { readFile } from "node:fs/promises"
import { loadEnvFiles } from "./env.ts"
import { PixelLabProvider } from "./providers/pixellab.ts"
import { formatCost, measureBalanceChange, requireDelete, requireList } from "./provider.ts"
import { loadManifest, resolveSpecs } from "./manifest.ts"
import { mountStyle, packSprites, packStyle, resolvePackInputs } from "./pipeline/pack.ts"
import { loadLock, saveLock, spendByUnit, upsert as upsertLock } from "./lock.ts"
import { sha256File } from "./hash.ts"
import { lockKey } from "./types.ts"
import { normalizeLockOutputPaths, resolveOutputPath } from "./outputs.ts"
import { buildPlan, summarize, type Plan } from "./pipeline/plan.ts"
import { submit } from "./pipeline/submit.ts"
import { poll } from "./pipeline/poll.ts"
import { fetchAssets, pushTags } from "./pipeline/fetch.ts"
import { doctor } from "./pipeline/doctor.ts"
import { adopt, formatUnmatchedRemote, tagAdopted, writePromptsBack } from "./pipeline/adopt.ts"
import { runPicker } from "./pick/server.ts"
import { scanAssets, buildManifest, writeManifestFile } from "./pipeline/init.ts"
import { loadClaims, findOrphans, groupOrphansByStyle, SALVAGED_SPEC_HASH } from "./pipeline/salvage.ts"
import { auditStyle, evaluateAudit, hex } from "./pipeline/audit.ts"
import { inspectCaches } from "./pipeline/cache-health.ts"
import { exportTileset, type TilesetFormat } from "./pipeline/tileset-export.ts"
import { runSalvage } from "./pick/salvage-server.ts"
import type { Provider } from "./provider.ts"

const log = (msg = "") => console.log(msg)

interface Args {
  command: string
  manifest: string
  lock: string
  styles: string[]
  assets: string[]
  force: boolean
  yes: boolean
  budget?: number
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
}

const VALUE_FLAGS = [
  "--manifest", "--lock", "--style", "--only", "--budget", "--port",
  "--from", "--out", "--generator", "--exclude", "--name", "--claims", "--columns", "--inputs", "--format",
  "--output-role", "--max-distance", "--min-transparency", "--max-colors", "--sigma",
] as const
const BOOL_FLAGS = [
  "--force", "--yes", "-y", "--dry-run", "--all", "--json", "--check", "--no-open", "--tag", "--write-prompts", "--primary-only", "--prune",
] as const

export const COMMANDS = [
  "init", "plan", "doctor", "gen", "submit", "poll", "pick", "fetch", "restore", "adopt", "accept",
  "salvage", "purge", "audit", "cache", "pack", "mount", "export", "tag", "balance", "status", "help", "--help", "-h", "--version", "-v",
] as const

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

  const rest = argv.slice(1)
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
  const rawBudget = get("--budget")
  if (rawBudget !== undefined) {
    budget = Number(rawBudget)
    // NaN would compare false against every cost and silently disable the cap.
    if (!Number.isFinite(budget) || budget < 0) {
      throw new Error(`--budget must be a non-negative number, got "${rawBudget}".`)
    }
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
  return {
    command,
    manifest,
    lock: get("--lock") ?? path.join(path.dirname(path.resolve(manifest)), "pixelkiln.lock.json"),
    styles: list("--style"),
    assets: list("--only"),
    force: rest.includes("--force"),
    yes: rest.includes("--yes") || rest.includes("-y"),
    budget,
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
  }
}

const HELP = `pixelkiln — manifest-driven pixel art generation (PixelLab)

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
  cache     Inspect local recovery/object-hash caches; optionally verify or prune.
  pack      Composite a style's sprites into one sheet + JSON atlas. Offline.
  mount     Write a style's sprites into their declared cells of an existing
            sheet, leaving every other pixel untouched. Offline.
  export    Build an engine-ready tile atlas and generic, Tiled, or Godot metadata.
  purge     Delete objects previously tagged discard. Irreversible; asks first.
  tag       Push manifest tags to the objects upstream (free).
  balance   Show the provider's remaining balance.
  status    Summarise the lockfile.

Options
  --columns <n>       pack/export: sprites or tiles per row (default: near-square)
  --port <n>          Local review-server port (default: choose a free port)
  --inputs <path>     pack: JSON [{id,path}] instead of the lockfile; needs --out
  --format <format>   export: generic (default), tiled, or godot
  --output-role <r>   pack: include only this output role (repeatable)
  --primary-only      pack: include only unambiguous primary/single outputs
  --max-distance <n>  audit: maximum palette distance
  --min-transparency <0..1>  audit: minimum transparent canvas share
  --max-colors <n>    audit: maximum distinct opaque colors
  --sigma <n>         audit: relative outlier cutoff (default: 1.5)
  --prune             cache: remove invalid/unreferenced local cache data
  --manifest <path>   Default: pixelkiln.manifest.json
  --lock <path>       Default: pixelkiln.lock.json beside the manifest
  --style a,b         Restrict to these styles
  --only id1,id2      Restrict to these asset ids
  --budget <n>        Refuse to spend more than n provider cost units
  --force             Regenerate even if up to date
  --dry-run           Never spend; doctor also skips provider connectivity
  --all               salvage --dry-run: list every unclaimed object, not just the first 30
  --json              Machine-readable output where supported, including plan/audit/doctor/cache
  --check             plan/audit/cache: exit nonzero when the selected state is unsafe
  --yes, -y           Skip the confirmation prompt
  --no-open           Do not auto-open the browser during pick
  --tag               Also push tags upstream after fetch
  --claims a.json,b   Other projects' lockfiles (salvage; required if account is shared)
  --from <dir>        Source tree for init
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
    log(
      `  would generate ${plan.actionable.length} asset(s) — ${formatCost(plan.costUnit, plan.cost)}, ` +
        `yielding ${plan.candidates} candidate/output image(s)`,
    )
  } else {
    log(`  nothing to generate`)
  }
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

  if (args.command === "balance") {
    loadEnvFiles(path.dirname(path.resolve(args.manifest)))
    loadEnvFiles(process.cwd())
    const p = PixelLabProvider.fromEnv()
    const b = await p.balance()
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

    const { png, atlas, skipped } = packSprites(inputs, { columns: args.columns })
    const base = path.resolve(args.out.replace(/\.png$/, ""))
    // --out is free-form, and a caller building a path under a scratch
    // directory (as heybud-admin's sync script does) should not also have to
    // pre-create it.
    mkdirSync(path.dirname(base), { recursive: true })
    writeFileSync(`${base}.png`, png)
    writeFileSync(`${base}.json`, JSON.stringify(atlas, null, 2) + "\n")
    log(
      `  ${atlas.frames.length} sprite(s), ${atlas.sheet.width}x${atlas.sheet.height} ` +
        `in ${atlas.columns} column(s) — ${(png.length / 1024).toFixed(1)} KB`,
    )
    log(`    ${path.relative(process.cwd(), base)}.png + .json`)
    for (const s of skipped) log(`    skipped ${s.id}: ${s.reason}`)
    return
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
  const estimator = PixelLabProvider.forOffline()
  const specs = await resolveSpecs(loaded, {
    styles: args.styles,
    assets: args.assets,
    provider: estimator,
  })
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
    for (const unit of ["generations", "usd", "free"] as const) {
      if (spend[unit]) {
        log(`  recorded successful submissions: ${formatCost(unit, spend[unit])}`)
        reported = true
      }
    }
    if (!reported) log(`  no successful submission cost recorded`)
    return
  }

  const plan = await buildPlan(specs, lock, { force: args.force })

  if (args.command === "doctor") {
    const apiKeyPresent = Boolean(process.env.PIXELLAB_API_KEY)
    const provider = !args.dryRun && apiKeyPresent ? PixelLabProvider.fromEnv() : undefined
    const report = await doctor(loaded, specs, lock, args.lock, {
      provider,
      offline: args.dryRun,
      apiKeyPresent,
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
      if (!entry || entry.outputs.length === 0) continue
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

  if (args.command === "pack") {
    // The --inputs form is handled earlier, before the manifest is required
    // at all — reaching here means the manifest-driven (lockfile) form.
    if (args.primaryOnly && args.outputRoles.length) {
      throw new Error("pack accepts either --primary-only or --output-role, not both")
    }
    const manifestDir = path.dirname(path.resolve(args.manifest))
    const styleIds = args.styles.length ? args.styles : Object.keys(loaded.manifest.styles)

    for (const styleId of styleIds) {
      const { png, atlas, skipped } = packStyle(lock, styleId, manifestDir, {
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

      mkdirSync(path.dirname(base), { recursive: true })
      writeFileSync(`${base}.png`, png)
      writeFileSync(`${base}.json`, JSON.stringify(atlas, null, 2) + "\n")

      log(
        `  ${styleId} — ${atlas.frames.length} sprite(s), ` +
          `${atlas.sheet.width}x${atlas.sheet.height} in ${atlas.columns} column(s)`,
      )
      log(`    ${path.relative(process.cwd(), base)}.png + .json`)
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

      const { png, atlas, skipped, overBase } = mountStyle(
        lock,
        styleId,
        manifestDir,
        style.mount,
        cells,
        sources,
        outputRoles,
      )

      const out = path.resolve(manifestDir, style.mount.out)
      mkdirSync(path.dirname(out), { recursive: true })
      writeFileSync(out, png)
      writeFileSync(out.replace(/\.png$/, "") + ".json", JSON.stringify(atlas, null, 2) + "\n")

      log(
        `  ${styleId} — ${atlas.frames.length} cell(s) into ` +
          `${atlas.sheet.width}x${atlas.sheet.height}` +
          (overBase ? ` over ${style.mount.base}` : " (new sheet)"),
      )
      log(`    ${path.relative(process.cwd(), out)}`)
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
      mkdirSync(path.dirname(base), { recursive: true })
      writeFileSync(`${base}.png`, result.png)
      writeFileSync(`${base}${result.extension}`, result.document)
      log(
        `  ${spec.styleId}/${spec.assetId} — ${result.generic.tiles.length} tile(s), ` +
          `${result.generic.sheet.width}x${result.generic.sheet.height} (${format})`,
      )
      log(`    ${path.relative(process.cwd(), base)}.png + ${path.basename(base)}${result.extension}`)
    }
    return
  }

  const provider: Provider =
    args.command === "restore" || (args.command === "fetch" && !args.tag)
      ? PixelLabProvider.forDownloads()
      : PixelLabProvider.fromEnv()

  if (args.command === "adopt") {
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
      })
      log(`  recovered ${filled} prompt(s) into ${path.relative(process.cwd(), args.manifest)}`)

      // Writing prompts rewrites the manifest, which changes every spec hash.
      // Without re-baselining, an adopt that recovered the true prompts would
      // report all of its own work as stale and offer to regenerate it.
      const reloaded = await loadManifest(args.manifest)
      const rebased = await resolveSpecs(reloaded, {
        styles: args.styles,
        assets: args.assets,
        provider,
      })
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
    const lockPaths = [
      ...(existsSync(ownLock) ? [ownLock] : []),
      ...args.claims.map((c) => path.resolve(c)),
    ]
    diag(`  claim set (${lockPaths.length} lockfile(s)):`)
    for (const p of lockPaths) diag(`    ${path.relative(process.cwd(), p)}`)
    if (!args.claims.length) {
      diag(
        `\n  Only this project's lockfile was consulted. If the account is shared,\n` +
          `  pass every other project's lockfile via --claims a.json,b.json or you\n` +
          `  will see their assets listed as unclaimed.`,
      )
    }

    const claimed = await loadClaims(lockPaths)
    const { orphans, total } = await findOrphans(provider, claimed, { onProgress: diag })
    diag(`  ${claimed.size} claimed · ${orphans.length} unclaimed of ${total}`)
    if (!orphans.length) {
      if (jsonMode) log("[]")
      else log(`\n  nothing to triage`)
      return
    }

    // Each --claims lockfile's sibling manifest (same directory, by the same
    // convention --lock defaults from --manifest), loaded purely so a
    // single-style manifest — which has no pattern of its own to check
    // against — can still recognise "this looks like project X's art"
    // instead of silently claiming everything by default. Best-effort: a
    // missing or malformed sibling just means no extra signal, not an error.
    const siblings: { label: string; manifest: typeof loaded.manifest }[] = []
    for (const claimPath of args.claims.map((c) => path.resolve(c))) {
      const siblingManifestPath = path.join(path.dirname(claimPath), "pixelkiln.manifest.json")
      if (!existsSync(siblingManifestPath)) continue
      try {
        const siblingLoaded = await loadManifest(siblingManifestPath)
        siblings.push({ label: path.basename(path.dirname(siblingManifestPath)), manifest: siblingLoaded.manifest })
      } catch {
        // Not this run's problem to solve — the orphan just gets no extra signal.
      }
    }

    // Which style each orphan's prompt was most likely generated from, so a
    // shared account's orphan pool doesn't get triaged as one undifferentiated
    // blob under whichever style happens to be first in the manifest.
    const { matched, unmatched, elsewhere } = groupOrphansByStyle(orphans, loaded.manifest, siblings)
    const multiStyle = Object.keys(loaded.manifest.styles).length > 1
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
      const rebased = await resolveSpecs(reloaded, { provider })
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
      const style = loaded.manifest.styles[styleId]!
      const res = await runSalvage(
        provider,
        list,
        {
          manifestPath: loaded.path,
          manifest: loaded.manifest,
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
    log(`\n  This permanently deletes them from your PixelLab account.`)
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
    const n = await pushTags(provider, specs, lock, { onProgress: log })
    log(`  tagged ${n} object(s)`)
    return
  }

  if (args.command === "submit" || args.command === "gen") {
    printPlan(plan)
    if (args.dryRun) {
      log(`\n  --dry-run: stopping before any spend.`)
      return
    }
    if (plan.actionable.length) {
      const balance = await provider.balance()
      log(`\n  balance: ${formatCost(balance.unit, balance.remaining)} remaining (${provider.id})`)
      if (balance.unit !== plan.costUnit) {
        throw new Error(
          `Provider estimate unit ${plan.costUnit} does not match balance unit ${balance.unit}.`,
        )
      }
      if (balance.unit !== "free" && plan.cost > balance.remaining) {
        throw new Error(
          `This run needs ${formatCost(balance.unit, plan.cost)} but only ` +
            `${formatCost(balance.unit, balance.remaining)} remain.`,
        )
      }
      const ok = await confirm(
        `  Spend ${formatCost(balance.unit, plan.cost)} on ${plan.actionable.length} asset(s)?`,
        args.yes,
      )
      if (!ok) {
        log(`  aborted`)
        return
      }
      log(`\n  submitting…`)
      const res = await submit(provider, loaded, plan.actionable, lock, args.lock, {
        budget: args.budget,
        onProgress: log,
      })
      log(
        `\n  submitted ${res.submitted}, failed ${res.failed}, ` +
          `estimated ${formatCost(res.unit, res.spent)}`,
      )
      try {
        const after = await provider.balance()
        const measured = measureBalanceChange(balance, after)
        if (measured) {
          const movement = measured.credited
            ? `${formatCost(measured.unit, measured.credited)} credited`
            : `${formatCost(measured.unit, measured.spent)} consumed`
          log(`  provider-reported balance change: ${movement}`)
        } else {
          log(`  provider changed balance units during the run; no delta reported`)
        }
      } catch (err) {
        log(`  provider balance recheck unavailable: ${err instanceof Error ? err.message : String(err)}`)
      }
      if (res.failed) process.exitCode = 1
    }
    if (args.command === "submit") return
  }

  if (args.command === "poll" || args.command === "gen") {
    log(`\n  polling…`)
    const res = await poll(provider, lock, args.lock, { onProgress: log, specs })
    log(`\n  ${res.completed} ready · ${res.review} awaiting selection · ${res.failed} failed`)
    if (res.failed || res.stillRunning) process.exitCode = 1
    if (args.command === "poll") return
  }

  if (args.command === "pick" || args.command === "gen") {
    const res = await runPicker(provider, lock, args.lock, {
      port: args.port,
      open: !args.noOpen,
      onProgress: log,
    })
    if (res.selected === 0 && res.skipped === 0) {
      log(`  nothing awaiting selection`)
    } else {
      log(`\n  selected ${res.selected}, left in review ${res.skipped}`)
    }
    if (args.command === "gen" && res.skipped) process.exitCode = 1
    if (args.command === "pick") return
  }

  if (args.command === "fetch" || args.command === "restore" || args.command === "gen") {
    log(`\n  downloading…`)
    const res = await fetchAssets(provider, specs, lock, args.lock, {
      onProgress: log,
      repair: args.command === "restore",
    })
    log(`\n  downloaded ${res.downloaded}, skipped ${res.skipped}, failed ${res.failed}`)
    if (res.failed) process.exitCode = 1
    if (args.tag) {
      const n = await pushTags(provider, specs, lock, { onProgress: log })
      log(`  tagged ${n} object(s) upstream`)
    }
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
