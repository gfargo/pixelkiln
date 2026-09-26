import { z } from "zod"
import type { SkeletonSet } from "./skeleton.ts"

const MediaTypeSchema = z.enum(["image/png", "image/gif"])

/**
 * Which provider capability produces the asset. The choice is mostly about cost,
 * and the gap is enormous. All figures were measured against a live account.
 *
 *   map   POST /map-objects. THE DEFAULT.
 *         A flat 1 generation at any size. Purpose-built for standalone props
 *         with transparent backgrounds, which is what an icon or a prop is.
 *         Arbitrary width x height. Returns exactly one result, so there is no
 *         selection step: if you dislike it, re-roll for 1 more.
 *
 *   1dir  POST /create-1-direction-object. 20-40 generations.
 *         The single-facing sibling of create-8-direction-object, meant for
 *         objects you may later want rotations or animations of. Square only.
 *         Returns 4-64 candidates for its one fixed price, which is genuinely
 *         useful when you want to compare options side by side, but at 40x the
 *         cost of a map object, re-rolling a map object forty times is the same
 *         money. Reach for this when you need rotations, or when the extra
 *         rendering detail is worth 40x.
 *
 * Rule of thumb: if the asset is a standalone image and you are not going to
 * animate or rotate it, `map` is the right call. Generating 65 icons costs 65
 * generations that way and 2,600 the other.
 *
 * Not yet implemented, but measured and worth knowing (see README):
 *   POST /create-image-pixflux also costs 1 generation, returns the image
 *   INLINE with no polling, and accepts `color_image`, a forced palette that
 *   constrains output to exact hex values. Verified: a four-colour Game Boy
 *   swatch produced output containing precisely those four colours. The same
 *   parameter on /map-objects returns a 500, so the palette lock is
 *   pixflux-only. Its rendering is flatter than 1dir's.
 */
export const GeneratorSchema = z.enum(["1dir", "map", "pixflux", "tiles", "animation", "frames", "character", "terrain", "imagePro", "isometricTile", "objectPro", "uiAsset", "uiElement"])
export type Generator = z.infer<typeof GeneratorSchema>

export const GridConfidenceSchema = z.enum(["low", "medium", "high"])
export type GridConfidence = z.infer<typeof GridConfidenceSchema>

export const RevisionModeSchema = z.enum([
  "image-to-image", "inpaint", "outpaint", "reduce-colors", "correct-pixelart", "animate", "animate-pixminimax",
  "animate-skeleton", "interpolate", "edit-animation",
])
export type RevisionMode = z.infer<typeof RevisionModeSchema>

/** A decoded style reference ready for a provider-specific request body. */
export interface ResolvedStyleImage {
  base64: string
  width: number
  height: number
  format: "png" | "jpeg"
}

/**
 * `tiles` is the odd one out: the unit of work is a *set*, not a sprite.
 *
 * POST /create-tiles-pro draws tile shape outlines and fills them, returning
 * many variations from one call. Independent variations land in the same
 * review-then-pick flow as `1dir`; connectable features are structural sets
 * and every returned storage URL is retained. There is no select-frames step
 * to run for either form.
 *
 * Two properties make it worth a generator of its own rather than a flag on
 * `1dir`:
 *
 *   - **Style mode overrides geometry.** Passing `styleImages` makes the API
 *     copy tile shape and dimensions from the reference and ignore
 *     `tileType`/`tileView` entirely. For an existing tileset that is the
 *     point: it is the only way to land new art on the same ground plane as
 *     the tiles already in the sheet.
 *   - **`tileFeature` generates connectable sets.** `"tileset"` returns a
 *     16-tile Wang corner set for a terrain transition, `"roads"` an
 *     18-configuration path set. Those are structural outputs; a consumer
 *     slices them by index, not by eye.
 */

/**
 * Variations a `tiles` call returns. The API derives this from the tile size
 * and how many numbered descriptions the prompt contains; observed at 4 per
 * numbered description for 32px isometric tiles. Clamped so a prompt with no
 * numbering still reports at least one.
 */
export function tileVariationCount(descriptions: number): number {
  return Math.max(1, descriptions) * 4
}

/** Known structural output counts for connectable tile features. */
export function tileFeatureOutputCount(feature: string | undefined): number | null {
  if (feature === "roads") return 18
  if (feature === "tileset") return 16
  // PixelLab does not document a stable count for the building kit. Its
  // returned storage URLs remain authoritative at download time.
  return null
}

/**
 * Numbered items in a `tiles` prompt. The endpoint documents `"1). grass
 * 2). dirt"` as the way to control what comes back, and returns a group of
 * variations per number.
 */
export function countNumberedDescriptions(prompt: string): number {
  return (prompt.match(/\d+\s*\)\s*\./g) ?? []).length
}

/** Candidate frames returned per call, derived from size. Extra candidates are free. */
export function candidateCount(size: number): number {
  if (size <= 42) return 64
  if (size <= 85) return 16
  if (size <= 170) return 4
  return 1
}

/**
 * Generation cost per call. Measured against a live account, not inferred.
 *
 * The two generators are priced completely differently, and the gap is wide
 * enough to change which one you should reach for:
 *
 *   map   FLAT 1 generation, any size. Verified: a 32x36 and a 64x96 map object
 *         each cost exactly 1 (balance 4751 → 4750 → 4749). Single result.
 *
 *   1dir  20-40 by canvas tier (1K=20, 2K=25, 4K=40), returning 4-64
 *         candidates for that one price.
 *
 *   tiles 20-40 on the same canvas tiers as `1dir`, but the canvas is picked
 *         from tile size x variation count rather than a single sprite, so a
 *         small tile in a large set can still reach the top tier. Reported by
 *         the API at submit time; estimated here from the widest canvas the
 *         request can produce, which is the honest direction to be wrong in
 *         for a `--budget` check.
 *
 *   imagePro FLAT 40 generations, any size or aspect ratio, regardless of
 *         canvas tier (docs/ENDPOINTS.md, "Single-image generators,
 *         measured"). `/generate-image-v2`, the Pro image tier: unlike
 *         `pixflux`, it reaches non-square canvases up to 792x688 and does
 *         real style transfer, at a flat price rather than one that scales
 *         with area the way `1dir`/`tiles` do.
 *
 *   uiAsset Confirmed live at one data point, and it disproved the borrowed
 *         formula: a real 256x192 (49152px²) call billed exactly 20
 *         generations (balance 4979.8 → 4959.8), the low end of the
 *         `create_ui_asset` MCP tool's "20-40 generations" claim. No
 *         dedicated branch exists here, so it still falls through to the
 *         same canvas-tier formula as `1dir`/`tiles` below, which — given
 *         uiAsset's 192px-per-side floor (36864px²) already past the
 *         2048px² top tier — always predicts the 40 ceiling. That
 *         prediction is now known wrong: 49152px² sits well above where
 *         `1dir`/`tiles` would bill 40, yet this billed the floor price.
 *         Left unpatched from one data point, which keeps `--budget` an
 *         over-read rather than a guess in the other direction, but a real
 *         call likely costs about half of what this reports.
 *
 *   uiElement UNVERIFIED. `/generate-ui-v2` ("Generate UI (Pro)") carries no
 *         usage example in its schema and has not been called live. It falls
 *         through to the same canvas tiers as `1dir`/`tiles`, the safe
 *         over-read for a Pro endpoint.
 *
 * So `1dir` buys candidate variety at 20-40x the price, and `map` buys
 * arbitrary (non-square) dimensions nearly free. For a single-result asset,
 * forty re-rolls of a map object cost the same as one 1dir call.
 */
export function generationCost(
  width: number,
  height: number,
  generator: Generator = "map",
): number {
  if (generator === "map" || generator === "pixflux") return 1
  if (generator === "imagePro") return 40
  const px = width * height
  if (px <= 1024) return 20
  if (px <= 2048) return 25
  return 40
}

/**
 * Cost of one `tiles` call. Same canvas tiers as `1dir`, but the canvas is the
 * sheet the API lays the variations out on, not one tile, so tile size alone
 * under-reads it badly (a 32px tile is 1024px on its own and would always
 * price at the floor).
 *
 * Estimated from tileSize^2 x variations, which is the area actually drawn.
 * `plan` prints this before anything is spent and `--budget` refuses on it, so
 * over-reading is the safe direction: a call that comes in cheaper than
 * budgeted is a pleasant surprise, one that comes in dearer is an overspend.
 */
export function tilesCost(tileSize: number, variations: number): number {
  const px = tileSize * tileSize * Math.max(1, variations)
  if (px <= 1024) return 20
  if (px <= 2048) return 25
  return 40
}

/**
 * Cost of one `/create-isometric-tile` call, in generations. PixelLab's own
 * OpenAPI response schema example is `{ type: "usd", usd: 0.02 }`, which
 * reads as billing in real dollars rather than subscription generations —
 * but a real call against a live subscription account (Tier 2, "generations"
 * balance) billed exactly 1 generation, matching `usage: { type:
 * "generations", generations: 1 }`, not the documented "usd" shape at all.
 * Treated here the same as `map`/`pixflux`: flat 1 regardless of canvas or
 * tile size. Only one size/shape combination (32px canvas, "block") has
 * actually been measured; the API's own docs give no size-tiering formula
 * for this endpoint the way they do for `1dir`/`tiles`, so this assumes flat
 * pricing across the 16-64px range rather than guessing a tier.
 */
export function isometricTileCost(): number {
  return 1
}

/**
 * Tiles returned by one `/create-tileset` call: 16 for a standard Wang
 * corner set, or 25 when `transitionSize` is exactly 1.0 (the cliff layout,
 * which adds a third "transition" corner value). `shapeStyle` accepts any
 * transitionSize and switches to an extended 32-tile layout above 0.5, which
 * this adapter does not model; `validate()` rejects that combination rather
 * than under-count it here.
 */
export function terrainTileCount(transitionSize: number | undefined): number {
  return transitionSize === 1 ? 25 : 16
}

