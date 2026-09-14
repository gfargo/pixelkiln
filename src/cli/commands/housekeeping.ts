/** Lockfile and cache upkeep: cache, accept, prune. */
import { existsSync } from "node:fs"
import { resolveSpecs } from "../../manifest.ts"
import { loadLock, remove as removeLock, saveLock, upsert as upsertLock } from "../../lock.ts"
import { sha256File } from "../../hash.ts"
import { lockKey } from "../../types.ts"
import { resolveOutputPath } from "../../outputs.ts"
import { buildPlan } from "../../pipeline/plan.ts"
import { inspectCaches } from "../../pipeline/cache-health.ts"
import { openProject } from "../project.ts"
import { log, confirm } from "../io.ts"
import type { Args } from "../args.ts"

export async function runCache(args: Args): Promise<void> {
  const lock = await loadLock(args.lock)
  const report = await inspectCaches(lock, args.lock, { prune: args.prune })
  if (args.json) {
    log(JSON.stringify(report, null, 2))
  } else {
    const size = report.content.bytes < 1024
      ? `${report.content.bytes} B`
      : `${(report.content.bytes / 1024).toFixed(1)} KB`
    log(`  content cache: ${report.content.path}`)
    log(
      report.content.exists
        ? `    ${report.content.valid} valid PNG(s), ${report.content.referenced} referenced, ` +
          `${report.content.unreferenced.length} unreferenced — ${size}`
        : "    not created yet",
    )
    if (report.content.missingReferenced.length) {
      log(`    ${report.content.missingReferenced.length} lockfile hash(es) are not locally cached`)
    }
    for (const issue of report.content.invalid.slice(0, 10)) {
      log(`    invalid ${issue.name}: ${issue.reason}`)
    }
    if (report.content.invalid.length > 10) {
      log(`    … and ${report.content.invalid.length - 10} more invalid entr(ies)`)
    }

    log(`  remote object-hash cache: ${report.remoteHashes.path}`)
    if (!report.remoteHashes.exists) log("    not created yet")
    else if (report.remoteHashes.error) {
      log(`    invalid cache: ${report.remoteHashes.error.split("\n")[0]}`)
    } else {
      log(
        `    ${report.remoteHashes.valid} valid entr(ies), ` +
          `${report.remoteHashes.invalidIds.length} invalid`,
      )
    }
    if (args.prune) {
      log(
        `  pruned ${report.removed.contentFiles} content file(s), ` +
          `${report.removed.remoteHashEntries} invalid remote hash entr(ies)` +
          (report.removed.resetRemoteHashCache ? "; rebuilt malformed remote cache" : ""),
      )
    }
    log(`  ${report.safe ? "cache integrity is healthy" : "cache integrity needs attention"}`)
  }
  if (args.check && !report.safe) process.exitCode = 1
}

export async function runAccept(args: Args): Promise<void> {
  const { specs, lock } = await openProject(args)
  const plan = await buildPlan(specs, lock, { force: args.force })
  // Re-baselines stale entries against the current spec without regenerating.
  // For when the style prose was reworded but the existing art is still wanted.
  let accepted = 0
  for (const item of plan.items) {
    if (item.state !== "stale") continue
    const entry = lock.entries[item.key]
    // Accepting new wording is safe; accepting a provider change would
    // relabel old remote work as if the new backend produced it.
    if (!entry || entry.provider !== item.spec.provider || entry.outputs.length === 0) continue
    let intact = true
    for (const output of entry.outputs) {
      const file = resolveOutputPath(output.path, item.spec.root)
      if (!existsSync(file) || (await sha256File(file)) !== output.sha256) {
        intact = false
        break
      }
    }
    if (!intact) continue
    upsertLock(lock, item.key, { specHash: item.spec.specHash })
    accepted++
  }
  await saveLock(args.lock, lock)
  log(`  accepted ${accepted} existing file(s) as satisfying the current spec`)
  log(`  (their artwork is unchanged; only the recorded spec hash moved)`)
}

export async function runPrune(args: Args): Promise<void> {
  const { loaded, lock } = await openProject(args)
  // Removes lock entries no style/asset pair in the manifest resolves to.
  // These accumulate when an asset is renamed or moved between styles: the
  // old entry keeps claiming the output path the new one now owns, which is
  // `doctor`'s lock-outputs error. Until `remove` existed there was no way
  // to clear one short of hand-editing the lockfile.
  //
  // Deliberately resolved from the whole manifest rather than the filtered
  // `specs`: under `--style base` every other style's entries would look
  // undeclared, and prune would delete the lot.
  if (args.styles.length || args.assets.length) {
    throw new Error(
      "prune compares the lockfile against the entire manifest, so --style " +
        "and --only would make it delete the entries they filter out. Run it unfiltered.",
    )
  }
  const declared = new Set((await resolveSpecs(loaded)).map((s) => lockKey(s.styleId, s.assetId)))
  const orphans = Object.keys(lock.entries).filter((key) => !declared.has(key)).sort()
  if (!orphans.length) {
    log(`  every lock entry is declared by the manifest — nothing to prune`)
    return
  }

  log(`
${orphans.length} lock entr(ies) the manifest no longer declares:`)
  for (const key of orphans.slice(0, 20)) {
    const outputs = lock.entries[key]?.outputs ?? []
    const where = outputs[0]?.path ?? "no recorded output"
    log(`    ${key.padEnd(44)} ${where}`)
  }
  if (orphans.length > 20) log(`    … and ${orphans.length - 20} more`)

  if (args.dryRun) {
    log(`
--dry-run: nothing removed.`)
    return
  }
  log(`
This drops their provenance from the lockfile. The art on disk is`)
  log(`  untouched, and nothing is deleted from your provider account — but`)
  log(`  the link from those files back to the objects that made them is gone,`)
  log(`  and the objects will read as unclaimed the next time you run salvage.`)
  if (!(await confirm(`  Remove ${orphans.length} lock entr(ies)?`, args.yes))) {
    log(`  aborted`)
    return
  }

  let removed = 0
  for (const key of orphans) if (removeLock(lock, key)) removed++
  await saveLock(args.lock, lock)
  log(`  removed ${removed} lock entr(ies); ${Object.keys(lock.entries).length} remain`)
}
