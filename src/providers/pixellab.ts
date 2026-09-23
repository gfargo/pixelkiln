import { mkdirSync, existsSync, readFileSync, writeFileSync } from "node:fs"
import { randomUUID } from "node:crypto"
import os from "node:os"
import path from "node:path"
import { PixelLabClient, PixelLabError, clientFromEnv, type Base64Image, type PixelLabCharacter, type PixelLabObject, type PixelLabUsage } from "../client.ts"
import { sha256 } from "../hash.ts"
import { imageMetadata } from "../media.ts"
import { paletteSwatch } from "../png.ts"
import {
  CHARACTER_DIRECTIONS_4,
  CHARACTER_DIRECTIONS_8,
  candidateCount,
  generationCost,
  type CharacterDirection,
  type Generator,
  type ResolvedCharacter,
  type ResolvedReferenceImage,
  type ResolvedSpec,
  type ResolvedStyleImage,
  type RevisionMode,
} from "../types.ts"
import type {
  BalanceInfo,
  BilledAmount,
  CostEstimate,
  JobState,
  OutputSource,
  PollContext,
  Provider,
  RateLimit,
  RefreshContext,
  RemoteAsset,
  RemoteCharacter,
  RemoteCharacterDetail,
  SubmitContext,
} from "../provider.ts"

/**
 * PixelLab, the reference implementation.
 *
 * All PixelLab-specific knowledge lives here: the three generators and their
 * very different pricing, the review/candidate flow, the fact that a map
 * object's job record expires while its image does not, and that pixflux
 * returns bytes inline instead of a job id.
 */
/**
 * Where a generation can be opened in the PixelLab web app, for a look or
 * for a hand edit in its built-in editor, after which `pixelkiln fetch
 * --refresh` pulls the changed bytes back down. A `map` or `1dir` object has
 * a page at `/create-object/<id>`; a tile set at `/maps/tiles/<set id>` (a
 * chosen variation records `<set id>#<index>`, and the page is the set's). A
 * `character` object has a page at `/create-character/<character id>` (a
 * state or animation records `<character id>#<group id>`, and the page is
 * the character's, since neither has a page of its own). pixflux returns an
 * inline image and keeps no object to open.
 */
export function pixelLabObjectUrl(generator: Generator, objectId: string | null): string | null {
  if (!objectId) return null
  if (generator === "map" || generator === "1dir") {
    return `https://www.pixellab.ai/create-object/${encodeURIComponent(objectId)}`
  }
  if (generator === "tiles") {
    const setId = objectId.split("#")[0]!
    return setId ? `https://www.pixellab.ai/maps/tiles/${encodeURIComponent(setId)}` : null
  }
  if (generator === "character") {
    const characterId = objectId.split("#")[0]!
    return characterId ? `https://www.pixellab.ai/create-character/${encodeURIComponent(characterId)}` : null
  }
  return null
}

/**
 * A completed background job's `usage`, as `billed` on the lock entry.
 *
 * Confirmed live (docs/ENDPOINTS.md, "Limits and billing") for a `map`
 * object and a standard character base: `GET /background-jobs/{id}` carries
 * `usage` once the job is `completed`, in the same `{type, generations|usd}`
 * shape the synchronous endpoints already return inline. Absent, null, or an
 * unrecognized `type` all mean "not known"; the submit-time `cost` estimate
 * is what a wave budget still spends against.
 */
function billedFromUsage(usage: PixelLabUsage | null | undefined): BilledAmount | null {
  if (!usage) return null
  if (usage.type === "usd" || (usage.type === undefined && typeof usage.usd === "number")) {
    return typeof usage.usd === "number" ? { amount: usage.usd, unit: "usd" } : null
  }
  if (typeof usage.generations === "number") return { amount: usage.generations, unit: "generations" }
  return null
}

/**
 * The cost PixelLab charges for one character-family asset, in generations.
 *
 * A standard base is a flat 1. A v3 base is Pixen's 1 plus the rotation
 * pass, `ceil(s*s*8 / 65536)`; a pro-flash base is its image tier plus the
 * same rotation pass. Pro bases and every state are priced by
 * canvas tier, 20 to 40, the same tiers as `1dir`; PixelLab resolves the
 * exact tier when the job runs and reserves against the floor, so this
 * reports the tier the canvas lands in. A template animation is 1 per
 * direction; a v3 animation scales with canvas and frames,
 * `ceil(w*h*frames / 65536)`; a pro animation is the 20 to 40 tier.
 */
export function characterCost(spec: ResolvedSpec): number {
  const character = spec.character
  if (!character) return generationCost(spec.width, spec.height, "1dir")
  const px = spec.width * spec.height
  if (character.kind === "animation") {
    const animation = character.animation!
    if (animation.mode === "template") return 1
    if (animation.mode === "v3") return Math.max(1, Math.ceil((px * animation.frames) / 65536))
    return generationCost(spec.width, spec.height, "1dir")
  }
  if (character.kind === "state") return generationCost(spec.width, spec.height, "1dir")
  if (character.mode === "standard") return 1
  if (character.mode === "v3") return 1 + Math.max(1, Math.ceil((px * 8) / 65536))
  if (character.mode === "pro-flash") {
    // From a sprite, the canvas is the sprite's, padded square; only the rotations are billed.
    const south = character.reference?.south
    return south ? proFlashCharacterCost(south.width, south.height, true) : proFlashCharacterCost(spec.width, spec.height, false)
  }
  return generationCost(spec.width, spec.height, "1dir")
}

/**
 * Pro Flash prices the south image and the v3 rotations separately; the
 * rotation pass is v3's formula on the square canvas the sprite is padded
 * to, and the image is a size tier read from PixelLab's cost endpoint in
 * September 2026 (5 up to 96px, 6 up to 208px, 9 beyond). A base drawn
 * from the author's own sprite pays the rotations only.
 */
export function proFlashCharacterCost(width: number, height: number, fromReference: boolean): number {
  const side = Math.max(32, Math.ceil(Math.max(width, height) / 4) * 4)
  const rotations = Math.max(1, Math.ceil((side * side * 8) / 65536))
  if (fromReference) return rotations
  const image = side <= 96 ? 5 : side <= 208 ? 6 : 9
  return image + rotations
}

/** The name PixelKiln gives an animation upstream, so a re-roll can find and replace it. */
export function characterAnimationName(spec: Pick<ResolvedSpec, "styleId" | "assetId">): string {
  return `pixelkiln:${spec.styleId}/${spec.assetId}`
}

/** Same name PixelKiln gives an objectPro animation upstream, so a re-roll can find it. */
export function objectAnimationName(spec: Pick<ResolvedSpec, "styleId" | "assetId">): string {
  return `pixelkiln:${spec.styleId}/${spec.assetId}`
}

/**
 * `/create-object-pro-flash`'s own image/rotation pricing has not been
 * measured against a live account -- this assumes it is identical to
 * `proFlashCharacterCost`'s measured formula (the request bodies are
 * near-identical, minus `template_id`), parameterized by `directions` (1 or
 * 8) rather than character's fixed 8, since a 1-direction object only pays
 * for one rotation.
 */
export function proFlashObjectCost(width: number, height: number, directions: 1 | 8, fromReference: boolean): number {
  const side = Math.max(32, Math.ceil(Math.max(width, height) / 4) * 4)
  const rotations = Math.max(1, Math.ceil((side * side * directions) / 65536))
  if (fromReference) return rotations
  const image = side <= 96 ? 5 : side <= 208 ? 6 : 9
  return image + rotations
}

/** Same shape as `characterCost`, minus the modes/template concept objects have none of. */
export function objectProCost(spec: ResolvedSpec): number {
  const object = spec.objectPro
  if (!object) return generationCost(spec.width, spec.height, "1dir")
  const px = spec.width * spec.height
  if (object.kind === "animation") {
    const animation = object.animation!
    if (animation.mode === "pro") return generationCost(spec.width, spec.height, "1dir")
    return Math.max(1, Math.ceil((px * animation.frames) / 65536))
  }
  if (object.kind === "state") return generationCost(spec.width, spec.height, "1dir")
  const south = object.reference
  return south ? proFlashObjectCost(south.width, south.height, object.directions, true) : proFlashObjectCost(spec.width, spec.height, object.directions, false)
}

const CHARACTER_TEMPLATES = ["mannequin", "bear", "cat", "dog", "horse", "lion"] as const
/** Pro Flash also fits a skeleton to whatever the image shows. */
const PRO_FLASH_TEMPLATES = [...CHARACTER_TEMPLATES, "custom"] as const

interface AnimationJob {
  characterId: string
  name: string
  direction: CharacterDirection
  jobIds: string[]
}

/** A poll handle that carries what a later run needs to find the animation upstream. */
function encodeAnimationJob(job: AnimationJob): string {
  return `character-animation:${Buffer.from(JSON.stringify(job)).toString("base64url")}`
}

function decodeAnimationJob(jobId: string): AnimationJob | null {
  if (!jobId.startsWith("character-animation:")) return null
  try {
    const value = JSON.parse(Buffer.from(jobId.slice("character-animation:".length), "base64url").toString("utf8"))
    if (typeof value?.characterId === "string" && typeof value.name === "string" && typeof value.direction === "string") {
      return { characterId: value.characterId, name: value.name, direction: value.direction, jobIds: Array.isArray(value.jobIds) ? value.jobIds : [] }
    }
  } catch {
    // fall through
  }
  return null
}

/**
 * One direction's animation job. Unlike `AnimationJob`, `jobId` is a single
 * nullable id, not an array: `/objects/{id}/animations` always returns
 * exactly one `DirectionSubmission` per requested direction, and it can be
 * null outright when that submission came back `rate_limited`.
 */
interface ObjectAnimationJob {
  objectId: string
  name: string
  direction: string
  jobId: string | null
}

function encodeObjectAnimationJob(job: ObjectAnimationJob): string {
  return `object-animation:${Buffer.from(JSON.stringify(job)).toString("base64url")}`
}

function decodeObjectAnimationJob(jobId: string): ObjectAnimationJob | null {
  if (!jobId.startsWith("object-animation:")) return null
  try {
    const value = JSON.parse(Buffer.from(jobId.slice("object-animation:".length), "base64url").toString("utf8"))
    if (typeof value?.objectId === "string" && typeof value.name === "string" && typeof value.direction === "string") {
      return { objectId: value.objectId, name: value.name, direction: value.direction, jobId: typeof value.jobId === "string" ? value.jobId : null }
    }
  } catch {
    // fall through
  }
  return null
}

export class PixelLabProvider implements Provider {
  readonly id = "pixellab"

  constructor(private readonly client: PixelLabClient) {}

  static fromEnv(): PixelLabProvider {
    return new PixelLabProvider(clientFromEnv())
  }

  /** Public storage URLs and the local content cache do not require API auth. */
  static forDownloads(): PixelLabProvider {
    return PixelLabProvider.forOffline()
  }

  /** Capability and cost estimation only; makes no network request itself. */
  static forOffline(): PixelLabProvider {
    return new PixelLabProvider(new PixelLabClient("download-only"))
  }

  supports(generator: Generator): boolean {
    return (
      generator === "1dir" ||
      generator === "map" ||
      generator === "pixflux" ||
      generator === "tiles" ||
      generator === "terrain" ||
      generator === "imagePro" ||
      generator === "character" ||
      generator === "isometricTile" ||
      generator === "objectPro"
    )
  }

