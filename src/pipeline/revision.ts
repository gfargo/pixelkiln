import { existsSync } from "node:fs"
import path from "node:path"
import { sha256File } from "../hash.ts"
import { currentEntryOutputPath } from "../outputs.ts"
import { lockKey, type Lock, type ResolvedSpec } from "../types.ts"
import { inspectQualityProfile } from "./quality-profile.ts"

export interface RevisionReadiness {
  ready: boolean
  reason: string
}

/**
 * Prove that a revision points at the current bytes of a current parent, or
 * that a character state or animation has its parent character downloaded
 * and current.
 *
 * This runs during planning and again immediately before submission. The
 * second check closes the gap where a source or mask changes after a plan was
 * printed but before a paid provider request begins.
 */
export async function inspectRevisionReadiness(
  spec: ResolvedSpec,
  lock: Lock,
): Promise<RevisionReadiness | null> {
  if (spec.mirror) return inspectMirror(spec, lock, new Set())
  // An outfit's dependency is its source loop's whole frame set, checked
  // the way a mirror's is; `character.parentSpec` is also set (so the
  // family shares parentAssetId plumbing), but there is no single
  // south-facing file for inspectCharacterParent to look for.
  if (spec.character?.kind === "outfit") return inspectOutfit(spec, lock, new Set())
  if (spec.character?.parentSpec) return inspectCharacterParent(spec, lock, new Set())
  if (spec.character?.styleAnchor) return inspectStyleAnchor(spec, lock, new Set())
  if (!spec.revision) return null
  return inspectRevision(spec, lock, new Set())
}

/**
 * A pro base drawn in another character's style needs that character
 * downloaded, current, untouched, and known to PixelLab; its south file is
 * what this base's identity hashed at resolve time.
 */
async function inspectStyleAnchor(spec: ResolvedSpec, lock: Lock, seen: Set<string>): Promise<RevisionReadiness> {
  const anchor = spec.character!.styleAnchor!
  const label = `style anchor ${spec.styleId}/${anchor.assetId}`
  const dependency = await inspectParent(anchor.spec, lock, seen)
  if (!dependency.ready) return { ready: false, reason: `${label} is not ready: ${dependency.reason}` }
  if (!anchor.sha256 || !existsSync(anchor.file)) return { ready: false, reason: `${label} has no generated south-facing file yet` }
  if ((await sha256File(anchor.file)) !== anchor.sha256) {
    return { ready: false, reason: `${label} changed after the manifest was resolved` }
  }
  if (!lock.entries[lockKey(anchor.spec.styleId, anchor.spec.assetId)]?.objectId) {
    return { ready: false, reason: `${label} has no PixelLab character id recorded` }
  }
  return { ready: true, reason: `${label} is current` }
}

/**
 * A mirror is flipped from its source's downloaded files, so the source has
 * to be downloaded, current, and untouched. Its own parents (a loop's
 * character, a revision's source) are checked through it.
 */
async function inspectMirror(spec: ResolvedSpec, lock: Lock, seen: Set<string>): Promise<RevisionReadiness> {
  const source = spec.mirror!.sourceSpec
  const label = `mirror source ${spec.styleId}/${spec.mirror!.sourceAssetId}`
  const dependency = await inspectParent(source, lock, seen)
  return dependency.ready
    ? { ready: true, reason: `${label} is current` }
    : { ready: false, reason: `${label} is not ready: ${dependency.reason}` }
}

/**
 * An outfit re-clothes its source loop's whole downloaded frame set (like a
 * mirror's dependency, not a single south-facing file) and needs its own
 * reference image current too.
 */
async function inspectOutfit(spec: ResolvedSpec, lock: Lock, seen: Set<string>): Promise<RevisionReadiness> {
  const character = spec.character!
  const outfit = character.outfit!
  const label = `outfit source ${spec.styleId}/${character.parentAssetId}`
  const dependency = await inspectParent(character.parentSpec!, lock, seen)
  if (!dependency.ready) return { ready: false, reason: `${label} is not ready: ${dependency.reason}` }
  if (!existsSync(outfit.reference.path)) {
    return { ready: false, reason: `outfit reference is missing: ${outfit.reference.path}` }
  }
  if ((await sha256File(outfit.reference.path)) !== outfit.reference.sha256) {
    return { ready: false, reason: "outfit reference changed after the manifest was resolved" }
  }
  return { ready: true, reason: `${label} is current` }
}

/**
 * A state or animation is drawn by PixelLab from the character it holds, so
 * the parent must be downloaded, current, and untouched; its south-facing
 * file is what the child's identity hashed at resolve time.
 */
