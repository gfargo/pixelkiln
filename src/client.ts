import type { ResolvedStyleImage } from "./types.ts"
import { z } from "zod"

/**
 * PixelLab REST client.
 *
 * Verified against https://api.pixellab.ai/v2/openapi.json. Every endpoint used
 * here was exercised against a live account before being written, so the shapes
 * are observed rather than assumed.
 *
 * Notably this needs no LLM and no MCP client — it is ordinary HTTP.
 */

const BASE = process.env.PIXELLAB_API_BASE ?? "https://api.pixellab.ai/v2"

export const MAX_RETRIES = 4
export const MAX_DOWNLOAD_BYTES = 64 * 1024 * 1024
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

export function shouldRetry(status: number): boolean {
  return status === 429 || status === 408 || status >= 500
}

/** Exponential backoff with jitter, so parallel workers don't retry in lockstep. */
export function backoffMs(attempt: number): number {
  const base = Math.min(1000 * 2 ** attempt, 16_000)
  return base + Math.floor(Math.random() * 400)
}

/** Supports both Retry-After forms: seconds and an HTTP date. */
export function retryAfterMs(value: string | null, now = Date.now()): number | null {
  if (!value) return null
  const seconds = Number(value)
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000
  const date = Date.parse(value)
  if (!Number.isFinite(date)) return null
  return Math.max(0, date - now)
}

export interface Balance {
  usd: number
  generations: number
  total: number
  plan: string
}

export interface PixelLabObject {
  id: string
  name: string | null
  prompt: string
  size: { width: number; height: number }
  directions: number
  created_at: string
  view: string | null
  preview_url?: string | null
  rotation_urls?: Record<string, string | null> | null
  /** Populated only while status === "review". Index order is what select-frames expects. */
  frame_urls?: string[] | null
  tags: string[]
  status: string | null
  progress_percent?: number | null
  eta_seconds?: number | null
}

/**
 * A tiles-pro job. Unlike an object or a map object there is no `status`
 * field: GET /tiles-pro/{id} answers 423 while the set is still drawing and
 * 200 with `storage_urls` once it is done, so the HTTP code IS the status.
 */
export interface TilesPro {
  /** Keyed `tile_0`, `tile_1`, ... Index order is load-bearing for a
   *  connectable set (`tile_feature`), where a consumer slices by index. */
  storage_urls: Record<string, string>
  kind: string | null
  tile_rules?: Record<string, unknown> | null
}

export interface MapObject {
  object_id: string
  status: string
  description: string | null
  width: number | null
  height: number | null
  download_url: string | null
}

const BalanceResponseSchema = z
  .object({
    credits: z.object({ usd: z.number() }).passthrough(),
    subscription: z
      .object({
        generations: z.number(),
        total: z.number(),
        plan: z.string().nullable().optional(),
      })
      .passthrough(),
  })
  .passthrough()

const ObjectSubmitSchema = z
  .object({
    background_job_id: z.string().min(1),
    object_id: z.string().min(1),
    status: z.string().default("queued"),
    n_frames: z.number().int().min(0),
  })
  .passthrough()
const MapSubmitSchema = z
  .object({
    background_job_id: z.string().min(1),
    object_id: z.string().min(1),
    status: z.string().default("processing"),
  })
  .passthrough()
const TilesSubmitSchema = z
  .object({
    tile_id: z.string().min(1),
    background_job_id: z.string().min(1),
    status: z.literal("processing").default("processing"),
  })
  .passthrough()
const TilesProSchema = z
  .object({
    storage_urls: z.record(z.string()),
    kind: z.string().nullable().default(null),
    tile_rules: z.record(z.unknown()).nullable().optional(),
  })
  .passthrough()
const PixelLabObjectSchema = z
  .object({
    id: z.string().min(1),
    name: z.string().nullable().default(null),
    prompt: z.string().default(""),
    size: z.object({ width: z.number().int().positive(), height: z.number().int().positive() }),
    directions: z.number().default(0),
    created_at: z.string(),
    view: z.string().nullable().default(null),
    preview_url: z.string().nullable().optional(),
    rotation_urls: z.record(z.string().nullable()).nullable().optional(),
    frame_urls: z.array(z.string()).nullable().optional(),
    tags: z.array(z.string()).default([]),
    status: z.string().nullable().default(null),
    progress_percent: z.number().nullable().optional(),
    eta_seconds: z.number().nullable().optional(),
  })
  .passthrough()
