import { readFile } from "node:fs/promises"
import { existsSync } from "node:fs"
import path from "node:path"
import { ManifestSchema, candidateCount, generationCost, type Manifest, type ResolvedSpec } from "./types.ts"
import { sha256, specHash } from "./hash.ts"

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
  filter?: { styles?: string[]; assets?: string[] },
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
  const styleImageCache = new Map<string, { base64: string; hash: string; size: number }>()
  async function loadStyleImage(rel: string) {
    const abs = path.resolve(root, rel)
    let hit = styleImageCache.get(abs)
    if (!hit) {
      if (!existsSync(abs)) throw new Error(`Style image not found: ${abs}`)
      const buf = await readFile(abs)
      hit = { base64: buf.toString("base64"), hash: sha256(buf), size: buf.length }
      styleImageCache.set(abs, hit)
    }
    return hit
  }

  for (const styleId of styleIds) {
    const style = manifest.styles[styleId]!
    const styleImageHashes: string[] = []
    for (const img of style.styleImages) {
      styleImageHashes.push((await loadStyleImage(img.path)).hash)
    }

    for (const [assetId, asset] of Object.entries(manifest.assets)) {
      if (filter?.assets?.length && !filter.assets.includes(assetId)) continue
      if (asset.styles.length && !asset.styles.includes(styleId)) continue

      const generator = style.generator
      let width: number
      let height: number
      let size: number

      if (generator === "1dir") {
        // Square only. When style images are in play the API derives the size
        // from the largest reference, so the manifest's `size` is advisory.
        size = asset.size ?? style.size ?? 64
        width = size
        height = size
      } else {
        width = asset.width ?? style.size ?? 64
        height = asset.height ?? style.size ?? 64
        size = Math.max(width, height)
      }

      const prompt = [style.promptPrefix, asset.prompt, style.promptSuffix]
        .map((p) => p.trim())
        .filter(Boolean)
        .join(", ")

      const relFile = asset.file ?? path.join(asset.category ?? "", `${assetId}.png`)
      const outFile = path.resolve(root, style.outDir, relFile)

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
        cost: generationCost(width, height),
        candidates: generator === "1dir" ? candidateCount(size) : 1,
      }

      specs.push({
        ...base,
        outFile,
        tags: [...style.tags, ...asset.tags, `pixelkiln:${manifest.name}`, `asset:${assetId}`, `style:${styleId}`],
        specHash: specHash(base, styleImageHashes),
      })
    }
  }

  return specs
}

/** Base64 payloads for a style's reference images, in manifest order. */
export async function styleImagesBase64(loaded: LoadedManifest, styleId: string): Promise<string[]> {
  const style = loaded.manifest.styles[styleId]
  if (!style) throw new Error(`Unknown style "${styleId}"`)
  const out: string[] = []
  for (const img of style.styleImages) {
    out.push((await readFile(path.resolve(loaded.root, img.path))).toString("base64"))
  }
  return out
}
