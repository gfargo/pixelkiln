/** `refine run|approve|check`: quality-profile output and its human approval. */
import path from "node:path"
import { approveQualityRecord, checkQualityRecord, refineAsset } from "../../pipeline/refine.ts"
import { inspectQualityProfile, refineQualityProfiles } from "../../pipeline/quality-profile.ts"
import { openProject } from "../project.ts"
import { log, confirm } from "../io.ts"
import type { Args } from "../args.ts"

export async function runRefine(args: Args): Promise<void> {
  // Path mode stays manifest-free. Without --from, `refine run/check` falls
  // through to the manifest quality-profile workflow below.
  if (args.from || args.subcommand === "approve") {
    if (!args.from) {
      throw new Error(
        args.subcommand === "run"
          ? "refine needs --from <source.png>."
          : `refine ${args.subcommand} needs --from <output.pixelkiln.json>.`,
      )
    }

    if (args.subcommand === "run") {
      if (!args.out) throw new Error("refine needs --out <final.png>.")
      if (!args.palette.length) {
        throw new Error("refine needs an explicit final palette via --palette <#rrggbb,...>.")
      }
      const result = await refineAsset({
        source: args.from,
        output: args.out,
        palette: args.palette,
        fixerPython: args.fixerPython,
        fixerRevision: args.fixerRevision,
        minGridConfidence: args.minGridConfidence,
        minTransparency: args.minTransparency,
        force: args.force,
      })
      if (args.json) {
        log(JSON.stringify(result, null, 2))
      } else {
        log(
          `  recovered ${result.detection.columns}x${result.detection.rows} native grid ` +
            `(${result.detection.confidence}: ${result.detection.consensus})`,
        )
        log(`  enforced ${result.palette.length}-color palette without dithering`)
        log(`  wrote ${path.relative(process.cwd(), result.output)}`)
        log(`  quality record: ${path.relative(process.cwd(), result.record)}`)
        log(`\n  Automated checks passed. Human 1× review is still required:`)
        log(
          `    pixelkiln refine approve --from ${path.relative(process.cwd(), result.record)} ` +
            `--reviewer "Your Name"`,
        )
      }
      return
    }

    if (args.subcommand === "approve") {
      if (!args.reviewer?.trim()) {
        throw new Error("refine approve needs --reviewer <name>.")
      }
      const pending = await checkQualityRecord(args.from)
      log(
        pending.options.frameSet
          ? `  Inspect all ${pending.options.frameSet.count} ordered frames at 1×, integer zoom, and playback speed.`
          : `  Inspect the final PNG at 1× and integer zoom.`,
      )
      log(`  Confirm crisp edges, readable forms, palette separation, alpha, and seams.`)
      if (!(await confirm(
        pending.options.frameSet
          ? "  Record this complete frame set as human-approved?"
          : "  Record this asset as human-approved?",
        args.yes,
      ))) {
        log("  approval not recorded")
        return
      }
      const result = await approveQualityRecord(args.from, {
        reviewer: args.reviewer,
        note: args.note,
      })
      if (args.json) log(JSON.stringify(result, null, 2))
      else {
        log(
          result.options.frameSet
            ? `  approved ${result.outputs.length} frames in ${path.relative(process.cwd(), result.record)} by ${args.reviewer.trim()}`
            : `  approved ${path.relative(process.cwd(), result.output)} by ${args.reviewer.trim()}`,
        )
      }
      return
    }

    const result = await checkQualityRecord(args.from)
    if (args.json) {
      log(JSON.stringify(result, null, 2))
    } else {
      log(`  ${result.safe ? "release-ready" : "not release-ready"}: ${path.relative(process.cwd(), result.output || result.record)}`)
      for (const reason of result.reasons) log(`    ${reason}`)
    }
    if (!result.safe) process.exitCode = 1
    return
  }

  const { specs, lock } = await openProject(args)
  const pathOwnedFlags = [
    args.out ? "--out" : null,
    args.palette.length ? "--palette" : null,
    args.fixerRevision ? "--fixer-revision" : null,
    args.minGridConfidence ? "--min-grid-confidence" : null,
    args.minTransparency != null ? "--min-transparency" : null,
  ].filter(Boolean)
  if (pathOwnedFlags.length) {
    throw new Error(
      `${pathOwnedFlags.join(", ")} require --from. Manifest mode reads output, palette, ` +
        "revision, and thresholds from style.quality.",
    )
  }

  if (args.subcommand === "check") {
    const inspections = (await Promise.all(
      specs.filter((spec) => spec.quality).map((spec) => inspectQualityProfile(spec, lock)),
    )).filter((item) => item !== null)
    if (!inspections.length) throw new Error("No selected style has a quality profile.")
    const safe = inspections.every((item) => item.state === "approved")
    if (args.json) {
      log(JSON.stringify({ version: 1, safe, items: inspections }, null, 2))
    } else {
      for (const item of inspections) {
        log(`  ${item.state.padEnd(16)} ${item.key}  ${item.reason}`)
      }
    }
    if (!safe) process.exitCode = 1
    return
  }

  const result = await refineQualityProfiles(specs, lock, {
    fixerPython: args.fixerPython,
    force: args.force,
  })
  if (args.json) {
    log(JSON.stringify({ version: 1, ...result }, null, 2))
  } else {
    for (const item of result.items) {
      log(`  ${item.state.padEnd(16)} ${item.key}  ${item.reason}`)
      if (item.state === "needs-approval") {
        log(
          `    pixelkiln refine approve --from ${path.relative(process.cwd(), item.record)} ` +
            `--reviewer "Your Name"`,
        )
      }
    }
    log(`\n  ${result.processed} refined, ${result.skipped} unchanged, ${result.failed} failed`)
  }
  if (result.failed) process.exitCode = 1
}
