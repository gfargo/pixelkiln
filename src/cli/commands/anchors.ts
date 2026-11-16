/**
 * `anchors`: writes the anchors file a held item (a layer with `attach`)
 * places its sprite by, one PixelLab skeleton estimate per frame of the
 * layer's sources. Like `estimate-skeleton` it is a direct, un-budgeted
 * account call outside the plan and lockfile: the pipeline reads the file it
 * leaves, hashed like any other input, and never estimates on its own.
 */
import path from "node:path"
import { UsageError } from "../../errors.ts"
import { clientFromEnv } from "../../client.ts"
import { ANCHOR_COST, writeAnchors } from "../../pipeline/attach.ts"
import { log } from "../io.ts"
import { openProject } from "../project.ts"
import type { Args } from "../args.ts"

export async function runAnchors(args: Args): Promise<void> {
  const target = args.target!
  const { specs, lock } = await openProject(args)
  const named = specs.filter((spec) => spec.assetId === target)
  if (!named.length) throw new UsageError(`No asset "${target}" in ${args.manifest}`)
  const held = named.filter((spec) => spec.character?.layer?.attach)
  if (!held.length) throw new UsageError(`${target} is not a held item; anchors are for a layer with attach`)
  if (held.length > 1) {
    throw new UsageError(`${target} is a held item in ${held.length} styles (${held.map((spec) => spec.styleId).join(", ")}); pick one with --style`)
  }
  const spec = held[0]!
  if (spec.provider !== "pixellab") {
    throw new UsageError(`anchors estimates skeletons with PixelLab; style "${spec.styleId}" uses ${spec.provider}. Write the anchors file by hand instead.`)
  }

  const cost = (frames: number) => `${Number((frames * ANCHOR_COST).toFixed(1))} generation${frames * ANCHOR_COST === 1 ? "" : "s"}`
  const result = await writeAnchors(spec, lock, args.dryRun ? { estimateSkeleton: async () => ({ keypoints: [] }) } : clientFromEnv(), {
    force: args.force,
    dryRun: args.dryRun,
    onProgress: log,
  })
  const file = path.relative(spec.root, result.file) || result.file
  if (args.dryRun) {
    log(`  ${result.estimated} frame${result.estimated === 1 ? "" : "s"} to estimate (about ${cost(result.estimated)}), ${result.current} already current`)
  } else if (result.estimated) {
    log(`  wrote ${file}: ${result.estimated} frame${result.estimated === 1 ? "" : "s"} estimated (about ${cost(result.estimated)}), ${result.current} already current`)
    log(`  place the item with: pixelkiln gen --only ${target}`)
  } else {
    log(`  ${file} is current: all ${result.current} frames match their anchors`)
  }
}
