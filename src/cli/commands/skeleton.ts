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
import { readFile, writeFile } from "node:fs/promises"
import { UsageError } from "../../errors.ts"
import { loadEnvFiles } from "../../env.ts"
import { clientFromEnv } from "../../client.ts"
import { imageMetadata } from "../../media.ts"
import { log } from "../io.ts"
import type { Args } from "../args.ts"

export async function runEstimateSkeleton(args: Args): Promise<void> {
  const image = args.target
  if (!image) throw new UsageError("estimate-skeleton needs an image path: pixelkiln estimate-skeleton <image> [--out keypoints.json]")

  // A manifest is not required to run this, but its directory (or the
  // current directory when none is given) is still where .env.local lives,
  // the same lookup `runBalance` does.
  loadEnvFiles(path.dirname(path.resolve(args.manifest)))
  loadEnvFiles(process.cwd())

  const bytes = await readFile(path.resolve(image))
  const metadata = imageMetadata(bytes)
  if (!metadata) throw new UsageError(`${image} is not a readable PNG or JPEG`)

  const client = clientFromEnv()
  const res = await client.estimateSkeleton({
    image: { base64: bytes.toString("base64"), format: metadata.format },
  })
  const json = JSON.stringify(res.keypoints, null, 2)

  if (args.out) {
    await writeFile(path.resolve(args.out), json + "\n")
    log(`  wrote ${res.keypoints.length} keypoints to ${args.out}`)
  } else {
    log(json)
  }
}
