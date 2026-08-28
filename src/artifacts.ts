import path from "node:path"
import { createHash, randomUUID } from "node:crypto"
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises"

export interface ArtifactFile {
  path: string
  data: string | Uint8Array
}

export interface ArtifactBundleResult {
  changed: string[]
  unchanged: string[]
}

export interface ArtifactBundleOptions {
  /** @internal Failure-injection hook used to verify staging cleanup. */
  beforeStage?: (destination: string, index: number) => void | Promise<void>
  /** @internal Failure-injection hook used to verify rollback behavior. */
  beforePromote?: (destination: string, index: number) => void | Promise<void>
  /** @internal Durable transaction journal used by the managed writer. */
  recoveryFile?: string
  /** @internal Failure-injection hook used to simulate a crash after commit. */
  afterCommit?: () => void | Promise<void>
}

export interface ManagedArtifactBundleOptions extends ArtifactBundleOptions {
  /** Explicitly replace unowned or manually modified destinations. */
  force?: boolean
}

export interface ArtifactSource {
  id: string
  path: string
  sha256: string | null
  included: boolean
}

export interface ArtifactProvenance {
  kind: "pack" | "mount" | "tileset"
  sources: ArtifactSource[]
  /** Every non-source input that can change the derived bytes. */
  options: unknown
}

export interface ArtifactBundleManifest {
  format: "pixelkiln-artifact-bundle"
  version: 1
  kind: ArtifactProvenance["kind"]
  fingerprint: string
  sources: ArtifactSource[]
  options: unknown
  outputs: Array<{ path: string; sha256: string }>
}

export interface ArtifactVerification {
  current: boolean
  fingerprintValid: boolean
  changedSources: string[]
  changedOutputs: string[]
}

interface PreparedArtifact {
  destination: string
  data: Buffer
  existed: boolean
  stage?: string
  backup?: string
  backedUp: boolean
  promoted: boolean
}

interface ArtifactTransaction {
  format: "pixelkiln-artifact-transaction"
  version: 1
  pid: number
  createdAt: string
  entries: Array<{
    destination: string
    stage: string
    backup?: string
    sha256: string
  }>
}

const activeTransactions = new Set<string>()

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function digest(data: string | Uint8Array): string {
  return createHash("sha256").update(data).digest("hex")
}

function portableRelative(from: string, to: string): string {
  return path.relative(from, path.resolve(to)).split(path.sep).join("/") || "."
}

function canonical(value: unknown): unknown {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("Artifact provenance numbers must be finite.")
    return value
  }
  if (Array.isArray(value)) return value.map(canonical)
  if (typeof value === "object") {
    const sorted: Record<string, unknown> = {}
    for (const key of Object.keys(value).sort()) {
      const item = (value as Record<string, unknown>)[key]
      if (item !== undefined) sorted[key] = canonical(item)
    }
    return sorted
  }
  throw new Error(`Artifact provenance cannot contain ${typeof value} values.`)
}

function fingerprint(provenance: Pick<ArtifactBundleManifest, "kind" | "sources" | "options" | "outputs">): string {
  return digest(JSON.stringify(canonical({
    kind: provenance.kind,
    sources: provenance.sources,
    options: provenance.options,
    outputs: provenance.outputs,
  })))
}

function parseArtifactManifest(absolute: string, data: string): ArtifactBundleManifest {
  let raw: Partial<ArtifactBundleManifest>
  try {
    raw = JSON.parse(data) as Partial<ArtifactBundleManifest>
  } catch (error) {
    throw new Error(`${absolute} is not valid JSON: ${message(error)}`, { cause: error })
  }
  if (
    raw.format !== "pixelkiln-artifact-bundle" ||
    raw.version !== 1 ||
    (raw.kind !== "pack" && raw.kind !== "mount" && raw.kind !== "tileset") ||
    typeof raw.fingerprint !== "string" ||
    raw.options === undefined ||
    !Array.isArray(raw.sources) ||
    !Array.isArray(raw.outputs)
  ) {
    throw new Error(`${absolute} is not a PixelKiln artifact bundle manifest.`)
  }
  for (const source of raw.sources) {
    if (
      !source ||
      typeof source.id !== "string" ||
      typeof source.path !== "string" ||
      (source.sha256 !== null && typeof source.sha256 !== "string") ||
      typeof source.included !== "boolean"
    ) {
      throw new Error(`${absolute} contains an invalid artifact source.`)
    }
  }
  for (const output of raw.outputs) {
    if (!output || typeof output.path !== "string" || typeof output.sha256 !== "string") {
      throw new Error(`${absolute} contains an invalid artifact output.`)
    }
  }
  return raw as ArtifactBundleManifest
}

