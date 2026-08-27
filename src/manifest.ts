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
import { validateCostEstimate, type Provider } from "./provider.ts"

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
  }
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
    provider?: Pick<Provider, "supports" | "estimate" | "id">
  },
): Promise<ResolvedSpec[]> {
  const { manifest, root } = loaded
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
      if (metadata.width < 1 || metadata.height < 1 || metadata.width > 256 || metadata.height > 256) {
        throw new Error(
          `Style image exceeds the API's 256x256 limit: ${abs} ` +
            `(${metadata.width}x${metadata.height})`,
        )
      }
      hit = { base64: buf.toString("base64"), hash: sha256(buf), ...metadata }
      styleImageCache.set(abs, hit)
    }
    return hit
  }

  for (const styleId of styleIds) {
    const style = manifest.styles[styleId]!
    const styleImageHashes: string[] = []
    const styleImageDimensions: { width: number; height: number }[] = []
    for (const img of style.styleImages) {
      const loadedImage = await loadStyleImage(img.path)
      styleImageHashes.push(loadedImage.hash)
      styleImageDimensions.push(loadedImage)
    }

    for (const [assetId, asset] of Object.entries(manifest.assets)) {
      if (filter?.assets?.length && !filter.assets.includes(assetId)) continue
      if (asset.styles.length && !asset.styles.includes(styleId)) continue

      const generator = style.generator
      if (filter?.provider && !filter.provider.supports(generator)) {
        throw new Error(`Provider "${filter.provider.id}" does not support generator "${generator}"`)
      }
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

      // One `tiles` call draws a whole set, so its price and its candidate
      // count both come off the set rather than off a single sprite.
      const tileSize = generator === "tiles" ? size : (style.tileSize ?? 32)
      const tileVariations =
        tileFeatureOutputCount(generator === "tiles" ? style.tileFeature : undefined) ??
        tileVariationCount(countNumberedDescriptions(prompt))

      const base = {
        styleId,
        assetId,
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
      if (tags.length > 20) {
        throw new Error(
          `${styleId}/${assetId} resolves to ${tags.length} tags, but PixelLab allows at most 20`,
        )
      }

      const resolved: ResolvedSpec = {
        ...base,
        root,
        outFile,
        tags,
        specHash: specHash(base, styleImageHashes),
      }
      if (filter?.provider) {
        const estimate = validateCostEstimate(filter.provider.id, filter.provider.estimate(resolved))
        resolved.cost = estimate.amount
        resolved.costUnit = estimate.unit
        resolved.candidates = estimate.candidates
      }
      specs.push(resolved)
    }
  }

  const byOutput = new Map<string, string>()
  for (const spec of specs) {
    const key = `${spec.styleId}/${spec.assetId}`
    const owner = byOutput.get(spec.outFile)
    if (owner) {
      throw new Error(`Output collision: ${owner} and ${key} both resolve to ${spec.outFile}`)
    }
    byOutput.set(spec.outFile, key)
  }

  return specs
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
    if (metadata.width < 1 || metadata.height < 1 || metadata.width > 256 || metadata.height > 256) {
      throw new Error(
        `Style image exceeds the API's 256x256 limit: ${file} ` +
          `(${metadata.width}x${metadata.height})`,
      )
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