/**
 * `/create-tileset` takes `lower_description` and `upper_description` (and
 * an optional `transition_description`) as separate fields, unlike `tiles`'s
 * single `description` that the API itself splits by number. So a `terrain`
 * asset's prompt is parsed client-side using the same numbered convention
 * `tiles` already asks for: "1). deep ocean water 2). golden sand 3). wet
 * sand with foam". Returns null when fewer than two numbered groups are
 * found, which the caller turns into a manifest-time error.
 */
export function parseTerrainDescriptions(
  prompt: string,
): { lower: string; upper: string; transition?: string } | null {
  const parts = prompt
    .split(/\d+\s*\)\s*\./)
    .map((part) => part.trim())
    .filter(Boolean)
  if (parts.length < 2) return null
  return { lower: parts[0]!, upper: parts[1]!, transition: parts[2] }
}

const StyleImageSchema = z.object({
  /** Path to a PNG/JPEG, relative to the manifest; the active provider validates limits. */
  path: z.string(),
})

const HexColorSchema = z.string().regex(/^#?[0-9a-f]{6}$/i, "expected a six-digit hex colour")

/** Required derived-art policy for one style's single-image outputs. */
const QualityProfileObjectSchema = z
  .object({
    /** Output root for approved refined art, relative to the manifest. */
    outDir: z.string().min(1),
    /** Closed final palette applied after native-grid recovery, without dithering. */
    palette: z.array(HexColorSchema).min(2).max(256),
    /** Minimum Pixel Art Fixer detector confidence accepted by the mechanical gate. */
    minGridConfidence: GridConfidenceSchema.default("high"),
    /** Optional alpha requirement for isolated assets. */
    minTransparency: z.number().min(0).max(1).optional(),
    /** Pixel Art Fixer revision written into the quality record. */
    fixerRevision: z.string().min(1).optional(),
    /** Python executable containing Pixel Art Fixer, relative to the manifest unless absolute. */
    fixerPython: z.string().min(1).optional(),
    /** Playback rate recorded for an ordered frame set. */
    fps: z.number().int().min(1).max(60).optional(),
  })
  .strict()

export const QualityProfileSchema = QualityProfileObjectSchema
  .refine(
    (profile) =>
      new Set(profile.palette.map((color) => color.replace(/^#/, "").toLowerCase())).size ===
      profile.palette.length,
    { message: "quality palette colors must be unique", path: ["palette"] },
  )

export type QualityProfile = z.infer<typeof QualityProfileSchema>

export interface ResolvedQualityProfile {
  outFile: string
  palette: string[]
  minGridConfidence: GridConfidence
  minTransparency?: number
  fixerRevision?: string
  /** Absolute local executable path resolved from the manifest. */
  fixerPython?: string
  fps?: number
}

/**
 * PixelLab characters: one `character` generator, three asset shapes that
 * share a PixelLab character behind the scenes.
 *
 * A base character is a prompt; PixelLab draws it facing 4 or 8 directions.
 * A state is a text edit of an existing character (a pose, an outfit) that
 * PixelLab applies to every direction at once and stores as a sibling
 * character. An animation is a short loop of one character in one
 * direction. States and animations depend on their parent the way a
 * revision does: the parent must be downloaded and current before the child
 * can be submitted, and regenerating the parent makes the child stale.
 */
export const CharacterDirectionSchema = z.enum([
  "south", "south-east", "east", "north-east", "north", "north-west", "west", "south-west",
])
export type CharacterDirection = z.infer<typeof CharacterDirectionSchema>

/** Output order for a base or state: clockwise from south. */
export const CHARACTER_DIRECTIONS_8: readonly CharacterDirection[] = [
  "south", "south-east", "east", "north-east", "north", "north-west", "west", "south-west",
]
/** PixelLab's 4-direction set. South first, so the primary file is the same either way. */
export const CHARACTER_DIRECTIONS_4: readonly CharacterDirection[] = ["south", "west", "east", "north"]

/**
 * The direction a sprite faces after a left-to-right flip. South and north
 * map onto themselves, which is why a mirror of either is refused: it would
 * be the same direction with its asymmetries swapped, not a new one.
 */
export const MIRRORED_DIRECTION: Readonly<Record<CharacterDirection, CharacterDirection>> = {
  south: "south",
  "south-east": "south-west",
  east: "west",
  "north-east": "north-west",
  north: "north",
  "north-west": "north-east",
  west: "east",
  "south-west": "south-east",
}

export const CharacterModeSchema = z.enum(["standard", "v3", "pro", "pro-flash"])
export type CharacterMode = z.infer<typeof CharacterModeSchema>

export const CHARACTER_PROPORTION_PRESETS = ["default", "chibi", "cartoon", "stylized", "realistic_male", "realistic_female", "heroic"] as const
/**
 * Body proportions for a `standard` humanoid base: one of PixelLab's presets,
 * or multipliers on the mannequin (0.5 to 2; PixelLab recommends heads no
 * larger than 1.7). Quadruped templates and the v3 and pro engines have no
 * proportions to set.
 */
export const CharacterProportionsSchema = z.union([
  z.enum(CHARACTER_PROPORTION_PRESETS),
  z
    .object({
      headSize: z.number().min(0.5).max(2).optional(),
      armsLength: z.number().min(0.5).max(2).optional(),
      legsLength: z.number().min(0.5).max(2).optional(),
      shoulderWidth: z.number().min(0.5).max(2).optional(),
      hipWidth: z.number().min(0.5).max(2).optional(),
    })
    .strict(),
])
export type CharacterProportions = z.infer<typeof CharacterProportionsSchema>
export const CharacterAnimationModeSchema = z.enum(["template", "v3", "pro"])
export type CharacterAnimationMode = z.infer<typeof CharacterAnimationModeSchema>

/**
 * A `uiAsset` panel's shape template: precise, labelled regions on a virtual
 * editor canvas (longer side 0–512, shorter side scaled to the output
 * aspect — the coordinate space, not the output pixel size) that
 * `/create-ui-asset` composites into one panel image. Omit entirely for a
 * default full-canvas rounded-rect panel.
 */
export const UiPieceSchema = z.discriminatedUnion("kind", [
  z
    .object({
      id: z.string().min(1),
      kind: z.literal("rounded_rect"),
      label: z.string().optional(),
      x: z.number(),
      y: z.number(),
      w: z.number(),
      h: z.number(),
      radius: z.number().min(0).optional(),
    })
    .strict(),
  z
    .object({
      id: z.string().min(1),
      kind: z.literal("circle"),
      label: z.string().optional(),
      x: z.number(),
      y: z.number(),
      r: z.number(),
    })
    .strict(),
  z
    .object({
      id: z.string().min(1),
      kind: z.literal("polygon"),
      label: z.string().optional(),
      x: z.number(),
      y: z.number(),
      r: z.number(),
      sides: z.number().int().min(3),
      phase: z.number().optional(),
    })
    .strict(),
])
export type UiPiece = z.infer<typeof UiPieceSchema>

/**
 * A `uiAsset` panel's named element scaffolds — auto-positioned, no
 * coordinates needed. Combine with `pieces` for a mix of precise and named
 * shapes; omit both for a default full-canvas panel.
 */
export const UiElementSchema = z.enum([
  "button", "icon_button", "toolbar", "tab", "panel", "window",
  "health_bar", "avatar", "triangle", "pentagon", "hexagon", "octagon",
])
export type UiElement = z.infer<typeof UiElementSchema>

/**
 * A member of a `1dir` batch: `/create-1-direction-object`'s
 * `item_descriptions` field asks for several *distinct* described objects
 * in one call instead of several candidates of the same one. The leader is
 * an ordinary `1dir` asset (its own `prompt` is `item_descriptions[0]`);
 * each member names the leader and its 1-based slot in the batch.
 */
export const AssetBatchSchema = z
  .object({
    /** The batch leader: another `1dir` asset in the same style. */
    of: z.string().min(1),
    /** 1-based slot in the batch (the leader is implicitly slot 0). Unique and contiguous among siblings. */
    index: z.number().int().min(1),
  })
  .strict()
export type AssetBatch = z.infer<typeof AssetBatchSchema>

/** A pose or outfit of an existing character, applied to every direction. */
export const CharacterStateSchema = z
  .object({
    /** The base character, or another state, in the same style. */
    of: z.string().min(1),
    /** Snap the edited rotations to the parent's colours. Off when the edit adds colours. */
    paletteFromReference: z.boolean().default(false),
    /** A larger canvas when the edit adds something big. Multiples of 4, no smaller than the parent. */
    canvas: z
      .object({
        width: z.number().int().min(16).max(256),
        height: z.number().int().min(16).max(256),
      })
      .strict()
      .optional(),
  })
  .strict()
export type CharacterState = z.infer<typeof CharacterStateSchema>

/** PixelLab's fixed `portrait-character-pro` result sizes; 128 and 160 render at 2K and cost more. */
export const CharacterPortraitSizeSchema = z.union([
  z.literal(16),
  z.literal(32),
  z.literal(48),
  z.literal(64),
  z.literal(128),
  z.literal(160),
])
export type CharacterPortraitSize = z.infer<typeof CharacterPortraitSizeSchema>

/** A bust portrait of an existing base or state's south sprite. */
export const CharacterPortraitSchema = z
  .object({
    /** The base or state to portray, in the same style. */
    of: z.string().min(1),
    size: CharacterPortraitSizeSchema.default(64),
  })
  .strict()
export type CharacterPortrait = z.infer<typeof CharacterPortraitSchema>

/** Applies a reference outfit to an existing loop's frames (PixelLab's `transfer-outfit-v2`). */
export const CharacterOutfitSchema = z
  .object({
    /** The loop (a character animation asset) to re-clothe, in the same style. */
    of: z.string().min(1),
    /** Manifest-relative image of the outfit to transfer. */
    reference: z.string().min(1),
    /** Extra guidance PixelLab passes through as written, e.g. view/direction hints. */
    additionalInstructions: z.string().max(2000).optional(),
  })
  .strict()
export type CharacterOutfit = z.infer<typeof CharacterOutfitSchema>

/** A loop of one character in one direction. One asset per direction. */
export const CharacterAnimationSchema = z
  .object({
    /** The character to animate: a base or a state in the same style. */
    of: z.string().min(1),
    /** A PixelLab template id (`walk`, `breathing-idle`, ...). Costs 1 generation; frame count is the template's. */
    template: z.string().min(1).optional(),
    /** Direction to animate. */
    direction: CharacterDirectionSchema.default("south"),
    /**
     * Shorthand for one loop in several directions, instead of `direction`.
     * Expanded when the manifest loads into one loop per named direction
     * (`<id>.<direction>`) plus a mirror for each direction whose flip is
     * not named, exactly as if each had been written out. See
     * `src/loop-directions.ts`.
     */
    directions: z.array(CharacterDirectionSchema).min(1).optional(),
    /** Frames to generate without a template (v3). Even, 4 to 16. */
    frames: z.number().int().min(4).max(16).optional(),
    /** Playback rate recorded with the frames; PixelLab does not store one. */
    fps: z.number().int().min(1).max(60).default(8),
    /** v3 only: keep the resting pose as frame 0, so `frames` generated frames land as `frames + 1` files. */
    keepFirstFrame: z.boolean().default(true),
    /** `template` when a template is named, otherwise `v3`; `pro` for the sequential high-quality engine. */
    mode: CharacterAnimationModeSchema.optional(),
    /**
     * v3 only: a manifest-relative image of the pose to start from, instead
     * of the character's rotation for this direction. Up to 256px.
     */
    startFrame: z.string().min(1).optional(),
    /**
     * v3 only: a pose to animate toward. The loop then interpolates from the
     * start frame (the rotation, or `startFrame`) to this image, which must
     * be the same size as the start frame.
     */
    endFrame: z.string().min(1).optional(),
    /** What is being animated, when the character's own description would mislead the model. */
    subject: z.string().min(1).optional(),
    /** Template mode only: style hints for this loop, over the character's own. */
    outline: z.string().min(1).optional(),
    shading: z.string().min(1).optional(),
    detail: z.string().min(1).optional(),
    /** v3 text loops only: let PixelLab expand the action into a fuller motion description first. */
    enhancePrompt: z.boolean().optional(),
  })
  .strict()
  .superRefine((animation, context) => {
    if (animation.directions !== undefined) {
      // Only reachable when a manifest is validated without being loaded
      // (loading expands the shorthand before validation ever sees it).
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "directions is expanded when the manifest loads; validate the loaded manifest, not the raw file",
        path: ["directions"],
      })
    }
    if (animation.frames !== undefined && animation.frames % 2 !== 0) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: "frames must be even", path: ["frames"] })
    }
    const mode = animation.mode ?? (animation.template ? "template" : "v3")
    for (const key of ["startFrame", "endFrame", "enhancePrompt"] as const) {
      if (animation[key] !== undefined && mode !== "v3") {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: `${key} is for v3 loops; a ${mode} loop ${mode === "template" ? "starts from the character's rotation and follows its template" : "takes neither"}`,
          path: [key],
        })
      }
    }
    for (const key of ["outline", "shading", "detail"] as const) {
      if (animation[key] !== undefined && mode !== "template") {
        context.addIssue({ code: z.ZodIssueCode.custom, message: `${key} overrides apply to template loops only`, path: [key] })
      }
    }
    if (animation.template && animation.mode && animation.mode !== "template") {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: `a template animation cannot use mode "${animation.mode}"`,
        path: ["mode"],
      })
    }
    if (animation.template && animation.frames !== undefined) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "a template decides its own frame count; drop frames",
        path: ["frames"],
      })
    }
    if (!animation.template && animation.mode === "template") {
      context.addIssue({ code: z.ZodIssueCode.custom, message: "template mode needs a template", path: ["template"] })
    }
  })
