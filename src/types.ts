import { z } from "zod"

/**
 * Which PixelLab endpoint produces the asset. The choice is mostly about cost,
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
export const GeneratorSchema = z.enum(["1dir", "map"])
export type Generator = z.infer<typeof GeneratorSchema>

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
 * So `1dir` buys candidate variety at 20-40x the price, and `map` buys
 * arbitrary (non-square) dimensions nearly free. For a single-result asset,
 * forty re-rolls of a map object cost the same as one 1dir call.
 */
export function generationCost(
  width: number,
  height: number,
  generator: Generator = "map",
): number {
  if (generator === "map") return 1
  const px = width * height
  if (px <= 1024) return 20
  if (px <= 2048) return 25
  return 40
}

const StyleImageSchema = z.object({
  /** Path to a PNG/JPEG, relative to the manifest file. Max 256x256. */
  path: z.string(),
})

export const StyleSchema = z
  .object({
    // `map` is the default because it is 20-40x cheaper and correct for any
    // asset that is not going to be rotated or animated.
    generator: GeneratorSchema.default("map"),
    /** Square edge length for `1dir`. 32-256. */
    size: z.number().int().min(32).max(256).optional(),
    view: z.string().optional(),
    /** Appended to every asset prompt in this style. Where the look is defined. */
    promptSuffix: z.string().default(""),
    /** Prepended to every asset prompt in this style. */
    promptPrefix: z.string().default(""),
    /** Style reference images. Capacity by size: <=85px -> 8, <=170px -> 4, >170px -> 1. */
    styleImages: z.array(StyleImageSchema).default([]),
    /** Output root for this style, relative to the manifest. */
    outDir: z.string(),
    /** `map` generator only. */
    outline: z.string().optional(),
    shading: z.string().optional(),
    detail: z.string().optional(),
    /** Fixed seed for reproducibility where the endpoint supports it. */
    seed: z.number().int().optional(),
    /** Tags applied to every object generated in this style, for server-side filtering. */
    tags: z.array(z.string()).default([]),
  })
  .strict()

export const AssetSchema = z
  .object({
    /** The subject. Style wrapping comes from the style's prefix/suffix. */
    prompt: z.string(),
    /** Subdirectory under the style's outDir. Optional. */
    category: z.string().optional(),
    /** Overrides the style default. `map` generator only. */
    width: z.number().int().min(16).max(400).optional(),
    height: z.number().int().min(16).max(400).optional(),
    /** Overrides the style default. `1dir` generator only. */
    size: z.number().int().min(32).max(256).optional(),
    /** Explicit output path relative to outDir. Defaults to `<category>/<id>.png`. */
    file: z.string().optional(),
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
  })
  .strict()

export const ManifestSchema = z
  .object({
    $schema: z.string().optional(),
    name: z.string(),
    styles: z.record(StyleSchema),
    assets: z.record(AssetSchema),
  })
  .strict()

export type Manifest = z.infer<typeof ManifestSchema>
export type Style = z.infer<typeof StyleSchema>
export type Asset = z.infer<typeof AssetSchema>

/**
 * One line of the lockfile: the mapping from a spec to the PixelLab object that
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
  /** The resolved prompt actually sent, kept for auditing and for adopt matching. */
  prompt: z.string(),
  width: z.number().int(),
  height: z.number().int(),

  /** Set at submit time, before the request is awaited, so a crash is recoverable. */
  jobId: z.string().nullable().default(null),
  /** For `1dir`: the multi-candidate parent object awaiting selection. */
  reviewObjectId: z.string().nullable().default(null),
  /** The chosen candidate's own object id, once selected. */
  objectId: z.string().nullable().default(null),
  candidateIndex: z.number().int().nullable().default(null),

  status: z
    .enum(["pending", "processing", "review", "selected", "downloaded", "failed"])
    .default("pending"),
  error: z.string().nullable().default(null),

  sourceUrl: z.string().nullable().default(null),

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
      }),
    )
    .default([]),

  submittedAt: z.string().nullable().default(null),
  downloadedAt: z.string().nullable().default(null),
  /** Cost in the provider's unit, recorded so spend is reported not guessed. */
  cost: z.number().int().default(0),
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
  styleId: string
  assetId: string
  generator: Generator
  prompt: string
  width: number
  height: number
  view: string
  size: number
  styleImagePaths: string[]
  outFile: string
  tags: string[]
  specHash: string
  cost: number
  candidates: number
  outline?: string
  shading?: string
  detail?: string
  seed?: number
}
