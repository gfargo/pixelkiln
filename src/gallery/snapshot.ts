import { createHash } from "node:crypto"
import { sha256, sha256File } from "../hash.ts"
import { existsSync } from "node:fs"
import { readFile, stat } from "node:fs/promises"
import path from "node:path"
import { loadLock, spendByUnit } from "../lock.ts"
import { loadManifest, resolveSpecs, type LoadedManifest } from "../manifest.ts"
import { cacheFileName, MediaType, mediaTypeFromExtension } from "../media.ts"
import { currentEntryOutputPath, frameSetFps, normalizeLockOutputPaths, portableOutputPath, resolveOutputPath, sourceIsStem, sourceOutputPath } from "../outputs.ts"
import { buildPlan, type PlanState } from "../pipeline/plan.ts"
import type { QualityProfileInspection } from "../pipeline/quality-profile.ts"
import { checkQualityRecord, type RefineRecordOptions } from "../pipeline/refine.ts"
import { decodePng } from "../png.ts"
import { lockKey, type Asset, type Lock, type LockEntry, type Postprocess, type ResolvedSpec } from "../types.ts"
import { resolveProject, type Workspace } from "../workspace.ts"
import { CANDIDATE_OPTION } from "./edit.ts"
import { handEditProjectPath, readHandEditCompanion } from "../pipeline/hand-edit.ts"
import { historyLimit } from "../pipeline/history.ts"
import { pixelLabObjectUrl } from "../providers/pixellab.ts"

/**
 * A read-only view of everything the project has generated, built from the
 * same three sources `plan` reads (manifest, lockfile, and disk) and nothing
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
  /** Images, or the editor's own project file kept beside a browser edit. */
  contentType: MediaType | typeof PROJECT_FILE_TYPE
}

/** Served type of a Pixelorama `.pxo`: a zip the browser never renders. */
export const PROJECT_FILE_TYPE = "application/octet-stream"

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
  /** File modification time, for telling an edit from the generation it started from. */
  modifiedAt: string | null
  /** Served only while the gallery runs; null when the file is missing. */
  url: string | null
}

export type HandEditStatus =
  /** The edit file has the generated art's pixels; nothing has been changed yet. */
  | "same"
  /** The author changed it. */
  | "edited"
  /** The generated art changed after the edit was last saved. */
  | "regenerated-since"
  /** The declared file is not on disk. */
  | "missing"

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
  /** Post-processing recorded on the entry: the palette its files were snapped to, if any. */
  postprocess: Postprocess | null
  /** Manifest asset as declared, for the "intent" side of the record. */
  asset: Asset | null
  /** Manifest-relative committed art placed instead of generated output. */
  source: string | null
  /**
   * The hand edit that stands in for this generation, when the asset has both
   * a lock entry and a `source`. Placed by mount and pack in place of the
   * generated file, which stays on disk as the record.
   */
  edit: GalleryOutput | null
  /**
   * Every file of the edit, one per output in the same order: the edit
   * itself for a single image, `<stem>-<role>.png` per member of a set.
   * Empty without a source.
   */
  edits: GalleryOutput[]
  /**
   * Per member of `edits`: true where its pixels differ from the generated
   * file. Compared by pixels, not bytes, because every editor re-encodes a
   * PNG it merely opened and saved.
   */
  editChanged: boolean[]
  editStatus: HandEditStatus | null
  /** What an in-browser save recorded beside the edit; null for edits made elsewhere. */
  editMeta: GalleryEditMeta | null
  /** Where the provider's own app shows this object, when it has one. */
  upstreamUrl: string | null
  /** Downloaded work with a durable provider reference; `fetch --refresh` can re-pull it. */
  refreshable: boolean
  /** Generations this one replaced, newest first; each can be brought back. */
  history: GalleryGeneration[]
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
  /** Resolved look, after inheritance. */
  promptPrefix: string
  promptSuffix: string
  palette: string[]
  /** Downloaded art is snapped to `palette` by fetch. */
  enforcePalette: boolean
  /** Provider view name, when the style sets one. */
  view: string | null
  /** Strip the generated background (sent for pixflux and non-PixelLab providers). */
  noBackground: boolean
  quality: boolean
  tags: string[]
  /** Parent style id when this style `extends` one. */
  extends: string | null
  /**
   * Fields the style declares itself, as written. A field absent here is
   * inherited (or a default), which is what decides whether a parent edit
   * reaches this style.
   */
  ownFields: string[]
  items: number
  spendByUnit: Record<string, number>
  /** What regenerating every declared asset in this style would cost now. */
  regenerate: { assets: number; cost: number; costUnit: string }
  /** Candidates one generation returns for this style; null when its assets disagree or none resolve. */
  candidates: number | null
  /** Whether that count is a provider option the manifest can set (`patch-style`). */
  candidatesEditable: boolean
  /** Declared assets `plan` would generate right now, with their offline estimate. */
  actionable: { keys: string[]; cost: number; costUnit: string }
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
  /** Replaced generations kept per asset (`PIXELKILN_HISTORY` or the manifest's `history`). */
  historyLimit: number
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

