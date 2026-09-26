import path from "node:path"
import { z } from "zod"
import {
  applyManifestEdit,
  ManifestEditError,
  ManifestEditSchema,
  priceManifestEdit,
  type ManifestEdit,
  type ManifestEditPrice,
} from "../manifest-edit.ts"
import { detachHandEdit, MAX_HAND_EDIT_BYTES, openInEditor, saveHandEdit, startHandEdit } from "../pipeline/hand-edit.ts"
import { lockKey, type ResolvedSpec } from "../types.ts"
import type { GalleryProjectContext } from "./generate.ts"
import { saveProjectImage, UploadImageSchema } from "./upload.ts"
import {
  createSkeletonAnimation,
  SkeletonAnimationRequestSchema,
  SkeletonKeypointsUpdateSchema,
  updateSkeletonKeypoints,
} from "./skeleton.ts"
import type { GalleryBuild } from "./snapshot.ts"

/** Standard base64, sized so a decoded payload cannot exceed the edit limit. */
const Base64 = z.string().regex(/^[A-Za-z0-9+/]*={0,2}$/).max(Math.ceil(MAX_HAND_EDIT_BYTES / 3) * 4)

/** Page-level hand-edit actions: resolve the asset, then use the pipeline. */
const HandEditRequestSchema = z.discriminatedUnion("action", [
  z
    .object({
      action: z.literal("start-edit"),
      project: z.string().min(1).optional(),
      assetId: z.string().min(1),
      styleId: z.string().min(1),
      expectedSha256: z.string().regex(/^[0-9a-f]{64}$/),
      /** Also launch the author's editor on the file. */
      open: z.boolean().optional(),
    })
    .strict(),
  z
    .object({
      action: z.literal("detach-edit"),
      project: z.string().min(1).optional(),
      assetId: z.string().min(1),
      styleId: z.string().min(1),
      expectedSha256: z.string().regex(/^[0-9a-f]{64}$/),
    })
    .strict(),
  /** From the in-browser editor: the page holds the bytes, the server validates and writes. */
  z
    .object({
      action: z.literal("save-edit"),
      project: z.string().min(1).optional(),
      assetId: z.string().min(1),
      styleId: z.string().min(1),
      expectedSha256: z.string().regex(/^[0-9a-f]{64}$/),
      /** The flattened image; for a frame set, `frames` instead. */
      png: Base64.min(1).optional(),
      /** Every frame of a set, tagged with the role it was opened under (null for one added in the editor). */
      frames: z.array(z.object({ role: z.string().min(1).nullable(), png: Base64.min(1) }).strict()).min(1).max(256).optional(),
      /** The editor's layered project file, kept beside the edit. */
      pxo: Base64.optional(),
      /** Editor identity from the bridge's ready message. */
      editor: z.string().min(1).max(200),
      protocol: z.number().int().positive(),
    })
    .strict(),
])

export {
  applyManifestEdit,
  CANDIDATE_OPTION,
  ManifestDriftError,
  ManifestEditError,
  ManifestEditSchema,
  type ManifestEdit,
  type ManifestEditResult,
} from "../manifest-edit.ts"

export interface GalleryEditHandlerOptions {
  /** Resolves the manifest an edit may rewrite; must never trust a client path. */
  manifestFor: (project?: string) => string | Promise<string>
  /** Rebuilds the gallery after a successful write. */
  reload: () => Promise<GalleryBuild>
  /** Loads a project for hand-edit actions, which need resolved specs and the lock. */
  loadProject?: (project?: string) => Promise<GalleryProjectContext>
  /** Launches the author's editor; defaults to `openInEditor`. */
  openEditor?: (file: string) => string
  onProgress?: (msg: string) => void
}

