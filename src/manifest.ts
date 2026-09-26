import { readFile } from "node:fs/promises"
import { existsSync } from "node:fs"
import path from "node:path"
import type { ZodIssue } from "zod"
import { ProjectError, UsageError } from "./errors.ts"
import {
  ManifestInputSchema,
  ManifestSchema,
  StyleSchema,
  candidateCount,
  countNumberedDescriptions,
  generationCost,
  isometricTileCost,
  parseTerrainDescriptions,
  terrainTileCount,
  tileVariationCount,
  tileFeatureOutputCount,
  tilesCost,
  CHARACTER_DIRECTIONS_4,
  CHARACTER_DIRECTIONS_8,
  MIRRORED_DIRECTION,
  type Asset,
  type CharacterDirection,
  type Manifest,
  type ResolvedCharacter,
  type ResolvedObjectPro,
  type ResolvedReferenceImage,
  type ResolvedSpec,
  type ResolvedStyleImage,
  type Style,
  type StyleInput,
} from "./types.ts"
import { sha256, sha256File, specHash } from "./hash.ts"
import { imageMetadata, MediaType } from "./media.ts"
import { expandAssetFilter, expandLoopDirections } from "./loop-directions.ts"
import { expectedOutputPath, memberPath } from "./outputs.ts"
import { validateCostEstimate, type Provider } from "./provider.ts"
import { createProvider } from "./providers/registry.ts"

export interface LoadedManifest {
  manifest: Manifest
  /** Directory the manifest lives in. All relative paths resolve against it. */
  root: string
  path: string
  /**
   * `animation.directions` shorthands, by the id they were declared under,
   * and the asset ids each expanded into. Absent when the manifest has none.
   */
  loopFamilies?: Record<string, string[]>
}

export async function loadManifest(manifestPath: string): Promise<LoadedManifest> {
  const abs = path.resolve(manifestPath)
  if (!existsSync(abs)) throw new ProjectError(`No manifest at ${abs}`)
  // One loop declared for several directions becomes the explicit assets it
  // stands for before anything validates them; see src/loop-directions.ts.
  const expansion = expandLoopDirections(JSON.parse(await readFile(abs, "utf8")))
  if (expansion.issues.length) {
    throw new ProjectError(`Manifest at ${abs} is invalid:\n${expansion.issues.map((i) => `  ${i}`).join("\n")}`)
  }
  const input = ManifestInputSchema.safeParse(expansion.raw)
  if (!input.success) {
    const issues = formatManifestIssues(input.error.issues)
    throw new ProjectError(`Manifest at ${abs} is invalid:\n${issues}`)
  }
  let styles: Record<string, Style>
  try {
    styles = resolveStyleInheritance(input.data.styles)
  } catch (error) {
    throw new ProjectError(
      `Manifest at ${abs} is invalid:\n  ${error instanceof Error ? error.message : String(error)}`,
    )
  }
  const parsed = ManifestSchema.safeParse({ ...input.data, styles })
  if (!parsed.success) {
    const issues = formatManifestIssues(parsed.error.issues)
    throw new ProjectError(`Manifest at ${abs} is invalid:\n${issues}`)
  }
  const styleIds = new Set(Object.keys(parsed.data.styles))
  const unknownReferences: string[] = []
  for (const [assetId, asset] of Object.entries(parsed.data.assets)) {
    for (const styleId of asset.styles) {
      if (!styleIds.has(styleId)) unknownReferences.push(`assets.${assetId}.styles: unknown style "${styleId}"`)
    }
    for (const styleId of Object.keys(asset.promptByStyle)) {
      if (!styleIds.has(styleId)) {
        unknownReferences.push(`assets.${assetId}.promptByStyle: unknown style "${styleId}"`)
      }
    }
    for (const styleId of Object.keys(asset.sourceByStyle)) {
      if (!styleIds.has(styleId)) {
        unknownReferences.push(`assets.${assetId}.sourceByStyle: unknown style "${styleId}"`)
      }
    }
    if (asset.revision) {
      if (!parsed.data.assets[asset.revision.from]) {
        unknownReferences.push(
          `assets.${assetId}.revision.from: unknown asset "${asset.revision.from}"`,
        )
      } else if (asset.revision.from === assetId) {
        unknownReferences.push(`assets.${assetId}.revision.from: an asset cannot revise itself`)
      }
    }
    // A state's parent is a base or another state; an animation's parent is
    // a base or a state. Nothing hangs off an animation.
    for (const shape of ["state", "animation"] as const) {
      const of = asset[shape]?.of
      if (!of) continue
      const parent = parsed.data.assets[of]
      if (!parent) {
        unknownReferences.push(`assets.${assetId}.${shape}.of: unknown asset "${of}"`)
      } else if (of === assetId) {
        unknownReferences.push(`assets.${assetId}.${shape}.of: an asset cannot be a ${shape} of itself`)
      } else if (parent.animation) {
        unknownReferences.push(`assets.${assetId}.${shape}.of: "${of}" is an animation and cannot be a parent`)
      }
    }
  }
  const visiting = new Set<string>()
  const visited = new Set<string>()
  const visitParents = (assetId: string, chain: string[]) => {
    if (visited.has(assetId)) return
    if (visiting.has(assetId)) {
      const start = chain.indexOf(assetId)
      const shape = parsed.data.assets[assetId]?.revision ? "revision" : parsed.data.assets[assetId]?.state ? "state" : "animation"
      const field = shape === "revision" ? "revision.from" : `${shape}.of`
      unknownReferences.push(
        `assets.${assetId}.${field}: ${shape} cycle ${[...chain.slice(start), assetId].join(" -> ")}`,
      )
      return
    }
    visiting.add(assetId)
    const parent = parentAssetId(parsed.data.assets[assetId])
    if (parent && parent !== assetId && parsed.data.assets[parent]) {
      visitParents(parent, [...chain, assetId])
    }
    visiting.delete(assetId)
    visited.add(assetId)
  }
  for (const assetId of Object.keys(parsed.data.assets)) visitParents(assetId, [])
  if (unknownReferences.length) {
    throw new ProjectError(`Manifest at ${abs} is invalid:\n${unknownReferences.map((i) => `  ${i}`).join("\n")}`)
  }
  const loopFamilies = Object.keys(expansion.families).length ? { loopFamilies: expansion.families } : {}
  return { manifest: parsed.data, root: path.dirname(abs), path: abs, ...loopFamilies }
}