/** The replaced generations of an entry, with cache-backed thumbnails where the bytes remain. */
function describeHistory(media: Map<string, GalleryMedia>, entry: LockEntry, cacheDir: string): GalleryGeneration[] {
  return (entry.history ?? []).map((generation, i) => {
    const outputs = generation.outputs.map((output) => {
      const mediaType = output.mediaType ?? MediaType.PNG
      const file = path.join(cacheDir, cacheFileName(output.sha256, mediaType))
      let url: string | null = null
      if (existsSync(file)) {
        const id = galleryMediaId(file)
        media.set(id, { path: file, contentType: mediaType })
        url = `${galleryMediaRoute(id)}?v=${output.sha256.slice(0, 24)}`
      }
      return { role: output.role ?? null, sha256: output.sha256, path: output.path, url }
    })
    return {
      index: i + 1,
      objectId: generation.objectId,
      jobId: generation.jobId,
      prompt: generation.prompt,
      promptDiffers: generation.prompt !== entry.prompt,
      width: generation.width,
      height: generation.height,
      cost: generation.cost,
      costUnit: generation.costUnit,
      submittedAt: generation.submittedAt,
      downloadedAt: generation.downloadedAt,
      retiredAt: generation.retiredAt,
      outputs,
      cached: outputs.length > 0 && outputs.every((output) => output.url !== null),
      upstreamUrl: generation.provider === "pixellab" ? pixelLabObjectUrl(generation.generator, generation.objectId) : null,
    }
  })
}

/** Sprites are small; past this an edit is simply taken as changed rather than decoded. */
const MAX_COMPARED_BYTES = 8 * 1024 * 1024

/** Same dimensions and RGBA bytes, whatever the two encoders did with the PNG around them. */
async function samePixels(a: string, b: string): Promise<boolean> {
  try {
    const [left, right] = await Promise.all([readFile(a), readFile(b)])
    if (left.length > MAX_COMPARED_BYTES || right.length > MAX_COMPARED_BYTES) return false
    const x = decodePng(left)
    const y = decodePng(right)
    return x.width === y.width && x.height === y.height && x.pixels.equals(y.pixels)
  } catch {
    return false
  }
}

const metadataFps = (entry: LockEntry | undefined): number | null => (entry ? frameSetFps(entry) : null)

