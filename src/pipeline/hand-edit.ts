import { existsSync } from "node:fs"
import { copyFile, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises"
import path from "node:path"
import { z } from "zod"
import { sha256, sha256File } from "../hash.ts"
import type { LoadedManifest } from "../manifest.ts"
import { MediaType, validateMedia } from "../media.ts"
import { defaultOpenCommand, openExternal } from "../open.ts"
import { currentEntryOutputPath, isMemberSetEntry, memberPath, portableOutputPath, sourceIsStem } from "../outputs.ts"
import { decodePng } from "../png.ts"
import { lockKey, primaryOutput, type Lock, type LockEntry, type ResolvedSpec } from "../types.ts"
import { applyManifestEdit, ManifestEditError } from "../manifest-edit.ts"

/**
 * Hand edits never touch the generated file. The generated PNG is the
 * provenance record — its hash is in the lockfile, `plan` verifies it, and a
 * regeneration replaces it — so an author's touch-up lives in a sibling file
 * that the manifest points at with `source` (or `sourceByStyle`). `mount` and
 * `pack` place that file, quality profiles read it, and revisions start from
 * it, while `plan` keeps reporting the generation itself as `ok`.
 *
 * A set — an ordered frame set, a tile set, any entry with several PNG
 * outputs — is edited the same way, one file per member: the manifest's
 * `source` names the stem, and each member is `<stem>-<role>.png` beside it,
 * the rule its generated outputs already follow.
 *
 * The author edits with whatever they already use: `PIXELKILN_EDITOR` names
 * the program, otherwise the file opens with the OS default.
 */
export const HAND_EDIT_DIR = "edits"

/** One file of a hand edit: the whole edit for a single image, one frame of a set. */
export interface HandEditMember {
  /** Output role for a set member; null for a single image. */
  role: string | null
  /** Absolute path of the file the author edits. */
  path: string
  /** The generated file it starts from, when on disk. */
  base: string | null
}

export interface HandEditStart {
  /** Absolute path of the file the author edits; the stem for a frame set. */
  editPath: string
  /** Every file of the edit, in output order. One entry for a single image. */
  members: HandEditMember[]
  /** Manifest-relative form recorded in the manifest. */
  source: string
  /** True when any file was created now as a copy of the generated art. */
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

/**
 * The generated (or untracked) art a fresh edit starts from, per member.
 * Null when the asset is not something a hand edit covers: a GIF, a set with
 * a GIF in it, or nothing on disk to copy.
 */
export function handEditBases(spec: ResolvedSpec, lock: Lock): Array<{ role: string | null; path: string }> | null {
  const entry = lock.entries[lockKey(spec.styleId, spec.assetId)]
  if (entry) {
    if (entry.outputs.length !== 1 && !isMemberSetEntry(entry)) return null
    const members = entry.outputs.map((output, index) => ({
      role: entry.outputs.length === 1 ? null : output.role ?? null,
      path: currentEntryOutputPath(entry, spec, index),
      mediaType: output.mediaType,
    }))
    if (members.some((member) => member.mediaType && member.mediaType !== "image/png")) return null
    if (entry.outputs.length === 1 && !primaryOutput(entry)) return null
    if (!members.every((member) => existsSync(member.path))) return null
    return members.map(({ role, path: file }) => ({ role, path: file }))
  }
  return existsSync(spec.outFile) ? [{ role: null, path: spec.outFile }] : null
}

/** The generated (or untracked) art a fresh single-image edit starts from, if it is on disk. */
export function handEditBase(spec: ResolvedSpec, lock: Lock): string | null {
  const bases = handEditBases(spec, lock)
  return bases && bases.length === 1 ? bases[0]!.path : null
}

/** The files a declared `source` stands for, in output order; the source itself for a single image. */
export function handEditMembers(loaded: LoadedManifest, spec: ResolvedSpec, lock: Lock, editPath: string): HandEditMember[] {
  const entry = lock.entries[lockKey(spec.styleId, spec.assetId)]
  const bases = handEditBases(spec, lock)
  if (entry && isMemberSetEntry(entry)) {
    return entry.outputs.map((output, index) => ({
      role: output.role ?? null,
      path: memberPath(editPath, output.role, index, entry.outputs.length, output.mediaType),
      base: bases?.[index]?.path ?? null,
    }))
  }
  return [{ role: null, path: editPath, base: bases?.[0]?.path ?? null }]
}

/**
 * Make (or reuse) the edit file for one asset in one style and declare it in
 * the manifest. Idempotent: a second call finds the same file and changes
 * nothing, so "open my edit again" and "start editing" are one action. A
 * set gets one file per member; a member already there is kept.
 */
export async function startHandEdit(
  loaded: LoadedManifest,
  lock: Lock,
  spec: ResolvedSpec,
  opts: { expectedSha256?: string } = {},
): Promise<HandEditStart> {
  const entry = lock.entries[lockKey(spec.styleId, spec.assetId)]
  if (entry && entry.outputs.length > 1 && !isMemberSetEntry(entry)) {
    throw new ManifestEditError(
      `${spec.styleId}/${spec.assetId} is a set of ${entry.outputs.length} outputs that are not all PNG; hand edits cover PNG images and sets of them`,
    )
  }
  if (entry && spec.source && isMemberSetEntry(entry) && !sourceIsStem(spec.source, entry, loaded.root)) {
    throw new ManifestEditError(
      `${spec.styleId}/${spec.assetId} declares ${spec.source}, one committed file placed for the whole set; ` +
        "clear that source (pixelkiln edit detach) to hand-edit the members one by one",
    )
  }
  const existing = spec.source ? path.resolve(loaded.root, spec.source) : null
  const editPath = existing ?? handEditPath(loaded, spec)
  const members = handEditMembers(loaded, spec, lock, editPath)
  let created = false
  for (const member of members) {
    if (existsSync(member.path)) continue
    if (!member.base) {
      throw new ManifestEditError(
        `${spec.styleId}/${spec.assetId} has no generated PNG on disk to start from; generate or restore it first`,
      )
    }
    await mkdir(path.dirname(member.path), { recursive: true })
    await copyFile(member.base, member.path)
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
  return { editPath, members, source, created, declared, manifestSha256 }
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
 * What an in-browser save leaves beside the edit: which generation each file
 * was based on (by hash, so a regeneration is detected however the clocks
 * read), which editor made it, and whether the layered project file is there
 * too. Written as `<edit>.edit.json` beside the edit (the stem, for a frame
 * set); a hand edit made in a desktop editor has none.
 */
const CompanionOutputSchema = z
  .object({
    /** Output role for a set member; null for a single image. */
    role: z.string().nullable(),
    /** sha256 of the generated file this member started from; null when it started from untracked art. */
    basedOn: z.string().regex(/^[0-9a-f]{64}$/).nullable(),
    /** sha256 of the member as saved, so a later change by another tool is visible. */
    sha256: z.string().regex(/^[0-9a-f]{64}$/),
  })
  .strict()

const CompanionV2Schema = z
  .object({
    version: z.literal(2),
    /** Editor identity the bridge reported, e.g. `pixelorama@v1.2.2-stable`. */
    editor: z.string().min(1),
    protocol: z.number().int().positive(),
    savedAt: z.string().datetime(),
    /** Basename of the layered project file beside the edit, when one was kept. */
    project: z.string().min(1).nullable(),
    /** One entry per file, in output order. */
    outputs: z.array(CompanionOutputSchema).min(1),
  })
  .strict()

/** The first shape, one image only; read and upgraded, never written. */
const CompanionV1Schema = z
  .object({
    version: z.literal(1),
    basedOn: z.string().regex(/^[0-9a-f]{64}$/).nullable(),
    sha256: z.string().regex(/^[0-9a-f]{64}$/),
    editor: z.string().min(1),
    protocol: z.number().int().positive(),
    savedAt: z.string().datetime(),
    project: z.string().min(1).nullable(),
  })
  .strict()

export const HandEditCompanionSchema = z.union([CompanionV2Schema, CompanionV1Schema]).transform((value): HandEditCompanion =>
  value.version === 2
    ? value
    : {
        version: 2,
        editor: value.editor,
        protocol: value.protocol,
        savedAt: value.savedAt,
        project: value.project,
        outputs: [{ role: null, basedOn: value.basedOn, sha256: value.sha256 }],
      },
)
export type HandEditCompanion = z.infer<typeof CompanionV2Schema>

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
  /** The flattened image, as PNG bytes. For a frame set, use `frames`. */
  png?: Buffer
  /** Every frame of a set, tagged with the role it was opened under (null for one added in the editor). */
  frames?: Array<{ role: string | null; png: Buffer }>
  /** The editor's own layered project file, kept beside the edit when given. */
  project?: Buffer
  editor: string
  protocol: number
  expectedSha256?: string
  now?: Date
}

export interface HandEditSave extends HandEditStart {
  /** sha256 of the edit as saved; of the first member for a frame set. */
  sha256: string
  /** Hash of the generation the edit started from; of the first member for a frame set. */
  basedOn: string | null
  companion: HandEditCompanion
  companionPath: string
  projectPath: string | null
}

/**
 * Save an edit made in the in-browser editor. Every PNG must be a valid
 * image at the asset's generated size, a set must come back with the same
 * members it was opened with, and the files replace the edit
 * atomically; the companion records what each was based on, and the
 * manifest declares the edit if it does not yet — the same path
 * `startHandEdit` takes, so the first save from the browser and
 * `pixelkiln edit` leave the same manifest.
 */
export async function saveHandEdit(
  loaded: LoadedManifest,
  lock: Lock,
  spec: ResolvedSpec,
  input: HandEditSaveInput,
): Promise<HandEditSave> {
  const entry = lock.entries[lockKey(spec.styleId, spec.assetId)]
  const memberSet = entry ? isMemberSetEntry(entry) : false
  const incoming = input.frames ?? (input.png ? [{ role: null, png: input.png }] : [])
  if (!incoming.length) throw new ManifestEditError("the save carried no image")
  if (input.project && input.project.length > MAX_HAND_EDIT_BYTES) {
    throw new ManifestEditError(`the project file is ${input.project.length} bytes; the limit is ${MAX_HAND_EDIT_BYTES}`)
  }
  if (memberSet) {
    const expected = entry!.outputs.map((output) => output.role ?? null)
    const got = incoming.map((frame) => frame.role)
    if (got.length !== expected.length || expected.some((role, index) => got[index] !== role)) {
      throw new ManifestEditError(
        `${spec.styleId}/${spec.assetId} is a set of ${expected.length} members (${expected.join(", ")}); ` +
          `the editor returned ${got.length} (${got.map((role) => role ?? "new").join(", ")}) — keep the frames it opened with`,
      )
    }
  } else if (incoming.length !== 1) {
    throw new ManifestEditError(`${spec.styleId}/${spec.assetId} is one image; the editor returned ${incoming.length} frames — keep a single frame`)
  }
  const decoded = incoming.map((frame, index) => {
    if (frame.png.length > MAX_HAND_EDIT_BYTES) {
      throw new ManifestEditError(`the edit is ${frame.png.length} bytes; the limit is ${MAX_HAND_EDIT_BYTES}`)
    }
    try {
      validateMedia(frame.png, MediaType.PNG)
      return decodePng(frame.png)
    } catch (error) {
      const which = memberSet ? `member ${frame.role ?? index}` : "the edit"
      throw new ManifestEditError(`${which} is not a valid PNG: ${error instanceof Error ? error.message : String(error)}`)
    }
  })
  const bases = handEditBases(spec, lock)
  const expectedSize = bases?.[0] ? decodePng(await readFile(bases[0].path)) : { width: spec.width, height: spec.height }
  for (const [index, image] of decoded.entries()) {
    if (image.width !== expectedSize.width || image.height !== expectedSize.height) {
      const which = memberSet ? `member ${incoming[index]!.role ?? index}` : "the edit"
      throw new ManifestEditError(
        `${which} is ${image.width}×${image.height}; ${spec.styleId}/${spec.assetId} is ${expectedSize.width}×${expectedSize.height}`,
      )
    }
  }

  const started = await startHandEdit(loaded, lock, spec, { expectedSha256: input.expectedSha256 })
  const projectPath = input.project ? handEditProjectPath(started.editPath) : null
  const companion: HandEditCompanion = {
    version: 2,
    editor: input.editor,
    protocol: input.protocol,
    savedAt: (input.now ?? new Date()).toISOString(),
    project: projectPath ? path.basename(projectPath) : null,
    outputs: incoming.map((frame, index) => ({
      role: frame.role,
      basedOn: basedOnHash(entry, index),
      sha256: sha256(frame.png),
    })),
  }
  for (const [index, member] of started.members.entries()) {
    await replaceFile(member.path, incoming[index]!.png)
  }
  if (projectPath && input.project) await replaceFile(projectPath, input.project)
  const companionPath = handEditCompanionPath(started.editPath)
  await replaceFile(companionPath, JSON.stringify(companion, null, 2) + "\n")
  return {
    ...started,
    sha256: companion.outputs[0]!.sha256,
    basedOn: companion.outputs[0]!.basedOn,
    companion,
    companionPath,
    projectPath,
  }
}

function basedOnHash(entry: LockEntry | undefined, index: number): string | null {
  if (!entry) return null
  if (entry.outputs.length === 1) return primaryOutput(entry)?.sha256 ?? null
  return entry.outputs[index]?.sha256 ?? null
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
  const command = editor?.trim() ? editor.trim().split(/\s+/) : defaultOpenCommand()
  return openExternal(file, command)
}
