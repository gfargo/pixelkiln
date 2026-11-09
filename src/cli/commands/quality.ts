/** `quality snapshot|check`: the visual regression baseline. */
import path from "node:path"
import { readFile } from "node:fs/promises"
import {
  checkQualityBaseline,
  resolveQualityInputs,
  snapshotQualityBaseline,
  snapshotQualityCases,
} from "../../pipeline/quality-regression.ts"

import { log } from "../io.ts"
import type { Args } from "../args.ts"

export async function runQuality(args: Args): Promise<void> {
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
    if (args.assets.length) {
      const result = await snapshotQualityCases(inputs, args.out, args.assets, { dryRun: args.dryRun })
      if (args.json) {
        log(JSON.stringify({ version: 1, path: result.path, changed: result.changed, dryRun: args.dryRun, cases: result.cases }, null, 2))
        return
      }
      for (const entry of result.cases ?? []) {
        log(`  ${entry.kind === "unchanged" ? "unchanged" : args.dryRun ? `would ${entry.kind === "added" ? "add" : "update"}` : entry.kind}  ${entry.id}`)
        for (const c of entry.changes) log(`         ${c.metric}: ${JSON.stringify(c.before)} -> ${JSON.stringify(c.after)}`)
      }
      log(
        `\n  ${result.changed ? (args.dryRun ? "would write" : "wrote") : "no changes to"} ` +
          `${path.relative(process.cwd(), result.path)}; other cases left as they were.`,
      )
      return
    }
    if (args.dryRun) throw new Error("quality snapshot --dry-run applies to a partial re-snapshot; add --only <id,...>.")
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
}