/** The asset this one is generated from, whichever shape declares it. */
export function parentAssetId(asset: Asset | undefined): string | undefined {
  return asset?.revision?.from ?? asset?.state?.of ?? asset?.animation?.of
}

function formatManifestIssues(issues: ZodIssue[]): string {
  return issues.flatMap((issue): string[] => {
    if (issue.code === "invalid_union") {
      return issue.unionErrors.flatMap((error) => formatManifestIssues(error.issues).split("\n"))
    }
    return [`  ${issue.path.join(".")}: ${issue.message}`]
  }).join("\n")
}

/** Resolve child styles without carrying the inheritance marker into runtime state. */
function resolveStyleInheritance(styles: Record<string, StyleInput>): Record<string, Style> {
  const resolved = new Map<string, Style>()

  const visit = (styleId: string, chain: string[]): Style => {
    const cached = resolved.get(styleId)
    if (cached) return cached
    const cycleStart = chain.indexOf(styleId)
    if (cycleStart >= 0) {
      throw new Error(
        `styles.${styleId}.extends: inheritance cycle ` +
          `${[...chain.slice(cycleStart), styleId].join(" -> ")}`,
      )
    }
    const style = styles[styleId]
    if (!style) throw new Error(`styles.${styleId}: unknown style`)
    if (!("extends" in style)) {
      resolved.set(styleId, style)
      return style
    }

    const parentId = style.extends
    if (!Object.hasOwn(styles, parentId)) {
      throw new Error(`styles.${styleId}.extends: unknown style "${parentId}"`)
    }
    const parent = visit(parentId, [...chain, styleId])
    const { extends: _parent, ...child } = style
    const merged = {
      ...parent,
      ...child,
      quality:
        child.quality == null
          ? parent.quality
          : { ...(parent.quality ?? {}), ...child.quality },
      providerOptions: mergeProviderOptions(parent.providerOptions, child.providerOptions),
    }
    const parsed = StyleSchema.safeParse(merged)
    if (!parsed.success) {
      const issues = parsed.error.issues
        .map((issue) => `styles.${styleId}.${issue.path.join(".")}: ${issue.message}`)
        .join("; ")
      throw new Error(issues)
    }
    resolved.set(styleId, parsed.data)
    return parsed.data
  }

  return Object.fromEntries(Object.keys(styles).map((styleId) => [styleId, visit(styleId, [])]))
}

function mergeProviderOptions(
  parent: Record<string, Record<string, unknown>>,
  child: Record<string, Record<string, unknown>> | undefined,
): Record<string, Record<string, unknown>> {
  if (!child) return parent
  const merged = { ...parent }
  for (const [provider, options] of Object.entries(child)) {
    merged[provider] = { ...(parent[provider] ?? {}), ...options }
  }
  return merged
}

/**
 * Expands the manifest into one concrete spec per (style, asset) pair. This is
 * where a style becomes a namespace: adding a style re-derives the entire asset
 * set under a separate output root and separate lock keys, which is what makes
 * a whole-collection restyle a one-flag operation.
 */
