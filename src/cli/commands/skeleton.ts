/**
 * `estimate-skeleton`: a direct, un-budgeted PixelLab account call, outside
 * the manifest/plan/lock pipeline entirely — same category as `balance`, not
 * a generation. This is the concrete tool an author uses to bootstrap an
 * `animate-skeleton` revision's `keypointsFile`: estimate once, sanity-check
 * the result, hand-tweak a few joints for in-between frames, rather than
 * hand-typing 18 joints of `{label, x, y, z_index}` from scratch.
 *
 * Deliberately not wired into `resolveSpecs`/`estimate()`/`submitRevision` —
 * see `PixelLabClient.estimateSkeleton`'s own doc comment for why.
 */
import path from "node:path"
import { existsSync } from "node:fs"
import { readFile, writeFile } from "node:fs/promises"
import { UsageError } from "../../errors.ts"
import { loadEnvFiles } from "../../env.ts"
import { clientFromEnv } from "../../client.ts"
import { loadManifest, resolveSpecs } from "../../manifest.ts"
import { imageMetadata } from "../../media.ts"
import { decodePng } from "../../png.ts"
import { DEFAULT_SCAFFOLD_FRAMES, parseSkeletonSet, scaffoldSkeletonSet, type SkeletonSet } from "../../skeleton.ts"
import { renderSkeletonSheet } from "../../skeleton-preview.ts"
import { log } from "../io.ts"
import type { Args } from "../args.ts"

/** `/estimate-skeleton`'s own documented sizes: square, 16 to 256. */
export const ESTIMATE_SKELETON_SIZES = [16, 32, 64, 128, 256] as const

export async function runEstimateSkeleton(args: Args): Promise<void> {
  const image = args.target
  if (!image) throw new UsageError("estimate-skeleton needs an image path: pixelkiln estimate-skeleton <image> [--out keypoints.json]")
  // Checked before the network: re-estimating over a hand-edited file would
  // silently discard the edits.
  if (args.out && existsSync(path.resolve(args.out)) && !args.force) {
    throw new UsageError(`${args.out} already exists; pass --force to replace it`)
  }

  // A manifest is not required to run this, but its directory (or the
  // current directory when none is given) is still where .env.local lives,
  // the same lookup `runBalance` does.
  loadEnvFiles(path.dirname(path.resolve(args.manifest)))
  loadEnvFiles(process.cwd())

  const bytes = await readFile(path.resolve(image))
  const metadata = imageMetadata(bytes)
  if (!metadata) throw new UsageError(`${image} is not a readable PNG or JPEG`)
  if (metadata.width !== metadata.height || !(ESTIMATE_SKELETON_SIZES as readonly number[]).includes(metadata.width)) {
    throw new UsageError(
      `${image} is ${metadata.width}x${metadata.height}; estimate-skeleton takes a square image of ` +
        `${ESTIMATE_SKELETON_SIZES.join(", ")} pixels`,
    )
  }

  const client = clientFromEnv()
  const res = await client.estimateSkeleton({
    image: { base64: bytes.toString("base64"), format: metadata.format },
  })
  // Written as a whole keypoints file, the shape a revision's keypointsFile
  // is validated against, so the output is usable as it stands: the estimate
  // is the pose the image is in, and each frame starts as a copy to move.
  const frames = args.frames ?? DEFAULT_SCAFFOLD_FRAMES
  const json = JSON.stringify(scaffoldSkeletonSet(res.keypoints, frames), null, 2)

  if (args.out) {
    await writeFile(path.resolve(args.out), json + "\n")
    log(`  wrote ${args.out}: the estimated pose and ${frames} frames to edit`)
    log(`  preview it with: pixelkiln skeleton-preview ${args.out} --from ${image}`)
  } else {
    log(json)
  }
}

/**
 * `skeleton-preview`: draws every pose in a keypoints file over its source
 * image, as one PNG. Local and free. The target is a keypoints file (with
 * `--from` naming the image), or an `animate-skeleton` asset id, whose
 * manifest already says which file and which source image.
 */
export async function runSkeletonPreview(args: Args): Promise<void> {
  const target = args.target!
  let keypointsFile: string
  let sourceFile: string | undefined
  let label: string
  if (target.endsWith(".json")) {
    keypointsFile = path.resolve(target)
    sourceFile = args.from ? path.resolve(args.from) : undefined
    label = target
  } else {
    const loaded = await loadManifest(args.manifest)
    const specs = (await resolveSpecs(loaded, { styles: args.styles, assets: [target] }))
      .filter((spec) => spec.assetId === target)
    const spec = specs.find((candidate) => candidate.revision?.mode === "animate-skeleton")
    if (!spec) {
      throw new UsageError(
        specs.length
          ? `${target} is not an animate-skeleton revision; pass a keypoints file instead`
          : `No asset "${target}" in ${args.manifest}`,
      )
    }
    keypointsFile = spec.revision!.keypointsFile!
    sourceFile = args.from ? path.resolve(args.from) : spec.revision!.sourceFile
    label = `${spec.styleId}/${spec.assetId}`
  }

  if (!existsSync(keypointsFile)) throw new UsageError(`Keypoints file does not exist yet: ${keypointsFile}`)
  let json: unknown
  try {
    json = JSON.parse(await readFile(keypointsFile, "utf8"))
  } catch (error) {
    throw new UsageError(`${keypointsFile} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`)
  }
  const set: SkeletonSet = parseSkeletonSet(json, keypointsFile)

  let source
  if (sourceFile) {
    if (!existsSync(sourceFile)) {
      log(`  source image does not exist yet, drawing on a plain ground: ${sourceFile}`)
    } else {
      const bytes = await readFile(sourceFile)
      if (imageMetadata(bytes)?.format !== "png") throw new UsageError(`${sourceFile} must be a PNG to preview over`)
      source = decodePng(bytes)
    }
  }

  const out = path.resolve(args.out ?? keypointsFile.replace(/\.json$/, "") + ".preview.png")
  await writeFile(out, renderSkeletonSheet(set, { source }))
  log(`  ${label}: ${set.frames.length} frames after the starting pose`)
  const shown = path.relative(process.cwd(), out)
  log(`  wrote ${shown.startsWith("..") ? out : shown}`)
}
