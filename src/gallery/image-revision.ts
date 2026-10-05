import { existsSync } from "node:fs"
import { readFile, rm, writeFile } from "node:fs/promises"
import path from "node:path"
import { z } from "zod"
import { applyManifestEdit, ManifestEditError } from "../manifest-edit.ts"
import { imageMetadata } from "../media.ts"
import { saveProjectImage } from "./upload.ts"

/**
 * The gallery's masked-inpaint path: the page's mask editor paints a
 * black-and-white PNG, and this writes it into the project and declares the
 * `inpaint` revision that names it in one step, behind `--edit`. Nothing is
 * generated; the revision is stale until `gen`.
 */
export const InpaintRevisionRequestSchema = z
  .object({
    action: z.literal("create-inpaint-revision"),
    project: z.string().min(1).optional(),
    expectedSha256: z.string().regex(/^[0-9a-f]{64}$/),
    styleId: z.string().min(1),
    /** The sprite being repainted. */
    from: z.string().min(1),
    assetId: z.string().min(1).regex(/^[^/\\]+$/, "asset ids cannot contain slashes"),
    /** What to paint into the masked area. */
    prompt: z.string().min(1),
    /** Manifest-relative `.png` destination for the mask. */
    maskPath: z.string().min(1),
    maskBase64: z.string().regex(/^[A-Za-z0-9+/]*={0,2}$/),
    /** Replace a file already at `maskPath`. */
    overwrite: z.boolean().optional(),
  })
  .strict()

/**
 * Writes the mask and adds the revision. A mask this call created is
 * removed again, and one it replaced is put back, when the manifest refuses
 * the asset (an unknown parent, or a mask whose size is not the parent's),
 * so a failed save leaves the project as it was.
 */
export async function createInpaintRevision(
  manifestPath: string,
  request: z.infer<typeof InpaintRevisionRequestSchema>,
): Promise<string> {
  const root = path.dirname(path.resolve(manifestPath))
  if (path.extname(request.maskPath).toLowerCase() !== ".png") {
    throw new ManifestEditError("the mask must be a .png path inside the project")
  }
  const bytes = Buffer.from(request.maskBase64, "base64")
  const metadata = imageMetadata(bytes)
  if (!metadata || metadata.format !== "png") throw new ManifestEditError("the mask is not a readable PNG")
  const file = path.resolve(root, request.maskPath)
  const previous = existsSync(file) ? await readFile(file) : null
  const mask = await saveProjectImage(root, {
    action: "upload-image",
    path: request.maskPath,
    base64: request.maskBase64,
    ...(request.overwrite ? { overwrite: true } : {}),
  })
  try {
    await applyManifestEdit(manifestPath, {
      action: "add-asset",
      assetId: request.assetId,
      expectedSha256: request.expectedSha256,
      asset: {
        prompt: request.prompt,
        styles: [request.styleId],
        revision: { mode: "inpaint", from: request.from, mask },
      },
    })
  } catch (error) {
    if (previous) await writeFile(file, previous)
    else await rm(file, { force: true })
    throw error
  }
  return mask
}
