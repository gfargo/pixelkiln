/** Commands that speak to one provider account: balance, adopt, salvage, purge, tag. */
import path from "node:path"
import { existsSync } from "node:fs"
import { loadEnvFiles } from "../../env.ts"
import { formatCost, requireBalance, requireDelete, requireList } from "../../provider.ts"
import { createProvider } from "../../providers/registry.ts"
import { loadManifest, resolveSpecs } from "../../manifest.ts"
import { saveLock, upsert as upsertLock } from "../../lock.ts"
import { lockKey } from "../../types.ts"
import { pushTags } from "../../pipeline/fetch.ts"
import { adopt, formatUnmatchedRemote, tagAdopted, writePromptsBack } from "../../pipeline/adopt.ts"
import {
  loadClaims,
  findOrphans,
  groupOrphansByStyle,
  loadSiblingManifests,
  SALVAGED_SPEC_HASH,
} from "../../pipeline/salvage.ts"
import { resolveProject, type WorkspaceProject } from "../../workspace.ts"
import { runSalvage as runSalvageServer } from "../../pick/salvage-server.ts"
import { openProject, openAccountProject, providerCache, specsByRecordedProvider, accountProviderId, requireCompleteWorkspaceClaims } from "../project.ts"
import { log, confirm } from "../io.ts"
import type { Args } from "../args.ts"

export async function runBalance(args: Args): Promise<void> {
  loadEnvFiles(path.dirname(path.resolve(args.manifest)))
  loadEnvFiles(process.cwd())
  const loaded = await loadManifest(args.manifest)
  const selectedProvider = accountProviderId(loaded.manifest, args.provider, "balance")
  const p = createProvider(selectedProvider, "online")
  const b = await requireBalance(p)()
  log(`  provider:  ${p.id}`)
  log(`  plan:      ${b.plan ?? "n/a"}`)
  log(`  remaining: ${formatCost(b.unit, b.remaining)}${b.total ? ` of ${b.total}` : ""}`)
}

export async function runAdopt(args: Args): Promise<void> {
  const { specs, lock, accountProvider } = await openAccountProject(args)
  const providerFor = providerCache("online")
  const provider = providerFor(accountProvider)
  log(`\n  Reconciling account objects against files already on disk…`)
  const res = await adopt(provider, specs, lock, args.lock, { onProgress: log })
  log(`\n  scanned ${res.scanned} remote object(s), adopted ${res.matched}`)
  if (res.ambiguous.length) {
    log(`\n  ambiguous (${res.ambiguous.length}):`)
    for (const a of res.ambiguous.slice(0, 10)) log(`    ${a}`)
  }
  if (res.unmatchedLocal.length) {
    log(`\n  local files with no matching remote object (${res.unmatchedLocal.length}):`)
    for (const u of res.unmatchedLocal.slice(0, 15)) log(`    ${u}`)
  }
  if (res.unmatchedRemote.length) {
    log(`\n  remote objects not matched by THIS manifest (${res.unmatchedRemote.length}):`)
    log(formatUnmatchedRemote(res.unmatchedRemote))
    log(
      `\n  One account is shared across projects, so this list mixes discarded\n` +
        `  candidates with assets belonging to other manifests. Do not bulk-delete\n` +
        `  it. Run adopt from each project first, then \`pixelkiln salvage\` to\n` +
        `  triage what is left over.`,
    )
  }
  if (args.tag) {
    const n = await tagAdopted(provider, specs, lock, { onProgress: log })
    log(`\n  tagged ${n} object(s) upstream`)
  }
  if (args.writePrompts) {
    const { filled, stillEmpty } = await writePromptsBack(path.resolve(args.manifest), lock, {
      onProgress: log,
      provider: provider.id,
      assetIds: specs.map((spec) => spec.assetId),
    })
    log(`  recovered ${filled} prompt(s) into ${path.relative(process.cwd(), args.manifest)}`)

    // Writing prompts rewrites the manifest, which changes every spec hash.
    // Without re-baselining, an adopt that recovered the true prompts would
    // report all of its own work as stale and offer to regenerate it.
    const reloaded = await loadManifest(args.manifest)
    const rebased = (await resolveSpecs(reloaded, {
      styles: args.styles,
      assets: args.assets,
    })).filter((spec) => spec.provider === provider.id)
    let n = 0
    for (const spec of rebased) {
      const key = lockKey(spec.styleId, spec.assetId)
      if (lock.entries[key]?.status !== "downloaded") continue
      upsertLock(lock, key, { specHash: spec.specHash })
      n++
    }
    await saveLock(args.lock, lock)
    log(`  re-baselined ${n} entr(ies) against the recovered prompts`)
    if (stillEmpty.length) {
      log(`  ${stillEmpty.length} asset(s) still have no prompt (not matched upstream):`)
      for (const id of stillEmpty.slice(0, 10)) log(`    ${id}`)
      if (stillEmpty.length > 10) log(`    … and ${stillEmpty.length - 10} more`)
    }
  }
  log(`\n  lockfile written: ${args.lock}`)
}

