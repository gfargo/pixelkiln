import { existsSync } from "node:fs"
import { mkdir, readFile, rm, writeFile } from "node:fs/promises"
import path from "node:path"
import { z } from "zod"
import { clientFromEnv, type PixelLabClient } from "../client.ts"
import { sha256 } from "../hash.ts"
import { applyManifestEdit, ManifestEditError } from "../manifest-edit.ts"
import { imageMetadata } from "../media.ts"
import {
  DEFAULT_SCAFFOLD_FRAMES,
  estimateSkeletonSizeProblem,
  scaffoldSkeletonSet,
  SkeletonSetSchema,
  type SkeletonSet,
} from "../skeleton.ts"
import { CharacterDirectionSchema, lockKey, type ResolvedSpec } from "../types.ts"
import type { GalleryProjectContext } from "./generate.ts"

/**
 * The gallery's skeleton-animation path: estimate a skeleton for a sprite,
 * then write the keypoints file and declare the `animate-skeleton` revision
 * in one step. Both sit behind `--edit`, since both act on the author's
 * behalf; estimating is a direct, un-budgeted PixelLab call, like the
 * `estimate-skeleton` command, and the page asks before making it.
 */

export const SkeletonEstimateRequestSchema = z
  .object({
    project: z.string().min(1).optional(),
    styleId: z.string().min(1),
    assetId: z.string().min(1),
    frames: z.number().int().min(3).max(15).optional(),
  })
  .strict()

export const SkeletonAnimationRequestSchema = z
  .object({
    action: z.literal("create-skeleton-animation"),
    project: z.string().min(1).optional(),
    expectedSha256: z.string().regex(/^[0-9a-f]{64}$/),
    styleId: z.string().min(1),
    /** The sprite the animation poses. */
    from: z.string().min(1),
    assetId: z.string().min(1).regex(/^[^/\\]+$/, "asset ids cannot contain slashes"),
    /** The motion, sent as PixelLab's `action`. */
    prompt: z.string().min(1),
    direction: CharacterDirectionSchema,
    description: z.string().min(1).optional(),
    skeletonTemplate: z.string().min(1).optional(),
    /** Manifest-relative JSON path inside the project. */
    keypointsFile: z.string().min(1),
    /** Poses to write to `keypointsFile`; omitted to use a file that already exists. */
    set: SkeletonSetSchema.optional(),
    /** Replace an existing `keypointsFile` with `set`. */
    overwrite: z.boolean().optional(),
  })
  .strict()

/** New poses for an existing `animate-skeleton` revision's keypoints file, from the page's pose editor. */
export const SkeletonKeypointsUpdateSchema = z
  .object({
    action: z.literal("update-skeleton-keypoints"),
    project: z.string().min(1).optional(),
    styleId: z.string().min(1),
    assetId: z.string().min(1),
    /** The file's SHA-256 when the page loaded it; anything else on disk is a concurrent edit. */
    expectedSha256: z.string().regex(/^[0-9a-f]{64}$/),
    set: SkeletonSetSchema,
  })
  .strict()

type EstimateClient = Pick<PixelLabClient, "estimateSkeleton">

/**
 * Estimates this gallery session has made, against its cap, and what
 * PixelLab reported billing for them, in whatever unit each response named.
 * Kept apart from the generation budget: PixelLab documents this endpoint in
 * dollars, and dollars do not convert to generations.
 */
export interface SkeletonEstimateSession {
  used: number
  limit: number
  spent: Record<string, number>
}

export interface GallerySkeletonHandlers {
  estimate(body: unknown): Promise<{ set: SkeletonSet; source: string; session: SkeletonEstimateSession }>
  status(): SkeletonEstimateSession
}

/** Estimates a gallery session may make unless `--estimate-limit` says otherwise. */
export const DEFAULT_ESTIMATE_LIMIT = 10

/** The one image an asset shows: its hand edit, its refined output, or its generated file. */
export function skeletonSourceFile(spec: ResolvedSpec): string {
  if (spec.source) return path.resolve(spec.root, spec.source)
  if (spec.quality && existsSync(spec.quality.outFile)) return spec.quality.outFile
  return spec.outFile
}