export type CharacterAnimation = z.infer<typeof CharacterAnimationSchema>

/** One of a base's reference sprites, read when the manifest is resolved; its hash is part of the spec's identity. */
export interface ResolvedReferenceImage {
  /** Absolute path. */
  path: string
  sha256: string
  width: number
  height: number
  format: "png" | "jpeg"
}

/** A pro base's style anchor: another character in the style, resolved so its identity and readiness can be checked. */
export interface ResolvedStyleAnchor {
  assetId: string
  spec: ResolvedSpec
  /** The anchor's south-facing generated file, and its hash when it exists. A change makes this spec stale. */
  file: string
  sha256: string | null
}

/** How a resolved spec describes its place in a character family. */
export interface ResolvedCharacter {
  kind: "base" | "state" | "animation" | "portrait" | "outfit"
  /** Creation engine for a base; states inherit the parent's. */
  mode: CharacterMode
  /** Rotations a base or state has. */
  directions: 4 | 8
  /** PixelLab body template: `mannequin`, or a quadruped such as `cat`. */
  template: string
  /** `standard` humanoid bases only. */
  proportions?: CharacterProportions
  /** `standard` bases and template loops. */
  textGuidanceScale?: number
  /** `standard` bases and every loop. */
  isometric?: boolean
  /** `v3` bases. */
  enhancePrompt?: boolean
  /** `pro-flash` bases with a style image: the traits it lends. */
  styleTraits?: { palette?: boolean; outline?: boolean; detail?: boolean; shading?: boolean }
  /** A base drawn by rotating the author's own sprite(s), keyed by the direction each shows. */
  reference?: Partial<Record<CharacterDirection, ResolvedReferenceImage>>
  /** `pro` bases: a concept image the design is seeded from. */
  concept?: ResolvedReferenceImage
  /** `pro` bases: the generated character in this style whose look this one follows. */
  styleAnchor?: ResolvedStyleAnchor
  /** For a state or animation: the parent asset in the same style. */
  parentAssetId?: string
  parentSpec?: ResolvedSpec
  /** The parent's south-facing generated file, and its hash when it exists. A change makes this spec stale. */
  parentFile?: string
  parentSha256?: string | null
  state?: {
    paletteFromReference: boolean
    canvas?: { width: number; height: number }
  }
  portrait?: {
    size: CharacterPortraitSize
  }
  /** For an outfit: the reference image to transfer, and any extra guidance. */
  outfit?: {
    reference: ResolvedReferenceImage
    additionalInstructions?: string
  }
  animation?: {
    mode: CharacterAnimationMode
    template?: string
    direction: CharacterDirection
    /** Frames asked for; a template ignores it. */
    frames: number
    fps: number
    keepFirstFrame: boolean
    /** v3: the pose to start from, and the pose to reach. */
    startFrame?: ResolvedReferenceImage
    endFrame?: ResolvedReferenceImage
    subject?: string
    /** Template mode: this loop's style hints. */
    outline?: string
    shading?: string
    detail?: string
    enhancePrompt?: boolean
  }
}

/**
 * The resolved shape of an `objectPro` asset: PixelLab's non-skeleton
 * `/create-object-pro-flash` entity family. Deliberately reuses
 * `CharacterState`/`CharacterAnimation`'s authoring schema (`AssetSchema.state`/
 * `.animation`) rather than inventing a parallel one, since an object's state
 * is a strict subset of a character's (no `paletteFromReference`/`canvas`
 * equivalent on the API) and its animation drops only the template/skeleton
 * concept objects have none of — `template`/`subject`/`outline`/`shading`/
 * `detail` on an `objectPro` animation are rejected at resolution time
 * instead of silently ignored.
 */
export interface ResolvedObjectPro {
  kind: "base" | "state" | "animation"
  /** Rotations a base or state has: 1, or the full 8. */
  directions: 1 | 8
  /** A base drawn by rotating the author's own south-facing sprite instead of the prompt. */
  reference?: ResolvedReferenceImage
  /** A style-image base only: the traits it lends. */
  styleTraits?: { palette?: boolean; outline?: boolean; detail?: boolean; shading?: boolean }
  /** For a state or animation: the parent asset in the same style. */
  parentAssetId?: string
  parentSpec?: ResolvedSpec
  /** The parent's south-facing generated file, and its hash when it exists. A change makes this spec stale. */
  parentFile?: string
  parentSha256?: string | null
  state?: NonNullable<ResolvedCharacter["state"]>
  animation?: NonNullable<ResolvedCharacter["animation"]>
}

/** A provider generation whose visual starting point is another manifest asset. */
export const RevisionDitheringSchema = z.enum(["none", "2x2", "4x4", "8x8"])
export type RevisionDithering = z.infer<typeof RevisionDitheringSchema>

