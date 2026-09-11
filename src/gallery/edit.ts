import { readFile, rename, rm, writeFile } from "node:fs/promises"
import path from "node:path"
import { z } from "zod"
import { sha256 } from "../hash.ts"
import { loadManifest, resolveSpecs } from "../manifest.ts"
import type { GalleryBuild } from "./snapshot.ts"

/**
 * The gallery's one write path: editing *intent* in the manifest. Nothing here
 * touches a provider or the lockfile. A saved edit changes the spec hash, so
 * the very next snapshot reports the asset `stale` (or `missing`) with its
 * estimate — the same thing that happens when the manifest is edited by hand,
 * and the same `plan`/`gen` gate applies before anything is spent.
 *
 * Edits are applied to the raw on-disk JSON rather than the resolved manifest
 * so `extends`, comments-by-convention, and key order survive, then the
 * result is validated through the real loader before it replaces the file.
 */
const HexSha = z.string().regex(/^[0-9a-f]{64}$/)

/** A JSON-safe subset of `AssetSchema` that is sensible to change in a form. */
const AssetPatchSchema = z
  .object({
    prompt: z.string().optional(),
    /** Per-style override for the style being viewed; null removes it. */
    promptForStyle: z.object({ styleId: z.string().min(1), prompt: z.string().nullable() }).optional(),
    category: z.string().nullable().optional(),
    width: z.number().int().nullable().optional(),
    height: z.number().int().nullable().optional(),
    size: z.number().int().nullable().optional(),
    tags: z.array(z.string()).optional(),
  })
  .strict()

const NewAssetSchema = z
  .object({
    prompt: z.string(),
    category: z.string().optional(),
    width: z.number().int().optional(),
    height: z.number().int().optional(),
    size: z.number().int().optional(),
    tags: z.array(z.string()).optional(),
    /** Restrict to these styles; empty or omitted means every style. */
    styles: z.array(z.string().min(1)).optional(),
  })
  .strict()

/**
 * Which style-level provider option carries "how many candidates per
 * generation". PixelLab has none: its count follows the generator and size,
 * so a candidate set means a `1dir` style, not a number.
 */
export const CANDIDATE_OPTION: Record<string, string> = {
  retrodiffusion: "numImages",
  comfyui: "numImages",
  scenario: "numOutputs",
}