export function createGallerySkeletonHandlers(opts: {
  loadProject: (project?: string) => Promise<GalleryProjectContext>
  /** Test hook; defaults to the environment's PixelLab key, loaded with the project. */
  client?: () => EstimateClient
  /** Estimates this session may make; a stuck page or a repeated click cannot run past it. */
  limit?: number
  onProgress?: (msg: string) => void
}): GallerySkeletonHandlers {
  const log = opts.onProgress ?? (() => {})
  const limit = opts.limit ?? DEFAULT_ESTIMATE_LIMIT
  let used = 0
  const spent: Record<string, number> = {}
  const status = (): SkeletonEstimateSession => ({ used, limit, spent: { ...spent } })
  return {
    status,
    async estimate(body) {
      const parsed = SkeletonEstimateRequestSchema.safeParse(body)
      if (!parsed.success) throw new ManifestEditError(`invalid estimate request: ${parsed.error.issues[0]?.message}`)
      const request = parsed.data
      const ctx = await opts.loadProject(request.project)
      const key = lockKey(request.styleId, request.assetId)
      const spec = ctx.specs.find((candidate) => lockKey(candidate.styleId, candidate.assetId) === key)
      if (!spec) throw new ManifestEditError(`"${key}" is not declared by the manifest`)
      const file = skeletonSourceFile(spec)
      if (!existsSync(file)) throw new ManifestEditError(`${key} has no image on disk to estimate from`)
      const bytes = await readFile(file)
      const metadata = imageMetadata(bytes)
      if (!metadata) throw new ManifestEditError(`${path.basename(file)} is not a readable PNG or JPEG`)
      const problem = estimateSkeletonSizeProblem(metadata.width, metadata.height)
      if (problem) throw new ManifestEditError(`${key} is ${problem}`)
      if (used >= limit) {
        throw Object.assign(
          new Error(`this gallery has made its ${limit} skeleton estimate${limit === 1 ? "" : "s"}; restart it with --estimate-limit to allow more`),
          { status: 429 },
        )
      }
      const client = (opts.client ?? clientFromEnv)()
      // Counted before the call: a request that fails after reaching
      // PixelLab may still have been billed.
      used++
      const res = await client.estimateSkeleton({ image: { base64: bytes.toString("base64"), format: metadata.format } })
      const billed = billedAmount(res.usage)
      if (billed) spent[billed.unit] = (spent[billed.unit] ?? 0) + billed.amount
      log(`  estimated a skeleton for ${key} (PixelLab estimate-skeleton, ${used}/${limit} this session${billed ? `, billed ${billed.amount} ${billed.unit}` : ""})`)
      return {
        set: scaffoldSkeletonSet(res.keypoints, request.frames ?? DEFAULT_SCAFFOLD_FRAMES),
        source: path.relative(ctx.loaded.root, file).split(path.sep).join("/"),
        session: status(),
      }
    },
  }
}

/** What a PixelLab `usage` object says was billed, in its own unit; null when it says nothing usable. */
function billedAmount(usage: unknown): { unit: string; amount: number } | null {
  if (!usage || typeof usage !== "object") return null
  const { type } = usage as { type?: unknown }
  if (type !== "usd" && type !== "generations") return null
  const amount = (usage as Record<string, unknown>)[type]
  return typeof amount === "number" && Number.isFinite(amount) ? { unit: type, amount } : null
}

/**
 * Writes the keypoints file (when the page sent poses) and adds the
 * revision. A file this call created is removed again, and one it replaced
 * is put back, when the manifest refuses the asset, so a failed save leaves
 * the project as it was.
 */
export async function createSkeletonAnimation(
  manifestPath: string,
  request: z.infer<typeof SkeletonAnimationRequestSchema>,
): Promise<void> {
  const root = path.dirname(path.resolve(manifestPath))
  const file = path.resolve(root, request.keypointsFile)
  const relative = path.relative(root, file)
  if (!request.keypointsFile.endsWith(".json") || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new ManifestEditError("the keypoints file must be a .json path inside the project")
  }
  const existed = existsSync(file)
  let previous: Buffer | null = null
  if (request.set) {
    if (existed && !request.overwrite) {
      throw new ManifestEditError(`${request.keypointsFile} already exists; choose another path, or replace it`)
    }
    if (existed) previous = await readFile(file)
    await mkdir(path.dirname(file), { recursive: true })
    await writeFile(file, JSON.stringify(request.set, null, 2) + "\n")
  } else if (!existed) {
    throw new ManifestEditError(`${request.keypointsFile} does not exist; paste poses or estimate them from the sprite`)
  }

  try {
    await applyManifestEdit(manifestPath, {
      action: "add-asset",
      assetId: request.assetId,
      expectedSha256: request.expectedSha256,
      asset: {
        prompt: request.prompt,
        styles: [request.styleId],
        revision: {
          mode: "animate-skeleton",
          from: request.from,
          keypointsFile: relative.split(path.sep).join("/"),
          direction: request.direction,
          ...(request.description ? { description: request.description } : {}),
          ...(request.skeletonTemplate ? { skeletonTemplate: request.skeletonTemplate } : {}),
        },
      },
    })
  } catch (error) {
    if (request.set) {
      if (previous) await writeFile(file, previous)
      else await rm(file, { force: true })
    }
    throw error
  }
}

/**
 * Rewrites an `animate-skeleton` revision's keypoints file with the poses
 * the page edited. The file is found from the manifest, never from the
 * request, and must still hold the bytes the page loaded: a hand edit or a
 * second tab since then is refused rather than overwritten. The new bytes
 * change the revision's identity, so `plan` shows it stale until it is
 * generated again.
 */
export async function updateSkeletonKeypoints(
  ctx: GalleryProjectContext,
  request: z.infer<typeof SkeletonKeypointsUpdateSchema>,
): Promise<string> {
  const key = lockKey(request.styleId, request.assetId)
  const spec = ctx.specs.find((candidate) => lockKey(candidate.styleId, candidate.assetId) === key)
  if (!spec) throw new ManifestEditError(`"${key}" is not declared by the manifest`)
  const file = spec.revision?.mode === "animate-skeleton" ? spec.revision.keypointsFile : undefined
  if (!file) throw new ManifestEditError(`${key} is not an animate-skeleton revision`)
  const relative = path.relative(ctx.loaded.root, file)
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new ManifestEditError(`${key}'s keypoints file is outside the project; edit it by hand`)
  }
  const current = existsSync(file) ? sha256(await readFile(file)) : null
  if (current !== request.expectedSha256) {
    throw Object.assign(
      new Error(`${relative.split(path.sep).join("/")} changed on disk since this page loaded it; press Refresh and edit again`),
      { status: 409 },
    )
  }
  await writeFile(file, JSON.stringify(request.set, null, 2) + "\n")
  return relative.split(path.sep).join("/")
}
