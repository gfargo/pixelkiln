import { existsSync, readFileSync } from "node:fs"

let cached: string | null | undefined

/**
 * The version of this pixelkiln install, or null when its package.json cannot
 * be found. The bundle flattens modules into dist/, so package.json is one
 * directory up there and one up from src/ as well; the second lookup covers
 * nested source layouts.
 */
export function pixelkilnVersion(): string | null {
  if (cached !== undefined) return cached
  cached = null
  for (const up of ["../package.json", "../../package.json"]) {
    const url = new URL(up, import.meta.url)
    if (!existsSync(url)) continue
    try {
      const pkg = JSON.parse(readFileSync(url, "utf8")) as { name?: string; version?: string }
      if (pkg.name === "pixelkiln" && pkg.version) {
        cached = pkg.version
        break
      }
    } catch {
      // unreadable package.json: keep looking
    }
  }
  return cached
}