async function inspectCharacterParent(
  spec: ResolvedSpec,
  lock: Lock,
  seen: Set<string>,
): Promise<RevisionReadiness> {
  const character = spec.character!
  const parentSpec = character.parentSpec!
  const label = `${character.kind} parent ${spec.styleId}/${character.parentAssetId}`
  const dependency = await inspectParent(parentSpec, lock, seen)
  if (!dependency.ready) return { ready: false, reason: `${label} is not ready: ${dependency.reason}` }
  if (!character.parentSha256 || !character.parentFile || !existsSync(character.parentFile)) {
    return { ready: false, reason: `${label} has no generated south-facing file yet` }
  }
  if ((await sha256File(character.parentFile)) !== character.parentSha256) {
    return { ready: false, reason: `${label} changed after the manifest was resolved` }
  }
  const parentEntry = lock.entries[lockKey(parentSpec.styleId, parentSpec.assetId)]
  if (!parentEntry?.objectId) {
    return { ready: false, reason: `${label} has no PixelLab character id recorded` }
  }
  return { ready: true, reason: `${label} is current` }
}

async function inspectRevision(
  spec: ResolvedSpec,
  lock: Lock,
  seen: Set<string>,
): Promise<RevisionReadiness> {
  const revision = spec.revision
  if (!revision) return { ready: true, reason: "asset has no revision inputs" }
  const dependency = await inspectParent(revision.sourceSpec, lock, seen)
  if (!dependency.ready) {
    return {
      ready: false,
      reason: `revision source ${spec.styleId}/${revision.sourceAssetId} is not ready: ${dependency.reason}`,
    }
  }

  if (!revision.sourceSha256 || !existsSync(revision.sourceFile)) {
    return { ready: false, reason: `revision source is missing: ${revision.sourceFile}` }
  }
  if ((await sha256File(revision.sourceFile)) !== revision.sourceSha256) {
    return { ready: false, reason: "revision source changed after the manifest was resolved" }
  }

  if (revision.maskFile) {
    if (!revision.maskSha256 || !existsSync(revision.maskFile)) {
      return { ready: false, reason: `revision mask is missing: ${revision.maskFile}` }
    }
    if ((await sha256File(revision.maskFile)) !== revision.maskSha256) {
      return { ready: false, reason: "revision mask changed after the manifest was resolved" }
    }
  }

  return { ready: true, reason: "revision inputs are current" }
}

export async function requireRevisionReady(spec: ResolvedSpec, lock: Lock): Promise<void> {
  const inspection = await inspectRevisionReadiness(spec, lock)
  if (inspection && !inspection.ready) throw new Error(inspection.reason)
}

async function inspectParent(
  spec: ResolvedSpec,
  lock: Lock,
  seen: Set<string>,
): Promise<RevisionReadiness> {
  const key = lockKey(spec.styleId, spec.assetId)
  if (seen.has(key)) return { ready: false, reason: `revision dependency cycle at ${key}` }
  const nextSeen = new Set(seen)
  nextSeen.add(key)

  if (spec.mirror) {
    const inputs = await inspectMirror(spec, lock, nextSeen)
    if (!inputs.ready) return inputs
  }
  if (spec.revision) {
    const inputs = await inspectRevision(spec, lock, nextSeen)
    if (!inputs.ready) return inputs
  }
  if (spec.character?.kind === "outfit") {
    const inputs = await inspectOutfit(spec, lock, nextSeen)
    if (!inputs.ready) return inputs
  } else if (spec.character?.parentSpec) {
    const inputs = await inspectCharacterParent(spec, lock, nextSeen)
    if (!inputs.ready) return inputs
  }
  if (spec.character?.styleAnchor) {
    const inputs = await inspectStyleAnchor(spec, lock, nextSeen)
    if (!inputs.ready) return inputs
  }

  if (spec.quality) {
    const quality = await inspectQualityProfile(spec, lock)
    return quality?.state === "approved"
      ? { ready: true, reason: "approved quality output is current" }
      : {
          ready: false,
          reason: `quality output is ${quality?.state ?? "missing"}` +
            (quality?.reason ? ` (${quality.reason})` : ""),
        }
  }

  if (spec.source) {
    const source = path.resolve(spec.root, spec.source)
    return existsSync(source)
      ? { ready: true, reason: "declared source is present" }
      : { ready: false, reason: `declared source is missing: ${spec.source}` }
  }

  const entry = lock.entries[key]
  if (!entry) return { ready: false, reason: "parent is not in the lockfile" }
  if (entry.specHash !== spec.specHash) {
    return { ready: false, reason: "parent generation spec is stale" }
  }
  if (entry.status !== "downloaded") {
    return { ready: false, reason: `parent is ${entry.status}, not downloaded` }
  }
  if (!entry.outputs.length) return { ready: false, reason: "parent has no recorded output" }
  for (let index = 0; index < entry.outputs.length; index++) {
    const output = entry.outputs[index]!
    const file = currentEntryOutputPath(entry, spec, index)
    if (!existsSync(file)) return { ready: false, reason: `parent output is missing: ${file}` }
    if ((await sha256File(file)) !== output.sha256) {
      return { ready: false, reason: `parent output was modified: ${file}` }
    }
  }
  return { ready: true, reason: "parent output is current" }
}