export async function resolveSpecs(
  loaded: LoadedManifest,
  filter?: {
    styles?: string[]
    assets?: string[]
    /** Optional provider makes offline plan cost/candidate estimates adapter-owned. */
    provider?: Pick<
      Provider,
      | "supports"
      | "supportsRevision"
      | "estimate"
      | "validate"
      | "resolveOptions"
      | "resolveInputs"
      | "id"
    >
  },
): Promise<ResolvedSpec[]> {
  const { manifest, root } = loaded
  // The explicit provider remains a whole-resolution override for existing
  // library callers and diagnostics. Normal manifest resolution constructs
  // one offline adapter per effective style provider.
  const providerOverride = filter?.provider
  const providers = new Map<string, Pick<
    Provider,
    | "supports"
    | "supportsRevision"
    | "estimate"
    | "validate"
    | "resolveOptions"
    | "resolveInputs"
    | "id"
  >>()
  const providerFor = (id: string) => {
    if (providerOverride) return providerOverride
    let provider = providers.get(id)
    if (!provider) {
      provider = createProvider(id, "offline")
      providers.set(id, provider)
    }
    return provider
  }
  const specs: ResolvedSpec[] = []

  const styleIds = Object.keys(manifest.styles).filter(
    (id) => !filter?.styles?.length || filter.styles.includes(id),
  )
  for (const unknownStyle of filter?.styles ?? []) {
    if (!manifest.styles[unknownStyle]) {
      throw new UsageError(
        `Unknown style "${unknownStyle}". Defined: ${Object.keys(manifest.styles).join(", ") || "(none)"}`,
      )
    }
  }
  // A loop shorthand's id selects the whole family it expanded into.
  const assetFilter = expandAssetFilter(filter?.assets ?? [], loaded.loopFamilies)
  for (const unknownAsset of assetFilter) {
    if (!manifest.assets[unknownAsset]) {
      throw new UsageError(`Unknown asset "${unknownAsset}".`)
    }
  }

  const requestedAssetIds = new Set(assetFilter.length
    ? assetFilter
    : Object.keys(manifest.assets))
  const resolutionAssetIds = new Set(requestedAssetIds)
  for (const assetId of [...requestedAssetIds]) {
    let current = parentAssetId(manifest.assets[assetId])
    while (current && !resolutionAssetIds.has(current)) {
      resolutionAssetIds.add(current)
      current = parentAssetId(manifest.assets[current])
    }
  }

  // Style images are hashed, not just named: editing a reference image must
  // invalidate every spec that depends on it.
  const styleImageCache = new Map<
    string,
    { base64: string; hash: string; width: number; height: number; format: "png" | "jpeg" }
  >()
  async function loadStyleImage(rel: string, what = "Style image") {
    const abs = path.resolve(root, rel)
    let hit = styleImageCache.get(abs)
    if (!hit) {
      if (!existsSync(abs)) throw new Error(`${what} not found: ${abs}`)
      const buf = await readFile(abs)
      const metadata = imageMetadata(buf)
      if (!metadata) throw new Error(`${what} is not a readable PNG or JPEG: ${abs}`)
      if (metadata.width < 1 || metadata.height < 1) {
        throw new Error(`${what} has invalid dimensions: ${abs}`)
      }
      hit = { base64: buf.toString("base64"), hash: sha256(buf), ...metadata }
      styleImageCache.set(abs, hit)
    }
    return hit
  }

  for (const styleId of styleIds) {
    const style = manifest.styles[styleId]!
    const activeProvider = providerFor(style.provider ?? manifest.provider)
    const rawProviderOptions = style.providerOptions[activeProvider.id] ?? {}
    const optionResolution = activeProvider.resolveOptions
      ? await activeProvider.resolveOptions(rawProviderOptions, { root, styleId })
      : { options: rawProviderOptions }
    const providerOptions = optionResolution.options
    const providerOptionIdentity = optionResolution.identity ?? providerOptions
    const styleImageHashes: string[] = []
    const styleImageDimensions: { width: number; height: number }[] = []
    for (const img of style.styleImages) {
      const loadedImage = await loadStyleImage(img.path)
      styleImageHashes.push(loadedImage.hash)
      styleImageDimensions.push(loadedImage)
    }

    const resolvedImages = style.styleImages.map((image) => {
      const hit = styleImageCache.get(path.resolve(root, image.path))!
      return { base64: hit.base64, width: hit.width, height: hit.height, format: hit.format }
    })
    const styleSpecs = new Map<string, ResolvedSpec>()
    const providerInputIdentities = new Map<string, unknown>()

    for (const [assetId, asset] of Object.entries(manifest.assets)) {
      if (!resolutionAssetIds.has(assetId)) continue
      if (asset.styles.length && !asset.styles.includes(styleId)) continue

      const generator = style.generator
      if (!activeProvider.supports(generator)) {
        throw new Error(`Provider "${activeProvider.id}" does not support generator "${generator}"`)
      }
      if (Object.keys(asset.providerInputs).length && !activeProvider.resolveInputs) {
        throw new Error(
          `Provider "${activeProvider.id}" does not support asset providerInputs ` +
            `(${styleId}/${assetId})`,
        )
      }
      const inputResolution = activeProvider.resolveInputs
        ? await activeProvider.resolveInputs(asset.providerInputs, {
            root,
            styleId,
            assetId,
            generator,
            providerOptions,
          })
        : { inputs: {} }
      const providerInputs = inputResolution.inputs
      const providerInputIdentity = inputResolution.identity ?? providerInputs
      providerInputIdentities.set(assetId, providerInputIdentity)
      let width: number
      let height: number
      let size: number

      if (generator === "1dir") {
        // Square only. When style images are in play the API derives the size
        // from the largest reference, so the manifest's `size` is advisory.
        size = styleImageDimensions.length
          ? Math.max(...styleImageDimensions.flatMap((img) => [img.width, img.height]))
          : (asset.size ?? style.size ?? 64)
        width = size
        height = size
      } else if (generator === "tiles") {
        // Style mode copies the reference geometry; otherwise the endpoint
        // uses tileSize. Asset-level map dimensions do not apply to tiles.
        width = styleImageDimensions.length
          ? Math.max(...styleImageDimensions.map((img) => img.width))
          : (style.tileSize ?? 32)
        height = styleImageDimensions.length
          ? Math.max(...styleImageDimensions.map((img) => img.height))
          : (style.tileSize ?? 32)
        size = Math.max(width, height)
      } else if (generator === "character") {
        // Characters are square. A state may ask for a larger canvas.
        size = asset.state?.canvas
          ? Math.max(asset.state.canvas.width, asset.state.canvas.height)
          : (asset.size ?? style.size ?? 64)
        width = asset.state?.canvas?.width ?? size
        height = asset.state?.canvas?.height ?? size
      } else if (generator === "terrain") {
        // Tiles are always square; asset-level map dimensions do not apply.
        size = style.terrainTileSize ?? 16
        width = size
        height = size
      } else if (generator === "isometricTile") {
        // Square generation canvas (`image_size`), independent of
        // `isometricTileSize` (the API's own tile grid, 16 or 32).
        size = asset.size ?? style.size ?? 32
        width = size
        height = size
      } else if (generator === "objectPro") {
        // Objects are square like characters; a state has no canvas override
        // of its own (the API always inherits the parent's exact size).
        size = asset.size ?? style.size ?? 64
        width = size
        height = size
      } else if (generator === "uiAsset") {
        // Non-square capable, like imagePro, but 64 (the shared default
        // below) is under the API's own 192px floor — default to 256
        // instead, matching /create-ui-asset's own default.
        width = asset.width ?? style.size ?? 256
        height = asset.height ?? style.size ?? 256
        size = Math.max(width, height)
      } else {
        width = asset.width ?? style.size ?? 64
        height = asset.height ?? style.size ?? 64
        size = Math.max(width, height)
      }

      if ((asset.state || asset.animation) && generator !== "character" && generator !== "objectPro") {
        throw new Error(
          `assets.${assetId}: ${asset.state ? "state" : "animation"} needs a character or objectPro style; ` +
            `"${styleId}" generates ${generator}`,
        )
      }
      if ((asset.pieces || asset.elements) && generator !== "uiAsset") {
        throw new Error(
          `assets.${assetId}: ${asset.pieces ? "pieces" : "elements"} needs a uiAsset style; ` +
            `"${styleId}" generates ${generator}`,
        )
      }
      const characterKind = asset.animation ? "animation" : asset.state ? "state" : "base"

      // A per-style override replaces the subject wording, not the style
      // wrapping; prefix and suffix still apply. A state's edit and an
      // animation's action describe a change to a character that already
      // carries the look, so they go to the provider as written.
      const subject = asset.promptByStyle[styleId] ?? asset.prompt ?? ""
      let terrainLowerDescription: string | undefined
      let terrainUpperDescription: string | undefined
      let terrainTransitionDescription: string | undefined
      let prompt: string
      if (generator === "terrain") {
        const parsed = parseTerrainDescriptions(subject)
        if (!parsed) {
          throw new Error(
            `assets.${assetId}: terrain needs "1). <lower terrain> 2). <upper terrain>" in its ` +
              `prompt, optionally followed by "3). <transition>"`,
          )
        }
        const wrap = (text: string) =>
          [style.promptPrefix, text, style.promptSuffix].map((p) => p.trim()).filter(Boolean).join(", ")
        terrainLowerDescription = wrap(parsed.lower)
        terrainUpperDescription = wrap(parsed.upper)
        terrainTransitionDescription = parsed.transition ? wrap(parsed.transition) : undefined
        prompt = subject.trim()
      } else if ((generator === "character" || generator === "objectPro") && characterKind !== "base") {
        prompt = subject.trim()
      } else {
        prompt = [style.promptPrefix, subject, style.promptSuffix]
          .map((p) => p.trim())
          .filter(Boolean)
          .join(", ")
      }

      const relFile = asset.file ?? path.join(asset.category ?? "", `${assetId}.png`)
      const outFile = path.resolve(root, style.outDir, relFile)
      const qualityOutFile = style.quality
        ? path.resolve(root, style.quality.outDir, pngPath(relFile))
        : undefined

      // One `tiles` call draws a whole set, so its price and its candidate
      // count both come off the set rather than off a single sprite.
      const tileSize = generator === "tiles" ? size : (style.tileSize ?? 32)
      const tileVariations =
        tileFeatureOutputCount(generator === "tiles" ? style.tileFeature : undefined) ??
        tileVariationCount(countNumberedDescriptions(prompt))
      // A `/create-tileset` call is always a connectable set too: 16 tiles,
      // or 25 at the cliff transitionSize.
      const terrainTiles = generator === "terrain" ? terrainTileCount(style.terrainTransitionSize) : 0

      const base = {
        styleId,
        assetId,
        provider: activeProvider.id,
        providerOptions,
        providerInputs,
        generator,
        prompt,
        width,
        height,
        size,
        view: style.view ?? (generator === "1dir" ? "top-down" : generator === "character" ? "low top-down" : "high top-down"),
        styleImagePaths: style.styleImages.map((s) => s.path),
        outline: style.outline,
        shading: style.shading,
        detail: style.detail,
        seed: style.seed,
        uiPieces: generator === "uiAsset" ? asset.pieces : undefined,
        uiElements: generator === "uiAsset" ? asset.elements : undefined,
        uiColorPalette: generator === "uiAsset" ? style.uiColorPalette : undefined,
        palette: style.palette,
        enforcePalette: style.enforcePalette,
        noBackground: style.noBackground,
        tileSize: generator === "tiles" ? tileSize : undefined,
        tileHeight: generator === "tiles" ? style.tileHeight : undefined,
        // `/create-tileset` places tiles on a rectangular vertex grid (its own
        // docs: "a map of W×H cells has (W+1)×(H+1) vertices"), the same
        // square Wang-tiling math as `square_topdown` tiles-pro, regardless of
        // `terrainView`'s camera-angle setting. `tileType` otherwise defaults
        // to undefined and falls through to the exporter's own "isometric"
        // fallback, which is `tiles`' own real API default, not terrain's —
        // this is set explicitly so that fallback is never reached for terrain.
        tileType: generator === "tiles" ? style.tileType : generator === "terrain" ? "square_topdown" : undefined,
        tileView: generator === "tiles" ? style.tileView : undefined,
        tileViewAngle: generator === "tiles" ? style.tileViewAngle : undefined,
        tileDepthRatio: generator === "tiles" ? style.tileDepthRatio : undefined,
        tileFlatTopPx: generator === "tiles" ? style.tileFlatTopPx : undefined,
        obliqueLean: generator === "tiles" ? style.obliqueLean : undefined,
        tileFeature: generator === "tiles" ? style.tileFeature : undefined,
        buildingWallTiles: generator === "tiles" ? style.buildingWallTiles : undefined,
        buildingLayout: generator === "tiles" ? style.buildingLayout : undefined,
        buildingWallDescription: generator === "tiles" ? style.buildingWallDescription : undefined,
        buildingFloorDescription: generator === "tiles" ? style.buildingFloorDescription : undefined,
        buildingFloor2Description: generator === "tiles" ? style.buildingFloor2Description : undefined,
        buildingWallAngle: generator === "tiles" ? style.buildingWallAngle : undefined,
        outlineMode: generator === "tiles" ? style.outlineMode : undefined,
        terrainLowerDescription: generator === "terrain" ? terrainLowerDescription : undefined,
        terrainUpperDescription: generator === "terrain" ? terrainUpperDescription : undefined,
        terrainTransitionDescription: generator === "terrain" ? terrainTransitionDescription : undefined,
        terrainTileSize: generator === "terrain" ? size : undefined,
        terrainMode: generator === "terrain" ? style.terrainMode : undefined,
        terrainShapeStyle: generator === "terrain" ? style.terrainShapeStyle : undefined,
        terrainSpreadX: generator === "terrain" ? style.terrainSpreadX : undefined,
        terrainSlopeSize: generator === "terrain" ? style.terrainSlopeSize : undefined,
        terrainRaggedness: generator === "terrain" ? style.terrainRaggedness : undefined,
        terrainTransitionSize: generator === "terrain" ? style.terrainTransitionSize : undefined,
        terrainView: generator === "terrain" ? style.terrainView : undefined,
        isometricTileSize: generator === "isometricTile" ? style.isometricTileSize : undefined,
        isometricTileShape: generator === "isometricTile" ? style.isometricTileShape : undefined,
        ...(generator === "character"
          ? { character: await resolveCharacterShape(asset, style, characterKind, { root, load: loadStyleImage }) }
          : {}),
        ...(generator === "objectPro"
          ? { objectPro: await resolveObjectProShape(assetId, asset, style, characterKind, { root, load: loadStyleImage }) }
          : {}),
        cost:
          generator === "tiles"
            ? tilesCost(tileSize, tileVariations)
            : generator === "terrain"
              ? tilesCost(size, terrainTiles)
              : generator === "isometricTile"
                ? isometricTileCost()
                : generationCost(width, height, generator),
        costUnit: "generations" as const,
        candidates:
          generator === "tiles"
            ? tileVariations
            : generator === "terrain"
              ? terrainTiles
              : generator === "1dir" || generator === "imagePro"
                ? candidateCount(size)
                : 1,
      }

      const tags = [
        ...new Set([
          ...style.tags,
          ...asset.tags,
          `pixelkiln:${manifest.name}`,
          `asset:${assetId}`,
          `style:${styleId}`,
        ]),
      ]
      const resolved: ResolvedSpec = {
        ...base,
        root,
        outFile,
        ...(style.quality && qualityOutFile
          ? {
              quality: {
                outFile: qualityOutFile,
                palette: style.quality.palette,
                minGridConfidence: style.quality.minGridConfidence,
                ...(style.quality.minTransparency == null
                  ? {}
                  : { minTransparency: style.quality.minTransparency }),
                ...(style.quality.fixerRevision
                  ? { fixerRevision: style.quality.fixerRevision }
                  : {}),
                ...(style.quality.fixerPython
                  ? { fixerPython: path.resolve(root, style.quality.fixerPython) }
                  : {}),
                ...(style.quality.fps == null ? {} : { fps: style.quality.fps }),
              },
            }
          : {}),
        tags,
        source: asset.sourceByStyle[styleId] ?? asset.source,
        ...(asset.remoteId ? { remoteId: asset.remoteId } : {}),
        // Revision identity is attached after every dependency in this style
        // has a concrete output target. Finalization below computes the hash.
        specHash: "",
      }
      styleSpecs.set(assetId, resolved)
    }

    // A leader declares nothing of its own; it is elected purely by being
    // named as `batch.of` by at least one sibling. Precomputed once so
    // `finalize` can answer "am I a leader" with a lookup instead of an
    // O(assets) scan on every call.
    const batchMembersByLeader = new Map<string, { id: string; index: number }[]>()
    for (const id of styleSpecs.keys()) {
      const batch = manifest.assets[id]!.batch
      if (!batch) continue
      const members = batchMembersByLeader.get(batch.of) ?? []
      members.push({ id, index: batch.index })
      batchMembersByLeader.set(batch.of, members)
    }

    const finalized = new Set<string>()
    const finalize = async (assetId: string): Promise<ResolvedSpec> => {
      const resolved = styleSpecs.get(assetId)
      if (!resolved) {
        throw new Error(
          `Asset "${assetId}" is not available in style "${styleId}"; ` +
            "revision parents, character parents, and mirror sources must be in the same style.",
        )
      }
      if (finalized.has(assetId)) return resolved
      const asset = manifest.assets[assetId]!
      if (asset.mirror) {
        // A mirror is the source's shape with its direction flipped: no
        // prompt, no provider request, no cost. It is finalized after its
        // source so the source's own dependencies are already settled.
        if (asset.mirror === assetId) throw new Error(`assets.${assetId}: an asset cannot mirror itself`)
        const sourceSpec = await finalize(asset.mirror)
        if (sourceSpec.generator === "tiles" || sourceSpec.generator === "terrain") {
          throw new Error(`assets.${assetId}: a tile set cannot be mirrored; its edges carry meaning`)
        }
        if (sourceSpec.character?.kind === "animation") {
          const facing = sourceSpec.character.animation!.direction
          const mirrored = MIRRORED_DIRECTION[facing]
          if (mirrored === facing) {
            throw new Error(
              `assets.${assetId}: mirroring ${asset.mirror} gives another ${facing}-facing loop; ` +
                "mirror a loop facing east, west, or a diagonal",
            )
          }
          resolved.character = { ...sourceSpec.character, animation: { ...sourceSpec.character.animation!, direction: mirrored } }
        } else if (sourceSpec.character) {
          resolved.character = { ...sourceSpec.character }
        }
        if (sourceSpec.objectPro?.kind === "animation") {
          const facing = sourceSpec.objectPro.animation!.direction
          const mirrored = MIRRORED_DIRECTION[facing]
          if (mirrored === facing) {
            throw new Error(
              `assets.${assetId}: mirroring ${asset.mirror} gives another ${facing}-facing loop; ` +
                "mirror a loop facing east, west, or a diagonal",
            )
          }
          resolved.objectPro = { ...sourceSpec.objectPro, animation: { ...sourceSpec.objectPro.animation!, direction: mirrored } }
        } else if (sourceSpec.objectPro) {
          resolved.objectPro = { ...sourceSpec.objectPro }
        }
        resolved.mirror = { sourceAssetId: asset.mirror, sourceSpec }
        resolved.generator = sourceSpec.generator
        resolved.width = sourceSpec.width
        resolved.height = sourceSpec.height
        resolved.size = sourceSpec.size
        resolved.prompt = ""
        resolved.specHash = specHash(resolved, styleImageHashes, providerOptionIdentity, providerInputIdentities.get(assetId))
        resolved.cost = 0
        resolved.costUnit = sourceSpec.costUnit
        resolved.candidates = 1
        finalized.add(assetId)
        return resolved
      }
      const anchorId = asset.styleCharacter ?? style.styleCharacter
      if (resolved.character?.kind === "base" && anchorId && anchorId !== assetId) {
        // The anchor is another character in the style whose look this
        // base follows; its south file is hashed so a regenerated anchor
        // makes the bases drawn in its style stale.
        const anchorSpec = await finalize(anchorId)
        if (!anchorSpec.character || anchorSpec.character.kind === "animation") {
          throw new Error(`assets.${assetId}: styleCharacter ${anchorId} is not a character base or state`)
        }
        const file = memberPath(anchorSpec.outFile, "south", 0, anchorSpec.character.directions, MediaType.PNG)
        resolved.character = {
          ...resolved.character,
          styleAnchor: { assetId: anchorId, spec: anchorSpec, file, sha256: existsSync(file) ? await sha256File(file) : null },
        }
      }
      const characterParent = asset.state?.of ?? asset.animation?.of
      if (resolved.character && characterParent) {
        // The parent is resolved first so its output path is final; its
        // south-facing generated file is what the child's identity hashes.
        // A hand edit beside it does not count: PixelLab draws the child from
        // the character it holds, not from local bytes.
        const parentSpec = await finalize(characterParent)
        const parentDirections = parentSpec.character?.directions ?? 8
        const parentFile = memberPath(parentSpec.outFile, "south", 0, parentDirections, MediaType.PNG)
        resolved.character = {
          ...resolved.character,
          parentAssetId: characterParent,
          parentSpec,
          parentFile,
          parentSha256: existsSync(parentFile) ? await sha256File(parentFile) : null,
          // A state and its animations keep the engine and rotations of the base.
          mode: resolved.character.kind === "base" ? resolved.character.mode : parentSpec.character?.mode ?? resolved.character.mode,
          directions: resolved.character.kind === "base" ? resolved.character.directions : parentSpec.character?.directions ?? resolved.character.directions,
        }
      }
      if (resolved.objectPro && characterParent) {
        const parentSpec = await finalize(characterParent)
        if (!parentSpec.objectPro) {
          throw new Error(`assets.${assetId}: ${characterParent} is not an objectPro asset`)
        }
        const parentDirections = parentSpec.objectPro.directions
        const parentFile = memberPath(parentSpec.outFile, "south", 0, parentDirections, MediaType.PNG)
        resolved.objectPro = {
          ...resolved.objectPro,
          parentAssetId: characterParent,
          parentSpec,
          parentFile,
          parentSha256: existsSync(parentFile) ? await sha256File(parentFile) : null,
          // A state and its animations keep the base's own rotation count.
          directions: resolved.objectPro.kind === "base" ? resolved.objectPro.directions : parentSpec.objectPro.directions,
        }
      }
      if (asset.revision) {
        if (!activeProvider.supportsRevision?.(asset.revision.mode)) {
          throw new Error(
            `Provider "${activeProvider.id}" does not support ${asset.revision.mode} revisions`,
          )
        }
        const sourceSpec = await finalize(asset.revision.from)
        const sourceFile = sourceSpec.quality?.outFile ??
          (sourceSpec.source ? path.resolve(root, sourceSpec.source) : sourceSpec.outFile)
        const sourceImage = await optionalRevisionImage(sourceFile, "revision source")
        const maskFile = asset.revision.mask
          ? path.resolve(root, asset.revision.mask)
          : undefined
        const maskImage = maskFile
          ? await optionalRevisionImage(maskFile, "revision mask", "png")
          : null
        if (
          sourceImage && maskImage &&
          (sourceImage.width !== maskImage.width || sourceImage.height !== maskImage.height)
        ) {
          throw new Error(
            `Revision mask for ${styleId}/${assetId} is ${maskImage.width}x${maskImage.height}; ` +
              `source ${asset.revision.from} is ${sourceImage.width}x${sourceImage.height}`,
          )
        }
        // A palette reference has no spatial relationship to the source — it
        // only lends colors — so unlike a mask its dimensions are never
        // checked against the source.
        const paletteImageFile = asset.revision.paletteImage
          ? path.resolve(root, asset.revision.paletteImage)
          : undefined
        const paletteImage = paletteImageFile
          ? await optionalRevisionImage(paletteImageFile, "revision palette image", "png")
          : null
        // Same treatment as the palette image: a pinned ending frame is just
        // another image PixelLab reads, with no size relationship enforced
        // against the source the way a mask has.
        const lastFrameFile = asset.revision.lastFrame
          ? path.resolve(root, asset.revision.lastFrame)
          : undefined
        const lastFrame = lastFrameFile
          ? await optionalRevisionImage(lastFrameFile, "revision last frame")
          : null
        resolved.revision = {
          mode: asset.revision.mode,
          sourceAssetId: asset.revision.from,
          sourceFile,
          sourceSha256: sourceImage?.hash ?? null,
          sourceWidth: sourceImage?.width ?? null,
          sourceHeight: sourceImage?.height ?? null,
          sourceFormat: sourceImage?.format ?? null,
          sourceSpec,
          ...(maskFile
            ? {
                maskFile,
                maskSha256: maskImage?.hash ?? null,
                maskWidth: maskImage?.width ?? null,
                maskHeight: maskImage?.height ?? null,
                maskFormat: maskImage?.format ?? null,
              }
            : {}),
          ...(asset.revision.strength == null ? {} : { strength: asset.revision.strength }),
          ...(asset.revision.numColors == null ? {} : { numColors: asset.revision.numColors }),
          ...(paletteImageFile
            ? {
                paletteImageFile,
                paletteImageSha256: paletteImage?.hash ?? null,
                paletteImageWidth: paletteImage?.width ?? null,
                paletteImageHeight: paletteImage?.height ?? null,
                paletteImageFormat: paletteImage?.format ?? null,
              }
            : {}),
          ...(asset.revision.dithering ? { dithering: asset.revision.dithering } : {}),
          ...(asset.revision.ditheringStrength == null ? {} : { ditheringStrength: asset.revision.ditheringStrength }),
          ...(asset.revision.frames == null ? {} : { frames: asset.revision.frames }),
          ...(asset.revision.fps == null ? {} : { fps: asset.revision.fps }),
          ...(lastFrameFile
            ? {
                lastFrameFile,
                lastFrameSha256: lastFrame?.hash ?? null,
                lastFrameWidth: lastFrame?.width ?? null,
                lastFrameHeight: lastFrame?.height ?? null,
                lastFrameFormat: lastFrame?.format ?? null,
              }
            : {}),
          ...(asset.revision.direction ? { direction: asset.revision.direction } : {}),
          ...(asset.revision.enhancePrompt == null ? {} : { enhancePrompt: asset.revision.enhancePrompt }),
        }
      }
      if (asset.batch) {
        // A member rides along on its leader's single submission; the
        // leader resolves the whole group's item_descriptions (below), and
        // this just records which slot is its own.
        if (asset.batch.of === assetId) throw new Error(`assets.${assetId}: a batch cannot name itself as its own leader`)
        const leaderSpec = await finalize(asset.batch.of)
        if (!leaderSpec.batch || leaderSpec.batch.role !== "leader") {
          throw new Error(`assets.${assetId}: ${asset.batch.of} is not a 1dir batch leader`)
        }
        if (resolved.size !== leaderSpec.size) {
          throw new Error(
            `assets.${assetId}: batch members share the leader's canvas size; ` +
              `${asset.batch.of} is ${leaderSpec.size}px, this is ${resolved.size}px`,
          )
        }
        resolved.batch = {
          role: "member",
          itemDescriptions: leaderSpec.batch.itemDescriptions,
          index: asset.batch.index,
          leaderAssetId: asset.batch.of,
          leaderSpec,
        }
      } else {
        const members = batchMembersByLeader.get(assetId)
        if (members) {
          if (style.generator !== "1dir") {
            throw new Error(`assets.${assetId}: only a 1dir asset can lead a batch`)
          }
          const sorted = [...members].sort((a, b) => a.index - b.index)
          const seen = new Set<number>()
          for (const { index } of sorted) {
            if (seen.has(index)) throw new Error(`assets.${assetId}: two batch members both claim index ${index}`)
            seen.add(index)
          }
          const expectedIndices = sorted.map((_, i) => i + 1).join(",")
          if (sorted.map((m) => m.index).join(",") !== expectedIndices) {
            throw new Error(
              `assets.${assetId}: batch member indices must be 1..${sorted.length} with no gaps; ` +
                `got ${sorted.map((m) => m.index).join(",")}`,
            )
          }
          const total = 1 + sorted.length
          const limit = candidateCount(resolved.size)
          if (total > limit) {
            throw new Error(
              `assets.${assetId}: a ${resolved.size}px batch holds at most ${limit} items ` +
                `(1 leader + ${limit - 1} members); this one declares ${total}`,
            )
          }
          resolved.batch = {
            role: "leader",
            itemDescriptions: [resolved.prompt, ...sorted.map(({ id }) => styleSpecs.get(id)!.prompt)],
            memberAssetIds: sorted.map((m) => m.id),
          }
        }
      }
      resolved.specHash = specHash(
        resolved,
        styleImageHashes,
        providerOptionIdentity,
        providerInputIdentities.get(assetId),
      )
      activeProvider.validate?.(resolved, resolvedImages)
      const estimate = validateCostEstimate(activeProvider.id, activeProvider.estimate(resolved))
      resolved.cost = estimate.amount
      resolved.costUnit = estimate.unit
      resolved.candidates = estimate.candidates
      finalized.add(assetId)
      return resolved
    }

    for (const assetId of Object.keys(manifest.assets)) {
      if (!requestedAssetIds.has(assetId) || !styleSpecs.has(assetId)) continue
      specs.push(await finalize(assetId))
    }
  }

  const byOutput = new Map<string, string>()
  const claimOutput = (file: string, owner: string) => {
    const existing = byOutput.get(file)
    if (existing) {
      throw new Error(`Output collision: ${existing} and ${owner} both resolve to ${file}`)
    }
    byOutput.set(file, owner)
  }
  for (const spec of specs) {
    const key = `${spec.styleId}/${spec.assetId}`
    claimOutput(spec.outFile, key)
    if (spec.quality) {
      if (spec.generator === "frames") {
        const frameInputs = Object.values(spec.providerInputs ?? {}).find(Array.isArray)
        const count = frameInputs?.length ?? 0
        for (let index = 0; index < count; index++) {
          const role = `frame-${String(index).padStart(2, "0")}`
          claimOutput(
            expectedOutputPath(
              { ...spec, outFile: spec.quality.outFile },
              role,
              index,
              count,
              MediaType.PNG,
            ),
            `${key} quality ${role}`,
          )
        }
      } else {
        claimOutput(spec.quality.outFile, `${key} quality output`)
      }
    }
  }

  return specs
}

