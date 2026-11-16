import { existsSync } from "node:fs"
import { mkdir, readFile, rename, writeFile } from "node:fs/promises"
import path from "node:path"
import { sha256 } from "../hash.ts"
import { saveLock, upsert } from "../lock.ts"
import { MediaType } from "../media.ts"
import { currentEntryOutputPath } from "../outputs.ts"
import { buildLayerSheet, cutLayerFrames, redrawSheet, shiftPixels } from "../paperdoll.ts"
import { decodePng } from "../png.ts"
import { LAYER_SHEET_MAX_SIDE, layerWorkDir } from "../providers/pixellab.ts"
import { lockKey, proTierCost, type Lock, type ResolvedSpec } from "../types.ts"
import { cacheMedia } from "./fetch.ts"
import { applyPostprocess } from "./postprocess.ts"

/**
 * Draws single frames of a paperdoll layer again. A layer is one inpaint over
 * every frame, and now and then one frame of it comes back wrong: the robe
 * turned the wrong way, the pack on the chest. Generating the whole layer
 * again pays for every frame to fix one, and may break a different one.
 *
 * `redraw` puts the bad frame on a small sheet with the other frames of the
 * same source asset. Those are shown already dressed, with their masks
 * closed, so the provider has the outfit in front of it and only the bad
 * frame to paint. The new frame replaces the old one in the layer's recorded
 * outputs, post-processed as the rest were, so everything downstream (a
 * recolour, `pack`, a later change of `offset`) treats it as the layer's own.
 */

/** What `redraw` asks of a provider: one masked inpaint, and its result. */
export interface SheetPainter {
  paintSheet(args: { description: string; keyed: Buffer; mask: Buffer; seed?: number }): Promise<string>
  paintedSheet(jobId: string): Promise<
    { status: "processing" } | { status: "failed"; error: string } | { status: "ready"; png: Buffer; billed: { amount: number; unit: string } | null }
  >
}

export interface RedrawOptions {
  /** The layer frames to draw again, by output role or an unambiguous end of one. */
  frames: string[]
  lockPath: string
  seed?: number
  dryRun?: boolean
  /** Where raw and finished bytes are kept; beside the lockfile by default. */
  cacheDir?: string
  pollMs?: number
  timeoutMs?: number
  onProgress?: (line: string) => void
}

export interface RedrawResult {
  /** The output roles drawn again. */
  roles: string[]
  /** Frames shown dressed, for the provider to copy. */
  guides: number
  sheet: { width: number; height: number }
  /** The estimate for the call: the Pro tier of the sheet's canvas. */
  cost: number
  billed: { amount: number; unit: string } | null
  /** The files replaced; empty on a dry run. */
  written: string[]
  /** Where the sheet, mask and result of this call were kept. */
  workDir: string
}

/** The roles of a layer's outputs, which are what `--frame` names. */
export function redrawRoles(spec: ResolvedSpec, lock: Lock): string[] {
  return (lock.entries[lockKey(spec.styleId, spec.assetId)]?.outputs ?? []).map((output) => output.role ?? "")
}

function pickRoles(label: string, roles: string[], wanted: string[]): string[] {
  if (!wanted.length) throw new Error(`redraw needs at least one --frame; ${label} has: ${roles.join(", ")}`)
  return [...new Set(wanted.map((name) => {
    if (roles.includes(name)) return name
    const ends = roles.filter((role) => role.endsWith(`.${name}`))
    if (ends.length === 1) return ends[0]!
    throw new Error(
      ends.length
        ? `--frame ${name} matches ${ends.length} frames of ${label}: ${ends.join(", ")}`
        : `${label} has no frame "${name}"; it has: ${roles.join(", ")}`,
    )
  }))]
}

/** A layer output's role is `<source asset>.<frame>`; the longest source id it starts with owns it. */
function ownerOf(role: string, assetIds: string[]): string | undefined {
  return assetIds.filter((id) => role.startsWith(`${id}.`)).sort((a, b) => b.length - a.length)[0]
}