/** The `edit` callback `serveGallery` expects: validate, apply, rebuild. */
export function createGalleryEditHandler(
  opts: GalleryEditHandlerOptions,
): (body: unknown) => Promise<GalleryBuild> {
  const log = opts.onProgress ?? (() => {})
  return async (body) => {
    const handEdit = HandEditRequestSchema.safeParse(body)
    if (handEdit.success) {
      if (!opts.loadProject) throw new ManifestEditError("hand edits are not available in this gallery")
      const request = handEdit.data
      const ctx = await opts.loadProject(request.project)
      const spec = ctx.specs.find((candidate) => lockKey(candidate.styleId, candidate.assetId) === lockKey(request.styleId, request.assetId))
      if (!spec) throw new ManifestEditError(`"${request.styleId}/${request.assetId}" is not declared by the manifest`)
      if (request.action === "start-edit") {
        const started = await startHandEdit(ctx.loaded, ctx.lock, spec, { expectedSha256: request.expectedSha256 })
        log(`  hand edit ${started.created ? "created" : "found"}: ${started.source}${started.declared ? " (declared in the manifest)" : ""}`)
        if (request.open) {
          const command = (opts.openEditor ?? openInEditor)(started.members[0]!.path)
          log(`  opened with: ${command}`)
        }
      } else if (request.action === "save-edit") {
        if ((request.png !== undefined) === (request.frames !== undefined)) {
          throw new ManifestEditError("invalid edit: send png for one image or frames for a set, not both")
        }
        const saved = await saveHandEdit(ctx.loaded, ctx.lock, spec, {
          ...(request.png !== undefined ? { png: Buffer.from(request.png, "base64") } : {}),
          ...(request.frames ? { frames: request.frames.map((frame) => ({ role: frame.role, png: Buffer.from(frame.png, "base64") })) } : {}),
          ...(request.pxo ? { project: Buffer.from(request.pxo, "base64") } : {}),
          editor: request.editor,
          protocol: request.protocol,
          expectedSha256: request.expectedSha256,
        })
        const what = saved.members.length > 1 ? `${saved.source} (${saved.members.length} frames)` : saved.source
        log(`  hand edit saved from ${request.editor}: ${what}${saved.declared ? " (declared in the manifest)" : ""}${saved.projectPath ? " + project file" : ""}`)
      } else {
        const result = await detachHandEdit(ctx.loaded, spec, { expectedSha256: request.expectedSha256 })
        if (result.changed) log(`  hand edit detached: ${request.styleId}/${request.assetId} (file kept)`)
      }
      return opts.reload()
    }
    const upload = UploadImageSchema.safeParse(body)
    if (upload.success) {
      let manifestPath: string
      try {
        manifestPath = await opts.manifestFor(upload.data.project)
      } catch (error) {
        throw new ManifestEditError(error instanceof Error ? error.message : String(error))
      }
      const written = await saveProjectImage(path.dirname(path.resolve(manifestPath)), upload.data)
      log(`  image added: ${written}`)
      return opts.reload()
    }
    if ((body as { action?: unknown } | null)?.action === "upload-image") {
      throw new ManifestEditError("invalid upload: " + upload.error.issues.slice(0, 2).map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; "))
    }
    const poses = SkeletonKeypointsUpdateSchema.safeParse(body)
    if (poses.success) {
      if (!opts.loadProject) throw new ManifestEditError("pose edits are not available in this gallery")
      const written = await updateSkeletonKeypoints(await opts.loadProject(poses.data.project), poses.data)
      log(`  poses saved: ${written} (${poses.data.styleId}/${poses.data.assetId} is stale until generated again)`)
      return opts.reload()
    }
    if ((body as { action?: unknown } | null)?.action === "update-skeleton-keypoints") {
      throw new ManifestEditError(
        "invalid pose edit: " +
          poses.error.issues.slice(0, 3).map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; "),
      )
    }
    const skeleton = SkeletonAnimationRequestSchema.safeParse(body)
    if (skeleton.success) {
      let manifestPath: string
      try {
        manifestPath = await opts.manifestFor(skeleton.data.project)
      } catch (error) {
        throw new ManifestEditError(error instanceof Error ? error.message : String(error))
      }
      await createSkeletonAnimation(manifestPath, skeleton.data)
      log(`  manifest edited: added skeleton animation ${skeleton.data.assetId} (${skeleton.data.keypointsFile})`)
      return opts.reload()
    }
    if ((body as { action?: unknown } | null)?.action === "create-skeleton-animation") {
      throw new ManifestEditError(
        "invalid skeleton animation: " +
          skeleton.error.issues.slice(0, 3).map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; "),
      )
    }
    const parsed = ManifestEditSchema.safeParse(body)
    if (!parsed.success) {
      throw new ManifestEditError(
        "invalid edit: " +
          parsed.error.issues.slice(0, 3).map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; "),
      )
    }
    let manifestPath: string
    try {
      manifestPath = await opts.manifestFor(parsed.data.project)
    } catch (error) {
      throw new ManifestEditError(error instanceof Error ? error.message : String(error))
    }
    const result = await applyManifestEdit(manifestPath, parsed.data)
    if (result.changed) {
      const relative = path.relative(process.cwd(), result.manifestPath)
      const shown = !relative || relative.startsWith("..") ? result.manifestPath : relative
      log(`  manifest edited: ${describeEdit(parsed.data)} in ${shown}`)
    }
    return opts.reload()
  }
}

/** One line for the terminal: what a saved edit did. */
function describeEdit(edit: ManifestEdit | Extract<ManifestEdit, { action: "batch" }>["edits"][number]): string {
  switch (edit.action) {
    case "batch": return `${edit.edits.length} changes (${edit.edits.map(describeEdit).join("; ")})`
    case "add-style": return `added style ${edit.styleId}`
    case "patch-style": return `changed style ${edit.styleId}`
    case "set-source":
    case "clear-source": return `changed ${edit.styleId}/${edit.assetId} source`
    case "add-asset": return `added ${edit.assetId}`
    case "patch-asset": return `changed ${edit.assetId}`
  }
}

/**
 * The page's "what would this cost" question for an unsaved form: the same
 * validation a save runs, resolved offline and compared with the manifest
 * as it stands. Nothing is written.
 */
export function createGalleryPriceHandler(opts: {
  manifestFor: (project?: string) => string | Promise<string>
  /**
   * The live quoter for a project's specs (PixelLab's Pro Flash cost
   * endpoint), or null when the project has no key for it. Anything it
   * declines or fails to quote keeps the offline estimate.
   */
  quoteFor?: (project?: string) => Promise<((spec: ResolvedSpec) => Promise<number | null>) | null>
}): (body: unknown) => Promise<ManifestEditPrice> {
  return async (body) => {
    const parsed = ManifestEditSchema.safeParse(body)
    if (!parsed.success) {
      throw new ManifestEditError(
        "invalid edit: " + parsed.error.issues.slice(0, 3).map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; "),
      )
    }
    let manifestPath: string
    try {
      manifestPath = await opts.manifestFor(parsed.data.project)
    } catch (error) {
      throw new ManifestEditError(error instanceof Error ? error.message : String(error))
    }
    let quote: ((spec: ResolvedSpec) => Promise<number | null>) | null = null
    let quoteError: string | undefined
    try {
      quote = opts.quoteFor ? await opts.quoteFor(parsed.data.project) : null
    } catch (error) {
      quoteError = error instanceof Error ? error.message : String(error)
    }
    const price = await priceManifestEdit(manifestPath, parsed.data, quote ? { quote } : {})
    return quoteError && !price.quoteError ? { ...price, quoteError } : price
  }
}
