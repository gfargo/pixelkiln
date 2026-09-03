import { randomUUID } from "node:crypto"
import { readFile } from "node:fs/promises"
import path from "node:path"
import { sha256 } from "../hash.ts"
import { MediaType } from "../media.ts"
import type {
  CostEstimate,
  JobState,
  PollContext,
  Provider,
  ProviderOptionContext,
  RateLimit,
  ResolvedProviderOptions,
} from "../provider.ts"
import type { Generator, ResolvedSpec, ResolvedStyleImage } from "../types.ts"

const DEFAULT_BASE_URL = "http://127.0.0.1:8188"

type JsonObject = Record<string, unknown>
type ComfyWorkflow = Record<string, { class_type: string; inputs: JsonObject; [key: string]: unknown }>

export interface ComfyUIBinding {
  nodeId: string
  input: string
}

export interface ComfyUIBindings {
  prompt: ComfyUIBinding
  width: ComfyUIBinding
  height: ComfyUIBinding
  batchSize: ComfyUIBinding
  seed?: ComfyUIBinding
}

/** Options stored under `providerOptions.comfyui` in a manifest style. */
export interface ComfyUIOptions {
  /** ComfyUI API-format workflow JSON, relative to the manifest. */
  workflowFile: string
  /** Node whose history output contains the final `images` array. */
  outputNodeId: string
  /** Expected final images from the output node. */
  numImages?: number
  /** Exact workflow inputs PixelKiln is allowed to replace. */
  bindings: ComfyUIBindings
}

interface ResolvedComfyUIOptions extends ComfyUIOptions {
  numImages: number
  workflow: ComfyWorkflow
  workflowSha256: string
}

interface ComfyImage {
  filename: string
  subfolder: string
  type: "output"
}

class ComfyUIClient {
  readonly baseUrl: string

  constructor(
    baseUrl = process.env.COMFYUI_BASE_URL ?? DEFAULT_BASE_URL,
    private readonly request: typeof fetch = fetch,
  ) {
    this.baseUrl = normalizeBaseUrl(baseUrl)
  }

  async checkConnection(): Promise<void> {
    const value = await this.json("system_stats")
    if (!isObject(value)) throw new Error("ComfyUI returned invalid system stats")
  }

  async submit(workflow: ComfyWorkflow): Promise<string> {
    const value = await this.json("prompt", {
      method: "POST",
      body: JSON.stringify({ prompt: workflow, client_id: randomUUID() }),
    })
    if (!isObject(value)) throw new Error("ComfyUI returned an invalid queue response")
    const promptId = value.prompt_id
    if (typeof promptId !== "string" || !promptId) {
      const nodes = isObject(value.node_errors) ? Object.keys(value.node_errors) : []
      throw new Error(
        "ComfyUI did not return a prompt id" +
          (nodes.length ? `; invalid workflow node(s): ${nodes.slice(0, 8).join(", ")}` : ""),
      )
    }
    return promptId
  }

  async history(promptId: string): Promise<unknown> {
    return this.json(`history/${encodeURIComponent(promptId)}`)
  }

  viewUrl(image: ComfyImage): string {
    const url = this.endpoint("view")
    url.searchParams.set("filename", image.filename)
    url.searchParams.set("subfolder", image.subfolder)
    url.searchParams.set("type", image.type)
    return url.toString()
  }

  async download(source: string): Promise<Buffer> {
    let target = source
    if (source.startsWith("comfyui://")) target = this.viewUrl(parseSource(source))
    const response = await this.request(target)
    if (!response.ok) throw new Error(`ComfyUI download failed (${response.status})`)
    return Buffer.from(await response.arrayBuffer())
  }

  private endpoint(route: string): URL {
    return new URL(route.replace(/^\/+/, ""), `${this.baseUrl}/`)
  }

