import { existsSync } from "node:fs"
import { sha256File } from "../hash.ts"
import { lockKey, type Lock, type LockEntry, type ResolvedSpec } from "../types.ts"
import type { CostUnit } from "../provider.ts"

export type PlanState =
  | "ok" // spec unchanged, file present and matching — nothing to do
  | "missing" // no lock entry and no file — genuinely needs generating
  | "untracked" // file exists but has no lock entry; the art is fine, provenance is not known
  | "stale" // prompt/style/size changed since the file was made
  | "orphaned" // lock says downloaded, but the file is gone or altered
  | "in-flight" // submitted, not yet downloaded
  | "recoverable" // generation succeeded; download can be retried without spending
  | "failed"

/**
 * True if any recorded output no longer hashes to what was written.
 *
 * Checked across every output, not just the primary: a character's engine
 * resource being hand-edited matters as much as its spritesheets changing.
 */
async function anyOutputModified(entry: LockEntry): Promise<boolean> {
  for (const output of entry.outputs) {
    if ((await sha256File(output.path)) !== output.sha256) return true
  }
  return false
}

export interface PlanItem {
  spec: ResolvedSpec
  key: string
  state: PlanState
  reason: string
}

export interface Plan {
  items: PlanItem[]
  /** Items that would incur provider cost if the plan were executed. */
  actionable: PlanItem[]
  cost: number
  costUnit: CostUnit
  candidates: number
}

/**
 * Diffs the manifest against the lockfile and the files on disk. Nothing here
 * touches the network, so it is safe to run constantly — it is the cheap
 * "what would this cost me?" question that should precede every real run.
 */
export async function buildPlan(
  specs: ResolvedSpec[],
  lock: Lock,
  opts: { force?: boolean } = {},
): Promise<Plan> {
  const items: PlanItem[] = []

  for (const spec of specs) {
    const key = lockKey(spec.styleId, spec.assetId)
    const entry = lock.entries[key]

    let state: PlanState
    let reason: string

    if (opts.force) {
      state = "missing"
      reason = "--force"
    } else if (!entry) {
      // Distinguish "no art" from "art exists but unmatched upstream". Calling
      // the latter `missing` invites regenerating perfectly good files — which
      // is exactly what happens to assets that were retouched by hand after
      // download, since their bytes no longer match any remote object.
      if (existsSync(spec.outFile)) {
        state = "untracked"
        reason = "file on disk, no provenance recorded"
      } else {
        state = "missing"
        reason = "not in lockfile"
      }
    } else if (entry.specHash !== spec.specHash) {
      state = "stale"
      reason = "prompt, size, or style changed"
    } else if (entry.status === "download-failed") {
      state = "recoverable"
      reason = `${entry.error ?? "download failed"}; run fetch or restore (no generation cost)`
    } else if (entry.status === "failed") {
      state = "failed"
      reason = entry.error ?? "previous attempt failed"
    } else if (entry.status !== "downloaded") {
      state = "in-flight"
      reason = `awaiting ${entry.status}`
    } else if (entry.outputs.length === 0 || entry.outputs.some((o) => !existsSync(o.path))) {
      state = "orphaned"
      reason =
        entry.outputs.length === 0
          ? "no recorded output files"
          : `missing on disk: ${entry.outputs
              .filter((o) => !existsSync(o.path))
              .map((o) => o.role ?? "asset")
              .join(", ")}`
    } else if (await anyOutputModified(entry)) {
      // The file was edited by hand. That is a legitimate thing to do, so this
      // is reported rather than silently overwritten.
      state = "orphaned"
      reason = "output modified since download"
    } else {
      state = "ok"
      reason = "up to date"
    }

    items.push({ spec, key, state, reason })
  }

  // "orphaned" entries may be re-downloadable from a persisted object without
  // paying again; only genuinely new work is counted toward cost.
  const actionable = items.filter((i) => i.state === "missing" || i.state === "stale" || i.state === "failed")
  const units = new Set(actionable.map((item) => item.spec.costUnit ?? "generations"))
  if (units.size > 1) throw new Error("A single plan cannot combine incompatible provider cost units")

  return {
    items,
    actionable,
    cost: actionable.reduce((sum, i) => sum + i.spec.cost, 0),
    costUnit: actionable[0]?.spec.costUnit ?? specs[0]?.costUnit ?? (specs.length ? "generations" : "free"),
    candidates: actionable.reduce((sum, i) => sum + i.spec.candidates, 0),
  }
}

export function summarize(plan: Plan): Record<PlanState, number> {
  const counts = {
    ok: 0, missing: 0, untracked: 0, stale: 0, orphaned: 0, "in-flight": 0,
    recoverable: 0, failed: 0,
  } as Record<PlanState, number>
  for (const item of plan.items) counts[item.state]++
  return counts
}
