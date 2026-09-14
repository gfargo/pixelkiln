/** `tools status|install editor`: the pinned in-browser editor build. */
import { editorStatus, installEditor, EditorInstallError } from "../../editor/install.ts"
import { EDITOR_PIN } from "../../editor/pin.ts"

import { log } from "../io.ts"
import type { Args } from "../args.ts"

/**
 * `tools status` / `tools install editor`: the in-browser editor is a 46 MB
 * web build fetched once per PixelKiln release into a user-level cache, so a
 * machine can be prepared before the gallery is opened (or offline, through
 * PIXELKILN_EDITOR_URL pointing at a mirror).
 */
export async function runTools(args: Pick<Args, "subcommand" | "target" | "json" | "yes">): Promise<void> {
  const mb = (bytes: number) => bytes < 1e6 ? `${(bytes / 1e3).toFixed(0)} kB` : `${(bytes / 1e6).toFixed(1)} MB`
  if (args.subcommand === "status") {
    const status = await editorStatus()
    if (args.json) {
      log(JSON.stringify({ version: 1, editor: { ...status, pixelorama: EDITOR_PIN.pixelorama, protocol: EDITOR_PIN.protocol } }, null, 2))
      return
    }
    log(`  editor  Pixelorama ${EDITOR_PIN.pixelorama} (bridge protocol ${EDITOR_PIN.protocol})`)
    if (!status.release) {
      log("          no published build is pinned by this PixelKiln version")
      return
    }
    log(`          release ${status.release}`)
    log(`          ${status.installed ? "installed and verified" : status.installedBytes ? `partial: ${status.missing.length} of ${Object.keys(EDITOR_PIN.files).length} files missing` : "not installed"} — ${mb(status.totalBytes)} in ${status.dir}`)
    if (!status.installed) log("          run: pixelkiln tools install editor")
    return
  }
  const status = await editorStatus()
  if (status.installed) {
    log(`  editor is already installed and verified in ${status.dir}`)
    return
  }
  if (!status.release) {
    throw new Error("this PixelKiln version pins no published editor build; upgrade, or set PIXELKILN_EDITOR_URL to a build you trust")
  }
  log(`  fetching ${status.missing.length} file(s), ${mb(status.totalBytes - status.installedBytes)}, from release ${status.release}`)
  try {
    const result = await installEditor({
      onProgress: (p) => {
        if (p.phase === "start") log(`    ${p.file.padEnd(34)} ${mb(p.bytes).padStart(9)}`)
      },
    })
    log(`  editor ready in ${result.dir} (${result.downloaded.length} fetched, ${result.skipped.length} already present, every hash verified)`)
  } catch (err) {
    if (err instanceof EditorInstallError) throw new Error(`editor install failed: ${err.message}`)
    throw err
  }
}
