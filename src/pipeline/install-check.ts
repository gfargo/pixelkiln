import { existsSync, readFileSync } from "node:fs"
import path from "node:path"

export interface InstallFacts {
  /** The version range package.json asks for, e.g. "0.88.0" or "^0.88.0". */
  pinned?: string
  /** The version in this project's node_modules, when installed there. */
  installed?: string
  /** The version of the CLI that is running now. */
  running: string | null
}

export interface InstallFinding {
  level: "ok" | "warning"
  message: string
}

function readJson(file: string): Record<string, unknown> | null {
  try {
    return JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>
  } catch {
    return null
  }
}

/**
 * Where this project asks for pixelkiln and where it got it. Looks for a
 * package.json at or above the manifest's directory that names pixelkiln.
 */
export function readInstallFacts(manifestDir: string, running: string | null): InstallFacts | null {
  let dir = path.resolve(manifestDir)
  for (let depth = 0; depth < 4; depth++) {
    const pkg = readJson(path.join(dir, "package.json"))
    if (pkg) {
      const pinned = (["dependencies", "devDependencies", "optionalDependencies"] as const)
        .map((field) => (pkg[field] as Record<string, string> | undefined)?.pixelkiln)
        .find((spec): spec is string => typeof spec === "string")
      if (pinned) {
        const installedPkg = readJson(path.join(dir, "node_modules", "pixelkiln", "package.json"))
        const installed = typeof installedPkg?.version === "string" ? installedPkg.version : undefined
        return { pinned, installed, running }
      }
    }
    const parent = path.dirname(dir)
    if (parent === dir || !existsSync(parent)) break
    dir = parent
  }
  return null
}

function parse(version: string): [number, number, number] | null {
  const match = /(\d+)\.(\d+)\.(\d+)/.exec(version)
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null
}

function compare(a: [number, number, number], b: [number, number, number]): number {
  return a[0] - b[0] || a[1] - b[1] || a[2] - b[2]
}

/**
 * Compares what package.json pins, what node_modules holds, and what is
 * running. A stale install runs an old schema and rejects a manifest written
 * for the pin, with errors that look like a broken manifest.
 */
export function checkInstall(facts: InstallFacts): InstallFinding[] {
  const findings: InstallFinding[] = []
  const pin = parse(facts.pinned ?? "")
  const installed = facts.installed ? parse(facts.installed) : null
  const running = facts.running ? parse(facts.running) : null
  const exact = /^[=v]*\d+\.\d+\.\d+$/.test((facts.pinned ?? "").trim())

  if (pin && facts.installed && installed) {
    const behind = exact ? compare(installed, pin) !== 0 : compare(installed, pin) < 0
    if (behind) {
      findings.push({
        level: "warning",
        message:
          `package.json asks for pixelkiln ${facts.pinned} but node_modules has ${facts.installed}; ` +
          "run `npm install` so the CLI matches the manifest.",
      })
    }
  } else if (pin && !facts.installed) {
    findings.push({
      level: "warning",
      message: `package.json asks for pixelkiln ${facts.pinned} but it is not installed in node_modules; run \`npm install\`.`,
    })
  }

  if (running && installed && compare(running, installed) !== 0) {
    findings.push({
      level: "warning",
      message:
        `running pixelkiln ${facts.running}, but this project's node_modules has ${facts.installed}. ` +
        "Another install is first on your PATH; use `npx pixelkiln` or remove the global one.",
    })
  }

  if (!findings.length) {
    findings.push({
      level: "ok",
      message: `pixelkiln ${facts.running ?? facts.installed ?? "?"} matches package.json (${facts.pinned})`,
    })
  }
  return findings
}
