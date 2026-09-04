import { execFileSync } from "node:child_process"
import { readFileSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { isSensitiveSourceUrl } from "../src/source-url.ts"

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const tracked = execFileSync("git", ["ls-files", "-z", "--", "*.json"], {
  cwd: root,
  encoding: "utf8",
}).split("\0").filter(Boolean)
const failures: string[] = []

function inspect(value: unknown, file: string, pointer = "$"): void {
  if (typeof value === "string") {
    if (isSensitiveSourceUrl(value)) failures.push(`${file} at ${pointer}`)
    return
  }
  if (Array.isArray(value)) {
    value.forEach((entry, index) => inspect(entry, file, `${pointer}[${index}]`))
    return
  }
  if (value && typeof value === "object") {
    for (const [key, entry] of Object.entries(value)) {
      inspect(entry, file, `${pointer}.${key}`)
    }
  }
}

for (const file of tracked) {
  let raw: unknown
  try {
    raw = JSON.parse(readFileSync(path.join(root, file), "utf8"))
  } catch (error) {
    failures.push(`${file} is not readable JSON: ${error instanceof Error ? error.message : String(error)}`)
    continue
  }
  inspect(raw, file)
}

if (failures.length) {
  console.error("Sensitive or signed URLs found in tracked JSON:\n")
  failures.forEach((failure) => console.error(`- ${failure}`))
  process.exitCode = 1
} else {
  console.log(`source URL hygiene passed: ${tracked.length} tracked JSON files`)
}
