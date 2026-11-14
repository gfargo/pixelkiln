/**
 * PixelLab UI assets after generation: split a template into elements, give
 * the elements states, set 9-slice insets, and pull the pieces down as files
 * with one record. Standalone, like `font` and `vfx`: the manifest's `uiAsset`
 * generator still makes the template.
 */
import { existsSync } from "node:fs"
import { mkdir, writeFile } from "node:fs/promises"
import path from "node:path"
import type { PixelLabClient, PixelLabUiAsset, TargetPaletteArg } from "./client.ts"
import { sha256 } from "./hash.ts"
import { validateMedia, MediaType } from "./media.ts"

/** PixelLab's three prices for one states generation, by the side of the grid it lays out. */
export const UI_STATES_COSTS = [10, 15, 25] as const
/** The most one `ui states` call can cost; what a `--budget` is checked against before the quote is known. */
export const UI_STATES_MAX_COST = 25
export const UI_STATES_MAX_ELEMENTS = 64
export const UI_STATES_MAX_STATES = 16

export interface UiStateSpec {
  name: string
  description: string
}

/** `"hover=brighter, a soft glow on the rim"` as a state. The description may itself contain `=` and commas. */
export function parseUiState(text: string): UiStateSpec {
  const at = text.indexOf("=")
  const name = at < 0 ? "" : text.slice(0, at).trim()
  const description = at < 0 ? "" : text.slice(at + 1).trim()
  if (!name || !description) {
    throw new Error(`a state is written "name=description", e.g. "pressed=pushed in: darker, face 1 px lower"; got "${text}"`)
  }
  return { name, description }
}

export interface UiBox {
  label?: string
  x: number
  y: number
  width: number
  height: number
}

/** `"Play:40,30,120,40"` or `"40,30,120,40"` as a crop box in template pixels. */
export function parseUiBox(text: string): UiBox {
  const colon = text.lastIndexOf(":")
  const label = colon < 0 ? "" : text.slice(0, colon).trim()
  const numbers = (colon < 0 ? text : text.slice(colon + 1)).split(",").map((part) => Number(part.trim()))
  if (numbers.length !== 4 || numbers.some((n) => !Number.isInteger(n) || n < 0) || numbers[2]! < 1 || numbers[3]! < 1) {
    throw new Error(`a box is written "label:x,y,width,height" in template pixels, e.g. "Play:40,30,120,40"; got "${text}"`)
  }
  const [x, y, width, height] = numbers as [number, number, number, number]
  return { ...(label ? { label } : {}), x, y, width, height }
}

export interface UiInsets {
  left: number
  right: number
  top: number
  bottom: number
}

/** `"6"` (all four sides) or `"left,right,top,bottom"` as 9-slice insets. */
export function parseUiInsets(text: string): UiInsets {
  const numbers = text.split(",").map((part) => Number(part.trim()))
  if ((numbers.length !== 1 && numbers.length !== 4) || numbers.some((n) => !Number.isInteger(n) || n < 0)) {
    throw new Error(`insets are one whole number for every side, or "left,right,top,bottom"; got "${text}"`)
  }
  const [left, right = left, top = left, bottom = left] = numbers as [number, number?, number?, number?]
  return { left, right, top, bottom }
}

/** Insets must leave a stretchable middle: left + right below the width, top + bottom below the height. */
export function checkUiInsets(insets: UiInsets, size: { width: number; height: number }): void {
  if (insets.left + insets.right >= size.width || insets.top + insets.bottom >= size.height) {
    throw new Error(
      `insets ${insets.left},${insets.right},${insets.top},${insets.bottom} leave no middle to stretch in a ${size.width}x${size.height} image; ` +
        "left + right must be below the width and top + bottom below the height",
    )
  }
}

