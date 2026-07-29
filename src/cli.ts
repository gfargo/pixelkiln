#!/usr/bin/env node
import path from "node:path"
import { existsSync } from "node:fs"
import { clientFromEnv } from "./client.ts"
import { loadManifest, resolveSpecs } from "./manifest.ts"
import { loadLock, saveLock, totalSpend, upsert as upsertLock } from "./lock.ts"
import { sha256File } from "./hash.ts"
import { buildPlan, summarize, type Plan } from "./pipeline/plan.ts"
import { submit } from "./pipeline/submit.ts"
import { poll } from "./pipeline/poll.ts"
import { fetchAssets, pushTags } from "./pipeline/fetch.ts"
import { adopt, formatUnmatchedRemote, tagAdopted } from "./pipeline/adopt.ts"
import { runPicker } from "./pick/server.ts"

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
  noOpen: boolean
  tag: boolean
}

function parseArgs(argv: string[]): Args {
  const [command = "help"] = argv
  const get = (flag: string) => {
    const i = argv.indexOf(flag)
    return i >= 0 ? argv[i + 1] : undefined
  }
  const list = (flag: string) =>
    (get(flag) ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean)

  const manifest = get("--manifest") ?? "sprites.manifest.json"
  return {
    command,
    manifest,
    lock: get("--lock") ?? path.join(path.dirname(path.resolve(manifest)), "sprites.lock.json"),
    styles: list("--style"),
    assets: list("--only"),
    force: argv.includes("--force"),
    yes: argv.includes("--yes") || argv.includes("-y"),
    budget: get("--budget") ? Number(get("--budget")) : undefined,
    dryRun: argv.includes("--dry-run"),
    noOpen: argv.includes("--no-open"),
    tag: argv.includes("--tag"),
  }
}

const HELP = `spritesmith — manifest-driven pixel art generation (PixelLab)

  spritesmith <command> [options]

Commands
  plan      Diff manifest against lockfile and disk. Costs nothing. Start here.
  gen       Full run: submit → poll → pick → fetch. The everyday command.
  submit    Queue generation jobs only.
  poll      Advance in-flight jobs to their settled state.
  pick      Open the contact sheet to choose among candidates.
  fetch     Download selected objects to their manifest paths.
  adopt     Match existing account objects to files already in the repo.
  accept    Keep existing art after a style reword — re-baseline, do not regenerate.
  tag       Push manifest tags to the objects upstream (free).
  balance   Show remaining generations.
  status    Summarise the lockfile.

Options
  --manifest <path>   Default: sprites.manifest.json
  --lock <path>       Default: sprites.lock.json beside the manifest
  --style a,b         Restrict to these styles
  --only id1,id2      Restrict to these asset ids
  --budget <n>        Refuse to spend more than n generations
  --force             Regenerate even if up to date
  --dry-run           Plan only; never spend
  --yes, -y           Skip the confirmation prompt
  --no-open           Do not auto-open the browser during pick
  --tag               Also push tags upstream after fetch

Examples
  spritesmith plan
  spritesmith gen --style heybud-premium --budget 400
  spritesmith gen --only first_review --force
  spritesmith adopt --tag
`

