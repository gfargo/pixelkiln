import { existsSync } from "node:fs"
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises"
import path from "node:path"
import { z } from "zod"
import type { JobState, Provider } from "../provider.ts"
import { sha256 } from "../hash.ts"
import { cacheFileName, detectMediaType, MediaType } from "../media.ts"
import { cacheMedia, readCachedMedia } from "../pipeline/fetch.ts"
import { isSensitiveSourceUrl } from "../source-url.ts"

/**
 * Local store for candidates waiting on the pick page.
 *
 * A provider job in review is not durable: PixelLab drops a finished
 * background job after an undocumented while, and then the candidates the
 * credits paid for are gone. So the moment a job reaches review, every
 * candidate's bytes go into the content-addressed cache that `fetch` and
 * `restore` already use (`.pixelkiln/cache/<sha256>.<ext>`), and a small JSON
 * file beside it records what each candidate is and where it came from. The
 * pick page serves frames from those files, and applying a choice needs only
 * them.
 *
 * The same file holds the review state (which assets wait, which candidate
 * was chosen), so a pick page can survive a restart.
 */

export const REVIEW_STATE_VERSION = 1

const CandidateSchema = z.object({
  index: z.number().int().nonnegative(),
  /** Frame role for a frame set (`frame-00`, ...); absent for candidates. */
  role: z.string().optional(),
  /**
   * Where the provider served the bytes. Null when the URL carried a
   * credential or signature, which never settles on disk.
   */
  sourceUrl: z.string().nullable(),
  /** sha256 of the cached bytes; null until the download succeeds. */
  sha256: z.string().nullable(),
  mediaType: z.string().nullable(),
  cachedAt: z.string().nullable(),
})

const ReviewAssetSchema = z.object({
  provider: z.string(),
  /** The provider job the candidates came from (the lock's `reviewObjectId`). */
  jobId: z.string(),
  generator: z.string().optional(),
  mode: z.enum(["candidates", "frame-set"]),
  /** Frame-set playback rate. */
  fps: z.number().optional(),
  /** Frame-set object id the provider reported. */
  objectId: z.string().optional(),
  candidates: z.array(CandidateSchema),
  /** "pending" while waiting on a choice, "applied" once one was committed. */
  status: z.enum(["pending", "applied"]),
  /** The chosen candidate index, or null while nothing is chosen. */
  chosen: z.number().int().nonnegative().nullable(),
  /** Frames (or candidates) the reviewer flagged as bad on the pick page. */
  flagged: z.array(z.number().int().nonnegative()).optional(),
  /** Set aside on the pick page to decide later. */
  later: z.boolean().optional(),
  updatedAt: z.string(),
})

export const ReviewStateSchema = z.object({
  version: z.literal(REVIEW_STATE_VERSION),
  /** Keyed by lock key (`<style>/<asset>`). */
  assets: z.record(ReviewAssetSchema),
})

export type ReviewCandidate = z.infer<typeof CandidateSchema>
export type ReviewAsset = z.infer<typeof ReviewAssetSchema>
export type ReviewState = z.infer<typeof ReviewStateSchema>

/** The content cache `fetch` and `restore` read, beside the lockfile. */
export function candidateCacheDirFor(lockPath: string): string {
  return path.resolve(path.dirname(lockPath), ".pixelkiln", "cache")
}

/** The review-state file, beside the cache directory. */
export function reviewStatePathFor(lockPath: string): string {
  const base = path.basename(lockPath)
  const name = base === "pixelkiln.lock.json" ? "review-state.json" : `${base.replace(/\.json$/, "")}.review-state.json`
  return path.resolve(path.dirname(lockPath), ".pixelkiln", name)
}