export interface CreateUiStatesOptions {
  /** A template (every element it was split into) or one element. */
  uiAssetId: string
  /** Limit a template to these of its elements. */
  elementIds?: string[]
  states: UiStateSpec[]
  targetPalette?: TargetPaletteArg
  intervalMs?: number
  timeoutMs?: number
  onProgress?: (status: string) => void
  /** Called with PixelLab's price once the job is accepted. */
  onQuote?: (generations: number, count: number) => void
  sleep?: (ms: number) => Promise<void>
}

export interface CreateUiStatesResult {
  jobId: string
  elementIds: string[]
  quotedGenerations: number
  count: number
  usage: unknown
  asset: PixelLabUiAsset
}

/** The elements a states call covers: the template's (optionally narrowed), or the element itself. */
export function uiStateElements(asset: PixelLabUiAsset, only?: string[]): string[] {
  if (asset.kind === "state") throw new Error(`${asset.id} is a state; states are made for an element or a split template`)
  if (asset.kind === "element") return [asset.id]
  if (!asset.elements.length) {
    throw new Error(`template ${asset.id} has not been split; run pixelkiln ui split --id ${asset.id} first (free)`)
  }
  const ids = asset.elements.map((element) => element.id)
  if (!only?.length) return ids
  const unknown = only.filter((id) => !ids.includes(id))
  if (unknown.length) throw new Error(`not elements of template ${asset.id}: ${unknown.join(", ")}`)
  return only
}

/** Make states for a template's elements (or one element), wait for the job, and return the asset as it now stands. */
export async function createUiStates(
  client: Pick<PixelLabClient, "getUiAssetDetail" | "createUiStates" | "getBackgroundJob">,
  opts: CreateUiStatesOptions,
): Promise<CreateUiStatesResult> {
  if (!opts.states.length) throw new Error("ui states needs at least one state")
  if (opts.states.length > UI_STATES_MAX_STATES) throw new Error(`PixelLab takes at most ${UI_STATES_MAX_STATES} states per call`)
  const before = await client.getUiAssetDetail(opts.uiAssetId)
  const elementIds = uiStateElements(before, opts.elementIds)
  if (elementIds.length > UI_STATES_MAX_ELEMENTS) throw new Error(`PixelLab takes at most ${UI_STATES_MAX_ELEMENTS} elements per call`)
  const submitted = await client.createUiStates({ elementIds, states: opts.states, targetPalette: opts.targetPalette })
  opts.onQuote?.(submitted.generations, submitted.count)

  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)))
  const interval = opts.intervalMs ?? 8000
  const timeout = opts.timeoutMs ?? 8 * 60_000
  const started = Date.now()
  for (;;) {
    const job = await client.getBackgroundJob(submitted.background_job_id)
    opts.onProgress?.(job.status)
    if (job.status === "failed") throw new Error(`PixelLab UI states job ${submitted.background_job_id} failed upstream`)
    if (job.status === "completed") {
      return {
        jobId: submitted.background_job_id,
        elementIds,
        quotedGenerations: submitted.generations,
        count: submitted.count,
        usage: job.usage ?? null,
        asset: await client.getUiAssetDetail(opts.uiAssetId),
      }
    }
    if (Date.now() - started > timeout) {
      throw new Error(
        `PixelLab UI states job ${submitted.background_job_id} is still ${job.status} after ${Math.round(timeout / 1000)} s; ` +
          "it keeps running upstream, and pixelkiln ui show will list the states once they are saved",
      )
    }
    await sleep(interval)
  }
}

