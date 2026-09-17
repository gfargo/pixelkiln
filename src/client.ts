import type { CharacterProportions, ResolvedStyleImage } from "./types.ts"
import { z } from "zod"
import { ProviderError } from "./errors.ts"
import { fetchWithRetry, type RetryingFetch } from "./http.ts"

/**
 * PixelLab REST client.
 *
 * Verified against https://api.pixellab.ai/v2/openapi.json. Every endpoint used
 * here was exercised against a live account before being written, so the shapes
 * are observed rather than assumed.
 *
 * Notably this needs no LLM and no MCP client. It is ordinary HTTP.
 */

const BASE = process.env.PIXELLAB_API_BASE ?? "https://api.pixellab.ai/v2"

export const MAX_DOWNLOAD_BYTES = 64 * 1024 * 1024
/** The retry policy now lives in http.ts and is shared by every provider; these names stay for callers that import them from here. */
export { MAX_RETRIES, backoffMs, retryAfterMs, shouldRetry } from "./http.ts"

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

// Characters. Verified against the v2 OpenAPI document; a character is one
// record with 4 or 8 rotation URLs once its job completes, and its
// animations hang off it grouped by name and direction.
const UsageSchema = z
  .object({
    type: z.string().optional(),
    usd: z.number().nullable().optional(),
    generations: z.number().nullable().optional(),
  })
  .passthrough()
  .nullable()
  .optional()
const CharacterSubmitSchema = z
  .object({
    background_job_id: z.string().min(1),
    character_id: z.string().min(1),
    status: z.string().default("processing"),
    usage: UsageSchema,
  })
  .passthrough()
const AnimateSubmitSchema = z
  .object({
    background_job_ids: z.array(z.string()),
    directions: z.array(z.string()),
    status: z.string().default("processing"),
    usage: UsageSchema,
  })
  .passthrough()
const CharacterAnimationDirectionSchema = z
  .object({
    direction: z.string(),
    frame_count: z.number().int().min(0),
    frames: z.array(z.string()),
  })
  .passthrough()
const CharacterAnimationSchema = z
  .object({
    animation_type: z.string(),
    display_name: z.string().nullable().optional(),
    animation_group_id: z.string().nullable().optional(),
    directions: z.array(CharacterAnimationDirectionSchema),
  })
  .passthrough()
const CharacterSchema = z
  .object({
    id: z.string().min(1),
    name: z.string().default(""),
    state_name: z.string().nullable().optional(),
    prompt: z.string().default(""),
    size: z.object({ width: z.number().int().positive(), height: z.number().int().positive() }),
    directions: z.number().int(),
    created_at: z.string(),
    updated_at: z.string().nullable().optional(),
    animation_count: z.number().int().default(0),
    template_id: z.string().default("mannequin"),
    view: z.string().nullable().optional(),
    status: z.string().default("completed"),
    rotation_urls: z.record(z.string().nullable()).nullable().optional(),
    tags: z.array(z.string()).default([]),
    group_id: z.string().nullable().optional(),
    animations: z.array(CharacterAnimationSchema).default([]),
    preview_url: z.string().nullable().optional(),
  })
  .passthrough()
const CharacterListSchema = z
  .object({ characters: z.array(CharacterSchema), total: z.number().int().min(0) })
  .passthrough()
const BackgroundJobSchema = z
  .object({
    id: z.string(),
    status: z.string(),
    last_response: z.record(z.unknown()).nullable().optional(),
    /**
     * The billed amount, confirmed live for a `map` object and a standard
     * character base (docs/ENDPOINTS.md, "Limits and billing"); duplicated at
     * `last_response.billing_usage` on the jobs observed so far.
     */
    usage: UsageSchema,
  })
  .passthrough()
const DeleteAnimationsSchema = z
  .object({ success: z.boolean(), deleted_count: z.number().int().default(0), error: z.string().nullable().optional() })
  .passthrough()

