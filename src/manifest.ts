import { readFile } from "node:fs/promises"
import { existsSync } from "node:fs"
import path from "node:path"
import {
  ManifestSchema,
  candidateCount,
  countNumberedDescriptions,
  generationCost,
  tileVariationCount,
  tileFeatureOutputCount,
  tilesCost,
  type Manifest,
  type ResolvedSpec,
  type ResolvedStyleImage,
} from "./types.ts"
import { sha256, specHash } from "./hash.ts"
import { MediaType } from "./media.ts"
import { expectedOutputPath } from "./outputs.ts"
import { validateCostEstimate, type Provider } from "./provider.ts"
import { createProvider } from "./providers/registry.ts"

export interface LoadedManifest {
  manifest: Manifest
  /** Directory the manifest lives in. All relative paths resolve against it. */
  root: string
  path: string
}

export async function loadManifest(manifestPath: string): Promise<LoadedManifest> {
  const abs = path.resolve(manifestPath)
  if (!existsSync(abs)) throw new Error(`No manifest at ${abs}`)
  const parsed = ManifestSchema.safeParse(JSON.parse(await readFile(abs, "utf8")))
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  ${i.path.join(".")}: ${i.message}`).join("\n")
    throw new Error(`Manifest at ${abs} is invalid:\n${issues}`)
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
    if (asset.revision) {
      if (!parsed.data.assets[asset.revision.from]) {
        unknownReferences.push(
          `assets.${assetId}.revision.from: unknown asset "${asset.revision.from}"`,
        )
      } else if (asset.revision.from === assetId) {
        unknownReferences.push(`assets.${assetId}.revision.from: an asset cannot revise itself`)
      }
    }
  }
  const visiting = new Set<string>()
  const visited = new Set<string>()
  const visitRevision = (assetId: string, chain: string[]) => {
    if (visited.has(assetId)) return
    if (visiting.has(assetId)) {
      const start = chain.indexOf(assetId)
      unknownReferences.push(
        `assets.${assetId}.revision.from: revision cycle ${[...chain.slice(start), assetId].join(" -> ")}`,
      )
      return
    }
    visiting.add(assetId)
    const parent = parsed.data.assets[assetId]?.revision?.from
    if (parent && parent !== assetId && parsed.data.assets[parent]) {
      visitRevision(parent, [...chain, assetId])
    }
    visiting.delete(assetId)
    visited.add(assetId)
  }
  for (const assetId of Object.keys(parsed.data.assets)) visitRevision(assetId, [])
  if (unknownReferences.length) {
    throw new Error(`Manifest at ${abs} is invalid:\n${unknownReferences.map((i) => `  ${i}`).join("\n")}`)
  }
  return { manifest: parsed.data, root: path.dirname(abs), path: abs }
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
      throw new Error(
        `Unknown style "${unknownStyle}". Defined: ${Object.keys(manifest.styles).join(", ") || "(none)"}`,
      )
    }
  }
  for (const unknownAsset of filter?.assets ?? []) {
    if (!manifest.assets[unknownAsset]) {
      throw new Error(`Unknown asset "${unknownAsset}".`)
    }
  }

  const requestedAssetIds = new Set(filter?.assets?.length
    ? filter.assets
    : Object.keys(manifest.assets))
  const resolutionAssetIds = new Set(requestedAssetIds)
  for (const assetId of [...requestedAssetIds]) {
    let current = manifest.assets[assetId]?.revision?.from
    while (current && !resolutionAssetIds.has(current)) {
      resolutionAssetIds.add(current)
      current = manifest.assets[current]?.revision?.from
    }
  }

  // Style images are hashed, not just named: editing a reference image must
  // invalidate every spec that depends on it.
  const styleImageCache = new Map<
    string,
    { base64: string; hash: string; width: number; height: number; format: "png" | "jpeg" }
  >()
  async function loadStyleImage(rel: string) {
    const abs = path.resolve(root, rel)
    let hit = styleImageCache.get(abs)
    if (!hit) {
      if (!existsSync(abs)) throw new Error(`Style image not found: ${abs}`)
      const buf = await readFile(abs)
      const metadata = imageMetadata(buf)
      if (!metadata) throw new Error(`Style image is not a readable PNG or JPEG: ${abs}`)
      if (metadata.width < 1 || metadata.height < 1) {
        throw new Error(`Style image has invalid dimensions: ${abs}`)
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
      } else {
        width = asset.width ?? style.size ?? 64
        height = asset.height ?? style.size ?? 64
        size = Math.max(width, height)
      }

      // A per-style override replaces the subject wording, not the style
      // wrapping — prefix and suffix still apply.
      const subject = asset.promptByStyle[styleId] ?? asset.prompt
      const prompt = [style.promptPrefix, subject, style.promptSuffix]
        .map((p) => p.trim())
        .filter(Boolean)
        .join(", ")

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
        view: style.view ?? (generator === "1dir" ? "top-down" : "high top-down"),
        styleImagePaths: style.styleImages.map((s) => s.path),
        outline: style.outline,
        shading: style.shading,
        detail: style.detail,
        seed: style.seed,
        palette: style.palette,
        noBackground: style.noBackground,
        tileSize: generator === "tiles" ? tileSize : undefined,
        tileType: generator === "tiles" ? style.tileType : undefined,
        tileView: generator === "tiles" ? style.tileView : undefined,
        tileFeature: generator === "tiles" ? style.tileFeature : undefined,
        outlineMode: generator === "tiles" ? style.outlineMode : undefined,
        cost:
          generator === "tiles"
            ? tilesCost(tileSize, tileVariations)
            : generationCost(width, height, generator),
        costUnit: "generations" as const,
        candidates:
          generator === "tiles"
            ? tileVariations
            : generator === "1dir"
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
        source: asset.source,
        // Revision identity is attached after every dependency in this style
        // has a concrete output target. Finalization below computes the hash.
        specHash: "",
      }
      styleSpecs.set(assetId, resolved)
    }

    const finalized = new Set<string>()
    const finalize = async (assetId: string): Promise<ResolvedSpec> => {
      const resolved = styleSpecs.get(assetId)
      if (!resolved) {
        throw new Error(
          `Asset "${assetId}" is not available in style "${styleId}"; ` +
            "revision parents must participate in the same style.",
        )
      }
      if (finalized.has(assetId)) return resolved
      const asset = manifest.assets[assetId]!
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

/** Reads dimensions without decoding pixel data. */
export function imageMetadata(
  buf: Buffer,
): Pick<ResolvedStyleImage, "width" | "height" | "format"> | null {
  if (
    buf.length >= 24 &&
    buf.readUInt32BE(0) === 0x89504e47 &&
    buf.readUInt32BE(4) === 0x0d0a1a0a &&
    buf.toString("ascii", 12, 16) === "IHDR"
  ) {
    return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20), format: "png" }
  }

  if (buf.length < 4 || buf[0] !== 0xff || buf[1] !== 0xd8) return null
  let offset = 2
  while (offset + 3 < buf.length) {
    if (buf[offset] !== 0xff) return null
    while (buf[offset] === 0xff) offset++
    const marker = buf[offset++]
    if (marker == null || marker === 0xd9 || marker === 0xda) break
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue
    if (offset + 2 > buf.length) return null
    const length = buf.readUInt16BE(offset)
    if (length < 2 || offset + length > buf.length) return null
    const isStartOfFrame =
      marker >= 0xc0 &&
      marker <= 0xcf &&
      ![0xc4, 0xc8, 0xcc].includes(marker)
    if (isStartOfFrame) {
      if (length < 7) return null
      return {
        width: buf.readUInt16BE(offset + 5),
        height: buf.readUInt16BE(offset + 3),
        format: "jpeg",
      }
    }
    offset += length
  }
  return null
}
