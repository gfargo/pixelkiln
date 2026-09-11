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
  for (const [file, vars] of envFiles(dir)) {
    for (const [key, value] of Object.entries(vars)) {
      if (!(key in process.env)) process.env[key] = value
    }
    loaded.push(file)
  }
  return loaded
}

/**
 * The variables a directory's env files would provide, without applying them.
 * A long-lived process serving several projects uses this to notice that a
 * project's file names a credential the process already holds with another
 * value — the never-override rule would otherwise route its work to the
 * wrong account silently.
 */
export function readEnvFiles(dir: string): Record<string, string> {
  const merged: Record<string, string> = {}
  for (const [, vars] of envFiles(dir)) {
    for (const [key, value] of Object.entries(vars)) {
      if (!(key in merged)) merged[key] = value
    }
  }
  return merged
}

function envFiles(dir: string): Array<[string, Record<string, string>]> {
  const out: Array<[string, Record<string, string>]> = []
  // .env.local last-writer-wins over .env, matching the Next.js convention
  // these projects already follow — so it is read first and .env cannot
  // clobber it, given the never-override rule in loadEnvFiles.
  for (const name of [".env.local", ".env"]) {
    const file = path.join(dir, name)
    if (!existsSync(file)) continue
    try {
      out.push([file, parseEnv(readFileSync(file, "utf8"))])
    } catch {
      // An unreadable env file is not worth failing the command over; the
      // missing-key error downstream is clearer than a parse trace.
    }
  }
  return out
}

function parseEnv(contents: string): Record<string, string> {
  const vars: Record<string, string> = {}
  for (const rawLine of contents.split("\n")) {
    const line = rawLine.trim()
    if (!line || line.startsWith("#")) continue

    const eq = line.indexOf("=")
    if (eq <= 0) continue

    const key = line.slice(0, eq).replace(/^export\s+/, "").trim()
    if (!key || key in vars) continue

    let value = line.slice(eq + 1).trim()
    // Strip one matching pair of surrounding quotes, if present.
    const quote = value[0]
    if ((quote === '"' || quote === "'") && value.endsWith(quote) && value.length >= 2) {
      value = value.slice(1, -1)
    }
    vars[key] = value
  }
  return vars
}
