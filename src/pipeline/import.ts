import { existsSync } from "node:fs"
import { readFile } from "node:fs/promises"
import { sha256 } from "../hash.ts"
import { saveLock, upsert } from "../lock.ts"
import { portableOutputPath } from "../outputs.ts"
import { decodePng } from "../png.ts"
import { lockKey, type Lock, type LockEntry, type ResolvedSpec } from "../types.ts"

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
  opts: Pick<ImportOptions, "source" | "note" | "objectId"> = {},
  now: Date = new Date(),
): EntryPatch {
  const png = decodePng(bytes)
  const at = now.toISOString()
  return {
    styleId: spec.styleId,
    assetId: spec.assetId,
    specHash: spec.specHash,
    generator: spec.generator,
    prompt: spec.prompt,
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
    cost: 0,
    costUnit: spec.costUnit,
    provider: spec.provider,
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
    try {
      patch = buildImportedEntry(spec, await readFile(spec.outFile), opts)
    } catch (error) {
      skipped.push({ key, reason: `invalid PNG: ${error instanceof Error ? error.message : String(error)}` })
      continue
    }
    if (opts.dryRun) {
      imported.push({ key, entry: patch as LockEntry })
      continue
    }
    imported.push({ key, entry: upsert(lock, key, patch) })
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
