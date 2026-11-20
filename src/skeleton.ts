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

/** Which side of the body a custom rig's joint is on, seen from the camera. */
export const RIG_SIDES = ["near", "mid", "far"] as const

/**
 * One joint of a custom rig, as PixelLab's `/estimate-custom-skeleton` returns
 * it and `/animate-with-skeleton-v3` takes it: a name unique in the rig, its
 * parent (null for the one root), its side, and the humanoid joint it stands
 * for when it is one of the 18.
 */
export const RigJointSchema = z
  .object({
    name: z.string().min(1),
    parent: z.string().min(1).nullable(),
    side: z.enum(RIG_SIDES),
    estimate: z.enum(SKELETON_LABELS).nullable().optional(),
  })
  .strict()
export type RigJoint = z.infer<typeof RigJointSchema>

/** PixelLab's limits: 2 to 64 joints, names unique, exactly one root, every parent listed before its children. */
export const SkeletonRigSchema = z
  .array(RigJointSchema)
  .min(2)
  .max(64)
  .superRefine((rig, context) => {
    const seen = new Set<string>()
    let roots = 0
    for (const [index, joint] of rig.entries()) {
      if (seen.has(joint.name)) {
        context.addIssue({ code: z.ZodIssueCode.custom, message: `joint "${joint.name}" appears twice`, path: [index, "name"] })
      }
      if (joint.parent === null) roots++
      else if (!seen.has(joint.parent)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: `"${joint.name}" hangs from "${joint.parent}", which is not listed before it`,
          path: [index, "parent"],
        })
      }
      seen.add(joint.name)
    }
    if (roots !== 1) context.addIssue({ code: z.ZodIssueCode.custom, message: `a rig has exactly one root joint; this one has ${roots}` })
  })

/** A joint of a custom rig's pose: like `SkeletonKeypoint`, but named by the rig. */
export const RigKeypointSchema = z
  .object({
    label: z.string().min(1),
    x: z.number().min(0).max(1),
    y: z.number().min(0).max(1),
    z_index: z.number(),
    depth: z.number().optional(),
  })
  .strict()
export type PoseJoint = z.infer<typeof RigKeypointSchema>

/**
 * The whole committed keypoints file a `revision.keypointsFile` path must
 * parse as: the pose the reference image is already in, plus the per-frame
 * motion. Without `rig` every pose is PixelLab's 18 humanoid joints and there
 * are 3 to 15 frames. With `rig` (from `pixelkiln estimate-skeleton
 * --custom`), every pose names each of the rig's joints once and 1 to 15
 * frames are allowed. `frames` may be left empty when the revision has
 * PixelLab write the motion (`writeMotionFrames`); that is checked where the
 * revision is, not here. `kind` is what PixelLab said the rig is (`person`,
 * `four-legged` or `other`), kept to pick the template.
 */
export const SkeletonSetSchema = z
  .object({
    rig: SkeletonRigSchema.optional(),
    kind: z.enum(["person", "four-legged", "other"]).nullable().optional(),
    firstFrameKeypoints: z.array(RigKeypointSchema),
    frames: z.array(z.array(RigKeypointSchema)).max(15).default([]),
  })
  .strict()
  .superRefine((set, context) => {
    const poses: Array<[PoseJoint[], Array<string | number>]> = [
      [set.firstFrameKeypoints, ["firstFrameKeypoints"]],
      ...set.frames.map((frame, index): [PoseJoint[], Array<string | number>] => [frame, ["frames", index]]),
    ]
    if (!set.rig && set.frames.length > 0 && set.frames.length < 3) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: "18-joint poses need 3 to 15 frames (a custom rig takes 1)", path: ["frames"] })
    }
    for (const [pose, where] of poses) {
      if (set.rig) {
        const names = set.rig.map((joint) => joint.name)
        const labels = pose.map((joint) => joint.label)
        const missing = names.filter((name) => !labels.includes(name))
        const extra = labels.filter((label) => !names.includes(label))
        const twice = labels.filter((label, index) => labels.indexOf(label) !== index)
        if (missing.length || extra.length || twice.length) {
          context.addIssue({
            code: z.ZodIssueCode.custom,
            message: [
              missing.length ? `missing ${missing.slice(0, 3).join(", ")}` : "",
              extra.length ? `not in the rig: ${extra.slice(0, 3).join(", ")}` : "",
              twice.length ? `twice: ${twice.slice(0, 3).join(", ")}` : "",
            ].filter(Boolean).join("; "),
            path: where,
          })
        }
      } else {
        const result = SkeletonFrameSchema.safeParse(pose)
        if (!result.success) {
          const issue = result.error.issues[0]!
          context.addIssue({ code: z.ZodIssueCode.custom, message: issue.message, path: [...where, ...issue.path] })
        }
      }
    }
  })
export type SkeletonSet = z.infer<typeof SkeletonSetSchema>

/**
 * The bones to draw for a pose: the 18-joint layout, or each rig joint to its
 * parent. Pairs name joints by label.
 */
export function skeletonBones(set: Pick<SkeletonSet, "rig">): ReadonlyArray<readonly [string, string]> {
  if (!set.rig) return SKELETON_BONES
  return set.rig.flatMap((joint) => (joint.parent ? [[joint.parent, joint.name] as const] : []))
}

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
export function scaffoldSkeletonSet(
  keypoints: PoseJoint[],
  frames = DEFAULT_SCAFFOLD_FRAMES,
  rig?: { rig: RigJoint[]; kind?: SkeletonSet["kind"] },
): SkeletonSet {
  const copy = () => keypoints.map((joint) => ({ ...joint }))
  return {
    ...(rig ? { rig: rig.rig, ...(rig.kind ? { kind: rig.kind } : {}) } : {}),
    firstFrameKeypoints: copy(),
    frames: Array.from({ length: frames }, copy),
  }
}
