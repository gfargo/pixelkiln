/**
 * `redraw`: draws named frames of a paperdoll layer again, one small inpaint
 * with the layer's other frames shown dressed beside them. Like `anchors` it
 * is a direct account call outside the plan and `--budget`; unlike it, the
 * result lands in the lockfile, as the layer's own frames.
 */
import path from "node:path"
import { UsageError } from "../../errors.ts"
import { clientFromEnv } from "../../client.ts"
import { redrawLayerFrames, redrawRoles } from "../../pipeline/redraw.ts"
import { PixelLabProvider } from "../../providers/pixellab.ts"
import { log } from "../io.ts"
import { openProject } from "../project.ts"
import type { Args } from "../args.ts"

export async function runRedraw(args: Args): Promise<void> {
  const target = args.target!
  const project = await openProject(args)
  const named = project.specs.filter((spec) => spec.assetId === target)
  if (!named.length) throw new UsageError(`No asset "${target}" in ${args.manifest}`)
  const layers = named.filter((spec) => spec.character?.kind === "layer")
  if (!layers.length) throw new UsageError(`${target} is not a paperdoll layer; redraw is for single frames of one`)
  if (layers.length > 1) {
    throw new UsageError(`${target} is a layer in ${layers.length} styles (${layers.map((spec) => spec.styleId).join(", ")}); pick one with --style`)
  }
  const spec = layers[0]!
  if (spec.provider !== "pixellab") throw new UsageError(`redraw inpaints with PixelLab; style "${spec.styleId}" uses ${spec.provider}`)
  if (!args.redrawFrames.length) {
    const roles = redrawRoles(spec, project.lock)
    throw new UsageError(
      roles.length
        ? `redraw needs the frames to draw again: pixelkiln redraw ${target} --frame <name>\n  ${roles.join("\n  ")}`
        : `${target} has no downloaded frames to redraw; generate it first`,
    )
  }
  const never = async (): Promise<never> => { throw new Error("a dry run calls nothing") }
  const painter = args.dryRun ? { paintSheet: never, paintedSheet: never } : new PixelLabProvider(clientFromEnv())
  const result = await redrawLayerFrames(spec, project.lock, painter, {
    frames: args.redrawFrames,
    lockPath: path.resolve(args.lock),
    seed: args.seed,
    dryRun: args.dryRun,
    onProgress: log,
  })
  const frames = `${result.roles.length} frame${result.roles.length === 1 ? "" : "s"}`
  const sheet = `${result.sheet.width}x${result.sheet.height}`
  if (args.dryRun) {
    log(`  would redraw ${frames} (${result.roles.join(", ")}) beside ${result.guides} dressed, on a ${sheet} sheet: about ${result.cost} generations`)
    return
  }
  for (const file of result.written) log(`  wrote   ${path.relative(process.cwd(), file)}`)
  const billed = result.billed ? `${result.billed.amount} ${result.billed.unit} billed` : `about ${result.cost} generations`
  log(`  redrew ${frames} of ${target} (${billed}); the sheet and result are in ${path.relative(process.cwd(), result.workDir)}`)
  log(`  look at ${result.written.length === 1 ? "it" : "them"}, then run pixelkiln gen to rebuild anything made from this layer`)
}