export async function redrawLayerFrames(spec: ResolvedSpec, lock: Lock, painter: SheetPainter, opts: RedrawOptions): Promise<RedrawResult> {
  const label = `${spec.styleId}/${spec.assetId}`
  const layer = spec.character?.kind === "layer" ? spec.character.layer : undefined
  if (!layer) throw new Error(`${label} is not a paperdoll layer`)
  if (layer.attach) {
    throw new Error(
      `${label} is a held item, placed rather than drawn; move it with attach or a place override in its anchors file` +
        (layer.attach.grasp ? ", or generate its grip again with gen --force" : ""),
    )
  }
  const key = lockKey(spec.styleId, spec.assetId)
  const entry = lock.entries[key]
  if (!entry || entry.status !== "downloaded" || !entry.outputs.length) throw new Error(`${label} has no downloaded frames to redraw; generate it first`)
  if (entry.specHash !== spec.specHash) throw new Error(`${label} changed in the manifest since it was generated; generate it again instead of redrawing a frame`)

  const sourceIds = layer.sources.map((source) => source.assetId)
  const roles = pickRoles(label, entry.outputs.map((output) => output.role ?? ""), opts.frames)
  const owners = [...new Set(roles.map((role) => ownerOf(role, sourceIds)!))]

  // Every frame of each source asset a bad frame belongs to, read as submit reads them.
  const stills: Buffer[] = []
  const sources: Array<{ assetId: string; role: string; png: Buffer; layerRole: string }> = []
  for (const source of layer.sources) {
    const sourceEntry = lock.entries[lockKey(source.spec.styleId, source.spec.assetId)]
    if (!sourceEntry || sourceEntry.status !== "downloaded") throw new Error(`${label}: its source ${source.assetId} is not downloaded`)
    const still = source.spec.character?.kind !== "animation"
    for (const [index, output] of sourceEntry.outputs.entries()) {
      if (!still && !owners.includes(source.assetId)) continue
      const png = await readFile(currentEntryOutputPath(sourceEntry, source.spec, index))
      if (still) stills.push(png)
      if (!owners.includes(source.assetId)) continue
      const role = output.role ?? String(index).padStart(2, "0")
      sources.push({ assetId: source.assetId, role, png, layerRole: `${source.assetId}.${role}` })
    }
  }
  const redraw = sources.map((source) => roles.includes(source.layerRole))
  const guides = redraw.filter((mark) => !mark).length
  if (!guides) {
    throw new Error(
      `${label}: every frame of ${owners.join(" and ")} would be redrawn, which leaves none to copy the outfit from; ` +
        "name fewer frames, or generate the layer again",
    )
  }

  const built = buildLayerSheet(sources, {
    minSide: 32,
    maxSide: LAYER_SHEET_MAX_SIDE,
    region: layer.region,
    padding: layer.padding,
    key: layer.key,
    skin: layer.skin,
    reference: layer.clean ? stills : [],
  })
  // The layer as it stands over each guide, with the recorded nudge taken back off.
  const offset = entry.postprocess?.offset
  const layers: Array<Buffer | null> = []
  const targets = new Map<number, number>()
  for (const [index, source] of sources.entries()) {
    const at = entry.outputs.findIndex((output) => output.role === source.layerRole)
    if (redraw[index]) {
      targets.set(index, at)
      layers.push(null)
      continue
    }
    const file = at >= 0 ? currentEntryOutputPath(entry, spec, at) : null
    if (!file || !existsSync(file)) {
      layers.push(null)
      continue
    }
    const pair = (offset?.per && offset.per[source.assetId]) || offset
    const png = await readFile(file)
    layers.push(pair ? shiftPixels(png, -pair.x, -pair.y).png : png)
  }
  const prepared = redrawSheet(built, layers, redraw)
  const size = decodePng(prepared.keyed)
  const cost = proTierCost(size.width, size.height)
  const workDir = path.join(layerWorkDir(spec), "redraw")
  const result: RedrawResult = { roles, guides, sheet: { width: size.width, height: size.height }, cost, billed: null, written: [], workDir }
  if (opts.dryRun) return result

  await mkdir(workDir, { recursive: true })
  await writeFile(path.join(workDir, "keyed.png"), prepared.keyed)
  await writeFile(path.join(workDir, "mask.png"), prepared.mask)
  const count = roles.length
  const description =
    `${spec.prompt}. Every figure but ${count === 1 ? "one" : count} already wears it. ` +
    `Dress the unfinished figure${count === 1 ? "" : "s"} in exactly the same thing, the same colours and details, ` +
    `seen from the side ${count === 1 ? "that figure faces" : "each of those figures faces"}.`
  const jobId = await painter.paintSheet({ description, keyed: prepared.keyed, mask: prepared.mask, seed: opts.seed ?? spec.seed })
  opts.onProgress?.(`  submitted ${jobId}: ${count} frame${count === 1 ? "" : "s"} beside ${guides} dressed, on a ${size.width}x${size.height} sheet`)

  const deadline = Date.now() + (opts.timeoutMs ?? 10 * 60_000)
  let painted: Buffer | undefined
  for (;;) {
    const state = await painter.paintedSheet(jobId)
    if (state.status === "failed") throw new Error(`${label}: redraw job ${jobId} failed: ${state.error}`)
    if (state.status === "ready") {
      painted = state.png
      result.billed = state.billed
      break
    }
    if (Date.now() > deadline) throw new Error(`${label}: redraw job ${jobId} did not finish in time; nothing was changed`)
    await new Promise((resolve) => setTimeout(resolve, opts.pollMs ?? 3000))
  }
  await writeFile(path.join(workDir, "result.png"), painted)
  const returned = decodePng(painted)
  if (returned.width !== size.width || returned.height !== size.height) {
    throw new Error(`${label}: redraw job ${jobId} returned a ${returned.width}x${returned.height} image for a ${size.width}x${size.height} sheet`)
  }
  const cut = cutLayerFrames(painted, { keyed: prepared.keyed, mask: prepared.mask, frames: built.frames }, { key: layer.key, region: layer.region })

  const cacheDir = path.resolve(opts.cacheDir ?? path.join(path.dirname(opts.lockPath), ".pixelkiln", "cache"))
  const outputs = [...entry.outputs]
  const renames: Array<[string, string]> = []
  for (const [index, at] of targets) {
    const role = sources[index]!.layerRole
    const raw = cut[index]!
    const empty = !decodePng(raw).pixels.some((value, i) => i % 4 === 3 && value > 0)
    if (empty) throw new Error(`${label}: the redraw of ${role} came back with nothing drawn; nothing was changed. Run it again, or with another --seed`)
    const target = currentEntryOutputPath(entry, spec, at)
    // The outgoing frame stays in the cache under its own hash, so `restore` can still reach it.
    if (existsSync(target)) await cacheMedia(cacheDir, await readFile(target), MediaType.PNG)
    await cacheMedia(cacheDir, raw, MediaType.PNG)
    const processed = applyPostprocess(raw, MediaType.PNG, entry.postprocess, [], role)
    await cacheMedia(cacheDir, processed.bytes, MediaType.PNG)
    const tmp = `${target}.pixelkiln.tmp`
    await writeFile(tmp, processed.bytes)
    renames.push([tmp, target])
    const { raw: _raw, ...kept } = outputs[at]!
    outputs[at] = { ...kept, sha256: sha256(processed.bytes), ...(processed.changed ? { raw: sha256(raw) } : {}) }
  }
  // The record first, then the files, as fetch does: a crash between the two
  // leaves a recorded output missing, which the next fetch restores from the cache.
  upsert(lock, key, {
    outputs,
    cost: entry.cost + cost,
    billed: result.billed
      ? { amount: (entry.billed?.unit === result.billed.unit ? entry.billed.amount : 0) + result.billed.amount, unit: result.billed.unit }
      : entry.billed,
  })
  await saveLock(opts.lockPath, lock)
  for (const [tmp, target] of renames) {
    await rename(tmp, target)
    result.written.push(target)
  }
  return result
}
