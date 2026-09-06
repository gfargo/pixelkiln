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
  ProviderInputContext,
  ProviderOptionContext,
  ProviderSubmission,
  RateLimit,
  ResolvedProviderInputs,
  ResolvedProviderOptions,
} from "../provider.ts"
import type { Generator, ResolvedSpec, ResolvedStyleImage, RevisionMode } from "../types.ts"

const DEFAULT_BASE_URL = "http://127.0.0.1:8188"

type JsonObject = Record<string, unknown>
type ComfyWorkflow = Record<string, { class_type: string; inputs: JsonObject; [key: string]: unknown }>

export interface ComfyUIBinding {
  nodeId: string
  input: string
}

export interface ComfyUIBindings {
  [name: string]: ComfyUIBinding | undefined
  prompt: ComfyUIBinding
  width?: ComfyUIBinding
  height?: ComfyUIBinding
  batchSize?: ComfyUIBinding
  seed?: ComfyUIBinding
  /** LoadImage-compatible input populated from a hashed revision parent. */
  sourceImage?: ComfyUIBinding
  /** LoadImage-compatible input populated from an inpaint mask. */
  maskImage?: ComfyUIBinding
  /** Sampler denoise/edit-strength input. */
  strength?: ComfyUIBinding
}

export interface ComfyUIImageInput {
  kind: "image"
  /** Absolute local path used only at submission time. */
  path: string
  sha256: string
  format: "png" | "jpeg"
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

const BUILTIN_BINDINGS = new Set([
  "prompt", "width", "height", "batchSize", "seed", "sourceImage", "maskImage", "strength",
])

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

