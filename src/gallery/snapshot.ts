import { createHash } from "node:crypto"
import { sha256File } from "../hash.ts"
import { existsSync } from "node:fs"
import { stat } from "node:fs/promises"
import path from "node:path"
import { loadLock, spendByUnit } from "../lock.ts"
import { loadManifest, resolveSpecs, type LoadedManifest } from "../manifest.ts"
import { mediaTypeFromExtension, type MediaType } from "../media.ts"
import { currentEntryOutputPath, normalizeLockOutputPaths, portableOutputPath, resolveOutputPath } from "../outputs.ts"
import { buildPlan, type PlanState } from "../pipeline/plan.ts"
import type { QualityProfileInspection } from "../pipeline/quality-profile.ts"
import { checkQualityRecord, type RefineRecordOptions } from "../pipeline/refine.ts"
import { lockKey, type Asset, type Lock, type LockEntry, type ResolvedSpec } from "../types.ts"
import { resolveProject, type Workspace } from "../workspace.ts"

/**
 * A read-only view of everything the project has generated, built from the
 * same three sources `plan` reads — manifest, lockfile, and disk — and nothing
 * else. No provider is contacted, so the snapshot is free to rebuild on every
 * page refresh while a `gen` runs in another terminal.
 *
 * The lockfile is the record of paid work, so the gallery is lock-first: an
 * entry the manifest no longer declares still appears (as `undeclared`) rather
 * than vanishing, and a declared asset with no entry yet appears as a
 * placeholder so the gallery also shows what has *not* been made.
 */
export type GalleryState = PlanState | "undeclared"

export interface GalleryMedia {
  /** Absolute path of the file the server may read for this id. */
  path: string
  contentType: MediaType
}

export interface GalleryOutput {
  /** Manifest-relative path as recorded (or as the manifest would record it). */
  path: string
  absolutePath: string
  /** Null for a file PixelKiln did not download (untracked or `source` art). */
  sha256: string | null
  role: string | null
  mediaType: MediaType | null
  exists: boolean
  bytes: number | null
  /** Served only while the gallery runs; null when the file is missing. */
  url: string | null
}

export interface GalleryQuality {
  state: QualityProfileInspection["state"]
  reason: string
  /** Manifest-relative refined output path. */
  output: string
  /** Manifest-relative quality companion path. */
  record: string
  recordExists: boolean
  outputs: GalleryOutput[]
  palette: string[] | null
  review:
    | { status: "pending" }
    | { status: "approved"; reviewer: string; approvedAt: string; note: string | null }
    | null
  nativeGrid: {
    confidence: string
    consensus: string
    stepX: number
    stepY: number
    sourceWidth: number
    sourceHeight: number
    nativeWidth: number
    nativeHeight: number
  } | null
  audit: { safe: boolean; colorCount: number; transparency: number; reasons: string[] } | null
  frameSet: { fps: number; count: number; roles: string[] } | null
  /** Fail-closed verdict from the record itself, when one could be read. */
  check: { safe: boolean; current: boolean; reasons: string[] } | null
}

export interface GalleryItem {
  /** Page identity: the lock key, prefixed by project id in a workspace. */
  id: string
  /** Workspace project id, or null for a single-project gallery. */
  project: string | null
  key: string
  styleId: string
  assetId: string
  /** False for a lock entry the current manifest no longer declares. */
  declared: boolean
  state: GalleryState
  reason: string
  /** Lock lifecycle status; null when nothing has been submitted. */
  status: LockEntry["status"] | null
  provider: string
  generator: string
  /** The prompt actually sent, or the prompt that would be sent. */
  prompt: string
  /** Current resolved prompt when it differs from the one recorded (stale work). */
  currentPrompt: string | null
  width: number
  height: number
  tileFeature: string | null
  /** Playback rate for an ordered frame set, from the quality record or provider metadata. */
  fps: number | null
  cost: number
  costUnit: string
  /** Offline estimate for the current spec; null for undeclared entries. */
  estimatedCost: number | null
  candidates: number | null
  submittedAt: string | null
  downloadedAt: string | null
  jobId: string | null
  objectId: string | null
  reviewObjectId: string | null
  candidateIndex: number | null
  error: string | null
  recordedSpecHash: string | null
  currentSpecHash: string | null
  revision: LockEntry["revision"]
  /** Parent lock key for a revision, so the page can link lineage. */
  revisionParentKey: string | null
  outputs: GalleryOutput[]
  quality: GalleryQuality | null
  providerMetadata: Record<string, unknown>
  /** Manifest asset as declared, for the "intent" side of the record. */
  asset: Asset | null
  /** Manifest-relative committed art placed instead of generated output. */
  source: string | null
  tags: string[]
  category: string | null
}

