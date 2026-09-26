import { z } from "zod"

/**
 * PixelLab's per-joint keypoint, `{label, x, y, z_index}` (confirmed against
 * the live `animate_with_skeleton_v3` MCP tool schema, whose own example is
 * `{"label": "RIGHT KNEE", "x": 0.52, "y": 0.71, "z_index": 9}`). Field names
 * are snake_case here, breaking this codebase's usual camelCase convention —
 * deliberately: this is a serialized PixelLab API payload, not manifest
 * prose. The realistic authoring path is `pixelkiln estimate-skeleton` →
 * dump the response to disk unmodified → hand-tweak a few joints for
 * in-between frames. Renaming fields would make that a lossy round trip.
 *
 * `label` is left a free string, not an enum of the 18 canonical joint
 * names: the exhaustive list and exact spelling of all 18 is not confirmed
 * anywhere this codebase can read from (only "RIGHT KNEE" is known, as an
 * example). Guessing the other 17 and getting one wrong would silently
 * reject a valid request. No client-side content validation of `label`
 * beyond requiring one — matching this codebase's existing precedent of
 * letting PixelLab's API reject what it rejects rather than gating on an
 * assumed vocabulary (no other PixelLab call in this codebase validates
 * field *content* client-side, only shape/range).
 */
export const SkeletonKeypointSchema = z
  .object({
    label: z.string().min(1),
    x: z.number().min(0).max(1),
    y: z.number().min(0).max(1),
    z_index: z.number(),
    depth: z.number().optional(),
  })
  .strict()
export type SkeletonKeypoint = z.infer<typeof SkeletonKeypointSchema>

/** One frame's full rig: PixelLab always wants all 18 joints per frame. */
export const SkeletonFrameSchema = z.array(SkeletonKeypointSchema).length(18)

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
