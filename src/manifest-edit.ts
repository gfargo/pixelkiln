import { readFile, rename, rm, writeFile } from "node:fs/promises"
import path from "node:path"
import { z } from "zod"
import { sha256 } from "./hash.ts"
import { expandLoopDirections, loopShorthandOf } from "./loop-directions.ts"
import { loadManifest, resolveSpecs } from "./manifest.ts"
import type { ResolvedSpec } from "./types.ts"
import {
  CharacterAnimationModeSchema,
  CharacterDirectionSchema,
  CharacterModeSchema,
  CharacterOutfitSchema,
  CharacterPortraitSchema,
  CharacterProportionsSchema,
} from "./types.ts"

/**
 * The gallery's one write path: editing *intent* in the manifest. Nothing here
 * touches a provider or the lockfile. A saved edit changes the spec hash, so
 * the very next snapshot reports the asset `stale` (or `missing`) with its
 * estimate, the same thing that happens when the manifest is edited by hand,
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

/**
 * A controlled state or animation of a `character`/`objectPro` base or
 * state, restricted to the fields that need no file upload — the gallery has
 * none. `startFrame`/`endFrame`, and template `outline`/`shading`/`detail`
 * hints, need a manifest-relative image or are template-specific polish;
 * hand-edit the manifest for those.
 */
const NewStateSchema = z
  .object({
    /** Asset id of the parent this states; must already exist. */
    of: z.string().min(1),
    paletteFromReference: z.boolean().optional(),
    canvas: z.object({ width: z.number().int().min(16).max(256), height: z.number().int().min(16).max(256) }).strict().optional(),
  })
  .strict()

const NewAnimationSchema = z
  .object({
    /** Asset id of the parent this animates; must already exist. */
    of: z.string().min(1),
    /** A PixelLab template id (`character` only; `objectPro` has no template concept). */
    template: z.string().min(1).optional(),
    direction: CharacterDirectionSchema.optional(),
    frames: z.number().int().min(4).max(16).optional(),
    fps: z.number().int().min(1).max(60).optional(),
    /** One loop per named direction, plus free mirrors; expanded when the manifest loads. */
    directions: z.array(CharacterDirectionSchema).min(1).optional(),
    mode: CharacterAnimationModeSchema.optional(),
    /** What is being animated, when the parent's own description would mislead the model (`character` only). */
    subject: z.string().min(1).optional(),
    enhancePrompt: z.boolean().optional(),
  })
  .strict()

