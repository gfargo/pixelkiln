import { spawn } from "node:child_process"
import { existsSync } from "node:fs"
import { copyFile, mkdir } from "node:fs/promises"
import path from "node:path"
import { sha256File } from "../hash.ts"
import type { LoadedManifest } from "../manifest.ts"
import { currentEntryOutputPath, portableOutputPath } from "../outputs.ts"
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