const MapObjectSchema = z
  .object({
    object_id: z.string().min(1),
    status: z.string(),
    description: z.string().nullable().default(null),
    width: z.number().nullable().default(null),
    height: z.number().nullable().default(null),
    download_url: z.string().nullable().default(null),
  })
  .passthrough()
const ObjectListSchema = z
  .object({ objects: z.array(PixelLabObjectSchema), total: z.number().int().min(0) })
  .passthrough()
const PixfluxResponseSchema = z
  .object({ image: z.object({ base64: z.string().min(1) }).passthrough(), usage: z.unknown().optional() })
  .passthrough()
const SelectFramesSchema = z.object({ created_object_ids: z.array(z.string()) }).passthrough()

function validateResponse<S extends z.ZodTypeAny>(
  schema: S,
  raw: unknown,
  operation: string,
): z.output<S> {
  const parsed = schema.safeParse(raw)
  if (parsed.success) return parsed.data
  const issues = parsed.error.issues
    .slice(0, 4)
    .map((i) => `${i.path.join(".") || "response"}: ${i.message}`)
    .join("; ")
  throw new Error(`Invalid PixelLab response for ${operation}: ${issues}`)
}

export class PixelLabError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body: string,
  ) {
    super(message)
    this.name = "PixelLabError"
  }
}

export class PixelLabClient {
  constructor(
    private readonly apiKey: string,
    private readonly timeoutMs = 120_000,
  ) {
    if (!apiKey) throw new Error("PIXELLAB_API_KEY is required")
  }

  /**
   * Retries only what is safe to retry: transport failures, 429, and 5xx.
   * A 4xx other than 429 is a bad request and retrying it just wastes time.
   *
   * POSTs that create objects are included, which is a deliberate trade: the
   * failure mode of not retrying (a dropped asset in a 65-item run) is more
   * common than the failure mode of retrying (a duplicate object), and a
   * duplicate is visible and free to delete whereas a silent gap is neither.
   */
  private async request<T>(path: string, init?: RequestInit, attempt = 0): Promise<T> {
    const auth = this.apiKey.startsWith("Bearer ") ? this.apiKey : `Bearer ${this.apiKey}`
    let res: Response
    try {
      res = await fetch(`${BASE}${path}`, {
        ...init,
        signal: init?.signal ?? AbortSignal.timeout(this.timeoutMs),
        headers: {
          Authorization: auth,
          "Content-Type": "application/json",
          ...(init?.headers ?? {}),
        },
      })
    } catch (err) {
      if (attempt < MAX_RETRIES) {
        await sleep(backoffMs(attempt))
        return this.request<T>(path, init, attempt + 1)
      }
      throw err
    }

    if (!res.ok && shouldRetry(res.status) && attempt < MAX_RETRIES) {
      // Honour Retry-After when the server sends one; it knows better than we do.
      const waitMs = retryAfterMs(res.headers.get("retry-after")) ?? backoffMs(attempt)
      await sleep(waitMs)
      return this.request<T>(path, init, attempt + 1)
    }

    const text = await res.text()
    if (!res.ok) {
      throw new PixelLabError(`${init?.method ?? "GET"} ${path} → ${res.status}`, res.status, text)
    }
    if (!text) return {} as T
    try {
      return JSON.parse(text) as T
    } catch {
      throw new Error(`${init?.method ?? "GET"} ${path} returned invalid JSON`)
    }
  }

  async balance(): Promise<Balance> {
    const raw = validateResponse(BalanceResponseSchema, await this.request<unknown>("/balance"), "balance")
    return {
      usd: raw.credits?.usd ?? 0,
      generations: raw.subscription?.generations ?? 0,
      total: raw.subscription?.total ?? 0,
      plan: raw.subscription?.plan ?? "unknown",
    }
  }

