import { existsSync } from "node:fs"
import { sha256File } from "../hash.ts"
import { lockKey, type Lock, type ResolvedSpec } from "../types.ts"

export type PlanState =
  | "ok" // spec unchanged, file present and matching — nothing to do
  | "missing" // no lock entry and no file — genuinely needs generating
  | "untracked" // file exists but has no lock entry; the art is fine, provenance is not known
  | "stale" // prompt/style/size changed since the file was made
  | "orphaned" // lock says downloaded, but the file is gone or altered
  | "in-flight" // submitted, not yet downloaded
  | "failed"

export interface PlanItem {
  spec: ResolvedSpec
  key: string
  state: PlanState
  reason: string
}

export interface Plan {
  items: PlanItem[]
  /** Items that would cost generations if the plan were executed. */
  actionable: PlanItem[]
  cost: number
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
    } else if (entry.status === "failed") {
      state = "failed"
      reason = entry.error ?? "previous attempt failed"
    } else if (entry.specHash !== spec.specHash) {
      state = "stale"
      reason = "prompt, size, or style changed"
    } else if (entry.status !== "downloaded") {
      state = "in-flight"
      reason = `awaiting ${entry.status}`
    } else if (!entry.file || !existsSync(entry.file)) {
      state = "orphaned"
      reason = "file missing on disk"
    } else if (entry.fileSha256 && (await sha256File(entry.file)) !== entry.fileSha256) {
      // The file was edited by hand. That is a legitimate thing to do, so this
      // is reported rather than silently overwritten.
      state = "orphaned"
      reason = "file modified since download"
    } else {
      state = "ok"
      reason = "up to date"
    }

    items.push({ spec, key, state, reason })
  }

  // "orphaned" entries may be re-downloadable from a persisted object without
  // paying again; only genuinely new work is counted toward cost.
  const actionable = items.filter((i) => i.state === "missing" || i.state === "stale" || i.state === "failed")

  return {
    items,
    actionable,
    cost: actionable.reduce((sum, i) => sum + i.spec.cost, 0),
    candidates: actionable.reduce((sum, i) => sum + i.spec.candidates, 0),
  }
}

export function summarize(plan: Plan): Record<PlanState, number> {
  const counts = {
    ok: 0, missing: 0, untracked: 0, stale: 0, orphaned: 0, "in-flight": 0, failed: 0,
  } as Record<PlanState, number>
  for (const item of plan.items) counts[item.state]++
  return counts
}
