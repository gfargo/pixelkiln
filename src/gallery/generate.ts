import { randomBytes } from "node:crypto"
import { z } from "zod"
import { fetchAssets } from "../pipeline/fetch.ts"
import { buildPlan, type PlanGroup } from "../pipeline/plan.ts"
import { poll } from "../pipeline/poll.ts"
import { submit } from "../pipeline/submit.ts"
import { prepareReview, type PickResult, type ReviewSession } from "../pick/server.ts"
import type { RenderSheetOptions } from "../pick/sheet.ts"
import { formatCost, type CostUnit, type Provider } from "../provider.ts"
import type { LoadedManifest } from "../manifest.ts"
import { lockKey, type Lock, type ResolvedSpec } from "../types.ts"
import type { GalleryBuild } from "./snapshot.ts"

/**
 * Generation from the gallery is the CLI's `gen`, run as a background job:
 * the same `buildPlan`, the same per-provider budget and balance preflight,
 * the same `submit → poll → fetch` library calls writing the same lockfile.
 * The page adds nothing the terminal cannot do; it only shows the estimate,
 * asks, and reports progress.
 *
 * Two ceilings guard spend. The session budget is passed when the gallery
 * starts (`--budget`, optionally keyed per provider) and every job's estimate
 * is charged against it up front, so the page can never exceed what the
 * person typed. Each submission also carries the remaining ceiling as its
 * own `budget`, the way `gen --budget` does, so a provider estimate that
 * grows between plan and submit is refused rather than paid.
 */
export type GeneratePhase =
  | "queued"
  | "submitting"
  | "polling"
  | "fetching"
  | "review"
  | "done"
  | "failed"

export interface GenerateJob {
  id: string
  project: string | null
  keys: string[]
  /** `resume` skips submission: poll, review, and fetch existing work at no cost. */
  mode: "generate" | "resume"
  phase: GeneratePhase
  startedAt: string
  finishedAt: string | null
  /** Progress lines, exactly what the CLI would have printed. */
  messages: string[]
  error: string | null
  /** Successful-submission estimates this job charged, by provider. */
  spent: Record<string, number>
  /** Keys still waiting for a human choice. */
  review: string[]
  counts: { submitted: number; failed: number; downloaded: number }
}

export interface GalleryProjectContext {
  loaded: LoadedManifest
  /** Every spec the project declares, unfiltered. */
  specs: ResolvedSpec[]
  lock: Lock
  lockPath: string
}

export interface SessionBudget {
  /** Unkeyed ceiling, valid only when a run involves a single provider. */
  amount?: number
  /** Provider-keyed ceilings. */
  byProvider: Record<string, number>
}

export interface GenerateHandlerOptions {
  /** Load a project fresh from disk; `project` is the workspace id, if any. */
  loadProject: (project?: string) => Promise<GalleryProjectContext>
  /** An online provider for a project; the caller owns env loading and caching. */
  providerFor: (project: string | undefined, providerId: string) => Provider
  budget: SessionBudget
  reload: () => Promise<GalleryBuild>
  onProgress?: (msg: string) => void
  /** Test hooks. */
  pollIntervalMs?: number
  submitSpacingMs?: number
  /** Deterministic clock hook. */
  now?: () => Date
}

export interface GenerateStatus {
  jobs: GenerateJob[]
  budget: SessionBudget
  /** Estimates charged so far this session, by provider. */
  spent: Record<string, number>
  /** Providers whose spend unit is known, for display. */
  units: Record<string, CostUnit>
}

export interface GalleryGenerateHandlers {
  start(body: unknown): Promise<GenerateJob>
  status(): GenerateStatus
  /** The embedded review sheet for a job's waiting keys; null when nothing waits. */
  review(jobId: string, options: RenderSheetOptions & { routePrefix: string }): Promise<ReviewSession | null>
  applyReview(jobId: string, body: unknown): Promise<PickResult>
}

export const GenerateRequestSchema = z
  .object({
    project: z.string().min(1).optional(),
    keys: z.array(z.string().min(1)).min(1).max(500),
    /** Regenerate work that is up to date, as `gen --force` does. */
    force: z.boolean().optional(),
    /** Advance in-flight, review, or selected work without submitting anything. */
    resume: z.boolean().optional(),
  })
  .strict()