  async uploadImage(
    bytes: Buffer,
    sha256: string,
    format: "png" | "jpeg",
  ): Promise<string> {
    const extension = format === "jpeg" ? "jpg" : "png"
    const form = new FormData()
    form.append(
      "image",
      new Blob([new Uint8Array(bytes)], { type: format === "jpeg" ? "image/jpeg" : "image/png" }),
      `${sha256}.${extension}`,
    )
    form.append("type", "input")
    form.append("subfolder", "pixelkiln")
    form.append("overwrite", "true")
    const url = this.endpoint("upload/image")
    const response = await this.request(url, { method: "POST", body: form })
    const text = await response.text()
    let value: unknown = null
    try {
      value = text ? JSON.parse(text) : null
    } catch {
      value = null
    }
    if (!response.ok) {
      throw new Error(
        `ComfyUI image upload failed (${response.status})` +
          (apiError(value) ? `: ${apiError(value)}` : ""),
      )
    }
    if (!isObject(value) || typeof value.name !== "string" || !value.name) {
      throw new Error("ComfyUI image upload returned an invalid response")
    }
    const subfolder = typeof value.subfolder === "string" ? value.subfolder : ""
    return subfolder ? `${subfolder.replace(/\/+$/, "")}/${value.name}` : value.name
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

  async resolveInputs(
    value: Record<string, string | number | boolean>,
    context: ProviderInputContext,
  ): Promise<ResolvedProviderInputs> {
    const options = parseOptions(context.providerOptions)
    if (!options.workflow || !options.workflowSha256) {
      throw new Error("ComfyUI provider inputs require resolved workflow options")
    }
    const inputs: Record<string, unknown> = {}
    const identity: Record<string, unknown> = {}
    for (const [name, input] of Object.entries(value)) {
      if (BUILTIN_BINDINGS.has(name)) {
        throw new Error(
          `ComfyUI providerInputs.${name} is reserved; use PixelKiln's built-in ${name} field`,
        )
      }
      const binding = Object.hasOwn(options.bindings, name) ? options.bindings[name] : undefined
      if (!binding) {
        throw new Error(
          `ComfyUI providerInputs.${name} has no matching bindings.${name} target`,
        )
      }
      if (isImageBinding(options.workflow, binding)) {
        if (typeof input !== "string") {
          throw new Error(`ComfyUI providerInputs.${name} must be a manifest-relative PNG or JPEG path`)
        }
        const file = path.resolve(context.root, input)
        let bytes: Buffer
        try {
          bytes = await readFile(file)
        } catch (error) {
          throw new Error(
            `ComfyUI providerInputs.${name} could not be read at ${file}: ` +
              `${error instanceof Error ? error.message : String(error)}`,
          )
        }
        const format = inputImageFormat(bytes)
        if (!format) {
          throw new Error(`ComfyUI providerInputs.${name} is not a PNG or JPEG: ${file}`)
        }
        const hash = sha256(bytes)
        inputs[name] = { kind: "image", path: file, sha256: hash, format } satisfies ComfyUIImageInput
        identity[name] = { kind: "image", sha256: hash, format }
      } else {
        const current = options.workflow[binding.nodeId]!.inputs[binding.input]
        if (typeof current !== "string" && typeof current !== "number" && typeof current !== "boolean") {
          throw new Error(
            `ComfyUI providerInputs.${name} cannot replace non-scalar ` +
              `${binding.nodeId}.${binding.input}`,
          )
        }
        if (typeof current !== typeof input) {
          throw new Error(
            `ComfyUI providerInputs.${name} must be ${typeof current} to match ` +
              `${binding.nodeId}.${binding.input}`,
          )
        }
        inputs[name] = input
        identity[name] = input
      }
    }
    return { inputs, identity }
  }

  supports(generator: Generator): boolean {
    return generator === "map"
  }

  supportsRevision(_mode: RevisionMode): boolean {
    return true
  }

  estimate(spec: ResolvedSpec): CostEstimate {
    return { unit: "free", amount: 0, candidates: resolvedOptions(spec).numImages }
  }

  validate(spec: ResolvedSpec, styleImages: ResolvedStyleImage[]): void {
    const options = resolvedOptions(spec)
    // A committed source can be a revision parent in the same style, but it is
    // never submitted. Revision-only workflows therefore do not need the
    // text-to-image bindings that this placeholder spec would otherwise imply.
    if (spec.source && !spec.revision) return
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
    if (!options.bindings.width !== !options.bindings.height) {
      throw new Error("ComfyUI width and height bindings must be declared together")
    }
    if (!spec.revision && (!options.bindings.width || !options.bindings.height)) {
      throw new Error("ComfyUI text-to-image generation requires width and height bindings")
    }
    if (options.numImages > 1 && !options.bindings.batchSize) {
      throw new Error("ComfyUI numImages greater than 1 requires bindings.batchSize")
    }
    if (spec.revision) {
      if (!options.bindings.sourceImage) {
        throw new Error("ComfyUI revisions require bindings.sourceImage")
      }
      if (spec.revision.mode === "inpaint" && !options.bindings.maskImage) {
        throw new Error("ComfyUI inpaint revisions require bindings.maskImage")
      }
      if (spec.revision.strength != null && !options.bindings.strength) {
        throw new Error("ComfyUI revision strength requires bindings.strength")
      }
      if (
        (!options.bindings.width || !options.bindings.height) &&
        spec.revision.sourceWidth != null &&
        spec.revision.sourceHeight != null &&
        (spec.width !== spec.revision.sourceWidth || spec.height !== spec.revision.sourceHeight)
      ) {
        throw new Error(
          "ComfyUI revisions without width/height bindings must keep the source dimensions",
        )
      }
    }
    validateWorkflowBindings(options.workflow, options)
  }

  rateLimit(): RateLimit {
    return { spacingMs: 0, maxInFlight: 1 }
  }

  async submit(spec: ResolvedSpec, styleImages: ResolvedStyleImage[]): Promise<ProviderSubmission> {
    this.validate(spec, styleImages)
    const options = resolvedOptions(spec)
    const workflow = structuredClone(options.workflow)
    setBinding(workflow, options.bindings.prompt, spec.prompt)
    if (options.bindings.width) setBinding(workflow, options.bindings.width, spec.width)
    if (options.bindings.height) setBinding(workflow, options.bindings.height, spec.height)
    if (options.bindings.batchSize) {
      setBinding(workflow, options.bindings.batchSize, options.numImages)
    }
    if (spec.seed != null && options.bindings.seed) {
      setBinding(workflow, options.bindings.seed, spec.seed)
    }
    for (const [name, input] of Object.entries(spec.providerInputs ?? {})) {
      const binding = Object.hasOwn(options.bindings, name) ? options.bindings[name] : undefined
      if (!binding) throw new Error(`ComfyUI provider input "${name}" has no binding`)
      if (isComfyImageInput(input)) {
        const bytes = await readFile(input.path)
        if (sha256(bytes) !== input.sha256) {
          throw new Error(`ComfyUI provider input "${name}" changed before upload`)
        }
        const uploaded = await this.client.uploadImage(bytes, input.sha256, input.format)
        setBinding(workflow, binding, uploaded)
      } else {
        setBinding(workflow, binding, input)
      }
    }
    if (spec.revision) {
      if (!spec.revision.sourceSha256 || !spec.revision.sourceFormat) {
        throw new Error("ComfyUI revision source is not ready")
      }
      const sourceBytes = await readFile(spec.revision.sourceFile)
      if (sha256(sourceBytes) !== spec.revision.sourceSha256) {
        throw new Error("ComfyUI revision source changed before upload")
      }
      const uploadedSource = await this.client.uploadImage(
        sourceBytes,
        spec.revision.sourceSha256,
        spec.revision.sourceFormat,
      )
      setBinding(workflow, options.bindings.sourceImage!, uploadedSource)

      if (spec.revision.maskFile) {
        if (!spec.revision.maskSha256 || !spec.revision.maskFormat) {
          throw new Error("ComfyUI revision mask is not ready")
        }
        const maskBytes = await readFile(spec.revision.maskFile)
        if (sha256(maskBytes) !== spec.revision.maskSha256) {
          throw new Error("ComfyUI revision mask changed before upload")
        }
        const uploadedMask = await this.client.uploadImage(
          maskBytes,
          spec.revision.maskSha256,
          spec.revision.maskFormat,
        )
        setBinding(workflow, options.bindings.maskImage!, uploadedMask)
      }
      if (spec.revision.strength != null) {
        setBinding(workflow, options.bindings.strength!, spec.revision.strength)
      }
    }
    const promptId = await this.client.submit(workflow)
    const inputs = providerInputProvenance(spec.providerInputs)
    const metadata = {
      ...(Object.keys(inputs).length ? { inputs } : {}),
      ...(spec.revision
        ? {
            revision: {
              mode: spec.revision.mode,
              sourceAssetId: spec.revision.sourceAssetId,
              sourceSha256: spec.revision.sourceSha256,
              ...(spec.revision.maskSha256 ? { maskSha256: spec.revision.maskSha256 } : {}),
            },
          }
        : {}),
    }
    return {
      jobId: encodeJob(promptId, options.outputNodeId),
      ...(Object.keys(metadata).length ? { metadata } : {}),
    }
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
  const bindings = Object.fromEntries(
    Object.entries(value.bindings).map(([name, binding]) => [name, parseBinding(binding, name)]),
  ) as unknown as ComfyUIBindings
  if (!bindings.prompt) throw new Error("ComfyUI bindings.prompt must be an object")
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
  const targets = new Map<string, string>()
  for (const [name, binding] of Object.entries(options.bindings)) {
    if (!binding) continue
    const node = workflow[binding.nodeId]
    if (!node) throw new Error(`ComfyUI ${name} binding refers to missing node "${binding.nodeId}"`)
    if (!Object.hasOwn(node.inputs, binding.input)) {
      throw new Error(
        `ComfyUI ${name} binding refers to missing input "${binding.input}" on node "${binding.nodeId}"`,
      )
    }
    const target = `${binding.nodeId}.${binding.input}`
    const prior = targets.get(target)
    if (prior) {
      throw new Error(`ComfyUI bindings.${name} and bindings.${prior} target the same input ${target}`)
    }
    targets.set(target, name)
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
  const inputs = providerInputProvenance(spec.providerInputs)
  return {
    promptId,
    outputNodeId,
    outputCount: images.length,
    workflowFile: options.workflowFile,
    workflowSha256: options.workflowSha256,
    files: images.map((image) => ({ ...image })),
    ...(Object.keys(inputs).length ? { inputs } : {}),
    ...(spec.revision
      ? {
          revision: {
            mode: spec.revision.mode,
            sourceAssetId: spec.revision.sourceAssetId,
            sourceSha256: spec.revision.sourceSha256,
            ...(spec.revision.maskSha256
              ? { maskSha256: spec.revision.maskSha256 }
              : {}),
            ...(spec.revision.strength == null ? {} : { strength: spec.revision.strength }),
          },
        }
      : {}),
  }
}

function isImageBinding(workflow: ComfyWorkflow, binding: ComfyUIBinding): boolean {
  const node = workflow[binding.nodeId]
  return binding.input === "image" &&
    (node?.class_type === "LoadImage" || node?.class_type === "LoadImageMask")
}

function isComfyImageInput(value: unknown): value is ComfyUIImageInput {
  return isObject(value) &&
    value.kind === "image" &&
    typeof value.path === "string" &&
    typeof value.sha256 === "string" &&
    (value.format === "png" || value.format === "jpeg")
}

function providerInputProvenance(
  inputs: Record<string, unknown> | undefined,
): Record<string, unknown> {
  return Object.fromEntries(Object.entries(inputs ?? {}).map(([name, input]) => [
    name,
    isComfyImageInput(input)
      ? { kind: "image", sha256: input.sha256, format: input.format }
      : { kind: "value", value: input },
  ]))
}

function inputImageFormat(bytes: Buffer): "png" | "jpeg" | null {
  if (
    bytes.length >= 24 &&
    bytes.readUInt32BE(0) === 0x89504e47 &&
    bytes.readUInt32BE(4) === 0x0d0a1a0a &&
    bytes.toString("ascii", 12, 16) === "IHDR" &&
    bytes.readUInt32BE(16) > 0 &&
    bytes.readUInt32BE(20) > 0
  ) return "png"

  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return null
  let offset = 2
  while (offset + 3 < bytes.length) {
    if (bytes[offset] !== 0xff) return null
    while (bytes[offset] === 0xff) offset++
    const marker = bytes[offset++]
    if (marker == null || marker === 0xd9 || marker === 0xda) break
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue
    if (offset + 2 > bytes.length) return null
    const length = bytes.readUInt16BE(offset)
    if (length < 2 || offset + length > bytes.length) return null
    const isStartOfFrame = marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)
    if (isStartOfFrame) {
      if (length < 7) return null
      return bytes.readUInt16BE(offset + 3) > 0 && bytes.readUInt16BE(offset + 5) > 0
        ? "jpeg"
        : null
    }
    offset += length
  }
  return null
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