export async function loadReviewState(file: string): Promise<ReviewState> {
  if (!existsSync(file)) return { version: REVIEW_STATE_VERSION, assets: {} }
  try {
    const parsed = ReviewStateSchema.safeParse(JSON.parse(await readFile(file, "utf8")))
    if (parsed.success) return parsed.data
  } catch {
    // Fall through: a corrupt state file is rebuilt, never fatal.
  }
  return { version: REVIEW_STATE_VERSION, assets: {} }
}

export async function saveReviewState(file: string, state: ReviewState): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true })
  const tmp = `${file}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`
  try {
    await writeFile(tmp, JSON.stringify(state, null, 2) + "\n")
    await rename(tmp, file)
  } finally {
    await rm(tmp, { force: true })
  }
}

/** Read-modify-write one asset's record. Returns the updated record, or null when absent. */
export async function updateReviewAsset(
  file: string,
  key: string,
  change: (asset: ReviewAsset) => ReviewAsset,
): Promise<ReviewAsset | null> {
  const state = await loadReviewState(file)
  const asset = state.assets[key]
  if (!asset) return null
  const next = { ...change(asset), updatedAt: new Date().toISOString() }
  state.assets[key] = next
  await saveReviewState(file, state)
  return next
}

/** Record a choice without committing it, so a reopened page can show it. */
export async function setChosen(file: string, key: string, index: number | null): Promise<ReviewAsset | null> {
  return updateReviewAsset(file, key, (asset) => ({ ...asset, chosen: index }))
}

/** Absolute path of a cached candidate, or null when its bytes are not cached. */
export function cachedCandidatePath(cacheDir: string, candidate: ReviewCandidate): string | null {
  if (!candidate.sha256 || !candidate.mediaType) return null
  const file = path.join(cacheDir, cacheFileName(candidate.sha256, candidate.mediaType as MediaType))
  return existsSync(file) ? file : null
}

/** True when every candidate of the asset has its bytes in the cache. */
export function fullyCached(cacheDir: string, asset: ReviewAsset): boolean {
  return asset.candidates.length > 0 && asset.candidates.every((c) => cachedCandidatePath(cacheDir, c))
}

function storableUrl(url: string): string | null {
  return isSensitiveSourceUrl(url) ? null : url
}

/** Download one candidate into the cache. Throws a clear error when the provider no longer has it. */
async function downloadCandidate(
  provider: Provider,
  cacheDir: string,
  url: string,
  label: string,
): Promise<{ sha256: string; mediaType: string }> {
  let bytes: Buffer
  try {
    bytes = await provider.download(url)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    throw new Error(`${label} could not be downloaded (${message}); the provider has likely expired it`)
  }
  const mediaType = detectMediaType(bytes) ?? MediaType.PNG
  const hash = sha256(bytes)
  await cacheMedia(cacheDir, bytes, mediaType, hash)
  return { sha256: hash, mediaType }
}

export interface CacheCandidatesOptions {
  cacheDir: string
  statePath: string
  generator?: string
}

/**
 * Record a job that just reached review and download every candidate's
 * bytes into the cache. Candidates already cached are left alone, so this is
 * cheap to call again. A download failure leaves that candidate uncached and
 * is reported in `failed`; the record still keeps its source URL so a later
 * `ensureCandidatesCached` can retry.
 */
