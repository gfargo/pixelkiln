import { MAX_DOWNLOAD_BYTES } from "../client.ts"
import { MediaType } from "../media.ts"
import type {
  CandidateSelection,
  CostEstimate,
  JobState,
  PollContext,
  Provider,
  ProviderMetadata,
  ProviderSubmission,
  RateLimit,
} from "../provider.ts"
import type { Generator, ResolvedSpec, ResolvedStyleImage } from "../types.ts"

const DEFAULT_BASE_URL = "https://api.cloud.scenario.com/v1"
const SOURCE_PROTOCOL = "scenario:"
const PROTECTED_PARAMETERS = new Set([
  "dryRun",
  "height",
  "maxComputeUnits",
  "numOutputs",
  "projectId",
  "prompt",
  "seed",
  "width",
])

export interface ScenarioOptions {
  /** Scenario model passed to POST /generate/custom/{modelId}. */
  modelId: string
  /** Conservative per-asset ceiling used by offline planning and live preflight. */
  maxComputeUnits: number
  /** Number of images requested. More than one enters PixelKiln review. */
  numOutputs?: number
  /** Optional Scenario project ownership/routing id. */
  projectId?: string
  /** Additional model-specific JSON inputs that cannot replace PixelKiln-owned intent. */
  parameters?: Record<string, unknown>
}

interface ScenarioQuote {
  total: number
  creativeUnitsCost: number
  costDetails: Record<string, number>
  ipDetectionCost: number
}

interface ScenarioJob {
  jobId: string
  status: string
  progress?: number
  metadata?: {
    assetIds?: unknown
    error?: unknown
  }
  billing?: {
    cuCost?: unknown
    cuDiscount?: unknown
    cuCostDetails?: unknown
  }
}

interface ScenarioAsset {
  id: string
  url: string
  originalFileUrl?: string
  originalMimeType?: string
  outputIndex: number
}

class ScenarioClient {
  constructor(
    private readonly apiKey: string | undefined,
    private readonly apiSecret: string | undefined,
    private readonly baseUrl = DEFAULT_BASE_URL,
    private readonly request: typeof fetch = fetch,
  ) {}

  async quote(modelId: string, body: Record<string, unknown>, projectId?: string): Promise<ScenarioQuote> {
    const response = await this.call(
      `/generate/custom/${encodeURIComponent(modelId)}`,
      { method: "POST", body: JSON.stringify(body) },
      { dryRun: "true", projectId },
    )
    const creativeUnitsCost = finiteNonnegative(
      (response as { creativeUnitsCost?: unknown })?.creativeUnitsCost,
      "Scenario dry run returned an invalid creativeUnitsCost",
    )
    const costDetails = numericRecord((response as { costDetails?: unknown })?.costDetails)
    const ipDetectionCost = optionalFiniteNonnegative(
      (response as { ipDetection?: { creativeUnitsCharged?: unknown } })?.ipDetection
        ?.creativeUnitsCharged,
      "Scenario dry run returned an invalid IP-detection cost",
    )
    return {
      total: creativeUnitsCost + ipDetectionCost,
      creativeUnitsCost,
      costDetails,
      ipDetectionCost,
    }
  }

  async submit(
    modelId: string,
    body: Record<string, unknown>,
    projectId?: string,
  ): Promise<string> {
    const response = await this.call(
      `/generate/custom/${encodeURIComponent(modelId)}`,
      { method: "POST", body: JSON.stringify(body) },
      { projectId },
    )
    const job = (response as { job?: unknown })?.job
    const jobId = readJobId(job)
    if (!jobId) throw new Error("Scenario did not return an async job id")
    return jobId
  }

  async job(id: string, projectId?: string): Promise<ScenarioJob> {
    const response = await this.call(`/jobs/${encodeURIComponent(id)}`, {}, { projectId })
    const raw = (response as { job?: unknown })?.job
    if (!raw || typeof raw !== "object") throw new Error("Scenario returned an invalid job")
    const record = raw as Record<string, unknown>
    const jobId = readJobId(raw)
    if (!jobId || typeof record.status !== "string") {
      throw new Error("Scenario returned an invalid job")
    }
    return {
      jobId,
      status: record.status,
      ...(typeof record.progress === "number" ? { progress: record.progress } : {}),
      ...(record.metadata && typeof record.metadata === "object"
        ? { metadata: record.metadata as ScenarioJob["metadata"] }
        : {}),
      ...(record.billing && typeof record.billing === "object"
        ? { billing: record.billing as ScenarioJob["billing"] }
        : {}),
    }
  }

