import { z } from "zod"

const MediaTypeSchema = z.enum(["image/png", "image/gif"])

/**
 * Which provider capability produces the asset. The choice is mostly about cost,
 * and the gap is enormous — all figures measured against a live account.
 *
 *   map   POST /map-objects — THE DEFAULT.
 *         A flat 1 generation at any size. Purpose-built for standalone props
 *         with transparent backgrounds, which is what an icon or a prop is.
 *         Arbitrary width x height. Returns exactly one result, so there is no
 *         selection step: if you dislike it, re-roll for 1 more.
 *
 *   1dir  POST /create-1-direction-object — 20-40 generations.
 *         The single-facing sibling of create-8-direction-object, meant for
 *         objects you may later want rotations or animations of. Square only.
 *         Returns 4-64 candidates for its one fixed price, which is genuinely
 *         useful when you want to compare options side by side — but at 40x the
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
 *   INLINE with no polling, and accepts `color_image` — a forced palette that
 *   constrains output to exact hex values. Verified: a four-colour Game Boy
 *   swatch produced output containing precisely those four colours. The same
 *   parameter on /map-objects returns a 500, so the palette lock is
 *   pixflux-only. Its rendering is flatter than 1dir's.
 */
export const GeneratorSchema = z.enum(["1dir", "map", "pixflux", "tiles", "animation", "frames"])
export type Generator = z.infer<typeof GeneratorSchema>

export const GridConfidenceSchema = z.enum(["low", "medium", "high"])
export type GridConfidence = z.infer<typeof GridConfidenceSchema>

export const RevisionModeSchema = z.enum(["image-to-image", "inpaint", "outpaint"])
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
  const px = width * height
  if (px <= 1024) return 20
  if (px <= 2048) return 25
  return 40
}

/**
 * Cost of one `tiles` call. Same canvas tiers as `1dir`, but the canvas is the
 * sheet the API lays the variations out on, not one tile — so tile size alone
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

/** A provider generation whose visual starting point is another manifest asset. */
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
  })

export type Revision = z.infer<typeof RevisionSchema>

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
  maskFile?: string
  maskSha256?: string | null
  maskWidth?: number | null
  maskHeight?: number | null
  maskFormat?: "png" | "jpeg" | null
  strength?: number
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
     * `tiles` generator only. Edge length of one tile, 16-256.
     *
     * Ignored when `styleImages` is set — style mode takes the tile's shape
     * and dimensions from the reference image, which is the whole reason to
     * use it against an existing sheet.
     */
    tileSize: z.number().int().min(16).max(256).optional(),
    /** `tiles` generator only. Defaults to the API's `isometric`. */
    tileType: z
      .enum(["hex", "hex_pointy", "isometric", "oblique", "octagon", "square_topdown"])
      .optional(),
    /** `tiles` generator only. Defaults to the API's `low top-down`. */
    tileView: z.enum(["top-down", "high top-down", "low top-down", "side"]).optional(),
    /**
     * `tiles` generator only. Asks for a connectable set instead of
     * independent variations:
     *
     *   roads    18-configuration path set
     *   tileset  16-tile Wang corner set for a terrain transition — describe
     *            the asset as the transition itself ("fairway grass to rough
     *            meadow"), not as one terrain
     *   building floor/wall/doorway construction kit
     *
     * A consumer slices these by index, so the order the API returns them in
     * is load-bearing; do not sort a connectable set by anything else.
     */
    tileFeature: z.enum(["roads", "tileset", "building"]).optional(),
    /**
     * `tiles` generator only. How tile edges are drawn.
     *
     * The API default is `outline`, which draws a dark border around every
     * tile. That is right for tiles meant to read as discrete objects and
     * wrong for ground: laid on a grid, the per-tile borders turn a continuous
     * surface into visible quilting, with a dark seam at every cell edge.
     * `segmentation` omits them and the same set tiles seamlessly.
     *
     * Measured on a fairway-to-rough terrain set — the difference decided
     * whether the art was usable at all, so it is worth setting deliberately
     * rather than inheriting.
     */
    outlineMode: z.enum(["outline", "segmentation"]).optional(),
    /**
     * `pixflux` only. Whether to strip the generated background.
     *
     * Defaults to true, which is right for the sprites this tool was built
     * for — a prop or an icon wants to sit on whatever is behind it. It is
     * wrong for anything that IS a scene: a cover banner, a splash, a
     * backdrop. The API's own default is false; forcing it true unconditionally
     * meant a full-bleed image came back as a small subject floating in a
     * mostly-empty frame, and prose asking for an "opaque background" does not
     * override it.
     */
    noBackground: z.boolean().default(true),
    /** Fixed seed for reproducibility where the endpoint supports it. */
    seed: z.number().int().optional(),
    /**
     * Forced palette, as `#rrggbb` values. `pixflux` only.
     *
     * Unlike prose, this is a hard constraint — the API is handed a swatch
     * image and the output is limited to those colours. Verified: a four-colour
     * Game Boy palette produced output containing exactly those four values.
     * Prose asking for the same thing does not reliably hold, which is why the
     * map-generated monochrome sets came back with a yellow star and a brown
     * chocolate bar.
     */
    palette: z
      .array(HexColorSchema)
      .default([]),
    /** Fail-closed native-grid, palette, and human-approval policy for derived art. */
    quality: QualityProfileSchema.optional(),
    /**
     * Composites this style's assets into declared cells of a sheet, rather
     * than letting `pack` derive a layout. Use it when the atlas coordinates
     * are already load-bearing somewhere else — a tile engine naming tiles by
     * cell, or saved data storing cell indices — since `pack`'s id-sorted grid
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
   * than a `submit` discovering it after the run has started — and the two
   * are individually the best reasons to use this generator, so reaching for
   * both at once is an easy mistake to make.
   */
  .refine((s) => !(s.tileFeature && s.styleImages.length), {
    message:
      "tileFeature and styleImages cannot be combined — a connectable set " +
      "derives its own tile geometry, so remove one or the other",
    path: ["tileFeature"],
  })
  .superRefine((style, ctx) => {
    if (style.quality && (style.generator === "tiles" || style.generator === "animation")) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "quality profiles currently support single-image generators only",
        path: ["quality"],
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
    /** The subject. Style wrapping comes from the style's prefix/suffix. */
    prompt: z.string(),
    /** Subdirectory under the style's outDir. Optional. */
    category: z.string().optional(),
    /** Overrides the style default. `map` generator only. */
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
     * sheet — when that is not the raw generated output.
     *
     * `mount` otherwise takes its pixels from the lockfile, which records
     * what the API returned. That is the wrong file whenever the art needs a
     * step pixelkiln does not perform: a palette reduction onto a sheet's
     * closed palette, a hand touch-up, an alignment shift. Without somewhere
     * to say so, the choice is to mount the unprocessed art or to abandon
     * `mount` and composite by hand — and the hand-composited sheet is
     * exactly the unreproducible artifact `mount` exists to replace.
     *
     * An asset with a `source` needs no lockfile entry at all, so art
     * generated outside pixelkiln can still be placed by cell alongside art
     * that wasn't. `prompt` still records what was asked for.
     */
    source: z.string().optional(),
    /** Controlled generation derived from another asset in the same style. */
    revision: RevisionSchema.optional(),
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
    if (asset.source && asset.revision) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "source and revision are mutually exclusive",
        path: ["revision"],
      })
    }
  })