  /**
   * `inpaint` (`/inpaint-v3`, a mask) and `image-to-image` (`/edit-images-v2`,
   * no mask) both exist on PixelLab, and so do `reduce-colors`
   * (`/reduce-colors`) and `correct-pixelart` (`/correct-pixelart`) — PixelLab's
   * "Cleanup" tier, a mechanical post-process on the source's own pixels
   * rather than a described edit — and `animate`/`animate-pixminimax`
   * (`/animate-with-text-v3`, `/animate-pixminimax`), which animate any loose
   * image from a text description with no character/object resource
   * required. `outpaint` does not: there is no canvas-expansion endpoint in
   * the API, matching docs/REVISIONS.md's note that no provider ships a
   * tested outpaint path yet.
   */
  supportsRevision(mode: RevisionMode): boolean {
    return (
      mode === "inpaint" || mode === "image-to-image" || mode === "reduce-colors" || mode === "correct-pixelart" ||
      mode === "animate" || mode === "animate-pixminimax"
    )
  }

  /** PixelLab's own constraints: submissions must be >2s apart, and
   *  background jobs in flight are capped by subscription tier (Tier 1=8,
   *  Tier 2=10, Tier 3=20); 8 is the safe floor across every tier. */
  rateLimit(): RateLimit {
    return { spacingMs: 2500, maxInFlight: 8 }
  }

  /**
   * Where synchronous pixflux results are parked between `submit` and `fetch`.
   *
   * pixflux returns the PNG inline rather than a job id, but the pipeline is
   * built around submit → poll → fetch running as separate commands. Writing
   * the bytes to a known path keeps that model intact: the "job id" is the
   * filename, polling is an existence check, and downloading is a file read.
   */
  private static cacheDir(): string {
    const dir = path.join(os.tmpdir(), "pixelkiln-pixflux")
    mkdirSync(dir, { recursive: true })
    return dir
  }

  estimate(spec: ResolvedSpec): CostEstimate {
    if (spec.revision?.mode === "reduce-colors" || spec.revision?.mode === "correct-pixelart") {
      // Confirmed live: a flat 0.1 generations for both, on a 32x32 source,
      // on a Tier 2 subscription account (docs/REVISIONS.md). The OpenAPI
      // response schema's own example is dollar-denominated (`usage:
      // {type: "usd", usd: 0.005}` for reduce-colors, `0.01` for
      // correct-pixelart), which this codebase has repeatedly found does not
      // predict real subscription billing (isometricTile, objectPro) — the
      // real account balance moved by exactly 0.1 generations per call
      // instead, matching PixelLab's own MCP tool descriptions. Only
      // confirmed at this one size; whether it stays flat at larger canvases
      // is unknown.
      return { unit: "generations", amount: 0.1, candidates: 1 }
    }
    if (spec.revision?.mode === "animate" || spec.revision?.mode === "animate-pixminimax") {
      // Unmeasured against a live account; no usage example exists for
      // either endpoint at all (only a generic background-job example).
      // `/animate-with-text-v3`'s request shape is near-identical to
      // `character`'s own v3 text loop (first_frame/action/frame_count/
      // seed/no_background/enhance_prompt), so this borrows that measured
      // formula — `ceil(width*height*frames / 65536)` — as a placeholder,
      // same reasoning `objectPro` used to borrow `character` pro-flash's
      // cost. `enhance_prompt` costs its own documented +0.05 generations,
      // which is a real number from the schema, not a guess.
      const width = spec.revision.sourceWidth ?? spec.width
      const height = spec.revision.sourceHeight ?? spec.height
      const frames = spec.revision.frames ?? 8
      const base = Math.max(1, Math.ceil((width * height * frames) / 65536))
      return { unit: "generations", amount: spec.revision.enhancePrompt ? base + 0.05 : base, candidates: 1 }
    }
    if (spec.revision) {
      // /inpaint-v3 and /edit-images-v2 are both documented "Pro" endpoints,
      // like /generate-with-style-v2 and /generate-image-v2. Live calls to
      // inpaint-v3 confirm its floor (32x32, 1024px², billed 20) and
      // ceiling (512x512, billed 40) match this borrowed tiering exactly,
      // and confirm a real middle (25-generation) tier exists -- 288x288
      // (82944px²) and 320x320 (102400px²) both billed 25 -- but at
      // breakpoints nowhere near this tiering's 1024px²/2048px²: 40x40,
      // 128x128, and 256x256 (up to 65536px²) all still billed 20, and
      // 352x352 (123904px²) and 384x384 (147456px²) already billed 40.
      // Both real breakpoints are now tightly bracketed: 20->25 in
      // (65536px², 82944px²], 25->40 in (102400px², 123904px²]
      // (docs/ENDPOINTS.md). Below 2048px² this still returns 20 (correct
      // everywhere measured); at or above 2048px² it always returns 40,
      // which is wrong for 288x288 and 320x320 specifically (confirmed 25,
      // not 40) -- still a safe direction, just a bigger miss than a
      // single tier. edit-images-v2 above its own 32x32 floor is
      // unmeasured entirely.
      // Reuse the same canvas-area tiering already measured for those Pro
      // endpoints and for 1dir/tiles rather than guess a number for what
      // remains unconfirmed: per
      // generationCost's own contract, over-reading is the safe direction
      // for a `--budget` gate. The image actually sent is the parent's own
      // size, not the child's declared width/height, so size against that
      // when it is known.
      const width = spec.revision.sourceWidth ?? spec.width
      const height = spec.revision.sourceHeight ?? spec.height
      return { unit: "generations", amount: generationCost(width, height, "1dir"), candidates: 1 }
    }
    // `tiles` and `terrain` both price and count off the whole set, both of
    // which the manifest layer already worked out; see tilesCost /
    // tileVariationCount / terrainTileCount. `/create-tileset`'s own cost is
    // unmeasured, so this borrows the same canvas-tier model. `isometricTile`
    // is a real measured flat 1 generation; see isometricTileCost().
    if (spec.generator === "tiles" || spec.generator === "terrain" || spec.generator === "isometricTile") {
      return { unit: "generations", amount: spec.cost, candidates: spec.candidates }
    }
    if (spec.generator === "character") {
      return { unit: "generations", amount: characterCost(spec), candidates: 1 }
    }
    if (spec.generator === "objectPro") {
      return { unit: "generations", amount: objectProCost(spec), candidates: 1 }
    }
    return {
      unit: "generations",
      amount: generationCost(spec.width, spec.height, spec.generator),
      candidates: spec.generator === "1dir" || spec.generator === "imagePro" ? candidateCount(spec.size) : 1,
    }
  }

  validate(spec: ResolvedSpec, styleImages: ResolvedStyleImage[]): void {
    if (spec.revision?.mode === "inpaint") {
      const { sourceWidth: width, sourceHeight: height } = spec.revision
      if (width != null && height != null && (width < 32 || height < 32 || width > 512 || height > 512)) {
        throw new Error(`PixelLab inpaint source is ${width}x${height}; the API takes 32 to 512 pixels per side`)
      }
    }
    if (spec.revision?.mode === "reduce-colors") {
      const { sourceWidth: width, sourceHeight: height } = spec.revision
      if (width != null && height != null && width * height > 512 * 512) {
        throw new Error(
          `PixelLab reduce-colors source is ${width}x${height} (${width * height}px²); ` +
            "the API takes at most 512x512 worth of pixels per call",
        )
      }
    }
    if (spec.revision?.mode === "correct-pixelart") {
      const { sourceWidth: width, sourceHeight: height } = spec.revision
      if (width != null && height != null && (width > 1024 || height > 1024)) {
        throw new Error(`PixelLab correct-pixelart source is ${width}x${height}; the API takes at most 1024 pixels per side`)
      }
    }
    if (spec.revision?.mode === "animate" || spec.revision?.mode === "animate-pixminimax") {
      const { sourceWidth: width, sourceHeight: height, mode, frames, lastFrameWidth, lastFrameHeight } = spec.revision
      if (width != null && height != null && (width > 256 || height > 256)) {
        throw new Error(`PixelLab ${mode} source is ${width}x${height}; the API takes at most 256 pixels per side`)
      }
      if (mode === "animate" && frames != null && frames > 16) {
        throw new Error(`PixelLab animate takes 4 to 16 frames; ${frames} is too many (use animate-pixminimax for up to 40)`)
      }
      if (
        lastFrameWidth != null && lastFrameHeight != null && width != null && height != null &&
        (lastFrameWidth !== width || lastFrameHeight !== height)
      ) {
        throw new Error(
          `PixelLab ${mode} lastFrame is ${lastFrameWidth}x${lastFrameHeight}; source is ${width}x${height} — they must match`,
        )
      }
    }
    if (spec.generator === "1dir" && (spec.width < 32 || spec.width > 256)) {
      throw new Error("PixelLab 1dir dimensions must be between 32 and 256 pixels")
    }
    if (
      (spec.generator === "map" || spec.generator === "pixflux") &&
      (spec.width < 16 || spec.height < 16 || spec.width > 400 || spec.height > 400)
    ) {
      throw new Error(`PixelLab ${spec.generator} dimensions must be between 16 and 400 pixels`)
    }
    if (
      spec.generator === "imagePro" &&
      (spec.width < 16 || spec.height < 16 || spec.width > 792 || spec.height > 688)
    ) {
      throw new Error(
        `PixelLab imagePro is ${spec.width}x${spec.height}; the API takes 16 to 792 wide and ` +
          "16 to 688 tall (the exact ceiling also depends on aspect ratio)",
      )
    }
    if (spec.generator === "map") {
      requirePixelLabOption("map", "view", spec.view, ["low top-down", "high top-down", "side"])
      requirePixelLabOption("map", "outline", spec.outline, [
        "single color outline", "selective outline", "lineless",
      ])
      requirePixelLabOption("map", "shading", spec.shading, [
        "flat shading", "basic shading", "medium shading", "detailed shading",
      ])
      requirePixelLabOption("map", "detail", spec.detail, [
        "low detail", "medium detail", "high detail",
      ])
    }
    if (spec.generator === "terrain") {
      if (spec.outline) {
        requirePixelLabOption("terrain", "outline", spec.outline, [
          "single color black outline", "single color outline", "selective outline", "lineless",
        ])
      }
      if (spec.shading) {
        requirePixelLabOption("terrain", "shading", spec.shading, [
          "flat shading", "basic shading", "medium shading", "detailed shading", "highly detailed shading",
        ])
      }
      if (spec.detail) {
        requirePixelLabOption("terrain", "detail", spec.detail, ["low detail", "medium detail", "highly detailed"])
      }
      // Real API rejections, not soft defaults: shape_style is standard-only,
      // and a 64px tile needs the pro pipeline.
      if (spec.terrainShapeStyle && spec.terrainMode === "pro") {
        throw new Error(
          "PixelLab terrain: terrainShapeStyle is standard-mode only; pro's own shape controls " +
            "are terrainSpreadX/terrainSlopeSize/terrainRaggedness",
        )
      }
      if (spec.terrainTileSize === 64 && spec.terrainMode !== "pro") {
        throw new Error('PixelLab terrain: a 64px tile needs terrainMode: "pro"')
      }
      if (
        spec.terrainShapeStyle &&
        spec.terrainTransitionSize != null &&
        spec.terrainTransitionSize > 0.5
      ) {
        throw new Error(
          "PixelLab terrain: terrainShapeStyle with terrainTransitionSize above 0.5 uses an " +
            "extended 32-tile layout pixelkiln does not model; use 0, 0.25, or 0.5",
        )
      }
      if (
        !spec.terrainShapeStyle &&
        spec.terrainTransitionSize != null &&
        ![0, 0.25, 0.5, 1].includes(spec.terrainTransitionSize)
      ) {
        throw new Error(
          "PixelLab terrain: terrainTransitionSize must be 0, 0.25, 0.5, or 1 unless terrainShapeStyle is set",
        )
      }
    }
    if (spec.generator === "isometricTile") {
      if (spec.outline) {
        requirePixelLabOption("isometricTile", "outline", spec.outline, [
          "single color outline", "selective outline", "lineless",
        ])
      }
      if (spec.shading) {
        requirePixelLabOption("isometricTile", "shading", spec.shading, [
          "flat shading", "basic shading", "medium shading", "detailed shading", "highly detailed shading",
        ])
      }
      if (spec.detail) {
        requirePixelLabOption("isometricTile", "detail", spec.detail, ["low detail", "medium detail", "highly detailed"])
      }
      if (spec.width < 16 || spec.width > 64) {
        throw new Error(`PixelLab isometricTile: size must be 16 to 64 pixels, got ${spec.width}`)
      }
    }
    if (spec.generator === "character") this.validateCharacter(spec, styleImages)
    if (spec.generator === "objectPro") this.validateObjectPro(spec, styleImages)
    if ((spec.generator === "map" || spec.generator === "pixflux") && styleImages.length) {
      throw new Error(`PixelLab ${spec.generator} does not support style images`)
    }
    if (spec.generator === "terrain" && styleImages.length) {
      throw new Error(
        "PixelLab terrain does not support style images yet; use color_image/reference " +
          "images directly against /create-tileset if this becomes a real need",
      )
    }
    if (spec.generator === "imagePro" && styleImages.length) {
      throw new Error(
        "PixelLab imagePro does not support style images yet; /generate-image-v2's own " +
          "reference_images and style_image are not modeled here",
      )
    }
    if (spec.generator === "isometricTile" && styleImages.length) {
      throw new Error(
        "PixelLab isometricTile does not support style images; /create-isometric-tile has no " +
          "such field (its own init_image/color_image are not modeled here yet)",
      )
    }
    for (const image of styleImages) {
      if (image.width > 256 || image.height > 256) {
        throw new Error(
          `Style image exceeds PixelLab's 256x256 limit (${image.width}x${image.height})`,
        )
      }
    }
    if (spec.tags.length > 20) {
      throw new Error(
        `${spec.styleId}/${spec.assetId} resolves to ${spec.tags.length} tags, ` +
          `but PixelLab allows at most 20`,
      )
    }
  }