export type PixelLabCharacter = z.infer<typeof CharacterSchema>
export type PixelLabCharacterAnimation = z.infer<typeof CharacterAnimationSchema>
export interface PixelLabUsage {
  type?: string | null
  generations?: number | null
  usd?: number | null
}

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

export class PixelLabError extends ProviderError {
  constructor(
    message: string,
    status: number,
    readonly body: string,
  ) {
    super("pixellab", message, { status })
    this.name = "PixelLabError"
  }
}

export interface Base64Image {
  base64: string
  format: "png" | "jpeg"
}

/** PixelLab's discriminated proportions object from the manifest's preset name or multipliers. */
export function proportionsPayload(proportions: CharacterProportions): Record<string, unknown> {
  if (typeof proportions === "string") return { type: "preset", name: proportions }
  return {
    type: "custom",
    ...(proportions.headSize !== undefined ? { head_size: proportions.headSize } : {}),
    ...(proportions.armsLength !== undefined ? { arms_length: proportions.armsLength } : {}),
    ...(proportions.legsLength !== undefined ? { legs_length: proportions.legsLength } : {}),
    ...(proportions.shoulderWidth !== undefined ? { shoulder_width: proportions.shoulderWidth } : {}),
    ...(proportions.hipWidth !== undefined ? { hip_width: proportions.hipWidth } : {}),
  }
}

export class PixelLabClient {
  private readonly http: RetryingFetch

  constructor(
    private readonly apiKey: string,
    timeoutMs = 120_000,
  ) {
    if (!apiKey) throw new Error("PIXELLAB_API_KEY is required")
    this.http = fetchWithRetry(undefined, { timeoutMs })
  }