export const ManifestEditSchema = z.discriminatedUnion("action", [
  z
    .object({
      action: z.literal("patch-asset"),
      /** Workspace project id; omitted for a single-project gallery. */
      project: z.string().min(1).optional(),
      assetId: z.string().min(1),
      /** Manifest bytes the page last saw; a mismatch refuses the write. */
      expectedSha256: HexSha,
      patch: AssetPatchSchema,
    })
    .strict(),
  z
    .object({
      action: z.literal("add-asset"),
      project: z.string().min(1).optional(),
      assetId: z.string().min(1).regex(/^[^/\\]+$/, "asset ids cannot contain slashes"),
      expectedSha256: HexSha,
      asset: NewAssetSchema,
    })
    .strict(),
  z
    .object({
      action: z.literal("patch-style"),
      project: z.string().min(1).optional(),
      styleId: z.string().min(1),
      expectedSha256: HexSha,
      patch: z
        .object({
          /** Candidates per generation, written to the provider's own option. */
          candidates: z.number().int().min(1).max(64).optional(),
          /** Empty clears the style's own value (inherit, or the default). */
          promptPrefix: z.string().optional(),
          promptSuffix: z.string().optional(),
          /** `#rrggbb` values; null or empty clears the style's own palette. */
          palette: z.array(z.string().regex(/^#?[0-9a-f]{6}$/i, "expected a six-digit hex colour")).max(256).nullable().optional(),
        })
        .strict()
        .refine((patch) => Object.keys(patch).length > 0, { message: "nothing to change" }),
    })
    .strict(),
])

export type ManifestEdit = z.infer<typeof ManifestEditSchema>

/** The page showed a manifest that has since changed; the write is refused. */
export class ManifestDriftError extends Error {
  readonly status = 409
  constructor(manifestPath: string) {
    super(`${manifestPath} changed on disk since this page loaded; refresh and try again`)
    this.name = "ManifestDriftError"
  }
}

/** A request the schema or the manifest rules reject; nothing was written. */
export class ManifestEditError extends Error {
  readonly status = 400
  constructor(message: string) {
    super(message)
    this.name = "ManifestEditError"
  }
}

export interface ManifestEditResult {
  manifestPath: string
  /** Hash of the manifest after the write, for the next edit's `expectedSha256`. */
  sha256: string
  changed: boolean
}

/** Keep the author's indentation and trailing newline; only the content changes. */
function serializeLike(original: string, value: unknown): string {
  const indentMatch = /\n([ \t]+)"/.exec(original)
  const indent = indentMatch ? (indentMatch[1]!.startsWith("\t") ? "\t" : indentMatch[1]!.length) : 2
  return JSON.stringify(value, null, indent) + (original.endsWith("\n") ? "\n" : "")
}

type RawAsset = Record<string, unknown> & { promptByStyle?: Record<string, string> }
type RawStyle = Record<string, unknown> & {
  provider?: string
  extends?: string
  providerOptions?: Record<string, Record<string, unknown>>
}
type RawManifest = { provider?: string; assets?: Record<string, RawAsset>; styles?: Record<string, RawStyle> }

/** Walk `extends` to find the provider a style actually resolves to. */
function styleProvider(raw: RawManifest, styleId: string, seen = new Set<string>()): string {
  const style = raw.styles?.[styleId]
  if (!style || seen.has(styleId)) return raw.provider ?? "pixellab"
  if (style.provider) return style.provider
  seen.add(styleId)
  return style.extends ? styleProvider(raw, style.extends, seen) : (raw.provider ?? "pixellab")
}

function setOrDelete(target: Record<string, unknown>, key: string, value: unknown): void {
  if (value === null || value === undefined) delete target[key]
  else target[key] = value
}

function applyEdit(raw: RawManifest, edit: ManifestEdit): void {
  raw.assets ??= {}
  if (edit.action === "patch-style") {
    const style = raw.styles && Object.hasOwn(raw.styles, edit.styleId) ? raw.styles[edit.styleId] : undefined
    if (!style) throw new ManifestEditError(`style "${edit.styleId}" is not declared by the manifest`)
    const { patch } = edit
    if (patch.candidates !== undefined) {
      const provider = styleProvider(raw, edit.styleId)
      const option = CANDIDATE_OPTION[provider]
      if (!option) {
        throw new ManifestEditError(
          provider === "pixellab"
            ? "PixelLab's candidate count follows the generator and size: map and pixflux return one image; a 1dir style returns 4–64 for its size"
            : `provider "${provider}" has no candidate-count option`,
        )
      }
      const options = { ...(style.providerOptions ?? {}) }
      options[provider] = { ...(options[provider] ?? {}), [option]: patch.candidates }
      style.providerOptions = options
    }
    // An empty value removes the style's own key: for a child that means
    // "inherit again", for a base style "the default" — exactly what the
    // author would write by hand in either case.
    if (patch.promptPrefix !== undefined) setOrDelete(style, "promptPrefix", patch.promptPrefix || null)
    if (patch.promptSuffix !== undefined) setOrDelete(style, "promptSuffix", patch.promptSuffix || null)
    if (patch.palette !== undefined) {
      const colors = (patch.palette ?? []).map((color) => "#" + color.replace(/^#/, "").toLowerCase())
      setOrDelete(style, "palette", colors.length ? colors : null)
    }
    return
  }
  if (edit.action === "add-asset") {
    if (Object.hasOwn(raw.assets, edit.assetId)) {
      throw new ManifestEditError(`asset "${edit.assetId}" already exists`)
    }
    const { styles, tags, ...rest } = edit.asset
    const asset: RawAsset = { ...rest }
    if (tags?.length) asset.tags = tags
    if (styles?.length) {
      for (const styleId of styles) {
        if (!raw.styles || !Object.hasOwn(raw.styles, styleId)) {
          throw new ManifestEditError(`unknown style "${styleId}"`)
        }
      }
      asset.styles = styles
    }
    raw.assets[edit.assetId] = asset
    return
  }

  const asset = Object.hasOwn(raw.assets, edit.assetId) ? raw.assets[edit.assetId] : undefined
  if (!asset) throw new ManifestEditError(`asset "${edit.assetId}" is not declared by the manifest`)
  const { patch } = edit
  if (patch.prompt !== undefined) asset.prompt = patch.prompt
  if (patch.promptForStyle) {
    const { styleId, prompt } = patch.promptForStyle
    if (!raw.styles || !Object.hasOwn(raw.styles, styleId)) {
      throw new ManifestEditError(`unknown style "${styleId}"`)
    }
    const byStyle = { ...(asset.promptByStyle ?? {}) }
    if (prompt === null) delete byStyle[styleId]
    else byStyle[styleId] = prompt
    if (Object.keys(byStyle).length) asset.promptByStyle = byStyle
    else delete asset.promptByStyle
  }
  if ("category" in patch) setOrDelete(asset, "category", patch.category)
  if ("width" in patch) setOrDelete(asset, "width", patch.width)
  if ("height" in patch) setOrDelete(asset, "height", patch.height)
  if ("size" in patch) setOrDelete(asset, "size", patch.size)
  if (patch.tags !== undefined) {
    if (patch.tags.length) asset.tags = patch.tags
    else delete asset.tags
  }
}

/**
 * Apply one edit to the manifest on disk. The write is refused when the file
 * no longer matches what the page saw, and rolled back when the edited
 * manifest fails to load or resolve — an invalid manifest never lands.
 */
export async function applyManifestEdit(
  manifestPath: string,
  edit: ManifestEdit,
): Promise<ManifestEditResult> {
  const absolute = path.resolve(manifestPath)
  const original = await readFile(absolute, "utf8")
  const before = sha256(original)
  if (before !== edit.expectedSha256) throw new ManifestDriftError(absolute)

  let raw: RawManifest
  try {
    raw = JSON.parse(original) as RawManifest
  } catch (error) {
    throw new ManifestEditError(
      `manifest is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    )
  }
  applyEdit(raw, edit)
  const next = serializeLike(original, raw)
  if (next === original) return { manifestPath: absolute, sha256: before, changed: false }

  // Validate the candidate through the real loader beside the destination so
  // relative style images, workflows, and sources resolve exactly as they will
  // after the rename. Only a manifest that loads and resolves replaces the file.
  const tmp = path.join(
    path.dirname(absolute),
    `.${path.basename(absolute)}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`,
  )
  try {
    await writeFile(tmp, next)
    try {
      const loaded = await loadManifest(tmp)
      await resolveSpecs(loaded)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      throw new ManifestEditError(message.replace(tmp, absolute))
    }
    await rename(tmp, absolute)
  } finally {
    await rm(tmp, { force: true })
  }
  return { manifestPath: absolute, sha256: sha256(next), changed: true }
}

export interface GalleryEditHandlerOptions {
  /** Resolves the manifest an edit may rewrite; must never trust a client path. */
  manifestFor: (project?: string) => string | Promise<string>
  /** Rebuilds the gallery after a successful write. */
  reload: () => Promise<GalleryBuild>
  onProgress?: (msg: string) => void
}

/** The `edit` callback `serveGallery` expects: validate, apply, rebuild. */
export function createGalleryEditHandler(
  opts: GalleryEditHandlerOptions,
): (body: unknown) => Promise<GalleryBuild> {
  const log = opts.onProgress ?? (() => {})
  return async (body) => {
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
      const subject = parsed.data.action === "patch-style" ? `style ${parsed.data.styleId}` : parsed.data.assetId
      log(`  manifest edited: ${parsed.data.action === "add-asset" ? "added" : "changed"} ${subject} in ${shown}`)
    }
    return opts.reload()
  }
}