export const RevisionSchema = z
  .object({
    /** What kind of controlled change the provider workflow performs. */
    mode: RevisionModeSchema,
    /** Parent asset id in the same style. */
    from: z.string().min(1),
    /** Manifest-relative black/white PNG. Required only for masked inpainting. */
    mask: z.string().min(1).optional(),
    /** Provider-neutral edit strength. The active adapter must bind it explicitly. */
    strength: z.number().min(0).max(1).optional(),
    /** `reduce-colors` only: target color count. Mutually exclusive with `paletteImage`. */
    numColors: z.number().int().min(2).max(256).optional(),
    /** `reduce-colors` only: manifest-relative image whose colors become the palette. Mutually exclusive with `numColors`. */
    paletteImage: z.string().min(1).optional(),
    /** `reduce-colors` only: ordered dithering matrix size. */
    dithering: RevisionDitheringSchema.optional(),
    /** `reduce-colors` only: dithering intensity; ignored when `dithering` is "none" or unset. */
    ditheringStrength: z.number().min(0).max(10).optional(),
    /**
     * `animate`/`animate-pixminimax` only: frames to generate, even, 4 to 40
     * (the provider-specific ceiling — 16 for `animate` — is enforced at
     * the provider layer, since it differs by mode).
     */
    frames: z.number().int().min(4).max(40).optional(),
    /** `animate`/`animate-pixminimax`/`interpolate`/`edit-animation` only: playback rate recorded with the frames; PixelLab does not store one. */
    fps: z.number().int().min(1).max(60).optional(),
    /**
     * `animate`/`animate-pixminimax`: manifest-relative image pinning where
     * the motion ends (interpolation instead of open-ended animation).
     * `interpolate`: required, the ending keyframe; the parent is the start.
     */
    lastFrame: z.string().min(1).optional(),
    /** `animate-pixminimax` only: facing direction, used only alongside `enhancePrompt` to hold the sprite's facing. */
    direction: CharacterDirectionSchema.optional(),
    /** `animate`/`animate-pixminimax` only: let PixelLab expand the action into a fuller motion description first. */
    enhancePrompt: z.boolean().optional(),
    /**
     * `animate-skeleton` only: manifest-relative path to a committed
     * `SkeletonSet` JSON file (see `src/skeleton.ts`) — the pose the parent
     * image is already in, plus 3-15 per-frame poses for the motion.
     * Authored via `pixelkiln estimate-skeleton`, then hand-tweaked; never
     * inline in the manifest, the same reasoning `mask`/`lastFrame` are
     * committed files rather than inline pixel data.
     */
    keypointsFile: z.string().min(1).optional(),
    /**
     * `animate-skeleton` only: the body a joint's missing `depth` is taken
     * from. PixelLab's default is `mannequin`; free string like `character`'s
     * own `template` field, validated at the provider layer against the
     * same `mannequin`/`bear`/`cat`/`dog`/`horse`/`lion` vocabulary.
     */
    skeletonTemplate: z.string().min(1).optional(),
    /**
     * `animate-skeleton` only: what the character *looks like*, a noun
     * phrase (colours, clothing, held items) — distinct from the asset's
     * own `prompt`, which this mode sends as the motion's short label
     * (PixelLab's `action`), the same `prompt`-as-motion convention
     * `animate`/`animate-pixminimax` already use.
     */
    description: z.string().min(1).optional(),
  })
  .strict()
  .superRefine((revision, context) => {
    if (revision.mode === "inpaint" && !revision.mask) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "inpaint revisions require a mask",
        path: ["mask"],
      })
    }
    if (revision.mode !== "inpaint" && revision.mask) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: `${revision.mode} revisions do not accept a mask`,
        path: ["mask"],
      })
    }
    if (revision.numColors !== undefined && revision.paletteImage !== undefined) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "numColors and paletteImage are mutually exclusive",
        path: ["numColors"],
      })
    }
    for (const field of ["numColors", "paletteImage", "dithering", "ditheringStrength"] as const) {
      if (revision[field] !== undefined && revision.mode !== "reduce-colors") {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: `${field} applies to reduce-colors revisions only`,
          path: [field],
        })
      }
    }
    if (revision.strength !== undefined && revision.mode === "reduce-colors") {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "reduce-colors revisions do not take a strength; use dithering/ditheringStrength",
        path: ["strength"],
      })
    }
    const generative = revision.mode === "animate" || revision.mode === "animate-pixminimax" ||
      revision.mode === "interpolate" || revision.mode === "edit-animation"
    if (revision.strength !== undefined && generative) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: revision.mode === "animate" || revision.mode === "animate-pixminimax"
          ? `${revision.mode} revisions do not take a strength; use enhancePrompt`
          : `${revision.mode} revisions do not take a strength`,
        path: ["strength"],
      })
    }
    for (const field of ["frames", "enhancePrompt"] as const) {
      if (revision[field] !== undefined && revision.mode !== "animate" && revision.mode !== "animate-pixminimax") {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: `${field} applies to animate/animate-pixminimax revisions only`,
          path: [field],
        })
      }
    }
    if (revision.lastFrame !== undefined && revision.mode !== "animate" && revision.mode !== "animate-pixminimax" && revision.mode !== "interpolate") {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "lastFrame applies to animate/animate-pixminimax/interpolate revisions only",
        path: ["lastFrame"],
      })
    }
    if (revision.mode === "interpolate" && revision.lastFrame === undefined) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "interpolate revisions require lastFrame: the ending keyframe to interpolate toward",
        path: ["lastFrame"],
      })
    }
    if (revision.fps !== undefined && !generative) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "fps applies to animate/animate-pixminimax/interpolate/edit-animation revisions only",
        path: ["fps"],
      })
    }
    if (revision.direction !== undefined && revision.mode !== "animate-pixminimax" && revision.mode !== "animate-skeleton") {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "direction applies to animate-pixminimax/animate-skeleton revisions only",
        path: ["direction"],
      })
    }
    if (revision.mode === "animate-skeleton" && revision.direction === undefined) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "animate-skeleton revisions require a direction",
        path: ["direction"],
      })
    }
    if (revision.frames !== undefined && revision.frames % 2 !== 0) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: "frames must be even", path: ["frames"] })
    }
    if (revision.mode === "animate-skeleton" && !revision.keypointsFile) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "animate-skeleton revisions require keypointsFile",
        path: ["keypointsFile"],
      })
    }
    for (const field of ["keypointsFile", "skeletonTemplate", "description"] as const) {
      if (revision[field] !== undefined && revision.mode !== "animate-skeleton") {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: `${field} applies to animate-skeleton revisions only`,
          path: [field],
        })
      }
    }
  })

export type Revision = z.infer<typeof RevisionSchema>

/** Modes whose output is an ordered frame set rather than one image. */
export const FRAME_SET_REVISION_MODES: readonly RevisionMode[] = ["animate", "animate-pixminimax", "animate-skeleton", "interpolate", "edit-animation"]

/**
 * Modes that can read a whole member set from their parent (a character's
 * directions, an animation's frames) in one call, rather than one image.
 * `edit-animation` needs one; the two Cleanup-tier modes process a set
 * together so every member lands on one shared palette or cleanup pass.
 */
export const MEMBER_SET_REVISION_MODES: readonly RevisionMode[] = ["reduce-colors", "correct-pixelart", "edit-animation"]

/** One file of a revision parent that is a member set rather than a single image. */
export interface ResolvedRevisionMember {
  /** The output role it was written under: a direction or `frame-NN`. */
  role: string
  file: string
  sha256: string
  width: number
  height: number
  format: "png" | "jpeg"
}

/** Resolved immutable inputs supplied to a revision-capable provider. */
export interface ResolvedRevision {
  mode: RevisionMode
  sourceAssetId: string
  /** Absolute path selected from the parent asset's approved/final output. */
  sourceFile: string
  /** Null keeps planning possible while the parent is not ready. */
  sourceSha256: string | null
  sourceWidth: number | null
  sourceHeight: number | null
  sourceFormat: "png" | "jpeg" | null
  /** Full parent intent used to prove the dependency is current before spending. */
  sourceSpec: ResolvedSpec
  /**
   * Present when the parent is a member set (`<stem>-south.png`, ...,
   * or `<stem>-frame-00.png`, ...) instead of one file. `sourceFile` and
   * the size fields then describe the first member, and `sourceSha256`
   * is a hash over every member's hash in order, the same formula a
   * mirror records over its source's outputs.
   */
  sourceMembers?: ResolvedRevisionMember[]
  /** A frame-set parent's playback rate, carried onto a set-to-set revision's frames. */
  sourceFps?: number
  maskFile?: string
  maskSha256?: string | null
  maskWidth?: number | null
  maskHeight?: number | null
  maskFormat?: "png" | "jpeg" | null
  strength?: number
  numColors?: number
  paletteImageFile?: string
  paletteImageSha256?: string | null
  paletteImageWidth?: number | null
  paletteImageHeight?: number | null
  paletteImageFormat?: "png" | "jpeg" | null
  dithering?: RevisionDithering
  ditheringStrength?: number
  frames?: number
  fps?: number
  lastFrameFile?: string
  lastFrameSha256?: string | null
  lastFrameWidth?: number | null
  lastFrameHeight?: number | null
  lastFrameFormat?: "png" | "jpeg" | null
  direction?: CharacterDirection
  enhancePrompt?: boolean
  keypointsFile?: string
  /** Null keeps planning possible before the keypoints file is authored. */
  keypointsSha256?: string | null
  skeleton?: SkeletonSet | null
  skeletonTemplate?: string
  description?: string
}

