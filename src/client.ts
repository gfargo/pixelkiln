import type { CharacterDirection, CharacterProportions, ResolvedStyleImage, UiElement, UiPiece } from "./types.ts"
import { z } from "zod"
import { ProviderError } from "./errors.ts"
import { fetchWithRetry, type RetryingFetch } from "./http.ts"
import { SkeletonKeypointSchema, type SkeletonKeypoint } from "./skeleton.ts"

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
  /** Set for a `POST /objects/{id}/states` result; null for a base. */
  state_name?: string | null
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
  /** Set once `/objects/{id}/animations` has ever completed on this object. */
  group_id?: string | null
  animations: ObjectAnimationGroup[]
}

/** One `POST /objects/{id}/animations` result, grouped across its directions. */
export interface ObjectAnimationGroup {
  animation_group_id: string
  display_name: string | null
  description: string
  frame_count: number
  directions: { direction: string; storage_urls: Record<string, unknown>; created_at: string }[]
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

/**
 * A `/create-tileset` tile: unlike `TilesPro`, the image comes back embedded
 * as base64 rather than a `storage_urls` link, and each tile carries the
 * Wang-corner data (`corners`, `pattern_4x4`) a consumer needs to place it.
 */
export interface TilesetTile {
  id: string
  name: string
  image: { base64: string; format: string }
  corners: { NW: string; NE: string; SW: string; SE: string }
  pattern_4x4: { row_0: number[]; row_1: number[]; row_2: number[]; row_3: number[] }
}

/**
 * A completed tileset. Like tiles-pro, `GET /tilesets/{id}` has no `status`
 * field: it answers 423 while still generating and 200 with this shape once
 * done, so the HTTP code IS the status.
 */
export interface Tileset {
  total_tiles: number
  tile_size: { width: number; height: number }
  terrain_types: string[]
  tiles: TilesetTile[]
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
const UsageSchema = z
  .object({
    type: z.string().optional(),
    usd: z.number().nullable().optional(),
    generations: z.number().nullable().optional(),
  })
  .passthrough()
  .nullable()
  .optional()
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
const TilesetSubmitSchema = z
  .object({
    tileset_id: z.string().min(1),
    background_job_id: z.string().min(1),
    status: z.literal("processing").default("processing"),
  })
  .passthrough()
const TilesetTileSchema = z
  .object({
    id: z.string().min(1),
    name: z.string(),
    image: z.object({ base64: z.string().min(1), format: z.string().default("png") }).passthrough(),
    corners: z
      .object({ NW: z.string(), NE: z.string(), SW: z.string(), SE: z.string() })
      .passthrough(),
    pattern_4x4: z
      .object({
        row_0: z.array(z.number()),
        row_1: z.array(z.number()),
        row_2: z.array(z.number()),
        row_3: z.array(z.number()),
      })
      .passthrough(),
  })
  .passthrough()
const TilesetGetSchema = z
  .object({
    tileset: z
      .object({
        total_tiles: z.number().int().min(1),
        tile_size: z.object({ width: z.number().int().positive(), height: z.number().int().positive() }).passthrough(),
        terrain_types: z.array(z.string()),
        tiles: z.array(TilesetTileSchema).min(1),
      })
      .passthrough(),
    usage: UsageSchema,
  })
  .passthrough()
const IsometricTileSubmitSchema = z
  .object({
    tile_id: z.string().min(1),
    background_job_id: z.string().min(1),
    status: z.literal("processing").default("processing"),
  })
  .passthrough()
const IsometricTileGetSchema = z
  .object({
    image: z.object({ base64: z.string().min(1), format: z.string().default("png") }).passthrough(),
    usage: UsageSchema,
  })
  .passthrough()
const UiAssetSubmitSchema = z
  .object({
    ui_asset_id: z.string().min(1),
    background_job_id: z.string().min(1),
    status: z.string().default("processing"),
    usage: UsageSchema,
  })
  .passthrough()
const UiAssetGetSchema = z
  .object({
    id: z.string().min(1),
    status: z.string().nullable().default(null),
    image_url: z.string().nullable().optional(),
    progress_percent: z.number().nullable().optional(),
    eta_seconds: z.number().nullable().optional(),
  })
  .passthrough()
/** Shared by /inpaint-v3 and /edit-images-v2: both hand back a generic background job. */
const RevisionJobSubmitSchema = z
  .object({
    background_job_id: z.string().min(1),
    status: z.string().default("processing"),
  })
  .passthrough()
const ObjectAnimationGroupSchema = z
  .object({
    animation_group_id: z.string().min(1),
    display_name: z.string().nullable().default(null),
    description: z.string().default(""),
    frame_count: z.number().int().default(0),
    directions: z
      .array(
        z
          .object({
            direction: z.string(),
            storage_urls: z.record(z.unknown()).default({}),
            created_at: z.string(),
          })
          .passthrough(),
      )
      .default([]),
  })
  .passthrough()
const PixelLabObjectSchema = z
  .object({
    id: z.string().min(1),
    name: z.string().nullable().default(null),
    state_name: z.string().nullable().optional(),
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
    group_id: z.string().nullable().optional(),
    animations: z.array(ObjectAnimationGroupSchema).default([]),
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
const ReduceColorsResponseSchema = z
  .object({
    images: z.array(z.object({ base64: z.string().min(1) }).passthrough()).min(1),
    palette: z.object({ base64: z.string().min(1) }).passthrough(),
    n_colors: z.number().int(),
    usage: z.unknown().optional(),
  })
  .passthrough()
const CorrectPixelartResponseSchema = z
  .object({
    images: z.array(z.object({ base64: z.string().min(1) }).passthrough()).min(1),
    usage: z.unknown().optional(),
  })
  .passthrough()
/** Every Pro Flash image endpoint answers with the same job shape; `source_image_id` is the durable id a later character or object can reuse. */
const ProFlashImageSubmitSchema = z
  .object({
    background_job_id: z.string().min(1),
    image_id: z.string().min(1),
    source_image_id: z.string().min(1),
    status: z.string().default("processing"),
    estimated_generations: z.number().nullable().optional(),
    usage: z.unknown().optional(),
  })
  .passthrough()
const UnzoomResponseSchema = z
  .object({
    image: z.object({ base64: z.string().min(1) }).passthrough(),
    original_size: z.object({ width: z.number().int(), height: z.number().int() }).passthrough(),
    unzoomed_size: z.object({ width: z.number().int(), height: z.number().int() }).passthrough(),
    zoom_factor_detected: z.number(),
    usage: z.unknown().optional(),
  })
  .passthrough()
/** `GET /generate-font-pro/{job_id}`: the download URLs appear only once `status` is `completed`. */
const FontJobSchema = z
  .object({
    job_id: z.string().min(1),
    status: z.string(),
    glyph_px: z.number().int().nullable().optional(),
    download_atlas_url: z.string().nullable().optional(),
    download_ttf_url: z.string().nullable().optional(),
    usage: z.unknown().optional(),
  })
  .passthrough()
const SelectFramesSchema = z.object({ created_object_ids: z.array(z.string()) }).passthrough()

/**
 * `/estimate-skeleton`'s response: unlike every other PixelLab call this
 * client makes, request/response field names here are not confirmed against
 * an authoritative source (no MCP tool wraps this endpoint to cross-check
 * against, unlike `animate-with-skeleton-v3` below). Synchronous — returns
 * keypoints directly, no `background_job_id` — per the issue's own "one-call
 * round trip" framing, but this specific claim is unverified against a live
 * account. Treat this schema as provisional until a real call confirms it.
 */
const EstimateSkeletonResponseSchema = z
  .object({
    keypoints: z.array(SkeletonKeypointSchema).length(18),
    usage: z.unknown().optional(),
  })
  .passthrough()

// Characters. Verified against the v2 OpenAPI document; a character is one
// record with 4 or 8 rotation URLs once its job completes, and its
// animations hang off it grouped by name and direction.
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
const ObjectProSubmitSchema = z
  .object({
    object_id: z.string().min(1),
    background_job_id: z.string().min(1),
    status: z.string().default("processing"),
    usage: UsageSchema,
  })
  .passthrough()
/**
 * Unlike `/animate-character` (whose real request/response shape does not
 * match its own OpenAPI schema — see `animateCharacter`), `/objects/{id}/animations`
 * matches its documented shape exactly: one `DirectionSubmission` per
 * requested direction, each with its own background job id.
 */
const DirectionSubmissionSchema = z
  .object({
    direction: z.string(),
    status: z.string(),
    background_job_id: z.string().nullable().default(null),
    animation_id: z.string().nullable().default(null),
  })
  .passthrough()
const AnimateObjectSubmitSchema = z
  .object({
    animation_group_id: z.string().min(1),
    object_id: z.string().min(1),
    mode: z.string(),
    frame_count: z.number().int(),
    display_name: z.string().nullable().default(null),
    description: z.string().default(""),
    submissions: z.array(DirectionSubmissionSchema),
    usage: UsageSchema,
  })
  .passthrough()
/** `usage` on this submit response is always null (docs/ENDPOINTS.md, "Characters, measured"); read `GET /background-jobs/{id}` for the real amount. */
const PortraitSubmitSchema = z
  .object({
    background_job_id: z.string().min(1),
    status: z.string().default("processing"),
    usage: UsageSchema,
  })
  .passthrough()
/** `GET /portrait-character-pro/{job_id}`; `usage` here is always null too, same reason. */
const PortraitJobSchema = z
  .object({
    status: z.string(),
    download_url: z.string().nullable().optional(),
    width: z.number().int().nullable().optional(),
    height: z.number().int().nullable().optional(),
  })
  .passthrough()
/** `POST /characters/{id}/portrait`: synchronous, and free (`usage.generations: 0` every time observed). */
const SetPortraitSchema = z
  .object({
    character_id: z.string().min(1),
    size: z.number().int().positive(),
    url: z.string().min(1),
    usage: UsageSchema,
  })
  .passthrough()
/**
 * `usage` here is always null too (docs/ENDPOINTS.md); read
 * `GET /background-jobs/{id}` for the real amount, the only place it
 * appears — there is no `transfer-outfit-v2/{id}` status endpoint.
 */
const TransferOutfitSubmitSchema = z
  .object({
    background_job_id: z.string().min(1),
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

/**
 * The Cleanup-tier endpoints take `images`, a list of same-size frames
 * processed together; a caller passes either one `image` or the list.
 */
function cleanupImages(args: { image?: Base64Image; images?: Base64Image[] }, operation: string): Base64Image[] {
  const images = args.images ?? (args.image ? [args.image] : [])
  if (!images.length) throw new Error(`${operation} needs at least one image`)
  return images
}

/** One result per frame sent, in the same order; anything else is a shape this code does not understand. */
function cleanupResults(images: { base64: string }[], sent: number, operation: string): Buffer[] {
  if (images.length !== sent) {
    throw new Error(`Invalid PixelLab response for ${operation}: sent ${sent} image(s), got ${images.length} back`)
  }
  return images.map((image) => Buffer.from(image.base64, "base64"))
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
    tileHeight?: number
    tileType?: string
    tileView?: string
    tileViewAngle?: number
    tileDepthRatio?: number
    tileFlatTopPx?: number
    obliqueLean?: number
    tileFeature?: string
    buildingWallTiles?: number
    buildingLayout?: string
    buildingWallDescription?: string
    buildingFloorDescription?: string
    buildingFloor2Description?: string
    buildingWallAngle?: number
    outlineMode?: string
    seed?: number
    styleImages?: { base64: string; width: number; height: number }[]
  }): Promise<{ tile_id: string; background_job_id: string; status: string }> {
    const body: Record<string, unknown> = { description: args.description }
    if (args.tileSize != null) body.tile_size = args.tileSize
    if (args.tileHeight != null) body.tile_height = args.tileHeight
    if (args.tileType) body.tile_type = args.tileType
    if (args.tileView) body.tile_view = args.tileView
    if (args.tileViewAngle != null) body.tile_view_angle = args.tileViewAngle
    if (args.tileDepthRatio != null) body.tile_depth_ratio = args.tileDepthRatio
    if (args.tileFlatTopPx != null) body.tile_flat_top_px = args.tileFlatTopPx
    if (args.obliqueLean != null) body.oblique_lean = args.obliqueLean
    if (args.tileFeature) body.tile_feature = args.tileFeature
    if (args.buildingWallTiles != null) body.building_wall_tiles = args.buildingWallTiles
    if (args.buildingLayout) body.building_layout = args.buildingLayout
    if (args.buildingWallDescription) body.building_wall_description = args.buildingWallDescription
    if (args.buildingFloorDescription) body.building_floor_description = args.buildingFloorDescription
    if (args.buildingFloor2Description) body.building_floor2_description = args.buildingFloor2Description
    if (args.buildingWallAngle != null) body.building_wall_angle = args.buildingWallAngle
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
   * `/create-tileset`: two named terrain levels (`lower`/`upper`) and the
   * transition between them, laid out as a Wang corner set. Unlike
   * `/create-tiles-pro`, the descriptions are separate fields the API itself
   * places on the terrain vertex grid, not one prompt it splits by number.
   */
  async createTileset(args: {
    lowerDescription: string
    upperDescription: string
    transitionDescription?: string
    tileSize?: number
    mode?: string
    shapeStyle?: string
    spreadX?: number
    slopeSize?: number
    raggedness?: number
    transitionSize?: number
    view?: string
    outline?: string
    shading?: string
    detail?: string
    seed?: number
  }): Promise<{ tileset_id: string; background_job_id: string; status: string }> {
    const body: Record<string, unknown> = {
      lower_description: args.lowerDescription,
      upper_description: args.upperDescription,
    }
    if (args.transitionDescription) body.transition_description = args.transitionDescription
    if (args.tileSize != null) body.tile_size = { width: args.tileSize, height: args.tileSize }
    if (args.mode) body.mode = args.mode
    if (args.shapeStyle) body.shape_style = args.shapeStyle
    if (args.spreadX != null) body.spread_x = args.spreadX
    if (args.slopeSize != null) body.slope_size = args.slopeSize
    if (args.raggedness != null) body.raggedness = args.raggedness
    if (args.transitionSize != null) body.transition_size = args.transitionSize
    if (args.view) body.view = args.view
    if (args.outline) body.outline = args.outline
    if (args.shading) body.shading = args.shading
    if (args.detail) body.detail = args.detail
    if (args.seed != null) body.seed = args.seed
    return validateResponse(
      TilesetSubmitSchema,
      await this.request<unknown>("/create-tileset", { method: "POST", body: JSON.stringify(body) }),
      "create tileset",
    )
  }

  /** Throws PixelLabError(423) while the set is still drawing; see Tileset. */
  async getTileset(tilesetId: string): Promise<{ tileset: Tileset; usage: PixelLabUsage | null }> {
    const res = await validateResponse(
      TilesetGetSchema,
      await this.request<unknown>(`/tilesets/${tilesetId}`),
      "get tileset",
    )
    return { tileset: res.tileset, usage: res.usage ?? null }
  }

  /** A single standalone isometric tile — no connectable set, no candidates. */
  async createIsometricTile(args: {
    description: string
    imageWidth?: number
    imageHeight?: number
    tileSize?: number
    tileShape?: string
    outline?: string
    shading?: string
    detail?: string
    seed?: number
  }): Promise<{ tile_id: string; background_job_id: string; status: string }> {
    const body: Record<string, unknown> = { description: args.description }
    if (args.imageWidth != null && args.imageHeight != null) {
      body.image_size = { width: args.imageWidth, height: args.imageHeight }
    }
    if (args.tileSize != null) body.isometric_tile_size = args.tileSize
    if (args.tileShape) body.isometric_tile_shape = args.tileShape
    if (args.outline) body.outline = args.outline
    if (args.shading) body.shading = args.shading
    if (args.detail) body.detail = args.detail
    if (args.seed != null) body.seed = args.seed
    return validateResponse(
      IsometricTileSubmitSchema,
      await this.request<unknown>("/create-isometric-tile", { method: "POST", body: JSON.stringify(body) }),
      "create isometric tile",
    )
  }

  /** Throws PixelLabError(423) while the tile is still processing. */
  async getIsometricTile(
    tileId: string,
  ): Promise<{ image: { base64: string; format: string }; usage: PixelLabUsage | null }> {
    const res = await validateResponse(
      IsometricTileGetSchema,
      await this.request<unknown>(`/isometric-tiles/${tileId}`),
      "get isometric tile",
    )
    return { image: res.image, usage: res.usage ?? null }
  }

  /**
   * `/create-ui-asset`: one composited panel image from a shape template —
   * `pieces` (precise rect/circle/polygon regions on a virtual 0–512
   * editor canvas) and/or named `elements` (auto-positioned scaffolds:
   * button, icon_button, toolbar, tab, panel, window, health_bar, avatar,
   * triangle, pentagon, hexagon, octagon), or neither for a default
   * full-canvas rounded-rect panel. Unlike every other generator here, the
   * result is one flat image with no per-piece sub-regions or nine-slice
   * metadata returned — cropping a `pieces` layout into separate files
   * would be pixelkiln's own local work, not modeled yet.
   */
  async createUiAsset(args: {
    description: string
    width: number
    height: number
    pieces?: UiPiece[]
    elements?: UiElement[]
    styleImage?: Base64Image
    colorPalette?: string
    noBackground?: boolean
    seed?: number
  }): Promise<{ ui_asset_id: string; background_job_id: string; usage: unknown }> {
    const body: Record<string, unknown> = {
      description: args.description,
      image_size: { width: args.width, height: args.height },
    }
    if (args.pieces?.length) body.pieces = args.pieces
    if (args.elements?.length) body.elements = args.elements
    if (args.styleImage) body.style_image = args.styleImage
    if (args.colorPalette) body.color_palette = args.colorPalette
    if (args.noBackground != null) body.no_background = args.noBackground
    if (args.seed != null) body.seed = args.seed
    const res = await validateResponse(
      UiAssetSubmitSchema,
      await this.request<unknown>("/create-ui-asset", { method: "POST", body: JSON.stringify(body) }),
      "create ui asset",
    )
    return { ui_asset_id: res.ui_asset_id, background_job_id: res.background_job_id, usage: res.usage }
  }

  async getUiAsset(uiAssetId: string): Promise<{
    status: string | null
    imageUrl: string | null
    progressPercent: number | null
    etaSeconds: number | null
  }> {
    const res = await validateResponse(
      UiAssetGetSchema,
      await this.request<unknown>(`/ui-assets/${encodeURIComponent(uiAssetId)}`),
      "get ui asset",
    )
    return {
      status: res.status,
      imageUrl: res.image_url ?? null,
      progressPercent: res.progress_percent ?? null,
      etaSeconds: res.eta_seconds ?? null,
    }
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

  /**
   * A standalone object with no skeleton, one call draws the south sprite
   * (or takes the author's) and rotates it with v3 — the character
   * pro-flash pattern, minus `template_id` (objects have no skeleton) and
   * with a real `n_directions` choice (1 or 8, character pro-flash is
   * always 8). Async only: `/create-object-pro-flash` has no sync response.
   */
  async createObjectProFlash(args: {
    description: string
    directions: 1 | 8
    size: number
    view?: string
    seed?: number
    reference?: Base64Image
    styleReference?: Base64Image
    styleReferenceSize?: { width: number; height: number }
    styleTraits?: { palette?: boolean; outline?: boolean; detail?: boolean; shading?: boolean }
    /** An owned image already holding the reference's exact pixels, sent instead of uploading them. */
    sourceImageId?: string
  }): Promise<{ object_id: string; background_job_id: string; usage?: PixelLabUsage | null }> {
    const encode = (image: Base64Image) => ({ type: "base64", base64: image.base64, format: image.format })
    const traits = args.styleTraits
    const body: Record<string, unknown> = {
      description: args.description,
      n_directions: args.directions,
      ...(args.sourceImageId
        ? { source_image_id: args.sourceImageId }
        : args.reference ? { first_frame: encode(args.reference) } : { image_size: { width: args.size, height: args.size } }),
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
    return validateResponse(
      ObjectProSubmitSchema,
      await this.request<unknown>("/create-object-pro-flash", { method: "POST", body: JSON.stringify(body) }),
      "create-object-pro-flash",
    )
  }

  /** A text edit of an existing object, applied to its whole rotation set and stored as a sibling. Always inherits the parent's exact canvas — no size override exists on this endpoint. */
  async createObjectProState(args: { objectId: string; editDescription: string; stateName?: string; seed?: number }): Promise<{ object_id: string; background_job_id: string; usage?: PixelLabUsage | null }> {
    const raw = await this.request<unknown>(`/objects/${encodeURIComponent(args.objectId)}/states`, {
      method: "POST",
      body: JSON.stringify({
        edit_description: args.editDescription,
        ...(args.stateName ? { state_name: args.stateName } : {}),
        ...(args.seed != null ? { seed: args.seed } : {}),
      }),
    })
    return validateResponse(ObjectProSubmitSchema, raw, "create object state")
  }

  /**
   * One direction of one object's animation. Unlike character animation,
   * this endpoint's own `replace_existing` flag regenerates an
   * already-animated direction directly (character has no such flag and
   * pixelkiln instead deletes the prior take itself before resubmitting;
   * see `submitCharacter`). A 1-direction object must not receive
   * `directions` at all -- the API 400s if it does.
   */
  async animateObject(args: {
    objectId: string
    directions: 1 | 8
    direction: string
    animationDescription?: string
    animationGroupId?: string
    displayName?: string
    mode: "v3" | "pro"
    frameCount?: number
    keepFirstFrame?: boolean
    startFrame?: Base64Image
    endFrame?: Base64Image
    enhancePrompt?: boolean
    replaceExisting?: boolean
  }): Promise<{ animation_group_id: string; object_id: string; mode: string; frame_count: number; submissions: { direction: string; status: string; background_job_id: string | null; animation_id: string | null }[]; usage?: PixelLabUsage | null }> {
    const encode = (image: Base64Image) => ({ type: "base64", base64: image.base64, format: image.format })
    const body: Record<string, unknown> = {
      mode: args.mode,
      ...(args.directions === 8 ? { directions: [args.direction] } : {}),
      ...(args.animationDescription ? { animation_description: args.animationDescription } : {}),
      ...(args.animationGroupId ? { animation_group_id: args.animationGroupId } : {}),
      ...(args.displayName ? { display_name: args.displayName } : {}),
      ...(args.frameCount != null ? { frame_count: args.frameCount } : {}),
      ...(args.keepFirstFrame === false ? { keep_first_frame: false } : {}),
      ...(args.startFrame ? { custom_start_frame: encode(args.startFrame) } : {}),
      ...(args.endFrame ? { end_frame: encode(args.endFrame) } : {}),
      ...(args.enhancePrompt ? { enhance_prompt: true } : {}),
      ...(args.replaceExisting ? { replace_existing: true } : {}),
    }
    const raw = await this.request<unknown>(`/objects/${encodeURIComponent(args.objectId)}/animations`, {
      method: "POST",
      body: JSON.stringify(body),
    })
    return validateResponse(AnimateObjectSubmitSchema, raw, "animate object")
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
    /** pro-flash only: an owned image already holding the south sprite's exact pixels, sent instead of uploading them. */
    sourceImageId?: string
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
        // The author's sprite sets the canvas; a size only applies to text
        // creation. An owned copy of the same sprite is referenced by id.
        ...(args.sourceImageId
          ? { source_image_id: args.sourceImageId }
          : south ? { first_frame: encode(south) } : { image_size: imageSize }),
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

  /**
   * A full-body sprite in, a bust portrait out (or the reverse, unused
   * today). Job-based like a state or `1dir`, not the couple-generations
   * "conversion" the name suggests: the smallest `resultSize` (16px) billed
   * 20 generations live (docs/ENDPOINTS.md, "Characters, measured").
   */
  async createPortraitCharacterPro(args: {
    direction: "portrait_to_character" | "character_to_portrait"
    image: Base64Image
    view?: string
    resultSize?: number
    seed?: number
  }): Promise<{ background_job_id: string; status: string; usage?: PixelLabUsage | null }> {
    const raw = await this.request<unknown>("/portrait-character-pro", {
      method: "POST",
      body: JSON.stringify({
        direction: args.direction,
        image: { type: "base64", base64: args.image.base64, format: args.image.format },
        ...(args.view ? { view: args.view } : {}),
        ...(args.resultSize != null ? { result_size: args.resultSize } : {}),
        ...(args.seed != null ? { seed: args.seed } : {}),
      }),
    })
    return validateResponse(PortraitSubmitSchema, raw, "portrait-character-pro")
  }

  /** Throws PixelLabError(423) while the job is still drawing, like tiles and map objects. */
  async getPortraitCharacterJob(jobId: string): Promise<{ status: string; download_url?: string | null; width?: number | null; height?: number | null }> {
    const raw = await this.request<unknown>(`/portrait-character-pro/${encodeURIComponent(jobId)}`)
    return validateResponse(PortraitJobSchema, raw, "portrait-character-pro/{id}")
  }

  /**
   * Attaches a portrait image to a character record. Synchronous and free
   * (0 generations, live); PixelLab does not link this to
   * `createPortraitCharacterPro` automatically, and `GET /characters/{id}`
   * never grows a portrait field, so this response's `url` is the only place
   * it appears.
   */
  async setCharacterPortrait(characterId: string, image: Base64Image): Promise<{ character_id: string; size: number; url: string; usage?: PixelLabUsage | null }> {
    const raw = await this.request<unknown>(`/characters/${encodeURIComponent(characterId)}/portrait`, {
      method: "POST",
      body: JSON.stringify({ image: { type: "base64", base64: image.base64, format: image.format } }),
    })
    return validateResponse(SetPortraitSchema, raw, "characters/{id}/portrait")
  }

  /**
   * Applies a reference outfit to 2–16 existing frames. Job-based like
   * everything else here, but the completed job returns the result frames
   * inline as base64 (`last_response.quantized_images`), not as storage
   * URLs — the one PixelLab character tool that works this way. A live
   * 2-frame, 92x92 job billed 20 generations (docs/ENDPOINTS.md).
   */
  async transferOutfitV2(args: {
    referenceImage: Base64Image & { width: number; height: number }
    frames: (Base64Image & { width: number; height: number })[]
    imageSize: { width: number; height: number }
    seed?: number
    noBackground?: boolean
    additionalInstructions?: string
  }): Promise<{ background_job_id: string; status: string; usage?: PixelLabUsage | null }> {
    const image = (img: Base64Image & { width: number; height: number }) => ({
      image: { type: "base64", base64: img.base64, format: img.format },
      size: { width: img.width, height: img.height },
    })
    const raw = await this.request<unknown>("/transfer-outfit-v2", {
      method: "POST",
      body: JSON.stringify({
        reference_image: image(args.referenceImage),
        frames: args.frames.map(image),
        image_size: args.imageSize,
        ...(args.seed != null ? { seed: args.seed } : {}),
        ...(args.noBackground !== undefined ? { no_background: args.noBackground } : {}),
        ...(args.additionalInstructions ? { additional_instructions: args.additionalInstructions } : {}),
      }),
    })
    return validateResponse(TransferOutfitSubmitSchema, raw, "transfer-outfit-v2")
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

  /**
   * Masked inpaint, PixelLab's `/inpaint-v3` (the endpoint its own docs list
   * first in the Inpaint section, its convention for "reach for this by
   * default"). Exercised live at nine sizes, all returning `last_response.
   * image` as a single `{type, base64, width, height}` (the first shape
   * `pollRevision` in pixellab.ts checks, so no change was ever needed):
   * 32x32 (1024px², billed 20, this adapter's tiering floor) through
   * 256x256 (65536px²) all billed 20 (the tiering wrongly predicts 25 from
   * 1024px² up, see estimate() in pixellab.ts); 288x288 (82944px²) and
   * 320x320 (102400px²) billed 25 — the middle tier is real, just starting
   * far higher than this tiering assumes; 352x352 (123904px²), 384x384
   * (147456px²), and 512x512 (262144px², the tiering ceiling) all billed
   * 40. Both breakpoints are now tightly bracketed: 20->25 in
   * (65536px², 82944px²], 25->40 in (102400px², 123904px²].
   * `editImagesV2` below returns the same fields under `images`, plural
   * and array-wrapped, not `image` — do not assume the two endpoints share
   * one response shape. See docs/ENDPOINTS.md and docs/REVISIONS.md for
   * the full shape and cost picture, including what is still unconfirmed.
   *
   * `crop_to_mask` defaults true upstream (confirmed in the schema): PixelLab
   * otherwise blends generated pixels outside the mask edge to "fit
   * naturally," which is the opposite of what a mask boundary is for.
   */
  async inpaintV3(args: {
    description: string
    image: Base64Image
    width: number
    height: number
    maskImage: Base64Image
    noBackground?: boolean
    cropToMask?: boolean
    seed?: number
  }): Promise<{ background_job_id: string; status: string }> {
    const size = { width: args.width, height: args.height }
    const body: Record<string, unknown> = {
      description: args.description,
      inpainting_image: { image: args.image, size },
      mask_image: { image: args.maskImage, size },
    }
    if (args.noBackground != null) body.no_background = args.noBackground
    if (args.cropToMask != null) body.crop_to_mask = args.cropToMask
    if (args.seed != null) body.seed = args.seed
    return validateResponse(
      RevisionJobSubmitSchema,
      await this.request<unknown>("/inpaint-v3", { method: "POST", body: JSON.stringify(body) }),
      "inpaint-v3",
    )
  }

  /**
   * Whole-image edit with no mask, PixelLab's `/edit-images-v2`. `edit_images`
   * takes an array (the endpoint supports editing several images with one
   * instruction); pixelkiln's `revision` model is one parent per child, so
   * this always sends exactly one. Exercised live at its floor size (32x32):
   * billed exactly the 20-generation estimate this adapter borrows from
   * `1dir`, matching `inpaintV3`'s floor exactly. The completed response is
   * `last_response.images`, an *array* of `{type, base64, width, height}` —
   * plural and array-wrapped, unlike `inpaintV3`'s singular `image` above,
   * even though exactly one image is ever sent or expected here.
   */
  async editImagesV2(args: {
    description: string
    image: Base64Image
    width: number
    height: number
    noBackground?: boolean
    seed?: number
  }): Promise<{ background_job_id: string; status: string }> {
    const body: Record<string, unknown> = {
      method: "edit_with_text",
      description: args.description,
      edit_images: [{ image: args.image, width: args.width, height: args.height }],
      image_size: { width: args.width, height: args.height },
    }
    if (args.noBackground != null) body.no_background = args.noBackground
    if (args.seed != null) body.seed = args.seed
    return validateResponse(
      RevisionJobSubmitSchema,
      await this.request<unknown>("/edit-images-v2", { method: "POST", body: JSON.stringify(body) }),
      "edit-images-v2",
    )
  }

  /**
   * PixelLab's Pro image tier, `/generate-image-v2`: a flat 40 generations
   * (docs/ENDPOINTS.md, "Single-image generators, measured") for real style
   * transfer and non-square canvases up to 792x688, where `pixflux` is
   * limited to 400x400 and no style reference. Like a revision, this hands
   * back a plain background job with no resource of its own; unlike a
   * revision, one call returns several candidate images to pick from (the
   * same 4/16/64-by-size tiering as `1dir`), not a single result, and its
   * completed shape has not been exercised live yet — `pollImagePro` in
   * pixellab.ts fails loudly rather than guess if `last_response.images`
   * turns out not to be the real field name.
   *
   * Reference images and a style image (`reference_images`, `style_image` +
   * `style_options`) exist on this endpoint but are not modeled here yet.
   */
  async createImagePro(args: {
    description: string
    width: number
    height: number
    noBackground?: boolean
    seed?: number
  }): Promise<{ background_job_id: string; status: string }> {
    const body: Record<string, unknown> = {
      description: args.description,
      image_size: { width: args.width, height: args.height },
    }
    if (args.noBackground != null) body.no_background = args.noBackground
    if (args.seed != null) body.seed = args.seed
    return validateResponse(
      RevisionJobSubmitSchema,
      await this.request<unknown>("/generate-image-v2", { method: "POST", body: JSON.stringify(body) }),
      "generate-image-v2",
    )
  }

  /**
   * `/create-image-pro-flash`: one native pixel-art image from a
   * description, optionally styled after a style image with per-trait
   * toggles, on the same Pro Flash model `character`/`objectPro` use for
   * their `pro-flash` engine. Sizes run 16 to 256 per side in multiples of 4.
   * A plain background job; `pollRevision`'s generic reader takes the
   * finished image. The response's `source_image_id` is what a Pro Flash
   * character or object can reuse instead of an upload.
   */
  async createImageProFlash(args: {
    description: string
    width: number
    height: number
    noBackground?: boolean
    seed?: number
    styleImage?: { image: Base64Image; width: number; height: number }
    styleTraits?: { palette?: boolean; outline?: boolean; detail?: boolean; shading?: boolean }
  }): Promise<z.output<typeof ProFlashImageSubmitSchema>> {
    const body: Record<string, unknown> = {
      description: args.description,
      image_size: { width: args.width, height: args.height },
    }
    if (args.noBackground != null) body.no_background = args.noBackground
    if (args.seed != null) body.seed = args.seed
    if (args.styleImage) {
      body.style_image = { image: args.styleImage.image, size: { width: args.styleImage.width, height: args.styleImage.height } }
      const traits = args.styleTraits
      if (traits) {
        body.style_options = {
          ...(traits.palette !== undefined ? { color_palette: traits.palette } : {}),
          ...(traits.outline !== undefined ? { outline: traits.outline } : {}),
          ...(traits.detail !== undefined ? { detail: traits.detail } : {}),
          ...(traits.shading !== undefined ? { shading: traits.shading } : {}),
        }
      }
    }
    return validateResponse(
      ProFlashImageSubmitSchema,
      await this.request<unknown>("/create-image-pro-flash", { method: "POST", body: JSON.stringify(body) }),
      "create-image-pro-flash",
    )
  }

  /** `/edit-image-pro-flash`, text method: edit one image at its own size. The canvas never grows or resizes. */
  async editImageProFlash(args: {
    image: Base64Image
    description: string
    noBackground?: boolean
    seed?: number
  }): Promise<z.output<typeof ProFlashImageSubmitSchema>> {
    const body: Record<string, unknown> = { image: args.image, method: "text", description: args.description }
    if (args.noBackground != null) body.no_background = args.noBackground
    if (args.seed != null) body.seed = args.seed
    return validateResponse(
      ProFlashImageSubmitSchema,
      await this.request<unknown>("/edit-image-pro-flash", { method: "POST", body: JSON.stringify(body) }),
      "edit-image-pro-flash",
    )
  }

  /**
   * `/inpaint-image-pro-flash`: replace only the white pixels of a same-size
   * black/white mask, keeping everything else exactly. `Modify current
   * layer` (the endpoint's default) returns the full composite.
   */
  async inpaintImageProFlash(args: {
    image: Base64Image
    maskImage: Base64Image
    description: string
    noBackground?: boolean
    seed?: number
  }): Promise<z.output<typeof ProFlashImageSubmitSchema>> {
    const body: Record<string, unknown> = { image: args.image, mask_image: args.maskImage, description: args.description }
    if (args.noBackground != null) body.no_background = args.noBackground
    if (args.seed != null) body.seed = args.seed
    return validateResponse(
      ProFlashImageSubmitSchema,
      await this.request<unknown>("/inpaint-image-pro-flash", { method: "POST", body: JSON.stringify(body) }),
      "inpaint-image-pro-flash",
    )
  }

  /**
   * `/generate-ui-v2` ("Generate UI (Pro)"): one UI element (a button, a
   * health bar, an inventory slot, a dialogue box) from a description,
   * guided by an optional concept image and a natural-language color
   * palette. A plain background job; unlike `/create-ui-asset` there is no
   * piece/element layout, and sizes start at 16px instead of 192. Its
   * completed shape has not been exercised live; `pollUiElement` reads it
   * defensively.
   */
  async generateUiV2(args: {
    description: string
    width: number
    height: number
    conceptImage?: { image: Base64Image; width: number; height: number }
    colorPalette?: string
    noBackground?: boolean
    seed?: number
  }): Promise<{ background_job_id: string; status: string }> {
    const body: Record<string, unknown> = {
      description: args.description,
      image_size: { width: args.width, height: args.height },
    }
    if (args.conceptImage) {
      body.concept_image = {
        image: args.conceptImage.image,
        size: { width: args.conceptImage.width, height: args.conceptImage.height },
      }
    }
    if (args.colorPalette) body.color_palette = args.colorPalette
    if (args.noBackground != null) body.no_background = args.noBackground
    if (args.seed != null) body.seed = args.seed
    return validateResponse(
      RevisionJobSubmitSchema,
      await this.request<unknown>("/generate-ui-v2", { method: "POST", body: JSON.stringify(body) }),
      "generate-ui-v2",
    )
  }

  /**
   * `/reduce-colors`, PixelLab's "Cleanup" tier: quantize one image, or
   * several same-size frames together onto ONE shared palette, synchronously
   * — no `background_job_id`, the result comes back in this same response,
   * like `createImagePixflux`. Passing every frame of an animation (or every
   * direction of a character) in one call is the endpoint's whole point:
   * frames quantized separately drift onto different palettes. The schema's
   * own response example is dollar-denominated (`usage: {type: "usd", usd:
   * 0.02}`), which — matching this codebase's repeated experience with
   * PixelLab's documented-vs-billed cost mismatches (`isometricTile`,
   * `objectPro`) — did not hold: confirmed live against a Tier 2 account at
   * exactly 0.1 generations for a 32x32 source (docs/REVISIONS.md).
   * `numColors` and `paletteImage` are mutually exclusive upstream; the
   * manifest schema already enforces that before this is ever called.
   */
  async reduceColors(args: {
    /** One image, or `images` for a frame set quantized together. */
    image?: Base64Image
    images?: Base64Image[]
    numColors?: number
    paletteImage?: Base64Image
    dithering?: "none" | "2x2" | "4x4" | "8x8"
    ditheringStrength?: number
  }): Promise<{ png: Buffer; pngs: Buffer[]; paletteStripPng: Buffer; nColors: number; usage: unknown }> {
    const images = cleanupImages(args, "reduce-colors")
    const body: Record<string, unknown> = { images }
    if (args.numColors != null) body.num_colors = args.numColors
    if (args.paletteImage) body.palette_image = args.paletteImage
    if (args.dithering) body.dithering = args.dithering
    if (args.ditheringStrength != null) body.dithering_strength = args.ditheringStrength
    const res = validateResponse(
      ReduceColorsResponseSchema,
      await this.request<unknown>("/reduce-colors", { method: "POST", body: JSON.stringify(body) }),
      "reduce-colors",
    )
    const pngs = cleanupResults(res.images, images.length, "reduce-colors")
    return {
      png: pngs[0]!,
      pngs,
      paletteStripPng: Buffer.from(res.palette.base64, "base64"),
      nColors: res.n_colors,
      usage: res.usage,
    }
  }

  /**
   * `/correct-pixelart`, PixelLab's "Cleanup" tier: sharpen edges and drop
   * stray pixels without resizing, synchronously — same shape as
   * `reduceColors` above, no background job, and likewise corrects several
   * same-size frames together when given `images`. Cost is confirmed live
   * at 0.1 generations for a 32x32 source, not the schema's own
   * dollar-denominated example (`usage: {type: "usd", usd: 0.02}`).
   */
  async correctPixelart(args: {
    image?: Base64Image
    images?: Base64Image[]
    strength?: number
  }): Promise<{ png: Buffer; pngs: Buffer[]; usage: unknown }> {
    const images = cleanupImages(args, "correct-pixelart")
    const body: Record<string, unknown> = { images }
    if (args.strength != null) body.strength = args.strength
    const res = validateResponse(
      CorrectPixelartResponseSchema,
      await this.request<unknown>("/correct-pixelart", { method: "POST", body: JSON.stringify(body) }),
      "correct-pixelart",
    )
    const pngs = cleanupResults(res.images, images.length, "correct-pixelart")
    return { png: pngs[0]!, pngs, usage: res.usage }
  }

  /**
   * `/unzoom`: recover native-resolution pixel art from an upscaled image (a
   * 32x32 sprite saved at 512x512). Synchronous like the Cleanup tier.
   * PixelLab's own API overview names this "the most common cause of
   * disappointing output": run it on outside artwork before it becomes a
   * style or reference image. The input must be at least 256x256 and at
   * most 2048x2048 in area, and the result is opaque — transparency is
   * composited onto white before the grid is detected. `quantize` is 0 to
   * auto-detect a palette, -1 to keep every color, or 2-256 for exactly
   * that many.
   */
  async unzoom(args: { image: Base64Image; quantize?: number }): Promise<{
    png: Buffer
    originalSize: { width: number; height: number }
    unzoomedSize: { width: number; height: number }
    zoomFactor: number
    usage: unknown
  }> {
    const body: Record<string, unknown> = { image: args.image }
    if (args.quantize != null) body.quantize = args.quantize
    const res = validateResponse(
      UnzoomResponseSchema,
      await this.request<unknown>("/unzoom", { method: "POST", body: JSON.stringify(body) }),
      "unzoom",
    )
    return {
      png: Buffer.from(res.image.base64, "base64"),
      originalSize: { width: res.original_size.width, height: res.original_size.height },
      unzoomedSize: { width: res.unzoomed_size.width, height: res.unzoomed_size.height },
      zoomFactor: res.zoom_factor_detected,
      usage: res.usage,
    }
  }

  /**
   * `/interpolation-v2` ("Interpolate (Pro)"): generate the in-between
   * frames from one keyframe to another, guided by a short `action`. Unlike
   * `last_frame` on `/animate-with-text-v3`, both ends are required and the
   * frame count is the model's own choice (its docs say "typically 4-8").
   * Output frames are 16 to 128 pixels per side. A plain background job;
   * its completed shape is read defensively by `pollAnimateRevision`.
   */
  async interpolationV2(args: {
    startImage: Base64Image
    endImage: Base64Image
    width: number
    height: number
    action: string
    seed?: number
    noBackground?: boolean
  }): Promise<{ background_job_id: string; status: string }> {
    const size = { width: args.width, height: args.height }
    const body: Record<string, unknown> = {
      start_image: { image: args.startImage, size },
      end_image: { image: args.endImage, size },
      action: args.action,
      image_size: size,
    }
    if (args.seed != null) body.seed = args.seed
    if (args.noBackground != null) body.no_background = args.noBackground
    return validateResponse(
      RevisionJobSubmitSchema,
      await this.request<unknown>("/interpolation-v2", { method: "POST", body: JSON.stringify(body) }),
      "interpolation-v2",
    )
  }

  /**
   * `/edit-animation-v2` ("Edit animation (Pro)"): apply one text edit
   * across every frame of an existing animation at once, so the change
   * stays consistent frame to frame. 2 to 16 frames, but the real ceiling
   * shrinks with frame size because every frame is packed into one grid:
   * 16 at up to 64px, 9 at 65-80px, 4 at 81-256px.
   */
  async editAnimationV2(args: {
    frames: Base64Image[]
    width: number
    height: number
    description: string
    seed?: number
    noBackground?: boolean
  }): Promise<{ background_job_id: string; status: string }> {
    const size = { width: args.width, height: args.height }
    const body: Record<string, unknown> = {
      description: args.description,
      frames: args.frames.map((image) => ({ image, size })),
      image_size: size,
    }
    if (args.seed != null) body.seed = args.seed
    if (args.noBackground != null) body.no_background = args.noBackground
    return validateResponse(
      RevisionJobSubmitSchema,
      await this.request<unknown>("/edit-animation-v2", { method: "POST", body: JSON.stringify(body) }),
      "edit-animation-v2",
    )
  }

  /**
   * `/generate-font-pro`: an 80-glyph pixel font (A-Z, a-z, 0-9, common
   * game-UI punctuation) from a style description, delivered as a glyph
   * atlas PNG plus a ready-to-use `.ttf`. Documented at 25 subscription
   * generations. Poll with `getFontJob`.
   */
  async generateFontPro(args: {
    description: string
    weight: "Bold" | "Regular"
    glyphPx?: 8 | 16 | 32 | 64
    seed?: number
    fontName?: string
  }): Promise<{ background_job_id: string; status: string }> {
    const body: Record<string, unknown> = { description: args.description, weight: args.weight }
    if (args.glyphPx != null) body.glyph_px = args.glyphPx
    if (args.seed != null) body.seed = args.seed
    if (args.fontName) body.font_name = args.fontName
    return validateResponse(
      RevisionJobSubmitSchema,
      await this.request<unknown>("/generate-font-pro", { method: "POST", body: JSON.stringify(body) }),
      "generate-font-pro",
    )
  }

  /** `GET /generate-font-pro/{job_id}`: status, then no-auth atlas and `.ttf` URLs once completed. */
  async getFontJob(jobId: string): Promise<z.output<typeof FontJobSchema>> {
    const raw = await this.request<unknown>(`/generate-font-pro/${encodeURIComponent(jobId)}`)
    return validateResponse(FontJobSchema, raw, "generate-font-pro/{job_id}")
  }

  /**
   * `/animate-with-text-v3`: animate a loose image from a text description,
   * no PixelLab character/object resource required — unlike `animateCharacter`
   * / `animateObject`, `firstFrame` is whatever bytes the caller has on hand.
   * A plain background job, like every other PixelLab async submission;
   * unlike `inpaintV3`/`editImagesV2`, its completed shape has not been
   * exercised against a live account (request/response fields here come from
   * the live OpenAPI document, not an observed call — `pollAnimateRevision`
   * in pixellab.ts checks several plausible field names for the frame list
   * defensively, the same as `pollRevision` already does for image edits).
   */
  async animateWithTextV3(args: {
    firstFrame: Base64Image
    lastFrame?: Base64Image
    action: string
    frameCount?: number
    seed?: number
    noBackground?: boolean
    enhancePrompt?: boolean
  }): Promise<{ background_job_id: string; status: string }> {
    const body: Record<string, unknown> = { first_frame: args.firstFrame, action: args.action }
    if (args.lastFrame) body.last_frame = args.lastFrame
    if (args.frameCount != null) body.frame_count = args.frameCount
    if (args.seed != null) body.seed = args.seed
    if (args.noBackground != null) body.no_background = args.noBackground
    if (args.enhancePrompt != null) body.enhance_prompt = args.enhancePrompt
    return validateResponse(
      RevisionJobSubmitSchema,
      await this.request<unknown>("/animate-with-text-v3", { method: "POST", body: JSON.stringify(body) }),
      "animate-with-text-v3",
    )
  }

  /**
   * `/animate-pixminimax`, beta (tier 1 subscription or higher): PixMiniMax's
   * richer take on the same idea — `direction` and `enhancePrompt` steer
   * facing for aimed motions. Same unverified-completed-shape caveat as
   * `animateWithTextV3` above.
   */
  async animatePixminimax(args: {
    firstFrame: Base64Image
    lastFrame?: Base64Image
    description: string
    frameCount?: number
    seed?: number
    noBackground?: boolean
    enhancePrompt?: boolean
    direction?: string
  }): Promise<{ background_job_id: string; status: string }> {
    const body: Record<string, unknown> = { first_frame: args.firstFrame, description: args.description }
    if (args.lastFrame) body.last_frame = args.lastFrame
    if (args.frameCount != null) body.frame_count = args.frameCount
    if (args.seed != null) body.seed = args.seed
    if (args.noBackground != null) body.no_background = args.noBackground
    if (args.enhancePrompt != null) body.enhance_prompt = args.enhancePrompt
    if (args.direction) body.direction = args.direction
    return validateResponse(
      RevisionJobSubmitSchema,
      await this.request<unknown>("/animate-pixminimax", { method: "POST", body: JSON.stringify(body) }),
      "animate-pixminimax",
    )
  }

  /**
   * `/animate-with-skeleton-v3`, beta (tier 1 subscription or higher): poses
   * one reference image frame-by-frame from a supplied skeleton per frame,
   * rather than a text motion description. Confirmed against the live
   * `animate_with_skeleton_v3` MCP tool schema (the same authoritative
   * source this codebase already treats as ground truth for the
   * character/object family) — `action`/`description` are both real,
   * optional wire fields, contrary to an initial guess that this endpoint
   * took no text input at all; `direction`/`keypoints`/`firstFrameKeypoints`
   * are required. The example keypoint from that same tool schema,
   * `{"label": "RIGHT KNEE", "x": 0.52, "y": 0.71, "z_index": 9}`, is what
   * `SkeletonKeypointSchema` (`src/skeleton.ts`) models. Same
   * unverified-completed-shape caveat as `animateWithTextV3`/
   * `animatePixminimax` above — this endpoint has never been called against
   * a live account by this codebase.
   */
  async animateWithSkeletonV3(args: {
    firstFrame: Base64Image
    firstFrameKeypoints: SkeletonKeypoint[]
    keypoints: SkeletonKeypoint[][]
    direction: CharacterDirection
    templateId?: string
    action?: string
    description?: string
    seed?: number
    noBackground?: boolean
  }): Promise<{ background_job_id: string; status: string }> {
    const body: Record<string, unknown> = {
      first_frame: args.firstFrame,
      first_frame_keypoints: args.firstFrameKeypoints,
      keypoints: args.keypoints,
      direction: args.direction,
    }
    if (args.templateId) body.template_id = args.templateId
    if (args.action) body.action = args.action
    if (args.description) body.description = args.description
    if (args.seed != null) body.seed = args.seed
    if (args.noBackground != null) body.no_background = args.noBackground
    return validateResponse(
      RevisionJobSubmitSchema,
      await this.request<unknown>("/animate-with-skeleton-v3", { method: "POST", body: JSON.stringify(body) }),
      "animate-with-skeleton-v3",
    )
  }

  /**
   * `/estimate-skeleton`: auto-derives a reference image's own 18-joint
   * keypoints, directly usable as `animateWithSkeletonV3`'s
   * `firstFrameKeypoints` (or, run against a candidate pose image, as one
   * entry of its `keypoints` sequence). Not called anywhere in this
   * codebase's own submit/poll pipeline — deliberately kept outside it (see
   * `runEstimateSkeleton` in `src/cli/commands`) so the only PixelLab
   * endpoint composed into `animate-with-skeleton-v3`'s submission is that
   * one endpoint itself, not two unverified calls chained together.
   * Synchronous per this endpoint's own framing; unverified against a live
   * account (see `EstimateSkeletonResponseSchema`'s own caveat).
   */
  async estimateSkeleton(args: { image: Base64Image }): Promise<{ keypoints: SkeletonKeypoint[]; usage: unknown }> {
    const body: Record<string, unknown> = { image: args.image }
    const res = validateResponse(
      EstimateSkeletonResponseSchema,
      await this.request<unknown>("/estimate-skeleton", { method: "POST", body: JSON.stringify(body) }),
      "estimate-skeleton",
    )
    return { keypoints: res.keypoints, usage: res.usage }
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