function slug(text: string | null | undefined, fallback: string): string {
  const cleaned = (text ?? "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "")
  return cleaned || fallback
}

export interface PulledUiFile {
  id: string
  kind: "template" | "element" | "state"
  name: string
  file: string
  sha256: string
  size: { width: number; height: number }
  nineSlice?: UiInsets
  /** An element: where it sits in the template, in template pixels. */
  box?: UiBox
  /** A state: the element it belongs to. */
  elementId?: string
}

export interface PullUiResult {
  dir: string
  record: string
  files: PulledUiFile[]
}

/**
 * Download a UI asset's images into a directory with one `ui.json` record:
 * the whole image, each element as `elements/<name>.png`, and each state as
 * `elements/<name>.<state>.png`, with boxes and 9-slice insets in the record.
 * Fetched from each image's own no-auth URL, not PixelLab's ZIP.
 */
export async function pullUiAsset(
  client: Pick<PixelLabClient, "getUiAssetDetail" | "download">,
  uiAssetId: string,
  opts: { out: string; force?: boolean },
): Promise<PullUiResult> {
  const asset = await client.getUiAssetDetail(uiAssetId)
  if (asset.status && asset.status !== "completed") throw new Error(`UI asset ${uiAssetId} is ${asset.status}; pull it once it is completed`)
  if (!asset.image_url) throw new Error(`UI asset ${uiAssetId} has no image yet`)
  const dir = path.resolve(opts.out)
  const record = path.join(dir, "ui.json")

  type Part = { id: string; name?: string | null; size: { width: number; height: number }; image_url: string; nine_slice?: UiInsets | null }
  const plan: Array<Omit<PulledUiFile, "sha256"> & { url: string }> = []
  const insets = (part: { nine_slice?: UiInsets | null }) =>
    part.nine_slice ? { nineSlice: { left: part.nine_slice.left, right: part.nine_slice.right, top: part.nine_slice.top, bottom: part.nine_slice.bottom } } : {}
  const taken = new Set<string>()
  const unique = (base: string) => {
    let name = base
    for (let n = 2; taken.has(name); n++) name = `${base}-${n}`
    taken.add(name)
    return name
  }
  const kind = (asset.kind ?? "template") as PulledUiFile["kind"]
  const rootName = slug(asset.name, kind)
  plan.push({ id: asset.id, kind, name: rootName, file: `${rootName}.png`, size: asset.size, url: asset.image_url, ...insets(asset) })
  const addStates = (owner: { id: string }, ownerName: string, states: Part[]) => {
    const stateNames = new Set<string>()
    for (const [i, state] of states.entries()) {
      let stateName = slug(state.name, `state-${i + 1}`)
      for (let n = 2; stateNames.has(stateName); n++) stateName = `${slug(state.name, `state-${i + 1}`)}-${n}`
      stateNames.add(stateName)
      plan.push({
        id: state.id, kind: "state", name: `${ownerName}.${stateName}`, file: `elements/${ownerName}.${stateName}.png`,
        size: state.size, url: state.image_url, elementId: owner.id, ...insets(state),
      })
    }
  }
  for (const [i, element] of asset.elements.entries()) {
    const name = unique(slug(element.name || element.template_box?.label, `element-${i + 1}`))
    const box = element.template_box
    plan.push({
      id: element.id, kind: "element", name, file: `elements/${name}.png`, size: element.size, url: element.image_url,
      ...(box ? { box: { ...(box.label ? { label: box.label } : {}), x: box.x, y: box.y, width: box.width, height: box.height } } : {}),
      ...insets(element),
    })
    addStates(element, name, element.states)
  }
  // An element pulled on its own carries its states at the top level.
  if (kind === "element") addStates(asset, rootName, asset.states)

  if (!opts.force) {
    for (const file of [record, ...plan.map((item) => path.join(dir, item.file))]) {
      if (existsSync(file)) throw new Error(`${file} already exists; pass --force to replace it`)
    }
  }
  const files: PulledUiFile[] = []
  for (const { url, ...item } of plan) {
    const bytes = await client.download(url)
    validateMedia(bytes, MediaType.PNG)
    const target = path.join(dir, item.file)
    await mkdir(path.dirname(target), { recursive: true })
    await writeFile(target, bytes)
    files.push({ ...item, sha256: sha256(bytes) })
  }
  await writeFile(
    record,
    JSON.stringify(
      {
        schema: "pixelkiln-ui",
        version: 1,
        provider: "pixellab",
        pulledAt: new Date().toISOString(),
        uiAssetId: asset.id,
        kind,
        prompt: asset.prompt,
        files,
      },
      null,
      2,
    ) + "\n",
  )
  return { dir, record, files }
}
