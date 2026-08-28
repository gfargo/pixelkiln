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
  promoted: boolean
}

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

/** Verify stored provenance and source/output hashes without rebuilding output. */
export async function verifyArtifactBundle(manifestPath: string): Promise<ArtifactVerification> {
  const absolute = path.resolve(manifestPath)
  const raw = JSON.parse(await readFile(absolute, "utf8")) as Partial<ArtifactBundleManifest>
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

  const root = path.dirname(absolute)
  const changedSources: string[] = []
  const changedOutputs: string[] = []
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
    let actual: string | null = null
    try {
      actual = digest(await readFile(path.resolve(root, source.path)))
    } catch (error) {
      if (!isCode(error, "ENOENT")) throw error
    }
    if (actual !== source.sha256) changedSources.push(source.id)
  }
  for (const output of raw.outputs) {
    if (!output || typeof output.path !== "string" || typeof output.sha256 !== "string") {
      throw new Error(`${absolute} contains an invalid artifact output.`)
    }
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
    if (!artifact.backup) continue
    try {
      await rename(artifact.backup, artifact.destination)
      artifact.backup = undefined
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

  const changed: PreparedArtifact[] = []
  const unchanged: string[] = []
  for (const artifact of normalized) {
    try {
      const current = await readFile(artifact.destination)
      if (current.equals(artifact.data)) {
        unchanged.push(artifact.destination)
      } else {
        changed.push({ ...artifact, existed: true, promoted: false })
      }
    } catch (error) {
      if (!isCode(error, "ENOENT")) throw error
      changed.push({ ...artifact, existed: false, promoted: false })
    }
  }

  if (!changed.length) return { changed: [], unchanged }

  const token = randomUUID()
  try {
    for (const [index, artifact] of changed.entries()) {
      await mkdir(path.dirname(artifact.destination), { recursive: true })
      const basename = path.basename(artifact.destination)
      artifact.stage = path.join(
        path.dirname(artifact.destination),
        `.${basename}.pixelkiln-stage-${token}-${index}`,
      )
      await options.beforeStage?.(artifact.destination, index)
      await writeFile(artifact.stage, artifact.data, { flag: "wx" })
    }
  } catch (error) {
    const cleanupErrors = await rollback(changed)
    const suffix = cleanupErrors.length ? ` Cleanup also failed: ${cleanupErrors.join("; ")}` : ""
    throw new Error(`Could not stage artifact bundle: ${message(error)}.${suffix}`, { cause: error })
  }

  try {
    // Move every prior member aside first. Once promotion begins, rollback has
    // a complete snapshot even when several destinations are being replaced.
    for (const [index, artifact] of changed.entries()) {
      if (!artifact.existed) continue
      const basename = path.basename(artifact.destination)
      const backup = path.join(
        path.dirname(artifact.destination),
        `.${basename}.pixelkiln-backup-${token}-${index}`,
      )
      await rename(artifact.destination, backup)
      artifact.backup = backup
    }

    for (const [index, artifact] of changed.entries()) {
      await options.beforePromote?.(artifact.destination, index)
      await rename(artifact.stage!, artifact.destination)
      artifact.stage = undefined
      artifact.promoted = true
    }
  } catch (error) {
    const rollbackErrors = await rollback(changed)
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
    throw new Error(
      `Artifact bundle was written, but old backup cleanup failed: ${cleanupErrors.join("; ")}`,
    )
  }

  return {
    changed: changed.map((artifact) => artifact.destination),
    unchanged,
  }
}
