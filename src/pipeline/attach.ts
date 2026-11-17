import { existsSync } from "node:fs"
import { mkdir, readFile, rename, writeFile } from "node:fs/promises"
import path from "node:path"
import { attachFrame, handPlacement, heldAngle, isDirection, isHeldItem, parseAnchorsFile, type AnchorsFile } from "../attach.ts"
import { sha256 } from "../hash.ts"
import { saveLock, upsert } from "../lock.ts"
import { MediaType } from "../media.ts"
import { decodePng, encodeRgbaPng } from "../png.ts"
import { ESTIMATE_SKELETON_SIZES, SkeletonFrameSchema, type SkeletonKeypoint } from "../skeleton.ts"
import { currentEntryOutputPath, expectedOutputPath, portableOutputPath } from "../outputs.ts"
import { layerOffsetFor, lockKey, type CharacterDirection, type Lock, type LockEntry, type LockOutput, type ResolvedSpec } from "../types.ts"
import { mirrorSourceHash } from "./mirror.ts"

/**
 * A held item is a paperdoll layer made without a provider: a sprite already
 * on disk, pinned to a hand in every frame of the layer's sources. Like a
 * mirror it is made during `gen` after its sources land, costs nothing, and
 * is made again whenever a source, the item, or the anchors file changes.
 */

export { isHeldItem }

/** One frame a held item is placed on. */
export interface HeldFrame {
  assetId: string
  /** The frame's name within its asset: a direction, `frame-03`, or its ordinal. */
  role: string
  direction: CharacterDirection
  file: string
}

/** Every frame of every source, in `of` order, with the direction it faces. */
export function heldFrames(spec: ResolvedSpec, lock: Lock): HeldFrame[] {
  const frames: HeldFrame[] = []
  for (const source of spec.character!.layer!.sources) {
    const key = lockKey(source.spec.styleId, source.spec.assetId)
    const entry = lock.entries[key]
    if (!entry || entry.status !== "downloaded" || !entry.outputs.length) {
      throw new Error(`held item source ${key} has no downloaded frames`)
    }
    for (const [index, output] of entry.outputs.entries()) {
      const direction = isDirection(output.role) ? output.role : source.spec.character?.animation?.direction
      if (!direction) throw new Error(`cannot tell which way ${key} frame ${output.role ?? index} faces`)
      frames.push({
        assetId: source.assetId,
        role: output.role ?? String(index).padStart(2, "0"),
        direction,
        file: currentEntryOutputPath(entry, source.spec, index),
      })
    }
  }
  return frames
}

export async function readAnchorsFile(file: string): Promise<AnchorsFile> {
  let json: unknown
  try {
    json = JSON.parse(await readFile(file, "utf8"))
  } catch (error) {
    throw new Error(`${file} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`)
  }
  return parseAnchorsFile(json, file)
}

export interface HeldItemOptions {
  onProgress?: (msg: string) => void
}

/** One frame's item, placed: the layer bytes, where the hand is, and whether the body covers it. */
export interface PlacedFrame {
  png: Buffer
  hand: { x: number; y: number }
  behind: boolean
  /** Item pixels that fell outside the padded canvas. */
  clipped: number
}

/**
 * Places a held item on each frame, from the item files and anchors file the
 * spec names. Fails, naming the frame, when a frame has no anchor or has
 * changed since its anchor was estimated.
 */
