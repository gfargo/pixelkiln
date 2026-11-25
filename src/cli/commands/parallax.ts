import path from "node:path"
import { writeManagedArtifactBundle, type ArtifactFile } from "../../artifacts.ts"
import {
  cameraPath,
  composeParallaxFrame,
  exportParallax,
  layerFiles,
  PARALLAX_FORMATS,
  previewHtml,
  resolveParallaxSet,
  type ParallaxFormat,
  type ResolvedParallaxSet,
} from "../../pipeline/parallax.ts"
import { encodeRgbaPng, joinStripPng } from "../../png.ts"
import type { Args } from "../args.ts"
import { log } from "../io.ts"
import { openProject, provenanceFile } from "../project.ts"

/**
 * `pixelkiln parallax preview [set]` writes a page that scrolls the set and a
 * strip of frames; `pixelkiln parallax export [set] --format tiled|godot|ldtk`
 * writes an engine file and the layer pictures it uses. Both read generated
 * layers from the lockfile and spend nothing.
 */
export async function runParallax(args: Args): Promise<void> {
  const { loaded, lock } = await openProject(args)
  const manifestDir = path.dirname(path.resolve(args.manifest))
  const ids = Object.keys(loaded.manifest.parallax ?? {})
  if (!ids.length) throw new Error("The manifest has no parallax sets. Add one under \"parallax\"; see docs/PARALLAX.md.")
  const wanted = args.target ? [args.target] : ids
  if (args.out && wanted.length > 1) {
    throw new Error(`--out names one set; this manifest has ${ids.length} (${ids.join(", ")}). Name the set: pixelkiln parallax ${args.subcommand} <set>`)
  }

  for (const id of wanted) {
    const set = await resolveParallaxSet(loaded.manifest, manifestDir, lock, id)
    const root = path.resolve(args.out ?? path.join(manifestDir, "parallax", id))
    const sources = [
      await provenanceFile("$manifest", args.manifest),
      await provenanceFile("$lock", args.lock),
      ...(await Promise.all(
        set.layers.flatMap((layer) =>
          layerFiles(layer).map((file, n, all) => provenanceFile(all.length > 1 || layer.source.kind === "run" ? `layer:${layer.name}:${n + 1}` : `layer:${layer.name}`, file)),
        ),
      )),
    ]
    const describe = setOptions(set)
    if (args.subcommand === "export") {
      const formats: ParallaxFormat[] = args.format ? [args.format as ParallaxFormat] : [...PARALLAX_FORMATS]
      for (const format of formats) {
        const base = path.join(root, format, id)
        const result = exportParallax(set, format, base)
        const outputs: ArtifactFile[] = result.files.map((file) => ({ path: file.path, data: typeof file.data === "string" ? Buffer.from(file.data) : file.data }))
        await writeManagedArtifactBundle(`${base}.pixelkiln.json`, outputs, {
          kind: "parallax",
          sources,
          options: { set: id, ...describe, ...result.options },
        }, { force: args.force })
        log(`  ${id} (${format}): ${path.relative(process.cwd(), result.files[0]!.path)} + ${result.files.length - 1} picture(s)`)
        for (const warning of (result.options.warnings as string[] | undefined) ?? []) log(`    warning: ${warning}`)
      }
    } else {
      const frames = args.frames ?? 3
      const strip = joinStripPng(
        cameraPath(set, frames).map(([x, y]) => {
            const frame = composeParallaxFrame(set, x, y)
            return encodeRgbaPng(frame.width, frame.height, frame.pixels)
          }),
      )
      const base = path.join(root, `${id}.preview`)
      await writeManagedArtifactBundle(`${base}.pixelkiln.json`, [
        { path: `${base}.html`, data: Buffer.from(previewHtml(set)) },
        { path: `${base}.png`, data: strip },
      ], {
        kind: "parallax",
        sources,
        options: { set: id, ...describe, preview: { frames } },
      }, { force: args.force })
      log(`  ${id}: ${path.relative(process.cwd(), base)}.html (scrolls in a browser) + .png (${frames} frames, start to end)`)
    }
    for (const layer of set.layers) {
      const seam = (layer.seamRatio === undefined ? "" : `, seam ${layer.seamRatio.toFixed(1)}`) +
        (layer.seamRatioY === undefined ? "" : `, vertical seam ${layer.seamRatioY.toFixed(1)}`)
      log(`    ${layer.name}: ${layer.png.width}x${layer.png.height} at ${layer.x},${layer.y}, speed ${layer.speed}/${layer.speedY}${seam}`)
    }
    for (const warning of set.warnings) log(`    warning: ${warning}`)
  }
}

function setOptions(set: ResolvedParallaxSet): Record<string, unknown> {
  return {
    view: set.view,
    travel: set.travel,
    climb: set.climb,
    layers: set.layers.map((layer) => ({
      name: layer.name,
      speed: layer.speed,
      speedY: layer.speedY,
      x: layer.x,
      y: layer.y,
      repeat: layer.repeat,
      repeatY: layer.repeatY,
      ...(layer.source.kind === "sky" ? { sky: layer.source.colors } : {}),
      ...(layer.source.kind === "run" ? { run: { seed: layer.source.seed, sprites: layer.source.sprites.length, width: layer.png.width } } : {}),
      ...(layer.finish ?? {}),
    })),
    ...(set.palette ? { palette: set.palette } : {}),
  }
}