  private async json(route: string, init: RequestInit = {}): Promise<unknown> {
    const url = this.endpoint(route)
    const response = await this.request(url, {
      ...init,
      headers: {
        ...(init.body ? { "Content-Type": "application/json" } : {}),
        ...init.headers,
      },
    })
    const text = await response.text()
    let value: unknown = null
    try {
      value = text ? JSON.parse(text) : null
    } catch {
      if (response.ok) throw new Error(`ComfyUI returned invalid JSON from ${url.pathname}`)
      value = null
    }
    if (!response.ok) {
      const detail = apiError(value)
      throw new Error(
        `ComfyUI request failed (${response.status}) at ${url.pathname}` +
          (detail ? `: ${detail}` : ""),
      )
    }
    return value
  }
}

/** Self-hosted ComfyUI workflow adapter. */
export class ComfyUIProvider implements Provider {
  readonly id = "comfyui"

  constructor(private readonly client: ComfyUIClient = new ComfyUIClient()) {}

  static fromEnv(): ComfyUIProvider {
    return new ComfyUIProvider()
  }

  static forOffline(): ComfyUIProvider {
    return new ComfyUIProvider(new ComfyUIClient(DEFAULT_BASE_URL))
  }

  static forDownloads(): ComfyUIProvider {
    return new ComfyUIProvider()
  }

