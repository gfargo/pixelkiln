import { z } from "zod"

/**
 * The 18 joints PixelLab's skeleton endpoints use, in the order of the
 * `label` enum in the v2 OpenAPI document (`/estimate-skeleton`'s keypoint).
 * "ARM" and "LEG" are the wrist and ankle ends of each limb.
 */
export const SKELETON_LABELS = [
  "NOSE", "NECK",
  "RIGHT SHOULDER", "RIGHT ELBOW", "RIGHT ARM",
  "LEFT SHOULDER", "LEFT ELBOW", "LEFT ARM",
  "RIGHT HIP", "RIGHT KNEE", "RIGHT LEG",
  "LEFT HIP", "LEFT KNEE", "LEFT LEG",
  "RIGHT EYE", "LEFT EYE", "RIGHT EAR", "LEFT EAR",
] as const
export type SkeletonLabel = (typeof SKELETON_LABELS)[number]

/** Joint pairs drawn as bones, the usual 18-point body layout. */
export const SKELETON_BONES: ReadonlyArray<readonly [SkeletonLabel, SkeletonLabel]> = [
  ["NOSE", "NECK"],
  ["NECK", "RIGHT SHOULDER"], ["RIGHT SHOULDER", "RIGHT ELBOW"], ["RIGHT ELBOW", "RIGHT ARM"],
  ["NECK", "LEFT SHOULDER"], ["LEFT SHOULDER", "LEFT ELBOW"], ["LEFT ELBOW", "LEFT ARM"],
  ["NECK", "RIGHT HIP"], ["RIGHT HIP", "RIGHT KNEE"], ["RIGHT KNEE", "RIGHT LEG"],
  ["NECK", "LEFT HIP"], ["LEFT HIP", "LEFT KNEE"], ["LEFT KNEE", "LEFT LEG"],
  ["NOSE", "RIGHT EYE"], ["RIGHT EYE", "RIGHT EAR"],
  ["NOSE", "LEFT EYE"], ["LEFT EYE", "LEFT EAR"],
]

/**
 * PixelLab's per-joint keypoint, `{label, x, y, z_index}`, with `x`/`y` as
 * fractions of the image (the MCP tool's own example is `{"label": "RIGHT
 * KNEE", "x": 0.52, "y": 0.71, "z_index": 9}`). Field names are snake_case,
 * breaking this codebase's usual camelCase convention, deliberately: this is
 * a serialized PixelLab payload, and `pixelkiln estimate-skeleton` writes the
 * response to disk as it came, so renaming would make that a lossy round trip.
 *
 * `label` is one of the 18 names the OpenAPI document enumerates, so a typo
 * fails when the manifest loads instead of after a paid call.
 */
export const SkeletonKeypointSchema = z
  .object({
    label: z.enum(SKELETON_LABELS),
    x: z.number().min(0).max(1),
    y: z.number().min(0).max(1),
    z_index: z.number(),
    depth: z.number().optional(),
  })
  .strict()
export type SkeletonKeypoint = z.infer<typeof SkeletonKeypointSchema>

/** One frame's full rig: PixelLab always wants all 18 joints per frame, each once. */
export const SkeletonFrameSchema = z
  .array(SkeletonKeypointSchema)
  .length(18)
  .superRefine((frame, context) => {
    const seen = new Set<string>()
    for (const [index, joint] of frame.entries()) {
      if (seen.has(joint.label)) {
        context.addIssue({ code: z.ZodIssueCode.custom, message: `"${joint.label}" appears twice`, path: [index, "label"] })
      }
      seen.add(joint.label)
    }
  })

/**
 * The whole committed keypoints file a `revision.keypointsFile` path must
 * parse as: the pose the reference image is already in, plus the per-frame
 * motion (3-15 frames, PixelLab's own documented ceiling).
 */
export const SkeletonSetSchema = z
  .object({
    firstFrameKeypoints: SkeletonFrameSchema,
    frames: z.array(SkeletonFrameSchema).min(3).max(15),
  })
  .strict()
export type SkeletonSet = z.infer<typeof SkeletonSetSchema>

/**
 * Parses and validates already-loaded JSON. Pure — no I/O. Throws naming the
 * file and the first few validation issues, the same truncated-issue-list
 * convention `validateResponse` (`src/client.ts`) already uses for a
 * provider response mismatch.
 */
export function parseSkeletonSet(json: unknown, file: string): SkeletonSet {
  const result = SkeletonSetSchema.safeParse(json)
  if (!result.success) {
    const issues = result.error.issues
      .slice(0, 4)
      .map((issue) => `${issue.path.join(".") || "root"}: ${issue.message}`)
      .join("; ")
    throw new Error(`revision keypoints file ${file} does not match the expected shape: ${issues}`)
  }
  return result.data
}

/** `/estimate-skeleton`'s own documented sizes: square, 16 to 256. */
export const ESTIMATE_SKELETON_SIZES = [16, 32, 64, 128, 256] as const

/** Why `/estimate-skeleton` would refuse an image this size, or null when it takes it. */
export function estimateSkeletonSizeProblem(width: number, height: number): string | null {
  return width === height && (ESTIMATE_SKELETON_SIZES as readonly number[]).includes(width)
    ? null
    : `${width}x${height}; estimate-skeleton takes a square image of ${ESTIMATE_SKELETON_SIZES.join(", ")} pixels`
}

/** Frames `estimate-skeleton` scaffolds by default: a short cycle to edit. */
export const DEFAULT_SCAFFOLD_FRAMES = 4

/**
 * A keypoints file ready to edit: the estimated pose as the pose the image
 * is already in, and `frames` copies of it to move into the motion. Each copy
 * is its own object, so editing one frame never edits another.
 */
export function scaffoldSkeletonSet(keypoints: SkeletonKeypoint[], frames = DEFAULT_SCAFFOLD_FRAMES): SkeletonSet {
  const copy = () => keypoints.map((joint) => ({ ...joint }))
  return { firstFrameKeypoints: copy(), frames: Array.from({ length: frames }, copy) }
}