export interface GalleryStyle {
  id: string
  /** Workspace project id, or null for a single-project gallery. */
  project: string | null
  provider: string
  generator: string
  outDir: string
  palette: string[]
  quality: boolean
  tags: string[]
  items: number
  spendByUnit: Record<string, number>
}

export interface GalleryProject {
  /** Workspace catalog id; the manifest name for a single project. */
  id: string
  name: string
  manifest: string
  lock: string
  root: string
  /** Manifest default provider, or the catalog provider when the manifest failed to load. */
  provider: string
  account: string | null
  /** Hash of the manifest bytes this snapshot was built from; an edit must quote it. */
  manifestSha256: string | null
  entries: number
  items: number
  spendByUnit: Record<string, number>
  /** Why this project contributed nothing; a broken sibling never hides the rest. */
  error: string | null
}

export interface GallerySnapshot {
  version: 1
  generatedAt: string
  /** The one project shown; null in a workspace gallery. */
  project: GalleryProject | null
  /** Every registered project, in catalog order; null for a single project. */
  workspace: { path: string; dir: string; projects: GalleryProject[] } | null
  /** Active `--style`/`--only` filters, so the page can say what it is showing. */
  filter: { styles: string[]; assets: string[] }
  totals: {
    entries: number
    items: number
    byState: Record<string, number>
    byStatus: Record<string, number>
    spendByUnit: Record<string, number>
  }
  styles: GalleryStyle[]
  items: GalleryItem[]
}

export interface GalleryBuild {
  snapshot: GallerySnapshot
  /** Exactly the files the page may load, keyed by their route id. */
  media: Map<string, GalleryMedia>
}

export interface BuildGalleryOptions {
  loaded: LoadedManifest
  specs: ResolvedSpec[]
  lock: Lock
  lockPath: string
  filter?: { styles?: string[]; assets?: string[] }
  /** Deterministic clock hook for tests. */
  now?: () => Date
}

/** Route id for one absolute path: stable across refreshes, not enumerable. */
export function galleryMediaId(absolutePath: string): string {
  return createHash("sha256").update(path.resolve(absolutePath)).digest("hex").slice(0, 24)
}

export function galleryMediaRoute(id: string): string {
  return `/media/${id}`
}

/** True when the manifest still pairs this asset with this style. */
function isDeclared(loaded: LoadedManifest, styleId: string, assetId: string): boolean {
  const asset = loaded.manifest.assets[assetId]
  if (!asset || !loaded.manifest.styles[styleId]) return false
  return asset.styles.length === 0 || asset.styles.includes(styleId)
}

function matchesFilter(
  filter: BuildGalleryOptions["filter"],
  styleId: string,
  assetId: string,
): boolean {
  if (filter?.styles?.length && !filter.styles.includes(styleId)) return false
  if (filter?.assets?.length && !filter.assets.includes(assetId)) return false
  return true
}

/** ComfyUI records the frame-set rate under its own namespace; other adapters may too. */
function metadataFps(entry: LockEntry | undefined): number | null {
  if (!entry) return null
  const namespace = entry.providerMetadata?.[entry.provider]
  const frameSet = namespace?.frameSet
  if (frameSet && typeof frameSet === "object" && "fps" in frameSet) {
    const fps = (frameSet as { fps?: unknown }).fps
    if (typeof fps === "number" && Number.isFinite(fps) && fps > 0) return fps
  }
  return null
}