async function fileInfo(absolutePath: string): Promise<{ bytes: number; modifiedAt: string } | null> {
  try {
    const info = await stat(absolutePath)
    return info.isFile() ? { bytes: info.size, modifiedAt: info.mtime.toISOString() } : null
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
  const info = await fileInfo(absolutePath)
  const exists = info !== null
  const mediaType = recorded.mediaType ?? mediaTypeFromExtension(absolutePath)
  let url: string | null = null
  if (exists && mediaType) {
    const id = galleryMediaId(absolutePath)
    media.set(id, { path: absolutePath, contentType: mediaType })
    // The hash (or size and mtime) doubles as a cache-buster so a rewritten
    // file at the same path is not shown from the browser cache after Refresh.
    const version = recorded.sha256 ?? `${info.bytes}-${Date.parse(info.modifiedAt).toString(36)}`
    url = `${galleryMediaRoute(id)}?v=${version.slice(0, 24)}`
  }
  return {
    path: portableOutputPath(absolutePath, root),
    absolutePath,
    sha256: recorded.sha256 ?? null,
    role: recorded.role ?? null,
    mediaType,
    exists,
    bytes: info?.bytes ?? null,
    modifiedAt: info?.modifiedAt ?? null,
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
/** A replaced generation still recorded in the lockfile, as the record lists it. */
export interface GalleryGeneration {
  /** 1 is the most recently replaced. */
  index: number
  objectId: string | null
  jobId: string | null
  prompt: string
  /** The prompt differs from the current generation's. */
  promptDiffers: boolean
  width: number
  height: number
  cost: number
  costUnit: string
  submittedAt: string | null
  downloadedAt: string | null
  retiredAt: string
  /** Its files, with a thumbnail URL when the bytes are still in the local content cache. */
  outputs: Array<{ role: string | null; sha256: string; path: string; url: string | null }>
  /** Every output's bytes are cached locally; a restore needs no provider. */
  cached: boolean
  upstreamUrl: string | null
}

export interface GalleryEditMeta {
  editor: string
  savedAt: string
  /** sha256 of the generation the edit was based on (its first member for a set), or null for untracked art. */
  basedOn: string | null
  /** An edit file changed since the editor saved it (another tool touched it). */
  changedSince: boolean
  /** Manifest-relative path of the layered project file kept beside the edit, if present. */
  project: string | null
  /** Where the page fetches that file to hand it back to the editor; null without one. */
  projectUrl: string | null
}

type RawStyleShape = { extends?: unknown } & Record<string, unknown>

export async function buildGallerySnapshot(opts: BuildGalleryOptions): Promise<GalleryBuild> {
  const { loaded, specs, lock } = opts
  const root = loaded.root
  const media = new Map<string, GalleryMedia>()
  const plan = await buildPlan(specs, lock)
  const items: GalleryItem[] = []
  // One read of the manifest serves both the edit-drift hash and the raw
  // style shapes; the loader already proved the file parses.
  const manifestText = await readFile(loaded.path, "utf8")
  const manifestSha256 = sha256(manifestText)
  // Where fetch keeps every downloaded file by hash: a replaced generation's
  // thumbnail comes from here, and so does its restore when it is still there.
  const cacheDir = path.resolve(path.dirname(opts.lockPath), ".pixelkiln", "cache")
  let rawStyles: Record<string, RawStyleShape> = {}
  try {
    const raw = JSON.parse(manifestText) as { styles?: Record<string, RawStyleShape> }
    if (raw && typeof raw === "object" && raw.styles && typeof raw.styles === "object") rawStyles = raw.styles
  } catch {
    // Unreachable after loadManifest succeeded; the page simply sees no own fields.
  }

  for (const planItem of plan.items) {
    const { spec, key } = planItem
    const entry = lock.entries[key]
    const asset = loaded.manifest.assets[spec.assetId] ?? null

    let outputs: GalleryOutput[]
    let edit: GalleryOutput | null = null
    let edits: GalleryOutput[] = []
    let editChanged: boolean[] = []
    let editStatus: HandEditStatus | null = null
    let editMeta: GalleryEditMeta | null = null
    if (entry && entry.outputs.length) {
      outputs = await Promise.all(
        entry.outputs.map((output, index) =>
          describeOutput(media, root, currentEntryOutputPath(entry, spec, index), output),
        ),
      )
      if (spec.source) {
        const editPath = path.resolve(root, spec.source)
        // The source itself, or one file per output for a set's hand edit,
        // so status is judged member by member.
        const memberCount = sourceIsStem(spec.source, entry, root) ? entry.outputs.length : 1
        const editShas = await Promise.all(
          Array.from({ length: memberCount }, async (_, index) => {
            const file = sourceOutputPath(spec.source!, entry, index, root)
            return { file, sha256: existsSync(file) ? await sha256File(file) : null }
          }),
        )
        edits = await Promise.all(editShas.map(({ file, sha256: editSha }) => describeOutput(media, root, file, { sha256: editSha })))
        edit = edits[0] ?? null
        // A browser save records the generation each member started from by
        // hash, which survives clock skew and a restore; without it, file
        // times are the only evidence.
        const companion = await readHandEditCompanion(editPath)
        if (companion) {
          const projectPath = handEditProjectPath(editPath)
          const project = companion.project && existsSync(projectPath) ? await fileInfo(projectPath) : null
          let projectUrl: string | null = null
          if (project) {
            const id = galleryMediaId(projectPath)
            media.set(id, { path: projectPath, contentType: PROJECT_FILE_TYPE })
            projectUrl = `${galleryMediaRoute(id)}?v=${project.bytes}-${Date.parse(project.modifiedAt).toString(36)}`
          }
          editMeta = {
            editor: companion.editor,
            savedAt: companion.savedAt,
            basedOn: companion.outputs[0]?.basedOn ?? null,
            changedSince: editShas.some(({ sha256: editSha }, index) => {
              const recorded = companion.outputs[index]?.sha256
              return editSha !== null && recorded !== undefined && editSha !== recorded
            }),
            project: project ? portableOutputPath(projectPath, root) : null,
            projectUrl,
          }
        }
        const regenerated = edits.some((member, index) => {
          const generated = outputs[index]!
          if (companion) {
            const recorded = companion.outputs[index]
            return recorded !== undefined && generated.sha256 !== null && recorded.basedOn !== generated.sha256
          }
          return Boolean(generated.modifiedAt && member.modifiedAt && generated.modifiedAt > member.modifiedAt && generated.exists)
        })
        editChanged = await Promise.all(edits.map(async (member, index) => {
          const generated = outputs[index]!
          if (!member.exists || !generated.exists) return true
          if (member.sha256 === generated.sha256) return false
          return !(await samePixels(member.absolutePath, generated.absolutePath))
        }))
        editStatus = edits.some((member) => !member.exists)
          ? "missing"
          : editChanged.every((changed) => !changed)
            ? "same"
            : regenerated
              ? "regenerated-since"
              : "edited"
      }
    } else if (spec.source) {
      outputs = [await describeOutput(media, root, path.resolve(root, spec.source))]
    } else if (!entry && existsSync(spec.outFile)) {
      // Untracked: the art is on disk with no provenance. Showing it is the
      // point; it is exactly the file a careless regeneration would clobber.
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
      postprocess: entry?.postprocess ?? null,
      asset,
      source: spec.source ?? null,
      edit,
      edits,
      editChanged,
      editStatus,
      editMeta,
      upstreamUrl: entry?.provider === "pixellab" ? pixelLabObjectUrl(entry.generator, entry.objectId) : null,
      refreshable: Boolean(entry && entry.status === "downloaded" && entry.outputs.length && (entry.sourceUrls?.length || entry.sourceUrl)),
      history: entry ? describeHistory(media, entry, cacheDir) : [],
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
      postprocess: entry.postprocess ?? null,
      asset: null,
      source: null,
      edit: null,
      edits: [],
      editChanged: [],
      editStatus: null,
      editMeta: null,
      upstreamUrl: entry.provider === "pixellab" ? pixelLabObjectUrl(entry.generator, entry.objectId) : null,
      refreshable: false,
      history: describeHistory(media, entry, cacheDir),
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
      const counts = new Set(styleItems.filter((item) => item.declared && item.candidates !== null).map((item) => item.candidates))
      const provider = style
        ? style.provider ?? loaded.manifest.provider
        : styleItems[0]?.provider ?? loaded.manifest.provider
      const actionableItems = styleItems.filter((item) =>
        item.declared && (item.state === "missing" || item.state === "stale" || item.state === "failed"))
      const declaredItems = styleItems.filter((item) => item.declared)
      const rawStyle = Object.hasOwn(rawStyles, id) ? rawStyles[id] : undefined
      return {
        id,
        project: null,
        // A declared style inherits the manifest default; only a style the
        // manifest no longer has falls back to what its entries recorded.
        provider,
        generator: style?.generator ?? styleItems[0]?.generator ?? "map",
        outDir: style?.outDir ?? "",
        promptPrefix: style?.promptPrefix ?? "",
        promptSuffix: style?.promptSuffix ?? "",
        palette: style?.palette ?? [],
        enforcePalette: style?.enforcePalette ?? false,
        view: style?.view ?? null,
        noBackground: style?.noBackground ?? true,
        quality: Boolean(style?.quality),
        tags: style?.tags ?? [],
        extends: typeof rawStyle?.extends === "string" ? rawStyle.extends : null,
        ownFields: rawStyle ? Object.keys(rawStyle).filter((key) => key !== "extends") : [],
        items: styleItems.length,
        spendByUnit: spend,
        regenerate: {
          assets: declaredItems.length,
          cost: declaredItems.reduce((sum, item) => sum + (item.estimatedCost ?? 0), 0),
          costUnit: declaredItems[0]?.costUnit ?? styleItems[0]?.costUnit ?? "generations",
        },
        candidates: counts.size === 1 ? [...counts][0]! : null,
        candidatesEditable: Boolean(style) && Object.hasOwn(CANDIDATE_OPTION, provider),
        actionable: {
          keys: actionableItems.map((item) => item.key),
          cost: actionableItems.reduce((sum, item) => sum + (item.estimatedCost ?? 0), 0),
          costUnit: actionableItems[0]?.costUnit ?? styleItems[0]?.costUnit ?? "generations",
        },
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
      manifestSha256,
      historyLimit: historyLimit(loaded.manifest),
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
      let manifestSha256: string | null = null
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
        manifestSha256 = build.snapshot.project?.manifestSha256 ?? null
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
        manifestSha256: manifestSha256 ?? sha256(await readFile(manifestPath, "utf8")),
        historyLimit: historyLimit(loaded.manifest),
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
        historyLimit: 0,
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
