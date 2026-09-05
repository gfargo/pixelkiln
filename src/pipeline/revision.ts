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
 * Prove that a revision points at the current bytes of a current parent.
 *
 * This runs during planning and again immediately before submission. The
 * second check closes the gap where a source or mask changes after a plan was
 * printed but before a paid provider request begins.
 */
export async function inspectRevisionReadiness(
  spec: ResolvedSpec,
  lock: Lock,
): Promise<RevisionReadiness | null> {
  if (!spec.revision) return null
  return inspectRevision(spec, lock, new Set())
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

  if (spec.revision) {
    const inputs = await inspectRevision(spec, lock, nextSeen)
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
