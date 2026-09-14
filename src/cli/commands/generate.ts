/** The generation lifecycle: submit, poll, pick, fetch, restore, and `gen` which chains them. */
import { formatCost, measureBalanceChange, type BalanceInfo } from "../../provider.ts"
import { BudgetError } from "../../errors.ts"
import { saveLock } from "../../lock.ts"
import { lockKey } from "../../types.ts"
import { buildPlan } from "../../pipeline/plan.ts"
import { submit } from "../../pipeline/submit.ts"
import { poll } from "../../pipeline/poll.ts"
import { fetchAssets, pushTags } from "../../pipeline/fetch.ts"
import { runPicker } from "../../pick/server.ts"
import { inspectQualityProfile } from "../../pipeline/quality-profile.ts"
import { openProject, providerCache, providerModeFor, specsByRecordedProvider, budgetsForPlan } from "../project.ts"
import { log, confirm, announceReviewReady, printPlan, printResumeActions } from "../io.ts"
import type { Args } from "../args.ts"

export async function runGenerate(args: Args): Promise<void> {
  const { loaded, specs, lock } = await openProject(args)
  const plan = await buildPlan(specs, lock, { force: args.force })
  const providerFor = providerCache(providerModeFor(args))
  if (args.command === "submit" || args.command === "gen") {
    printPlan(plan)
    if (args.dryRun) {
      log(`\n  --dry-run: stopping before any spend.`)
      return
    }
    if (plan.actionable.length) {
      const budgets = budgetsForPlan(plan, args)
      const balances = new Map<string, BalanceInfo | null>()
      // Validate every ceiling and available balance before the first provider
      // can spend. A later group must never reveal that the whole run was
      // unaffordable only after an earlier group already submitted work.
      for (const group of plan.groups) {
        const groupProvider = providerFor(group.provider)
        const balance = groupProvider.balance ? await groupProvider.balance() : null
        balances.set(group.provider, balance)
        if (balance) {
          log(
            `\n  balance: ${formatCost(balance.unit, balance.remaining)} remaining ` +
              `(${group.provider})`,
          )
          if (balance.unit !== group.costUnit) {
            throw new BudgetError(
              `Provider ${group.provider} estimate unit ${group.costUnit} does not match ` +
                `balance unit ${balance.unit}.`,
            )
          }
          if (balance.unit !== "free" && group.cost > balance.remaining) {
            throw new BudgetError(
              `${group.provider} needs ${formatCost(balance.unit, group.cost)} but only ` +
                `${formatCost(balance.unit, balance.remaining)} remain.`,
            )
          }
        } else {
          log(
            `\n  ${group.provider} does not expose an account balance; ` +
              `enforcing its run budget`,
          )
        }
        const ceiling = budgets.get(group.provider)
        if (ceiling !== undefined && group.cost > ceiling) {
          throw new BudgetError(
            `${group.provider} would spend ${formatCost(group.costUnit, group.cost)} but its ` +
              `budget is ${formatCost(group.costUnit, ceiling)}.`,
          )
        }
      }
      const spendSummary = plan.groups
        .map((group) => `${group.provider} ${formatCost(group.costUnit, group.cost)}`)
        .join("; ")
      const ok = await confirm(
        `  Spend ${spendSummary} on ${plan.actionable.length} asset(s)?`,
        args.yes,
      )
      if (!ok) {
        log(`  aborted`)
        return
      }
      log(`\n  submitting…`)
      for (const group of plan.groups) {
        const groupProvider = providerFor(group.provider)
        const res = await submit(groupProvider, loaded, group.actionable, lock, args.lock, {
          budget: budgets.get(group.provider),
          onProgress: log,
        })
        log(
          `\n  ${group.provider}: submitted ${res.submitted}, failed ${res.failed}, ` +
            `estimated ${formatCost(res.unit, res.spent)}`,
        )
        try {
          const before = balances.get(group.provider)
          const after = before && groupProvider.balance ? await groupProvider.balance() : null
          if (!before || !after) throw new Error("balance reporting is unsupported")
          const measured = measureBalanceChange(before, after)
          if (measured) {
            const movement = measured.credited
              ? `${formatCost(measured.unit, measured.credited)} credited`
              : `${formatCost(measured.unit, measured.spent)} consumed`
            log(`  ${group.provider} balance change: ${movement}`)
          } else {
            log(`  ${group.provider} changed balance units; no delta reported`)
          }
        } catch (err) {
          log(
            `  ${group.provider} balance recheck unavailable: ` +
              `${err instanceof Error ? err.message : String(err)}`,
          )
        }
        if (res.failed) process.exitCode = 1
      }
    }
    if (args.command === "submit") return
  }

  if (args.command === "poll" || args.command === "gen") {
    log(`\n  polling…`)
    const total = { completed: 0, review: 0, failed: 0, stillRunning: 0 }
    for (const [providerId, providerSpecsForRun] of specsByRecordedProvider(specs, lock)) {
      const res = await poll(providerFor(providerId), lock, args.lock, {
        onProgress: log,
        specs: providerSpecsForRun,
      })
      total.completed += res.completed
      total.review += res.review
      total.failed += res.failed
      total.stillRunning += res.stillRunning
    }
    log(
      `\n  ${total.completed} ready · ${total.review} awaiting selection · ` +
        `${total.failed} failed`,
    )
    if (total.failed || total.stillRunning) process.exitCode = 1
    if (args.command === "poll") {
      printResumeActions(specs, lock)
      return
    }
  }

  if (args.command === "pick" || args.command === "gen") {
    const total = { selected: 0, skipped: 0 }
    for (const [providerId, providerSpecsForRun] of specsByRecordedProvider(specs, lock)) {
      const res = await runPicker(providerFor(providerId), lock, args.lock, {
        port: args.port,
        open: !args.noOpen,
        onProgress: log,
        onReady: announceReviewReady,
        keys: providerSpecsForRun.map((spec) => lockKey(spec.styleId, spec.assetId)),
        specs: providerSpecsForRun,
      })
      total.selected += res.selected
      total.skipped += res.skipped
    }
    if (total.selected === 0 && total.skipped === 0) {
      log(`  nothing awaiting selection`)
    } else {
      log(`\n  selected ${total.selected}, left in review ${total.skipped}`)
    }
    if (args.command === "gen" && total.skipped) process.exitCode = 1
    if (args.command === "pick") {
      printResumeActions(specs, lock)
      return
    }
  }

  if (args.command === "fetch" || args.command === "restore" || args.command === "gen") {
    log(`\n  downloading…`)
    const total = { downloaded: 0, skipped: 0, failed: 0, tagged: 0, unchanged: 0 }
    for (const [providerId, providerSpecsForRun] of specsByRecordedProvider(specs, lock)) {
      const groupProvider = providerFor(providerId)
      const res = await fetchAssets(groupProvider, providerSpecsForRun, lock, args.lock, {
        onProgress: log,
        repair: args.command === "restore",
        force: args.force,
        refresh: args.command === "fetch" && args.refresh,
      })
      total.downloaded += res.downloaded
      total.skipped += res.skipped
      total.failed += res.failed
      total.unchanged += res.unchanged ?? 0
      if (args.tag) {
        total.tagged += await pushTags(groupProvider, providerSpecsForRun, lock, {
          onProgress: log,
        })
      }
    }
    log(
      `\n  downloaded ${total.downloaded}, skipped ${total.skipped}, failed ${total.failed}` +
        (args.refresh ? `, unchanged upstream ${total.unchanged}` : ""),
    )
    if (total.failed) process.exitCode = 1
    if (args.tag) log(`  tagged ${total.tagged} object(s) upstream`)
    await saveLock(args.lock, lock)
    log(`  lockfile written: ${args.lock}`)
    const resumeActionCount = printResumeActions(specs, lock)
    if (args.command === "gen" && specs.some((spec) => spec.quality) && !total.failed) {
      const quality = (await Promise.all(
        specs.filter((spec) => spec.quality).map((spec) => inspectQualityProfile(spec, lock)),
      )).filter((item) => item !== null)
      const blocked = quality.filter((item) => item.state === "blocked")
      if (blocked.length) {
        log(
          `\n  ${blocked.length} quality source${blocked.length === 1 ? " is" : "s are"} not ready; ` +
            (resumeActionCount
              ? "finish the resume steps above before refining."
              : "run `pixelkiln plan` for the blocking reason before refining."),
        )
      } else {
        log(`\n  Raw provider output is ready. Run \`pixelkiln refine\` to build the configured quality output.`)
        log(`  Packaging stays blocked until each refined PNG has a current human approval.`)
      }
    }
    return
  }
}
