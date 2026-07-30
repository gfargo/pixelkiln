import { createHash } from "node:crypto"
import { readFile } from "node:fs/promises"
import type { ResolvedSpec } from "./types.ts"

export function sha256(data: Buffer | string): string {
  return createHash("sha256").update(data).digest("hex")
}

export async function sha256File(path: string): Promise<string> {
  return sha256(await readFile(path))
}

/**
 * Identity of a spec: everything that would change the generated image.
 * `outFile` and `tags` are deliberately excluded — renaming the destination or
 * retagging should not force a costly regeneration.
 */
export function specHash(
  spec: Omit<ResolvedSpec, "specHash" | "outFile" | "tags">,
  styleImageHashes: string[],
): string {
  return sha256(
    JSON.stringify({
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
      styleImages: styleImageHashes,
    }),
  )
}
