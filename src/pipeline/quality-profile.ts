import { existsSync } from "node:fs"
import path from "node:path"
import { sha256File } from "../hash.ts"
import { MediaType } from "../media.ts"
import { currentEntryOutputPath } from "../outputs.ts"
import { lockKey, type Lock, type ResolvedSpec } from "../types.ts"
import {
  PIXEL_ART_FIXER_REVISION,
  checkQualityRecord,
  normalizeRefinementPalette,
  qualityRecordPath,
  refineAsset,
} from "./refine.ts"

export type QualityProfileState =
  | "blocked"
  | "needs-refinement"
  | "needs-approval"
  | "approved"

export interface QualityProfileInspection {
  key: string
  state: QualityProfileState
  reason: string
  source: string | null
  output: string
  record: string
}

export interface RefineQualityProfilesOptions {
  fixerPython?: string
  force?: boolean
  /** @internal Alternate fixer command used by compatibility tests. */
  fixerCommand?: string
  /** @internal Prefix arguments for the alternate fixer command. */
  fixerArgsPrefix?: string[]
}

export interface RefineQualityProfilesResult {
  processed: number
  skipped: number
  failed: number
  items: QualityProfileInspection[]
}

interface QualitySource {
  path: string | null
  reason?: string
}

async function qualitySource(spec: ResolvedSpec, lock: Lock): Promise<QualitySource> {
  if (spec.source) {
    const source = path.resolve(spec.root, spec.source)
    return existsSync(source)
      ? { path: source }
      : { path: null, reason: `declared source is missing: ${spec.source}` }
  }

  const entry = lock.entries[lockKey(spec.styleId, spec.assetId)]
  if (!entry) return { path: null, reason: "raw provider output is not in the lockfile" }
  if (entry.specHash !== spec.specHash) {
    return { path: null, reason: "raw provider output does not match the current generation spec" }
  }
  if (entry.status !== "downloaded") {
    return { path: null, reason: `raw provider output is ${entry.status}, not downloaded` }
  }
  if (entry.outputs.length !== 1) {
    return {
      path: null,
      reason: `quality profiles require one PNG output; lock entry has ${entry.outputs.length}`,
    }
  }
  const output = entry.outputs[0]!
  if (output.mediaType && output.mediaType !== MediaType.PNG) {
    return { path: null, reason: `quality profiles require PNG input; lock entry is ${output.mediaType}` }
  }
  const source = currentEntryOutputPath(entry, spec, 0)
  if (!existsSync(source)) return { path: null, reason: `raw provider output is missing: ${source}` }
  if ((await sha256File(source)) !== output.sha256) {
    return { path: null, reason: "raw provider output was modified after download" }
  }
  return { path: source }
}

/** Inspect one configured quality output without changing files or contacting a provider. */
export async function inspectQualityProfile(
  spec: ResolvedSpec,
  lock: Lock,
): Promise<QualityProfileInspection | null> {
  if (!spec.quality) return null
  const key = lockKey(spec.styleId, spec.assetId)
  const output = spec.quality.outFile
  const record = qualityRecordPath(output)
  const source = await qualitySource(spec, lock)
  if (!source.path) {
    return { key, state: "blocked", reason: source.reason!, source: null, output, record }
  }
  if (!existsSync(record)) {
    return {
      key,
      state: "needs-refinement",
      reason: "no refinement record",
      source: source.path,
      output,
      record,
    }
  }

  try {
    const check = await checkQualityRecord(record)
    const expectedPalette = normalizeRefinementPalette(spec.quality.palette)
    const expectedRevision = spec.quality.fixerRevision ?? PIXEL_ART_FIXER_REVISION
    const expectedTransparency = spec.quality.minTransparency ?? null
    const contractChanged =
      path.resolve(check.source) !== path.resolve(source.path) ||
      path.resolve(check.output) !== path.resolve(output) ||
      JSON.stringify(check.options.palette.colors) !== JSON.stringify(expectedPalette) ||
      check.options.nativeGrid.revision !== expectedRevision ||
      check.options.audit.thresholds.minGridConfidence !== spec.quality.minGridConfidence ||
      check.options.audit.thresholds.minTransparency !== expectedTransparency

    if (contractChanged) {
      return {
        key,
        state: "needs-refinement",
        reason: "quality profile changed",
        source: source.path,
        output,
        record,
      }
    }
    if (!check.current || !check.auditSafe) {
      return {
        key,
        state: "needs-refinement",
        reason: check.reasons.filter((reason) => reason !== "human 1× review is pending").join("; ") ||
          "refinement record is stale",
        source: source.path,
        output,
        record,
      }
    }
    if (!check.approved) {
      return {
        key,
        state: "needs-approval",
        reason: "automated checks passed; human 1× review is pending",
        source: source.path,
        output,
        record,
      }
    }
    return {
      key,
      state: "approved",
      reason: "refined output and human approval are current",
      source: source.path,
      output,
      record,
    }
  } catch (error) {
    return {
      key,
      state: "needs-refinement",
      reason: `invalid refinement record: ${error instanceof Error ? error.message : String(error)}`,
      source: source.path,
      output,
      record,
    }
  }
}

