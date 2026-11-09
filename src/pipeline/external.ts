import { existsSync } from "node:fs"
import path from "node:path"
import { sha256File } from "../hash.ts"
import { currentEntryOutputPath } from "../outputs.ts"
import type { LockEntry, ResolvedSpec } from "../types.ts"
import type { PlanState } from "./plan.ts"

/**
 * Where an externally built asset stands. pixelkiln never builds one, so
 * nothing here is ever actionable: every state other than `ok` is `untracked`
 * or `orphaned`, with the manual step that fixes it in the reason. Recording
 * the built file is `adopt --local`.
 */
export async function inspectExternal(
  spec: ResolvedSpec,
  entry: LockEntry | undefined,
): Promise<{ state: PlanState; reason: string }> {
  const external = spec.external!
  const file = entry?.outputs.length ? currentEntryOutputPath(entry, spec, 0) : spec.outFile
  const rebuild = `run \`${external.builder}\``
  if (!existsSync(file)) {
    return { state: "orphaned", reason: `built outside pixelkiln and not found at ${path.relative(spec.root, file)}; ${rebuild}, then adopt --local` }
  }
  if (!entry) {
    return { state: "untracked", reason: `built outside pixelkiln; record it with adopt --local (builder: ${external.builder})` }
  }
  if (entry.specHash !== spec.specHash) {
    return { state: "orphaned", reason: `builder or an input changed since the file was recorded; ${rebuild}, then adopt --local --force` }
  }
  const recorded = entry.outputs[0]?.sha256
  if (!recorded || (await sha256File(file)) !== recorded) {
    return { state: "orphaned", reason: "file changed since it was recorded; adopt --local --force to record it again" }
  }
  return { state: "ok", reason: "built outside pixelkiln; matches the recorded file" }
}