function pngPath(file: string): string {
  const extension = path.extname(file)
  return extension ? `${file.slice(0, -extension.length)}.png` : `${file}.png`
}

async function optionalRevisionImage(
  file: string,
  label: string,
  requiredFormat?: "png" | "jpeg",
): Promise<{ hash: string; width: number; height: number; format: "png" | "jpeg" } | null> {
  if (!existsSync(file)) return null
  const bytes = await readFile(file)
  const metadata = imageMetadata(bytes)
  if (!metadata) throw new Error(`${label} is not a readable PNG or JPEG: ${file}`)
  if (requiredFormat && metadata.format !== requiredFormat) {
    throw new Error(`${label} must be ${requiredFormat.toUpperCase()}: ${file}`)
  }
  return { hash: sha256(bytes), ...metadata }
}

/** Reference image bytes and measured dimensions, in manifest order. */
export async function resolveStyleImages(
  loaded: LoadedManifest,
  styleId: string,
): Promise<ResolvedStyleImage[]> {
  const style = loaded.manifest.styles[styleId]
  if (!style) throw new Error(`Unknown style "${styleId}"`)
  const out: ResolvedStyleImage[] = []
  for (const img of style.styleImages) {
    const file = path.resolve(loaded.root, img.path)
    const buf = await readFile(file)
    const metadata = imageMetadata(buf)
    if (!metadata) throw new Error(`Style image is not a readable PNG or JPEG: ${file}`)
    if (metadata.width < 1 || metadata.height < 1) {
      throw new Error(`Style image has invalid dimensions: ${file}`)
    }
    out.push({ base64: buf.toString("base64"), ...metadata })
  }
  return out
}

