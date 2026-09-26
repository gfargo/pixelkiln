import { existsSync } from "node:fs"
import { mkdir, writeFile } from "node:fs/promises"
import path from "node:path"
import { z } from "zod"
import { ManifestEditError } from "../manifest-edit.ts"
import { imageMetadata } from "../media.ts"

/** Largest image the page may upload: a concept painting at 1024px fits many times over. */
export const MAX_UPLOAD_BYTES = 8 * 1024 * 1024

/**
 * An image the page adds to the project for a manifest input to name: a
 * base's `reference` sprite, a pro `concept`, an outfit's `reference`. It
 * is written where the request says, inside the project, and nothing else:
 * the manifest edit that uses it is a separate, validated write.
 */
export const UploadImageSchema = z
  .object({
    action: z.literal("upload-image"),
    project: z.string().min(1).optional(),
    /** Manifest-relative destination, ending .png, .jpg, or .jpeg. */
    path: z.string().min(1),
    base64: z.string().regex(/^[A-Za-z0-9+/]*={0,2}$/).max(Math.ceil(MAX_UPLOAD_BYTES / 3) * 4),
    /** Replace a file already at `path`. */
    overwrite: z.boolean().optional(),
  })
  .strict()

/** Writes the upload and returns its manifest-relative path. */
export async function saveProjectImage(root: string, request: z.infer<typeof UploadImageSchema>): Promise<string> {
  const file = path.resolve(root, request.path)
  const relative = path.relative(root, file)
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new ManifestEditError("an upload must stay inside the project")
  }
  const extension = path.extname(file).toLowerCase()
  const expected = extension === ".png" ? "png" : extension === ".jpg" || extension === ".jpeg" ? "jpeg" : null
  if (!expected) throw new ManifestEditError("an upload must be a .png, .jpg, or .jpeg path")
  const bytes = Buffer.from(request.base64, "base64")
  if (!bytes.length || bytes.length > MAX_UPLOAD_BYTES) {
    throw new ManifestEditError(`an upload must be between 1 byte and ${MAX_UPLOAD_BYTES / 1024 / 1024} MB`)
  }
  const metadata = imageMetadata(bytes)
  if (!metadata) throw new ManifestEditError("the upload is not a readable PNG or JPEG")
  if (metadata.format !== expected) {
    throw new ManifestEditError(`the upload is a ${metadata.format.toUpperCase()}; name it ${metadata.format === "png" ? ".png" : ".jpg"}`)
  }
  if (existsSync(file) && !request.overwrite) {
    throw new ManifestEditError(`${relative.split(path.sep).join("/")} already exists; choose another name, or replace it`)
  }
  await mkdir(path.dirname(file), { recursive: true })
  await writeFile(file, bytes)
  return relative.split(path.sep).join("/")
}