function printPlan(plan: Plan): void {
  const counts = summarize(plan)
  const order = ["missing", "stale", "failed", "in-flight", "orphaned", "ok"] as const
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
    `\n  totals: ${counts.ok} ok · ${counts.missing} missing · ${counts.stale} stale · ` +
      `${counts["in-flight"]} in-flight · ${counts.orphaned} orphaned · ${counts.failed} failed`,
  )
  if (plan.actionable.length) {
    log(
      `  would generate ${plan.actionable.length} asset(s) — ${plan.cost} generations, ` +
        `yielding ${plan.candidates} candidate image(s)`,
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

  if (args.command === "balance") {
    const b = await clientFromEnv().balance()
    log(`  plan:        ${b.plan}`)
    log(`  generations: ${b.generations} of ${b.total} remaining`)
    log(`  credits:     $${b.usd.toFixed(2)}`)
    return
  }

  if (!existsSync(path.resolve(args.manifest))) {
    throw new Error(
      `No manifest at ${path.resolve(args.manifest)}. Pass --manifest, or create one (see README).`,
    )
  }

  const loaded = await loadManifest(args.manifest)
  const specs = await resolveSpecs(loaded, { styles: args.styles, assets: args.assets })
  const lock = await loadLock(args.lock)

  if (args.command === "status") {
    const byStatus: Record<string, number> = {}
    for (const e of Object.values(lock.entries)) byStatus[e.status] = (byStatus[e.status] ?? 0) + 1
    log(`  ${Object.keys(lock.entries).length} lock entries`)
    for (const [s, n] of Object.entries(byStatus).sort()) log(`    ${s.padEnd(12)} ${n}`)
    log(`  generations recorded as spent: ${totalSpend(lock)}`)
    return
  }

  const plan = await buildPlan(specs, lock, { force: args.force })

  if (args.command === "plan") {
    printPlan(plan)
    return
  }

  if (args.command === "accept") {
    // Re-baselines stale entries against the current spec without regenerating.
    // For when the style prose was reworded but the existing art is still wanted.
    let accepted = 0
    for (const item of plan.items) {
      if (item.state !== "stale") continue
      const entry = lock.entries[item.key]
      if (!entry?.file || !existsSync(entry.file)) continue
      if (entry.fileSha256 && (await sha256File(entry.file)) !== entry.fileSha256) continue
      upsertLock(lock, item.key, { specHash: item.spec.specHash })
      accepted++
    }
    await saveLock(args.lock, lock)
    log(`  accepted ${accepted} existing file(s) as satisfying the current spec`)
    log(`  (their artwork is unchanged; only the recorded spec hash moved)`)
    return
  }

  const client = clientFromEnv()

  if (args.command === "adopt") {
    log(`\n  Reconciling account objects against files already on disk…`)
    const res = await adopt(client, specs, lock, args.lock, { onProgress: log })
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
          `  it — run adopt from each project first, then review what is left over.`,
      )
    }
    if (args.tag) {
      const n = await tagAdopted(client, specs, lock, { onProgress: log })
      log(`\n  tagged ${n} object(s) upstream`)
    }
    log(`\n  lockfile written: ${args.lock}`)
    return
  }

  if (args.command === "tag") {
    const n = await pushTags(client, specs, lock, { onProgress: log })
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
      const balance = await client.balance()
      log(`\n  balance: ${balance.generations} generations remaining`)
      if (plan.cost > balance.generations) {
        throw new Error(
          `This run needs ${plan.cost} generations but only ${balance.generations} remain.`,
        )
      }
      const ok = await confirm(`  Spend ${plan.cost} generations on ${plan.actionable.length} asset(s)?`, args.yes)
      if (!ok) {
        log(`  aborted`)
        return
      }
      log(`\n  submitting…`)
      const res = await submit(client, loaded, plan.actionable, lock, args.lock, {
        budget: args.budget,
        onProgress: log,
      })
      log(`\n  submitted ${res.submitted}, failed ${res.failed}, spent ${res.spent} generations`)
    }
    if (args.command === "submit") return
  }

  if (args.command === "poll" || args.command === "gen") {
    log(`\n  polling…`)
    const res = await poll(client, lock, args.lock, { onProgress: log })
    log(
      `\n  ${res.completed} ready · ${res.review} awaiting selection · ${res.failed} failed` +
        (res.expired ? ` · ${res.expired} expired` : ""),
    )
    if (args.command === "poll") return
  }

  if (args.command === "pick" || args.command === "gen") {
    const res = await runPicker(client, lock, args.lock, { open: !args.noOpen, onProgress: log })
    if (res.selected === 0 && res.skipped === 0) {
      log(`  nothing awaiting selection`)
    } else {
      log(`\n  selected ${res.selected}, left in review ${res.skipped}`)
    }
    if (args.command === "pick") return
  }

  if (args.command === "fetch" || args.command === "gen") {
    log(`\n  downloading…`)
    const res = await fetchAssets(client, specs, lock, args.lock, { onProgress: log })
    log(`\n  downloaded ${res.downloaded}, skipped ${res.skipped}, failed ${res.failed}`)
    if (args.tag) {
      const n = await pushTags(client, specs, lock, { onProgress: log })
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