  async asset(id: string, projectId?: string): Promise<ScenarioAsset> {
    const response = await this.call(
      `/assets/${encodeURIComponent(id)}`,
      {},
      { originalAssets: "true", projectId },
    )
    const raw = (response as { asset?: unknown })?.asset
    if (!raw || typeof raw !== "object") throw new Error(`Scenario returned an invalid asset ${id}`)
    const asset = raw as Record<string, unknown>
    const assetId = typeof asset.id === "string" && asset.id ? asset.id : id
    const url = typeof asset.url === "string" ? asset.url : ""
    const originalFileUrl = typeof asset.originalFileUrl === "string"
      ? asset.originalFileUrl
      : undefined
    if (!originalFileUrl && !url) throw new Error(`Scenario asset ${assetId} has no download URL`)
    const metadata = isRecord(asset.metadata) ? asset.metadata : {}
    const rawOutputIndex = asset.outputIndex ?? metadata.outputIndex
    const outputIndex = Number.isInteger(rawOutputIndex) && Number(rawOutputIndex) >= 0
      ? Number(rawOutputIndex)
      : Number.MAX_SAFE_INTEGER
    const originalMimeType = typeof asset.originalMimeType === "string"
      ? asset.originalMimeType
      : typeof asset.mimeType === "string"
        ? asset.mimeType
        : undefined
    return {
      id: assetId,
      url,
      ...(originalFileUrl ? { originalFileUrl } : {}),
      ...(originalMimeType ? { originalMimeType } : {}),
      outputIndex,
    }
  }

  async download(url: string): Promise<Buffer> {
    const parsed = new URL(url)
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      throw new Error("Scenario downloads must use HTTP or HTTPS")
    }
    const response = await this.request(parsed)
    if (!response.ok) throw new Error(`Scenario download failed (${response.status})`)
    const declared = Number(response.headers.get("content-length"))
    if (Number.isFinite(declared) && declared > MAX_DOWNLOAD_BYTES) {
      throw new Error(`Scenario download exceeds the ${MAX_DOWNLOAD_BYTES}-byte safety limit`)
    }
    const bytes = Buffer.from(await response.arrayBuffer())
    if (bytes.length > MAX_DOWNLOAD_BYTES) {
      throw new Error(`Scenario download exceeds the ${MAX_DOWNLOAD_BYTES}-byte safety limit`)
    }
    return bytes
  }

  async checkConnection(): Promise<void> {
    await this.call("/models", {}, { pageSize: "1" })
  }

  private async call(
    pathname: string,
    init: RequestInit = {},
    query: Record<string, string | undefined> = {},
  ): Promise<unknown> {
    if (!this.apiKey || !this.apiSecret) {
      const missing = [
        !this.apiKey ? "SCENARIO_SDK_API_KEY" : null,
        !this.apiSecret ? "SCENARIO_SDK_API_SECRET" : null,
      ].filter(Boolean)
      throw new Error(`${missing.join(" and ")} ${missing.length > 1 ? "are" : "is"} not set`)
    }
    const url = new URL(`${this.baseUrl.replace(/\/$/, "")}${pathname}`)
    for (const [key, value] of Object.entries(query)) {
      if (value != null) url.searchParams.set(key, value)
    }
    const auth = Buffer.from(`${this.apiKey}:${this.apiSecret}`).toString("base64")
    const response = await this.request(url, {
      ...init,
      headers: {
        Accept: "application/json",
        Authorization: `Basic ${auth}`,
        ...(init.body ? { "Content-Type": "application/json" } : {}),
        ...init.headers,
      },
    })
    const text = await response.text()
    let value: unknown = null
    try {
      value = text ? JSON.parse(text) : null
    } catch {
      value = text
    }
    if (!response.ok) {
      const retry = response.headers.get("retry-after")
      const detail = redactScenarioError(value, [this.apiKey, this.apiSecret, auth])
      throw new Error(
        `Scenario request failed (${response.status}): ${detail}` +
          (retry ? `; retry after ${retry}s` : ""),
      )
    }
    return value
  }
}

/** Experimental Scenario still-image adapter with mandatory CU preflight. */
export class ScenarioProvider implements Provider {
  readonly id = "scenario"

  constructor(private readonly client: ScenarioClient) {}

  static fromEnv(): ScenarioProvider {
    return new ScenarioProvider(new ScenarioClient(
      process.env.SCENARIO_SDK_API_KEY,
      process.env.SCENARIO_SDK_API_SECRET,
      scenarioBaseUrl(process.env.SCENARIO_API_BASE_URL ?? DEFAULT_BASE_URL),
    ))
  }

