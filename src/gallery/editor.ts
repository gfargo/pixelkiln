import { readFile } from "node:fs/promises"
import path from "node:path"
import {
  editorBaseUrl,
  editorContentType,
  editorDir,
  editorStatus,
  installEditor,
  type EditorInstallOptions,
  type EditorInstallProgress,
  type EditorInstallStatus,
} from "../editor/install.ts"
import { EDITOR_PIN, type EditorPin } from "../editor/pin.ts"

/**
 * The gallery's side of the in-browser editor: it reports whether the pinned
 * build is on disk, installs it on request, and serves its files.
 *
 * Serving is allowlisted twice. The release tag in the URL must be the one
 * this package pins, and the file name must be one the pin lists; nothing
 * else under the tools directory is reachable. A file is served only after
 * the whole build has verified against the pinned hashes, and its size is
 * checked again on every read, so a build that changed on disk after
 * verification is refused rather than served.
 */
export interface GalleryEditorStatus extends EditorInstallStatus {
  pixelorama: string
  protocol: number
  /** Where the page loads the editor from once installed; null until then. */
  url: string | null
  /** The install in flight, if any. */
  installing: EditorInstallProgress | null
  /** Why the last install failed, until the next attempt. */
  error: string | null
}

export interface GalleryEditorHandlers {
  release: string | null
  status(): Promise<GalleryEditorStatus>
  /** Start an install unless one is running; returns the status right after. */
  install(): Promise<GalleryEditorStatus>
  /** A verified build file, or null when it is not pinned or not installed. */
  file(release: string, name: string): Promise<{ bytes: Buffer; contentType: string } | null>
}

export interface GalleryEditorOptions extends Pick<EditorInstallOptions, "dir" | "baseUrl" | "fetch"> {
  pin?: EditorPin
  onProgress?: (msg: string) => void
}

export function editorRoute(release: string, name = "index.html"): string {
  return `/editor/${encodeURIComponent(release)}/${encodeURIComponent(name)}`
}

export function createGalleryEditorHandlers(opts: GalleryEditorOptions = {}): GalleryEditorHandlers {
  const pin = opts.pin ?? EDITOR_PIN
  const dir = opts.dir ?? editorDir(pin)
  const log = opts.onProgress ?? (() => {})
  let verified: EditorInstallStatus | null = null
  let checking: Promise<EditorInstallStatus> | null = null
  let installing: EditorInstallProgress | null = null
  let running: Promise<void> | null = null
  let error: string | null = null

  // Hashing 46 MB takes a moment; do it once and again only after an install
  // or a failed serve, not on every status poll.
  const check = () => {
    if (!checking) {
      checking = editorStatus({ pin, dir }).then((status) => {
        verified = status
        return status
      }).finally(() => {
        checking = null
      })
    }
    return checking
  }

  const describe = (status: EditorInstallStatus): GalleryEditorStatus => ({
    ...status,
    pixelorama: pin.pixelorama,
    protocol: pin.protocol,
    url: status.installed && pin.release ? editorRoute(pin.release) : null,
    installing,
    error,
  })

  return {
    release: pin.release,
    status: async () => describe(verified ?? await check()),
    install: async () => {
      if (!running) {
        error = null
        installing = { file: "", index: 0, count: 0, bytes: 0, totalBytes: 0, fetchedBytes: 0, phase: "start" }
        log(`  installing the editor (Pixelorama ${pin.pixelorama}) into ${dir}`)
        running = installEditor({
          pin,
          dir,
          baseUrl: opts.baseUrl ?? editorBaseUrl(pin) ?? undefined,
          ...(opts.fetch ? { fetch: opts.fetch } : {}),
          onProgress: (progress) => {
            installing = progress
          },
        }).then((result) => {
          verified = result
          const mb = (result.totalBytes / 1e6).toFixed(1)
          log(`  editor ready: ${result.downloaded.length} file(s) fetched, ${result.skipped.length} already present (${mb} MB)`)
        }).catch((err) => {
          error = err instanceof Error ? err.message : String(err)
          verified = null
          log(`  editor install failed: ${error}`)
        }).finally(() => {
          installing = null
          running = null
        })
      }
      return describe(verified ?? await check())
    },
    file: async (release, name) => {
      if (!pin.release || release !== pin.release) return null
      const expected = pin.files[name]
      const contentType = editorContentType(name)
      if (!expected || !contentType) return null
      const status = verified ?? await check()
      if (!status.installed) return null
      let bytes: Buffer
      try {
        bytes = await readFile(path.join(dir, name))
      } catch {
        verified = null
        return null
      }
      if (bytes.length !== expected.bytes) {
        verified = null
        return null
      }
      return { bytes, contentType }
    },
  }
}
