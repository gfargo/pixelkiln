import { existsSync } from "node:fs"
import { readFile } from "node:fs/promises"
import path from "node:path"
import { sha256 } from "../hash.ts"
import { MediaType } from "../media.ts"
import { saveLock, upsert } from "../lock.ts"
import { portableOutputPath } from "../outputs.ts"
import { decodePng } from "../png.ts"
import { DEFAULT_HISTORY_LIMIT, lockKey, type Lock, type LockEntry, type LockOrigin, type ResolvedSpec } from "../types.ts"
import { cacheMedia } from "./fetch.ts"
import { historyAfterReplacing } from "./history.ts"

export interface ImportOptions {
  /** Where the art came from: "mcp", "hand", a tool name. Defaults to "external". */
  source?: string
  note?: string
  /** The provider's id for the object, when the art was made on the account by another route. */
  objectId?: string
  /** Replace an existing lock entry. Without it, an entry already in the lockfile is left alone. */
  force?: boolean
  /** Compute the entries without writing the lockfile. */
  dryRun?: boolean
  /** The tool call that made it, e.g. `create_image_pro_flash`. */
  tool?: string
  /** The prompt it was actually rolled with, when that differs from the manifest's. */
  prompt?: string
  seed?: number
  /** Credits spent making it, in the asset's cost unit. Counts toward recorded spend. */
  cost?: number
  /** What was done after generation, in order, as free text. Recorded, never run. */
  steps?: string[]
  /** The unprocessed original, so the plan can tell it from the processed file. */
  raw?: string
  /** Replaced generations to keep. Defaults to the built-in default. */
  historyLimit?: number
  /** Where bytes are cached so a replaced import can be restored; false skips it. */
  cacheDir?: string | false
}

export interface ImportedEntry {
  key: string
  entry: LockEntry
}

export interface ImportResult {
  imported: ImportedEntry[]
  skipped: { key: string; reason: string }[]
}

type EntryPatch = Partial<LockEntry>

/**
 * The lock entry that records an image already on disk as satisfying the spec.
 * Shared by `adopt --local` and `hash`, so what `hash` prints is exactly what
 * adopt would write. Like `adopt`, it pins the CURRENT spec hash: importing
 * declares that the file satisfies today's spec, so `plan` reports it ok.
 */
export function buildImportedEntry(
  spec: ResolvedSpec,
  bytes: Buffer,
  opts: Pick<ImportOptions, "source" | "note" | "objectId" | "tool" | "prompt" | "seed" | "cost" | "steps"> & {
    rawSha256?: string
  } = {},
  now: Date = new Date(),
): EntryPatch {
  const png = decodePng(bytes)
  const at = now.toISOString()
  const origin: LockOrigin = {
    ...(opts.tool ? { tool: opts.tool } : {}),
    ...(opts.prompt ? { prompt: opts.prompt } : {}),
    ...(opts.seed !== undefined ? { seed: opts.seed } : {}),
    ...(opts.steps?.length ? { steps: opts.steps } : {}),
    ...(opts.rawSha256 ? { raw: { sha256: opts.rawSha256 } } : {}),
  }
  return {
    styleId: spec.styleId,
    assetId: spec.assetId,
    specHash: spec.specHash,
    generator: spec.generator,
    prompt: opts.prompt ?? spec.prompt,
    width: png.width,
    height: png.height,
    jobId: opts.objectId ?? null,
    objectId: opts.objectId ?? null,
    reviewObjectId: null,
    candidateIndex: null,
    status: "downloaded",
    error: null,
    sourceUrl: null,
    sourceUrls: [],
    outputs: [{ path: portableOutputPath(spec.outFile, spec.root), sha256: sha256(bytes) }],
    submittedAt: null,
    downloadedAt: at,
    cost: opts.cost ?? 0,
    costUnit: spec.costUnit,
    provider: spec.provider,
    ...(Object.keys(origin).length ? { origin } : {}),
    ...(spec.external ? { external: { builder: spec.external.builder, inputs: spec.external.inputs } } : {}),
    imported: {
      source: opts.source ?? "external",
      ...(opts.note ? { note: opts.note } : {}),
      importedAt: at,
    },
  }
}

/** Why a spec cannot be recorded from its single PNG, or null when it can. */
function unimportable(spec: ResolvedSpec): string | null {
  if (spec.character) return "a character is several files; import it with account adopt"
  if (spec.vfx) return "an effect is rendered from its recipe, not imported"
  if (!spec.outFile.toLowerCase().endsWith(".png")) return "only a single PNG output can be imported"
  return null
}

/**
 * Records images already in the repo as lock entries without touching a
 * provider: no key, no network. Hashes each file the same way `gen` does.
 */