async function fileBytes(absolutePath: string): Promise<number | null> {
  try {
    const info = await stat(absolutePath)
    return info.isFile() ? info.size : null
  } catch {
    return null
  }
}

async function describeOutput(
  media: Map<string, GalleryMedia>,
  root: string,
  absolutePath: string,
  recorded: { sha256?: string | null; role?: string; mediaType?: MediaType } = {},
): Promise<GalleryOutput> {
  const bytes = await fileBytes(absolutePath)
  const exists = bytes !== null
  const mediaType = recorded.mediaType ?? mediaTypeFromExtension(absolutePath)
  let url: string | null = null
  if (exists && mediaType) {
    const id = galleryMediaId(absolutePath)
    media.set(id, { path: absolutePath, contentType: mediaType })
    // The hash (or size) doubles as a cache-buster so a regenerated file with
    // the same path is not shown from the browser cache after Refresh.
    url = `${galleryMediaRoute(id)}?v=${(recorded.sha256 ?? String(bytes)).slice(0, 16)}`
  }
  return {
    path: portableOutputPath(absolutePath, root),
    absolutePath,
    sha256: recorded.sha256 ?? null,
    role: recorded.role ?? null,
    mediaType,
    exists,
    bytes,
    url,
  }
}

async function describeQuality(
  media: Map<string, GalleryMedia>,
  root: string,
  inspection: QualityProfileInspection,
): Promise<GalleryQuality> {
  const outputPaths = inspection.outputs ?? [inspection.output]
  const outputs = await Promise.all(
    outputPaths.map((file) => describeOutput(media, root, path.resolve(root, file))),
  )
  const recordPath = path.resolve(root, inspection.record)
  const recordExists = existsSync(recordPath)
  let options: RefineRecordOptions | null = null
  let check: GalleryQuality["check"] = null
  if (recordExists) {
    try {
      const result = await checkQualityRecord(recordPath)
      options = result.options
      check = { safe: result.safe, current: result.current, reasons: result.reasons }
    } catch (error) {
      // An unreadable companion is itself information; the inspection already
      // carries the fail-closed reason, so the record details simply stay empty.
      check = {
        safe: false,
        current: false,
        reasons: [error instanceof Error ? error.message : String(error)],
      }
    }
  }
  return {
    state: inspection.state,
    reason: inspection.reason,
    output: portableOutputPath(path.resolve(root, inspection.output), root),
    record: portableOutputPath(recordPath, root),
    recordExists,
    outputs,
    palette: options?.palette.colors ?? null,
    review: options
      ? options.review.status === "approved"
        ? {
            status: "approved",
            reviewer: options.review.reviewer,
            approvedAt: options.review.approvedAt,
            note: options.review.note ?? null,
          }
        : { status: "pending" }
      : null,
    nativeGrid: options
      ? {
          confidence: options.nativeGrid.confidence,
          consensus: options.nativeGrid.consensus,
          stepX: options.nativeGrid.stepX,
          stepY: options.nativeGrid.stepY,
          sourceWidth: options.nativeGrid.sourceWidth,
          sourceHeight: options.nativeGrid.sourceHeight,
          nativeWidth: options.nativeGrid.nativeWidth,
          nativeHeight: options.nativeGrid.nativeHeight,
        }
      : null,
    audit: options
      ? {
          safe: options.audit.safe,
          colorCount: options.audit.colorCount,
          transparency: options.audit.transparency,
          reasons: options.audit.reasons,
        }
      : null,
    frameSet: options?.frameSet
      ? { fps: options.frameSet.fps, count: options.frameSet.count, roles: options.frameSet.roles }
      : null,
    check,
  }
}

/**
 * Build the gallery from the project's offline state. `specs` are the resolved
 * (possibly filtered) manifest entries the CLI already computed; lock entries
 * outside the manifest are added here so paid work is never hidden.
 */