const StyleObjectSchema = z
  .object({
    /** Generation backend for this style. Omit to inherit the manifest default. */
    provider: z.string().min(1).optional(),
    // `map` is the default because it is 20-40x cheaper and correct for any
    // asset that is not going to be rotated or animated.
    generator: GeneratorSchema.default("map"),
    /** Square edge length. The active provider owns its exact limit. */
    size: z.number().int().min(16).max(8192).optional(),
    view: z.string().optional(),
    /** Appended to every asset prompt in this style. Where the look is defined. */
    promptSuffix: z.string().default(""),
    /** Prepended to every asset prompt in this style. */
    promptPrefix: z.string().default(""),
    /** Style reference images. */
    styleImages: z.array(StyleImageSchema).default([]),
    /** Output root for this style, relative to the manifest. */
    outDir: z.string(),
    /** `map` generator only. */
    outline: z.string().optional(),
    shading: z.string().optional(),
    detail: z.string().optional(),
    /**
     * `tiles` generator only. Edge length of one tile, 16-128 (the API's own
     * range; connectable sets narrow it further per shape, e.g. square
     * top-down roads are fixed at 32).
     *
     * Ignored when `styleImages` is set: style mode takes the tile's shape
     * and dimensions from the reference image, which is the whole reason to
     * use it against an existing sheet.
     */
    tileSize: z.number().int().min(16).max(128).optional(),
    /** `tiles` generator only. Height in pixels (16-256) for a non-square
     *  tile (e.g. a tall building wall); omit to compute it from `tileType`
     *  geometry and the view angle. */
    tileHeight: z.number().int().min(16).max(256).optional(),
    /** `tiles` generator only. Defaults to the API's `isometric`. */
    tileType: z
      .enum(["hex", "hex_pointy", "isometric", "oblique", "octagon", "square_topdown"])
      .optional(),
    /** `tiles` generator only. Defaults to the API's `low top-down`. */
    tileView: z.enum(["top-down", "high top-down", "low top-down", "side"]).optional(),
    /** `tiles` generator only. Continuous view angle in degrees (0 = side,
     *  90 = top-down), overriding `tileView` when set. */
    tileViewAngle: z.number().min(0).max(90).optional(),
    /** `tiles` generator only. Tile depth/thickness as a ratio (0-1) of the
     *  tile's height, overriding the default the API computes from the
     *  view. This is the tutorials' "thickness" control. */
    tileDepthRatio: z.number().min(0).max(1).optional(),
    /** `tiles` generator only, `tileType: "isometric"`. Top/bottom cap
     *  width in pixels: 2 for the classic look, 4 for a more modern one. */
    tileFlatTopPx: z.number().int().min(2).max(8).optional(),
    /** `tiles` generator only, `tileType: "oblique"` (ground tiles or
     *  building walls). Horizontal shear per pixel of height (0-1); 0.5 is
     *  a classic cabinet projection (~27°), 1.0 a full 45° diagonal. */
    obliqueLean: z.number().min(0).max(1).optional(),
    /**
     * `tiles` generator only. Asks for a connectable set instead of
     * independent variations:
     *
     *   roads    18-configuration path set
     *   tileset  16-tile Wang corner set for a terrain transition. Describe
     *            the asset as the transition itself ("fairway grass to rough
     *            meadow"), not as one terrain
     *   building floor/wall/doorway construction kit
     *
     * A consumer slices these by index, so the order the API returns them in
     * is load-bearing; do not sort a connectable set by anything else.
     */
    tileFeature: z.enum(["roads", "tileset", "building"]).optional(),
    /** `tileFeature: "building"` only. Wall height in tiles (1-3); the API
     *  defaults to 2. */
    buildingWallTiles: z.number().int().min(1).max(3).optional(),
    /** `tileFeature: "building"` only. `"grid"` paints each shaped piece
     *  individually (richer, the isometric default); `"materials"` paints
     *  flat swatches and renders pieces from them (more consistent for
     *  square top-down building kits). */
    buildingLayout: z.enum(["grid", "materials"]).optional(),
    /** `tileFeature: "building"` only. Wall material, e.g. "stone brick
     *  walls" — more reliable than relying on the main `prompt` being split
     *  into wall/floor parts. */
    buildingWallDescription: z.string().min(1).max(500).optional(),
    /** `tileFeature: "building"` only. Floor material, e.g. "wooden plank
     *  floor". */
    buildingFloorDescription: z.string().min(1).max(500).optional(),
    /** `tileFeature: "building"` only. Upper-storey or roof surface;
     *  defaults to the wall material when omitted. */
    buildingFloor2Description: z.string().min(1).max(500).optional(),
    /** `tileFeature: "building"` with `tileType: "square_topdown"` only.
     *  Wall storey height as its own camera angle in degrees (5-90),
     *  decoupled from the ground's pitch. */
    buildingWallAngle: z.number().min(5).max(90).optional(),
    /**
     * `tiles` generator only. How tile edges are drawn.
     *
     * The API default is `outline`, which draws a dark border around every
     * tile. That is right for tiles meant to read as discrete objects and
     * wrong for ground: laid on a grid, the per-tile borders turn a continuous
     * surface into visible quilting, with a dark seam at every cell edge.
     * `segmentation` omits them and the same set tiles seamlessly.
     *
     * Measured on a fairway-to-rough terrain set, where the difference decided
     * whether the art was usable at all, so it is worth setting deliberately
     * rather than inheriting.
     */
    outlineMode: z.enum(["outline", "segmentation"]).optional(),
    /**
     * `terrain` generator only. Edge length of one tile in pixels. 16 or 32
     * work in both modes; 64 needs `terrainMode: "pro"`. The API default is
     * 16. See `parseTerrainDescriptions` for how an asset's `prompt` becomes
     * the lower/upper/transition terrain descriptions this endpoint wants.
     */
    terrainTileSize: z.union([z.literal(16), z.literal(32), z.literal(64)]).optional(),
    /**
     * `terrain` generator only. `standard` is the classic Wang tileset
     * pipeline; `pro` is a newer corner-pair pipeline with its own shape
     * controls (`terrainSpreadX`, `terrainSlopeSize`, `terrainRaggedness`)
     * in place of `terrainShapeStyle`. The API default is `standard`.
     */
    terrainMode: z.enum(["standard", "pro"]).optional(),
    /**
     * `uiAsset` and `uiElement` generators only. A natural-language palette hint sent as-is
     * (e.g. "brown and gold"), distinct from `palette`'s hex-color array —
     * this is a prompt-level steer, not a local quantization target.
     */
    uiColorPalette: z.string().max(200).optional(),
    /**
     * `terrain` generator only, `terrainMode: "standard"`. Procedural
     * boundary geometry: `square` or `round`, 16px or 32px tiles only.
     * Rejected together with `terrainMode: "pro"`, whose own shape controls
     * are `terrainSpreadX`/`terrainSlopeSize`/`terrainRaggedness`.
     */
    terrainShapeStyle: z.enum(["square", "round"]).optional(),
    /** `terrain` generator only, `terrainMode: "pro"`. Boundary spread
     *  between terrains (0 = steep, 1 = gradual). API default 0.5. */
    terrainSpreadX: z.number().min(0).max(1).optional(),
    /** `terrain` generator only, `terrainMode: "pro"`. Slope on the N/W/E
     *  sides as a fraction of wall height. API default 0. */
    terrainSlopeSize: z.number().min(0).max(1).optional(),
    /** `terrain` generator only, `terrainMode: "pro"`. Terrain boundary
     *  noise (0 = smooth, 1 = rough). API default 0. */
    terrainRaggedness: z.number().min(0).max(1).optional(),
    /**
     * `terrain` generator only. Visual height of the step between lower and
     * upper terrain. Without `terrainShapeStyle`, only 0, 0.25, 0.5, or 1 are
     * accepted (1 switches to the 25-tile cliff layout, where corners take a
     * third "transition" value); with it, any value from 0 to 1 works, but
     * above 0.5 switches to an extended 32-tile layout this adapter does not
     * model. API default 0.
     */
    terrainTransitionSize: z.number().min(0).max(1).optional(),
    /** `terrain` generator only. Camera angle; the API default is `high
     *  top-down`. */
    terrainView: z.enum(["low top-down", "high top-down"]).optional(),
    /**
     * `isometricTile` generator only. `/create-isometric-tile`'s own tile
     * grid size, distinct from `size` (the generation canvas, 16-64px — the
     * API's own guidance is that sizes above 24px "often produce better
     * quality results"). The API default is 16.
     */
    isometricTileSize: z.union([z.literal(16), z.literal(32)]).optional(),
    /**
     * `isometricTile` generator only. Vertical thickness, i.e. how much
     * height/elevation variation the tile can represent on a map: `"thin
     * tile"` (~15% of canvas height), `"thick tile"` (~25%), or `"block"`
     * (~50%, the API default).
     */
    isometricTileShape: z.enum(["thin tile", "thick tile", "block"]).optional(),
    /**
     * `objectPro` generator only. Rotations captured for a base: 1 (the API
     * still draws and stores a single facing) or the full 8. The API default
     * is 8. Unlike `character`, `objectPro` has no skeleton/template modes
     * and so no `mode`/`template` fields of its own — `/create-object-pro-flash`
     * is the only base-creation path.
     */
    objectDirections: z.union([z.literal(1), z.literal(8)]).optional(),
    /**
     * `pixflux` only. Whether to strip the generated background.
     *
     * Defaults to true, which is right for the sprites this tool was built
     * for; a prop or an icon wants to sit on whatever is behind it. It is
     * wrong for anything that IS a scene: a cover banner, a splash, a
     * backdrop. The API's own default is false; forcing it true unconditionally
     * meant a full-bleed image came back as a small subject floating in a
     * mostly-empty frame, and prose asking for an "opaque background" does not
     * override it.
     */
    noBackground: z.boolean().default(true),
    /**
     * `character` only. `standard` draws from a skeleton template for 1
     * generation; `v3` is the highest quality at 2 to 9 by size; `pro` is a
     * reference-based engine at 20 to 40 by size; `pro-flash` draws a
     * south sprite with PixelLab's newest image model and rotates it with
     * v3, 6 to 17 by size, or the rotations alone (1 at 64px) from a
     * `reference`. States inherit the parent's engine; animations choose
     * their own.
     */
    mode: CharacterModeSchema.optional(),
    /** `character` only. Rotations per base or state. Every engine but `standard` draws 8. */
    directions: z.union([z.literal(4), z.literal(8)]).optional(),
    /** `character` only. Body template: `mannequin` (default), a quadruped (`bear`, `cat`, `dog`, `horse`, `lion`), or `custom` for `pro-flash`. */
    template: z.string().min(1).optional(),
    /**
     * `character` only, `pro-flash` bases with a style image: which traits
     * the style image lends. Each defaults to true.
     */
    styleTraits: z
      .object({
        palette: z.boolean().optional(),
        outline: z.boolean().optional(),
        detail: z.boolean().optional(),
        shading: z.boolean().optional(),
      })
      .strict()
      .optional(),
    /** `character` only, `standard` humanoid bases. A preset or multipliers; an asset may override it. */
    proportions: CharacterProportionsSchema.optional(),
    /**
     * `character` only. How closely a `standard` base and a template loop
     * follow their text, 1 to 20; PixelLab's default is 8. The v3 and pro
     * engines do not take it.
     */
    textGuidanceScale: z.number().min(1).max(20).optional(),
    /** `character` only. Draw `standard` bases and every loop in isometric view. */
    isometric: z.boolean().optional(),
    /** `character` only, `v3` bases: let PixelLab expand the prompt into a fuller one before drawing. */
    enhancePrompt: z.boolean().optional(),
    /**
     * `character` only, `pro` bases: the asset id of a generated 8-direction
     * character in this style whose look every base drawn from text or a
     * concept follows. An asset may override it; the anchor itself ignores it.
     */
    styleCharacter: z.string().min(1).optional(),
    /** Fixed seed for reproducibility where the endpoint supports it. */
    seed: z.number().int().optional(),
    /**
     * Forced palette, as `#rrggbb` values. `pixflux` only.
     *
     * Unlike prose, this is a hard constraint. The API is handed a swatch
     * image and the output is limited to those colours. Verified: a four-colour
     * Game Boy palette produced output containing exactly those four values.
     * Prose asking for the same thing does not reliably hold, which is why the
     * map-generated monochrome sets came back with a yellow star and a brown
     * chocolate bar.
     */
    palette: z
      .array(HexColorSchema)
      .default([]),
    /**
     * Snap every visible pixel of the downloaded art to the nearest `palette`
     * colour, without dithering. The palette is sent to providers that take
     * one, and most honour it most of the time; this makes it a guarantee
     * for every generator, including the ones with no palette parameter.
     * Applied by `fetch` as the file is written and recorded on the lock
     * entry, so a restore reproduces the same bytes. Turning it on or off
     * does not change the spec hash: `plan` reports the entry as recoverable
     * and the next `fetch` or `restore` re-applies it from the art already
     * on disk or in the cache, spending nothing.
     */
    enforcePalette: z.boolean().default(false),
    /** Fail-closed native-grid, palette, and human-approval policy for derived art. */
    quality: QualityProfileSchema.optional(),
    /**
     * Composites this style's assets into declared cells of a sheet, rather
     * than letting `pack` derive a layout. Use it when the atlas coordinates
     * are already load-bearing somewhere else, a tile engine naming tiles by
     * cell or saved data storing cell indices, since `pack`'s id-sorted grid
     * moves every position when an asset is added or renamed.
     *
     * Assets in a mounted style declare their own `cell`; ones that do not are
     * left out of the sheet.
     */
    mount: z
      .object({
        /**
         * Existing sheet to composite into, relative to the manifest. Every
         * pixel outside a declared cell survives byte-for-byte, so a
         * hand-authored sheet can be part generated and part drawn. Omit to
         * start from transparent.
         */
        base: z.string().optional(),
        cellWidth: z.number().int().positive(),
        cellHeight: z.number().int().positive(),
        /** Where the composited sheet is written, relative to the manifest. */
        out: z.string(),
      })
      .strict()
      .optional(),
    /** Tags applied to every object generated in this style, for server-side filtering. */
    tags: z.array(z.string()).default([]),
    /** Adapter-owned settings, keyed by provider id. */
    providerOptions: z.record(z.record(z.unknown())).default({}),
  })
  .strict()