export class GenerateRequestError extends Error {
  constructor(message: string, readonly status: number = 400) {
    super(message)
    this.name = "GenerateRequestError"
  }
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** The ceiling one provider group may spend now, after what this session already charged. */
function remainingFor(
  group: PlanGroup,
  groupCount: number,
  budget: SessionBudget,
  spent: Record<string, number>,
): number {
  const keyed = budget.byProvider[group.provider]
  if (keyed === undefined && groupCount > 1 && budget.amount !== undefined) {
    throw new GenerateRequestError(
      "This run spans several providers; start the gallery with a keyed budget for each, " +
        "for example --budget pixellab=40 --budget retrodiffusion=1.25.",
    )
  }
  const ceiling = keyed ?? (groupCount === 1 ? budget.amount : undefined)
  if (ceiling === undefined) {
    throw new GenerateRequestError(
      `No session budget for ${group.provider}; start the gallery with --budget ${group.provider}=<amount>.`,
    )
  }
  return Math.max(0, ceiling - (spent[group.provider] ?? 0))
}

export function createGenerateHandlers(opts: GenerateHandlerOptions): GalleryGenerateHandlers {
  const log = opts.onProgress ?? (() => {})
  const now = opts.now ?? (() => new Date())
  const jobs = new Map<string, GenerateJob>()
  const spent: Record<string, number> = {}
  const units: Record<string, CostUnit> = {}
  /** Per-job project state, kept off the JSON the page sees. */
  const contexts = new Map<string, GalleryProjectContext>()
  const reviews = new Map<string, ReviewSession>()

  const busyKeys = () => {
    const busy = new Map<string, string>()
    for (const job of jobs.values()) {
      if (job.phase === "done" || job.phase === "failed") continue
      for (const key of job.keys) busy.set(`${job.project ?? ""}:${key}`, job.id)
    }
    return busy
  }

  const say = (job: GenerateJob, line: string) => {
    job.messages.push(line)
    if (job.messages.length > 400) job.messages.splice(0, job.messages.length - 400)
    log(`  [${job.id.slice(0, 6)}] ${line.trim()}`)
  }

  const groupByRecordedProvider = (specs: ResolvedSpec[], lock: Lock) => {
    const groups = new Map<string, ResolvedSpec[]>()
    for (const spec of specs) {
      const entry = lock.entries[lockKey(spec.styleId, spec.assetId)]
      const providerId = entry?.provider ?? spec.provider
      groups.set(providerId, [...(groups.get(providerId) ?? []), spec])
    }
    return groups
  }

  async function settle(job: GenerateJob, ctx: GalleryProjectContext, specs: ResolvedSpec[]) {
    job.phase = "polling"
    for (const [providerId, providerSpecs] of groupByRecordedProvider(specs, ctx.lock)) {
      const provider = opts.providerFor(job.project ?? undefined, providerId)
      const res = await poll(provider, ctx.lock, ctx.lockPath, {
        onProgress: (line) => say(job, line),
        specs: providerSpecs,
        intervalMs: opts.pollIntervalMs,
      })
      say(job, `${providerId}: ${res.completed} completed, ${res.review} awaiting review, ${res.failed} failed, ${res.stillRunning} still running`)
    }
    job.review = specs
      .map((spec) => lockKey(spec.styleId, spec.assetId))
      .filter((key) => ctx.lock.entries[key]?.status === "review")

    job.phase = "fetching"
    for (const [providerId, providerSpecs] of groupByRecordedProvider(specs, ctx.lock)) {
      const provider = opts.providerFor(job.project ?? undefined, providerId)
      const res = await fetchAssets(provider, providerSpecs, ctx.lock, ctx.lockPath, {
        onProgress: (line) => say(job, line),
      })
      job.counts.downloaded += res.downloaded
      if (res.downloaded || res.failed) {
        say(job, `${providerId}: downloaded ${res.downloaded}, skipped ${res.skipped}, failed ${res.failed}`)
      }
    }
    if (job.review.length) {
      job.phase = "review"
      say(job, `${job.review.length} asset(s) awaiting selection`)
    } else {
      job.phase = "done"
      job.finishedAt = now().toISOString()
    }
  }

  async function run(job: GenerateJob, ctx: GalleryProjectContext, specs: ResolvedSpec[], groups: PlanGroup[]) {
    try {
      if (job.mode === "generate") {
        job.phase = "submitting"
        for (const group of groups) {
          const provider = opts.providerFor(job.project ?? undefined, group.provider)
          const ceiling = remainingFor(group, groups.length, opts.budget, spent)
          // Same preflight as `gen`: a known balance must cover the estimate,
          // in the same unit, before the first request is made.
          if (provider.balance) {
            const balance = await provider.balance()
            say(job, `balance: ${formatCost(balance.unit, balance.remaining)} remaining (${group.provider})`)
            if (balance.unit !== group.costUnit) {
              throw new Error(
                `Provider ${group.provider} estimate unit ${group.costUnit} does not match balance unit ${balance.unit}.`,
              )
            }
            if (balance.unit !== "free" && group.cost > balance.remaining) {
              throw new Error(
                `${group.provider} needs ${formatCost(balance.unit, group.cost)} but only ` +
                  `${formatCost(balance.unit, balance.remaining)} remain.`,
              )
            }
          }
          const res = await submit(provider, ctx.loaded, group.actionable, ctx.lock, ctx.lockPath, {
            budget: ceiling,
            onProgress: (line) => say(job, line),
            spacingMs: opts.submitSpacingMs,
          })
          spent[group.provider] = (spent[group.provider] ?? 0) + res.spent
          units[group.provider] = res.unit
          job.spent[group.provider] = (job.spent[group.provider] ?? 0) + res.spent
          job.counts.submitted += res.submitted
          job.counts.failed += res.failed
          say(job, `${group.provider}: submitted ${res.submitted}, failed ${res.failed}, estimated ${formatCost(res.unit, res.spent)}`)
        }
      }
      await settle(job, ctx, specs)
    } catch (error) {
      job.phase = "failed"
      job.error = message(error)
      job.finishedAt = now().toISOString()
      say(job, `failed: ${job.error}`)
    }
  }

  return {
    async start(body) {
      const parsed = GenerateRequestSchema.safeParse(body)
      if (!parsed.success) {
        throw new GenerateRequestError(
          "invalid request: " +
            parsed.error.issues.slice(0, 3).map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; "),
        )
      }
      const request = parsed.data
      const ctx = await opts.loadProject(request.project)
      const byKey = new Map(ctx.specs.map((spec) => [lockKey(spec.styleId, spec.assetId), spec]))
      const specs: ResolvedSpec[] = []
      for (const key of request.keys) {
        const spec = byKey.get(key)
        if (!spec) throw new GenerateRequestError(`"${key}" is not declared by the manifest`)
        specs.push(spec)
      }
      const busy = busyKeys()
      for (const key of request.keys) {
        const holder = busy.get(`${request.project ?? ""}:${key}`)
        if (holder) throw new GenerateRequestError(`"${key}" is already being worked on by job ${holder}`, 409)
      }

      let groups: PlanGroup[] = []
      if (!request.resume) {
        const plan = await buildPlan(specs, ctx.lock, { force: request.force })
        if (!plan.actionable.length) {
          const reasons = plan.items.map((item) => `${item.key}: ${item.state} — ${item.reason}`).slice(0, 5)
          throw new GenerateRequestError(`nothing to generate; ${reasons.join("; ")}`)
        }
        groups = plan.groups
        // Charge the session budget before anything is queued so two quick
        // clicks cannot both fit under the same remaining amount.
        for (const group of groups) {
          const remaining = remainingFor(group, groups.length, opts.budget, spent)
          if (group.cost > remaining) {
            throw new GenerateRequestError(
              `${group.provider} would spend ${formatCost(group.costUnit, group.cost)} but only ` +
                `${formatCost(group.costUnit, remaining)} of this session's budget remain.`,
            )
          }
        }
      }

      const job: GenerateJob = {
        id: randomBytes(8).toString("hex"),
        project: request.project ?? null,
        keys: request.keys,
        mode: request.resume ? "resume" : "generate",
        phase: "queued",
        startedAt: now().toISOString(),
        finishedAt: null,
        messages: [],
        error: null,
        spent: {},
        review: [],
        counts: { submitted: 0, failed: 0, downloaded: 0 },
      }
      jobs.set(job.id, job)
      contexts.set(job.id, ctx)
      say(job, request.resume
        ? `resuming ${request.keys.length} asset(s) at no cost`
        : `generating ${groups.reduce((n, g) => n + g.actionable.length, 0)} asset(s): ` +
          groups.map((g) => `${g.provider} ${formatCost(g.costUnit, g.cost)}`).join("; "))
      void run(job, ctx, specs, groups)
      return job
    },

    status() {
      return {
        jobs: [...jobs.values()].sort((a, b) => b.startedAt.localeCompare(a.startedAt)),
        budget: opts.budget,
        spent,
        units,
      }
    },

    async review(jobId, options) {
      const job = jobs.get(jobId)
      const ctx = contexts.get(jobId)
      if (!job || !ctx || job.phase !== "review" || !job.review.length) return null
      const specs = ctx.specs.filter((spec) => job.review.includes(lockKey(spec.styleId, spec.assetId)))
      // One session per provider would be needed for a mixed set; review sets
      // are grouped by the provider that produced them, like `pick`.
      const providers = [...groupByRecordedProvider(specs, ctx.lock).keys()]
      const providerId = providers[0]
      if (!providerId) return null
      const session = await prepareReview(opts.providerFor(job.project ?? undefined, providerId), ctx.lock, {
        keys: job.review,
        specs,
        onProgress: (line) => say(job, line),
        routePrefix: options.routePrefix,
      })
      if (session) reviews.set(jobId, session)
      return session
    },

    async applyReview(jobId, body) {
      const job = jobs.get(jobId)
      const ctx = contexts.get(jobId)
      const session = reviews.get(jobId)
      if (!job || !ctx || !session) throw new GenerateRequestError("no review is open for this job", 404)
      const result = await session.apply(body, ctx.lockPath)
      say(job, `selected ${result.selected}, left in review ${result.skipped}`)
      reviews.delete(jobId)
      const specs = ctx.specs.filter((spec) => job.review.includes(lockKey(spec.styleId, spec.assetId)))
      void settle(job, ctx, specs).catch((error) => {
        job.phase = "failed"
        job.error = message(error)
        job.finishedAt = now().toISOString()
        say(job, `failed: ${job.error}`)
      })
      return result
    },
  }
}