  static forOffline(): ScenarioProvider {
    return new ScenarioProvider(new ScenarioClient(undefined, undefined))
  }

  static forDownloads(): ScenarioProvider {
    return ScenarioProvider.fromEnv()
  }

  supports(generator: Generator): boolean {
    return generator === "map"
  }

  estimate(spec: ResolvedSpec): CostEstimate {
    const options = scenarioOptions(spec)
    return {
      unit: "compute-units",
      amount: options.maxComputeUnits,
      candidates: options.numOutputs ?? 1,
    }
  }

  validate(spec: ResolvedSpec, styleImages: ResolvedStyleImage[]): void {
    const options = scenarioOptions(spec)
    if (typeof options.modelId !== "string" || !options.modelId.trim()) {
      throw new Error("Scenario modelId is required")
    }
    if (!Number.isFinite(options.maxComputeUnits) || options.maxComputeUnits <= 0) {
      throw new Error("Scenario maxComputeUnits must be a positive number")
    }
    const count = options.numOutputs ?? 1
    if (!Number.isInteger(count) || count < 1 || count > 4) {
      throw new Error("Scenario numOutputs must be a whole number from 1 to 4")
    }
    if (
      spec.width < 128 || spec.width > 2048 || spec.width % 16 !== 0 ||
      spec.height < 128 || spec.height > 2048 || spec.height % 16 !== 0
    ) {
      throw new Error("Scenario width and height must be multiples of 16 from 128 to 2048")
    }
    if (styleImages.length) {
      throw new Error("Scenario styleImages are not supported yet; use a reusable Scenario model")
    }
    if (options.projectId != null && (typeof options.projectId !== "string" || !options.projectId.trim())) {
      throw new Error("Scenario projectId must be a non-empty string")
    }
    validateParameters(options.parameters ?? {})
  }

  rateLimit(): RateLimit {
    return { spacingMs: 1000, maxInFlight: 4 }
  }

  async submit(spec: ResolvedSpec, styleImages: ResolvedStyleImage[]): Promise<ProviderSubmission> {
    this.validate(spec, styleImages)
    const options = scenarioOptions(spec)
    const body = requestBody(spec, options)
    const quote = await this.client.quote(options.modelId, body, options.projectId)
    if (quote.total > options.maxComputeUnits + Number.EPSILON) {
      throw new Error(
        `Scenario quoted ${quote.total} compute-units, above maxComputeUnits ` +
          `${options.maxComputeUnits}; no paid request was sent`,
      )
    }
    const apiJobId = await this.client.submit(options.modelId, body, options.projectId)
    return {
      jobId: jobRef(apiJobId, options.projectId),
      metadata: {
        modelId: options.modelId,
        projectId: options.projectId ?? null,
        maxComputeUnits: options.maxComputeUnits,
        quotedComputeUnits: quote.total,
        creativeUnitsCost: quote.creativeUnitsCost,
        costDetails: quote.costDetails,
        ipDetectionCost: quote.ipDetectionCost,
      },
    }
  }

  async poll(jobReference: string, _generator: Generator, context?: PollContext): Promise<JobState> {
    const reference = parseJobRef(jobReference)
    const job = await this.client.job(reference.jobId, reference.projectId)
    const metadata = jobMetadata(job, context?.spec ? scenarioOptions(context.spec) : undefined)
    if (["pending", "queued", "warming-up", "in-progress", "finalizing", "processing"].includes(job.status)) {
      return {
        status: "processing",
        progressPercent: validProgress(job.progress),
      }
    }
    if (["failure", "failed", "canceled"].includes(job.status)) {
      return { status: "failed", error: scenarioJobError(job) }
    }
    if (job.status !== "success") {
      return { status: "failed", error: `Scenario returned unknown job status "${job.status}"` }
    }
    const assetIds = scenarioAssetIds(job)
    if (!assetIds.length) return { status: "failed", error: "Scenario job returned no asset IDs" }
    const assets = await this.assets(assetIds, reference.projectId)
    if (assets.length > 1) {
      return {
        status: "review",
        candidateUrls: assets.map(assetDownloadUrl),
        metadata: { ...metadata, assetIds: assets.map((asset) => asset.id) },
      }
    }
    const asset = assets[0]!
    return {
      status: "ready",
      objectId: asset.id,
      sourceUrl: assetRef(asset.id, reference.projectId),
      sources: [{ url: assetRef(asset.id, reference.projectId), mediaType: MediaType.PNG }],
      metadata: {
        ...metadata,
        assetId: asset.id,
        outputIndex: asset.outputIndex === Number.MAX_SAFE_INTEGER ? null : asset.outputIndex,
      },
    }
  }

