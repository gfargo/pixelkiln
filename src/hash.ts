import { createHash } from "node:crypto"
import { createReadStream } from "node:fs"
import type { ResolvedSpec } from "./types.ts"

export function sha256(data: Buffer | string): string {
  return createHash("sha256").update(data).digest("hex")
}

export async function sha256File(path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256")
    const stream = createReadStream(path)
    stream.on("data", (chunk) => hash.update(chunk))
    stream.on("error", reject)
    stream.on("end", () => resolve(hash.digest("hex")))
  })
}

/**
 * Identity of a spec: everything that would change the generated image.
 * Project root, `outFile`, `source`, and `tags` are deliberately excluded —
 * moving a checkout, renaming the destination, swapping the committed art a
 * `mount` places, or retagging should not regenerate art.
 *
 * Generator-specific parameters are hashed only where they apply, and are
 * left `undefined` otherwise so `JSON.stringify` drops the key entirely.
 * That matters: adding a field unconditionally rewrites the hash of every
 * spec in every existing lockfile, and each one then reports as `stale` and
 * invites a full regeneration of art that never changed. Adding `palette`
 * unconditionally did exactly that once already.
 */
export function specHash(
  spec: Omit<ResolvedSpec, "specHash" | "root" | "outFile" | "quality" | "source" | "tags">,
  styleImageHashes: string[],
  providerOptionIdentity: unknown = spec.providerOptions,
): string {
  return sha256(
    JSON.stringify({
      // Preserve every existing PixelLab hash while making a provider switch
      // invalidate the spec. Older manifests implicitly mean pixellab.
      provider: spec.provider === "pixellab" ? undefined : spec.provider,
      providerOptions:
        providerOptionIdentity &&
        (typeof providerOptionIdentity !== "object" || Object.keys(providerOptionIdentity).length > 0)
          ? providerOptionIdentity
          : undefined,
      generator: spec.generator,
      prompt: spec.prompt,
      width: spec.width,
      height: spec.height,
      view: spec.view,
      outline: spec.outline ?? null,
      shading: spec.shading ?? null,
      detail: spec.detail ?? null,
      seed: spec.seed ?? null,
      palette: spec.palette,
      // `noBackground` only reaches the wire for pixflux; the tile fields are
      // undefined for every other generator. `tileSize` is intentionally
      // absent — width/height are derived from it, so it is already covered.
      noBackground:
        spec.generator === "pixflux" || spec.provider !== "pixellab"
          ? spec.noBackground
          : undefined,
      tileType: spec.tileType,
      tileView: spec.tileView,
      tileFeature: spec.tileFeature,
      outlineMode: spec.outlineMode,
      styleImages: styleImageHashes,
    }),
  )
}