  private validateCharacter(spec: ResolvedSpec, styleImages: ResolvedStyleImage[] = []): void {
    const character = spec.character
    if (!character) throw new Error(`${spec.styleId}/${spec.assetId} has no character shape`)
    const label = `${spec.styleId}/${spec.assetId}`
    if (character.kind === "base" && character.proportions !== undefined) {
      if (character.mode !== "standard") {
        throw new Error(`${label}: proportions apply to standard bases; the ${character.mode} engine has none to set`)
      }
      if (character.template !== "mannequin") {
        throw new Error(`${label}: proportions apply to the mannequin template; ${character.template} is a quadruped`)
      }
    }
    if (character.kind === "base" && character.enhancePrompt !== undefined && character.mode !== "v3") {
      throw new Error(`${label}: enhancePrompt applies to v3 bases; the ${character.mode} engine does not take it`)
    }
    if (character.animation) {
      const { startFrame, endFrame } = character.animation
      for (const [name, image] of [["start frame", startFrame], ["end frame", endFrame]] as const) {
        if (image && (image.width > 256 || image.height > 256)) {
          throw new Error(`${label}: ${name} is ${image.width}x${image.height}; PixelLab v3 takes up to 256px`)
        }
      }
      if (endFrame) {
        // The end frame must match the start frame: the given one, or the
        // parent's rotation when that is on disk to compare with.
        const start = startFrame ?? (character.parentFile && existsSync(character.parentFile)
          ? imageMetadata(readFileSync(character.parentFile))
          : null)
        if (start && (start.width !== endFrame.width || start.height !== endFrame.height)) {
          throw new Error(
            `${label}: end frame is ${endFrame.width}x${endFrame.height} but the ${startFrame ? "start frame" : "character's rotation"} ` +
              `is ${start.width}x${start.height}; PixelLab interpolates between frames of one size`,
          )
        }
      }
    }
    if (character.concept) {
      if (character.mode !== "pro") throw new Error(`${label}: a concept image is a pro input; the ${character.mode} engine draws from text or a reference`)
      if (character.concept.width > 1024 || character.concept.height > 1024) {
        throw new Error(`${label}: concept image is ${character.concept.width}x${character.concept.height}; PixelLab pro takes up to 1024px`)
      }
    }
    if (character.styleAnchor) {
      if (character.mode !== "pro") throw new Error(`${label}: styleCharacter is a pro input; the ${character.mode} engine has no style anchor`)
      if (character.reference) throw new Error(`${label}: a pro base rotating its own reference takes no styleCharacter`)
      if (character.styleAnchor.spec.character?.directions !== 8) {
        throw new Error(`${label}: styleCharacter ${character.styleAnchor.assetId} has ${character.styleAnchor.spec.character?.directions} directions; PixelLab wants an 8-direction anchor`)
      }
    }
    if (character.reference) {
      const given = Object.keys(character.reference) as CharacterDirection[]
      if (!character.reference.south) throw new Error(`${label}: a reference needs a south-facing sprite`)
      if (character.mode !== "standard") {
        if (given.length > 1) throw new Error(`${label}: PixelLab ${character.mode} rotates one south-facing reference; drop the other directions`)
        const limit = character.mode === "pro" ? 168 : 256
        const south = character.reference.south
        if (south.width > limit || south.height > limit) {
          throw new Error(`${label}: reference is ${south.width}x${south.height}; PixelLab ${character.mode} takes up to ${limit}px`)
        }
      } else {
        const allowed = character.directions === 4 ? CHARACTER_DIRECTIONS_4 : CHARACTER_DIRECTIONS_8
        for (const direction of given) {
          if (!allowed.includes(direction)) {
            throw new Error(`${label}: reference "${direction}" is not one of this character's ${character.directions} directions`)
          }
          const image = character.reference[direction]!
          if (image.width !== spec.width || image.height !== spec.height) {
            throw new Error(
              `${label}: reference (${direction}) is ${image.width}x${image.height}; ` +
                `standard mode wants each image at the style's size, ${spec.width}x${spec.height}`,
            )
          }
        }
        if (character.template !== "mannequin" && !character.reference.east) {
          throw new Error(`${label}: a ${character.template} reference needs south and east images`)
        }
      }
    }
    if (styleImages.length) {
      if (character.mode !== "pro" && character.mode !== "pro-flash") {
        throw new Error(
          `PixelLab ${character.mode} characters take no style images; ` +
            "give a base its own sprite with `reference`, or use mode pro or pro-flash for a style anchor",
        )
      }
      if (styleImages.length > 1) throw new Error(`PixelLab ${character.mode} characters take one style image`)
      if (character.kind === "base" && character.reference) {
        throw new Error(`${label}: a ${character.mode} base rotating its own reference takes no style image`)
      }
      const image = styleImages[0]!
      const limit = character.mode === "pro" ? 168 : 256
      if (image.width > limit || image.height > limit) {
        throw new Error(`PixelLab ${character.mode} character style image is ${image.width}x${image.height}; the limit is ${limit}px`)
      }
      // Pro Flash lays the style image on the canvas it draws; one that
      // does not fit is refused upstream ("crop the reference or choose a
      // larger supported canvas").
      if (character.mode === "pro-flash" && (image.width > spec.width || image.height > spec.height)) {
        throw new Error(
          `PixelLab pro-flash style image is ${image.width}x${image.height} but the character is ${spec.width}x${spec.height}; ` +
            "crop the image to its subject or raise the style's size",
        )
      }
    }
    if (character.styleTraits && character.mode !== "pro-flash") {
      throw new Error(`${label}: styleTraits choose what a pro-flash style image lends; the ${character.mode} engine does not take them`)
    }
    const maxSize = character.mode === "v3" || character.mode === "pro-flash" ? 256 : 128
    if (spec.width < 16 || spec.height < 16 || spec.width > maxSize || spec.height > maxSize) {
      throw new Error(`PixelLab ${character.mode} characters must be between 16 and ${maxSize} pixels`)
    }
    if (character.mode === "pro-flash" && character.kind === "base" && (spec.width % 4 || spec.height % 4)) {
      throw new Error(`PixelLab pro-flash characters are sized in multiples of 4 pixels; ${spec.width}x${spec.height} is not`)
    }
    const templates: readonly string[] = character.mode === "pro-flash" ? PRO_FLASH_TEMPLATES : CHARACTER_TEMPLATES
    if (!templates.includes(character.template)) {
      throw new Error(`PixelLab ${character.mode} character template must be one of: ${templates.join(", ")}`)
    }
    const views = character.mode === "standard"
      ? ["low top-down", "high top-down", "side", "perspective", "oblique"]
      : ["low top-down", "high top-down", "side"]
    if (!views.includes(spec.view)) {
      throw new Error(`PixelLab ${character.mode} character view must be one of: ${views.join(", ")}`)
    }
    if (spec.view === "oblique" && character.directions !== 4) {
      throw new Error("PixelLab oblique characters are 4-direction only")
    }
    if (character.kind !== "base" && !character.parentAssetId) {
      throw new Error(`${spec.styleId}/${spec.assetId} is a ${character.kind} with no parent`)
    }
    if (character.animation) {
      const allowed = character.directions === 4 ? CHARACTER_DIRECTIONS_4 : CHARACTER_DIRECTIONS_8
      if (!allowed.includes(character.animation.direction)) {
        throw new Error(
          `${spec.styleId}/${spec.assetId} animates "${character.animation.direction}", ` +
            `but its character has ${character.directions} directions: ${allowed.join(", ")}`,
        )
      }
      if (character.animation.mode !== "template" && !spec.prompt.trim()) {
        throw new Error(`${spec.styleId}/${spec.assetId} needs a prompt describing the motion, or a template`)
      }
    }
  }

