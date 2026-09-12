import { createHash } from "node:crypto"
import { existsSync } from "node:fs"
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { EDITOR_PIN, EDITOR_RELEASE_BASE, type EditorPin } from "./pin.ts"

/**
 * The in-gallery editor is a 46 MB web build that is not part of the npm
 * package. It is fetched once per pinned release into a user-level cache,
 * every file verified against the hash the package carries, and served from
 * there by the gallery. Nothing is executed at install; the browser runs the
 * wasm, and only from files whose hashes matched.
 *
 * A user-level cache rather than the project's `.pixelkiln/`: the pin is per
 * PixelKiln release, not per project, and one copy serves every project.
 * `PIXELKILN_TOOLS_DIR` moves it; `PIXELKILN_EDITOR_URL` points downloads at
 * a mirror or a local directory server for offline machines.
 */
export interface EditorInstallStatus {
  /** Release tag the package pins; null means no build has been published for this version. */
  release: string | null
  dir: string
  /** Every pinned file is present with the right hash. */
  installed: boolean
  /** Files still to fetch (missing or hash mismatch). */
  missing: string[]
  totalBytes: number
  installedBytes: number
}

export interface EditorInstallProgress {
  file: string
  index: number
  count: number
  bytes: number
  totalBytes: number
  /** Bytes fetched so far across all files, including the part of this one. */
  fetchedBytes: number
  /** `start` once per file, `progress` as its bytes arrive, `done` once it verified and landed. */
  phase: "start" | "progress" | "done"
}

export interface EditorInstallOptions {
  pin?: EditorPin
  dir?: string
  /** Base URL (or `file://`-less local directory) the files are fetched from. */
  baseUrl?: string
  fetch?: typeof fetch
  onProgress?: (progress: EditorInstallProgress) => void
  signal?: AbortSignal
}

export interface EditorInstallResult extends EditorInstallStatus {
  downloaded: string[]
  skipped: string[]
}

export class EditorInstallError extends Error {
  constructor(message: string, readonly file?: string) {
    super(message)
    this.name = "EditorInstallError"
  }
}

/** Default cache root: XDG on Linux, ~/Library/Caches on macOS, LOCALAPPDATA on Windows. */
export function editorToolsRoot(): string {
  const override = process.env.PIXELKILN_TOOLS_DIR?.trim()
  if (override) return path.resolve(override)
  if (process.platform === "darwin") return path.join(os.homedir(), "Library", "Caches", "pixelkiln", "tools")
  if (process.platform === "win32") {
    return path.join(process.env.LOCALAPPDATA ?? path.join(os.homedir(), "AppData", "Local"), "pixelkiln", "tools")
  }
  return path.join(process.env.XDG_CACHE_HOME ?? path.join(os.homedir(), ".cache"), "pixelkiln", "tools")
}

/** Where one pinned release lives; the tag is part of the path so upgrades never overwrite. */
export function editorDir(pin: EditorPin = EDITOR_PIN, root = editorToolsRoot()): string {
  return path.join(root, "pixelorama", pin.release ?? "unpublished")
}

/** Download base for a pinned release; `PIXELKILN_EDITOR_URL` overrides it. */
export function editorBaseUrl(pin: EditorPin = EDITOR_PIN): string | null {
  const override = process.env.PIXELKILN_EDITOR_URL?.trim()
  if (override) return override.replace(/\/+$/, "")
  if (!pin.release) return null
  return `${EDITOR_RELEASE_BASE}/${encodeURIComponent(pin.release)}`
}

async function sha256Of(file: string): Promise<string | null> {
  try {
    return createHash("sha256").update(await readFile(file)).digest("hex")
  } catch {
    return null
  }
}

/** What is on disk versus what the pin expects, without touching the network. */
export async function editorStatus(opts: { pin?: EditorPin; dir?: string } = {}): Promise<EditorInstallStatus> {
  const pin = opts.pin ?? EDITOR_PIN
  const dir = opts.dir ?? editorDir(pin)
  const missing: string[] = []
  let installedBytes = 0
  let totalBytes = 0
  for (const [name, expected] of Object.entries(pin.files)) {
    totalBytes += expected.bytes
    const file = path.join(dir, name)
    const info = existsSync(file) ? await stat(file).catch(() => null) : null
    if (info && info.size === expected.bytes && (await sha256Of(file)) === expected.sha256) {
      installedBytes += expected.bytes
    } else {
      missing.push(name)
    }
  }
  const pinned = Object.keys(pin.files).length > 0 && pin.release !== null
  return {
    release: pin.release,
    dir,
    installed: pinned && missing.length === 0,
    missing: pinned ? missing : Object.keys(pin.files),
    totalBytes,
    installedBytes,
  }
}