export async function cacheReviewCandidates(
  provider: Provider,
  key: string,
  jobId: string,
  job: Extract<JobState, { status: "review" | "review-set" }>,
  opts: CacheCandidatesOptions,
): Promise<{ asset: ReviewAsset; failed: string[] }> {
  const state = await loadReviewState(opts.statePath)
  const previous = state.assets[key]?.jobId === jobId ? state.assets[key] : undefined
  const sources =
    job.status === "review"
      ? job.candidateUrls.map((url) => ({ url, role: undefined as string | undefined }))
      : job.sources.map((source) => ({ url: source.url, role: source.role }))
  const failed: string[] = []
  const candidates: ReviewCandidate[] = []
  for (const [index, source] of sources.entries()) {
    // A batch shares one job across its members; whichever member was
    // recorded first already holds the bytes.
    const known = [previous, ...Object.values(state.assets).filter((a) => a.jobId === jobId && a.provider === provider.id)]
      .map((asset) => asset?.candidates[index])
      .find((candidate) => candidate && candidate.sourceUrl === storableUrl(source.url) && cachedCandidatePath(opts.cacheDir, candidate))
    if (known) {
      candidates.push(known)
      continue
    }
    try {
      const cached = await downloadCandidate(provider, opts.cacheDir, source.url, `${key} candidate ${index + 1}`)
      candidates.push({
        index,
        ...(source.role ? { role: source.role } : {}),
        sourceUrl: storableUrl(source.url),
        ...cached,
        cachedAt: new Date().toISOString(),
      })
    } catch (err) {
      failed.push(err instanceof Error ? err.message : String(err))
      candidates.push({
        index,
        ...(source.role ? { role: source.role } : {}),
        sourceUrl: storableUrl(source.url),
        sha256: null,
        mediaType: null,
        cachedAt: null,
      })
    }
  }
  const asset: ReviewAsset = {
    provider: provider.id,
    jobId,
    ...(opts.generator ? { generator: opts.generator } : {}),
    mode: job.status === "review" ? "candidates" : "frame-set",
    ...(job.status === "review-set" ? { fps: job.fps, objectId: job.objectId } : {}),
    candidates,
    status: "pending",
    chosen: previous?.chosen ?? null,
    ...(previous?.flagged?.length ? { flagged: previous.flagged } : {}),
    ...(previous?.later ? { later: true } : {}),
    updatedAt: new Date().toISOString(),
  }
  // Reload before writing: another asset may have been recorded meanwhile.
  const latest = await loadReviewState(opts.statePath)
  latest.assets[key] = asset
  await saveReviewState(opts.statePath, latest)
  return { asset, failed }
}

/**
 * The recovery path for an asset recorded but not fully cached: re-download
 * each missing candidate from its recorded source URL. Throws one clear
 * message naming the asset when the provider has already expired it.
 */
export async function ensureCandidatesCached(
  provider: Provider,
  key: string,
  opts: { cacheDir: string; statePath: string },
): Promise<ReviewAsset> {
  const state = await loadReviewState(opts.statePath)
  const asset = state.assets[key]
  if (!asset) throw new Error(`${key} has no recorded candidates to recover`)
  const missing: string[] = []
  const candidates: ReviewCandidate[] = []
  for (const candidate of asset.candidates) {
    if (cachedCandidatePath(opts.cacheDir, candidate)) {
      candidates.push(candidate)
      continue
    }
    if (!candidate.sourceUrl) {
      missing.push(`candidate ${candidate.index + 1} has no stored source URL`)
      candidates.push(candidate)
      continue
    }
    try {
      const cached = await downloadCandidate(provider, opts.cacheDir, candidate.sourceUrl, `candidate ${candidate.index + 1}`)
      candidates.push({ ...candidate, ...cached, cachedAt: new Date().toISOString() })
    } catch (err) {
      missing.push(err instanceof Error ? err.message : String(err))
      candidates.push(candidate)
    }
  }
  const next = { ...asset, candidates, updatedAt: new Date().toISOString() }
  const latest = await loadReviewState(opts.statePath)
  latest.assets[key] = next
  await saveReviewState(opts.statePath, latest)
  if (missing.length) {
    throw new Error(
      `${key}: job ${asset.jobId} expired on the provider before every candidate was cached ` +
        `(${missing.join("; ")}); re-run gen for this asset`,
    )
  }
  return next
}

/** Bytes of a cached candidate, verified against its hash. */
export async function readCachedCandidate(cacheDir: string, candidate: ReviewCandidate): Promise<Buffer | null> {
  if (!candidate.sha256 || !candidate.mediaType) return null
  return readCachedMedia(cacheDir, candidate.sha256, candidate.mediaType as MediaType)
}