  async selectCandidate(jobReference: string, index: number): Promise<CandidateSelection> {
    const reference = parseJobRef(jobReference)
    const job = await this.client.job(reference.jobId, reference.projectId)
    if (job.status !== "success") throw new Error(`Scenario job ${reference.jobId} is not ready`)
    const assets = await this.assets(scenarioAssetIds(job), reference.projectId)
    const asset = assets[index]
    if (!asset) throw new Error(`Scenario job ${reference.jobId} has no candidate at index ${index}`)
    return {
      objectId: asset.id,
      sourceUrl: assetRef(asset.id, reference.projectId),
      metadata: {
        ...jobMetadata(job),
        assetId: asset.id,
        outputIndex: asset.outputIndex === Number.MAX_SAFE_INTEGER ? null : asset.outputIndex,
      },
    }
  }

  async download(source: string): Promise<Buffer> {
    if (!source.startsWith(`${SOURCE_PROTOCOL}//`)) return this.client.download(source)
    const reference = parseAssetRef(source)
    const asset = await this.client.asset(reference.assetId, reference.projectId)
    assertPngAsset(asset)
    return this.client.download(assetDownloadUrl(asset))
  }

  async checkConnection(): Promise<void> {
    await this.client.checkConnection()
  }

  private async assets(ids: string[], projectId?: string): Promise<ScenarioAsset[]> {
    const assets = await Promise.all(ids.map((id) => this.client.asset(id, projectId)))
    for (const asset of assets) assertPngAsset(asset)
    return assets.sort((left, right) =>
      left.outputIndex - right.outputIndex || left.id.localeCompare(right.id))
  }
}

function scenarioOptions(spec: ResolvedSpec): ScenarioOptions {
  return spec.providerOptions as unknown as ScenarioOptions
}

function scenarioBaseUrl(value: string): string {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new Error("SCENARIO_API_BASE_URL must be an absolute HTTP(S) URL")
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("SCENARIO_API_BASE_URL must use HTTP or HTTPS")
  }
  return url.href.replace(/\/$/, "")
}

function requestBody(spec: ResolvedSpec, options: ScenarioOptions): Record<string, unknown> {
  return {
    ...(options.parameters ?? {}),
    prompt: spec.prompt,
    width: spec.width,
    height: spec.height,
    numOutputs: options.numOutputs ?? 1,
    ...(spec.seed != null ? { seed: spec.seed } : {}),
  }
}

function validateParameters(parameters: Record<string, unknown>): void {
  if (!parameters || typeof parameters !== "object" || Array.isArray(parameters)) {
    throw new Error("Scenario parameters must be a JSON object")
  }
  for (const key of Object.keys(parameters)) {
    if (PROTECTED_PARAMETERS.has(key)) {
      throw new Error(`Scenario parameters.${key} is managed by PixelKiln and cannot be overridden`)
    }
  }
  assertJsonValue(parameters, "Scenario parameters")
}

function assertJsonValue(value: unknown, label: string, seen = new Set<object>()): void {
  if (value == null || typeof value === "string" || typeof value === "boolean") return
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error(`${label} contains a non-finite number`)
    return
  }
  if (typeof value !== "object") throw new Error(`${label} must contain only JSON values`)
  if (!Array.isArray(value)) {
    const prototype = Object.getPrototypeOf(value)
    if (prototype !== Object.prototype && prototype !== null) {
      throw new Error(`${label} must contain only plain JSON objects`)
    }
  }
  if (seen.has(value)) throw new Error(`${label} contains a circular value`)
  seen.add(value)
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertJsonValue(item, `${label}[${index}]`, seen))
  } else {
    for (const [key, item] of Object.entries(value)) {
      assertJsonValue(item, `${label}.${key}`, seen)
    }
  }
  seen.delete(value)
}

function jobRef(jobId: string, projectId?: string): string {
  const url = new URL("scenario://job")
  url.searchParams.set("id", jobId)
  if (projectId) url.searchParams.set("projectId", projectId)
  return url.href
}