export async function buildGallerySnapshot(opts: BuildGalleryOptions): Promise<GalleryBuild> {
  const { loaded, specs, lock } = opts
  const root = loaded.root
  const media = new Map<string, GalleryMedia>()
  const plan = await buildPlan(specs, lock)
  const items: GalleryItem[] = []

  for (const planItem of plan.items) {
    const { spec, key } = planItem
    const entry = lock.entries[key]
    const asset = loaded.manifest.assets[spec.assetId] ?? null

    let outputs: GalleryOutput[]
    if (entry && entry.outputs.length) {
      outputs = await Promise.all(
        entry.outputs.map((output, index) =>
          describeOutput(media, root, currentEntryOutputPath(entry, spec, index), output),
        ),
      )
    } else if (spec.source) {
      outputs = [await describeOutput(media, root, path.resolve(root, spec.source))]
    } else if (!entry && existsSync(spec.outFile)) {
      // Untracked: the art is on disk with no provenance. Showing it is the
      // point — it is exactly the file a careless regeneration would clobber.
      outputs = [await describeOutput(media, root, spec.outFile)]
    } else {
      outputs = []
    }

    const quality = planItem.quality ? await describeQuality(media, root, planItem.quality) : null
    items.push({
      id: key,
      project: null,
      key,
      styleId: spec.styleId,
      assetId: spec.assetId,
      declared: true,
      state: planItem.state,
      reason: planItem.reason,
      status: entry?.status ?? null,
      provider: entry?.provider ?? spec.provider,
      generator: entry?.generator ?? spec.generator,
      prompt: entry?.prompt ?? spec.prompt,
      currentPrompt: entry && entry.prompt !== spec.prompt ? spec.prompt : null,
      width: entry?.width ?? spec.width,
      height: entry?.height ?? spec.height,
      tileFeature: entry?.tileFeature ?? spec.tileFeature ?? null,
      fps: quality?.frameSet?.fps ?? metadataFps(entry) ?? spec.quality?.fps ?? null,
      cost: entry?.cost ?? 0,
      costUnit: entry?.costUnit ?? spec.costUnit,
      estimatedCost: spec.cost,
      candidates: spec.candidates,
      submittedAt: entry?.submittedAt ?? null,
      downloadedAt: entry?.downloadedAt ?? null,
      jobId: entry?.jobId ?? null,
      objectId: entry?.objectId ?? null,
      reviewObjectId: entry?.reviewObjectId ?? null,
      candidateIndex: entry?.candidateIndex ?? null,
      error: entry?.error ?? null,
      recordedSpecHash: entry?.specHash ?? null,
      currentSpecHash: spec.specHash,
      revision: entry?.revision ?? null,
      revisionParentKey: spec.revision
        ? lockKey(spec.styleId, spec.revision.sourceAssetId)
        : entry?.revision
          ? lockKey(spec.styleId, entry.revision.sourceAssetId)
          : null,
      outputs,
      quality,
      providerMetadata: entry?.providerMetadata ?? {},
      asset,
      source: spec.source ?? null,
      tags: spec.tags,
      category: asset?.category ?? null,
    })
  }

  const shown = new Set(items.map((item) => item.key))
  for (const [key, entry] of Object.entries(lock.entries)) {
    if (shown.has(key)) continue
    if (isDeclared(loaded, entry.styleId, entry.assetId)) continue // merely filtered out
    if (!matchesFilter(opts.filter, entry.styleId, entry.assetId)) continue
    const outputs = await Promise.all(
      entry.outputs.map((output) =>
        describeOutput(media, root, resolveOutputPath(output.path, root), output),
      ),
    )
    items.push({
      id: key,
      project: null,
      key,
      styleId: entry.styleId,
      assetId: entry.assetId,
      declared: false,
      state: "undeclared",
      reason: "not declared by the current manifest; `pixelkiln prune` removes the entry",
      status: entry.status,
      provider: entry.provider,
      generator: entry.generator,
      prompt: entry.prompt,
      currentPrompt: null,
      width: entry.width,
      height: entry.height,
      tileFeature: entry.tileFeature,
      fps: metadataFps(entry),
      cost: entry.cost,
      costUnit: entry.costUnit,
      estimatedCost: null,
      candidates: null,
      submittedAt: entry.submittedAt,
      downloadedAt: entry.downloadedAt,
      jobId: entry.jobId,
      objectId: entry.objectId,
      reviewObjectId: entry.reviewObjectId,
      candidateIndex: entry.candidateIndex,
      error: entry.error,
      recordedSpecHash: entry.specHash,
      currentSpecHash: null,
      revision: entry.revision,
      revisionParentKey: entry.revision ? lockKey(entry.styleId, entry.revision.sourceAssetId) : null,
      outputs,
      quality: null,
      providerMetadata: entry.providerMetadata ?? {},
      asset: null,
      source: null,
      tags: [],
      category: null,
    })
  }

  items.sort((a, b) => a.key.localeCompare(b.key))

  const byState: Record<string, number> = {}
  for (const item of items) byState[item.state] = (byState[item.state] ?? 0) + 1
  const byStatus: Record<string, number> = {}
  for (const entry of Object.values(lock.entries)) {
    byStatus[entry.status] = (byStatus[entry.status] ?? 0) + 1
  }

  const styleIds = new Set<string>([
    ...Object.keys(loaded.manifest.styles),
    ...items.map((item) => item.styleId),
  ])
  const styles: GalleryStyle[] = [...styleIds]
    .filter((id) => !opts.filter?.styles?.length || opts.filter.styles.includes(id) ||
      items.some((item) => item.styleId === id))
    .sort()
    .map((id) => {
      const style = loaded.manifest.styles[id]
      const styleItems = items.filter((item) => item.styleId === id)
      const spend: Record<string, number> = {}
      for (const item of styleItems) {
        if (item.cost) spend[item.costUnit] = (spend[item.costUnit] ?? 0) + item.cost
      }
      return {
        id,
        project: null,
        // A declared style inherits the manifest default; only a style the
        // manifest no longer has falls back to what its entries recorded.
        provider: style
          ? style.provider ?? loaded.manifest.provider
          : styleItems[0]?.provider ?? loaded.manifest.provider,
        generator: style?.generator ?? styleItems[0]?.generator ?? "map",
        outDir: style?.outDir ?? "",
        palette: style?.palette ?? [],
        quality: Boolean(style?.quality),
        tags: style?.tags ?? [],
        items: styleItems.length,
        spendByUnit: spend,
      }
    })
    .filter((style) => style.items > 0 || !opts.filter?.styles?.length)

  const snapshot: GallerySnapshot = {
    version: 1,
    generatedAt: (opts.now ?? (() => new Date()))().toISOString(),
    project: {
      id: loaded.manifest.name,
      name: loaded.manifest.name,
      manifest: loaded.path,
      lock: path.resolve(opts.lockPath),
      root,
      provider: loaded.manifest.provider,
      account: null,
      manifestSha256: await sha256File(loaded.path),
      entries: Object.keys(lock.entries).length,
      items: items.length,
      spendByUnit: spendByUnit(lock),
      error: null,
    },
    workspace: null,
    filter: { styles: opts.filter?.styles ?? [], assets: opts.filter?.assets ?? [] },
    totals: {
      entries: Object.keys(lock.entries).length,
      items: items.length,
      byState,
      byStatus,
      spendByUnit: spendByUnit(lock),
    },
    styles,
    items,
  }
  return { snapshot, media }
}

