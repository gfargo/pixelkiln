import { existsSync } from "node:fs"
import path from "node:path"
import { OverwriteRefusedError } from "../errors.ts"
import { sha256File } from "../hash.ts"
import { saveLock, upsert } from "../lock.ts"
import { currentEntryOutputPath } from "../outputs.ts"
import type { Provider } from "../provider.ts"
import { DEFAULT_HISTORY_LIMIT, lockKey, type Lock, type LockEntry, type LockHistoryEntry, type Manifest, type ResolvedSpec } from "../types.ts"
import { fetchAssets } from "./fetch.ts"

/**
 * Regenerating an asset used to forget the generation it replaced the moment
 * the new bytes landed: the lockfile kept the new object, and the old one was
 * findable only by hand: in the content cache by hash, in git, or upstream
 * as an unclaimed object. A lock entry now keeps its replaced generations as
 * `history`, newest first, and a retired generation can be swapped back in
 * without spending: its bytes come from the content cache when they are
 * still there, otherwise from its durable provider reference.
 *
 * How many to keep is a personal default, `PIXELKILN_HISTORY` in the
 * environment (5 unless set), which a project's manifest `history` overrides
 * so a team can pin its own policy. 0 keeps nothing.
 */
export const HISTORY_ENV = "PIXELKILN_HISTORY"

export function historyLimit(manifest?: Pick<Manifest, "history">, env: NodeJS.ProcessEnv = process.env): number {
  if (manifest?.history !== undefined) return manifest.history
  const raw = env[HISTORY_ENV]?.trim()
  if (raw === undefined || raw === "") return DEFAULT_HISTORY_LIMIT
  const value = Number(raw)
  if (!Number.isInteger(value) || value < 0 || value > 100) {
    throw new Error(`${HISTORY_ENV} must be a whole number from 0 to 100, got "${raw}"`)
  }
  return value
}

/** The identity of a downloaded generation, as history keeps it. */
export function retireGeneration(entry: LockEntry, retiredAt: string): LockHistoryEntry {
  return {
    specHash: entry.specHash,
    generator: entry.generator,
    tileFeature: entry.tileFeature,
    prompt: entry.prompt,
    width: entry.width,
    height: entry.height,
    jobId: entry.jobId,
    objectId: entry.objectId,
    candidateIndex: entry.candidateIndex,
    sourceUrl: entry.sourceUrl,
    sourceUrls: entry.sourceUrls,
    outputs: entry.outputs,
    providerMetadata: entry.providerMetadata,
    submittedAt: entry.submittedAt,
    downloadedAt: entry.downloadedAt,
    cost: entry.cost,
    costUnit: entry.costUnit,
    billed: entry.billed,
    provider: entry.provider,
    postprocess: entry.postprocess,
    retiredAt,
  }
}

/**
 * The history a replacement entry should carry: the outgoing generation in
 * front of what the previous entry already kept, trimmed to the limit. Only a
 * downloaded generation is worth keeping; an entry that never finished has
 * no bytes to come back to.
 */
export function historyAfterReplacing(previous: LockEntry | undefined, limit: number, retiredAt: string): LockHistoryEntry[] | undefined {
  if (!previous) return undefined
  const kept = previous.history ?? []
  const outgoing = previous.status === "downloaded" && previous.outputs.length ? [retireGeneration(previous, retiredAt)] : []
  const history = [...outgoing, ...kept].slice(0, limit)
  return history.length ? history : undefined
}

/** Hashes every generation in the lockfile, current or retired, still refers to: outputs and the raw bytes behind them. */
export function referencedHashes(lock: Lock): Set<string> {
  const hashes = new Set<string>()
  const add = (output: { sha256: string; raw?: string }) => {
    hashes.add(output.sha256)
    // The provider's bytes behind a snapped output are what a changed
    // palette rule is re-applied to; pruning them would cost a download.
    if (output.raw) hashes.add(output.raw)
  }
  for (const entry of Object.values(lock.entries)) {
    for (const output of entry.outputs) add(output)
    for (const generation of entry.history ?? []) for (const output of generation.outputs) add(output)
  }
  return hashes
}

export interface HistoryPick {
  /** 1 is the most recently replaced generation. */
  index: number
  generation: LockHistoryEntry
}

/**
 * Find a retired generation by its 1-based position (newest first) or by a
 * prefix of any of its output hashes, which is how the gallery and a copied
 * `sha256` name it.
 */