export async function runSalvage(args: Args): Promise<void> {
  const { loaded, lock, accountProvider, accountManifest } = await openAccountProject(args)
  const providerFor = providerCache("online")
  const provider = providerFor(accountProvider)
  // --json is a machine-readable contract: stdout must be the JSON array
  // and nothing else, so `pixelkiln salvage --dry-run --json | jq` works.
  // Every human-oriented line below goes through `diag` instead of `log` so
  // it lands on stderr — visible in a terminal, invisible to a pipe — and
  // only the final JSON.stringify call ever reaches console.log.
  const jsonMode = args.dryRun && args.json
  const diag = jsonMode ? (msg = "") => console.error(msg) : log

  // Correctness depends on a complete claim set. Missing a lockfile makes
  // another project's shipped art look unclaimed, so this is stated loudly.
  // This project's own lockfile is optional — salvage is a reasonable first
  // command in a fresh project, which has none yet. Paths given via --claims
  // are required, because a typo there silently widens the orphan set.
  const ownLock = path.resolve(args.lock)
  let workspaceProjects: WorkspaceProject[] = []
  let workspaceDir = ""
  if (args.workspace) {
    const workspacePath = path.resolve(args.workspace)
    workspaceDir = path.dirname(workspacePath)
    const complete = await requireCompleteWorkspaceClaims(workspacePath)
    workspaceProjects = complete.ws.projects
    for (const d of complete.diagnostics) diag(`  WARN  ${d.id}: ${d.message}`)
  }
  const workspaceLockPaths = workspaceProjects.map((p) => resolveProject(workspaceDir, p).lockPath)
  const lockPaths = [
    ...new Set([
      ...workspaceLockPaths,
      ...(existsSync(ownLock) ? [ownLock] : []),
      ...args.claims.map((c) => path.resolve(c)),
    ]),
  ]
  diag(`  claim set (${lockPaths.length} lockfile(s)):`)
  for (const p of lockPaths) diag(`    ${path.relative(process.cwd(), p)}`)
  if (!args.claims.length && !args.workspace) {
    diag(
      `\n  Only this project's lockfile was consulted. If the account is shared,\n` +
        `  pass every other project's lockfile via --claims a.json,b.json, or\n` +
        `  register every project in a workspace catalog and pass --workspace.`,
    )
  } else if (
    args.workspace &&
    !workspaceProjects.some((p) => resolveProject(workspaceDir, p).manifestPath === path.resolve(args.manifest))
  ) {
    diag(
      `\n  This project's manifest is not registered in the workspace catalog. Its own\n` +
        `  lockfile is still included above, so this run's claim set is complete, but\n` +
        `  \`pixelkiln workspace add ${args.manifest}\` would keep it aggregated too.`,
    )
  }

  const claimed = await loadClaims(lockPaths, { provider: provider.id })
  const { orphans, total } = await findOrphans(provider, claimed, { onProgress: diag })
  diag(`  ${claimed.size} claimed · ${orphans.length} unclaimed of ${total}`)
  if (!orphans.length) {
    if (jsonMode) log("[]")
    else log(`\n  nothing to triage`)
    return
  }

  // Each sibling project's manifest, loaded purely so a single-style
  // manifest — which has no pattern of its own to check against — can still
  // recognise "this looks like project X's art" instead of silently
  // claiming everything by default.
  const siblings = await loadSiblingManifests(
    args.manifest,
    workspaceProjects.map((p) => resolveProject(workspaceDir, p).manifestPath),
    args.claims,
  )

  // Which style each orphan's prompt was most likely generated from, so a
  // shared account's orphan pool doesn't get triaged as one undifferentiated
  // blob under whichever style happens to be first in the manifest.
  const { matched, unmatched, elsewhere } = groupOrphansByStyle(orphans, accountManifest, siblings)
  const multiStyle = Object.keys(accountManifest.styles).length > 1
  if (multiStyle) {
    diag(`\n  by style (matched against each style's prompt prefix/suffix):`)
    for (const [id, list] of matched) diag(`    ${id.padEnd(24)} ${list.length}`)
    if (unmatched.length) diag(`    ${"(no style match)".padEnd(24)} ${unmatched.length}`)
  }
  if (elsewhere.size) {
    diag(`\n  matched a sibling project's own style instead of this one:`)
    for (const [label, list] of elsewhere) diag(`    ${label.padEnd(28)} ${list.length}`)
    diag(`  excluded from every session below; not this project's art.`)
  }
  if (unmatched.length) {
    diag(
      `\n  ${unmatched.length} object(s) don't match any known style pattern.\n` +
        `  If the account is shared, they may belong to a different project. Check\n` +
        `  you've passed every sibling project's lockfile via --claims. They're left\n` +
        `  out of the sessions below; force them into one style with --style <id>.`,
    )
  }

  if (args.dryRun) {
    if (args.json) {
      log(JSON.stringify(orphans, null, 2))
    } else {
      const shown = args.all ? orphans : orphans.slice(0, 30)
      for (const o of shown) {
        log(`    ${o.id}  ${o.width}x${o.height}  ${o.createdAt.slice(0, 10)}  ${o.prompt.slice(0, 50)}`)
      }
      if (!args.all && orphans.length > 30) {
        log(`    … and ${orphans.length - 30} more (--all for the full list, --json for machine-readable)`)
      }
    }
    diag(`\n  --dry-run: nothing changed.`)
    return
  }

  const rebaseline = async () => {
    // Imports append to the manifest, so their spec hashes only exist after
    // it is rewritten. Without this every salvaged asset reports `stale` on
    // the next plan and offers to regenerate art that was just recovered —
    // which would re-pay for all of it.
    const reloaded = await loadManifest(args.manifest)
    const rebased = (await resolveSpecs(reloaded)).filter((spec) => spec.provider === provider.id)
    let n = 0
    for (const spec of rebased) {
      const key = lockKey(spec.styleId, spec.assetId)
      const entry = lock.entries[key]
      if (entry?.status !== "downloaded" || entry.specHash !== SALVAGED_SPEC_HASH) continue
      upsertLock(lock, key, { specHash: spec.specHash })
      n++
    }
    await saveLock(args.lock, lock)
    if (n) log(`  baselined ${n} imported asset(s) against the manifest`)
  }

  const runOne = async (styleId: string, list: typeof orphans) => {
    const style = accountManifest.styles[styleId]!
    const res = await runSalvageServer(
      provider,
      list,
      {
        manifestPath: loaded.path,
        manifest: accountManifest,
        styleId,
        importDir: path.resolve(loaded.root, style.outDir),
        lock,
        lockPath: args.lock,
      },
      { port: args.port, open: !args.noOpen, onProgress: log },
    )
    log(
      `  imported ${res.imported} · kept ${res.kept} · tagged-discard ${res.discarded}` +
        (res.failed ? ` · failed ${res.failed}` : ""),
    )
    if (res.imported > 0) await rebaseline()
    return res
  }

  // An explicit --style bypasses grouping entirely and runs one session
  // across every unclaimed object, same as before grouping existed — for
  // when the auto-match misses a real candidate and a human already knows
  // where it belongs.
  if (args.styles.length) {
    const res = await runOne(args.styles[0]!, orphans)
    if (res.discarded) {
      log(`\n  Nothing was deleted. To actually remove the discarded objects:`)
      log(`    pixelkiln purge\n`)
    }
    return
  }

  if (!matched.size) {
    log(`\n  nothing matched a known style; nothing to triage`)
    return
  }

  log(`\n  ${matched.size} session(s), one style at a time:`)
  let totalDiscarded = 0
  for (const [styleId, list] of matched) {
    log(`\n  ${styleId} (${list.length})`)
    const res = await runOne(styleId, list)
    totalDiscarded += res.discarded
  }
  if (totalDiscarded) {
    log(`\n  Nothing was deleted. To actually remove the discarded objects:`)
    log(`    pixelkiln purge\n`)
  }
}