export async function placeHeldFrames(spec: ResolvedSpec, frames: HeldFrame[]): Promise<PlacedFrame[]> {
  const layer = spec.character!.layer!
  const attach = layer.attach!
  const relative = (file: string) => path.relative(spec.root, file) || file
  if (!existsSync(attach.anchors.path)) {
    throw new Error(`anchors file ${relative(attach.anchors.path)} does not exist; write it with: pixelkiln anchors ${spec.assetId}`)
  }
  const anchors = await readAnchorsFile(attach.anchors.path)
  const items = new Map<CharacterDirection, Buffer>()
  for (const file of attach.item) {
    if (!existsSync(file.path)) throw new Error(`item image ${relative(file.path)} does not exist (${file.direction})`)
    items.set(file.direction, await readFile(file.path))
  }
  const placed: PlacedFrame[] = []
  for (const frame of frames) {
    const anchor = anchors.frames[frame.assetId]?.[frame.role]
    const name = `${frame.assetId} ${frame.role}`
    if (!anchor) {
      throw new Error(`${relative(attach.anchors.path)} has no entry for ${name}; add the new frames with: pixelkiln anchors ${spec.assetId}`)
    }
    const bytes = await readFile(frame.file)
    if (sha256(bytes) !== anchor.sha256) {
      throw new Error(`${name} changed since its anchor was estimated, so its hand may have moved; refresh it with: pixelkiln anchors ${spec.assetId}`)
    }
    const item = items.get(frame.direction)
    if (!item) throw new Error(`no item image for ${frame.direction}, which ${name} faces`)
    const placement = handPlacement(anchor, attach.joint)
    if (attach.depth !== "auto") placement.behind = attach.depth === "behind"
    const hand = { x: placement.x, y: placement.y }
    // The nudge moves the item, not where the hand is: a grip pass still opens its disc on the hand.
    const nudge = layerOffsetFor(layer.offset, frame.assetId)
    placement.x += nudge.x
    placement.y += nudge.y
    const grip = attach.grip === "center" || Array.isArray(attach.grip) ? attach.grip : attach.grip?.[frame.direction]
    const result = attachFrame(bytes, item, {
      placement,
      angle: heldAngle(frame.direction, attach.joint, attach.tilt, attach.lean),
      ...(grip ? { grip: grip === "center" ? grip : { x: grip[0], y: grip[1] } } : {}),
      scale: attach.scale,
      padding: layer.padding,
    })
    placed.push({ png: result.png, hand, behind: placement.behind, clipped: result.clipped })
  }
  return placed
}

/** Write a held item's layer frames and record the asset as downloaded. */
export async function heldItemAsset(
  spec: ResolvedSpec,
  lock: Lock,
  lockPath: string,
  opts: HeldItemOptions = {},
): Promise<LockEntry> {
  const log = opts.onProgress ?? (() => {})
  const layer = spec.character!.layer!
  const attach = layer.attach!
  const key = lockKey(spec.styleId, spec.assetId)
  const frames = heldFrames(spec, lock)
  const placed = await placeHeldFrames(spec, frames)
  const outputs: LockOutput[] = []
  let clipped = 0
  for (const [index, frame] of frames.entries()) {
    const bytes = placed[index]!.png
    clipped += placed[index]!.clipped
    const role = `${frame.assetId}.${frame.role}`
    const target = expectedOutputPath(spec, role, index, frames.length, MediaType.PNG)
    await mkdir(path.dirname(target), { recursive: true })
    const tmp = `${target}.pixelkiln.tmp`
    await writeFile(tmp, bytes)
    await rename(tmp, target)
    outputs.push({ path: portableOutputPath(target, spec.root), sha256: sha256(bytes), role, mediaType: MediaType.PNG })
  }

  const now = new Date().toISOString()
  const entry = upsert(lock, key, {
    styleId: spec.styleId,
    assetId: spec.assetId,
    specHash: spec.specHash,
    generator: spec.generator,
    tileFeature: null,
    prompt: "",
    width: spec.width + layer.padding * 2,
    height: spec.height + layer.padding * 2,
    revision: null,
    layer: {
      sources: layer.sources.map((source) => ({
        assetId: source.assetId,
        sha256: mirrorSourceHash(lock.entries[lockKey(source.spec.styleId, source.spec.assetId)]!),
      })),
    },
    supersededOutputs: [],
    jobId: null,
    submissionComplete: undefined,
    reviewObjectId: null,
    objectId: null,
    candidateIndex: null,
    status: "downloaded",
    error: null,
    outputs,
    providerMetadata: {
      [spec.provider]: { character: { kind: "layer", held: { joint: attach.joint, frames: frames.length, clippedPixels: clipped } } },
    },
    sourceUrl: null,
    sourceUrls: [],
    submittedAt: now,
    downloadedAt: now,
    history: [],
    cost: 0,
    costUnit: spec.costUnit,
    provider: spec.provider,
    postprocess: undefined,
  })
  await saveLock(lockPath, lock)
  log(`  attach  ${key} (${frames.length} frame${frames.length === 1 ? "" : "s"}, ${attach.joint}, no generation cost)`)
  if (clipped) log(`          ${clipped} item pixel${clipped === 1 ? "" : "s"} fell outside the canvas; raise layer.padding above ${layer.padding} to keep them`)
  return entry
}

