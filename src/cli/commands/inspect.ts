/** Read-only reports: status, doctor, plan, audit. */
import { formatCost } from "../../provider.ts"
import {
  createProvider,
  providerCredentialEnvs,
  providerFactory,
} from "../../providers/registry.ts"
import { spendByUnit } from "../../lock.ts"
import { buildPlan, summarize } from "../../pipeline/plan.ts"
import { doctor } from "../../pipeline/doctor.ts"
import { auditStyle, evaluateAudit, hex } from "../../pipeline/audit.ts"
import { openProject } from "../project.ts"
import { log, printPlan } from "../io.ts"
import type { Args } from "../args.ts"

export async function runStatus(args: Args): Promise<void> {
  const { lock } = await openProject(args)
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
}

export async function runDoctor(args: Args): Promise<void> {
  const { loaded, specs, lock } = await openProject(args)
  const selectedStyleIds = args.styles.length
    ? args.styles
    : Object.keys(loaded.manifest.styles)
  const providerIds = [...new Set(
    selectedStyleIds.map((styleId) =>
      loaded.manifest.styles[styleId]?.provider ?? loaded.manifest.provider),
  )].sort()
  const providers = providerIds.map((id) => {
    const factory = providerFactory(id)
    const credentialEnvs = providerCredentialEnvs(factory)
    const missingCredentialEnvs = credentialEnvs.filter((name) => !process.env[name])
    const apiKeyPresent = missingCredentialEnvs.length === 0
    return {
      id,
      apiKeyPresent,
      credentialEnv: factory.credentialEnv,
      missingCredentialEnvs,
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
}

export async function runPlan(args: Args): Promise<void> {
  const { specs, lock } = await openProject(args)
  const plan = await buildPlan(specs, lock, { force: args.force })
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
      items: plan.items.map(({ key, state, reason, quality, spec }) => ({
        key,
        state,
        reason,
        ...(spec.revision
          ? {
              revision: {
                mode: spec.revision.mode,
                from: spec.revision.sourceAssetId,
                sourceSha256: spec.revision.sourceSha256,
                ...(spec.revision.maskSha256
                  ? { maskSha256: spec.revision.maskSha256 }
                  : {}),
                ...(spec.revision.strength == null ? {} : { strength: spec.revision.strength }),
              },
            }
          : {}),
        ...(quality ? { quality: { state: quality.state, reason: quality.reason } } : {}),
      })),
    }, null, 2))
  } else {
    printPlan(plan)
  }
  if (
    args.check && plan.items.some(
      (item) => item.state !== "ok" || (item.quality && item.quality.state !== "approved"),
    )
  ) process.exitCode = 1
}

export async function runAudit(args: Args): Promise<void> {
  const { loaded, specs, lock } = await openProject(args)
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
    log(`\n  ${styleId}: ${audit.assets.length} asset(s) measured`)
    log(
      `  reference palette: ${audit.referenceFromStyleImages ? "style images" : "the set's own average"}` +
        `  ${audit.reference.slice(0, 6).map(hex).join(" ")}`,
    )
    if (!audit.referenceFromStyleImages) {
      log(`  (no styleImages set; this finds outliers but cannot tell you the whole set drifted)`)
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
}