  /**
   * Square objects that persist indefinitely.
   *
   * `size` and `styleImages` are mutually exclusive at the API level: when style
   * images are supplied the largest one dictates the output size. So style
   * references must already be at the target resolution — a 128px reference
   * silently produces 128px output and a different candidate count.
   */
  async create1Direction(args: {
    description: string
    size?: number
    view?: string
    styleImages?: ResolvedStyleImage[]
    itemDescriptions?: string[]
  }): Promise<{ object_id: string; status: string; n_frames: number }> {
    const body: Record<string, unknown> = { description: args.description }
    if (args.styleImages?.length) {
      body.style_images = args.styleImages.map(({ base64, format }) => ({
        type: "base64",
        base64,
        format,
      }))
    } else if (args.size != null) {
      body.size = args.size
    }
    if (args.view) body.view = args.view
    if (args.itemDescriptions?.length) body.item_descriptions = args.itemDescriptions
    const raw = await this.request<unknown>("/create-1-direction-object", {
      method: "POST",
      body: JSON.stringify(body),
    })
    const parsed = validateResponse(ObjectSubmitSchema, raw, "create-1-direction-object")
    return parsed
  }

  /**
   * Arbitrary width x height. Returns a single result — no selection step.
   *
   * These AUTO-DELETE AFTER 8 HOURS, so `fetch` must run in the same session as
   * `submit`. The pipeline warns when a map-object entry is older than that.
   */
  async createMapObject(args: {
    description: string
    width: number
    height: number
    view?: string
    outline?: string
    shading?: string
    detail?: string
    seed?: number
  }): Promise<{ object_id: string; status: string }> {
    const body: Record<string, unknown> = {
      description: args.description,
      image_size: { width: args.width, height: args.height },
    }
    if (args.view) body.view = args.view
    if (args.outline) body.outline = args.outline
    if (args.shading) body.shading = args.shading
    if (args.detail) body.detail = args.detail
    if (args.seed != null) body.seed = args.seed
    return validateResponse(
      MapSubmitSchema,
      await this.request<unknown>("/map-objects", { method: "POST", body: JSON.stringify(body) }),
      "create map object",
    )
  }

  /**
   * Draws a whole tile set in one call — many variations, or a connectable
   * set when `tileFeature` is given.
   *
   * `styleImages` here is NOT the shape `create-1-direction-object` uses.
   * TilesProStyleImage is flat — `{base64, width, height}`, all three
   * required — where 1dir wants `{type, base64, format}`. Confirmed against
   * the OpenAPI schema; sending 1dir's shape is rejected as an extra field.
   *
   * Passing style images also makes the API ignore `tileType` and `tileView`
   * and copy the reference's tile geometry instead.
   */
  async createTilesPro(args: {
    description: string
    tileSize?: number
    tileType?: string
    tileView?: string
    tileFeature?: string
    outlineMode?: string
    seed?: number
    styleImages?: { base64: string; width: number; height: number }[]
  }): Promise<{ tile_id: string; background_job_id: string; status: string }> {
    const body: Record<string, unknown> = { description: args.description }
    if (args.tileSize != null) body.tile_size = args.tileSize
    if (args.tileType) body.tile_type = args.tileType
    if (args.tileView) body.tile_view = args.tileView
    if (args.tileFeature) body.tile_feature = args.tileFeature
    if (args.outlineMode) body.outline_mode = args.outlineMode
    if (args.seed != null) body.seed = args.seed
    if (args.styleImages?.length) body.style_images = args.styleImages
    return validateResponse(
      TilesSubmitSchema,
      await this.request<unknown>("/create-tiles-pro", { method: "POST", body: JSON.stringify(body) }),
      "create tiles",
    )
  }

  /** Throws PixelLabError(423) while the set is still drawing — see TilesPro. */
  async getTilesPro(tileId: string): Promise<TilesPro> {
    return validateResponse(
      TilesProSchema,
      await this.request<unknown>(`/tiles-pro/${tileId}`),
      "get tiles",
    )
  }

