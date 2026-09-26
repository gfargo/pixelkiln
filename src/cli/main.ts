import { existsSync } from "node:fs"
import { readFile } from "node:fs/promises"
import { parseArgs, type Args } from "./args.ts"
import { HELP } from "./help.ts"
import { log } from "./io.ts"
import { runAdopt, runBalance, runPurge, runSalvage, runTag } from "./commands/account.ts"
import { runEdit } from "./commands/edit.ts"
import { runGallery } from "./commands/gallery.ts"
import { runGenerate } from "./commands/generate.ts"
import { runHistory, runRestoreGeneration } from "./commands/history.ts"
import { runAccept, runCache, runPrune } from "./commands/housekeeping.ts"
import { runInit } from "./commands/init.ts"
import { runAudit, runDoctor, runPlan, runStatus } from "./commands/inspect.ts"
import { runExport, runMount, runPack } from "./commands/pack.ts"
import { runFont, runUnzoom } from "./commands/pixellab-utils.ts"
import { runQuality } from "./commands/quality.ts"
import { runRecipe } from "./commands/recipe.ts"
import { runRefine } from "./commands/refine.ts"
import { runEstimateSkeleton, runSkeletonPreview } from "./commands/skeleton.ts"
import { runTools } from "./commands/tools.ts"
import { runWorkspace } from "./commands/workspace.ts"

async function runHelp(): Promise<void> {
  log(HELP)
}

/**
 * The bundle flattens this module into dist/cli.js, so package.json is one
 * directory up there and two up in source. Walk until it is found.
 */
async function runVersion(): Promise<void> {
  for (const up of ["../package.json", "../../package.json"]) {
    const url = new URL(up, import.meta.url)
    if (!existsSync(url)) continue
    const pkg = JSON.parse(await readFile(url, "utf8")) as { name: string; version: string }
    if (pkg.name === "pixelkiln") {
      log(`${pkg.name} ${pkg.version}`)
      return
    }
  }
  throw new Error("could not locate pixelkiln's package.json")
}

/**
 * One entry per command. A command that does different work depending on a
 * flag (restore with --generation, pack with --inputs) decides inside its
 * own module; the router only knows names.
 */
const RUNNERS: Record<string, (args: Args) => Promise<void>> = {
  help: runHelp,
  "--help": runHelp,
  "-h": runHelp,
  "--version": runVersion,
  "-v": runVersion,
  init: runInit,
  plan: runPlan,
  doctor: runDoctor,
  gen: runGenerate,
  submit: runGenerate,
  poll: runGenerate,
  pick: runGenerate,
  fetch: runGenerate,
  restore: (args) => (args.generation !== undefined ? runRestoreGeneration(args) : runGenerate(args)),
  adopt: runAdopt,
  accept: runAccept,
  salvage: runSalvage,
  purge: runPurge,
  prune: runPrune,
  audit: runAudit,
  cache: runCache,
  pack: runPack,
  mount: runMount,
  export: runExport,
  tag: runTag,
  balance: runBalance,
  status: runStatus,
  gallery: runGallery,
  edit: runEdit,
  tools: runTools,
  history: runHistory,
  quality: runQuality,
  refine: runRefine,
  recipe: runRecipe,
  workspace: runWorkspace,
  "estimate-skeleton": runEstimateSkeleton,
  "skeleton-preview": runSkeletonPreview,
  unzoom: runUnzoom,
  font: runFont,
}

export async function main(argv = process.argv.slice(2)): Promise<void> {
  const args = parseArgs(argv)
  const run = RUNNERS[args.command]
  if (!run) throw new Error(`Unknown command "${args.command}". Run \`pixelkiln help\` for the list.`)
  await run(args)
}