  async resolveOptions(
    value: Record<string, unknown>,
    context: ProviderOptionContext,
  ): Promise<ResolvedProviderOptions> {
    const options = parseOptions(value)
    const workflowPath = path.resolve(context.root, options.workflowFile)
    let raw: string
    try {
      raw = await readFile(workflowPath, "utf8")
    } catch (err) {
      throw new Error(
        `ComfyUI workflow for style "${context.styleId}" could not be read at ${workflowPath}: ` +
          `${err instanceof Error ? err.message : String(err)}`,
      )
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch {
      throw new Error(`ComfyUI workflow for style "${context.styleId}" is not valid JSON: ${workflowPath}`)
    }
    const workflow = parseWorkflow(parsed, workflowPath)
    validateWorkflowBindings(workflow, options)
    const workflowSha256 = sha256(JSON.stringify(canonical(workflow)))
    const resolved: ResolvedComfyUIOptions = { ...options, workflow, workflowSha256 }
    return {
      options: resolved as unknown as Record<string, unknown>,
      identity: {
        outputNodeId: options.outputNodeId,
        numImages: options.numImages,
        bindings: options.bindings,
        workflowSha256,
      },
    }
  }

  supports(generator: Generator): boolean {
    return generator === "map"
  }

  estimate(spec: ResolvedSpec): CostEstimate {
    return { unit: "free", amount: 0, candidates: resolvedOptions(spec).numImages }
  }

  validate(spec: ResolvedSpec, styleImages: ResolvedStyleImage[]): void {
    const options = resolvedOptions(spec)
    if (spec.width < 16 || spec.height < 16 || spec.width > 4096 || spec.height > 4096) {
      throw new Error("ComfyUI output dimensions must be between 16 and 4096 pixels")
    }
    if (styleImages.length) {
      throw new Error("ComfyUI styleImages are not supported yet; keep references inside the workflow")
    }
    if (spec.palette.length) {
      throw new Error("ComfyUI does not map PixelKiln palette values yet; encode palette control in the workflow")
    }
    if (spec.seed != null && !options.bindings.seed) {
      throw new Error("ComfyUI requires bindings.seed when the style declares a seed")
    }
    validateWorkflowBindings(options.workflow, options)
  }

  rateLimit(): RateLimit {
    return { spacingMs: 0, maxInFlight: 1 }
  }

  async submit(spec: ResolvedSpec, styleImages: ResolvedStyleImage[]): Promise<{ jobId: string }> {
    this.validate(spec, styleImages)
    const options = resolvedOptions(spec)
    const workflow = structuredClone(options.workflow)
    setBinding(workflow, options.bindings.prompt, spec.prompt)
    setBinding(workflow, options.bindings.width, spec.width)
    setBinding(workflow, options.bindings.height, spec.height)
    setBinding(workflow, options.bindings.batchSize, options.numImages)
    if (spec.seed != null && options.bindings.seed) {
      setBinding(workflow, options.bindings.seed, spec.seed)
    }
    const promptId = await this.client.submit(workflow)
    return { jobId: encodeJob(promptId, options.outputNodeId) }
  }

  async poll(jobId: string, _generator: Generator, context?: PollContext): Promise<JobState> {
    const { promptId, outputNodeId } = decodeJob(jobId)
    const history = await this.client.history(promptId)
    const entry = historyEntry(history, promptId)
    if (!entry) return { status: "processing" }

    const status = isObject(entry.status) ? entry.status : {}
    const statusText = typeof status.status_str === "string" ? status.status_str : ""
    if (statusText === "error") {
      return { status: "failed", error: historyError(status) }
    }
    if (status.completed === false) return { status: "processing" }

    const images = outputImages(entry, outputNodeId)
    if (images instanceof Error) return { status: "failed", error: images.message }
    const expected = context?.spec ? resolvedOptions(context.spec).numImages : null
    if (expected != null && images.length !== expected) {
      return {
        status: "failed",
        error: `ComfyUI output node "${outputNodeId}" returned ${images.length} image(s), expected ${expected}`,
      }
    }
    const metadata = context?.spec ? comfyMetadata(context.spec, promptId, outputNodeId, images) : {
      promptId,
      outputNodeId,
      outputCount: images.length,
    }
    if (images.length > 1) {
      return {
        status: "review",
        candidateUrls: images.map((image) => this.client.viewUrl(image)),
        metadata,
      }
    }
    const sourceUrl = sourceRef(images[0]!)
    return {
      status: "ready",
      objectId: `${promptId}#${outputNodeId}#0`,
      sourceUrl,
      sources: [{ url: sourceUrl, mediaType: MediaType.PNG }],
      metadata,
    }
  }

  async selectCandidate(
    jobId: string,
    index: number,
  ): Promise<{ objectId: string; sourceUrl: string | null }> {
    const { promptId, outputNodeId } = decodeJob(jobId)
    const history = await this.client.history(promptId)
    const entry = historyEntry(history, promptId)
    if (!entry) throw new Error(`ComfyUI prompt ${promptId} is not complete`)
    const images = outputImages(entry, outputNodeId)
    if (images instanceof Error) throw images
    const image = images[index]
    if (!image) throw new Error(`ComfyUI prompt ${promptId} has no candidate at index ${index}`)
    return {
      objectId: `${promptId}#${outputNodeId}#${index}`,
      sourceUrl: sourceRef(image),
    }
  }

  async download(url: string): Promise<Buffer> {
    return this.client.download(url)
  }

  async checkConnection(): Promise<void> {
    await this.client.checkConnection()
  }
}

function parseOptions(value: Record<string, unknown>): ResolvedComfyUIOptions {
  const allowed = new Set(["workflowFile", "outputNodeId", "numImages", "bindings", "workflow", "workflowSha256"])
  const extra = Object.keys(value).filter((key) => !allowed.has(key))
  if (extra.length) throw new Error(`Unknown ComfyUI option(s): ${extra.join(", ")}`)
  const workflowFile = requiredString(value.workflowFile, "workflowFile")
  const outputNodeId = requiredString(value.outputNodeId, "outputNodeId")
  const numImages = value.numImages ?? 1
  if (!Number.isInteger(numImages) || Number(numImages) < 1 || Number(numImages) > 16) {
    throw new Error("ComfyUI numImages must be a whole number from 1 to 16")
  }
  if (!isObject(value.bindings)) throw new Error("ComfyUI bindings must be an object")
  const bindingKeys = new Set(["prompt", "width", "height", "batchSize", "seed"])
  const extraBindings = Object.keys(value.bindings).filter((key) => !bindingKeys.has(key))
  if (extraBindings.length) throw new Error(`Unknown ComfyUI binding(s): ${extraBindings.join(", ")}`)
  const bindings: ComfyUIBindings = {
    prompt: parseBinding(value.bindings.prompt, "prompt"),
    width: parseBinding(value.bindings.width, "width"),
    height: parseBinding(value.bindings.height, "height"),
    batchSize: parseBinding(value.bindings.batchSize, "batchSize"),
    ...(value.bindings.seed == null ? {} : { seed: parseBinding(value.bindings.seed, "seed") }),
  }
  const workflow = value.workflow == null ? undefined : parseWorkflow(value.workflow, workflowFile)
  const workflowSha256 = value.workflowSha256 == null
    ? undefined
    : requiredString(value.workflowSha256, "workflowSha256")
  return {
    workflowFile,
    outputNodeId,
    numImages: Number(numImages),
    bindings,
    ...(workflow ? { workflow } : {}),
    ...(workflowSha256 ? { workflowSha256 } : {}),
  } as ResolvedComfyUIOptions
}

function resolvedOptions(spec: ResolvedSpec): ResolvedComfyUIOptions {
  const options = parseOptions(spec.providerOptions)
  if (!options.workflow || !options.workflowSha256) {
    throw new Error("ComfyUI workflow options were not resolved from workflowFile")
  }
  return options
}

function parseBinding(value: unknown, name: string): ComfyUIBinding {
  if (!isObject(value)) throw new Error(`ComfyUI bindings.${name} must be an object`)
  const extra = Object.keys(value).filter((key) => key !== "nodeId" && key !== "input")
  if (extra.length) throw new Error(`Unknown ComfyUI bindings.${name} field(s): ${extra.join(", ")}`)
  return {
    nodeId: requiredString(value.nodeId, `bindings.${name}.nodeId`),
    input: requiredString(value.input, `bindings.${name}.input`),
  }
}

function parseWorkflow(value: unknown, label: string): ComfyWorkflow {
  if (!isObject(value) || !Object.keys(value).length) {
    throw new Error(`ComfyUI workflow is not a non-empty API-format object: ${label}`)
  }
  for (const [nodeId, node] of Object.entries(value)) {
    if (!isObject(node) || typeof node.class_type !== "string" || !isObject(node.inputs)) {
      throw new Error(`ComfyUI workflow node "${nodeId}" must contain class_type and inputs`)
    }
  }
  return value as ComfyWorkflow
}

function validateWorkflowBindings(workflow: ComfyWorkflow, options: ComfyUIOptions): void {
  for (const [name, binding] of Object.entries(options.bindings)) {
    if (!binding) continue
    const node = workflow[binding.nodeId]
    if (!node) throw new Error(`ComfyUI ${name} binding refers to missing node "${binding.nodeId}"`)
    if (!Object.hasOwn(node.inputs, binding.input)) {
      throw new Error(
        `ComfyUI ${name} binding refers to missing input "${binding.input}" on node "${binding.nodeId}"`,
      )
    }
  }
  if (!workflow[options.outputNodeId]) {
    throw new Error(`ComfyUI outputNodeId refers to missing node "${options.outputNodeId}"`)
  }
}

function setBinding(workflow: ComfyWorkflow, binding: ComfyUIBinding, value: unknown): void {
  const node = workflow[binding.nodeId]
  if (!node || !Object.hasOwn(node.inputs, binding.input)) {
    throw new Error(`ComfyUI binding ${binding.nodeId}.${binding.input} is unavailable`)
  }
  node.inputs[binding.input] = value
}

function historyEntry(history: unknown, promptId: string): JsonObject | null {
  if (!isObject(history)) throw new Error("ComfyUI returned invalid history JSON")
  const entry = history[promptId]
  if (entry == null) return null
  if (!isObject(entry)) throw new Error(`ComfyUI returned invalid history for prompt ${promptId}`)
  return entry
}

function outputImages(entry: JsonObject, outputNodeId: string): ComfyImage[] | Error {
  if (!isObject(entry.outputs)) return new Error("ComfyUI completed without workflow outputs")
  const output = entry.outputs[outputNodeId]
  if (!isObject(output) || !Array.isArray(output.images)) {
    return new Error(`ComfyUI output node "${outputNodeId}" returned no images`)
  }
  const images: ComfyImage[] = []
  for (const value of output.images) {
    if (
      !isObject(value) ||
      typeof value.filename !== "string" ||
      typeof value.subfolder !== "string" ||
      value.type !== "output"
    ) {
      return new Error(`ComfyUI output node "${outputNodeId}" returned an invalid image record`)
    }
    images.push({ filename: value.filename, subfolder: value.subfolder, type: "output" })
  }
  if (!images.length) return new Error(`ComfyUI output node "${outputNodeId}" returned no images`)
  return images
}

function comfyMetadata(
  spec: ResolvedSpec,
  promptId: string,
  outputNodeId: string,
  images: ComfyImage[],
): JsonObject {
  const options = resolvedOptions(spec)
  return {
    promptId,
    outputNodeId,
    outputCount: images.length,
    workflowFile: options.workflowFile,
    workflowSha256: options.workflowSha256,
    files: images.map((image) => ({ ...image })),
  }
}

function encodeJob(promptId: string, outputNodeId: string): string {
  return `${promptId}#${encodeURIComponent(outputNodeId)}`
}

function decodeJob(jobId: string): { promptId: string; outputNodeId: string } {
  const split = jobId.lastIndexOf("#")
  if (split < 1 || split === jobId.length - 1) throw new Error(`Invalid ComfyUI job id "${jobId}"`)
  return {
    promptId: jobId.slice(0, split),
    outputNodeId: decodeURIComponent(jobId.slice(split + 1)),
  }
}

function sourceRef(image: ComfyImage): string {
  const url = new URL("comfyui://output")
  url.searchParams.set("filename", image.filename)
  url.searchParams.set("subfolder", image.subfolder)
  url.searchParams.set("type", image.type)
  return url.toString()
}

function parseSource(source: string): ComfyImage {
  let url: URL
  try {
    url = new URL(source)
  } catch {
    throw new Error("Invalid ComfyUI output reference")
  }
  const filename = url.searchParams.get("filename")
  const subfolder = url.searchParams.get("subfolder")
  const type = url.searchParams.get("type")
  if (url.protocol !== "comfyui:" || url.hostname !== "output" || !filename || subfolder == null || type !== "output") {
    throw new Error("Invalid ComfyUI output reference")
  }
  return { filename, subfolder, type }
}

function normalizeBaseUrl(value: string): string {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new Error("COMFYUI_BASE_URL must be an absolute HTTP(S) URL")
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("COMFYUI_BASE_URL must use HTTP or HTTPS")
  }
  url.hash = ""
  url.search = ""
  return url.toString().replace(/\/$/, "")
}