async function readOptional(file: string): Promise<Buffer | null> {
  try {
    return await readFile(file)
  } catch (error) {
    if (isCode(error, "ENOENT")) return null
    throw error
  }
}

function transactionMarker(journal: string): string {
  return `${journal}.committed`
}

function processIsAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid < 1) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return !isCode(error, "ESRCH")
  }
}

function validTemporaryPath(
  candidate: string,
  destination: string,
  type: "stage" | "backup",
): boolean {
  return (
    path.dirname(candidate) === path.dirname(destination) &&
    path.basename(candidate).startsWith(
      `.${path.basename(destination)}.pixelkiln-${type}-`,
    )
  )
}

function parseTransaction(journal: string, data: string): ArtifactTransaction {
  let raw: Partial<ArtifactTransaction>
  try {
    raw = JSON.parse(data) as Partial<ArtifactTransaction>
  } catch (error) {
    throw new Error(`${journal} is not valid transaction JSON: ${message(error)}`, { cause: error })
  }
  if (
    raw.format !== "pixelkiln-artifact-transaction" ||
    raw.version !== 1 ||
    !Number.isInteger(raw.pid) ||
    typeof raw.createdAt !== "string" ||
    !Array.isArray(raw.entries) ||
    !raw.entries.length
  ) {
    throw new Error(`${journal} is not a PixelKiln artifact transaction.`)
  }
  return raw as ArtifactTransaction
}

async function removeTransactionFiles(journal: string): Promise<void> {
  // Journal first: a marker without a journal means the destinations were
  // already committed and cleanup may safely be considered complete.
  await rm(journal, { force: true })
  await rm(transactionMarker(journal), { force: true })
}

async function recoverArtifactTransaction(
  recoveryFile: string,
  allowedDestinations: Set<string>,
): Promise<void> {
  const journal = path.resolve(recoveryFile)
  const bytes = await readOptional(journal)
  if (!bytes) {
    await rm(transactionMarker(journal), { force: true })
    return
  }

  if (activeTransactions.has(journal)) {
    throw new Error(`Another artifact write in this process is already using ${journal}.`)
  }
  const transaction = parseTransaction(journal, bytes.toString("utf8"))
  if (transaction.pid !== process.pid && processIsAlive(transaction.pid)) {
    throw new Error(
      `Artifact transaction ${journal} is still owned by live process ${transaction.pid}; ` +
        `refusing concurrent recovery.`,
    )
  }

  for (const entry of transaction.entries) {
    if (
      typeof entry.destination !== "string" ||
      typeof entry.stage !== "string" ||
      typeof entry.sha256 !== "string" ||
      (entry.backup !== undefined && typeof entry.backup !== "string") ||
      !allowedDestinations.has(path.resolve(entry.destination)) ||
      !validTemporaryPath(entry.stage, entry.destination, "stage") ||
      (entry.backup !== undefined && !validTemporaryPath(entry.backup, entry.destination, "backup"))
    ) {
      throw new Error(
        `Refusing unsafe artifact recovery from ${journal}; its destinations or temporary ` +
          `paths do not match the current bundle.`,
      )
    }
  }

  const committed = (await readOptional(transactionMarker(journal))) !== null
  const errors: string[] = []
  if (committed) {
    for (const entry of transaction.entries) {
      if (entry.backup) await remove(entry.backup, errors)
      await remove(entry.stage, errors)
    }
  } else {
    for (const entry of [...transaction.entries].reverse()) {
      const backup = entry.backup ? await readOptional(entry.backup) : null
      const destination = await readOptional(entry.destination)
      if (backup) {
        if (destination && digest(destination) !== entry.sha256) {
          errors.push(
            `destination changed during interrupted recovery: ${entry.destination}; ` +
              `previous file remains at ${entry.backup}`,
          )
          continue
        }
        await remove(entry.destination, errors)
        try {
          await rename(entry.backup!, entry.destination)
        } catch (error) {
          errors.push(
            `could not restore ${entry.destination}; previous file remains at ` +
              `${entry.backup}: ${message(error)}`,
          )
        }
      } else if (destination && digest(destination) === entry.sha256) {
        await remove(entry.destination, errors)
      }
      await remove(entry.stage, errors)
    }
  }

  if (errors.length) {
    throw new Error(
      `Artifact transaction recovery needs attention; journal retained at ${journal}: ` +
        errors.join("; "),
    )
  }
  await removeTransactionFiles(journal)
}