const NewAssetSchema = z
  .object({
    /** A portrait, an outfit, or a mirror has none of its own; the loader says where one is needed. */
    prompt: z.string().optional(),
    category: z.string().optional(),
    width: z.number().int().optional(),
    height: z.number().int().optional(),
    size: z.number().int().optional(),
    tags: z.array(z.string()).optional(),
    /** Restrict to these styles; empty or omitted means every style. */
    styles: z.array(z.string().min(1)).optional(),
    /**
     * A controlled regeneration of another asset in the same manifest,
     * instead of a fresh generation. `inpaint` needs a mask upload the
     * gallery does not offer yet, so only `image-to-image` and
     * `animate-skeleton` (whose keypoints file the gallery writes first) can
     * be created here; hand-edit the manifest for the other modes.
     */
    revision: z
      .discriminatedUnion("mode", [
        z
          .object({
            mode: z.literal("image-to-image"),
            /** Asset id of the parent this revises; must already exist. */
            from: z.string().min(1),
            strength: z.number().min(0).max(1).optional(),
          })
          .strict(),
        z
          .object({
            mode: z.literal("animate-skeleton"),
            from: z.string().min(1),
            /** Manifest-relative; checked when the manifest is loaded, like every revision input. */
            keypointsFile: z.string().min(1),
            direction: CharacterDirectionSchema,
            description: z.string().min(1).optional(),
            skeletonTemplate: z.string().min(1).optional(),
          })
          .strict(),
      ])
      .optional(),
    /** A pose or outfit of an existing `character`/`objectPro` base or state. */
    state: NewStateSchema.optional(),
    /** A loop of an existing `character`/`objectPro` base or state. */
    animation: NewAnimationSchema.optional(),
    /** A bust of an existing character. */
    portrait: CharacterPortraitSchema.optional(),
    /** An existing loop re-clothed from a reference image (uploaded first). */
    outfit: CharacterOutfitSchema.optional(),
    /** Another asset of the same style, flipped; free. */
    mirror: z.string().min(1).optional(),
    /**
     * `character`/`objectPro` bases: the subject's own sprite (uploaded
     * first), or one per direction, which PixelLab rotates instead of drawing.
     */
    reference: z.union([z.string().min(1), z.record(CharacterDirectionSchema, z.string().min(1))]).optional(),
    /** `character` pro bases: a concept image that seeds the design. */
    concept: z.string().min(1).optional(),
    /** `character` pro bases: another character in the style whose look this one follows. */
    styleCharacter: z.string().min(1).optional(),
    /** `character` standard humanoid bases: this character's proportions, over the style's. */
    proportions: CharacterProportionsSchema.optional(),
  })
  .strict()
  .refine((asset) => !(asset.revision && (asset.state || asset.animation)), {
    message: "an asset is a revision, a state, or an animation — not more than one",
  })
  .refine((asset) => !(asset.state && asset.animation), {
    message: "an asset is a state or an animation — not both",
  })

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

/**
 * A new `character` or `objectPro` style, the shape the gallery's character
 * studio creates. Everything else about a style is written by hand; the
 * loader validates the result like any other manifest before it lands.
 */