  private validateObjectPro(spec: ResolvedSpec, styleImages: ResolvedStyleImage[] = []): void {
    const object = spec.objectPro
    if (!object) throw new Error(`${spec.styleId}/${spec.assetId} has no objectPro shape`)
    const label = `${spec.styleId}/${spec.assetId}`
    if (object.kind === "base" && object.reference && styleImages.length) {
      throw new Error(`${label}: a base rotating its own reference sprite takes no style image`)
    }
    if (object.reference && (object.reference.width > 256 || object.reference.height > 256)) {
      throw new Error(`${label}: reference is ${object.reference.width}x${object.reference.height}; PixelLab objectPro takes up to 256px`)
    }
    if (styleImages.length) {
      if (styleImages.length > 1) throw new Error(`PixelLab objectPro takes one style image`)
      const image = styleImages[0]!
      if (image.width > 256 || image.height > 256) {
        throw new Error(`PixelLab objectPro style image is ${image.width}x${image.height}; the limit is 256px`)
      }
      // Pro Flash lays the style image on the canvas it draws, same as character pro-flash.
      if (image.width > spec.width || image.height > spec.height) {
        throw new Error(
          `PixelLab objectPro style image is ${image.width}x${image.height} but the object is ${spec.width}x${spec.height}; ` +
            "crop the image to its subject or raise the style's size",
        )
      }
    }
    if (object.kind === "base" && (spec.width < 16 || spec.height < 16 || spec.width > 256 || spec.height > 256)) {
      throw new Error(`PixelLab objectPro bases must be between 16 and 256 pixels`)
    }
    if (object.kind === "base" && (spec.width % 4 || spec.height % 4)) {
      throw new Error(`PixelLab objectPro bases are sized in multiples of 4 pixels; ${spec.width}x${spec.height} is not`)
    }
    if (object.kind !== "base" && !object.parentAssetId) {
      throw new Error(`${spec.styleId}/${spec.assetId} is a ${object.kind} with no parent`)
    }
    if (object.animation) {
      const allowed = object.directions === 1 ? (["south"] as const) : CHARACTER_DIRECTIONS_8
      if (!allowed.includes(object.animation.direction as never)) {
        throw new Error(
          `${label} animates "${object.animation.direction}", but its object has ${object.directions} direction${object.directions === 1 ? "" : "s"}: ${allowed.join(", ")}`,
        )
      }
      if (!spec.prompt.trim()) {
        throw new Error(`${label} needs a prompt describing the motion`)
      }
      const { startFrame, endFrame } = object.animation
      for (const [name, image] of [["start frame", startFrame], ["end frame", endFrame]] as const) {
        if (image && (image.width > 256 || image.height > 256)) {
          throw new Error(`${label}: ${name} is ${image.width}x${image.height}; PixelLab v3 takes up to 256px`)
        }
      }
      if (endFrame) {
        const start = startFrame ?? (object.parentFile && existsSync(object.parentFile) ? imageMetadata(readFileSync(object.parentFile)) : null)
        if (start && (start.width !== endFrame.width || start.height !== endFrame.height)) {
          throw new Error(
            `${label}: end frame is ${endFrame.width}x${endFrame.height} but the ${startFrame ? "start frame" : "object's rotation"} ` +
              `is ${start.width}x${start.height}; PixelLab interpolates between frames of one size`,
          )
        }
      }
    }
  }

  /**
   * A base is one request that answers with the character id; a state is
   * the same with the parent's id; an animation names itself after the
   * asset so a later run can find it, and clears its own earlier take for
   * that direction first, since PixelLab skips a direction that exists.
   */
  private async submitCharacter(spec: ResolvedSpec, styleImages: ResolvedStyleImage[], context?: SubmitContext): Promise<{ jobId: string; metadata?: Record<string, unknown> }> {
    const character = spec.character!
    if (character.kind === "base") {
      const swatch = spec.palette.length && character.mode === "standard"
        ? paletteSwatch(spec.palette).toString("base64")
        : undefined
      const styleImage = styleImages[0]
      const res = await this.client.createCharacter({
        mode: character.mode,
        description: spec.prompt,
        size: spec.width,
        directions: character.directions,
        view: spec.view,
        template: character.template,
        outline: spec.outline,
        shading: spec.shading,
        detail: spec.detail,
        seed: spec.seed,
        noBackground: spec.noBackground,
        paletteSwatchBase64: swatch,
        proportions: character.proportions,
        textGuidanceScale: character.textGuidanceScale,
        isometric: character.isometric,
        reference: character.reference ? readReference(spec, character.reference) : undefined,
        styleReference: styleImage ? { base64: styleImage.base64, format: styleImage.format } : undefined,
        enhancePrompt: character.enhancePrompt,
        concept: character.concept ? readPose(spec, "concept image", character.concept) : undefined,
        styleCharacterId: character.styleAnchor ? requireStyleObjectId(spec, context) : undefined,
        styleReferenceSize: styleImage ? { width: styleImage.width, height: styleImage.height } : undefined,
        styleTraits: character.styleTraits,
      })
      return { jobId: res.character_id, metadata: { character: { kind: "base", characterId: res.character_id, mode: character.mode, directions: character.directions, backgroundJobId: res.background_job_id } } }
    }
    const parentId = context?.parentObjectId
    if (!parentId) {
      throw new Error(
        `${spec.styleId}/${spec.assetId} is a ${character.kind} of ${character.parentAssetId}, ` +
          "which has no PixelLab character id in the lockfile yet; generate the parent first",
      )
    }
    if (character.kind === "state") {
      const res = await this.client.createCharacterState({
        characterId: parentId,
        editDescription: spec.prompt,
        stateName: spec.assetId.slice(0, 50),
        paletteFromReference: character.state?.paletteFromReference,
        canvas: character.state?.canvas,
        seed: spec.seed,
        noBackground: spec.noBackground,
      })
      return { jobId: res.character_id, metadata: { character: { kind: "state", characterId: res.character_id, parentCharacterId: parentId, mode: character.mode, directions: character.directions, backgroundJobId: res.background_job_id } } }
    }
    const animation = character.animation!
    const name = characterAnimationName(spec)
    // PixelLab skips a direction that already exists on the character, so an
    // earlier take of this asset's direction goes first. It is found by the
    // group id the last poll recorded, or by the name PixelKiln gave it, or by
    // the animation id in its frame URLs; nothing else on the character is
    // touched.
    const replaced = (context?.replacedMetadata?.character ?? {}) as { animationGroupId?: string | null; animationId?: string | null }
    const existing = await this.client.getCharacter(parentId)
    for (const group of existing.animations) {
      const ours = group.animation_group_id && (
        group.animation_group_id === replaced.animationGroupId ||
        group.display_name === name ||
        (replaced.animationId && group.directions.some((d) => d.frames.some((url) => url.includes(`/animations/${replaced.animationId}/`))))
      )
      if (!ours || !group.animation_group_id) continue
      if (group.directions.some((d) => d.direction === animation.direction)) {
        await this.client.deleteCharacterAnimations(parentId, { animationGroupId: group.animation_group_id }, animation.direction)
      }
    }
    const res = await this.client.animateCharacter({
      characterId: parentId,
      animationName: name,
      actionDescription: spec.prompt.trim() || undefined,
      template: animation.template,
      mode: animation.mode,
      frameCount: animation.frames,
      keepFirstFrame: animation.keepFirstFrame,
      directions: [animation.direction],
      seed: spec.seed,
      textGuidanceScale: character.textGuidanceScale,
      isometric: character.isometric,
      startFrame: animation.startFrame ? readPose(spec, "start frame", animation.startFrame) : undefined,
      endFrame: animation.endFrame ? readPose(spec, "end frame", animation.endFrame) : undefined,
      description: animation.subject,
      outline: animation.outline,
      shading: animation.shading,
      detail: animation.detail,
      enhancePrompt: animation.enhancePrompt,
      paletteSwatchBase64: spec.palette.length ? paletteSwatch(spec.palette).toString("base64") : undefined,
    })
    const job: AnimationJob = { characterId: parentId, name, direction: animation.direction, jobIds: res.background_job_ids }
    return {
      jobId: encodeAnimationJob(job),
      metadata: { character: { kind: "animation", characterId: parentId, animationName: name, direction: animation.direction, mode: animation.mode, backgroundJobIds: res.background_job_ids } },
    }
  }

  /**
   * Same shape as `submitCharacter`, minus the mode branching (objectPro has
   * exactly one base-creation path) and minus the client-side "find and
   * delete the prior take" dance for animation: `/objects/{id}/animations`
   * has its own `replace_existing` flag, so this always passes it rather
   * than fetching the object first to check.
   */
  private async submitObjectPro(spec: ResolvedSpec, styleImages: ResolvedStyleImage[], context?: SubmitContext): Promise<{ jobId: string; metadata?: Record<string, unknown> }> {
    const object = spec.objectPro!
    if (object.kind === "base") {
      const styleImage = styleImages[0]
      const res = await this.client.createObjectProFlash({
        description: spec.prompt,
        directions: object.directions,
        size: spec.width,
        view: spec.view,
        seed: spec.seed,
        reference: object.reference ? readPose(spec, "reference sprite", object.reference) : undefined,
        styleReference: styleImage ? { base64: styleImage.base64, format: styleImage.format } : undefined,
        styleReferenceSize: styleImage ? { width: styleImage.width, height: styleImage.height } : undefined,
        styleTraits: object.styleTraits,
      })
      return { jobId: res.object_id, metadata: { objectPro: { kind: "base", objectId: res.object_id, directions: object.directions, backgroundJobId: res.background_job_id } } }
    }
    const parentId = context?.parentObjectId
    if (!parentId) {
      throw new Error(
        `${spec.styleId}/${spec.assetId} is a ${object.kind} of ${object.parentAssetId}, ` +
          "which has no PixelLab object id in the lockfile yet; generate the parent first",
      )
    }
    if (object.kind === "state") {
      const res = await this.client.createObjectProState({
        objectId: parentId,
        editDescription: spec.prompt,
        stateName: spec.assetId.slice(0, 50),
        seed: spec.seed,
      })
      return { jobId: res.object_id, metadata: { objectPro: { kind: "state", objectId: res.object_id, parentObjectId: parentId, directions: object.directions, backgroundJobId: res.background_job_id } } }
    }
    const animation = object.animation!
    const name = objectAnimationName(spec)
    const res = await this.client.animateObject({
      objectId: parentId,
      directions: object.directions,
      direction: animation.direction,
      animationDescription: spec.prompt.trim() || undefined,
      displayName: name,
      mode: animation.mode === "pro" ? "pro" : "v3",
      frameCount: animation.frames,
      keepFirstFrame: animation.keepFirstFrame,
      startFrame: animation.startFrame ? readPose(spec, "start frame", animation.startFrame) : undefined,
      endFrame: animation.endFrame ? readPose(spec, "end frame", animation.endFrame) : undefined,
      enhancePrompt: animation.enhancePrompt,
      replaceExisting: true,
    })
    const submission = res.submissions.find((s) => s.direction === animation.direction) ?? res.submissions[0]
    const job: ObjectAnimationJob = { objectId: parentId, name, direction: animation.direction, jobId: submission?.background_job_id ?? null }
    return {
      jobId: encodeObjectAnimationJob(job),
      metadata: {
        objectPro: {
          kind: "animation",
          objectId: parentId,
          animationName: name,
          direction: animation.direction,
          mode: animation.mode,
          animationGroupId: res.animation_group_id,
          animationId: submission?.animation_id ?? null,
        },
      },
    }
  }

  private async pollCharacter(jobId: string, context?: PollContext): Promise<JobState> {
    const animation = decodeAnimationJob(jobId)
    if (animation) return this.pollCharacterAnimation(animation, context)
    const character = await this.client.getCharacter(jobId)
    if (character.status === "failed") return { status: "failed", error: "character generation failed upstream" }
    if (character.status !== "completed" || !character.rotation_urls) return { status: "processing" }
    const sources = rotationSources(character)
    if (!sources.length) return { status: "failed", error: "character completed with no rotation images" }
    const backgroundJobId = (context?.metadata?.character as { backgroundJobId?: string } | undefined)?.backgroundJobId
    return {
      status: "ready",
      objectId: character.id,
      sourceUrl: sources[0]!.url,
      sources,
      metadata: {
        character: {
          characterId: character.id,
          groupId: character.group_id ?? null,
          name: character.name,
          stateName: character.state_name ?? null,
          directions: character.directions,
          size: character.size,
          updatedAt: character.updated_at ?? null,
        },
      },
      billed: await this.billedForJob(backgroundJobId),
    }
  }

