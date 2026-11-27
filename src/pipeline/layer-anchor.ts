import { existsSync, readFileSync } from "node:fs"
import { sha256 } from "../hash.ts"
import { currentEntryOutputPath } from "../outputs.ts"
import { shiftPixels } from "../paperdoll.ts"
import { lockKey, type Lock, type ResolvedSpec } from "../types.ts"
import { mirrorSourceHash } from "./mirror.ts"

/**
 * One guide cell for a layer with an `anchor`: a frame the anchor layer
 * already dressed, put on this layer's sheet with its clothes painted on and
 * its mask closed, so the provider copies the outfit instead of inventing it.
 */
export interface AnchorGuide {
  /** The source asset the guide's base frame belongs to, and its role there. */
  assetId: string
  role: string
  /** The base frame on disk. */
  basePath: string
  /** The anchor layer's frame over it, with any `offset` the anchor applied taken back off. */
  layer: Buffer
}

export type AnchorGuides = { ok: true; guides: AnchorGuide[] } | { ok: false; reason: string }

/** The anchor layer's frames a guide is made from: the ones named, or the one over its first still's south rotation. */
function guideRoles(anchor: NonNullable<NonNullable<NonNullable<ResolvedSpec["character"]>["layer"]>["anchor"]>, outputs: Array<string | undefined>): string[] {
  if (anchor.frames) return anchor.frames
  const layer = anchor.spec.character!.layer!
  const still = layer.sources.find((source) => source.spec.character?.kind !== "animation")
  const south = still && outputs.find((role) => role === `${still.assetId}.south`)
  return [south ?? outputs.find(Boolean) ?? ""]
}

/** The guide frames a layer's anchor gives it, read from the lockfile and disk, or why they are not ready. */
export function anchorGuides(spec: ResolvedSpec, lock: Lock): AnchorGuides {
  const anchor = spec.character?.layer?.anchor
  if (!anchor) return { ok: true, guides: [] }
  const label = `layer anchor ${anchor.spec.styleId}/${anchor.assetId}`
  const entry = lock.entries[lockKey(anchor.spec.styleId, anchor.assetId)]
  if (!entry) return { ok: false, reason: `${label} is not made yet` }
  if (entry.specHash !== anchor.spec.specHash) return { ok: false, reason: `${label} is stale; generate it first` }
  if (entry.status !== "downloaded" || !entry.outputs.length) return { ok: false, reason: `${label} is ${entry.status}, not downloaded` }
  const roles = guideRoles(anchor, entry.outputs.map((output) => output.role))
  const sources = anchor.spec.character!.layer!.sources
  const guides: AnchorGuide[] = []
  for (const role of roles) {
    const index = entry.outputs.findIndex((output) => output.role === role)
    if (index < 0) {
      return { ok: false, reason: `${label} has no frame "${role}"; its frames are ${entry.outputs.map((output) => output.role).join(", ")}` }
    }
    const file = currentEntryOutputPath(entry, anchor.spec, index)
    if (!existsSync(file)) return { ok: false, reason: `${label}'s frame is missing on disk: ${file}` }
    const bytes = readFileSync(file)
    if (sha256(bytes) !== entry.outputs[index]!.sha256) return { ok: false, reason: `${label}'s frame was changed after download: ${file}` }
    // The frame's base: the longest source id its role starts with, then that source's own role.
    const owner = sources.filter((source) => role.startsWith(`${source.assetId}.`)).sort((a, b) => b.assetId.length - a.assetId.length)[0]
    if (!owner) return { ok: false, reason: `${label}'s frame "${role}" names none of its sources` }
    const baseRole = role.slice(owner.assetId.length + 1)
    const baseEntry = lock.entries[lockKey(owner.spec.styleId, owner.spec.assetId)]
    const baseIndex = baseEntry?.outputs.findIndex((output) => output.role === baseRole) ?? -1
    if (!baseEntry || baseIndex < 0) return { ok: false, reason: `${label}'s frame "${role}" goes over ${owner.assetId} ${baseRole}, which is not downloaded` }
    const basePath = currentEntryOutputPath(baseEntry, owner.spec, baseIndex)
    if (!existsSync(basePath)) return { ok: false, reason: `the base frame under ${label}'s "${role}" is missing: ${basePath}` }
    const pair = entry.postprocess?.offset?.per?.[owner.assetId] ?? entry.postprocess?.offset
    guides.push({ assetId: owner.assetId, role: baseRole, basePath, layer: pair ? shiftPixels(bytes, -pair.x, -pair.y).png : bytes })
  }
  return { ok: true, guides }
}

/** What a layer records of its anchor when it is made, and what the plan compares. */
export function anchorRecord(spec: ResolvedSpec, lock: Lock): { assetId: string; sha256: string } | undefined {
  const anchor = spec.character?.layer?.anchor
  if (!anchor) return undefined
  return { assetId: anchor.assetId, sha256: mirrorSourceHash(lock.entries[lockKey(anchor.spec.styleId, anchor.assetId)] ?? { outputs: [] }) }
}
