import { readFileSync, existsSync } from "node:fs"
import path from "node:path"

/**
 * Loads `.env.local` then `.env` from a directory into `process.env`.
 *
 * Existing environment variables always win, so an explicit export or a CI
 * secret is never silently overridden by a checked-out file.
 *
 * This exists because the "PIXELLAB_API_KEY is not set" error told people to
 * put the key in a .env file next to the manifest — advice the code did not
 * actually implement, so following it correctly still failed.
 */
export function loadEnvFiles(dir: string): string[] {
  const loaded: string[] = []
  // .env.local last-writer-wins over .env, matching the Next.js convention
  // these projects already follow — so it is read first and .env cannot
  // clobber it, given the never-override rule below.
  for (const name of [".env.local", ".env"]) {
    const file = path.join(dir, name)
    if (!existsSync(file)) continue
    try {
      applyEnv(readFileSync(file, "utf8"))
      loaded.push(file)
    } catch {
      // An unreadable env file is not worth failing the command over; the
      // missing-key error downstream is clearer than a parse trace.
    }
  }
  return loaded
}

function applyEnv(contents: string): void {
  for (const rawLine of contents.split("\n")) {
    const line = rawLine.trim()
    if (!line || line.startsWith("#")) continue

    const eq = line.indexOf("=")
    if (eq <= 0) continue

    const key = line.slice(0, eq).replace(/^export\s+/, "").trim()
    if (!key || key in process.env) continue

    let value = line.slice(eq + 1).trim()
    // Strip one matching pair of surrounding quotes, if present.
    const quote = value[0]
    if ((quote === '"' || quote === "'") && value.endsWith(quote) && value.length >= 2) {
      value = value.slice(1, -1)
    }
    process.env[key] = value
  }
}
