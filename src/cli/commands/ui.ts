/** `ui`: split a PixelLab UI template, give its elements states, set 9-slice insets, and pull the pieces. */
import path from "node:path"
import { clientFromEnv, type PixelLabUiAsset } from "../../client.ts"
import { loadEnvFiles } from "../../env.ts"
import { UsageError } from "../../errors.ts"
import {
  checkUiInsets,
  createUiStates,
  parseUiBox,
  parseUiInsets,
  parseUiState,
  pullUiAsset,
  UI_STATES_COSTS,
  UI_STATES_MAX_COST,
} from "../../pixellab-ui.ts"
import { confirm, log } from "../io.ts"
import type { Args } from "../args.ts"

function loadKeys(args: Pick<Args, "manifest">): void {
  loadEnvFiles(path.dirname(path.resolve(args.manifest)))
  loadEnvFiles(process.cwd())
}

function requireId(args: Args): string {
  if (!args.id) throw new UsageError(`ui ${args.subcommand} needs --id <ui asset id>: a template from the uiAsset generator, or one of its elements`)
  return args.id
}

const insetsText = (slice: { left: number; right: number; top: number; bottom: number } | null | undefined) =>
  slice ? `  9-slice ${slice.left},${slice.right},${slice.top},${slice.bottom}` : ""

function printAsset(asset: PixelLabUiAsset): void {
  log(`  ${asset.kind ?? "template"} ${asset.id}  ${asset.size.width}x${asset.size.height}  ${asset.status ?? ""}${insetsText(asset.nine_slice)}`)
  if (asset.prompt) log(`    "${asset.prompt}"`)
  for (const element of asset.elements) {
    const box = element.template_box
    log(`    element ${element.id}  ${element.name || box?.label || "(unnamed)"}  ${element.size.width}x${element.size.height}` +
      `${box ? `  at ${box.x},${box.y}` : ""}${insetsText(element.nine_slice)}`)
    for (const state of element.states) log(`      state ${state.id}  ${state.name ?? "(unnamed)"}`)
  }
  for (const state of asset.states) log(`    state ${state.id}  ${state.name ?? "(unnamed)"}`)
  if (!asset.elements.length && asset.split_preview.length) {
    log(`    not split yet; ui split would cut ${asset.split_preview.length} element(s):`)
    for (const box of asset.split_preview) log(`      ${box.label || "(unnamed)"}  ${box.width}x${box.height} at ${box.x},${box.y}`)
  }
}

export async function runUi(args: Args): Promise<void> {
  const id = requireId(args)

  if (args.subcommand === "show") {
    loadKeys(args)
    const asset = await clientFromEnv().getUiAssetDetail(id)
    if (args.json) log(JSON.stringify({ version: 1, asset }, null, 2))
    else printAsset(asset)
    return
  }

  if (args.subcommand === "split") {
    const boxes = args.boxes.map(parseUiBox)
    if (args.dryRun) {
      log(`  would split ${id} ${boxes.length ? `into ${boxes.length} box(es)` : "along its generated shapes"}; nothing sent`)
      return
    }
    loadKeys(args)
    const client = clientFromEnv()
    const before = await client.getUiAssetDetail(id)
    if (before.elements.length) {
      throw new Error(`template ${id} is already split into ${before.elements.length} element(s); a template splits once (delete its elements on PixelLab to split it again)`)
    }
    const elements = await client.splitUiAsset(id, boxes.length ? boxes : undefined)
    if (args.json) {
      log(JSON.stringify({ version: 1, elements }, null, 2))
      return
    }
    log(`  split ${id} into ${elements.length} element(s) (free):`)
    for (const element of elements) log(`    ${element.id}  ${element.name || element.template_box?.label || "(unnamed)"}  ${element.size.width}x${element.size.height}`)
    return
  }

  if (args.subcommand === "states") {
    if (!args.uiStates.length) {
      throw new UsageError('ui states needs at least one --state "name=description", e.g. --state "hover=brighter, a soft glow on the rim"')
    }
    const states = args.uiStates.map(parseUiState)
    log(`  ui states: ${states.map((state) => state.name).join(", ")} for ${args.elements.length ? `${args.elements.length} element(s) of ${id}` : id}`)
    log(`  cost: ${UI_STATES_COSTS.join(", ")} generations by the size of the grid PixelLab lays out; the exact price is quoted on submit`)
    if (args.budget !== undefined && args.budget < UI_STATES_MAX_COST) {
      throw new Error(`--budget ${args.budget} is below the ${UI_STATES_MAX_COST} generations this call can cost`)
    }
    if (args.dryRun) {
      log("  dry run: nothing sent")
      return
    }
    if (!(await confirm(`  Spend up to ${UI_STATES_MAX_COST} generations on these states?`, args.yes))) return
    loadKeys(args)
    let last = ""
    const res = await createUiStates(clientFromEnv(), {
      uiAssetId: id,
      elementIds: args.elements,
      states,
      targetPalette: args.palette.length || args.maxColors !== undefined
        ? { ...(args.palette.length ? { colors: args.palette } : {}), ...(args.maxColors !== undefined ? { maxColors: args.maxColors } : {}) }
        : undefined,
      onQuote: (generations, count) => log(`  quoted ${generations} generations for ${count} state image(s)`),
      onProgress: (status) => {
        if (status !== last) log(`  ${status}…`)
        last = status
      },
    })
    if (args.json) {
      log(JSON.stringify({ version: 1, ...res }, null, 2))
      return
    }
    printAsset(res.asset)
    log(`  pull the images with: pixelkiln ui pull --id ${id} --out <dir>`)
    return
  }

  if (args.subcommand === "nine-slice") {
    if (args.clear === Boolean(args.insets)) throw new UsageError('ui nine-slice needs --insets <n | left,right,top,bottom> or --clear')
    const insets = args.insets ? parseUiInsets(args.insets) : undefined
    if (args.dryRun) {
      log(`  would ${insets ? `set 9-slice ${args.insets}` : "clear the 9-slice"} on ${id}; nothing sent`)
      return
    }
    loadKeys(args)
    const client = clientFromEnv()
    if (insets) checkUiInsets(insets, (await client.getUiAssetDetail(id)).size)
    const asset = await client.updateUiAsset(id, insets ? { nineSlice: insets } : { clearNineSlice: true })
    if (args.json) log(JSON.stringify({ version: 1, asset }, null, 2))
    else log(`  ${id}: ${asset.nine_slice ? `9-slice ${asset.nine_slice.left},${asset.nine_slice.right},${asset.nine_slice.top},${asset.nine_slice.bottom}` : "no 9-slice (plain scaling)"} (free)`)
    return
  }

  // pull
  if (!args.out) throw new UsageError("ui pull needs --out <dir>: the images and a ui.json record are written there")
  if (args.dryRun) {
    log(`  would download ${id} into ${args.out}; nothing sent`)
    return
  }
  loadKeys(args)
  const res = await pullUiAsset(clientFromEnv(), id, { out: args.out, force: args.force })
  if (args.json) {
    log(JSON.stringify({ version: 1, ...res }, null, 2))
    return
  }
  for (const file of res.files) log(`  wrote ${path.join(args.out, file.file)}  (${file.kind}, ${file.size.width}x${file.size.height})`)
  log(`  wrote ${path.join(args.out, "ui.json")}`)
}