/**
 * Fetch every pinned file that is missing or wrong, verifying each against
 * its hash before it lands. A file that fails verification is discarded and
 * the install fails; nothing partial is ever left under the final name.
 */
export async function installEditor(opts: EditorInstallOptions = {}): Promise<EditorInstallResult> {
  const pin = opts.pin ?? EDITOR_PIN
  const dir = opts.dir ?? editorDir(pin)
  const baseUrl = opts.baseUrl ?? editorBaseUrl(pin)
  const doFetch = opts.fetch ?? fetch
  const before = await editorStatus({ pin, dir })
  if (!pin.release || !Object.keys(pin.files).length) {
    throw new EditorInstallError(
      "this PixelKiln version pins no published editor build; upgrade, or set PIXELKILN_EDITOR_URL to a build you trust",
    )
  }
  if (!baseUrl) throw new EditorInstallError("no download location for the editor build")

  await mkdir(dir, { recursive: true })
  const downloaded: string[] = []
  const skipped = Object.keys(pin.files).filter((name) => !before.missing.includes(name))
  let fetchedBytes = before.installedBytes
  const names = before.missing
  for (const [index, name] of names.entries()) {
    const expected = pin.files[name]!
    const report = (phase: EditorInstallProgress["phase"], received: number) =>
      opts.onProgress?.({
        file: name, index, count: names.length, bytes: expected.bytes, totalBytes: before.totalBytes,
        fetchedBytes: fetchedBytes + received, phase,
      })
    report("start", 0)
    const url = `${baseUrl}/${encodeURIComponent(name)}`
    const response = await doFetch(url, { signal: opts.signal, redirect: "follow" })
    if (!response.ok) throw new EditorInstallError(`${name}: ${response.status} ${response.statusText} from ${url}`, name)
    const bytes = await readBody(response, expected.bytes, (received) => report("progress", received))
    if (bytes.length !== expected.bytes) {
      throw new EditorInstallError(`${name}: expected ${expected.bytes} bytes, got ${bytes.length}`, name)
    }
    const digest = createHash("sha256").update(bytes).digest("hex")
    if (digest !== expected.sha256) {
      throw new EditorInstallError(`${name}: sha256 ${digest.slice(0, 12)}… does not match the pinned ${expected.sha256.slice(0, 12)}…`, name)
    }
    const final = path.join(dir, name)
    const tmp = `${final}.${process.pid}.part`
    try {
      await writeFile(tmp, bytes)
      await rename(tmp, final)
    } finally {
      await rm(tmp, { force: true })
    }
    fetchedBytes += bytes.length
    downloaded.push(name)
    report("done", 0)
  }
  const after = await editorStatus({ pin, dir })
  if (!after.installed) {
    throw new EditorInstallError(`editor install is incomplete: ${after.missing.join(", ")}`)
  }
  return { ...after, downloaded, skipped }
}

/**
 * Collect a response body, reporting bytes as they arrive so a 40 MB file
 * shows movement, and giving up early once it is already larger than pinned.
 */
async function readBody(response: Response, expectedBytes: number, onBytes: (received: number) => void): Promise<Buffer> {
  if (!response.body) return Buffer.from(await response.arrayBuffer())
  const chunks: Uint8Array[] = []
  let received = 0
  const reader = response.body.getReader()
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    chunks.push(value)
    received += value.length
    if (received > expectedBytes) {
      await reader.cancel().catch(() => {})
      break
    }
    onBytes(received)
  }
  return Buffer.concat(chunks)
}

/** Content types the gallery serves the build with; anything else is refused. */
export const EDITOR_CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".wasm": "application/wasm",
  ".pck": "application/octet-stream",
  ".png": "image/png",
  ".json": "application/json; charset=utf-8",
}

export function editorContentType(name: string): string | null {
  return EDITOR_CONTENT_TYPES[path.extname(name).toLowerCase()] ?? null
}