/** Retained for callers that only need the encoded bytes. */
export async function styleImagesBase64(loaded: LoadedManifest, styleId: string): Promise<string[]> {
  return (await resolveStyleImages(loaded, styleId)).map((img) => img.base64)
}

export { imageMetadata }

/** The character-family shape of one asset, before its parent is known. */
async function resolveCharacterShape(
  asset: Asset,
  style: Style,
  kind: ResolvedCharacter["kind"],
  files: { root: string; load: (rel: string, what: string) => Promise<{ hash: string; width: number; height: number; format: "png" | "jpeg" }> },
): Promise<ResolvedCharacter> {
  const mode = style.mode ?? "standard"
  const directions: 4 | 8 = mode === "standard" ? (style.directions ?? 8) : 8
  const proportions = asset.proportions ?? style.proportions
  const shape: ResolvedCharacter = {
    kind,
    mode,
    directions,
    template: style.template ?? "mannequin",
    ...(proportions !== undefined ? { proportions } : {}),
    ...(style.textGuidanceScale !== undefined ? { textGuidanceScale: style.textGuidanceScale } : {}),
    ...(style.isometric !== undefined ? { isometric: style.isometric } : {}),
    ...(style.enhancePrompt !== undefined ? { enhancePrompt: style.enhancePrompt } : {}),
    ...(style.styleTraits ? { styleTraits: style.styleTraits } : {}),
  }
  if (asset.concept) {
    const image = await files.load(asset.concept, "Concept image")
    shape.concept = { path: path.resolve(files.root, asset.concept), sha256: image.hash, width: image.width, height: image.height, format: image.format }
  }
  if (asset.reference) {
    // The author's own sprite, hashed so a redrawn reference makes the base
    // stale the way an edited style image does.
    const byDirection = typeof asset.reference === "string" ? { south: asset.reference } : asset.reference
    shape.reference = {}
    for (const [direction, rel] of Object.entries(byDirection)) {
      const image = await files.load(rel, `Reference sprite (${direction})`)
      shape.reference[direction as CharacterDirection] = {
        path: path.resolve(files.root, rel),
        sha256: image.hash,
        width: image.width,
        height: image.height,
        format: image.format,
      }
    }
  }
  if (asset.state) {
    shape.state = {
      paletteFromReference: asset.state.paletteFromReference,
      ...(asset.state.canvas ? { canvas: asset.state.canvas } : {}),
    }
  }
  if (asset.animation) {
    const animationMode = asset.animation.mode ?? (asset.animation.template ? "template" : "v3")
    const pose = async (rel: string, what: string): Promise<ResolvedReferenceImage> => {
      const image = await files.load(rel, what)
      return { path: path.resolve(files.root, rel), sha256: image.hash, width: image.width, height: image.height, format: image.format }
    }
    shape.animation = {
      mode: animationMode,
      ...(asset.animation.template ? { template: asset.animation.template } : {}),
      direction: asset.animation.direction,
      frames: asset.animation.frames ?? 8,
      fps: asset.animation.fps,
      keepFirstFrame: asset.animation.keepFirstFrame,
      ...(asset.animation.startFrame ? { startFrame: await pose(asset.animation.startFrame, "Animation start frame") } : {}),
      ...(asset.animation.endFrame ? { endFrame: await pose(asset.animation.endFrame, "Animation end frame") } : {}),
      ...(asset.animation.subject ? { subject: asset.animation.subject } : {}),
      ...(asset.animation.outline ? { outline: asset.animation.outline } : {}),
      ...(asset.animation.shading ? { shading: asset.animation.shading } : {}),
      ...(asset.animation.detail ? { detail: asset.animation.detail } : {}),
      ...(asset.animation.enhancePrompt !== undefined ? { enhancePrompt: asset.animation.enhancePrompt } : {}),
    }
  }
  return shape
}

