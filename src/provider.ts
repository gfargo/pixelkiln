import type { Generator, ResolvedSpec, ResolvedStyleImage } from "./types.ts"
import type { MediaType } from "./media.ts"

/**
 * Human-readable unit attached to every estimate and recorded charge.
 * Built-ins use generations, USD, free, and compute units. Adapters may report
 * another non-convertible unit without pretending it is dollars.
 */
export type CostUnit = "generations" | "usd" | "free" | (string & {})

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

/** Runtime guard for third-party adapters before estimates influence a budget. */
export function validateCostEstimate(providerId: string, value: unknown): CostEstimate {
  if (!value || typeof value !== "object") {
    throw new Error(`Provider "${providerId}" returned an invalid cost estimate`)
  }
  const estimate = value as Partial<CostEstimate>
  if (typeof estimate.unit !== "string" || !estimate.unit.trim()) {
    throw new Error(`Provider "${providerId}" returned an invalid cost unit`)
  }
  if (!Number.isFinite(estimate.amount) || estimate.amount! < 0) {
    throw new Error(`Provider "${providerId}" returned an invalid cost amount`)
  }
  if (estimate.unit === "free" && estimate.amount !== 0) {
    throw new Error(`Provider "${providerId}" returned a nonzero amount with the free cost unit`)
  }
  if (!Number.isInteger(estimate.candidates) || estimate.candidates! < 1) {
    throw new Error(`Provider "${providerId}" returned an invalid candidate count`)
  }
  return estimate as CostEstimate
}

export interface OutputSource {
  url: string
  /** Stable semantic/index role used in filenames and lockfile outputs. */
  role?: string
  /** Durable byte format. Omission preserves legacy PNG behavior. */
  mediaType?: MediaType
}

export interface PollContext {
  /** Distinguishes structural tile sets from independent tile candidates. */
  tileFeature?: string
  /** Current resolved intent, needed when output media depends on provider options. */
  spec?: ResolvedSpec
}

/** Provider-owned, JSON-serializable details needed by downstream exporters. */
export type ProviderMetadata = Record<string, unknown>

export interface ProviderSubmission {
  jobId: string
  /** Authoritative provider details known at submission, such as a live quote. */
  metadata?: ProviderMetadata
}

export interface CandidateSelection {
  objectId: string
  sourceUrl: string | null
  /** Details known only after choosing an output, such as its durable asset id. */
  metadata?: ProviderMetadata
}

export interface ProviderOptionContext {
  /** Absolute directory containing the manifest. */
  root: string
  styleId: string
}

export interface ResolvedProviderOptions {
  /** Runtime options passed to estimate, validate, and submit. */
  options: Record<string, unknown>
  /** Stable JSON value hashed instead of runtime-only data when present. */
  identity?: unknown
}

/** Terminal and non-terminal states a queued job can be observed in. */
export type JobState =
  | { status: "processing"; progressPercent?: number | null; etaSeconds?: number | null }
  | { status: "review"; candidateUrls: string[]; metadata?: ProviderMetadata }
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

export interface BalanceChange {
  unit: CostUnit
  before: number
  after: number
  /** Provider-reported quota/currency consumed between the two readings. */
  spent: number
  /** Quota/currency added between readings, e.g. a refill during the run. */
  credited: number
}

/** Compare two provider readings without ever combining incompatible units. */
export function measureBalanceChange(
  before: BalanceInfo,
  after: BalanceInfo,
): BalanceChange | null {
  if (
    before.unit !== after.unit ||
    !Number.isFinite(before.remaining) ||
    !Number.isFinite(after.remaining)
  ) return null
  const delta = before.remaining - after.remaining
  return {
    unit: before.unit,
    before: before.remaining,
    after: after.remaining,
    spent: Math.max(0, delta),
    credited: Math.max(0, -delta),
  }
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
 * A backend that turns a resolved spec into durable image or animation bytes.
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

  /**
   * Resolve provider-owned local files before spec hashing. This must remain
   * offline and return JSON-serializable data. It lets adapters hash file
   * content rather than a machine-specific path.
   */
  resolveOptions?(
    options: Record<string, unknown>,
    context: ProviderOptionContext,
  ): Promise<ResolvedProviderOptions>

  /** False for a generator this backend cannot express (e.g. non-square). */
  supports(generator: Generator): boolean

  /** Never performs I/O — `plan` must stay free and offline. */
  estimate(spec: ResolvedSpec): CostEstimate

  /** Provider-specific, offline validation after references resolve. */
  validate?(spec: ResolvedSpec, styleImages: ResolvedStyleImage[]): void

  /** This backend's own submission constraints. Falls back to
   *  `DEFAULT_RATE_LIMIT` when absent — see that constant's doc. */
  rateLimit?(): RateLimit

  submit(spec: ResolvedSpec, styleImages: ResolvedStyleImage[]): Promise<ProviderSubmission>

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
  selectCandidate?(
    jobId: string,
    index: number,
    commonTag?: string,
    generator?: Generator,
  ): Promise<CandidateSelection>

  /** Storage URLs are usually public; implementations should not send auth. */
  download(url: string): Promise<Buffer>

  /** Query an authoritative account balance when the service exposes one. */
  balance?(): Promise<BalanceInfo>

  /** Read-only connectivity probe for providers without a balance endpoint. */
  checkConnection?(): Promise<void>

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

export function requireSelectCandidate(
  provider: Provider,
): NonNullable<Provider["selectCandidate"]> {
  if (!provider.selectCandidate) {
    throw new UnsupportedCapabilityError(provider.id, "candidate selection")
  }
  return provider.selectCandidate.bind(provider)
}

export function requireBalance(provider: Provider): NonNullable<Provider["balance"]> {
  if (!provider.balance) throw new UnsupportedCapabilityError(provider.id, "account balance")
  return provider.balance.bind(provider)
}

export function formatCost(unit: CostUnit, amount: number): string {
  if (unit === "free") return "free"
  if (unit === "usd") return `$${amount.toFixed(2)}`
  if (unit === "generations") return `${amount} generation${amount === 1 ? "" : "s"}`
  return `${amount} ${unit}`
}
