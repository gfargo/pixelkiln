/** Terminal output shared by every command. */
import { formatCost } from "../provider.ts"
import type { Lock, ResolvedSpec } from "../types.ts"
import { resumeActions, summarize, type Plan } from "../pipeline/plan.ts"
import type { ReviewReadyInfo } from "../pick/server.ts"


export const log = (msg = "") => console.log(msg)

interface CliWritable {
  isTTY?: boolean
  write(chunk: string): unknown
}

/**
 * Interactive readiness is progress, not command output. Keep it on stdout in
 * a terminal, but use stderr when stdout is piped so consumers such as `tail`
 * cannot hold the only copy of the live URL until the server exits.
 */
export function announceReviewReady(
  info: ReviewReadyInfo,
  stdout: CliWritable = process.stdout,
  stderr: CliWritable = process.stderr,
): void {
  const stream = stdout.isTTY ? stdout : stderr
  const count = info.keys.length
  stream.write(
    `\n  ${count} asset${count === 1 ? "" : "s"} awaiting selection: ${info.url}\n` +
      "  (leave this running; it exits once you apply)\n\n",
  )
}

/** Same stream rule as review readiness: the live URL must not wait behind a pipe. */
export function announceGalleryReady(
  url: string,
  count: number,
  stdout: CliWritable = process.stdout,
  stderr: CliWritable = process.stderr,
  edit = false,
  budget: string | null = null,
): void {
  const stream = stdout.isTTY ? stdout : stderr
  const notes: string[] = []
  if (edit) notes.push("editing enabled: saves rewrite the manifest only")
  if (budget) notes.push(`generation enabled under a session budget of ${budget}`)
  stream.write(
    `\n  gallery of ${count} generation${count === 1 ? "" : "s"}: ${url}\n` +
      (notes.length
        ? `  (${notes.join("; ")}; Ctrl+C to stop)\n\n`
        : "  (read-only — add --edit to change prompts or edit sprites, --budget <n> to generate; Ctrl+C to stop)\n\n"),
  )
}


export function printPlan(plan: Plan): void {
  const counts = summarize(plan)
  const order = [
    "blocked", "missing", "untracked", "stale", "failed", "recoverable", "in-flight", "orphaned", "ok",
  ] as const
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
    `\n  totals: ${counts.ok} ok · ${counts.blocked} blocked · ${counts.missing} missing · ${counts.untracked} untracked · ` +
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
  const qualityItems = plan.items.flatMap((item) => item.quality ? [item.quality] : [])
  if (qualityItems.length) {
    const approved = qualityItems.filter((item) => item.state === "approved").length
    log(`\n  quality: ${approved}/${qualityItems.length} approved`)
    for (const item of qualityItems.filter((item) => item.state !== "approved").slice(0, 40)) {
      log(`    ${item.state.padEnd(16)} ${item.key}  ${item.reason}`)
    }
  }
}

export function printResumeActions(specs: ResolvedSpec[], lock: Lock): number {
  const actions = resumeActions(specs, lock)
  for (const action of actions) {
    const shown = action.keys.slice(0, 3).join(", ")
    const more = action.keys.length > 3 ? `, +${action.keys.length - 3} more` : ""
    log(
      `  next: pixelkiln ${action.command} — ${action.keys.length} asset` +
        `${action.keys.length === 1 ? "" : "s"} (${shown}${more})`,
    )
  }
  return actions.length
}


export async function confirm(question: string, auto: boolean): Promise<boolean> {
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

