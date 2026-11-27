/**
 * `layer preview`: each paperdoll layer drawn over the frames it dresses, the
 * way `pack --flatten` draws it, as a strip per source or, with `--gif`, a
 * GIF per loop. A fringe or a seam between two loops' layers is easier to
 * judge moving than on a still sheet. Free and local.
 */
import { mkdir, writeFile } from "node:fs/promises"
import path from "node:path"
import { UsageError } from "../../errors.ts"
import { dressedGif, dressedStrip, dressLayer } from "../../pipeline/layer-preview.ts"
import { log } from "../io.ts"
import { openProject } from "../project.ts"
import type { Args } from "../args.ts"

export async function runLayer(args: Args): Promise<void> {
  const project = await openProject(args)
  const manifestDir = path.dirname(path.resolve(args.manifest))
  const layers = project.specs.filter((spec) => spec.character?.kind === "layer" && (!args.target || spec.assetId === args.target))
  if (!layers.length) {
    throw new UsageError(args.target ? `${args.target} is not a paperdoll layer in ${args.manifest}` : `${args.manifest} declares no paperdoll layers`)
  }
  if (args.out && layers.length > 1) {
    throw new UsageError(`--out names one layer's folder; ${layers.length} match. Name the layer: pixelkiln layer preview <layer> [--style <id>]`)
  }
  for (const spec of layers) {
    const dir = path.resolve(args.out ?? path.join(manifestDir, ".pixelkiln", "previews", spec.styleId, spec.assetId))
    await mkdir(dir, { recursive: true })
    for (const source of dressLayer(spec, project.lock)) {
      const gif = args.gif && !source.still
      const file = path.join(dir, `${source.assetId}.${gif ? "gif" : "png"}`)
      await writeFile(file, gif ? dressedGif(source) : dressedStrip(source))
      const trimmed = spec.character!.layer!.trim ? `, trim hid ${source.cut} base pixel${source.cut === 1 ? "" : "s"}` : ""
      log(`  ${spec.styleId}/${spec.assetId} over ${source.assetId}: ${source.frames.length} frame${source.frames.length === 1 ? "" : "s"}${trimmed}`)
      log(`    ${path.relative(process.cwd(), file)}`)
      if (source.missing.length) log(`    no layer frame over ${source.missing.join(", ")}; shown bare`)
    }
  }
}
