import path from "node:path"
import { z } from "zod"
import {
  applyManifestEdit,
  ManifestEditError,
  ManifestEditSchema,
} from "../manifest-edit.ts"
import { detachHandEdit, openInEditor, startHandEdit } from "../pipeline/hand-edit.ts"
import { lockKey } from "../types.ts"
import type { GalleryProjectContext } from "./generate.ts"
import type { GalleryBuild } from "./snapshot.ts"

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
          const command = (opts.openEditor ?? openInEditor)(started.editPath)
          log(`  opened with: ${command}`)
        }
      } else {
        const result = await detachHandEdit(ctx.loaded, spec, { expectedSha256: request.expectedSha256 })
        if (result.changed) log(`  hand edit detached: ${request.styleId}/${request.assetId} (file kept)`)
      }
      return opts.reload()
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
      const subject = parsed.data.action === "patch-style" ? `style ${parsed.data.styleId}`
        : parsed.data.action === "set-source" || parsed.data.action === "clear-source"
          ? `${parsed.data.styleId}/${parsed.data.assetId} source`
          : parsed.data.assetId
      log(`  manifest edited: ${parsed.data.action === "add-asset" ? "added" : "changed"} ${subject} in ${shown}`)
    }
    return opts.reload()
  }
}