export async function runPurge(args: Args): Promise<void> {
  const { accountProvider } = await openAccountProject(args)
  const providerFor = providerCache("online")
  const provider = providerFor(accountProvider)
  const doomed: { id: string; prompt: string }[] = []
  for await (const obj of requireList(provider)()) {
    if (obj.tags.includes("pixelkiln:discard")) {
      doomed.push({ id: obj.id, prompt: obj.prompt })
    }
  }
  if (!doomed.length) {
    log(`  nothing tagged pixelkiln:discard; run \`pixelkiln salvage\` first`)
    return
  }
  log(`\n  ${doomed.length} object(s) tagged for discard:`)
  for (const d of doomed.slice(0, 20)) log(`    ${d.id}  ${d.prompt.slice(0, 60)}`)
  if (doomed.length > 20) log(`    … and ${doomed.length - 20} more`)

  if (args.dryRun) {
    log(`\n  --dry-run: nothing deleted.`)
    return
  }
  log(`\n  This permanently deletes them from your ${provider.id} account.`)
  log(`  Any local files already downloaded are untouched, but the objects`)
  log(`  and their URLs are gone and cannot be re-downloaded.`)
  if (!(await confirm(`  Delete ${doomed.length} object(s)?`, args.yes))) {
    log(`  aborted`)
    return
  }

  let deleted = 0
  let failed = 0
  for (const d of doomed) {
    try {
      await requireDelete(provider)(d.id)
      deleted++
    } catch (err) {
      failed++
      log(`  delete failed ${d.id}: ${err instanceof Error ? err.message : String(err)}`)
    }
  }
  log(`\n  deleted ${deleted}${failed ? `, failed ${failed}` : ""}`)
}

export async function runTag(args: Args): Promise<void> {
  const { specs, lock } = await openProject(args)
  const providerFor = providerCache("online")
  let tagged = 0
  for (const [providerId, providerSpecsForRun] of specsByRecordedProvider(specs, lock)) {
    tagged += await pushTags(providerFor(providerId), providerSpecsForRun, lock, {
      onProgress: log,
    })
  }
  log(`  tagged ${tagged} object(s)`)
}