export const StyleSchema = StyleObjectSchema
  /**
   * The API rejects a connectable set combined with style tiles:
   * "Connectable features (roads/tileset/building) cannot be combined with
   * style tiles". Catching it here means `plan` reports it for free rather
   * than a `submit` discovering it after the run has started. The two
   * are individually the best reasons to use this generator, so reaching for
   * both at once is an easy mistake to make.
   */
  .refine((s) => !(s.tileFeature && s.styleImages.length), {
    message:
      "tileFeature and styleImages cannot be combined; a connectable set " +
      "derives its own tile geometry, so remove one or the other",
    path: ["tileFeature"],
  })
  .superRefine((style, ctx) => {
    if (style.quality && (style.generator === "tiles" || style.generator === "terrain" || style.generator === "animation")) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "quality profiles currently support single-image generators only",
        path: ["quality"],
      })
    }
    if (style.enforcePalette && style.palette.length < 2) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "enforcePalette needs a palette of at least two colours to snap to",
        path: ["enforcePalette"],
      })
    }
    if (style.generator !== "character") {
      for (const field of ["mode", "directions", "template"] as const) {
        if (style[field] !== undefined) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: `${field} applies to the character generator only`,
            path: [field],
          })
        }
      }
    } else if (style.mode && style.mode !== "standard" && style.directions === 4) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `${style.mode} characters always have 8 directions`,
        path: ["directions"],
      })
    }
  })

/**
 * Hand-authored child style before inheritance is resolved. Defaults must not
 * run here: an omitted value means "inherit", not "reset to the default".
 */
export const InheritedStyleSchema = StyleObjectSchema.partial()
  .extend({
    extends: z.string().min(1),
    /** Children own their destination; sharing a parent's output is never implicit. */
    outDir: z.string(),
    /** A child may override only part of the inherited final-art policy. */
    quality: QualityProfileObjectSchema.partial().optional(),
  })
  .strict()

export const StyleInputSchema = z.union([StyleSchema, InheritedStyleSchema])
export type StyleInput = z.infer<typeof StyleInputSchema>

export const AssetSchema = z
  .object({
    /** The subject. Style wrapping comes from the style's prefix/suffix. Only a `mirror` may leave it out. */
    prompt: z.string().optional(),
    /** Subdirectory under the style's outDir. Optional. */
    category: z.string().optional(),
    /** Overrides the style default. `map`, `pixflux`, and `imagePro` only. */
    width: z.number().int().min(16).max(8192).optional(),
    height: z.number().int().min(16).max(8192).optional(),
    /** Overrides the style default. `1dir` generator only. */
    size: z.number().int().min(32).max(256).optional(),
    /** Explicit output path relative to outDir. Media-aware providers may replace its extension. */
    file: z.string().optional(),
    /**
     * Grid cell this asset owns in a mounted style, as [column, row].
     *
     * Declared rather than derived, which is the point of `mount`: the
     * coordinate is a contract with whatever already reads the sheet, so it
     * must not move when the asset set changes. Assets without one are left
     * out of the mounted sheet.
     */
    cell: z.tuple([z.number().int().min(0), z.number().int().min(0)]).optional(),
    /**
     * Path, relative to the manifest, of the art that goes on a mounted
     * sheet, when that is not the raw generated output.
     *
     * `mount` otherwise takes its pixels from the lockfile, which records
     * what the API returned. That is the wrong file whenever the art needs a
     * step pixelkiln does not perform: a palette reduction onto a sheet's
     * closed palette, a hand touch-up, an alignment shift. Without somewhere
     * to say so, the choice is to mount the unprocessed art or to abandon
     * `mount` and composite by hand, and the hand-composited sheet is
     * exactly the unreproducible artifact `mount` exists to replace.
     *
     * An asset with a `source` needs no lockfile entry at all, so art
     * generated outside pixelkiln can still be placed by cell alongside art
     * that wasn't. `prompt` still records what was asked for.
     */
    source: z.string().optional(),
    /**
     * Per-style replacement for `source`, keyed by style id.
     *
     * A hand edit belongs to one generation: the same asset generated in two
     * styles is two different pictures, so the touch-up of one must not be
     * placed for the other. `pixelkiln edit` writes here when an asset is in
     * more than one style, and to `source` when it is in exactly one.
     */
    sourceByStyle: z.record(z.string().min(1)).default({}),
    /** Controlled generation derived from another asset in the same style. */
    revision: RevisionSchema.optional(),
    /**
     * The provider's own id for art that already exists on the account, so
     * `adopt` can map it without matching bytes: an object id (an
     * `objectPro` base and state included, since they share PixelLab's
     * `/objects` identity space), a character id, or `<id>#<animation group
     * id>` for a character or `objectPro` animation. Not part of the spec's
     * identity.
     */
    remoteId: z.string().min(1).optional(),
    /**
     * `character` or `objectPro` styles: this asset is a pose or edit of
     * another asset in the same family. `objectPro` ignores
     * `paletteFromReference`/`canvas` — the API has no equivalent, and
     * always inherits the parent's exact canvas.
     */
    state: CharacterStateSchema.optional(),
    /**
     * `character` or `objectPro` styles: this asset is a loop of another
     * asset in the same family, in one direction. `objectPro` has no
     * skeleton/template concept, so `template`/`subject`/`outline`/
     * `shading`/`detail` are rejected on an `objectPro` animation rather
     * than silently ignored — describe the motion in the asset's own
     * `prompt` instead.
     */
    animation: CharacterAnimationSchema.optional(),
    /**
     * `1dir` styles only: this asset rides along on another `1dir` asset's
     * batch submission instead of generating on its own. See
     * `AssetBatchSchema`.
     */
    batch: AssetBatchSchema.optional(),
    /** `uiAsset` styles: precise shape regions the panel is composited from. Combine with `elements`; omit both for a default full-canvas panel. */
    pieces: z.array(UiPieceSchema).min(1).optional(),
    /** `uiAsset` styles: named, auto-positioned UI element scaffolds. Combine with `pieces`; omit both for a default full-canvas panel. */
    elements: z.array(UiElementSchema).min(1).optional(),
    /** `character` styles: this asset is a bust portrait of another character asset's south sprite. */
    portrait: CharacterPortraitSchema.optional(),
    /** `character` styles: this asset re-clothes an existing loop's frames with a reference outfit. */
    outfit: CharacterOutfitSchema.optional(),
    /** `character` styles, `standard` humanoid bases: this character's proportions, over the style's. */
    proportions: CharacterProportionsSchema.optional(),
    /**
     * `character` or `objectPro` styles, bases only: the subject's own
     * sprite, which PixelLab rotates into the other directions instead of
     * drawing from the prompt. A manifest-relative PNG or JPEG of the
     * south-facing sprite, or an object keyed by direction (`{ "south":
     * ..., "east": ... }`); quadrupeds in `standard` character mode need
     * south and east, and only `standard` takes more than south. `objectPro`
     * only ever reads the south image, since `/create-object-pro-flash`
     * rotates from one frame. `standard` wants each image at the style's
     * size; v3 accepts up to 256px, pro up to 168px. The prompt
     * still guides the result.
     */
    reference: z.union([z.string().min(1), z.record(CharacterDirectionSchema, z.string().min(1))]).optional(),
    /**
     * `character` styles, `pro` bases only: a manifest-relative concept
     * image (a painting, a photo, a sketch; up to 1024px) that seeds the
     * design instead of the prompt alone. A style image or `styleCharacter`
     * may still anchor the look.
     */
    concept: z.string().min(1).optional(),
    /** `character` styles, `pro` bases: this base's style anchor, over the style's. */
    styleCharacter: z.string().min(1).optional(),
    /**
     * Another asset of the same style flipped left to right, made locally
     * from that asset's downloaded files at no generation cost.
     *
     * The saving is in character loops, where each direction is its own
     * generation: a walk facing west mirrored is the walk facing east, and a
     * diagonal mirrors to the other diagonal. South and north mirror onto
     * themselves and are refused. A single image or a frame set from any
     * generator can be mirrored too; a tile set cannot, since its edges
     * carry meaning. Mirroring swaps handedness, so an asymmetric character
     * (a sword hand, a parted fringe) comes out the other way round.
     */
    mirror: z.string().min(1).optional(),
    /**
     * Generated output role to place in `cell` when this asset expands to
     * several files. Omit for ordinary single-output assets. A structural set
     * is otherwise ambiguous and `mount` refuses to guess by taking index zero.
     */
    outputRole: z.string().min(1).optional(),
    tags: z.array(z.string()).default([]),
    /** Restrict this asset to specific styles. Empty means all styles. */
    styles: z.array(z.string()).default([]),
    /**
     * Per-style replacement for `prompt`, keyed by style id.
     *
     * A style can need different wording rather than different styling. A
     * monochrome style is the clear case: prompts that name colours
     * ("green purple gold", "colorful rainbow") override the palette
     * instruction and survive into the output, while the same prompt is
     * exactly right for a colour style. Editing the shared prompt to suit one
     * style would invalidate every other style's already-generated art.
     */
    promptByStyle: z.record(z.string()).default({}),
    /**
     * Named per-asset values consumed by the active provider's declared
     * bindings. Values are JSON scalars, or a frame-set sequence of scalars;
     * adapters may interpret a string as a manifest-relative uploaded file.
     */
    providerInputs: z
      .record(z.union([
        z.string(),
        z.number().finite(),
        z.boolean(),
        z.array(z.union([z.string(), z.number().finite(), z.boolean()])).min(2).max(64),
      ]))
      .default({}),
  })
  .strict()
  .superRefine((asset, context) => {
    if ((asset.source || Object.keys(asset.sourceByStyle).length) && asset.revision) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "source and revision are mutually exclusive",
        path: ["revision"],
      })
    }
    const shapes = [asset.revision && "revision", asset.state && "state", asset.animation && "animation", asset.mirror && "mirror", asset.batch && "batch", asset.portrait && "portrait", asset.outfit && "outfit"].filter(Boolean)
    if (shapes.length > 1) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: `${shapes.join(" and ")} are mutually exclusive`,
        path: [shapes[1] as string],
      })
    }
    if (asset.mirror && (asset.source || Object.keys(asset.sourceByStyle).length)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "a mirror is made from another asset's files; it cannot also declare a source",
        path: ["mirror"],
      })
    }
    if (asset.prompt === undefined && !asset.mirror && !asset.portrait && !asset.outfit) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Required",
        path: ["prompt"],
      })
    }
    if (asset.reference && (asset.state || asset.animation || asset.mirror || asset.portrait || asset.outfit)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "a reference sprite belongs on a base; a state, animation, mirror, portrait, or outfit takes its look from its parent",
        path: ["reference"],
      })
    }
    if (asset.concept && (asset.state || asset.animation || asset.mirror || asset.portrait || asset.outfit)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "a concept image belongs on a base; a state, animation, mirror, portrait, or outfit takes its look from its parent",
        path: ["concept"],
      })
    }
    if (asset.concept && asset.reference) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "concept and reference are mutually exclusive: a concept seeds a new design, a reference is the sprite to rotate",
        path: ["concept"],
      })
    }
    if (typeof asset.reference === "object" && !Object.keys(asset.reference).length) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: "a reference needs at least a south image", path: ["reference"] })
    }
  })