function parseJobRef(value: string): { jobId: string; projectId?: string } {
  if (!value.startsWith(`${SOURCE_PROTOCOL}//`)) return { jobId: value }
  const url = new URL(value)
  const jobId = url.searchParams.get("id")
  if (url.protocol !== SOURCE_PROTOCOL || url.hostname !== "job" || !jobId) {
    throw new Error("Invalid durable Scenario job reference")
  }
  const projectId = url.searchParams.get("projectId") || undefined
  return { jobId, ...(projectId ? { projectId } : {}) }
}

function assetRef(assetId: string, projectId?: string): string {
  const url = new URL("scenario://asset")
  url.searchParams.set("id", assetId)
  if (projectId) url.searchParams.set("projectId", projectId)
  return url.href
}

function parseAssetRef(value: string): { assetId: string; projectId?: string } {
  const url = new URL(value)
  const assetId = url.searchParams.get("id")
  if (url.protocol !== SOURCE_PROTOCOL || url.hostname !== "asset" || !assetId) {
    throw new Error("Invalid durable Scenario asset reference")
  }
  const projectId = url.searchParams.get("projectId") || undefined
  return { assetId, ...(projectId ? { projectId } : {}) }
}

function readJobId(value: unknown): string | null {
  if (!value || typeof value !== "object") return null
  const job = value as Record<string, unknown>
  const id = job.jobId ?? job.id
  return typeof id === "string" && id ? id : null
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value)
}

function scenarioAssetIds(job: ScenarioJob): string[] {
  const ids = job.metadata?.assetIds
  return Array.isArray(ids)
    ? [...new Set(ids.filter((id): id is string => typeof id === "string" && id.length > 0))]
    : []
}

function assetDownloadUrl(asset: ScenarioAsset): string {
  return asset.originalFileUrl || asset.url
}

function assertPngAsset(asset: ScenarioAsset): void {
  if (asset.originalMimeType && asset.originalMimeType !== MediaType.PNG) {
    throw new Error(
      `Scenario asset ${asset.id} is ${asset.originalMimeType}; PixelKiln's Scenario MVP requires PNG output`,
    )
  }
}

function jobMetadata(job: ScenarioJob, options?: ScenarioOptions): ProviderMetadata {
  const billing = job.billing
  const billedMain = optionalFiniteNonnegative(billing?.cuCost, "Scenario job returned invalid CU billing")
  const billedAddons = Object.values(numericRecord(billing?.cuCostDetails))
    .reduce((sum, amount) => sum + amount, 0)
  return {
    ...(options
      ? {
          modelId: options.modelId,
          projectId: options.projectId ?? null,
          maxComputeUnits: options.maxComputeUnits,
        }
      : {}),
    apiJobId: job.jobId,
    billedComputeUnits: billedMain + billedAddons,
    billing: billing ?? null,
  }
}

function scenarioJobError(job: ScenarioJob): string {
  const raw = job.metadata?.error
  const detail = typeof raw === "string"
    ? raw
    : raw && typeof raw === "object" && typeof (raw as { message?: unknown }).message === "string"
      ? String((raw as { message: string }).message)
      : "job did not complete"
  return `Scenario job ${job.status}: ${detail.slice(0, 500)}`
}

function validProgress(progress: number | undefined): number | null {
  if (typeof progress !== "number" || !Number.isFinite(progress) || progress < 0 || progress > 1) {
    return null
  }
  return Math.round(progress * 100)
}

function finiteNonnegative(value: unknown, message: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) throw new Error(message)
  return value
}

function optionalFiniteNonnegative(value: unknown, message: string): number {
  if (value == null) return 0
  return finiteNonnegative(value, message)
}

function numericRecord(value: unknown): Record<string, number> {
  if (value == null) return {}
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Scenario returned invalid cost details")
  }
  const out: Record<string, number> = {}
  for (const [key, amount] of Object.entries(value)) {
    out[key] = finiteNonnegative(amount, `Scenario returned invalid cost detail "${key}"`)
  }
  return out
}

function redactScenarioError(value: unknown, secrets: string[]): string {
  let detail: string
  if (typeof value === "string") detail = value
  else if (value && typeof value === "object") {
    const record = value as Record<string, unknown>
    const nested = record.error && typeof record.error === "object"
      ? (record.error as Record<string, unknown>).message
      : null
    detail = typeof record.message === "string"
      ? record.message
      : typeof nested === "string"
        ? nested
        : typeof record.detail === "string"
          ? record.detail
          : "request failed"
  } else detail = "request failed"
  for (const secret of secrets) {
    if (secret) detail = detail.split(secret).join("[redacted]")
  }
  return detail.slice(0, 500)
}
