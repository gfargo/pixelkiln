/** `workspace add|remove|list|status|claims`: the multi-project catalog. */
import path from "node:path"
import { existsSync } from "node:fs"
import { formatCost } from "../../provider.ts"
import { loadManifest } from "../../manifest.ts"
import {
  loadWorkspace,
  saveWorkspace,
  toPortablePath,
  resolveProject,
  validateWorkspace,
  type WorkspaceProject,
} from "../../workspace.ts"
import { workspaceStatus } from "../../pipeline/workspace.ts"

import { requireCompleteWorkspaceClaims } from "../project.ts"
import { log } from "../io.ts"
import type { Args } from "../args.ts"

export async function runWorkspace(args: Args): Promise<void> {
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
        `  warning: no lockfile there yet; this project contributes no claims until one is generated`,
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
          log(`\n  ${p.id}: ERROR: ${p.error}`)
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
