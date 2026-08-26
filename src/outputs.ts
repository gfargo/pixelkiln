import path from "node:path"
import { lockKey, type Lock, type LockEntry, type LockOutput, type ResolvedSpec } from "./types.ts"

/** One lockfile output with the identity consumers should expose publicly. */
export interface ResolvedOutput extends LockOutput {
  assetId: string
  /** Stable within a style's atlas or report. Single-output assets keep their old id. */
  id: string
  index: number
  absolutePath: string
}

/** The fallback role used when a provider returns several unnamed outputs. */
export function fallbackOutputRole(index: number): string {
  return `output-${String(index).padStart(2, "0")}`
}

/**
 * Gives every output a stable, collision-resistant consumer id.
 *
 * A conventional one-file asset remains `grass`, preserving existing atlas
 * lookups. A structural set becomes `grass/tile-00`, `grass/tile-01`, … so no
 * downstream command has to silently pretend its first file is the whole set.
 */
export function outputId(
  assetId: string,
  output: Pick<LockOutput, "role">,
  index: number,
  total: number,
): string {
  if (total === 1) return assetId
  return `${assetId}/${output.role ?? fallbackOutputRole(index)}`
}

/** Resolve every output recorded for one manifest asset, preserving lock order. */
export function resolveEntryOutputs(
  entry: LockEntry,
  assetId: string,
  manifestDir: string,
): ResolvedOutput[] {
  return entry.outputs.map((output, index) => ({
    ...output,
    assetId,
    id: outputId(assetId, output, index, entry.outputs.length),
    index,
    absolutePath: path.resolve(manifestDir, output.path),
  }))
}

/** Resolve all outputs for a style in deterministic asset-id order. */
export function resolveStyleOutputs(
  lock: Lock,
  styleId: string,
  manifestDir: string,
): ResolvedOutput[] {
  const prefix = `${styleId}/`
  return Object.entries(lock.entries)
    .filter(([key]) => key.startsWith(prefix))
    .sort(([a], [b]) => a.localeCompare(b))
    .flatMap(([key, entry]) =>
      resolveEntryOutputs(entry, key.slice(prefix.length), manifestDir),
    )
}

export type OutputSelection =
  | { ok: true; output: LockOutput }
  | { ok: false; reason: string }

/**
 * Select the one output needed by a single-cell consumer such as `mount`.
 * Multi-output sets are deliberately ambiguous unless the manifest names a
 * role; choosing index zero is silent data loss disguised as convenience.
 */
export function selectEntryOutput(entry: LockEntry, role?: string): OutputSelection {
  if (role) {
    const output = entry.outputs.find((candidate) => candidate.role === role)
    return output
      ? { ok: true, output }
      : { ok: false, reason: `output role "${role}" is not recorded` }
  }
  if (entry.outputs.length === 0) return { ok: false, reason: "no output recorded in the lockfile" }
  if (entry.outputs.length === 1) return { ok: true, output: entry.outputs[0]! }

  const primary = entry.outputs.filter((output) => !output.role)
  if (primary.length === 1) return { ok: true, output: primary[0]! }
  return {
    ok: false,
    reason: `${entry.outputs.length} outputs are recorded; set \`outputRole\` to choose one`,
  }
}

/** Lock outputs for a resolved spec, or its conventional path before adoption. */
export function resolveSpecOutputs(
  spec: ResolvedSpec,
  lock: Lock | undefined,
  manifestDir: string,
): ResolvedOutput[] {
  const entry = lock?.entries[lockKey(spec.styleId, spec.assetId)]
  if (entry?.outputs.length) return resolveEntryOutputs(entry, spec.assetId, manifestDir)
  return [{
    assetId: spec.assetId,
    id: spec.assetId,
    index: 0,
    path: spec.outFile,
    absolutePath: path.resolve(spec.outFile),
    sha256: "",
  }]
}
