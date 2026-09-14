/** `init`: scaffold a manifest from a tree of PNGs. */
import path from "node:path"
import { existsSync } from "node:fs"
import { scanAssets, buildManifest, writeManifestFile } from "../../pipeline/init.ts"

import { log } from "../io.ts"
import type { Args } from "../args.ts"

export async function runInit(args: Args): Promise<void> {
  if (!args.from) throw new Error("init needs --from <dir> pointing at your existing PNGs.")
  const root = path.resolve(args.from)
  if (!existsSync(root)) throw new Error(`No directory at ${root}`)

  const generator = (args.generator ?? "map") as "1dir" | "map"
  if (generator !== "1dir" && generator !== "map") {
    throw new Error(`--generator must be "1dir" or "map", got "${args.generator}".`)
  }

  const target = path.resolve(args.out ?? "pixelkiln.manifest.json")
  const { assets, skipped } = await scanAssets(root, { exclude: args.exclude })
  if (!assets.length) throw new Error(`No PNGs found under ${root}`)

  const manifest = buildManifest(
    args.name ?? path.basename(path.dirname(target)),
    args.styles[0] ?? "base",
    generator,
    path.relative(path.dirname(target), root) || ".",
    assets,
  )
  await writeManifestFile(target, manifest)

  log(`  scanned ${assets.length} PNG(s) under ${path.relative(process.cwd(), root)}`)
  if (skipped.length) log(`  skipped ${skipped.length} unreadable file(s)`)
  log(`  wrote ${path.relative(process.cwd(), target)}`)
  log(`\n  Prompts are intentionally empty. To recover the real ones from your`)
  log(`  PixelLab account instead of inventing them:`)
  log(`\n    pixelkiln adopt --manifest ${path.relative(process.cwd(), target)} --write-prompts\n`)
}