export interface BuildWorkspaceGalleryOptions {
  workspace: Workspace
  /** Catalog path; project paths resolve against its directory. */
  workspacePath: string
  filter?: { styles?: string[]; assets?: string[] }
  now?: () => Date
}

/**
 * One gallery for every project a workspace catalog registers. Each project
 * is built with the single-project builder and its items are namespaced by
 * project id, so two projects can both own `base/anvil`. A project whose
 * manifest or lock fails to load is listed with its error and contributes
 * nothing, mirroring `workspace status`: one broken sibling must not hide
 * the rest. A `--style`/`--only` filter is applied per project and a project
 * that has none of the requested ids simply shows zero items.
 */
export async function buildWorkspaceGallerySnapshot(
  opts: BuildWorkspaceGalleryOptions,
): Promise<GalleryBuild> {
  const dir = path.dirname(path.resolve(opts.workspacePath))
  const media = new Map<string, GalleryMedia>()
  const projects: GalleryProject[] = []
  const items: GalleryItem[] = []
  const styles: GalleryStyle[] = []
  const filter = { styles: opts.filter?.styles ?? [], assets: opts.filter?.assets ?? [] }

  for (const project of opts.workspace.projects) {
    const { manifestPath, lockPath } = resolveProject(dir, project)
    try {
      const loaded = await loadManifest(manifestPath)
      const styleFilter = filter.styles.filter((id) => loaded.manifest.styles[id])
      const assetFilter = filter.assets.filter((id) => loaded.manifest.assets[id])
      const excluded =
        (filter.styles.length > 0 && styleFilter.length === 0) ||
        (filter.assets.length > 0 && assetFilter.length === 0)
      const lock = await loadLock(lockPath)
      let projectItems: GalleryItem[] = []
      let projectStyles: GalleryStyle[] = []
      if (!excluded) {
        const specs = await resolveSpecs(loaded, { styles: styleFilter, assets: assetFilter })
        normalizeLockOutputPaths(lock, specs)
        const build = await buildGallerySnapshot({
          loaded,
          specs,
          lock,
          lockPath,
          filter: { styles: styleFilter, assets: assetFilter },
          now: opts.now,
        })
        for (const [id, file] of build.media) media.set(id, file)
        projectItems = build.snapshot.items.map((item) => ({
          ...item,
          id: `${project.id}:${item.key}`,
          project: project.id,
        }))
        projectStyles = build.snapshot.styles.map((style) => ({ ...style, project: project.id }))
      }
      items.push(...projectItems)
      styles.push(...projectStyles)
      projects.push({
        id: project.id,
        name: loaded.manifest.name,
        manifest: manifestPath,
        lock: path.resolve(lockPath),
        root: loaded.root,
        provider: loaded.manifest.provider,
        account: project.account ?? null,
        manifestSha256: await sha256File(manifestPath),
        entries: Object.keys(lock.entries).length,
        items: projectItems.length,
        spendByUnit: spendByUnit(lock),
        error: null,
      })
    } catch (err) {
      projects.push({
        id: project.id,
        name: project.id,
        manifest: manifestPath,
        lock: path.resolve(lockPath),
        root: path.dirname(manifestPath),
        provider: project.provider,
        account: project.account ?? null,
        manifestSha256: null,
        entries: 0,
        items: 0,
        spendByUnit: {},
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }

  const byState: Record<string, number> = {}
  for (const item of items) byState[item.state] = (byState[item.state] ?? 0) + 1
  const byStatus: Record<string, number> = {}
  for (const item of items) if (item.status) byStatus[item.status] = (byStatus[item.status] ?? 0) + 1
  const spend: Record<string, number> = {}
  for (const project of projects) {
    for (const [unit, amount] of Object.entries(project.spendByUnit)) {
      spend[unit] = (spend[unit] ?? 0) + amount
    }
  }

  return {
    snapshot: {
      version: 1,
      generatedAt: (opts.now ?? (() => new Date()))().toISOString(),
      project: null,
      workspace: { path: path.resolve(opts.workspacePath), dir, projects },
      filter,
      totals: {
        entries: projects.reduce((sum, project) => sum + project.entries, 0),
        items: items.length,
        byState,
        byStatus,
        spendByUnit: spend,
      },
      styles,
      items,
    },
    media,
  }
}