export async function importLocal(
  specs: ResolvedSpec[],
  lock: Lock,
  lockPath: string,
  opts: ImportOptions = {},
): Promise<ImportResult> {
  if (opts.objectId && specs.length !== 1) {
    throw new Error(`--object-id names one object; ${specs.length} assets are selected. Narrow with --only and --style.`)
  }
  const cacheDir = opts.cacheDir === false
    ? null
    : path.resolve(opts.cacheDir ?? path.join(path.dirname(lockPath), ".pixelkiln", "cache"))
  let rawSha256: string | undefined
  let rawBytes: Buffer | undefined
  if (opts.raw) {
    if (specs.length !== 1) throw new Error(`--raw names one original; ${specs.length} assets are selected. Narrow with --only and --style.`)
    try {
      rawBytes = await readFile(opts.raw)
      decodePng(rawBytes)
    } catch (error) {
      throw new Error(`--raw ${opts.raw} is not a readable PNG: ${error instanceof Error ? error.message : String(error)}`, { cause: error })
    }
    rawSha256 = sha256(rawBytes)
  }
  const imported: ImportedEntry[] = []
  const skipped: ImportResult["skipped"] = []
  for (const spec of specs) {
    const key = lockKey(spec.styleId, spec.assetId)
    const reason = unimportable(spec)
    if (reason) {
      skipped.push({ key, reason })
      continue
    }
    if (!existsSync(spec.outFile)) {
      skipped.push({ key, reason: `no file at ${spec.outFile}` })
      continue
    }
    if (lock.entries[key] && !opts.force) {
      skipped.push({ key, reason: "already in the lockfile (use --force to replace it)" })
      continue
    }
    let patch: EntryPatch
    let bytes: Buffer
    try {
      bytes = await readFile(spec.outFile)
      patch = buildImportedEntry(spec, bytes, { ...opts, rawSha256 }, new Date())
    } catch (error) {
      skipped.push({ key, reason: `invalid PNG: ${error instanceof Error ? error.message : String(error)}` })
      continue
    }
    if (opts.dryRun) {
      imported.push({ key, entry: patch as LockEntry })
      continue
    }
    // Replacing a recorded generation keeps it in history, and the bytes go
    // into the content cache so `restore --generation` can bring either one
    // back with no provider: an import has no object to download again.
    const existing = lock.entries[key]
    const history = existing?.outputs[0]?.sha256 === sha256(bytes)
      ? existing.history // the same bytes again is not a replacement
      : historyAfterReplacing(existing, opts.historyLimit ?? DEFAULT_HISTORY_LIMIT, patch.downloadedAt ?? new Date().toISOString())
    if (cacheDir) {
      await cacheMedia(cacheDir, bytes, MediaType.PNG)
      if (rawBytes) await cacheMedia(cacheDir, rawBytes, MediaType.PNG)
    }
    imported.push({ key, entry: upsert(lock, key, {
      ...patch,
      // An import replaces the whole record: clear what the entry held that
      // an import never has, or a regenerated entry would keep stale links.
      origin: patch.origin,
      history,
    }) })
  }
  if (!opts.dryRun && imported.length) await saveLock(lockPath, lock)
  return { imported, skipped }
}

export interface SpecHashReport {
  key: string
  specHash: string
  file: string
  /** SHA-256 of the file on disk, or null when it is missing or not a PNG. */
  fileSha256: string | null
  lock: { specHash: string; outputSha256: string | null; matches: boolean } | null
  /** What `adopt --local` would write for this asset, or null when it cannot be imported. */
  wouldImport: EntryPatch | null
}

/** Read-only: the spec hash, the file's hash, and the entry `adopt --local` would write. */
export async function reportSpecHashes(specs: ResolvedSpec[], lock: Lock): Promise<SpecHashReport[]> {
  const reports: SpecHashReport[] = []
  for (const spec of specs) {
    const key = lockKey(spec.styleId, spec.assetId)
    let bytes: Buffer | null = null
    if (existsSync(spec.outFile)) bytes = await readFile(spec.outFile)
    let wouldImport: EntryPatch | null = null
    if (bytes && !unimportable(spec)) {
      try {
        wouldImport = buildImportedEntry(spec, bytes)
      } catch {
        wouldImport = null
      }
    }
    const entry = lock.entries[key]
    const fileSha256 = bytes ? sha256(bytes) : null
    const outputSha256 = entry?.outputs[0]?.sha256 ?? null
    reports.push({
      key,
      specHash: spec.specHash,
      file: spec.outFile,
      fileSha256,
      lock: entry
        ? {
            specHash: entry.specHash,
            outputSha256,
            matches: entry.specHash === spec.specHash && outputSha256 !== null && outputSha256 === fileSha256,
          }
        : null,
      wouldImport,
    })
  }
  return reports
}