const NewStyleSchema = z
  .object({
    generator: z.enum(["character", "objectPro"]),
    /** Where the style's art is written, inside the project. */
    outDir: z.string().min(1).refine((dir) => !dir.split(/[\\/]/).includes("..") && !/^([a-z]:)?[\\/]/i.test(dir), {
      message: "outDir must be a path inside the project",
    }),
    size: z.number().int().min(16).max(256).optional(),
    mode: CharacterModeSchema.optional(),
    directions: z.union([z.literal(4), z.literal(8)]).optional(),
    template: z.string().min(1).optional(),
    view: z.string().min(1).max(64).optional(),
    proportions: CharacterProportionsSchema.optional(),
    isometric: z.boolean().optional(),
    textGuidanceScale: z.number().min(1).max(20).optional(),
    enhancePrompt: z.boolean().optional(),
    promptPrefix: z.string().optional(),
    promptSuffix: z.string().optional(),
    palette: z.array(z.string().regex(/^#?[0-9a-f]{6}$/i, "expected a six-digit hex colour")).max(256).optional(),
  })
  .strict()

// Each edit's own fields; a request wraps one in `project` and
// `expectedSha256`, and a batch carries several under one envelope.
const PatchAssetEdit = z
  .object({
    action: z.literal("patch-asset"),
    assetId: z.string().min(1),
    patch: AssetPatchSchema,
  })
  .strict()
const AddAssetEdit = z
  .object({
    action: z.literal("add-asset"),
    assetId: z.string().min(1).regex(/^[^/\\]+$/, "asset ids cannot contain slashes"),
    asset: NewAssetSchema,
  })
  .strict()
const SetSourceEdit = z
  .object({
    action: z.literal("set-source"),
    assetId: z.string().min(1),
    styleId: z.string().min(1),
    /** Manifest-relative path of the art that stands in for this asset in this style. */
    source: z.string().min(1),
  })
  .strict()
const ClearSourceEdit = z
  .object({
    action: z.literal("clear-source"),
    assetId: z.string().min(1),
    styleId: z.string().min(1),
  })
  .strict()
const PatchStyleEdit = z
  .object({
    action: z.literal("patch-style"),
    styleId: z.string().min(1),
    patch: z
      .object({
        /** Candidates per generation, written to the provider's own option. */
        candidates: z.number().int().min(1).max(64).optional(),
        /** Empty clears the style's own value (inherit, or the default). */
        promptPrefix: z.string().optional(),
        promptSuffix: z.string().optional(),
        /** `#rrggbb` values; null or empty clears the style's own palette. */
        palette: z.array(z.string().regex(/^#?[0-9a-f]{6}$/i, "expected a six-digit hex colour")).max(256).nullable().optional(),
        /** Snap downloaded art to the palette; false clears the style's own value. */
        enforcePalette: z.boolean().optional(),
        /** Provider view name (PixelLab: low top-down, high top-down, side); empty clears. */
        view: z.string().max(64).nullable().optional(),
        /** pixflux only; null clears the style's own value. */
        noBackground: z.boolean().nullable().optional(),
      })
      .strict()
      .refine((patch) => Object.keys(patch).length > 0, { message: "nothing to change" }),
  })
  .strict()
const AddStyleEdit = z
  .object({
    action: z.literal("add-style"),
    styleId: z.string().min(1).regex(/^[^/\\:]+$/, "style ids cannot contain slashes or colons"),
    style: NewStyleSchema,
  })
  .strict()

const Envelope = {
  /** Workspace project id; omitted for a single-project gallery. */
  project: z.string().min(1).optional(),
  /** Manifest bytes the page last saw; a mismatch refuses the write. */
  expectedSha256: HexSha,
}

const SingleEdit = z.discriminatedUnion("action", [PatchAssetEdit, AddAssetEdit, SetSourceEdit, ClearSourceEdit, PatchStyleEdit, AddStyleEdit])
type SingleEdit = z.infer<typeof SingleEdit>

export const ManifestEditSchema = z.discriminatedUnion("action", [
  PatchAssetEdit.extend(Envelope),
  AddAssetEdit.extend(Envelope),
  SetSourceEdit.extend(Envelope),
  ClearSourceEdit.extend(Envelope),
  PatchStyleEdit.extend(Envelope),
  AddStyleEdit.extend(Envelope),
  /**
   * Several edits as one write: a new character's style, base, and loops
   * land together or not at all, validated once as the finished manifest.
   * Each edit sees the ones before it, so a base can name a style the same
   * batch adds.
   */
  z
    .object({
      action: z.literal("batch"),
      ...Envelope,
      edits: z.array(SingleEdit).min(1).max(64),
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

/** Styles an asset resolves into: its own list, or every style when it has none. */
function assetStyles(raw: RawManifest, asset: RawAsset): string[] {
  const own = Array.isArray(asset.styles) ? (asset.styles as string[]) : []
  return own.length ? own : Object.keys(raw.styles ?? {})
}

/**
 * Every asset id the manifest declares once loaded, including those an
 * `animation.directions` shorthand expands into: a new revision of
 * `hero.walk.south` names a real parent even though the file only says
 * `hero.walk`.
 */
function declaredAssets(raw: RawManifest): Set<string> {
  const expanded = expandLoopDirections(raw).raw as RawManifest
  return new Set(Object.keys(expanded.assets ?? {}))
}

/** Editing an expanded loop in place would have nowhere to go in the file; say where it came from. */
function undeclaredAsset(raw: RawManifest, assetId: string): ManifestEditError {
  const shorthand = loopShorthandOf(assetId, expandLoopDirections(raw).families)
  return new ManifestEditError(
    shorthand
      ? `asset "${assetId}" is expanded from "${shorthand}"'s animation.directions; edit "${shorthand}" (it applies to every ` +
          "direction), or write this direction out as its own asset to change it alone"
      : `asset "${assetId}" is not declared by the manifest`,
  )
}

function applyEdit(raw: RawManifest, edit: SingleEdit | ManifestEdit): void {
  raw.assets ??= {}
  if (edit.action === "batch") {
    for (const each of edit.edits) applyEdit(raw, each)
    return
  }
  if (edit.action === "add-style") {
    raw.styles ??= {}
    if (Object.hasOwn(raw.styles, edit.styleId)) throw new ManifestEditError(`style "${edit.styleId}" already exists`)
    const style: RawStyle = { ...edit.style }
    if (edit.style.palette) style.palette = edit.style.palette.map((color) => "#" + color.replace(/^#/, "").toLowerCase())
    raw.styles[edit.styleId] = style
    return
  }
  if (edit.action === "set-source" || edit.action === "clear-source") {
    const asset = Object.hasOwn(raw.assets, edit.assetId) ? raw.assets[edit.assetId] : undefined
    if (!asset) throw undeclaredAsset(raw, edit.assetId)
    if (!raw.styles || !Object.hasOwn(raw.styles, edit.styleId)) {
      throw new ManifestEditError(`unknown style "${edit.styleId}"`)
    }
    if (!assetStyles(raw, asset).includes(edit.styleId)) {
      throw new ManifestEditError(`asset "${edit.assetId}" is not in style "${edit.styleId}"`)
    }
    // One style: the plain `source` reads best. Several: the edit belongs to
    // one generation, so it goes under that style alone.
    const single = assetStyles(raw, asset).length === 1
    const byStyle = { ...((asset.sourceByStyle as Record<string, string> | undefined) ?? {}) }
    if (edit.action === "set-source") {
      if (single) {
        asset.source = edit.source
        delete byStyle[edit.styleId]
      } else {
        byStyle[edit.styleId] = edit.source
      }
    } else {
      delete byStyle[edit.styleId]
      if (single) delete asset.source
    }
    if (Object.keys(byStyle).length) asset.sourceByStyle = byStyle
    else delete asset.sourceByStyle
    return
  }
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
    // "inherit again", for a base style "the default", exactly what the
    // author would write by hand in either case.
    if (patch.promptPrefix !== undefined) setOrDelete(style, "promptPrefix", patch.promptPrefix || null)
    if (patch.promptSuffix !== undefined) setOrDelete(style, "promptSuffix", patch.promptSuffix || null)
    if (patch.palette !== undefined) {
      const colors = (patch.palette ?? []).map((color) => "#" + color.replace(/^#/, "").toLowerCase())
      setOrDelete(style, "palette", colors.length ? colors : null)
    }
    if (patch.enforcePalette !== undefined) setOrDelete(style, "enforcePalette", patch.enforcePalette || null)
    if (patch.view !== undefined) setOrDelete(style, "view", patch.view?.trim() || null)
    if (patch.noBackground !== undefined) setOrDelete(style, "noBackground", patch.noBackground)
    return
  }
  if (edit.action === "add-asset") {
    if (declaredAssets(raw).has(edit.assetId)) {
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
    if (edit.asset.revision && !declaredAssets(raw).has(edit.asset.revision.from)) {
      throw new ManifestEditError(`revision parent "${edit.asset.revision.from}" is not declared by the manifest`)
    }
    if (edit.asset.state && !declaredAssets(raw).has(edit.asset.state.of)) {
      throw new ManifestEditError(`state parent "${edit.asset.state.of}" is not declared by the manifest`)
    }
    if (edit.asset.animation && !declaredAssets(raw).has(edit.asset.animation.of)) {
      throw new ManifestEditError(`animation parent "${edit.asset.animation.of}" is not declared by the manifest`)
    }
    for (const [what, parent] of [
      ["portrait", edit.asset.portrait?.of],
      ["outfit", edit.asset.outfit?.of],
      ["mirror", edit.asset.mirror],
    ] as const) {
      if (parent && !declaredAssets(raw).has(parent)) {
        throw new ManifestEditError(`${what} source "${parent}" is not declared by the manifest`)
      }
    }
    raw.assets[edit.assetId] = asset
    return
  }

  const asset = Object.hasOwn(raw.assets, edit.assetId) ? raw.assets[edit.assetId] : undefined
  if (!asset) throw undeclaredAsset(raw, edit.assetId)
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
 * The edited manifest, written beside the real one and resolved through the
 * real loader so relative style images, workflows, and sources resolve
 * exactly as they will after a rename. `use` sees the candidate path and its
 * resolved specs; the candidate is always removed afterwards.
 */
async function withCandidate<T>(
  manifestPath: string,
  edit: ManifestEdit,
  use: (candidate: { absolute: string; original: string; next: string; tmp: string; specs: ResolvedSpec[] }) => Promise<T>,
  unchanged: (absolute: string, original: string) => T,
): Promise<T> {
  const absolute = path.resolve(manifestPath)
  const original = await readFile(absolute, "utf8")
  if (sha256(original) !== edit.expectedSha256) throw new ManifestDriftError(absolute)

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
  if (next === original) return unchanged(absolute, original)

  const tmp = path.join(
    path.dirname(absolute),
    `.${path.basename(absolute)}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`,
  )
  try {
    await writeFile(tmp, next)
    let specs: ResolvedSpec[]
    try {
      specs = await resolveSpecs(await loadManifest(tmp))
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      throw new ManifestEditError(message.replace(tmp, absolute))
    }
    return await use({ absolute, original, next, tmp, specs })
  } finally {
    await rm(tmp, { force: true })
  }
}

/**
 * Apply one edit to the manifest on disk. The write is refused when the file
 * no longer matches what the page saw, and rolled back when the edited
 * manifest fails to load or resolve; an invalid manifest never lands.
 */
export async function applyManifestEdit(
  manifestPath: string,
  edit: ManifestEdit,
): Promise<ManifestEditResult> {
  return withCandidate<ManifestEditResult>(
    manifestPath,
    edit,
    async ({ absolute, next, tmp }) => {
      await rename(tmp, absolute)
      return { manifestPath: absolute, sha256: sha256(next), changed: true }
    },
    (absolute, original) => ({ manifestPath: absolute, sha256: sha256(original), changed: false }),
  )
}

/** What an edit would cost to generate, before it is saved. */
export interface ManifestEditPrice {
  /** Every asset the edit adds or changes, with the estimate plan would quote. */
  items: Array<{
    key: string
    styleId: string
    assetId: string
    change: "new" | "changed"
    cost: number
    costUnit: string
    candidates: number
  }>
  /** Summed by unit: generations and dollars do not add. */
  totals: Record<string, number>
}

/**
 * Prices an edit without writing it: the same candidate manifest
 * `applyManifestEdit` would validate, resolved offline, compared with the
 * manifest as it stands. Anything new or whose identity changes is what a
 * `gen` after saving would spend on. The same drift check applies, so a
 * price is never quoted against a manifest the page no longer shows.
 */
export async function priceManifestEdit(manifestPath: string, edit: ManifestEdit): Promise<ManifestEditPrice> {
  return withCandidate<ManifestEditPrice>(
    manifestPath,
    edit,
    async ({ absolute, specs }) => {
      const before = new Map((await resolveSpecs(await loadManifest(absolute))).map((spec) => [`${spec.styleId}/${spec.assetId}`, spec.specHash]))
      const items: ManifestEditPrice["items"] = []
      const totals: Record<string, number> = {}
      for (const spec of specs) {
        const key = `${spec.styleId}/${spec.assetId}`
        const was = before.get(key)
        if (was === spec.specHash) continue
        items.push({
          key,
          styleId: spec.styleId,
          assetId: spec.assetId,
          change: was === undefined ? "new" : "changed",
          cost: spec.cost,
          costUnit: spec.costUnit,
          candidates: spec.candidates,
        })
        totals[spec.costUnit] = (totals[spec.costUnit] ?? 0) + spec.cost
      }
      return { items, totals }
    },
    () => ({ items: [], totals: {} }),
  )
}