/** Build the deterministic companion metadata written beside a derived bundle. */
export function createArtifactBundleManifest(
  manifestPath: string,
  outputs: ArtifactFile[],
  provenance: ArtifactProvenance,
): ArtifactBundleManifest {
  const root = path.dirname(path.resolve(manifestPath))
  const sources = provenance.sources.map((source) => ({
    ...source,
    path: portableRelative(root, source.path),
  }))
  const normalized = {
    kind: provenance.kind,
    sources,
    options: canonical(provenance.options),
  }
  const manifestOutputs = outputs.map((output) => ({
    path: portableRelative(root, output.path),
    sha256: digest(output.data),
  }))
  return {
    format: "pixelkiln-artifact-bundle",
    version: 1,
    ...normalized,
    fingerprint: fingerprint({ ...normalized, outputs: manifestOutputs }),
    outputs: manifestOutputs,
  }
}

/** Add deterministic provenance metadata to a related set of generated files. */
export function withArtifactManifest(
  manifestPath: string,
  outputs: ArtifactFile[],
  provenance: ArtifactProvenance,
): ArtifactFile[] {
  const manifest = createArtifactBundleManifest(manifestPath, outputs, provenance)
  return [
    ...outputs,
    { path: manifestPath, data: JSON.stringify(manifest, null, 2) + "\n" },
  ]
}

/**
 * Persist a generated bundle while protecting files not demonstrably owned by
 * its existing companion manifest. Byte-identical legacy files are adopted
 * without rewriting; `force` is required to take over anything else.
 */
export async function writeManagedArtifactBundle(
  manifestPath: string,
  outputs: ArtifactFile[],
  provenance: ArtifactProvenance,
  options: ManagedArtifactBundleOptions = {},
): Promise<ArtifactBundleResult> {
  const absoluteManifest = path.resolve(manifestPath)
  const recoveryFile = `${absoluteManifest}.transaction`
  const allowedDestinations = new Set([
    absoluteManifest,
    ...outputs.map((output) => path.resolve(output.path)),
  ])
  await recoverArtifactTransaction(recoveryFile, allowedDestinations)
  const existingManifestBytes = await readOptional(absoluteManifest)
  let previous: ArtifactBundleManifest | null = null

  if (existingManifestBytes && !options.force) {
    try {
      previous = parseArtifactManifest(absoluteManifest, existingManifestBytes.toString("utf8"))
      const valid = previous.fingerprint === fingerprint(previous)
      if (!valid) throw new Error("its integrity fingerprint does not match")
    } catch (error) {
      throw new Error(
        `Refusing to replace unrecognized or modified provenance at ${absoluteManifest}: ` +
          `${message(error)}. Pass { force: true } (CLI: --force) to take ownership ` +
          `of this artifact bundle.`,
        { cause: error },
      )
    }
  }

  if (!options.force) {
    const root = path.dirname(absoluteManifest)
    const recorded = new Map(
      previous?.outputs.map((output) => [path.resolve(root, output.path), output.sha256]) ?? [],
    )
    const conflicts: string[] = []
    for (const output of outputs) {
      const destination = path.resolve(output.path)
      const current = await readOptional(destination)
      if (!current || digest(current) === digest(output.data)) continue
      const expected = recorded.get(destination)
      if (!expected || digest(current) !== expected) conflicts.push(destination)
    }
    if (conflicts.length) {
      throw new Error(
        `Refusing to overwrite modified or unowned artifact file(s):\n` +
          conflicts.map((file) => `  ${file}`).join("\n") +
          `\nPass { force: true } (CLI: --force) to take ownership and replace ` +
          `the complete bundle.`,
      )
    }
  }

  const { force: _force, ...bundleOptions } = options
  return writeArtifactBundle(
    withArtifactManifest(absoluteManifest, outputs, provenance),
    { ...bundleOptions, recoveryFile },
  )
}

