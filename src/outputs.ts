import path from "node:path"
import { upsert } from "./lock.ts"
import { lockKey, type Lock, type LockEntry, type LockOutput, type ResolvedSpec } from "./types.ts"

/** One lockfile output with the identity consumers should expose publicly. */
export interface ResolvedOutput extends LockOutput {
  assetId: string
  /** Stable within a style's atlas or report. Single-output assets keep their old id. */
  id: string
  index: number
  absolutePath: string
}

/** Store generated paths relative to the manifest so committed locks survive a clone/move. */
export function portableOutputPath(file: string, manifestDir: string): string {
  const root = path.resolve(manifestDir)
  const absolute = path.isAbsolute(file) ? path.normalize(file) : path.resolve(root, file)
  const relative = path.relative(root, absolute)
  // Different Windows drives cannot be expressed as a relative path. This is
  // the one case where retaining an absolute path is more honest than writing
  // a value that resolves somewhere else.
  const value = path.isAbsolute(relative) ? absolute : relative
  return value.split(path.sep).join("/")
}

/** Resolve a portable lock path against the manifest, never the process cwd. */
export function resolveOutputPath(recordedPath: string, manifestDir: string): string {
  if (path.isAbsolute(recordedPath)) return path.normalize(recordedPath)
  // A lock committed by Windows before paths became portable cannot be opened
  // directly on POSIX. `normalizeLockOutputPaths` rebases it from the spec.
  if (path.win32.isAbsolute(recordedPath)) return recordedPath
  return path.resolve(manifestDir, recordedPath.split(/[\\/]/).join(path.sep))
}

/** Deterministic current destination for one provider output. */
export function expectedOutputPath(
  spec: ResolvedSpec,
  role: string | undefined,
  index: number,
  total: number,
): string {
  if (total === 1) return spec.outFile
  const originalExt = path.extname(spec.outFile)
  const ext = originalExt || ".png"
  const stem = originalExt ? spec.outFile.slice(0, -originalExt.length) : spec.outFile
  const safeRole = (role ?? fallbackOutputRole(index)).replace(/[^a-zA-Z0-9_-]+/g, "-")
  return `${stem}-${safeRole}${ext}`
}

/** Resolve one recorded output from the current manifest-owned destination. */
export function currentOutputPath(
  output: Pick<LockOutput, "path" | "role">,
  spec: ResolvedSpec,
  index: number,
  total: number,
): string {
  // The lock records where bytes were written; the manifest owns where they
  // belong now. Always deriving from the current spec both rebases a clone and
  // prevents a hand-edited lock path from redirecting restore into an unrelated
  // project file. Output roles preserve structural-set identity.
  return expectedOutputPath(spec, output.role, index, total)
}

/** Resolve an entry member using the complete source-set order when available. */
export function currentEntryOutputPath(
  entry: LockEntry,
  spec: ResolvedSpec,
  index: number,
): string {
  const output = entry.outputs[index]!
  const sourceIndex = output.role
    ? (entry.sourceUrls ?? []).findIndex((source) => source.role === output.role)
    : -1
  const position = sourceIndex >= 0 ? sourceIndex : index
  const total = Math.max(entry.outputs.length, entry.sourceUrls?.length ?? 0)
  return currentOutputPath(output, spec, position, total)
}

/**
 * Rebase legacy absolute output paths onto this checkout and canonicalize all
 * selected entries in memory. Persistence remains the caller's decision.
 */
export function normalizeLockOutputPaths(lock: Lock, specs: ResolvedSpec[]): number {
  const byKey = new Map(specs.map((spec) => [lockKey(spec.styleId, spec.assetId), spec]))
  let changed = 0
  for (const [key, entry] of Object.entries(lock.entries)) {
    const spec = byKey.get(key)
    if (!spec) continue
    let entryChanged = false
    const outputs = entry.outputs.map((output, index) => {
      const absolute = currentEntryOutputPath(entry, spec, index)
      const portable = portableOutputPath(absolute, spec.root)
      if (portable === output.path) return output
      changed++
      entryChanged = true
      return { ...output, path: portable }
    })
    if (entryChanged) upsert(lock, key, { outputs })
  }
  return changed
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
    absolutePath: resolveOutputPath(output.path, manifestDir),
  }))
}

/** Resolve an entry using its current spec, including cross-checkout v2 migration. */
export function resolveSpecEntryOutputs(
  entry: LockEntry,
  spec: ResolvedSpec,
): ResolvedOutput[] {
  return entry.outputs.map((output, index) => ({
    ...output,
    assetId: spec.assetId,
    id: outputId(spec.assetId, output, index, entry.outputs.length),
    index,
    absolutePath: currentEntryOutputPath(entry, spec, index),
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
  if (entry?.outputs.length) return resolveSpecEntryOutputs(entry, spec)
  return [{
    assetId: spec.assetId,
    id: spec.assetId,
    index: 0,
    path: spec.outFile,
    absolutePath: path.resolve(spec.outFile),
    sha256: "",
  }]
}