  /**
   * The background job is the authoritative record of one direction: it
   * completes with the frame URLs, the animation id, and the direction, and
   * it reports a failure. The character's own animation list is the
   * fallback once PixelLab has cleaned the job up, and the place the group
   * id (what a later delete needs) is read from.
   */
  private async pollCharacterAnimation(job: AnimationJob, context?: PollContext): Promise<JobState> {
    const fps = context?.spec?.character?.animation?.fps ?? 8
    const review = (frames: string[], animationId: string | null, groupId: string | null, billed: BilledAmount | null): JobState => ({
      status: "review-set",
      objectId: `${job.characterId}#${groupId ?? animationId ?? job.name}`,
      frameUrls: frames,
      sources: frames.map((url, index) => ({ url, role: `frame-${String(index).padStart(2, "0")}` })),
      fps,
      metadata: {
        frameSet: { fps, count: frames.length },
        character: {
          kind: "animation",
          characterId: job.characterId,
          animationId,
          animationGroupId: groupId,
          animationName: job.name,
          direction: job.direction,
        },
      },
      billed,
    })

    let cleanedUp = job.jobIds.length === 0
    for (const id of job.jobIds) {
      const status = await this.client.getBackgroundJob(id).catch((err: unknown) => {
        if (err instanceof PixelLabError && err.status === 404) return null
        throw err
      })
      if (!status) {
        cleanedUp = true
        continue
      }
      if (status.status === "failed") return { status: "failed", error: "animation generation failed upstream" }
      if (status.status !== "completed") return { status: "processing" }
      const done = status.last_response ?? {}
      const frames = (done.storage_urls as { frames?: unknown } | undefined)?.frames
      const animationId = typeof done.animation_id === "string" ? done.animation_id : null
      if (Array.isArray(frames) && frames.length && frames.every((f) => typeof f === "string")) {
        const character = await this.client.getCharacter(job.characterId)
        const group = findAnimation(character, job.name, job.direction, animationId)
        return review(frames as string[], animationId, group?.groupId ?? null, billedFromUsage(status.usage))
      }
    }
    // No job told us; the animation list is what is left, searched by name
    // or by the animation id an earlier poll recorded.
    const recorded = (context?.metadata?.character as { animationId?: string | null } | undefined)?.animationId ?? null
    const character = await this.client.getCharacter(job.characterId)
    const found = findAnimation(character, job.name, job.direction, recorded)
    if (found) return review(found.frames, found.animationId, found.groupId, null)
    return cleanedUp
      ? { status: "failed", error: `animation job is gone upstream and no "${job.name}" ${job.direction} animation exists on the character` }
      : { status: "processing" }
  }

  private async pollObjectPro(jobId: string, context?: PollContext): Promise<JobState> {
    const animation = decodeObjectAnimationJob(jobId)
    if (animation) return this.pollObjectProAnimation(animation, context)
    const object = await this.client.getObject(jobId)
    if (object.status === "failed") return { status: "failed", error: "object generation failed upstream" }
    if (object.status !== "completed" || !object.rotation_urls) return { status: "processing" }
    const sources = objectRotationSources(object)
    if (!sources.length) return { status: "failed", error: "object completed with no rotation images" }
    const backgroundJobId = (context?.metadata?.objectPro as { backgroundJobId?: string } | undefined)?.backgroundJobId
    return {
      status: "ready",
      objectId: object.id,
      sourceUrl: sources[0]!.url,
      sources,
      metadata: {
        objectPro: {
          objectId: object.id,
          groupId: object.group_id ?? null,
          name: object.name,
          stateName: object.state_name ?? null,
          directions: object.directions,
          size: object.size,
        },
      },
      billed: await this.billedForJob(backgroundJobId),
    }
  }

  /**
   * Same resilience shape as `pollCharacterAnimation`: the background job is
   * the authoritative record while it lasts, the object's own `animations`
   * list (matched by the `pixelkiln:` display name this asset submitted, or
   * a recorded animation id) is the fallback once PixelLab cleans the job
   * up. Never declares failure from absence alone -- a `rate_limited`
   * `DirectionSubmission` has no background job id at all, so this keeps
   * reporting "processing" rather than guessing a job that never existed
   * has failed.
   */
  private async pollObjectProAnimation(job: ObjectAnimationJob, context?: PollContext): Promise<JobState> {
    const fps = context?.spec?.objectPro?.animation?.fps ?? 8
    const review = (frames: string[], animationId: string | null, groupId: string | null, billed: BilledAmount | null): JobState => ({
      status: "review-set",
      objectId: `${job.objectId}#${groupId ?? animationId ?? job.name}`,
      frameUrls: frames,
      sources: frames.map((url, index) => ({ url, role: `frame-${String(index).padStart(2, "0")}` })),
      fps,
      metadata: {
        frameSet: { fps, count: frames.length },
        objectPro: {
          kind: "animation",
          objectId: job.objectId,
          animationId,
          animationGroupId: groupId,
          animationName: job.name,
          direction: job.direction,
        },
      },
      billed,
    })

    if (job.jobId) {
      const status = await this.client.getBackgroundJob(job.jobId).catch((err: unknown) => {
        if (err instanceof PixelLabError && err.status === 404) return null
        throw err
      })
      if (status) {
        if (status.status === "failed") return { status: "failed", error: "animation generation failed upstream" }
        if (status.status !== "completed") return { status: "processing" }
        const done = status.last_response ?? {}
        const frames = (done.storage_urls as { frames?: unknown } | undefined)?.frames
        const animationId = typeof done.animation_id === "string" ? done.animation_id : null
        if (Array.isArray(frames) && frames.length && frames.every((f) => typeof f === "string")) {
          const object = await this.client.getObject(job.objectId)
          const group = findObjectAnimation(object, job.name, job.direction, animationId)
          return review(frames as string[], animationId, group?.groupId ?? null, billedFromUsage(status.usage))
        }
      }
    }
    // No job told us, or none was ever assigned (rate-limited at submit
    // time): the animation list is what is left, searched by name or by the
    // animation id an earlier poll recorded.
    const recorded = (context?.metadata?.objectPro as { animationId?: string | null } | undefined)?.animationId ?? null
    const object = await this.client.getObject(job.objectId)
    const found = findObjectAnimation(object, job.name, job.direction, recorded)
    if (found) return review(found.frames, found.animationId, found.groupId, null)
    return { status: "processing" }
  }

  async submit(spec: ResolvedSpec, styleImages: ResolvedStyleImage[], context?: SubmitContext): Promise<{ jobId: string; metadata?: Record<string, unknown> }> {
    this.validate(spec, styleImages)
    if (spec.revision) return this.submitRevision(spec)
    if (spec.generator === "character") return this.submitCharacter(spec, styleImages, context)
    if (spec.generator === "objectPro") return this.submitObjectPro(spec, styleImages, context)
    if (spec.generator === "pixflux") {
      const swatch = spec.palette.length
        ? paletteSwatch(spec.palette).toString("base64")
        : undefined
      const { png } = await this.client.createImagePixflux({
        description: spec.prompt,
        width: spec.width,
        height: spec.height,
        noBackground: spec.noBackground,
        paletteSwatchBase64: swatch,
        seed: spec.seed,
      })
      const jobId = randomUUID()
      writeFileSync(path.join(PixelLabProvider.cacheDir(), `${jobId}.png`), png)
      return { jobId }
    }

    if (spec.generator === "tiles") {
      const res = await this.client.createTilesPro({
        description: spec.prompt,
        tileSize: spec.tileSize,
        tileHeight: spec.tileHeight,
        tileType: spec.tileType,
        tileView: spec.tileView,
        tileViewAngle: spec.tileViewAngle,
        tileDepthRatio: spec.tileDepthRatio,
        tileFlatTopPx: spec.tileFlatTopPx,
        obliqueLean: spec.obliqueLean,
        tileFeature: spec.tileFeature,
        buildingWallTiles: spec.buildingWallTiles,
        buildingLayout: spec.buildingLayout,
        buildingWallDescription: spec.buildingWallDescription,
        buildingFloorDescription: spec.buildingFloorDescription,
        buildingFloor2Description: spec.buildingFloor2Description,
        buildingWallAngle: spec.buildingWallAngle,
        outlineMode: spec.outlineMode,
        seed: spec.seed,
        // TilesProStyleImage is flat and wants the reference's real dimensions,
        // unlike 1dir's {type, base64, format} payload.
        styleImages: styleImages.map(({ base64, width, height }) => ({ base64, width, height })),
      })
      return { jobId: res.tile_id, metadata: { backgroundJobId: res.background_job_id } }
    }

    if (spec.generator === "terrain") {
      const res = await this.client.createTileset({
        lowerDescription: spec.terrainLowerDescription!,
        upperDescription: spec.terrainUpperDescription!,
        transitionDescription: spec.terrainTransitionDescription,
        tileSize: spec.terrainTileSize,
        mode: spec.terrainMode,
        shapeStyle: spec.terrainShapeStyle,
        spreadX: spec.terrainSpreadX,
        slopeSize: spec.terrainSlopeSize,
        raggedness: spec.terrainRaggedness,
        transitionSize: spec.terrainTransitionSize,
        view: spec.terrainView,
        outline: spec.outline,
        shading: spec.shading,
        detail: spec.detail,
        seed: spec.seed,
      })
      return { jobId: res.tileset_id, metadata: { backgroundJobId: res.background_job_id } }
    }

    if (spec.generator === "isometricTile") {
      const res = await this.client.createIsometricTile({
        description: spec.prompt,
        imageWidth: spec.width,
        imageHeight: spec.height,
        tileSize: spec.isometricTileSize,
        tileShape: spec.isometricTileShape,
        outline: spec.outline,
        shading: spec.shading,
        detail: spec.detail,
        seed: spec.seed,
      })
      return { jobId: res.tile_id, metadata: { backgroundJobId: res.background_job_id } }
    }

    if (spec.generator === "imagePro") {
      const res = await this.client.createImagePro({
        description: spec.prompt,
        width: spec.width,
        height: spec.height,
        noBackground: spec.noBackground,
        seed: spec.seed,
      })
      // Like a revision, jobId is the background_job_id itself: there is no
      // separate resource id to poll, so pollImagePro polls it directly.
      return { jobId: res.background_job_id }
    }

    if (spec.generator === "1dir") {
      const res = await this.client.create1Direction({
        description: spec.prompt,
        size: spec.size,
        view: spec.view === "sidescroller" ? "sidescroller" : "top-down",
        styleImages,
      })
      return { jobId: res.object_id, metadata: { backgroundJobId: res.background_job_id } }
    }
    const res = await this.client.createMapObject({
      description: spec.prompt,
      width: spec.width,
      height: spec.height,
      view: spec.view,
      outline: spec.outline,
      shading: spec.shading,
      detail: spec.detail,
      seed: spec.seed,
    })
    return { jobId: res.object_id, metadata: { backgroundJobId: res.background_job_id } }
  }

