/**
 * `layer preview`: a paperdoll layer's inpaint inputs, written and not sent.
 * Free and offline; see src/pipeline/layer-preview.ts.
 */
import path from "node:path"
import { UsageError } from "../../errors.ts"
import { previewLayer } from "../../pipeline/layer-preview.ts"
import { log } from "../io.ts"
import { openProject } from "../project.ts"
import type { Args } from "../args.ts"

export async function runLayer(args: Args): Promise<void> {
  const target = args.target!
  const project = await openProject(args)
  const named = project.specs.filter((spec) => spec.assetId === target)
  if (!named.length) throw new UsageError(`No asset "${target}" in ${args.manifest}`)
  const layers = named.filter((spec) => spec.character?.kind === "layer")
  if (!layers.length) throw new UsageError(`${target} is not a paperdoll layer`)
  if (layers.length > 1) {
    throw new UsageError(`${target} is a layer in ${layers.length} styles (${layers.map((spec) => spec.styleId).join(", ")}); pick one with --style`)
  }
  const result = await previewLayer(layers[0]!, project.lock)
  const width = Math.max(...result.frames.map((frame) => frame.name.length))
  for (const frame of result.frames) {
    const neck = frame.neck
      ? `neck row ${String(frame.neck.row).padStart(3)}` +
        (frame.neck.corrected ? `  (own narrowest row ${frame.neck.detected ?? "none"}; taken from the head and the other frames)` : "")
      : result.supplied.mask ? "mask supplied" : "empty"
    log(`  ${frame.name.padEnd(width)}  ${String(frame.masked).padStart(6)} px open  ${neck}`)
  }
  const corrected = result.frames.filter((frame) => frame.neck?.corrected).length
  if (corrected) log(`  ${corrected} frame${corrected === 1 ? "'s" : "s'"} neck overruled; look at those in overlay.png before paying`)
  if (result.closed) log(`  ${result.closed} pinhole pixel${result.closed === 1 ? "" : "s"} keyed shut inside the mask`)
  if (result.cleaned) log(`  ${result.cleaned} ghost pixel${result.cleaned === 1 ? "" : "s"} cleaned from the loops`)
  log(`  wrote ${result.written.length} files to ${path.relative(process.cwd(), result.dir) || "."} (overlay.png shows the mask over the frames)`)
  log(`  ${result.frames.length} frames on a ${result.sheet.width}x${result.sheet.height} sheet: about ${result.cost} generations when generated; nothing was sent`)
}