/** Verify stored provenance and source/output hashes without rebuilding output. */
export async function verifyArtifactBundle(manifestPath: string): Promise<ArtifactVerification> {
  const absolute = path.resolve(manifestPath)
  const raw = parseArtifactManifest(absolute, await readFile(absolute, "utf8"))

  const root = path.dirname(absolute)
  const changedSources: string[] = []
  const changedOutputs: string[] = []
  for (const source of raw.sources) {
    let actual: string | null = null
    try {
      actual = digest(await readFile(path.resolve(root, source.path)))
    } catch (error) {
      if (!isCode(error, "ENOENT")) throw error
    }
    if (actual !== source.sha256) changedSources.push(source.id)
  }
  for (const output of raw.outputs) {
    try {
      if (digest(await readFile(path.resolve(root, output.path))) !== output.sha256) {
        changedOutputs.push(output.path)
      }
    } catch (error) {
      if (!isCode(error, "ENOENT")) throw error
      changedOutputs.push(output.path)
    }
  }

  const fingerprintValid = raw.fingerprint === fingerprint({
    kind: raw.kind,
    sources: raw.sources,
    options: raw.options,
    outputs: raw.outputs,
  })
  return {
    current: fingerprintValid && !changedSources.length && !changedOutputs.length,
    fingerprintValid,
    changedSources,
    changedOutputs,
  }
}

function isCode(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === code
}

async function remove(file: string, errors?: string[]): Promise<void> {
  try {
    await rm(file, { force: true })
  } catch (error) {
    errors?.push(`could not remove ${file}: ${message(error)}`)
  }
}

async function rollback(prepared: PreparedArtifact[]): Promise<string[]> {
  const errors: string[] = []

  // Remove newly-promoted members before putting their previous versions back.
  for (const artifact of [...prepared].reverse()) {
    if (artifact.promoted) await remove(artifact.destination, errors)
  }

  for (const artifact of [...prepared].reverse()) {
    if (!artifact.backup || !artifact.backedUp) continue
    try {
      await rename(artifact.backup, artifact.destination)
      artifact.backedUp = false
    } catch (error) {
      errors.push(
        `could not restore ${artifact.destination}; previous file remains at ` +
          `${artifact.backup}: ${message(error)}`,
      )
    }
  }

  for (const artifact of prepared) {
    if (artifact.stage) await remove(artifact.stage, errors)
  }
  return errors
}

/**
 * Write a related set of generated files without leaving a partial bundle
 * after an ordinary write failure.
 *
 * All changed members are staged before any destination is replaced. If an
 * ordinary filesystem error interrupts promotion, prior files are restored.
 * Byte-identical members are not rewritten.
 */