  /**
   * `inpaint` reads the mask as PixelLab's own convention: white marks the
   * area to generate, black the area to preserve (`InpaintV3Request`'s own
   * field description). Unlike ComfyUI's revision graph, there is no
   * configurable side to this — document it as fixed rather than leave an
   * agent to guess, the way docs/REVISIONS.md tells a ComfyUI author to test
   * their own graph.
   */
  private async submitRevision(spec: ResolvedSpec): Promise<{ jobId: string; metadata?: Record<string, unknown> }> {
    const revision = spec.revision!
    if (!revision.sourceSha256 || !revision.sourceFormat || revision.sourceWidth == null || revision.sourceHeight == null) {
      throw new Error(`${spec.styleId}/${spec.assetId}: revision source is not ready`)
    }
    const sourceBytes = readFileSync(revision.sourceFile)
    if (sha256(sourceBytes) !== revision.sourceSha256) {
      throw new Error(`${spec.styleId}/${spec.assetId}: revision source changed after the manifest was resolved`)
    }
    const image: Base64Image = { base64: sourceBytes.toString("base64"), format: revision.sourceFormat }
    const width = revision.sourceWidth
    const height = revision.sourceHeight

    if (revision.mode === "inpaint") {
      if (!revision.maskFile || !revision.maskSha256 || !revision.maskFormat) {
        throw new Error(`${spec.styleId}/${spec.assetId}: revision mask is not ready`)
      }
      const maskBytes = readFileSync(revision.maskFile)
      if (sha256(maskBytes) !== revision.maskSha256) {
        throw new Error(`${spec.styleId}/${spec.assetId}: revision mask changed after the manifest was resolved`)
      }
      const res = await this.client.inpaintV3({
        description: spec.prompt,
        image,
        width,
        height,
        maskImage: { base64: maskBytes.toString("base64"), format: revision.maskFormat },
        noBackground: spec.noBackground,
        seed: spec.seed,
      })
      return { jobId: res.background_job_id }
    }

    // reduce-colors and correct-pixelart are PixelLab's "Cleanup" tier: both
    // are ordinary synchronous REST calls with no background_job_id, exactly
    // like pixflux's own /create-image-pixflux — the result is already in
    // hand when this function returns, so it is cached locally under a fresh
    // id the same way pixflux's is, and `poll()` below just checks the file
    // exists. `spec.prompt` describes nothing to either endpoint (there is no
    // text instruction here); it stays a manifest-only label.
    if (revision.mode === "reduce-colors") {
      let paletteImage: Base64Image | undefined
      if (revision.paletteImageFile) {
        if (!revision.paletteImageSha256 || !revision.paletteImageFormat) {
          throw new Error(`${spec.styleId}/${spec.assetId}: revision palette image is not ready`)
        }
        const paletteBytes = readFileSync(revision.paletteImageFile)
        if (sha256(paletteBytes) !== revision.paletteImageSha256) {
          throw new Error(`${spec.styleId}/${spec.assetId}: revision palette image changed after the manifest was resolved`)
        }
        paletteImage = { base64: paletteBytes.toString("base64"), format: revision.paletteImageFormat }
      }
      const res = await this.client.reduceColors({
        image,
        numColors: revision.numColors,
        paletteImage,
        dithering: revision.dithering,
        ditheringStrength: revision.ditheringStrength,
      })
      const jobId = randomUUID()
      writeFileSync(path.join(PixelLabProvider.cacheDir(), `${jobId}.png`), res.png)
      return { jobId, metadata: { revisionUsage: res.usage } }
    }
    if (revision.mode === "correct-pixelart") {
      const res = await this.client.correctPixelart({ image, strength: revision.strength })
      const jobId = randomUUID()
      writeFileSync(path.join(PixelLabProvider.cacheDir(), `${jobId}.png`), res.png)
      return { jobId, metadata: { revisionUsage: res.usage } }
    }

    // animate and animate-pixminimax are real async jobs, unlike the two
    // Cleanup-tier modes above — PixelLab generates new frames rather than
    // transforming the source in place, so this is a plain background job
    // like inpaint/image-to-image, not a locally-cached synchronous result.
    if (revision.mode === "animate" || revision.mode === "animate-pixminimax") {
      let lastFrame: Base64Image | undefined
      if (revision.lastFrameFile) {
        if (!revision.lastFrameSha256 || !revision.lastFrameFormat) {
          throw new Error(`${spec.styleId}/${spec.assetId}: revision last frame is not ready`)
        }
        const lastFrameBytes = readFileSync(revision.lastFrameFile)
        if (sha256(lastFrameBytes) !== revision.lastFrameSha256) {
          throw new Error(`${spec.styleId}/${spec.assetId}: revision last frame changed after the manifest was resolved`)
        }
        lastFrame = { base64: lastFrameBytes.toString("base64"), format: revision.lastFrameFormat }
      }
      if (revision.mode === "animate") {
        const res = await this.client.animateWithTextV3({
          firstFrame: image,
          lastFrame,
          action: spec.prompt,
          frameCount: revision.frames,
          seed: spec.seed,
          noBackground: spec.noBackground,
          enhancePrompt: revision.enhancePrompt,
        })
        return { jobId: res.background_job_id }
      }
      const res = await this.client.animatePixminimax({
        firstFrame: image,
        lastFrame,
        description: spec.prompt,
        frameCount: revision.frames,
        seed: spec.seed,
        noBackground: spec.noBackground,
        enhancePrompt: revision.enhancePrompt,
        direction: revision.direction,
      })
      return { jobId: res.background_job_id }
    }

    // image-to-image: PixelLab has no denoise-strength knob on this
    // endpoint, so a declared `strength` has nowhere to go. Refuse rather
    // than silently drop what the manifest asked for.
    if (revision.strength != null) {
      throw new Error(
        `${spec.styleId}/${spec.assetId}: PixelLab image-to-image revisions take no strength; ` +
          "edit-images-v2 always applies the full instruction",
      )
    }
    const res = await this.client.editImagesV2({
      description: spec.prompt,
      image,
      width,
      height,
      noBackground: spec.noBackground,
      seed: spec.seed,
    })
    return { jobId: res.background_job_id }
  }

  /**
   * What a background job actually billed, once its own record is still
   * around to ask; see `billedFromUsage`. A stale or already-cleaned-up job
   * (a map object's record expires in hours; see `pollMap`) means "not
   * known", not a failure worth surfacing.
   */
  private async billedForJob(backgroundJobId: string | null | undefined): Promise<BilledAmount | null> {
    if (!backgroundJobId) return null
    try {
      const job = await this.client.getBackgroundJob(backgroundJobId)
      return billedFromUsage(job.usage)
    } catch {
      return null
    }
  }

  async poll(jobId: string, generator: Generator, context?: PollContext): Promise<JobState> {
    // A revision has no resource-specific status endpoint the way a map
    // object, tile set, or character does: /inpaint-v3 and /edit-images-v2
    // both hand back a plain background job, so jobId here already *is* the
    // background_job_id. `generator` alone cannot tell a revision apart from
    // an ordinary submission of the same base generator, which is why this
    // checks the spec the pipeline threads through PollContext instead.
    const revisionMode = context?.spec?.revision?.mode
    if (revisionMode === "reduce-colors" || revisionMode === "correct-pixelart") {
      return this.pollCachedRevision(jobId, context)
    }
    if (revisionMode === "animate" || revisionMode === "animate-pixminimax") {
      return this.pollAnimateRevision(jobId, context)
    }
    if (context?.spec?.revision) return this.pollRevision(jobId)
    if (generator === "pixflux") {
      const file = path.join(PixelLabProvider.cacheDir(), `${jobId}.png`)
      if (existsSync(file)) {
        const sourceUrl = `file://${file}`
        return { status: "ready", objectId: jobId, sourceUrl, sources: [{ url: sourceUrl }] }
      }
      // The bytes only ever lived here, so a missing file means the temp dir
      // was cleared. Nothing to recover from upstream, so say so plainly.
      return {
        status: "failed",
        error: "pixflux result is no longer cached locally; re-run submit for this asset",
      }
    }
    if (generator === "map") return this.pollMap(jobId, context)
    if (generator === "tiles") return this.pollTiles(jobId, Boolean(context?.tileFeature), context)
    if (generator === "terrain") return this.pollTerrain(jobId, context)
    if (generator === "isometricTile") return this.pollIsometricTile(jobId, context)
    if (generator === "imagePro") return this.pollImagePro(jobId)
    if (generator === "character") return this.pollCharacter(jobId, context)
    if (generator === "objectPro") return this.pollObjectPro(jobId, context)

    const backgroundJobId = context?.metadata?.backgroundJobId as string | undefined
    const obj = await this.client.getObject(jobId)
    if (obj.status === "review") {
      return { status: "review", candidateUrls: obj.frame_urls ?? [], billed: await this.billedForJob(backgroundJobId) }
    }
    if (obj.status === "completed") {
      const url = firstUrl(obj.rotation_urls) ?? obj.preview_url ?? null
      return { status: "ready", objectId: obj.id, sourceUrl: url, sources: url ? [{ url }] : [], billed: await this.billedForJob(backgroundJobId) }
    }
    if (obj.status === "failed") return { status: "failed", error: "generation failed upstream" }
    return {
      status: "processing",
      progressPercent: obj.progress_percent ?? null,
      etaSeconds: obj.eta_seconds ?? null,
    }
  }

  /**
   * `reduce-colors` and `correct-pixelart` results are already on disk by
   * the time `poll` is first called — `submitRevision` wrote them
   * synchronously, the same way `pixflux`'s poll branch above checks its own
   * cache file rather than a provider resource. The billed amount, if any,
   * travels through `context.metadata.revisionUsage` since there is no
   * background job to ask afterwards the way `billedForJob` does for async
   * work.
   */
  private async pollCachedRevision(jobId: string, context?: PollContext): Promise<JobState> {
    const file = path.join(PixelLabProvider.cacheDir(), `${jobId}.png`)
    if (!existsSync(file)) {
      return {
        status: "failed",
        error: "revision result is no longer cached locally; re-run submit for this asset",
      }
    }
    const sourceUrl = `file://${file}`
    const usage = context?.metadata?.revisionUsage as PixelLabUsage | undefined
    return { status: "ready", objectId: jobId, sourceUrl, sources: [{ url: sourceUrl }], billed: billedFromUsage(usage) }
  }

  /**
   * `animate`/`animate-pixminimax` revisions: a plain background job, like
   * `pollRevision` above, but completing with an ORDERED FRAME LIST instead
   * of a single image — the same `review-set` shape `pollCharacterAnimation`
   * returns, minus any character/object resource to look the result up on
   * (there is none; this operates on a loose image). Unlike every other
   * PixelLab call this adapter makes, the completed shape for
   * `/animate-with-text-v3`/`/animate-pixminimax` has never been exercised
   * against a live account — the checks below are an informed guess (hosted
   * URLs under a plausible key name, the same `storage_urls.frames` shape
   * character animations use, or inline base64 per frame, decoded to a local
   * cache file the same way `pollRevision`'s single-image case already is)
   * rather than an observed shape, and fail loudly, naming the keys actually
   * received, for whatever the real shape turns out to be.
   */
  private async pollAnimateRevision(jobId: string, context?: PollContext): Promise<JobState> {
    const job = await this.client.getBackgroundJob(jobId)
    if (job.status === "failed") return { status: "failed", error: "animation job failed upstream" }
    if (job.status !== "completed") return { status: "processing" }
    const billed = billedFromUsage(job.usage)
    const done = (job.last_response ?? {}) as Record<string, unknown>
    const fps = context?.spec?.revision?.fps ?? 8

    const review = (frameUrls: string[]): JobState => ({
      status: "review-set",
      objectId: jobId,
      frameUrls,
      sources: frameUrls.map((url, index) => ({ url, role: `frame-${String(index).padStart(2, "0")}` })),
      fps,
      metadata: { frameSet: { fps, count: frameUrls.length } },
      billed,
    })

    for (const key of ["frame_urls", "frames", "images"]) {
      const list = done[key]
      if (!Array.isArray(list) || !list.length) continue
      const urls: string[] = []
      for (const [index, item] of list.entries()) {
        if (typeof item === "string" && item) {
          urls.push(item)
          continue
        }
        const url = (item as Record<string, unknown> | undefined)?.url
        if (typeof url === "string" && url) {
          urls.push(url)
          continue
        }
        const base64 = extractBase64(item)
        if (base64) {
          const file = path.join(PixelLabProvider.cacheDir(), `${jobId}-${index}.png`)
          writeFileSync(file, Buffer.from(base64, "base64"))
          urls.push(`file://${file}`)
          continue
        }
        break
      }
      if (urls.length === list.length) return review(urls)
    }
    const storageFrames = (done.storage_urls as { frames?: unknown } | undefined)?.frames
    if (Array.isArray(storageFrames) && storageFrames.length && storageFrames.every((f) => typeof f === "string")) {
      return review(storageFrames as string[])
    }
    return {
      status: "failed",
      error:
        `Invalid PixelLab response for animate job ${jobId}: completed with no recognized frame list ` +
        `(got: ${Object.keys(done).join(", ") || "no keys"}); update pollAnimateRevision in src/providers/pixellab.ts with the real shape`,
    }
  }

