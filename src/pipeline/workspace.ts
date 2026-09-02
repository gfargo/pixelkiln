import { loadLock, spendByUnit } from "../lock.ts"
import { loadManifest, resolveSpecs } from "../manifest.ts"
import { normalizeLockOutputPaths } from "../outputs.ts"
import { createProvider } from "../providers/registry.ts"
import type { CostUnit } from "../provider.ts"
import {
  resolveProject,
  validateWorkspace,
  type Workspace,
  type WorkspaceDiagnostic,
} from "../workspace.ts"
import { loadClaims } from "./salvage.ts"
import { buildPlan, summarize, type PlanState } from "./plan.ts"

export interface WorkspaceClaims {
  claimed: Set<string>
  /** Claim count contributed by each registered project. */
  byProject: Record<string, number>
  lockPaths: string[]
}

/**
 * The complete account-wide claim set, derived from every registered lock.
 *
 * Delegates the union rule itself to `loadClaims` rather than reimplementing
 * it, so the workspace and single-project `--claims` paths cannot drift. Each
 * lock is loaded one at a time — rather than handing `loadClaims` the whole
 * path list at once — purely so a failure can be attributed to the project
 * that owns it; the safety property (any unreadable registered lock aborts
 * before returning a claim set) is identical either way.
 */
export async function workspaceClaims(ws: Workspace, dir: string): Promise<WorkspaceClaims> {
  const lockPaths: string[] = []
  const byProject: Record<string, number> = {}
  const claimed = new Set<string>()

  for (const project of ws.projects) {
    const { lockPath } = resolveProject(dir, project)
    lockPaths.push(lockPath)
    let projectClaims: Set<string>
    try {
      projectClaims = await loadClaims([lockPath])
    } catch (err) {
      throw new Error(
        `Project "${project.id}" lockfile is unreadable: ` +
          `${err instanceof Error ? err.message : String(err)}`,
      )
    }
    byProject[project.id] = projectClaims.size
    for (const id of projectClaims) claimed.add(id)
  }

  return { claimed, byProject, lockPaths }
}

function emptyStateCounts(): Record<PlanState, number> {
  return {
    ok: 0, missing: 0, untracked: 0, stale: 0, orphaned: 0, "in-flight": 0,
    recoverable: 0, failed: 0,
  }
}

export interface WorkspaceProjectStatus {
  id: string
  provider: string
  account: string | null
  manifest: string
  lock: string
  entries: number
  byState: Record<PlanState, number>
  spendByUnit: Record<CostUnit, number>
  error: string | null
}

export interface WorkspaceStatusReport {
  version: 1
  safe: boolean
  /** The catalog's own directory — resolved paths in `projects` sit under it. */
  dir: string
  projects: WorkspaceProjectStatus[]
  totals: {
    byState: Record<PlanState, number>
    spendByUnit: Record<CostUnit, number>
    claims: number
  }
  diagnostics: WorkspaceDiagnostic[]
}

/**
 * Aggregate, read-only account/project state — offline throughout, using the
 * same offline cost estimator `plan` uses. A project whose manifest or lock
 * fails to load surfaces as that project's own `error` rather than aborting
 * the whole report, so one broken sibling does not hide every other
 * project's status. It never writes to any registered project's lock.
 */
export async function workspaceStatus(ws: Workspace, dir: string): Promise<WorkspaceStatusReport> {
  const diagnostics = validateWorkspace(ws, dir)
  const projects: WorkspaceProjectStatus[] = []
  const totalsByState = emptyStateCounts()
  const totalsSpend: Record<CostUnit, number> = { generations: 0, usd: 0, free: 0 }

  for (const project of ws.projects) {
    const { manifestPath, lockPath } = resolveProject(dir, project)
    const base = {
      id: project.id,
      provider: project.provider,
      account: project.account ?? null,
      manifest: manifestPath,
      lock: lockPath,
    }
    try {
      const provider = createProvider(project.provider, "offline")
      const loaded = await loadManifest(manifestPath)
      const specs = await resolveSpecs(loaded, { provider })
      const lock = await loadLock(lockPath)
      normalizeLockOutputPaths(lock, specs)
      const plan = await buildPlan(specs, lock)
      const byState = summarize(plan)
      const spend = spendByUnit(lock)
      for (const state of Object.keys(byState) as PlanState[]) {
        totalsByState[state] += byState[state]
      }
      for (const unit of Object.keys(spend) as CostUnit[]) {
        totalsSpend[unit] = (totalsSpend[unit] ?? 0) + (spend[unit] ?? 0)
      }
      projects.push({
        ...base,
        entries: Object.keys(lock.entries).length,
        byState,
        spendByUnit: spend,
        error: null,
      })
    } catch (err) {
      projects.push({
        ...base,
        entries: 0,
        byState: emptyStateCounts(),
        spendByUnit: { generations: 0, usd: 0, free: 0 },
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }

  let claims = 0
  try {
    claims = (await workspaceClaims(ws, dir)).claimed.size
  } catch {
    // Already visible via a project's own `error` or a missing-lock
    // diagnostic; not worth surfacing a second time here.
  }

  return {
    version: 1,
    safe: !diagnostics.some((d) => d.level === "error") && projects.every((p) => !p.error),
    dir,
    projects,
    totals: { byState: totalsByState, spendByUnit: totalsSpend, claims },
    diagnostics,
  }
}
