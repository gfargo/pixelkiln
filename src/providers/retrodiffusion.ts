import { paletteSwatch } from "../png.ts"
import type {
  BalanceInfo,
  CostEstimate,
  JobState,
  PollContext,
  Provider,
} from "../provider.ts"
import type { Generator, ResolvedSpec, ResolvedStyleImage } from "../types.ts"
import { MediaType, type MediaType as MediaKind } from "../media.ts"

const DEFAULT_BASE_URL = "https://api.retrodiffusion.ai/v1"

export interface RetroDiffusionOptions {
  /** Live style id returned by GET /styles/selector. */
  promptStyle?: string
  /** Candidate images produced by one request. */
  numImages?: number
  /** Override the style's shared noBackground setting. */
  removeBg?: boolean
  /** Animation frame duration accepted by Retro Diffusion. */
  framesDuration?: 4 | 6 | 8 | 10 | 12 | 16
  /** Return a PNG spritesheet instead of the default animated GIF. */
  returnSpritesheet?: boolean
  /** Outside texture description for rd_tile__tileset_advanced. */
  extraPrompt?: string
  /** Ask a still image to tile seamlessly on each axis. */
  tileX?: boolean
  tileY?: boolean
}

interface InferenceResult {
  balance_cost?: number
  remaining_balance?: number
  base64_images?: string[]
  output_urls?: string[]
}

interface TaskResponse {
  status: "pending" | "running" | "succeeded" | "failed"
  result?: InferenceResult | null
  error?: string | { message?: string } | null
}

class RetroDiffusionClient {
  constructor(
    private readonly token: string | undefined,
    private readonly baseUrl = DEFAULT_BASE_URL,
    private readonly request: typeof fetch = fetch,
  ) {}

  async submit(body: Record<string, unknown>): Promise<string> {
    const response = await this.call("/inferences", { method: "POST", body: JSON.stringify(body) })
    const taskId = (response as { task_id?: unknown }).task_id
    if (typeof taskId !== "string" || !taskId) {
      throw new Error("Retro Diffusion did not return an async task id")
    }
    return taskId
  }

  async quote(body: Record<string, unknown>): Promise<number> {
    const response = await this.call("/inferences", {
      method: "POST",
      body: JSON.stringify({ ...body, check_cost: true }),
    })
    const amount = (response as { balance_cost?: unknown }).balance_cost
    if (typeof amount !== "number" || !Number.isFinite(amount) || amount < 0) {
      throw new Error("Retro Diffusion returned an invalid cost quote")
    }
    return amount
  }

  async task(id: string): Promise<TaskResponse> {
    return (await this.call(`/inferences/tasks/${encodeURIComponent(id)}`)) as TaskResponse
  }

  async balance(): Promise<number> {
    const response = await this.call("/inferences/credits")
    const balance = (response as { balance?: unknown }).balance
    if (typeof balance !== "number" || !Number.isFinite(balance)) {
      throw new Error("Retro Diffusion returned an invalid balance")
    }
    return balance
  }

