import pin from "../../tools/pixelorama-bridge/pin.json"

/**
 * The one editor build a PixelKiln release trusts. The source of truth is
 * `tools/pixelorama-bridge/pin.json`, written when a build is published; the
 * bundler inlines it here so the shipped package carries the exact hashes.
 */
export interface EditorPin {
  /** Upstream Pixelorama tag the build was made from. */
  pixelorama: string
  godot: string
  extensionsApi: number
  /** Bridge protocol version the page must speak. */
  protocol: number
  /** GitHub release tag carrying the files, or null before the first publish. */
  release: string | null
  files: Record<string, { sha256: string; bytes: number }>
}

export const EDITOR_PIN: EditorPin = pin as EditorPin

/** Where a published build's files are downloaded from, unless overridden. */
export const EDITOR_RELEASE_BASE = "https://github.com/gfargo/pixelkiln/releases/download"