  /**
   * Synchronous single-image generation. Returns the PNG inline rather than a
   * job id, and is the only endpoint that honours a forced palette —
   * `color_image` on /map-objects returns a 500 whatever the payload shape.
   */
  async createImagePixflux(args: {
    description: string
    width: number
    height: number
    noBackground?: boolean
    paletteSwatchBase64?: string
    seed?: number
  }): Promise<{ png: Buffer; usage: unknown }> {
    const body: Record<string, unknown> = {
      description: args.description,
      image_size: { width: args.width, height: args.height },
      no_background: args.noBackground ?? true,
    }
    if (args.paletteSwatchBase64) {
      body.color_image = { type: "base64", base64: args.paletteSwatchBase64, format: "png" }
    }
    if (args.seed != null) body.seed = args.seed

    const res = validateResponse(
      PixfluxResponseSchema,
      await this.request<unknown>("/create-image-pixflux", {
        method: "POST",
        body: JSON.stringify(body),
      }),
      "create pixflux image",
    )
    const b64 = res.image.base64
    return { png: Buffer.from(b64, "base64"), usage: res.usage }
  }

  async getObject(objectId: string): Promise<PixelLabObject> {
    return validateResponse(
      PixelLabObjectSchema,
      await this.request<unknown>(`/objects/${objectId}`),
      "get object",
    )
  }

  async getMapObject(objectId: string): Promise<MapObject> {
    return validateResponse(
      MapObjectSchema,
      await this.request<unknown>(`/map-objects/${objectId}`),
      "get map object",
    )
  }

  async listObjects(limit = 50, offset = 0): Promise<{ objects: PixelLabObject[]; total: number }> {
    return validateResponse(
      ObjectListSchema,
      await this.request<unknown>(`/objects?limit=${limit}&offset=${offset}`),
      "list objects",
    )
  }

  /** Walks the whole account. Used by `adopt` to reconcile orphaned objects. */
  async *iterateObjects(pageSize = 100): AsyncGenerator<PixelLabObject> {
    let offset = 0
    for (;;) {
      const page = await this.listObjects(pageSize, offset)
      for (const obj of page.objects) yield obj
      offset += page.objects.length
      if (page.objects.length === 0 || offset >= page.total) return
    }
  }

  /**
   * Promotes chosen candidates to standalone objects, each with its own id.
   * The review parent survives until nothing is left in it, so the returned
   * `created_object_ids` — not the parent id — is what should be recorded.
   */
  async selectFrames(
    objectId: string,
    indices: number[],
    commonTag?: string,
  ): Promise<{ created_object_ids?: string[] }> {
    const raw = await this.request<unknown>(`/objects/${objectId}/select-frames`, {
      method: "POST",
      body: JSON.stringify(commonTag ? { indices, common_tag: commonTag } : { indices }),
    })
    return validateResponse(SelectFramesSchema, raw, "select frames")
  }

  /** Irreversible. Only reached via `purge`, behind an explicit confirmation. */
  deleteObject(objectId: string): Promise<unknown> {
    return this.request(`/objects/${objectId}`, { method: "DELETE" })
  }

  dismissReview(objectId: string): Promise<unknown> {
    return this.request(`/objects/${objectId}/dismiss-review`, { method: "POST" })
  }

  /** Free and synchronous. Replaces the full tag set — include tags you want to keep. */
  setTags(objectId: string, tags: string[]): Promise<unknown> {
    return this.request(`/objects/${objectId}/tags`, { method: "PATCH", body: JSON.stringify({ tags }) })
  }

  /** Storage URLs are public; no auth header, and sending one can break the CDN request. */
  async download(url: string): Promise<Buffer> {
    const res = await fetch(url, { signal: AbortSignal.timeout(this.timeoutMs) })
    if (!res.ok) throw new PixelLabError(`download ${url} → ${res.status}`, res.status, "")
    const declared = Number(res.headers.get("content-length"))
    if (Number.isFinite(declared) && declared > MAX_DOWNLOAD_BYTES) {
      throw new Error(`download ${url} exceeds the ${MAX_DOWNLOAD_BYTES}-byte safety limit`)
    }
    const buf = Buffer.from(await res.arrayBuffer())
    if (buf.length > MAX_DOWNLOAD_BYTES) {
      throw new Error(`download ${url} exceeds the ${MAX_DOWNLOAD_BYTES}-byte safety limit`)
    }
    return buf
  }
}

export function clientFromEnv(): PixelLabClient {
  const key = process.env.PIXELLAB_API_KEY
  if (!key) {
    throw new Error(
      "PIXELLAB_API_KEY is not set.\n" +
        "Looked in the environment, and in .env.local / .env beside the manifest and in the current directory.",
    )
  }
  return new PixelLabClient(key)
}