  /**
   * `/inpaint-v3` and `/edit-images-v2` both hand back a plain background
   * job with no resource of its own, polled generically at
   * `GET /background-jobs/{id}`. Confirmed live for both, and the two do not
   * match: a completed `inpaint-v3` job's `last_response.image` is a single
   * `{type: "base64", base64, width, height}`, matched by the `imageKeys`
   * branch below; a completed `edit-images-v2` job's is `last_response.images`,
   * an *array* of that same shape, matched by the `done.images` branch below
   * instead — exactly why both branches exist rather than just the first one
   * (docs/ENDPOINTS.md, docs/REVISIONS.md). Beyond these two confirmed
   * shapes, this also checks a nested `{image: {base64, format}}` and a
   * hosted URL under a handful of plausible keys, and fails loudly, naming
   * the keys it actually got, rather than guess wrong silently, for whatever
   * shape still isn't covered.
   */
  private async pollRevision(jobId: string): Promise<JobState> {
    const job = await this.client.getBackgroundJob(jobId)
    if (job.status === "failed") return { status: "failed", error: "revision job failed upstream" }
    if (job.status !== "completed") return { status: "processing" }
    const billed = billedFromUsage(job.usage)
    const done = (job.last_response ?? {}) as Record<string, unknown>

    const urlKeys = ["image_url", "download_url", "url", "output_url"]
    for (const key of urlKeys) {
      const url = done[key]
      if (typeof url === "string" && url) {
        return { status: "ready", objectId: jobId, sourceUrl: url, sources: [{ url }], billed }
      }
    }
    const imageKeys = ["image", "output_image", "result_image", "edited_image"]
    for (const key of imageKeys) {
      const candidate = done[key]
      const base64 = extractBase64(candidate)
      if (base64) {
        const file = path.join(PixelLabProvider.cacheDir(), `${jobId}.png`)
        writeFileSync(file, Buffer.from(base64, "base64"))
        const sourceUrl = `file://${file}`
        return { status: "ready", objectId: jobId, sourceUrl, sources: [{ url: sourceUrl }], billed }
      }
    }
    if (Array.isArray(done.images) && done.images.length) {
      const base64 = extractBase64(done.images[0])
      if (base64) {
        const file = path.join(PixelLabProvider.cacheDir(), `${jobId}.png`)
        writeFileSync(file, Buffer.from(base64, "base64"))
        const sourceUrl = `file://${file}`
        return { status: "ready", objectId: jobId, sourceUrl, sources: [{ url: sourceUrl }], billed }
      }
    }
    // The pipeline's poll loop treats a thrown error as transient and
    // retries it forever (nothing here would ever change): an unrecognized
    // shape is not transient, so it must come back as `failed`, the same as
    // every other unrecoverable poll outcome in this file.
    return {
      status: "failed",
      error:
        `Invalid PixelLab response for revision job ${jobId}: completed with no recognized image field ` +
        `(got: ${Object.keys(done).join(", ") || "no keys"}); update pollRevision in src/providers/pixellab.ts with the real shape`,
    }
  }

  /**
   * `/generate-image-v2` hands back a plain background job, the same as a
   * revision, but a completed one carries several candidate images to
   * review rather than a single result: the Python client's own usage
   * sample reads `response.images`, and `edit-images-v2` (a sibling Pro
   * endpoint) confirmed live that its own array lands at
   * `last_response.images` with each entry `extractBase64`-shaped, so this
   * assumes the same field name and shape here. That assumption is
   * UNVERIFIED for this specific endpoint — no live call has been made to
   * it — so an unrecognized response still fails loudly rather than
   * guessing, exactly like pollRevision.
   */
  private async pollImagePro(jobId: string): Promise<JobState> {
    const job = await this.client.getBackgroundJob(jobId)
    if (job.status === "failed") return { status: "failed", error: "imagePro job failed upstream" }
    if (job.status !== "completed") return { status: "processing" }
    const billed = billedFromUsage(job.usage)
    const done = (job.last_response ?? {}) as Record<string, unknown>
    if (Array.isArray(done.images) && done.images.length) {
      const urls: string[] = []
      for (const [index, candidate] of done.images.entries()) {
        const base64 = extractBase64(candidate)
        if (!base64) continue
        const file = path.join(PixelLabProvider.cacheDir(), `${jobId}-${index}.png`)
        writeFileSync(file, Buffer.from(base64, "base64"))
        urls.push(`file://${file}`)
      }
      if (urls.length) return { status: "review", candidateUrls: urls, billed }
    }
    return {
      status: "failed",
      error:
        `Invalid PixelLab response for imagePro job ${jobId}: completed with no recognized images array ` +
        `(got: ${Object.keys(done).join(", ") || "no keys"}); this endpoint's completed shape has not been ` +
        "exercised live yet -- update pollImagePro in src/providers/pixellab.ts with the real shape",
    }
  }

  /**
   * Map objects need their own path because the `/map-objects/{id}` record is
   * deleted upstream roughly 8 hours after creation while the image survives in
   * the objects collection. Verified: a March 2026 sprite still resolves from
   * `/objects` four months on, with `/map-objects` returning 404 for the same
   * id. So a 404 here is not evidence the work is lost.
   */
  private async pollMap(jobId: string, context?: PollContext): Promise<JobState> {
    const backgroundJobId = context?.metadata?.backgroundJobId as string | undefined
    try {
      const obj = await this.client.getMapObject(jobId)
      if (obj.status === "completed" && obj.download_url) {
        return {
          status: "ready",
          objectId: jobId,
          sourceUrl: obj.download_url,
          sources: [{ url: obj.download_url }],
          billed: await this.billedForJob(backgroundJobId),
        }
      }
      if (obj.status === "failed") return { status: "failed", error: "generation failed upstream" }
      return { status: "processing" }
    } catch (err) {
      // Like tiles, a map object answers 423 while it is still being drawn.
      if (err instanceof PixelLabError && err.status === 423) return { status: "processing" }
      if (!(err instanceof PixelLabError) || err.status !== 404) throw err
      const survivor = await this.client.getObject(jobId).catch(() => null)
      const url = firstUrl(survivor?.rotation_urls) ?? survivor?.preview_url ?? null
      if (survivor?.status === "completed" && url) {
        // The job record is exactly what expired to produce this 404 path,
        // so there is nothing left to ask for a billed amount.
        return { status: "ready", objectId: survivor.id, sourceUrl: url, sources: [{ url }], billed: null }
      }
      return {
        status: "failed",
        error: "map object record deleted upstream and no surviving image found",
      }
    }
  }

  /**
   * Tiles report progress through the HTTP status: 423 while drawing, 200 with
   * `storage_urls` once finished. There is no `status` field to read and no
   * progress percentage on offer, so "processing" here carries no ETA.
   */
  private async pollTiles(tileId: string, connectable: boolean, context?: PollContext): Promise<JobState> {
    try {
      const set = await this.client.getTilesPro(tileId)
      const tiles = tilesInIndexOrder(set.storage_urls)
      if (!tiles.length) return { status: "failed", error: "tiles job returned no storage urls" }
      const backgroundJobId = context?.metadata?.backgroundJobId as string | undefined
      const billed = await this.billedForJob(backgroundJobId)
      if (!connectable) return { status: "review", candidateUrls: tiles.map((tile) => tile.url), billed }
      return {
        status: "ready",
        objectId: tileId,
        sourceUrl: tiles[0]?.url ?? null,
        sources: tiles.map((tile) => ({
          url: tile.url,
          role: `tile-${String(tile.index).padStart(2, "0")}`,
        })),
        metadata: {
          tileKind: set.kind,
          ...(set.tile_rules ? { tileRules: set.tile_rules } : {}),
        },
        billed,
      }
    } catch (err) {
      if (err instanceof PixelLabError && err.status === 423) return { status: "processing" }
      throw err
    }
  }

  /**
   * `/create-tileset` reports progress the same way `tiles` does (423 while
   * drawing, 200 once finished), but each tile's image comes back embedded
   * as base64 rather than a `storage_urls` link, so it is decoded straight
   * to a cache file the same way a revision result is (`pollRevision`). A
   * terrain set is always a connectable Wang tileset, never independent
   * candidates to review, so this goes straight to "ready" like a connectable
   * `tiles` set does.
   */
  private async pollTerrain(tilesetId: string, context?: PollContext): Promise<JobState> {
    try {
      const { tileset, usage } = await this.client.getTileset(tilesetId)
      const backgroundJobId = context?.metadata?.backgroundJobId as string | undefined
      const billed = billedFromUsage(usage) ?? (await this.billedForJob(backgroundJobId))
      const sources: OutputSource[] = []
      const terrainTiles: Record<string, unknown>[] = []
      for (const [index, tile] of tileset.tiles.entries()) {
        const slug = tile.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "tile"
        const role = `tile-${String(index).padStart(2, "0")}-${slug}`
        const file = path.join(PixelLabProvider.cacheDir(), `${tilesetId}-${index}.png`)
        writeFileSync(file, Buffer.from(tile.image.base64, "base64"))
        sources.push({ url: `file://${file}`, role })
        terrainTiles.push({ role, corners: tile.corners, pattern4x4: tile.pattern_4x4 })
      }
      return {
        status: "ready",
        objectId: tilesetId,
        sourceUrl: sources[0]?.url ?? null,
        sources,
        metadata: { terrainTypes: tileset.terrain_types, terrainTiles },
        billed,
      }
    } catch (err) {
      if (err instanceof PixelLabError && err.status === 423) return { status: "processing" }
      throw err
    }
  }

  /**
   * `/create-isometric-tile` reports progress the same way `/create-tileset`
   * does (423 while drawing, 200 once finished, no `status` field to poll),
   * and its image also comes back embedded as base64 rather than a
   * `storage_urls` link. One call is one tile with nothing to review, so
   * this goes straight to "ready" like a connectable `tiles`/`terrain` set.
   */
  private async pollIsometricTile(tileId: string, context?: PollContext): Promise<JobState> {
    try {
      const { image, usage } = await this.client.getIsometricTile(tileId)
      const backgroundJobId = context?.metadata?.backgroundJobId as string | undefined
      const billed = billedFromUsage(usage) ?? (await this.billedForJob(backgroundJobId))
      const file = path.join(PixelLabProvider.cacheDir(), `${tileId}.png`)
      writeFileSync(file, Buffer.from(image.base64, "base64"))
      return {
        status: "ready",
        objectId: tileId,
        sourceUrl: `file://${file}`,
        billed,
      }
    } catch (err) {
      if (err instanceof PixelLabError && err.status === 423) return { status: "processing" }
      throw err
    }
  }

