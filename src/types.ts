import { z } from "zod"

/**
 * A "generator" is which PixelLab endpoint produces the asset. They differ in
 * ways that matter to the pipeline, not just cosmetically:
 *
 *   1dir  POST /create-1-direction-object
 *         Square only (one `size`). Objects PERSIST indefinitely and keep a
 *         stable public URL. At size <= 170 the call returns multiple candidate
 *         frames for the same fixed cost, which then need a selection step.
 *
 *   map   POST /map-objects
 *         Arbitrary width x height. Returns exactly one result, no selection
 *         step. Objects AUTO-DELETE AFTER 8 HOURS, so the download is not
 *         resumable later — `fetch` must run the same day as `submit`.
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
 * Generation cost per call, by canvas tier. Fixed per call — it does NOT scale
 * with how many candidates come back, which is the whole economic argument for
 * generating small and picking from many.
 */
export function generationCost(width: number, height: number): number {
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
    generator: GeneratorSchema.default("1dir"),
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
  file: z.string().nullable().default(null),
  fileSha256: z.string().nullable().default(null),

  submittedAt: z.string().nullable().default(null),
  downloadedAt: z.string().nullable().default(null),
  /** Cost in generations, recorded so spend can be reported without guessing. */
  cost: z.number().int().default(0),
})

export const LockSchema = z.object({
  version: z.literal(1),
  entries: z.record(LockEntrySchema),
})

export type LockEntry = z.infer<typeof LockEntrySchema>
export type Lock = z.infer<typeof LockSchema>

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