/** How many replaced generations a lock entry keeps, unless the environment or manifest says otherwise. */
export const DEFAULT_HISTORY_LIMIT = 5
const HistoryLimitSchema = z.number().int().min(0).max(100)

export const ManifestSchema = z
  .object({
    $schema: z.string().optional(),
    name: z.string(),
    /** Generation backend. Existing manifests remain PixelLab by default. */
    provider: z.string().min(1).default("pixellab"),
    /** Replaced generations kept per asset for this project; overrides PIXELKILN_HISTORY. 0 keeps none. */
    history: HistoryLimitSchema.optional(),
    styles: z.record(StyleSchema),
    assets: z.record(AssetSchema),
  })
  .strict()

/** Manifest contract accepted from disk before style inheritance is resolved. */
export const ManifestInputSchema = z
  .object({
    $schema: z.string().optional(),
    name: z.string(),
    provider: z.string().min(1).default("pixellab"),
    history: HistoryLimitSchema.optional(),
    styles: z.record(StyleInputSchema),
    assets: z.record(AssetSchema),
  })
  .strict()

export type Manifest = z.infer<typeof ManifestSchema>
export type Style = z.infer<typeof StyleSchema>
export type Asset = z.infer<typeof AssetSchema>

/**
 * One line of the lockfile: the mapping from a spec to the provider work that
 * satisfies it and the file on disk that came from it. This is the record that
 * did not exist before. Without it, generated objects and downloaded files are
 * two unrelated piles.
 */
const LockOutputSchema = z.object({
  path: z.string(),
  sha256: z.string(),
  role: z.string().optional(),
  mediaType: MediaTypeSchema.optional(),
  /**
   * Hash of the provider's bytes before post-processing changed them, when
   * it did. The content cache keeps both, so the post-processing can be
   * undone or redone without contacting the provider.
   */
  raw: z.string().optional(),
})

/**
 * What `fetch` did to the provider's bytes before writing them. Recorded on
 * the entry so `plan` can tell when the manifest asks for something else
 * and `restore` can reproduce the recorded hash from the raw bytes.
 */
export const PostprocessSchema = z.object({
  palette: z
    .object({
      /** Canonical lowercase `#rrggbb` values, in manifest order. */
      colors: z.array(z.string()).min(2).max(256),
      dither: z.literal("none"),
      distance: z.literal("redmean"),
    })
    .optional(),
})
export type Postprocess = z.infer<typeof PostprocessSchema>

const LockSourceSchema = z.object({
  url: z.string(),
  role: z.string().optional(),
  mediaType: MediaTypeSchema.optional(),
})

/**
 * A generation this entry replaced, kept so it can be brought back. It is the
 * retired entry's identity (object, sources, output hashes, prompt, cost)
 * without the live-state fields; `pixelkiln restore --generation` swaps it
 * back in. How many are kept is `PIXELKILN_HISTORY` or the manifest's
 * `history`, newest first.
 */
export const LockHistoryEntrySchema = z.object({
  specHash: z.string(),
  generator: GeneratorSchema,
  tileFeature: z.string().nullable().default(null),
  prompt: z.string(),
  width: z.number().int(),
  height: z.number().int(),
  jobId: z.string().nullable().default(null),
  objectId: z.string().nullable().default(null),
  candidateIndex: z.number().int().nullable().default(null),
  sourceUrl: z.string().nullable().default(null),
  sourceUrls: z.array(LockSourceSchema).default([]),
  outputs: z.array(LockOutputSchema).default([]),
  providerMetadata: z.record(z.record(z.unknown())).default({}),
  submittedAt: z.string().nullable().default(null),
  downloadedAt: z.string().nullable().default(null),
  cost: z.number().finite().nonnegative().default(0),
  costUnit: z.string().min(1).default("generations"),
  /** What the provider actually billed, read from the completed job; null when never read. */
  billed: z.object({ amount: z.number(), unit: z.string() }).nullable().default(null),
  provider: z.string().default("pixellab"),
  postprocess: PostprocessSchema.optional(),
  /** When the replacement was submitted. */
  retiredAt: z.string(),
})

