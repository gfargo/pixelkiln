import { existsSync } from "node:fs"
import path from "node:path"
import { sha256File } from "../hash.ts"
import { currentEntryOutputPath } from "../outputs.ts"
import { lockKey, type Lock, type LockEntry, type ResolvedSpec } from "../types.ts"
import type { CostUnit } from "../provider.ts"
import { inspectQualityProfile, type QualityProfileInspection } from "./quality-profile.ts"
import { inspectRevisionReadiness } from "./revision.ts"

export type PlanState =
  | "ok" // spec unchanged, file present and matching — nothing to do
  | "missing" // no lock entry and no file — genuinely needs generating
  | "untracked" // file exists but has no lock entry; the art is fine, provenance is not known
  | "stale" // prompt/style/size changed since the file was made
  | "orphaned" // the bytes that should be on disk are gone or altered
  | "in-flight" // submitted, not yet downloaded
  | "recoverable" // generation succeeded; download can be retried without spending
  | "blocked" // a declared revision input is missing, stale, or not approved
  | "failed"

/**
 * True if any recorded output no longer hashes to what was written.
 *
 * Checked across every output, not just the primary: a character's engine
 * resource being hand-edited matters as much as its spritesheets changing.
 */
async function anyOutputModified(entry: LockEntry, spec: ResolvedSpec): Promise<boolean> {
  for (let index = 0; index < entry.outputs.length; index++) {
    const output = entry.outputs[index]!
    if (
      (await sha256File(currentEntryOutputPath(entry, spec, index))) !== output.sha256
    ) return true
  }
  return false
}

export interface PlanItem {
  spec: ResolvedSpec
  key: string
  state: PlanState
  reason: string
  /** Derived-art state. It never changes provider cost or generation actionability. */
  quality?: QualityProfileInspection
}

export interface Plan {
  items: PlanItem[]
  /** Items that would incur provider cost if the plan were executed. */
  actionable: PlanItem[]
  /** Provider-scoped totals. Unlike units and accounts are never combined. */
  groups: PlanGroup[]
  /** Compatibility projection for a single provider group; null for mixed plans. */
  cost: number | null
  /** Compatibility projection for a single provider group; null for mixed plans. */
  costUnit: CostUnit | null
  candidates: number
}

export interface PlanGroup {
  provider: string
  costUnit: CostUnit
  cost: number
  candidates: number
  actionable: PlanItem[]
}

export type ResumeCommand = "poll" | "pick" | "fetch"

export interface ResumeAction {
  command: ResumeCommand
  keys: string[]
}

/** The zero-cost command that advances one settled lock state. */
export function resumeCommandForStatus(
  status: LockEntry["status"],
): ResumeCommand | null {
  if (status === "pending" || status === "processing") return "poll"
  if (status === "review") return "pick"
  if (status === "selected" || status === "download-failed") return "fetch"
  return null
}