export function pickHistory(entry: LockEntry, selector: string | number): HistoryPick {
  const history = entry.history ?? []
  if (!history.length) throw new Error(`${entry.styleId}/${entry.assetId} has no previous generations recorded`)
  if (typeof selector === "number" || /^\d{1,3}$/.test(selector)) {
    const index = Number(selector)
    const generation = history[index - 1]
    if (!generation) throw new Error(`${entry.styleId}/${entry.assetId} keeps ${history.length} previous generation(s); there is no #${index}`)
    return { index, generation }
  }
  const prefix = selector.toLowerCase()
  const matches = history
    .map((generation, i) => ({ index: i + 1, generation }))
    .filter(({ generation }) => generation.outputs.some((output) => output.sha256.startsWith(prefix)))
  if (matches.length !== 1) {
    throw new Error(
      matches.length
        ? `"${selector}" matches ${matches.length} previous generations of ${entry.styleId}/${entry.assetId}; give more of the hash`
        : `no previous generation of ${entry.styleId}/${entry.assetId} has an output hash starting with "${selector}"`,
    )
  }
  return matches[0]!
}

export interface RevertOptions {
  /** 1-based position (newest first) or an output hash prefix. */
  generation: string | number
  /** Replace an output file that no longer matches what PixelKiln wrote. */
  force?: boolean
  onProgress?: (msg: string) => void
  cacheDir?: string | false
}

export interface RevertResult {
  /** The generation now current. */
  restored: LockHistoryEntry
  /** Where it sat in history, 1 being the newest. */
  index: number
  /** Files written. */
  downloaded: number
}

/**
 * Make a retired generation current again. The current generation moves to
 * the front of history (so a revert can itself be reverted), the chosen one
 * becomes the entry, and its files are written back by the same fetch that
 * repairs missing output: cache first, provider reference second. The file
 * being replaced is PixelKiln's own, the outgoing generation's bytes, so
 * no `--force` is needed unless it was changed by hand since.
 */
export async function revertGeneration(
  provider: Provider,
  spec: ResolvedSpec,
  lock: Lock,
  lockPath: string,
  opts: RevertOptions,
): Promise<RevertResult> {
  const key = lockKey(spec.styleId, spec.assetId)
  const entry = lock.entries[key]
  if (!entry) throw new Error(`${key} is not in the lockfile`)
  if (entry.status !== "downloaded") {
    throw new Error(`${key} is ${entry.status}; finish or fetch the current generation before restoring an older one`)
  }
  const { index, generation } = pickHistory(entry, opts.generation)
  if (generation.provider !== provider.id) {
    throw new Error(`${key}'s previous generation #${index} came from ${generation.provider}, not ${provider.id}`)
  }
  // A hand-changed file is refused up front, before the lockfile moves.
  for (let i = 0; i < entry.outputs.length; i++) {
    const file = currentEntryOutputPath(entry, spec, i)
    if (!existsSync(file)) continue
    if ((await sha256File(file)) !== entry.outputs[i]!.sha256 && !opts.force) {
      throw new OverwriteRefusedError(
        `${path.relative(process.cwd(), file)} was changed after download; keep it with pixelkiln edit, or pass --force to replace it`,
        [file],
      )
    }
  }

  const now = new Date().toISOString()
  const remaining = (entry.history ?? []).filter((_, i) => i !== index - 1)
  const history = [retireGeneration(entry, now), ...remaining]
  upsert(lock, key, {
    specHash: generation.specHash,
    generator: generation.generator,
    tileFeature: generation.tileFeature,
    prompt: generation.prompt,
    width: generation.width,
    height: generation.height,
    jobId: generation.jobId,
    objectId: generation.objectId,
    candidateIndex: generation.candidateIndex,
    reviewObjectId: null,
    status: "downloaded",
    error: null,
    sourceUrl: generation.sourceUrl,
    sourceUrls: generation.sourceUrls,
    outputs: generation.outputs,
    // The files on disk are the outgoing generation's; that record authorizes
    // replacing them without --force, exactly as after a regeneration.
    supersededOutputs: entry.outputs,
    providerMetadata: generation.providerMetadata,
    submittedAt: generation.submittedAt,
    downloadedAt: generation.downloadedAt,
    cost: generation.cost,
    costUnit: generation.costUnit,
    billed: generation.billed,
    provider: generation.provider,
    postprocess: generation.postprocess,
    history,
  })
  await saveLock(lockPath, lock)

  const result = await fetchAssets(provider, [spec], lock, lockPath, {
    onProgress: opts.onProgress,
    repair: true,
    force: opts.force,
    cacheDir: opts.cacheDir,
  })
  if (result.failed) {
    throw new Error(`the previous generation's bytes could not be written back; run pixelkiln restore --only ${spec.assetId} --style ${spec.styleId} once the provider is reachable`)
  }
  return { restored: generation, index, downloaded: result.downloaded }
}