export const LockEntrySchema = z.object({
  styleId: z.string(),
  assetId: z.string(),
  /** sha256 of the resolved spec. Changing a prompt/size/style invalidates it. */
  specHash: z.string(),
  generator: GeneratorSchema,
  /** Connectable tiles must remain multi-output even when polling is resumed later. */
  tileFeature: z.string().nullable().default(null),
  /** The resolved prompt actually sent, kept for auditing and for adopt matching. */
  prompt: z.string(),
  width: z.number().int(),
  height: z.number().int(),
  /** Explicit parent/input lineage for a revision generation. */
  revision: z
    .object({
      mode: RevisionModeSchema,
      sourceAssetId: z.string().min(1),
      sourceSha256: z.string().regex(/^[0-9a-f]{64}$/),
      maskSha256: z.string().regex(/^[0-9a-f]{64}$/).optional(),
      strength: z.number().min(0).max(1).optional(),
      numColors: z.number().int().min(2).max(256).optional(),
      paletteImageSha256: z.string().regex(/^[0-9a-f]{64}$/).optional(),
      dithering: RevisionDitheringSchema.optional(),
      ditheringStrength: z.number().min(0).max(10).optional(),
      // 4-40 for animate/animate-pixminimax; animate-skeleton's own 3-15
      // range extends the floor down to 3, hence min(3) here rather than 4.
      frames: z.number().int().min(3).max(40).optional(),
      fps: z.number().int().min(1).max(60).optional(),
      lastFrameSha256: z.string().regex(/^[0-9a-f]{64}$/).optional(),
      direction: CharacterDirectionSchema.optional(),
      enhancePrompt: z.boolean().optional(),
      keypointsSha256: z.string().regex(/^[0-9a-f]{64}$/).optional(),
      skeletonTemplate: z.string().min(1).optional(),
      description: z.string().min(1).optional(),
    })
    .strict()
    .nullable()
    .default(null),
  /** For a mirror: the asset it flips and a hash over that asset's output hashes when this was made. */
  mirror: z
    .object({
      sourceAssetId: z.string().min(1),
      sourceSha256: z.string().regex(/^[0-9a-f]{64}$/),
    })
    .strict()
    .nullable()
    .default(null),
  /** For a `1dir` batch member: which leader and slot it rode along on. */
  batch: z
    .object({
      role: z.enum(["leader", "member"]),
      leaderAssetId: z.string().min(1).optional(),
      index: z.number().int().min(1).optional(),
    })
    .strict()
    .nullable()
    .default(null),
  /**
   * For an outfit: the loop it re-clothed, a hash over that loop's output
   * hashes when this was made, and the reference image's own hash. Tracked
   * the way `mirror` is, not through `specHash`: manifest resolution has no
   * lock to hash the parent's actual current frame bytes against.
   */
  outfit: z
    .object({
      sourceAssetId: z.string().min(1),
      sourceSha256: z.string().regex(/^[0-9a-f]{64}$/),
      referenceSha256: z.string().regex(/^[0-9a-f]{64}$/),
    })
    .strict()
    .nullable()
    .default(null),

  /**
   * Output hashes owned by the previous generation while its replacement is
   * pending. They authorize replacing only unchanged PixelKiln-owned files.
   */
  supersededOutputs: z
    .array(
      z.object({
        path: z.string(),
        sha256: z.string(),
        role: z.string().optional(),
        mediaType: MediaTypeSchema.optional(),
      }),
    )
    .optional(),

  /** Set at submit time, before the request is awaited, so a crash is recoverable. */
  jobId: z.string().nullable().default(null),
  /** False only when a provider checkpoint says more requests remain. */
  submissionComplete: z.boolean().optional(),
  /** For `1dir`: the multi-candidate parent object awaiting selection. */
  reviewObjectId: z.string().nullable().default(null),
  /** The chosen candidate's own object id, once selected. */
  objectId: z.string().nullable().default(null),
  candidateIndex: z.number().int().nullable().default(null),

  status: z
    .enum([
      "pending",
      "processing",
      "review",
      "selected",
      "downloaded",
      "download-failed",
      "failed",
    ])
    .default("pending"),
  error: z.string().nullable().default(null),

  sourceUrl: z.string().nullable().default(null),
  /** Every source in a structural multi-output result, in provider order. */
  sourceUrls: z
    .array(
      z.object({
        url: z.string(),
        role: z.string().optional(),
        mediaType: MediaTypeSchema.optional(),
      }),
    )
    .default([]),

  /**
   * Files this entry produced. A plain object generates one; asset kinds that
   * expand into many, an animated character being ~35 spritesheets plus an engine
   * resource, need the list, which is why v1's single `file` became this.
   *
   * `role` labels non-primary artifacts (e.g. "portrait", "spriteframes") so a
   * consumer can find the one it wants without pattern-matching on paths.
   */
  outputs: z.array(LockOutputSchema).default([]),

  /**
   * Provider-owned data retained for downstream consumers, namespaced by
   * provider id. PixelLab connectable sets keep their exact `tileRules` here
   * so exporters can map images to adjacency rules.
   */
  providerMetadata: z.record(z.record(z.unknown())).default({}),

  submittedAt: z.string().nullable().default(null),
  downloadedAt: z.string().nullable().default(null),
  /** Successful-submission estimate in `costUnit`; may be fractional USD. */
  cost: z.number().finite().nonnegative().default(0),
  /** Unit for `cost`. Defaults preserve pre-unit PixelLab lockfiles. */
  costUnit: z.string().min(1).default("generations"),
  /**
   * What the provider actually billed, read from the completed job rather
   * than estimated at submit time. Null until a poll reads it, and for a
   * provider or generator `poll` does not read it from at all; `cost` above
   * is still what a wave budget spends against, since the real number is
   * only known after the fact.
   */
  billed: z.object({ amount: z.number(), unit: z.string() }).nullable().default(null),
  /** Which provider produced this. Absent on entries written before providers. */
  provider: z.string().default("pixellab"),

  /** Generations this entry replaced, newest first; see LockHistoryEntrySchema. */
  history: z.array(LockHistoryEntrySchema).optional(),
  /** Post-processing applied to the recorded outputs; absent when the bytes are the provider's. */
  postprocess: PostprocessSchema.optional(),
})

export const LockSchema = z.object({
  version: z.literal(2),
  entries: z.record(LockEntrySchema),
})

export type LockEntry = z.infer<typeof LockEntrySchema>
export type Lock = z.infer<typeof LockSchema>
export type LockOutput = LockEntry["outputs"][number]
export type LockHistoryEntry = z.infer<typeof LockHistoryEntrySchema>

/**
 * Parses a lockfile, rejecting anything that is not v2.
 *
 * There is deliberately no migration path. Both consuming projects were
 * onboarded after v2 landed, so a v1 file would be a corruption or a
 * hand-edit rather than a legacy artifact. Better to fail loudly than to
 * quietly reinterpret it.
 */
export function parseLock(raw: unknown): Lock {
  const parsed = LockSchema.safeParse(raw)
  if (parsed.success) return parsed.data
  throw new Error(
    `Lockfile is not valid v2:\n${parsed.error.issues
      .slice(0, 5)
      .map((i) => `  ${i.path.join(".")}: ${i.message}`)
      .join("\n")}`,
  )
}

/** The file a consumer means when it says "the asset": the first output. */
export function primaryOutput(entry: LockEntry): LockOutput | null {
  return entry.outputs.find((o) => !o.role) ?? entry.outputs[0] ?? null
}

/** Lock entries are keyed `<styleId>/<assetId>`, which makes styles a namespace. */
export function lockKey(styleId: string, assetId: string): string {
  return `${styleId}/${assetId}`
}

export interface ResolvedMirror {
  sourceAssetId: string
  sourceSpec: ResolvedSpec
}

/**
 * A `1dir` batch, leader or member. `itemDescriptions` is the full ordered
 * list (the leader's own prompt at index 0, then each member's prompt at
 * its declared `index`) and is identical across the whole group — every
 * member's identity depends on the group's full membership, so adding,
 * removing, or editing any one member's prompt marks every sibling stale
 * together, matching PixelLab having no way to add an item to an
 * already-submitted batch.
 */
export interface ResolvedBatch {
  role: "leader" | "member"
  itemDescriptions: string[]
  /** Member only: this asset's 1-based slot into `itemDescriptions`. */
  index?: number
  /** Member only: the leader asset id and its full resolved intent. */
  leaderAssetId?: string
  leaderSpec?: ResolvedSpec
  /** Leader only: every member's asset id, in `index` order. */
  memberAssetIds?: string[]
}

/** A manifest entry resolved against its style, everything needed to generate. */
export interface ResolvedSpec {
  /** Absolute directory containing the manifest; excluded from the spec hash. */
  root: string
  styleId: string
  assetId: string
  /** Backend whose request semantics and estimate produced this spec. */
  provider: string
  /** Adapter-owned settings selected from the active provider namespace. */
  providerOptions: Record<string, unknown>
  /** Adapter-resolved per-asset inputs. Their stable identity participates in the spec hash. */
  providerInputs?: Record<string, unknown>
  generator: Generator
  prompt: string
  width: number
  height: number
  view: string
  size: number
  styleImagePaths: string[]
  outFile: string
  /** Derived quality output. Excluded from provider request identity and spend. */
  quality?: ResolvedQualityProfile
  /** Provider generation derived from another current manifest asset. */
  revision?: ResolvedRevision
  /** Set for every spec in a `character` style: base, state, or animation. */
  character?: ResolvedCharacter
  /** Set for every spec in an `objectPro` style: base, state, or animation. */
  objectPro?: ResolvedObjectPro
  /** A local left-to-right flip of another asset in this style; costs nothing. */
  mirror?: ResolvedMirror
  /** Set for a `1dir` asset that hosts or rides along on a batch submission. */
  batch?: ResolvedBatch
  /** Provider-side id declared for adoption; excluded from the spec hash. */
  remoteId?: string
  /**
   * Manifest-relative path of committed art that stands in for generated
   * output; excluded from the spec hash. Set only when the asset declares
   * `source`, which also means it needs no lock entry.
   */
  source?: string
  tags: string[]
  specHash: string
  cost: number
  costUnit: import("./provider.ts").CostUnit
  candidates: number
  outline?: string
  shading?: string
  detail?: string
  seed?: number
  /** `uiAsset` generator only. See `UiPieceSchema`. */
  uiPieces?: UiPiece[]
  /** `uiAsset` generator only. See `UiElementSchema`. */
  uiElements?: UiElement[]
  /** `uiAsset`/`uiElement` generators only. Natural-language palette hint, distinct from `palette`'s hex array. */
  uiColorPalette?: string
  /** Forced palette hex values; empty unless the style sets one. */
  palette: string[]
  /** Snap downloaded art to `palette`; excluded from the spec hash. */
  enforcePalette: boolean
  /** `pixflux` only. Strip the generated background. Defaults to true. */
  noBackground: boolean
  /** `tiles` generator only. See StyleSchema for what each one means. */
  tileSize?: number
  tileHeight?: number
  /**
   * `tiles` generator: author-set, from the style. `terrain` generator: always
   * `"square_topdown"`, set internally (not an author-facing field on
   * `terrain`) so exporters read the real tile shape instead of falling back
   * to `tiles`' own "isometric" default, which does not apply to terrain's
   * `/create-tileset` output (a rectangular vertex grid regardless of
   * `terrainView`'s camera angle).
   */
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
  /** `terrain` generator only. See StyleSchema for what each one means. */
  terrainLowerDescription?: string
  terrainUpperDescription?: string
  terrainTransitionDescription?: string
  terrainTileSize?: number
  terrainMode?: string
  terrainShapeStyle?: string
  terrainSpreadX?: number
  terrainSlopeSize?: number
  terrainRaggedness?: number
  terrainTransitionSize?: number
  terrainView?: string
  /** `isometricTile` generator only. See StyleSchema for what each one means. */
  isometricTileSize?: number
  isometricTileShape?: string
}