/** Refine every configured, selected asset while preserving current approvals. */
export async function refineQualityProfiles(
  specs: ResolvedSpec[],
  lock: Lock,
  options: RefineQualityProfilesOptions = {},
): Promise<RefineQualityProfilesResult> {
  const configured = specs.filter((spec) => spec.quality)
  if (!configured.length) {
    throw new Error("No selected style has a quality profile.")
  }

  const result: RefineQualityProfilesResult = { processed: 0, skipped: 0, failed: 0, items: [] }
  for (const spec of configured) {
    const inspection = (await inspectQualityProfile(spec, lock))!
    if (!options.force && (inspection.state === "approved" || inspection.state === "needs-approval")) {
      result.skipped++
      result.items.push(inspection)
      continue
    }
    if (inspection.state === "blocked") {
      result.failed++
      result.items.push(inspection)
      continue
    }
    try {
      await refineAsset({
        source: inspection.source!,
        output: inspection.output,
        palette: spec.quality!.palette,
        minGridConfidence: spec.quality!.minGridConfidence,
        ...(spec.quality!.minTransparency == null
          ? {}
          : { minTransparency: spec.quality!.minTransparency }),
        fixerRevision: spec.quality!.fixerRevision ?? PIXEL_ART_FIXER_REVISION,
        // A one-off CLI/library override wins; otherwise each style can carry
        // the stable project-local interpreter that provides its pinned fixer.
        fixerPython: options.fixerPython ?? spec.quality!.fixerPython,
        fixerCommand: options.fixerCommand,
        fixerArgsPrefix: options.fixerArgsPrefix,
        force: options.force,
      })
      result.processed++
      result.items.push((await inspectQualityProfile(spec, lock))!)
    } catch (error) {
      result.failed++
      result.items.push({
        ...inspection,
        state: "needs-refinement",
        reason: error instanceof Error ? error.message : String(error),
      })
    }
  }
  return result
}

/** Return approved derived files for a packaging command, or fail closed. */
export async function requireApprovedQualitySources(
  specs: ResolvedSpec[],
  lock: Lock,
  assetIds?: ReadonlySet<string>,
): Promise<Record<string, string> | undefined> {
  const configured = specs.filter(
    (spec) => spec.quality && (!assetIds || assetIds.has(spec.assetId)),
  )
  if (!configured.length) return undefined

  const sources: Record<string, string> = {}
  const rejected: QualityProfileInspection[] = []
  for (const spec of configured) {
    const inspection = (await inspectQualityProfile(spec, lock))!
    if (inspection.state === "approved") sources[spec.assetId] = inspection.output
    else rejected.push(inspection)
  }
  if (rejected.length) {
    const detail = rejected
      .slice(0, 5)
      .map((item) => `${item.key}: ${item.state} (${item.reason})`)
      .join("; ")
    throw new Error(
      `Packaging requires current, human-approved quality output: ${detail}. ` +
        "Run `pixelkiln refine`, review each PNG, then run `pixelkiln refine approve --from <record> --reviewer <name>`.",
    )
  }
  return sources
}