  private async call(path: string, init: RequestInit = {}): Promise<unknown> {
    if (!this.token) throw new Error("RD_API_KEY is not set")
    const response = await this.request(`${this.baseUrl}${path}`, {
      ...init,
      headers: {
        "Content-Type": "application/json",
        "X-RD-Token": this.token,
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
      const detail = retroError(value)
      throw new Error(
        `Retro Diffusion request failed (${response.status}): ${detail}` +
          (retry ? `; retry after ${retry}s` : ""),
      )
    }
    return value
  }
}

/** Experimental native pixel-art still, tileset, and animation adapter. */
export class RetroDiffusionProvider implements Provider {
  readonly id = "retrodiffusion"

  constructor(private readonly client: RetroDiffusionClient) {}

  static fromEnv(): RetroDiffusionProvider {
    return new RetroDiffusionProvider(new RetroDiffusionClient(process.env.RD_API_KEY))
  }

  static forOffline(): RetroDiffusionProvider {
    return new RetroDiffusionProvider(new RetroDiffusionClient(undefined))
  }

  static forDownloads(): RetroDiffusionProvider {
    return RetroDiffusionProvider.forOffline()
  }

  supports(generator: Generator): boolean {
    return generator === "map" || generator === "pixflux" ||
      generator === "tiles" || generator === "animation"
  }

  estimate(spec: ResolvedSpec): CostEstimate {
    const options = retroOptions(spec)
    const style = resolvedPromptStyle(spec, options)
    const count = options.numImages ?? 1
    const pixels = spec.width * spec.height
    let each: number
    if (style.startsWith("rd_advanced_animation__")) {
      each = /__(?:custom_action|subtle_motion)$/.test(style) ? 0.25 : 0.14
    } else if (style.startsWith("rd_animation__")) {
      each = /__(?:any_animation|8_dir_rotation)$/.test(style) ? 0.25 : 0.07
    } else if (/^rd_tile__tileset(?:_advanced)?$/.test(style)) {
      each = 0.1
    } else if (style.startsWith("rd_pro__")) {
      each = 0.18
    } else if (style.startsWith("rd_fast__")) {
      each = Math.max(0.015, (pixels + 100_000) / 6_000_000)
    } else if (isLowResolutionStyle(style)) {
      each = Math.max(0.02, (pixels + 13_700) / 600_000)
    } else {
      each = Math.max(0.025, (pixels + 50_000) / 2_000_000)
    }
    return { unit: "usd", amount: roundUsdEstimate(each * count), candidates: count }
  }

  validate(spec: ResolvedSpec, styleImages: ResolvedStyleImage[]): void {
    const options = retroOptions(spec)
    const promptStyle = resolvedPromptStyle(spec, options)
    const count = options.numImages ?? 1
    const isAnimation = /^(?:rd_animation__|rd_advanced_animation__)/.test(promptStyle)
    const isTile = promptStyle.startsWith("rd_tile__")
    if (
      !promptStyle ||
      (spec.generator === "animation" && !isAnimation) ||
      (spec.generator === "tiles" && !isTile) ||
      (spec.generator !== "animation" && spec.generator !== "tiles" && (isAnimation || isTile))
    ) {
      throw new Error(
        `Retro Diffusion style "${promptStyle}" does not match generator "${spec.generator}"`,
      )
    }
    if (!Number.isInteger(count) || count < 1 || count > 16) {
      throw new Error("Retro Diffusion numImages must be a whole number from 1 to 16")
    }
    if (spec.width < 12 || spec.height < 12 || spec.width > 512 || spec.height > 512) {
      throw new Error("Retro Diffusion output dimensions must be between 12 and 512 pixels")
    }
    if (styleImages.length > 9) {
      throw new Error("Retro Diffusion accepts at most 9 reference images")
    }
    if (spec.generator === "animation") {
      if (count !== 1) throw new Error("Retro Diffusion animations currently require numImages: 1")
      validateAnimation(promptStyle, spec, styleImages, options)
    } else if (spec.generator === "tiles") {
      validateTile(promptStyle, spec, styleImages, count, options)
    } else if (styleImages.length && !/^(?:rd_pro__|user__)/.test(promptStyle)) {
      throw new Error(
        `Retro Diffusion style "${promptStyle}" does not accept reference_images; ` +
          "use an RD Pro or user style",
      )
    }
  }

  async submit(spec: ResolvedSpec, styleImages: ResolvedStyleImage[]): Promise<{ jobId: string }> {
    this.validate(spec, styleImages)
    const options = retroOptions(spec)
    const promptStyle = resolvedPromptStyle(spec, options)
    const animation = spec.generator === "animation"
    const tiles = spec.generator === "tiles"
    const body: Record<string, unknown> = {
      prompt: spec.prompt,
      prompt_style: promptStyle,
      width: spec.width,
      height: spec.height,
      num_images: options.numImages ?? 1,
      ...(!animation && !tiles ? { remove_bg: options.removeBg ?? spec.noBackground } : {}),
      ...(spec.seed != null ? { seed: spec.seed } : {}),
      ...(animation || tiles
        ? styleImages[0]
          ? { input_image: styleImages[0].base64 }
          : {}
        : styleImages.length
          ? { reference_images: styleImages.map((image) => image.base64) }
          : {}),
      ...(tiles && styleImages[1] ? { extra_input_image: styleImages[1].base64 } : {}),
      ...(tiles && options.extraPrompt ? { extra_prompt: options.extraPrompt } : {}),
      ...(animation && options.framesDuration ? { frames_duration: options.framesDuration } : {}),
      ...(animation && options.returnSpritesheet ? { return_spritesheet: true } : {}),
      ...(!animation && options.tileX != null ? { tile_x: options.tileX } : {}),
      ...(!animation && options.tileY != null ? { tile_y: options.tileY } : {}),
      ...(spec.palette.length
        ? { input_palette: paletteSwatch(spec.palette).toString("base64") }
        : {}),
    }
    const quoted = await this.client.quote(body)
    const estimated = this.estimate(spec).amount
    if (quoted > estimated + 0.000001) {
      throw new Error(
        `Retro Diffusion quoted $${quoted.toFixed(6)}, above the offline estimate ` +
          `$${estimated.toFixed(6)}; no paid request was sent`,
      )
    }
    return {
      jobId: await this.client.submit({ ...body, async: true, upload_outputs: true }),
    }
  }

  async poll(jobId: string, generator: Generator, context?: PollContext): Promise<JobState> {
    const task = await this.client.task(jobId)
    if (task.status === "pending" || task.status === "running") return { status: "processing" }
    if (task.status === "failed") return { status: "failed", error: retroError(task.error) }
    if (task.status !== "succeeded") {
      return { status: "failed", error: `Retro Diffusion returned unknown task status "${String(task.status)}"` }
    }

    const options = context?.spec ? retroOptions(context.spec) : {}
    const mediaType = generator === "animation" && !options.returnSpritesheet
      ? MediaType.GIF
      : MediaType.PNG
    const sources = resultSources(task.result, mediaType)
    const urls = sources.map((source) => source.url)
    if (!urls.length) return { status: "failed", error: "Retro Diffusion task returned no images" }
    if (urls.length > 1) return { status: "review", candidateUrls: urls }
    return {
      status: "ready",
      objectId: `${jobId}#0`,
      sourceUrl: urls[0]!,
      sources,
      metadata: {
        balanceCost: task.result?.balance_cost ?? null,
        remainingBalance: task.result?.remaining_balance ?? null,
        mediaType,
        kind: generator === "animation" ? "animation" : generator === "tiles" ? "tileset" : "image",
        ...(context?.spec
          ? {
              promptStyle: resolvedPromptStyle(context.spec, options),
              width: context.spec.width,
              height: context.spec.height,
            }
          : {}),
      },
    }
  }

  async selectCandidate(
    jobId: string,
    index: number,
  ): Promise<{ objectId: string; sourceUrl: string | null }> {
    const task = await this.client.task(jobId)
    if (task.status !== "succeeded") throw new Error(`Retro Diffusion task ${jobId} is not ready`)
    const url = resultSources(task.result, MediaType.PNG)[index]?.url
    if (!url) throw new Error(`Retro Diffusion task ${jobId} has no candidate at index ${index}`)
    return { objectId: `${jobId}#${index}`, sourceUrl: url }
  }

  async download(url: string): Promise<Buffer> {
    const data = /^data:[^;]+;base64,(.+)$/.exec(url)?.[1]
    if (data) return Buffer.from(data, "base64")
    const response = await fetch(url)
    if (!response.ok) throw new Error(`Retro Diffusion download failed (${response.status})`)
    return Buffer.from(await response.arrayBuffer())
  }

  async balance(): Promise<BalanceInfo> {
    return { unit: "usd", remaining: await this.client.balance() }
  }
}

function retroOptions(spec: ResolvedSpec): RetroDiffusionOptions {
  return spec.providerOptions as RetroDiffusionOptions
}

function resultSources(
  result: InferenceResult | null | undefined,
  mediaType: MediaKind,
): Array<{ url: string; mediaType: MediaKind }> {
  if (result?.output_urls?.length) {
    return result.output_urls
      .filter((url): url is string => typeof url === "string" && url.length > 0)
      .map((url) => ({ url, mediaType }))
  }
  return (result?.base64_images ?? [])
    .filter((data): data is string => typeof data === "string" && data.length > 0)
    .map((data) => ({
      url: `data:${mediaType};base64,${data}`,
      mediaType,
    }))
}

function resolvedPromptStyle(spec: ResolvedSpec, options: RetroDiffusionOptions): string {
  return options.promptStyle ??
    (spec.generator === "animation"
      ? "rd_animation__any_animation"
      : spec.generator === "tiles"
        ? "rd_tile__tileset"
        : "rd_plus__default")
}

function validateAnimation(
  style: string,
  spec: ResolvedSpec,
  styleImages: ResolvedStyleImage[],
  options: RetroDiffusionOptions,
): void {
  if (spec.width !== spec.height) throw new Error("Retro Diffusion animations must be square")
  if (style.startsWith("rd_advanced_animation__")) {
    if (styleImages.length !== 1) {
      throw new Error(`Retro Diffusion advanced animation style "${style}" requires one input image`)
    }
    if (spec.width < 32 || spec.width > 256) {
      throw new Error("Retro Diffusion advanced animations require dimensions from 32 to 256 pixels")
    }
  } else if (styleImages.length > 1) {
    throw new Error("Retro Diffusion prompt animations accept at most one input image")
  }
  const exact = style.includes("four_angle_walking") ? 48
    : style.endsWith("__small_sprites") ? 32
      : style.endsWith("__any_animation") ? 64
        : style.endsWith("__big_animation") ? 128
          : style.endsWith("__8_dir_rotation") ? 80
            : null
  if (exact && spec.width !== exact) {
    throw new Error(`Retro Diffusion style "${style}" requires ${exact}x${exact} dimensions`)
  }
  if (style.endsWith("__vfx") && (spec.width < 24 || spec.width > 96)) {
    throw new Error("Retro Diffusion VFX animations require dimensions from 24 to 96 pixels")
  }
  if (options.framesDuration != null && ![4, 6, 8, 10, 12, 16].includes(options.framesDuration)) {
    throw new Error("Retro Diffusion framesDuration must be 4, 6, 8, 10, 12, or 16")
  }
}

function validateTile(
  style: string,
  spec: ResolvedSpec,
  styleImages: ResolvedStyleImage[],
  count: number,
  options: RetroDiffusionOptions,
): void {
  if (spec.width !== spec.height) throw new Error("Retro Diffusion tiles must be square")
  const size = spec.width
  if (/^rd_tile__tileset(?:_advanced)?$/.test(style)) {
    if (size < 16 || size > 32) throw new Error("Retro Diffusion tilesets require 16–32px tiles")
    if (count !== 1) throw new Error("Retro Diffusion tilesets require numImages: 1")
  } else if (style === "rd_tile__single_tile" && (size < 16 || size > 64)) {
    throw new Error("Retro Diffusion single tiles require dimensions from 16 to 64 pixels")
  } else if (style === "rd_tile__tile_variation") {
    if (size < 16 || size > 128) throw new Error("Retro Diffusion tile variations require 16–128px tiles")
    if (styleImages.length !== 1) throw new Error("Retro Diffusion tile variations require one input image")
  } else if (style === "rd_tile__tile_object" && (size < 16 || size > 96)) {
    throw new Error("Retro Diffusion tile objects require dimensions from 16 to 96 pixels")
  } else if (style === "rd_tile__scene_object" && (size < 64 || size > 384)) {
    throw new Error("Retro Diffusion tile scene objects require dimensions from 64 to 384 pixels")
  }
  if (style === "rd_tile__tileset" && styleImages.length > 1) {
    throw new Error("Retro Diffusion basic tilesets accept at most one input image")
  }
  if (style === "rd_tile__tileset_advanced") {
    if (styleImages.length > 2) throw new Error("Retro Diffusion advanced tilesets accept at most two input images")
    if (!options.extraPrompt && styleImages.length < 2) {
      throw new Error("Retro Diffusion advanced tilesets require extraPrompt or a second input image")
    }
  }
}

function isLowResolutionStyle(style: string): boolean {
  return /(?:^|__)(?:mc_|low_res|classic|skill_icon|topdown_item)/.test(style)
}

function roundUsdEstimate(value: number): number {
  // Live quotes may round a formula result up to the nearest $0.001. Planning
  // must be conservative or submit() will correctly reject that rounded quote
  // as higher than the offline estimate.
  return Math.ceil((value - 1e-9) * 1_000) / 1_000
}

function retroError(value: unknown): string {
  if (typeof value === "string") return value || "unknown error"
  if (!value || typeof value !== "object") return "unknown error"
  const record = value as Record<string, unknown>
  if (typeof record.message === "string") return record.message
  if (typeof record.detail === "string") return record.detail
  if (Array.isArray(record.detail)) {
    const details = record.detail
      .map((item) => {
        if (!item || typeof item !== "object") return String(item)
        const detail = item as Record<string, unknown>
        return typeof detail.msg === "string" ? detail.msg : JSON.stringify(item)
      })
      .filter(Boolean)
    if (details.length) return details.join("; ")
  }
  if (record.detail && typeof record.detail === "object") {
    const message = (record.detail as Record<string, unknown>).message
    if (typeof message === "string") return message
  }
  return JSON.stringify(value)
}