/** PixelLab's own price for one `/estimate-skeleton` call, in generations. */
export const ANCHOR_COST = 0.1

export interface WriteAnchorsOptions {
  /** Estimate every frame again, including ones whose anchor is current. */
  force?: boolean
  /** Count what would be estimated; call nothing and write nothing. */
  dryRun?: boolean
  onProgress?: (msg: string) => void
}

export interface WriteAnchorsResult {
  file: string
  /** Frames estimated in this run (or that would be, on a dry run). */
  estimated: number
  /** Frames whose anchor already matched their bytes. */
  current: number
}

/**
 * Brings a held item's anchors file up to date with its sources' frames: one
 * skeleton estimate per frame that has no entry or has changed since its
 * entry was made. Entries for frames this layer does not use, and hand-made
 * `place` corrections on frames that have not changed, are kept. The file is
 * written even when an estimate fails part-way, so nothing paid for is lost.
 */
export async function writeAnchors(
  spec: ResolvedSpec,
  lock: Lock,
  client: { estimateSkeleton(args: { image: { base64: string; format: "png" } }): Promise<{ keypoints: SkeletonKeypoint[] }> },
  opts: WriteAnchorsOptions = {},
): Promise<WriteAnchorsResult> {
  const log = opts.onProgress ?? (() => {})
  const attach = spec.character?.layer?.attach
  if (!attach) throw new Error(`${spec.styleId}/${spec.assetId} is not a held item (a layer with attach)`)
  const file = attach.anchors.path
  const anchors: AnchorsFile = existsSync(file) ? await readAnchorsFile(file) : { version: 1, frames: {} }
  const frames = heldFrames(spec, lock)
  let estimated = 0
  let current = 0
  try {
    for (const frame of frames) {
      const bytes = await readFile(frame.file)
      const hash = sha256(bytes)
      const existing = anchors.frames[frame.assetId]?.[frame.role]
      if (existing && existing.sha256 === hash && !opts.force) {
        current++
        continue
      }
      const image = decodePng(bytes)
      const { width, height } = image
      // The endpoint takes a few square sizes. Any other frame goes up on the
      // next one, in its top-left corner, and the joints are scaled back.
      const side = ESTIMATE_SKELETON_SIZES.find((size) => size >= Math.max(width, height))
      if (!side) {
        throw new Error(`${frame.assetId} ${frame.role} is ${width}x${height}; a skeleton can be estimated up to ${ESTIMATE_SKELETON_SIZES.at(-1)} pixels a side`)
      }
      estimated++
      if (opts.dryRun) continue
      let sent: Buffer = bytes
      if (side !== width || side !== height) {
        const padded = Buffer.alloc(side * side * 4)
        for (let y = 0; y < height; y++) image.pixels.copy(padded, y * side * 4, y * width * 4, (y + 1) * width * 4)
        sent = encodeRgbaPng(side, side, padded)
      }
      const { keypoints } = await client.estimateSkeleton({ image: { base64: sent.toString("base64"), format: "png" } })
      const parsed = SkeletonFrameSchema.safeParse(keypoints.map((joint) => ({
        ...joint,
        x: Math.min(1, (joint.x * side) / width),
        y: Math.min(1, (joint.y * side) / height),
      })))
      if (!parsed.success) throw new Error(`${frame.assetId} ${frame.role}: the estimate is not an 18-joint skeleton`)
      // A correction made for the old pose does not carry to a new one.
      const kept = existing && existing.sha256 === hash ? existing.place : undefined
      if (existing?.place && !kept) log(`  ${frame.assetId} ${frame.role} changed; its hand-placed position was dropped`)
      ;(anchors.frames[frame.assetId] ??= {})[frame.role] = { sha256: hash, width, height, keypoints: parsed.data, ...(kept ? { place: kept } : {}) }
      log(`  ${frame.assetId} ${frame.role}`)
    }
  } finally {
    if (!opts.dryRun && estimated) {
      await mkdir(path.dirname(file), { recursive: true })
      const tmp = `${file}.pixelkiln.tmp`
      await writeFile(tmp, `${JSON.stringify(anchors, null, 2)}\n`)
      await rename(tmp, file)
    }
  }
  return { file, estimated, current }
}
