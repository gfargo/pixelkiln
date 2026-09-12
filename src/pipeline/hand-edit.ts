import { spawn } from "node:child_process"
import { existsSync } from "node:fs"
import { copyFile, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises"
import path from "node:path"
import { z } from "zod"
import { sha256, sha256File } from "../hash.ts"
import type { LoadedManifest } from "../manifest.ts"
import { MediaType, validateMedia } from "../media.ts"
import { currentEntryOutputPath, portableOutputPath } from "../outputs.ts"
import { decodePng } from "../png.ts"
import { lockKey, primaryOutput, type Lock, type ResolvedSpec } from "../types.ts"
import { applyManifestEdit, ManifestEditError } from "../manifest-edit.ts"

/**
 * Hand edits never touch the generated file. The generated PNG is the
 * provenance record — its hash is in the lockfile, `plan` verifies it, and a
 * regeneration replaces it — so an author's touch-up lives in a sibling file
 * that the manifest points at with `source` (or `sourceByStyle`). `mount` and
 * `pack` place that file, quality profiles read it, and revisions start from
 * it, while `plan` keeps reporting the generation itself as `ok`.
 *
 * The author edits with whatever they already use: `PIXELKILN_EDITOR` names
 * the program, otherwise the file opens with the OS default.
 */
export const HAND_EDIT_DIR = "edits"

export interface HandEditStart {
  /** Absolute path of the file the author edits. */
  editPath: string
  /** Manifest-relative form recorded in the manifest. */
  source: string
  /** True when the file was created now as a copy of the generated art. */
  created: boolean
  /** True when the manifest was rewritten to point at it. */
  declared: boolean
  /** Manifest hash after the write, for a page that quotes it on the next edit. */
  manifestSha256: string
}

/** Where a hand edit of this spec lives: an `edits/` mirror under the style's outDir. */
export function handEditPath(loaded: LoadedManifest, spec: ResolvedSpec): string {
  const style = loaded.manifest.styles[spec.styleId]
  const outDir = path.resolve(loaded.root, style?.outDir ?? ".")
  const relative = path.relative(outDir, spec.outFile)
  const inside = relative && !relative.startsWith("..") && !path.isAbsolute(relative)
  const file = inside ? relative : path.basename(spec.outFile)
  return path.join(outDir, HAND_EDIT_DIR, file.replace(/\.gif$/i, ".png"))
}

/** The generated (or untracked) art a fresh edit starts from, if it is on disk. */
export function handEditBase(spec: ResolvedSpec, lock: Lock): string | null {
  const entry = lock.entries[lockKey(spec.styleId, spec.assetId)]
  if (entry) {
    if (entry.outputs.length !== 1) return null
    const primary = primaryOutput(entry)
    if (!primary || (primary.mediaType && primary.mediaType !== "image/png")) return null
    const file = currentEntryOutputPath(entry, spec, 0)
    return existsSync(file) ? file : null
  }
  return existsSync(spec.outFile) ? spec.outFile : null
}

/**
 * Make (or reuse) the edit file for one asset in one style and declare it in
 * the manifest. Idempotent: a second call finds the same file and changes
 * nothing, so "open my edit again" and "start editing" are one action.
 */
export async function startHandEdit(
  loaded: LoadedManifest,
  lock: Lock,
  spec: ResolvedSpec,
  opts: { expectedSha256?: string } = {},
): Promise<HandEditStart> {
  const entry = lock.entries[lockKey(spec.styleId, spec.assetId)]
  if (entry && entry.outputs.length > 1) {
    throw new ManifestEditError(
      `${spec.styleId}/${spec.assetId} has ${entry.outputs.length} outputs; hand edits currently cover single-image assets`,
    )
  }
  const existing = spec.source ? path.resolve(loaded.root, spec.source) : null
  const editPath = existing ?? handEditPath(loaded, spec)
  let created = false
  if (!existsSync(editPath)) {
    const base = handEditBase(spec, lock)
    if (!base) {
      throw new ManifestEditError(
        `${spec.styleId}/${spec.assetId} has no generated PNG on disk to start from; generate or restore it first`,
      )
    }
    await mkdir(path.dirname(editPath), { recursive: true })
    await copyFile(base, editPath)
    created = true
  }
  const source = portableOutputPath(editPath, loaded.root)
  let declared = false
  let manifestSha256 = opts.expectedSha256 ?? (await sha256File(loaded.path))
  if (spec.source !== source) {
    const result = await applyManifestEdit(loaded.path, {
      action: "set-source",
      assetId: spec.assetId,
      styleId: spec.styleId,
      source,
      expectedSha256: manifestSha256,
    })
    declared = result.changed
    manifestSha256 = result.sha256
  }
  return { editPath, source, created, declared, manifestSha256 }
}

/** Stop placing the edit. The file stays where it is; only the manifest changes. */
export async function detachHandEdit(
  loaded: LoadedManifest,
  spec: ResolvedSpec,
  opts: { expectedSha256?: string } = {},
): Promise<{ manifestSha256: string; changed: boolean }> {
  if (!spec.source) {
    return { manifestSha256: opts.expectedSha256 ?? (await sha256File(loaded.path)), changed: false }
  }
  const result = await applyManifestEdit(loaded.path, {
    action: "clear-source",
    assetId: spec.assetId,
    styleId: spec.styleId,
    expectedSha256: opts.expectedSha256 ?? (await sha256File(loaded.path)),
  })
  return { manifestSha256: result.sha256, changed: result.changed }
}

/**
 * What an in-browser save leaves beside the edit: which generation it was
 * based on (by hash, so a regeneration is detected however the clocks read),
 * which editor made it, and whether the layered project file is there too.
 * Written as `<edit>.edit.json`; a hand edit made in a desktop editor has none.
 */
export const HandEditCompanionSchema = z
  .object({
    version: z.literal(1),
    /** sha256 of the generated art the edit started from; null when it started from untracked art. */
    basedOn: z.string().regex(/^[0-9a-f]{64}$/).nullable(),
    /** sha256 of the edit PNG as saved, so a later change by another tool is visible. */
    sha256: z.string().regex(/^[0-9a-f]{64}$/),
    /** Editor identity the bridge reported, e.g. `pixelorama@v1.2.2-stable`. */
    editor: z.string().min(1),
    protocol: z.number().int().positive(),
    savedAt: z.string().datetime(),
    /** Basename of the layered project file beside the edit, when one was kept. */
    project: z.string().min(1).nullable(),
  })
  .strict()
export type HandEditCompanion = z.infer<typeof HandEditCompanionSchema>

export function handEditCompanionPath(editPath: string): string {
  return editPath.replace(/\.png$/i, "") + ".edit.json"
}

/** The layered project (Pixelorama `.pxo`) kept beside the edit for re-editing. */
export function handEditProjectPath(editPath: string): string {
  return editPath.replace(/\.png$/i, "") + ".pxo"
}

export async function readHandEditCompanion(editPath: string): Promise<HandEditCompanion | null> {
  let text: string
  try {
    text = await readFile(handEditCompanionPath(editPath), "utf8")
  } catch {
    return null
  }
  try {
    return HandEditCompanionSchema.parse(JSON.parse(text))
  } catch {
    return null
  }
}

/** Edits bigger than this are refused before decoding; a sprite sheet is far smaller. */
export const MAX_HAND_EDIT_BYTES = 16 * 1024 * 1024

export interface HandEditSaveInput {
  /** The flattened image, as PNG bytes. */
  png: Buffer
  /** The editor's own layered project file, kept beside the edit when given. */
  project?: Buffer
  editor: string
  protocol: number
  expectedSha256?: string
  now?: Date
}

export interface HandEditSave extends HandEditStart {
  sha256: string
  basedOn: string | null
  companionPath: string
  projectPath: string | null
}

/**
 * Save an edit made in the in-browser editor. The PNG must be a valid image
 * at the asset's generated size; it replaces the edit file atomically, the
 * companion records what it was based on, and the manifest declares the file
 * if it does not yet — the same path `startHandEdit` takes, so the first save
 * from the browser and `pixelkiln edit` leave the same manifest.
 */
export async function saveHandEdit(
  loaded: LoadedManifest,
  lock: Lock,
  spec: ResolvedSpec,
  input: HandEditSaveInput,
): Promise<HandEditSave> {
  if (input.png.length > MAX_HAND_EDIT_BYTES) {
    throw new ManifestEditError(`the edit is ${input.png.length} bytes; the limit is ${MAX_HAND_EDIT_BYTES}`)
  }
  if (input.project && input.project.length > MAX_HAND_EDIT_BYTES) {
    throw new ManifestEditError(`the project file is ${input.project.length} bytes; the limit is ${MAX_HAND_EDIT_BYTES}`)
  }
  let decoded: { width: number; height: number }
  try {
    validateMedia(input.png, MediaType.PNG)
    decoded = decodePng(input.png)
  } catch (error) {
    throw new ManifestEditError(`the edit is not a valid PNG: ${error instanceof Error ? error.message : String(error)}`)
  }
  const base = handEditBase(spec, lock)
  const expected = base ? decodePng(await readFile(base)) : { width: spec.width, height: spec.height }
  if (decoded.width !== expected.width || decoded.height !== expected.height) {
    throw new ManifestEditError(
      `the edit is ${decoded.width}×${decoded.height}; ${spec.styleId}/${spec.assetId} is ${expected.width}×${expected.height}`,
    )
  }
  const started = await startHandEdit(loaded, lock, spec, { expectedSha256: input.expectedSha256 })
  const entry = lock.entries[lockKey(spec.styleId, spec.assetId)]
  const basedOn = entry ? primaryOutput(entry)?.sha256 ?? null : null
  const digest = sha256(input.png)
  const projectPath = input.project ? handEditProjectPath(started.editPath) : null
  const companion: HandEditCompanion = {
    version: 1,
    basedOn,
    sha256: digest,
    editor: input.editor,
    protocol: input.protocol,
    savedAt: (input.now ?? new Date()).toISOString(),
    project: projectPath ? path.basename(projectPath) : null,
  }
  await replaceFile(started.editPath, input.png)
  if (projectPath && input.project) await replaceFile(projectPath, input.project)
  const companionPath = handEditCompanionPath(started.editPath)
  await replaceFile(companionPath, JSON.stringify(companion, null, 2) + "\n")
  return { ...started, sha256: digest, basedOn, companionPath, projectPath }
}

async function replaceFile(file: string, bytes: Buffer | string): Promise<void> {
  const tmp = `${file}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`
  try {
    await writeFile(tmp, bytes)
    await rename(tmp, file)
  } finally {
    await rm(tmp, { force: true })
  }
}

/**
 * Open a file in the author's editor. `PIXELKILN_EDITOR` may be a program
 * name or a command with arguments (`aseprite`, `"open -a Aseprite"`); the
 * file path is appended. Without it the OS default handler is used.
 */
export function openInEditor(file: string, editor = process.env.PIXELKILN_EDITOR): string {
  const command = editor?.trim()
    ? editor.trim().split(/\s+/)
    : process.platform === "darwin"
      ? ["open"]
      : process.platform === "win32"
        ? ["cmd", "/c", "start", ""]
        : ["xdg-open"]
  const [program, ...args] = command
  const child = spawn(program!, [...args, file], { stdio: "ignore", detached: true })
  child.on("error", () => {
    // A missing editor surfaces as nothing happening; the caller has already
    // printed the path, which is the useful part.
  })
  child.unref()
  return command.join(" ")
}