/**
 * `objectPro` reuses `AssetSchema.state`/`.animation`'s character-shaped
 * schema (an object's state/animation authoring surface is a strict subset
 * of a character's), so this mirrors `resolveCharacterShape` but drops what
 * has no object equivalent: no `mode`/`template`/`proportions`/`isometric`/
 * `concept`/`styleAnchor`, since `/create-object-pro-flash` is the only base
 * path and objects have no skeleton. A `template`/`subject`/`outline`/
 * `shading`/`detail` set on an object's `animation` is rejected here rather
 * than silently dropped, since none of them reach the API for an object.
 */
async function resolveObjectProShape(
  assetId: string,
  asset: Asset,
  style: Style,
  kind: ResolvedObjectPro["kind"],
  files: { root: string; load: (rel: string, what: string) => Promise<{ hash: string; width: number; height: number; format: "png" | "jpeg" }> },
): Promise<ResolvedObjectPro> {
  const directions: 1 | 8 = style.objectDirections ?? 8
  const shape: ResolvedObjectPro = {
    kind,
    directions,
    ...(style.styleTraits ? { styleTraits: style.styleTraits } : {}),
  }
  if (asset.reference) {
    // Objects rotate from one south-facing frame; other directions in a
    // reference map (a character convention) do not apply and are ignored.
    const south = typeof asset.reference === "string" ? asset.reference : asset.reference.south
    if (south) {
      const image = await files.load(south, "Reference sprite")
      shape.reference = { path: path.resolve(files.root, south), sha256: image.hash, width: image.width, height: image.height, format: image.format }
    }
  }
  if (asset.state) {
    shape.state = {
      paletteFromReference: asset.state.paletteFromReference,
      ...(asset.state.canvas ? { canvas: asset.state.canvas } : {}),
    }
  }
  if (asset.animation) {
    for (const [field, value] of Object.entries({
      template: asset.animation.template,
      subject: asset.animation.subject,
      outline: asset.animation.outline,
      shading: asset.animation.shading,
      detail: asset.animation.detail,
    })) {
      if (value !== undefined) {
        throw new Error(
          `assets.${assetId}: objectPro has no skeleton/template concept, so animation.${field} does not apply; ` +
            "describe the motion in the asset's own prompt instead",
        )
      }
    }
    if (asset.animation.mode === "template") {
      throw new Error(`assets.${assetId}: objectPro animations have no "template" mode; use "v3" or "pro"`)
    }
    const pose = async (rel: string, what: string): Promise<ResolvedReferenceImage> => {
      const image = await files.load(rel, what)
      return { path: path.resolve(files.root, rel), sha256: image.hash, width: image.width, height: image.height, format: image.format }
    }
    shape.animation = {
      mode: asset.animation.mode ?? "v3",
      direction: asset.animation.direction,
      frames: asset.animation.frames ?? 8,
      fps: asset.animation.fps,
      keepFirstFrame: asset.animation.keepFirstFrame,
      ...(asset.animation.startFrame ? { startFrame: await pose(asset.animation.startFrame, "Animation start frame") } : {}),
      ...(asset.animation.endFrame ? { endFrame: await pose(asset.animation.endFrame, "Animation end frame") } : {}),
      ...(asset.animation.enhancePrompt !== undefined ? { enhancePrompt: asset.animation.enhancePrompt } : {}),
    }
  }
  return shape
}

/** The rotations a base or state writes, in output order. */
export function characterDirections(directions: 4 | 8) {
  return directions === 4 ? CHARACTER_DIRECTIONS_4 : CHARACTER_DIRECTIONS_8
}