function historyError(status: JsonObject): string {
  const messages = Array.isArray(status.messages) ? status.messages : []
  for (const message of messages) {
    if (!Array.isArray(message) || message[0] !== "execution_error" || !isObject(message[1])) continue
    const detail = message[1].exception_message
    if (typeof detail === "string" && detail.trim()) {
      return `ComfyUI execution failed: ${detail.trim().slice(0, 300)}`
    }
  }
  return "ComfyUI execution failed"
}

function apiError(value: unknown): string | null {
  if (!isObject(value)) return null
  const raw = typeof value.error === "string"
    ? value.error
    : isObject(value.error) && typeof value.error.message === "string"
      ? value.error.message
      : typeof value.message === "string"
        ? value.message
        : null
  const nodes = isObject(value.node_errors) ? Object.keys(value.node_errors) : []
  if (nodes.length) {
    return `${raw ? `${raw}; ` : ""}invalid workflow node(s): ${nodes.slice(0, 8).join(", ")}`
  }
  return raw?.trim().slice(0, 300) || null
}

function requiredString(value: unknown, name: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`ComfyUI ${name} must be a non-empty string`)
  return value.trim()
}

function isObject(value: unknown): value is JsonObject {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value)
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical)
  if (!isObject(value)) return value
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, canonical(value[key])]),
  )
}
