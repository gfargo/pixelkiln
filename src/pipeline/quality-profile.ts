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
  qualityFrameOutputPath,
  qualityRecordPath,
  refineAsset,
  refineFrameSet,
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
  sources?: string[]
  output: string
  outputs?: string[]
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
  items: Array<{ role: string; path: string }> | null
  reason?: string
}

async function qualitySource(spec: ResolvedSpec, lock: Lock): Promise<QualitySource> {
  if (spec.source) {
    if (spec.generator === "frames") {
      return { items: null, reason: "frame-set quality requires ordered downloaded provider outputs" }
    }
    const source = path.resolve(spec.root, spec.source)
    return existsSync(source)
      ? { items: [{ role: "source", path: source }] }
      : { items: null, reason: `declared source is missing: ${spec.source}` }
  }

  const entry = lock.entries[lockKey(spec.styleId, spec.assetId)]
  if (!entry) return { items: null, reason: "raw provider output is not in the lockfile" }
  if (entry.specHash !== spec.specHash) {
    return { items: null, reason: "raw provider output does not match the current generation spec" }
  }
  if (entry.status !== "downloaded") {
    return { items: null, reason: `raw provider output is ${entry.status}, not downloaded` }
  }
  const frameSet = spec.generator === "frames"
  if ((!frameSet && entry.outputs.length !== 1) || (frameSet && entry.outputs.length < 2)) {
    return {
      items: null,
      reason: frameSet
        ? `frame-set quality requires at least two PNG outputs; lock entry has ${entry.outputs.length}`
        : `quality profiles require one PNG output; lock entry has ${entry.outputs.length}`,
    }
  }
  const roles = new Set<string>()
  const items: Array<{ role: string; path: string }> = []
  for (const [index, output] of entry.outputs.entries()) {
    if (output.mediaType && output.mediaType !== MediaType.PNG) {
      return { items: null, reason: `quality profiles require PNG input; lock entry is ${output.mediaType}` }
    }
    const role = frameSet ? output.role : "source"
    if (frameSet && (!role || roles.has(role))) {
      return { items: null, reason: "frame-set quality requires a unique role for every ordered output" }
    }
    if (role) roles.add(role)
    const source = currentEntryOutputPath(entry, spec, index)
    if (!existsSync(source)) return { items: null, reason: `raw provider output is missing: ${source}` }
    if ((await sha256File(source)) !== output.sha256) {
      return { items: null, reason: "raw provider output was modified after download" }
    }
    items.push({ role: role!, path: source })
  }
  return { items }
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
  if (!source.items) {
    return { key, state: "blocked", reason: source.reason!, source: null, output, record }
  }
  const sourcePaths = source.items.map((item) => item.path)
  const expectedOutputs = spec.generator === "frames"
    ? source.items.map((item, index) => qualityFrameOutputPath(output, item.role, index))
    : [output]
  if (!existsSync(record)) {
    return {
      key,
      state: "needs-refinement",
      reason: "no refinement record",
      source: sourcePaths[0]!,
      sources: sourcePaths,
      output,
      outputs: expectedOutputs,
      record,
    }
  }

  try {
    const check = await checkQualityRecord(record)
    const expectedPalette = normalizeRefinementPalette(spec.quality.palette)
    const expectedRevision = spec.quality.fixerRevision ?? PIXEL_ART_FIXER_REVISION
    const expectedTransparency = spec.quality.minTransparency ?? null
    const expectedFrameSet = spec.generator === "frames"
      ? { fps: spec.quality.fps ?? 12, count: source.items.length, roles: source.items.map((item) => item.role) }
      : null
    const contractChanged =
      JSON.stringify(check.sources.map((item) => path.resolve(item))) !==
        JSON.stringify(sourcePaths.map((item) => path.resolve(item))) ||
      JSON.stringify(check.outputs.map((item) => path.resolve(item))) !==
        JSON.stringify(expectedOutputs.map((item) => path.resolve(item))) ||
      JSON.stringify(check.options.palette.colors) !== JSON.stringify(expectedPalette) ||
      check.options.nativeGrid.revision !== expectedRevision ||
      check.options.audit.thresholds.minGridConfidence !== spec.quality.minGridConfidence ||
      check.options.audit.thresholds.minTransparency !== expectedTransparency ||
      (expectedFrameSet
        ? !check.options.frameSet ||
          check.options.frameSet.fps !== expectedFrameSet.fps ||
          check.options.frameSet.count !== expectedFrameSet.count ||
          JSON.stringify(check.options.frameSet.roles) !== JSON.stringify(expectedFrameSet.roles)
        : check.options.frameSet !== undefined)

    if (contractChanged) {
      return {
        key,
        state: "needs-refinement",
        reason: "quality profile changed",
        source: sourcePaths[0]!,
        sources: sourcePaths,
        output,
        outputs: expectedOutputs,
        record,
      }
    }
    if (!check.current || !check.auditSafe) {
      return {
        key,
        state: "needs-refinement",
        reason: check.reasons.filter((reason) => reason !== "human 1× review is pending").join("; ") ||
          "refinement record is stale",
        source: sourcePaths[0]!,
        sources: sourcePaths,
        output,
        outputs: expectedOutputs,
        record,
      }
    }
    if (!check.approved) {
      return {
        key,
        state: "needs-approval",
        reason: "automated checks passed; human 1× review is pending",
        source: sourcePaths[0]!,
        sources: sourcePaths,
        output,
        outputs: expectedOutputs,
        record,
      }
    }
    return {
      key,
      state: "approved",
      reason: "refined output and human approval are current",
      source: sourcePaths[0]!,
      sources: sourcePaths,
      output,
      outputs: expectedOutputs,
      record,
    }
  } catch (error) {
    return {
      key,
      state: "needs-refinement",
      reason: `invalid refinement record: ${error instanceof Error ? error.message : String(error)}`,
      source: sourcePaths[0]!,
      sources: sourcePaths,
      output,
      outputs: expectedOutputs,
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
      const common = {
        output: inspection.output,
        palette: spec.quality!.palette,
        minGridConfidence: spec.quality!.minGridConfidence,
        ...(spec.quality!.minTransparency == null
          ? {}
          : { minTransparency: spec.quality!.minTransparency }),
        fixerRevision: spec.quality!.fixerRevision ?? PIXEL_ART_FIXER_REVISION,
        fixerPython: options.fixerPython,
        fixerCommand: options.fixerCommand,
        fixerArgsPrefix: options.fixerArgsPrefix,
        force: options.force,
      }
      if (spec.generator === "frames") {
        const frameSources = await qualitySource(spec, lock)
        if (!frameSources.items) throw new Error(frameSources.reason)
        await refineFrameSet({
          ...common,
          sources: frameSources.items,
          fps: spec.quality!.fps ?? 12,
        })
      } else {
        await refineAsset({ ...common, source: inspection.source! })
      }
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
  outputRoles?: Readonly<Record<string, string>>,
): Promise<Record<string, string> | undefined> {
  const configured = specs.filter(
    (spec) => spec.quality && (!assetIds || assetIds.has(spec.assetId)),
  )
  if (!configured.length) return undefined

  const sources: Record<string, string> = {}
  const rejected: QualityProfileInspection[] = []
  for (const spec of configured) {
    const inspection = (await inspectQualityProfile(spec, lock))!
    if (inspection.state === "approved") {
      if (spec.generator === "frames") {
        const check = await checkQualityRecord(inspection.record)
        const roles = check.options.frameSet!.roles
        if (outputRoles) {
          const selectedRole = outputRoles[spec.assetId]
          if (!selectedRole) {
            throw new Error(
              `Mounting quality-approved frame set ${inspection.key} requires asset.outputRole.`,
            )
          }
          const index = roles.indexOf(selectedRole)
          if (index < 0) {
            throw new Error(
              `Frame set ${inspection.key} has no approved output role "${selectedRole}".`,
            )
          }
          sources[spec.assetId] = check.outputs[index]!
        } else {
          for (const [index, output] of check.outputs.entries()) {
            sources[`${spec.assetId}/${roles[index]}`] = output
          }
        }
      } else {
        sources[spec.assetId] = inspection.output
      }
    } else rejected.push(inspection)
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