  async selectCandidate(
    jobId: string,
    index: number,
    commonTag?: string,
    generator?: Generator,
  ): Promise<{ objectId: string; sourceUrl: string | null }> {
    // A tiles variation is already a finished image at a stable URL; there is
    // no frame to promote and no new account object to create. The identity we
    // record is the job plus the index, which is what actually reproduces it.
    if (generator === "tiles") {
      const set = await this.client.getTilesPro(jobId)
      const url = tilesInIndexOrder(set.storage_urls)[index]?.url
      if (!url) throw new Error(`tiles job ${jobId} has no variation at index ${index}`)
      return { objectId: `${jobId}#${index}`, sourceUrl: url }
    }
    // imagePro's candidates were decoded to local files at poll time
    // (pollImagePro); there is no PixelLab account object to promote, the
    // same as pixflux never having one.
    if (generator === "imagePro") {
      const file = path.join(PixelLabProvider.cacheDir(), `${jobId}-${index}.png`)
      if (!existsSync(file)) throw new Error(`imagePro job ${jobId} has no cached candidate at index ${index}`)
      return { objectId: `${jobId}#${index}`, sourceUrl: `file://${file}` }
    }
    const promoted = await this.client.selectFrames(jobId, [index], commonTag)
    const objectId = promoted.created_object_ids?.[0]
    if (!objectId) {
      // The review parent is transient; recording its id would leave a mapping
      // that breaks once the parent is emptied. Fail loudly instead.
      throw new Error(`select-frames returned no created_object_ids for job ${jobId}`)
    }
    const obj = await this.client.getObject(objectId).catch(() => null)
    return { objectId, sourceUrl: firstUrl(obj?.rotation_urls) ?? obj?.preview_url ?? null }
  }

  async download(url: string): Promise<Buffer> {
    if (url.startsWith("file://")) return readFileSync(url.slice("file://".length))
    return this.client.download(url)
  }

  async balance(): Promise<BalanceInfo> {
    const b = await this.client.balance()
    return { unit: "generations", remaining: b.generations, total: b.total, plan: b.plan }
  }

  async setTags(objectId: string, tags: string[], generator?: Generator): Promise<void> {
    if (generator === "character") {
      // An animation records `<character>#<group>`; the tags belong to the character.
      await this.client.setCharacterTags(objectId.split("#")[0]!, tags.slice(0, 20))
      return
    }
    await this.client.setTags(objectId, tags.slice(0, 20))
  }

  async *list(): AsyncGenerator<RemoteAsset> {
    for await (const obj of this.client.iterateObjects(100)) {
      yield {
        id: obj.id,
        prompt: obj.prompt ?? "",
        width: obj.size.width,
        height: obj.size.height,
        createdAt: obj.created_at,
        previewUrl: obj.preview_url ?? null,
        tags: obj.tags ?? [],
        status: obj.status ?? "unknown",
      }
    }
  }

  async delete(assetId: string): Promise<void> {
    await this.client.deleteObject(assetId)
  }

  async *listCharacters(): AsyncGenerator<RemoteCharacter> {
    for await (const character of this.client.iterateCharacters(100)) {
      yield remoteCharacter(character)
    }
  }

  async getCharacter(id: string): Promise<RemoteCharacterDetail> {
    const character = await this.client.getCharacter(id)
    const order = character.directions === 4 ? CHARACTER_DIRECTIONS_4 : CHARACTER_DIRECTIONS_8
    const rotations: OutputSource[] = []
    for (const direction of order) {
      const url = character.rotation_urls?.[direction]
      if (url) rotations.push({ url, role: direction })
    }
    return {
      ...remoteCharacter(character),
      rotations,
      animations: character.animations.flatMap((group) =>
        group.directions.map((d) => ({
          groupId: group.animation_group_id ?? null,
          name: group.display_name ?? null,
          type: group.animation_type,
          direction: d.direction,
          frames: d.frames,
        }))),
    }
  }

  /**
   * A character's rotation and frame URLs carry its last edit time as a
   * cache-buster, so the record's URLs can name bytes a cache still holds
   * after an edit in PixelLab's editor. Objects keep stable URLs.
   */
  async refreshSources(objectId: string, context: RefreshContext): Promise<OutputSource[] | null | undefined> {
    if (context.generator !== "character") return undefined
    const [characterId, groupId] = objectId.split("#") as [string, string | undefined]
    const character = await this.client.getCharacter(characterId).catch((err: unknown) => {
      if (err instanceof PixelLabError && err.status === 404) return null
      throw err
    })
    if (!character) return null
    if (!groupId) return character.status === "completed" ? rotationSources(character) : undefined
    const recorded = (context.metadata?.character ?? {}) as { direction?: string; animationName?: string; animationId?: string | null }
    const direction = recorded.direction ?? "south"
    const group = character.animations.find((g) => g.animation_group_id === groupId)
    const frames = group?.directions.find((d) => d.direction === direction && d.frames.length)?.frames
      ?? (recorded.animationName ? findAnimation(character, recorded.animationName, direction, recorded.animationId ?? null)?.frames : undefined)
    if (!frames) return null
    return frames.map((url, index) => ({ url, role: `frame-${String(index).padStart(2, "0")}` }))
  }
}

function remoteCharacter(character: PixelLabCharacter): RemoteCharacter {
  return {
    id: character.id,
    name: character.name,
    stateName: character.state_name ?? null,
    prompt: character.prompt,
    groupId: character.group_id ?? null,
    directions: character.directions,
    width: character.size.width,
    height: character.size.height,
    createdAt: character.created_at,
    previewUrl: character.preview_url ?? character.rotation_urls?.south ?? null,
    tags: character.tags,
    status: character.status,
    animationCount: character.animation_count,
  }
}

function requirePixelLabOption(
  generator: string,
  name: string,
  value: string | undefined,
  allowed: readonly string[],
): void {
  if (value != null && !allowed.includes(value)) {
    throw new Error(`PixelLab ${generator} ${name} must be one of: ${allowed.join(", ")}`)
  }
}

/**
 * `storage_urls` is an object keyed `tile_0`, `tile_1`, and so on. JSON object order
 * is not something to rely on, and a connectable set is sliced by index, so
 * sort numerically rather than taking Object.values() as it comes.
 */
function tilesInIndexOrder(urls: Record<string, string>): Array<{ index: number; url: string }> {
  return Object.entries(urls)
    .map(([key, url]) => ({ index: Number(key.replace(/^tile_/, "")), url }))
    .filter((tile) => Number.isFinite(tile.index))
    .sort((a, b) => a.index - b.index)
}

function firstUrl(urls: Record<string, string | null> | null | undefined): string | null {
  if (!urls) return null
  return Object.values(urls).find((u): u is string => typeof u === "string") ?? null
}

/**
 * A base64 image payload in any shape seen elsewhere in this client: a bare
 * string, `{base64}`, or a nested `{image: {base64}}`. See `pollRevision`.
 */
function extractBase64(value: unknown): string | null {
  if (typeof value === "string" && value) return value
  if (value && typeof value === "object") {
    const obj = value as Record<string, unknown>
    if (typeof obj.base64 === "string" && obj.base64) return obj.base64
    if (obj.image) return extractBase64(obj.image)
  }
  return null
}

/**
 * One direction of one animation on a character, if it has landed: by the
 * name PixelKiln gave it, or by the animation id in its frame URLs.
 */
/**
 * The reference sprites as the request wants them, read now rather than at
 * resolve time so a redrawn file is caught at the spending boundary.
 */
function readReference(spec: ResolvedSpec, reference: NonNullable<ResolvedCharacter["reference"]>): Partial<Record<string, Base64Image>> {
  const images: Partial<Record<string, Base64Image>> = {}
  for (const [direction, image] of Object.entries(reference)) {
    const bytes = readFileSync(image.path)
    if (sha256(bytes) !== image.sha256) {
      throw new Error(`${spec.styleId}/${spec.assetId}: reference (${direction}) changed after the manifest was resolved: ${image.path}`)
    }
    images[direction] = { base64: bytes.toString("base64"), format: image.format }
  }
  return images
}

/** The anchor character's id, which the pipeline reads from the anchor's lock entry. */
function requireStyleObjectId(spec: ResolvedSpec, context?: SubmitContext): string {
  if (!context?.styleObjectId) {
    throw new Error(
      `${spec.styleId}/${spec.assetId} anchors its style on ${spec.character!.styleAnchor!.assetId}, ` +
        "which has no PixelLab character id in the lockfile yet; generate the anchor first",
    )
  }
  return context.styleObjectId
}

/** An image read at submit time and refused if it moved since resolve. */
function readPose(spec: ResolvedSpec, what: string, image: ResolvedReferenceImage): Base64Image {
  const bytes = readFileSync(image.path)
  if (sha256(bytes) !== image.sha256) {
    throw new Error(`${spec.styleId}/${spec.assetId}: ${what} changed after the manifest was resolved: ${image.path}`)
  }
  return { base64: bytes.toString("base64"), format: image.format }
}

/** A character's directions as output sources, south first. */
function rotationSources(character: PixelLabCharacter): OutputSource[] {
  const order = character.directions === 4 ? CHARACTER_DIRECTIONS_4 : CHARACTER_DIRECTIONS_8
  const sources: OutputSource[] = []
  for (const direction of order) {
    const url = character.rotation_urls?.[direction]
    if (url) sources.push({ url, role: direction })
  }
  return sources
}

function findAnimation(
  character: PixelLabCharacter,
  name: string,
  direction: string,
  animationId: string | null,
): { frames: string[]; groupId: string | null; animationId: string | null } | null {
  for (const group of character.animations) {
    const match = group.directions.find((d) => d.direction === direction && d.frames.length > 0)
    if (!match) continue
    const byName = group.display_name === name || group.animation_type === name
    const byId = animationId !== null && match.frames.some((url) => url.includes(`/animations/${animationId}/`))
    if (!byName && !byId) continue
    const fromUrl = /\/animations\/([^/]+)\//.exec(match.frames[0]!)?.[1] ?? null
    return { frames: match.frames, groupId: group.animation_group_id ?? null, animationId: animationId ?? fromUrl }
  }
  return null
}

/** An object's directions as output sources, south first. */
function objectRotationSources(object: PixelLabObject): OutputSource[] {
  const order = object.directions === 1 ? (["south"] as const) : CHARACTER_DIRECTIONS_8
  const sources: OutputSource[] = []
  for (const direction of order) {
    const url = object.rotation_urls?.[direction]
    if (url) sources.push({ url, role: direction })
  }
  return sources
}

/**
 * Same matching rule as `findAnimation`, adapted for `ObjectAnimationGroup`'s
 * shape: frame URLs sit under each direction's `storage_urls.frames` rather
 * than a flat `frames` array, and there is no legacy `animation_type` to
 * also match by (only `display_name`, always set here to `objectAnimationName`).
 */
function findObjectAnimation(
  object: PixelLabObject,
  name: string,
  direction: string,
  animationId: string | null,
): { frames: string[]; groupId: string | null; animationId: string | null } | null {
  for (const group of object.animations) {
    const match = group.directions.find((d) => d.direction === direction)
    const frames = match ? (match.storage_urls as { frames?: unknown }).frames : undefined
    if (!match || !Array.isArray(frames) || !frames.length || !frames.every((f) => typeof f === "string")) continue
    const byName = group.display_name === name
    const byId = animationId !== null && frames.some((url) => url.includes(`/animations/${animationId}/`))
    if (!byName && !byId) continue
    const fromUrl = /\/animations\/([^/]+)\//.exec(frames[0]!)?.[1] ?? null
    return { frames, groupId: group.animation_group_id, animationId: animationId ?? fromUrl }
  }
  return null
}