export const ManifestSchema = z
  .object({
    $schema: z.string().optional(),
    name: z.string(),
    /** Generation backend. Existing manifests remain PixelLab by default. */
    provider: z.string().min(1).default("pixellab"),
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
 * did not exist before — without it, generated objects and downloaded files are
 * two unrelated piles.
 */
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
   * expand into many — an animated character is ~35 spritesheets plus an engine
   * resource — need the list, which is why v1's single `file` became this.
   *
   * `role` labels non-primary artifacts (e.g. "portrait", "spriteframes") so a
   * consumer can find the one it wants without pattern-matching on paths.
   */
  outputs: z
    .array(
      z.object({
        path: z.string(),
        sha256: z.string(),
        role: z.string().optional(),
        mediaType: MediaTypeSchema.optional(),
      }),
    )
    .default([]),

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
  /** Which provider produced this. Absent on entries written before providers. */
  provider: z.string().default("pixellab"),
})

export const LockSchema = z.object({
  version: z.literal(2),
  entries: z.record(LockEntrySchema),
})

export type LockEntry = z.infer<typeof LockEntrySchema>
export type Lock = z.infer<typeof LockSchema>
export type LockOutput = LockEntry["outputs"][number]

/**
 * Parses a lockfile, rejecting anything that is not v2.
 *
 * There is deliberately no migration path. Both consuming projects were
 * onboarded after v2 landed, so a v1 file would be a corruption or a
 * hand-edit rather than a legacy artifact — better to fail loudly than to
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

/** The file a consumer means when it says "the asset" — the first output. */
export function primaryOutput(entry: LockEntry): LockOutput | null {
  return entry.outputs.find((o) => !o.role) ?? entry.outputs[0] ?? null
}

/** Lock entries are keyed `<styleId>/<assetId>`, which makes styles a namespace. */
export function lockKey(styleId: string, assetId: string): string {
  return `${styleId}/${assetId}`
}

/** A manifest entry resolved against its style — everything needed to generate. */
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
  /** Forced palette hex values; empty unless the style sets one. */
  palette: string[]
  /** `pixflux` only — strip the generated background. Defaults to true. */
  noBackground: boolean
  /** `tiles` generator only — see StyleSchema for what each one means. */
  tileSize?: number
  tileType?: string
  tileView?: string
  tileFeature?: string
  outlineMode?: string
}
