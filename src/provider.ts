import type { Generator, ResolvedSpec, ResolvedStyleImage } from "./types.ts"

/**
 * What a provider charges in. Cost is not universally "generations": PixelLab
 * bills a subscription quota, OpenAI bills dollars per image, a local model
 * bills nothing. `plan` prints the unit alongside the number so the figure is
 * never silently misread, and `--budget` is interpreted in the active unit.
 */
export type CostUnit = "generations" | "usd" | "free"

export interface CostEstimate {
  unit: CostUnit
  amount: number
  /**
   * How many candidates one call returns. This is a provider property, not a
   * universal truth — PixelLab's `1dir` returns up to 64 for a single fixed
   * price, whereas a per-image provider returns one and charges N times for N.
   * The "generate small, pick from many" strategy only pays off where this is
   * greater than 1 at no extra cost.
   */
  candidates: number
}

export interface OutputSource {
  url: string
  /** Stable semantic/index role used in filenames and lockfile outputs. */
  role?: string
}

export interface PollContext {
  /** Distinguishes structural tile sets from independent tile candidates. */
  tileFeature?: string
}

/** Provider-owned, JSON-serializable details needed by downstream exporters. */
export type ProviderMetadata = Record<string, unknown>

/** Terminal and non-terminal states a queued job can be observed in. */
export type JobState =
  | { status: "processing"; progressPercent?: number | null; etaSeconds?: number | null }
  | { status: "review"; candidateUrls: string[] }
  | {
      status: "ready"
      objectId: string
      /** Kept for compatibility with single-output provider implementations. */
      sourceUrl: string | null
      /** Present for structural multi-output results. */
      sources?: OutputSource[]
      /** Preserved under the provider's namespace in the lockfile. */
      metadata?: ProviderMetadata
    }
  | { status: "failed"; error: string }

/** A previously generated asset as the provider reports it. */
export interface RemoteAsset {
  id: string
  prompt: string
  width: number
  height: number
  createdAt: string
  previewUrl: string | null
  tags: string[]
  status: string
}

export interface BalanceInfo {
  unit: CostUnit
  remaining: number
  total?: number
  plan?: string
}

/**
 * Submission constraints a backend enforces upstream, in its own units —
 * `submit` has no business knowing these numbers itself.
 */
export interface RateLimit {
  /** Minimum time between successive submissions, global across the account. */
  spacingMs: number
  /** Background jobs allowed in flight at once. */
  maxInFlight: number
}

/**
 * Used when a provider doesn't declare `rateLimit()` — conservative enough
 * not to be a real constraint for a provider that has none of its own, and
 * overridable per run via `submit`'s own options regardless.
 */
export const DEFAULT_RATE_LIMIT: RateLimit = { spacingMs: 2500, maxInFlight: 8 }

/**
 * A backend that turns a resolved spec into image bytes.
 *
 * Everything above this interface — the manifest, the lockfile, plan diffing,
 * salvage, the contact sheets — is provider-agnostic. Everything that knows a
 * URL shape or an auth header lives below it.
 *
 * The optional members are genuinely optional capabilities rather than
 * convenience: a provider with no queryable asset list cannot support `adopt`
 * or `salvage`, and the CLI reports that rather than failing obscurely.
 */
export interface Provider {
  readonly id: string

  /** False for a generator this backend cannot express (e.g. non-square). */
  supports(generator: Generator): boolean

  /** Never performs I/O — `plan` must stay free and offline. */
  estimate(spec: ResolvedSpec): CostEstimate

  /** This backend's own submission constraints. Falls back to
   *  `DEFAULT_RATE_LIMIT` when absent — see that constant's doc. */
  rateLimit?(): RateLimit

  submit(spec: ResolvedSpec, styleImages: ResolvedStyleImage[]): Promise<{ jobId: string }>

  poll(jobId: string, generator: Generator, context?: PollContext): Promise<JobState>

  /**
   * Promote one candidate from a review-status job to a standalone asset.
   * Only meaningful where `estimate().candidates > 1`.
   *
   * `generator` is passed because "promote" is not universal: PixelLab's
   * frame-based generators create a new account object, while a tiles
   * variation is already a finished image and there is nothing to promote.
   * A provider that treats every candidate alike can ignore it.
   */
  selectCandidate(
    jobId: string,
    index: number,
    commonTag?: string,
    generator?: Generator,
  ): Promise<{ objectId: string; sourceUrl: string | null }>

  /** Storage URLs are usually public; implementations should not send auth. */
  download(url: string): Promise<Buffer>

  balance(): Promise<BalanceInfo>

  /** Free-form labels on the remote asset. Absent if unsupported. */
  setTags?(objectId: string, tags: string[]): Promise<void>

  /** Walk every asset on the account. Required by `adopt` and `salvage`. */
  list?(): AsyncGenerator<RemoteAsset>

  /** Irreversible. Only reached via `purge`, behind explicit confirmation. */
  delete?(assetId: string): Promise<void>
}

export class UnsupportedCapabilityError extends Error {
  constructor(providerId: string, capability: string) {
    super(
      `Provider "${providerId}" does not support ${capability}. ` +
        `That command is unavailable with this backend.`,
    )
    this.name = "UnsupportedCapabilityError"
  }
}

/** Narrowing helpers so call sites fail with a clear message, not `undefined is not a function`. */
export function requireList(provider: Provider): NonNullable<Provider["list"]> {
  if (!provider.list) throw new UnsupportedCapabilityError(provider.id, "listing remote assets")
  return provider.list.bind(provider)
}

export function requireDelete(provider: Provider): NonNullable<Provider["delete"]> {
  if (!provider.delete) throw new UnsupportedCapabilityError(provider.id, "deleting remote assets")
  return provider.delete.bind(provider)
}

export function formatCost(unit: CostUnit, amount: number): string {
  if (unit === "free") return "free"
  if (unit === "usd") return `$${amount.toFixed(2)}`
  return `${amount} generation${amount === 1 ? "" : "s"}`
}