export async function writeArtifactBundle(
  files: ArtifactFile[],
  options: ArtifactBundleOptions = {},
): Promise<ArtifactBundleResult> {
  if (!files.length) throw new Error("An artifact bundle must contain at least one file.")

  const normalized = files.map((file) => {
    if (!file.path.trim()) throw new Error("Artifact paths cannot be empty.")
    return { destination: path.resolve(file.path), data: Buffer.from(file.data) }
  })
  const destinations = new Set<string>()
  for (const artifact of normalized) {
    if (destinations.has(artifact.destination)) {
      throw new Error(`Artifact bundle contains duplicate destination: ${artifact.destination}`)
    }
    destinations.add(artifact.destination)
  }
  if (options.recoveryFile) {
    await recoverArtifactTransaction(options.recoveryFile, destinations)
  }

  const changed: PreparedArtifact[] = []
  const unchanged: string[] = []
  for (const artifact of normalized) {
    try {
      const current = await readFile(artifact.destination)
      if (current.equals(artifact.data)) {
        unchanged.push(artifact.destination)
      } else {
        changed.push({ ...artifact, existed: true, backedUp: false, promoted: false })
      }
    } catch (error) {
      if (!isCode(error, "ENOENT")) throw error
      changed.push({ ...artifact, existed: false, backedUp: false, promoted: false })
    }
  }

  if (!changed.length) return { changed: [], unchanged }

  const token = randomUUID()
  for (const [index, artifact] of changed.entries()) {
    const basename = path.basename(artifact.destination)
    artifact.stage = path.join(
      path.dirname(artifact.destination),
      `.${basename}.pixelkiln-stage-${token}-${index}`,
    )
    if (artifact.existed) {
      artifact.backup = path.join(
        path.dirname(artifact.destination),
        `.${basename}.pixelkiln-backup-${token}-${index}`,
      )
    }
  }

  const journal = options.recoveryFile ? path.resolve(options.recoveryFile) : null
  if (journal) {
    await mkdir(path.dirname(journal), { recursive: true })
    const transaction: ArtifactTransaction = {
      format: "pixelkiln-artifact-transaction",
      version: 1,
      pid: process.pid,
      createdAt: new Date().toISOString(),
      entries: changed.map((artifact) => ({
        destination: artifact.destination,
        stage: artifact.stage!,
        ...(artifact.backup ? { backup: artifact.backup } : {}),
        sha256: digest(artifact.data),
      })),
    }
    try {
      await writeFile(journal, JSON.stringify(transaction, null, 2) + "\n", { flag: "wx" })
      activeTransactions.add(journal)
    } catch (error) {
      throw new Error(
        `Could not start durable artifact transaction at ${journal}: ${message(error)}`,
        { cause: error },
      )
    }
  }

  try {
    for (const [index, artifact] of changed.entries()) {
      await mkdir(path.dirname(artifact.destination), { recursive: true })
      await options.beforeStage?.(artifact.destination, index)
      await writeFile(artifact.stage!, artifact.data, { flag: "wx" })
    }
  } catch (error) {
    const cleanupErrors = await rollback(changed)
    if (journal && !cleanupErrors.length) await removeTransactionFiles(journal)
    if (journal) activeTransactions.delete(journal)
    const suffix = cleanupErrors.length ? ` Cleanup also failed: ${cleanupErrors.join("; ")}` : ""
    throw new Error(`Could not stage artifact bundle: ${message(error)}.${suffix}`, { cause: error })
  }

  let durableCommit = false
  try {
    // Move every prior member aside first. Once promotion begins, rollback has
    // a complete snapshot even when several destinations are being replaced.
    for (const artifact of changed) {
      if (!artifact.existed) continue
      await rename(artifact.destination, artifact.backup!)
      artifact.backedUp = true
    }

    for (const [index, artifact] of changed.entries()) {
      await options.beforePromote?.(artifact.destination, index)
      await rename(artifact.stage!, artifact.destination)
      artifact.stage = undefined
      artifact.promoted = true
    }
    if (journal) {
      await writeFile(transactionMarker(journal), `${token}\n`, { flag: "wx" })
      durableCommit = true
      await options.afterCommit?.()
    }
  } catch (error) {
    if (durableCommit) {
      if (journal) activeTransactions.delete(journal)
      throw new Error(
        `Artifact bundle was committed, but final cleanup was interrupted: ${message(error)}. ` +
          `The next write will finish cleanup from ${journal}.`,
        { cause: error },
      )
    }
    const rollbackErrors = await rollback(changed)
    if (journal && !rollbackErrors.length) await removeTransactionFiles(journal)
    if (journal) activeTransactions.delete(journal)
    const suffix = rollbackErrors.length
      ? ` Rollback needs attention: ${rollbackErrors.join("; ")}`
      : " Previous bundle restored."
    throw new Error(`Could not promote artifact bundle: ${message(error)}.${suffix}`, { cause: error })
  }

  const cleanupErrors: string[] = []
  for (const artifact of changed) {
    if (artifact.backup) await remove(artifact.backup, cleanupErrors)
  }
  if (cleanupErrors.length) {
    if (journal) activeTransactions.delete(journal)
    throw new Error(
      `Artifact bundle was written, but old backup cleanup failed: ${cleanupErrors.join("; ")}`,
    )
  }
  if (journal) {
    try {
      await removeTransactionFiles(journal)
    } finally {
      activeTransactions.delete(journal)
    }
  }

  return {
    changed: changed.map((artifact) => artifact.destination),
    unchanged,
  }
}