  /** Retries transport failures, 429, and 5xx; see http.ts for the policy. */
  private async request<T>(path: string, init?: RequestInit): Promise<T> {
    const auth = this.apiKey.startsWith("Bearer ") ? this.apiKey : `Bearer ${this.apiKey}`
    const res = await this.http(`${BASE}${path}`, {
      ...init,
      headers: {
        Authorization: auth,
        "Content-Type": "application/json",
        ...(init?.headers ?? {}),
      },
    })

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
   * references must already be at the target resolution; a 128px reference
   * silently produces 128px output and a different candidate count.
   */
  async create1Direction(args: {
    description: string
    size?: number
    view?: string
    styleImages?: ResolvedStyleImage[]
    itemDescriptions?: string[]
  }): Promise<{ object_id: string; status: string; n_frames: number; background_job_id: string }> {
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
   * Arbitrary width x height. Returns a single result, no selection step.
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
  }): Promise<{ object_id: string; status: string; background_job_id: string }> {
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
   * Draws a whole tile set in one call: many variations, or a connectable
   * set when `tileFeature` is given.
   *
   * `styleImages` here is NOT the shape `create-1-direction-object` uses.
   * TilesProStyleImage is flat, `{base64, width, height}` with all three
   * required, where 1dir wants `{type, base64, format}`. Confirmed against
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

  /** Throws PixelLabError(423) while the set is still drawing; see TilesPro. */
  async getTilesPro(tileId: string): Promise<TilesPro> {
    return validateResponse(
      TilesProSchema,
      await this.request<unknown>(`/tiles-pro/${tileId}`),
      "get tiles",
    )
  }

  /**
   * Synchronous single-image generation. Returns the PNG inline rather than a
   * job id, and is the only endpoint that honours a forced palette;
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
   * `created_object_ids`, not the parent id, is what should be recorded.
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

  /** Free and synchronous. Replaces the full tag set, so include tags you want to keep. */
  setTags(objectId: string, tags: string[]): Promise<unknown> {
    return this.request(`/objects/${objectId}/tags`, { method: "PATCH", body: JSON.stringify({ tags }) })
  }

  /**
   * A base character. Standard mode picks the 4- or 8-direction template
   * endpoint; v3 and pro have their own and always draw 8. Every one answers
   * at once with the character id and a background job.
   *
   * A `reference` is the author's own sprite: standard takes one per
   * direction and draws the rest, v3 rotates the south one, and pro
   * switches to its rotate method for it. A `styleReference` is pro's style
   * anchor; the other engines have no such input.
   */
  async createCharacter(args: {
    mode: "standard" | "v3" | "pro" | "pro-flash"
    description: string
    size: number
    directions: 4 | 8
    view?: string
    template: string
    outline?: string
    shading?: string
    detail?: string
    seed?: number
    noBackground?: boolean
    paletteSwatchBase64?: string
    proportions?: CharacterProportions
    textGuidanceScale?: number
    isometric?: boolean
    reference?: Partial<Record<string, Base64Image>>
    styleReference?: Base64Image
    /** v3 only. */
    enhancePrompt?: boolean
    /** pro only: a concept image the design is seeded from. */
    concept?: Base64Image
    /** pro only: one of the account's 8-direction characters as the style anchor. */
    styleCharacterId?: string
    /** pro-flash only: the style image's native size, and which traits it lends. */
    styleReferenceSize?: { width: number; height: number }
    styleTraits?: { palette?: boolean; outline?: boolean; detail?: boolean; shading?: boolean }
  }): Promise<{ character_id: string; background_job_id: string; usage?: PixelLabUsage | null }> {
    const imageSize = { width: args.size, height: args.size }
    const palette = args.paletteSwatchBase64
      ? { color_image: { type: "base64", base64: args.paletteSwatchBase64, format: "png" }, force_colors: true }
      : {}
    const encode = (image: Base64Image) => ({ type: "base64", base64: image.base64, format: image.format })
    const south = args.reference?.south
    let path: string
    let body: Record<string, unknown>
    if (args.mode === "v3") {
      path = "/create-character-v3"
      body = {
        description: args.description,
        image_size: imageSize,
        template_id: args.template,
        no_background: args.noBackground ?? true,
        ...(args.view ? { view: args.view } : {}),
        ...(args.outline ? { outline: args.outline } : {}),
        ...(args.detail ? { detail: args.detail } : {}),
        ...(args.seed != null ? { seed: args.seed } : {}),
        ...(south ? { reference_image: encode(south) } : {}),
        ...(args.enhancePrompt ? { enhance_prompt: true } : {}),
      }
    } else if (args.mode === "pro-flash") {
      // One call draws the south sprite (or takes the author's) and rotates
      // it with v3. Style traits only mean something next to a style image.
      path = "/create-character-pro-flash"
      const traits = args.styleTraits
      body = {
        description: args.description,
        template_id: args.template,
        n_directions: 8,
        // The author's sprite sets the canvas; a size only applies to text creation.
        ...(south ? { first_frame: encode(south) } : { image_size: imageSize }),
        ...(args.view ? { view: args.view } : {}),
        ...(args.seed != null ? { seed: args.seed } : {}),
        ...(args.styleReference && args.styleReferenceSize
          ? {
              style_image: { image: encode(args.styleReference), size: args.styleReferenceSize },
              ...(traits
                ? {
                    style_options: {
                      ...(traits.palette !== undefined ? { color_palette: traits.palette } : {}),
                      ...(traits.outline !== undefined ? { outline: traits.outline } : {}),
                      ...(traits.detail !== undefined ? { detail: traits.detail } : {}),
                      ...(traits.shading !== undefined ? { shading: traits.shading } : {}),
                    },
                  }
                : {}),
            }
          : {}),
      }
    } else if (args.mode === "pro") {
      path = "/create-character-pro"
      // Three ways in: rotate the author's sprite, grow a design from a
      // concept image, or draw from text; the last two may anchor their
      // look on a style image or one of the account's characters.
      body = {
        description: args.description,
        image_size: imageSize,
        template_id: args.template,
        no_background: args.noBackground ?? true,
        method: south ? "rotate_character" : args.concept ? "create_from_concept" : "create_with_style",
        ...(args.view ? { view: args.view } : {}),
        ...(args.seed != null ? { seed: args.seed } : {}),
        ...(south ? { reference_image: encode(south) } : args.styleReference ? { reference_image: encode(args.styleReference) } : {}),
        ...(!south && args.concept ? { concept_image: encode(args.concept) } : {}),
        ...(!south && args.styleCharacterId ? { style_character_id: args.styleCharacterId } : {}),
      }
    } else {
      path = args.directions === 4 ? "/create-character-with-4-directions" : "/create-character-with-8-directions"
      body = {
        description: args.description,
        image_size: imageSize,
        template_id: args.template,
        ...(args.view ? { view: args.view } : {}),
        ...(args.outline ? { outline: args.outline } : {}),
        ...(args.shading ? { shading: args.shading } : {}),
        ...(args.detail ? { detail: args.detail } : {}),
        ...(args.seed != null ? { seed: args.seed } : {}),
        ...(args.proportions !== undefined ? { proportions: proportionsPayload(args.proportions) } : {}),
        ...(args.textGuidanceScale !== undefined ? { text_guidance_scale: args.textGuidanceScale } : {}),
        ...(args.isometric !== undefined ? { isometric: args.isometric } : {}),
        ...(args.reference && Object.keys(args.reference).length
          ? { directions: Object.fromEntries(Object.entries(args.reference).flatMap(([direction, image]) => (image ? [[direction, encode(image)]] : []))) }
          : {}),
        ...palette,
      }
    }
    const raw = await this.request<unknown>(path, { method: "POST", body: JSON.stringify(body) })
    return validateResponse(CharacterSubmitSchema, raw, path.slice(1))
  }

  /** A text edit of an existing character, applied to every direction and stored as a sibling. */
  async createCharacterState(args: {
    characterId: string
    editDescription: string
    stateName?: string
    paletteFromReference?: boolean
    canvas?: { width: number; height: number }
    seed?: number
    noBackground?: boolean
  }): Promise<{ character_id: string; background_job_id: string; usage?: PixelLabUsage | null }> {
    const raw = await this.request<unknown>("/create-character-state", {
      method: "POST",
      body: JSON.stringify({
        character_id: args.characterId,
        edit_description: args.editDescription,
        no_background: args.noBackground ?? true,
        use_color_palette_from_reference: args.paletteFromReference ?? false,
        ...(args.stateName ? { state_name: args.stateName } : {}),
        ...(args.canvas ? { override_frame_size: args.canvas } : {}),
        ...(args.seed != null ? { seed: args.seed } : {}),
      }),
    })
    return validateResponse(CharacterSubmitSchema, raw, "create-character-state")
  }

  /**
   * One animation of one character. Template mode costs a generation per
   * direction and fixes the frame count; v3 draws `frameCount` frames from
   * the action text; pro is the sequential engine. One job per direction.
   */
  async animateCharacter(args: {
    characterId: string
    animationName: string
    actionDescription?: string
    template?: string
    mode: "template" | "v3" | "pro"
    frameCount?: number
    keepFirstFrame?: boolean
    directions: string[]
    seed?: number
    /** Template mode only. */
    textGuidanceScale?: number
    isometric?: boolean
    /** v3 only: a pose to start from and a pose to reach. */
    startFrame?: Base64Image
    endFrame?: Base64Image
    /** What is being animated, over the character's own description. */
    description?: string
    /** Template mode only. */
    outline?: string
    shading?: string
    detail?: string
    /** v3 only. */
    enhancePrompt?: boolean
    paletteSwatchBase64?: string
  }): Promise<{ background_job_ids: string[]; directions: string[]; usage?: PixelLabUsage | null }> {
    const encode = (image: Base64Image) => ({ type: "base64", base64: image.base64, format: image.format })
    const raw = await this.request<unknown>("/animate-character", {
      method: "POST",
      body: JSON.stringify({
        character_id: args.characterId,
        animation_name: args.animationName,
        mode: args.mode,
        directions: args.directions,
        ...(args.template ? { template_animation_id: args.template } : {}),
        ...(args.actionDescription ? { action_description: args.actionDescription } : {}),
        ...(args.description ? { description: args.description } : {}),
        ...(args.mode === "v3" && args.frameCount ? { frame_count: args.frameCount } : {}),
        ...(args.mode === "v3" && args.keepFirstFrame === false ? { keep_first_frame: false } : {}),
        ...(args.mode === "v3" && args.startFrame ? { custom_start_frame: encode(args.startFrame) } : {}),
        ...(args.mode === "v3" && args.endFrame ? { end_frame: encode(args.endFrame) } : {}),
        ...(args.mode === "v3" && args.enhancePrompt ? { enhance_prompt: true } : {}),
        ...(args.mode === "template" && args.textGuidanceScale !== undefined ? { text_guidance_scale: args.textGuidanceScale } : {}),
        ...(args.mode === "template" && args.outline ? { outline: args.outline } : {}),
        ...(args.mode === "template" && args.shading ? { shading: args.shading } : {}),
        ...(args.mode === "template" && args.detail ? { detail: args.detail } : {}),
        ...(args.isometric !== undefined ? { isometric: args.isometric } : {}),
        ...(args.paletteSwatchBase64
          ? { color_image: { type: "base64", base64: args.paletteSwatchBase64, format: "png" }, force_colors: true }
          : {}),
        ...(args.seed != null ? { seed: args.seed } : {}),
      }),
    })
    return validateResponse(AnimateSubmitSchema, raw, "animate-character")
  }

  async getCharacter(characterId: string): Promise<PixelLabCharacter> {
    const raw = await this.request<unknown>(`/characters/${encodeURIComponent(characterId)}`)
    return validateResponse(CharacterSchema, raw, "characters/{id}")
  }

  async listCharacters(limit = 100, offset = 0): Promise<{ characters: PixelLabCharacter[]; total: number }> {
    const raw = await this.request<unknown>(`/characters?limit=${limit}&offset=${offset}`)
    return validateResponse(CharacterListSchema, raw, "characters")
  }

  async *iterateCharacters(pageSize = 100): AsyncGenerator<PixelLabCharacter> {
    let offset = 0
    for (;;) {
      const page = await this.listCharacters(pageSize, offset)
      for (const character of page.characters) yield character
      offset += page.characters.length
      if (page.characters.length === 0 || offset >= page.total) return
    }
  }

  async getBackgroundJob(jobId: string): Promise<{ id: string; status: string; last_response?: Record<string, unknown> | null; usage?: PixelLabUsage | null }> {
    const raw = await this.request<unknown>(`/background-jobs/${encodeURIComponent(jobId)}`)
    return validateResponse(BackgroundJobSchema, raw, "background-jobs/{id}")
  }

  /** Remove one animation group from a character, or one direction of it. */
  async deleteCharacterAnimations(
    characterId: string,
    selector: { animationGroupId: string } | { animationType: string },
    direction?: string,
  ): Promise<{ success: boolean; deleted_count: number }> {
    const query = new URLSearchParams(
      "animationGroupId" in selector
        ? { animation_group_id: selector.animationGroupId }
        : { animation_type: selector.animationType },
    )
    if (direction) query.set("direction", direction)
    const raw = await this.request<unknown>(
      `/characters/${encodeURIComponent(characterId)}/animations?${query.toString()}`,
      { method: "DELETE" },
    )
    return validateResponse(DeleteAnimationsSchema, raw, "characters/{id}/animations")
  }

  /** Irreversible: the character, its states are separate records, and its animations. */
  deleteCharacter(characterId: string): Promise<unknown> {
    return this.request(`/characters/${encodeURIComponent(characterId)}`, { method: "DELETE" })
  }

  setCharacterTags(characterId: string, tags: string[]): Promise<unknown> {
    return this.request(`/characters/${encodeURIComponent(characterId)}/tags`, {
      method: "PATCH",
      body: JSON.stringify({ tags }),
    })
  }

  /** Storage URLs are public; no auth header, and sending one can break the CDN request. */
  async download(url: string): Promise<Buffer> {
    const res = await this.http(url)
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