/** Group current selected specs by the command that can resume them safely. */
export function resumeActions(specs: ResolvedSpec[], lock: Lock): ResumeAction[] {
  const grouped = new Map<ResumeCommand, string[]>()
  for (const spec of specs) {
    const key = lockKey(spec.styleId, spec.assetId)
    const entry = lock.entries[key]
    if (!entry || entry.specHash !== spec.specHash) continue
    const command = resumeCommandForStatus(entry.status)
    if (!command) continue
    if (command === "poll" && !entry.jobId) continue
    if (command === "pick" && !entry.reviewObjectId) continue
    grouped.set(command, [...(grouped.get(command) ?? []), key])
  }
  return (["poll", "pick", "fetch"] as const).flatMap((command) => {
    const keys = grouped.get(command)
    return keys?.length ? [{ command, keys }] : []
  })
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

    const revision = await inspectRevisionReadiness(spec, lock)
    if (revision && !revision.ready) {
      state = "blocked"
      reason = revision.reason
    } else if (opts.force) {
      state = "missing"
      reason = "--force"
    } else if (!entry && spec.source) {
      // An asset with a `source` is placed from committed art by `mount`, and
      // AssetSchema.source says it needs no lock entry at all. Treating it as
      // `missing` puts art pixelkiln did not make and will never generate into
      // the actionable list, and bills a generation cost for each one.
      if (existsSync(path.resolve(spec.root, spec.source))) {
        state = "ok"
        reason = `placed from ${spec.source}; not generated`
      } else {
        state = "orphaned"
        reason = `declared source is missing: ${spec.source}`
      }
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
      const force = entry.error?.includes("pass --force") ? " --force" : ""
      reason =
        `${entry.error ?? "download failed"}; run pixelkiln fetch${force} ` +
        "(no generation cost)"
    } else if (entry.status === "failed") {
      state = "failed"
      reason = entry.error ?? "previous attempt failed"
    } else if (entry.status === "selected") {
      state = "recoverable"
      reason = "provider output is selected; run pixelkiln fetch (no generation cost)"
    } else if (entry.status === "pending" || entry.status === "processing") {
      state = "in-flight"
      reason = entry.jobId
        ? "awaiting processing; run pixelkiln poll"
        : "submission state has no job id; run pixelkiln doctor before retrying"
    } else if (entry.status === "review") {
      state = "in-flight"
      reason = entry.reviewObjectId
        ? "awaiting review; run pixelkiln pick"
        : "review state has no review object id; run pixelkiln doctor"
    } else if (entry.status !== "downloaded") {
      state = "in-flight"
      reason = `awaiting ${entry.status}`
    } else if (
      entry.outputs.length === 0 ||
      entry.outputs.some((_output, index) =>
        !existsSync(currentEntryOutputPath(entry, spec, index)))
    ) {
      state = "orphaned"
      reason =
        entry.outputs.length === 0
          ? "no recorded output files"
          : `missing on disk: ${entry.outputs
              .filter((_output, index) =>
                !existsSync(currentEntryOutputPath(entry, spec, index)))
              .map((o) => o.role ?? "asset")
              .join(", ")}`
    } else if (await anyOutputModified(entry, spec)) {
      // The file was edited by hand. That is a legitimate thing to do, so this
      // is reported rather than silently overwritten.
      state = "orphaned"
      reason = "output modified since download"
    } else {
      state = "ok"
      reason = "up to date"
    }

    const quality = await inspectQualityProfile(spec, lock)
    items.push({ spec, key, state, reason, ...(quality ? { quality } : {}) })
  }

  // "orphaned" entries may be re-downloadable from a persisted object without
  // paying again; only genuinely new work is counted toward cost.
  const actionable = items.filter((i) => i.state === "missing" || i.state === "stale" || i.state === "failed")
  const groupsByProvider = new Map<string, PlanGroup>()
  for (const item of actionable) {
    const provider = item.spec.provider
    const costUnit = item.spec.costUnit ?? "generations"
    const group = groupsByProvider.get(provider)
    if (group && group.costUnit !== costUnit) {
      throw new Error(
        `Provider "${provider}" returned mixed cost units (${group.costUnit}, ${costUnit})`,
      )
    }
    if (group) {
      group.actionable.push(item)
      group.cost += item.spec.cost
      group.candidates += item.spec.candidates
    } else {
      groupsByProvider.set(provider, {
        provider,
        costUnit,
        cost: item.spec.cost,
        candidates: item.spec.candidates,
        actionable: [item],
      })
    }
  }
  const groups = [...groupsByProvider.values()].sort((a, b) => a.provider.localeCompare(b.provider))
  const fallbackUnits = new Set(specs.map((spec) => spec.costUnit))
  const single = groups.length === 1 ? groups[0]! : null

  return {
    items,
    actionable,
    groups,
    cost: single?.cost ?? (groups.length ? null : 0),
    costUnit: single?.costUnit ?? (groups.length || fallbackUnits.size > 1
      ? null
      : fallbackUnits.values().next().value ?? (specs.length ? "generations" : "free")),
    candidates: actionable.reduce((sum, i) => sum + i.spec.candidates, 0),
  }
}

export function summarize(plan: Plan): Record<PlanState, number> {
  const counts = {
    ok: 0, missing: 0, untracked: 0, stale: 0, orphaned: 0, "in-flight": 0,
    recoverable: 0, blocked: 0, failed: 0,
  } as Record<PlanState, number>
  for (const item of plan.items) counts[item.state]++
  return counts
}
