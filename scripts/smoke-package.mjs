import { execFileSync } from "node:child_process"
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const scratch = mkdtempSync(path.join(tmpdir(), "pixelkiln-package-"))
const npm = process.platform === "win32" ? "npm.cmd" : "npm"

function run(command, args, cwd = root) {
  return execFileSync(command, args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] })
}

try {
  const packed = run(npm, ["pack", "--silent", "--pack-destination", scratch])
    .trim()
    .split(/\r?\n/)
    .at(-1)
  if (!packed?.endsWith(".tgz")) throw new Error(`npm pack did not return a tarball: ${packed}`)

  const consumer = path.join(scratch, "consumer")
  mkdirSync(consumer)
  writeFileSync(
    path.join(consumer, "package.json"),
    JSON.stringify({ name: "pixelkiln-smoke-consumer", private: true, type: "module" }),
  )
  run(npm, ["install", "--ignore-scripts", "--no-audit", "--no-fund", path.join(scratch, packed)], consumer)

  const installed = path.join(consumer, "node_modules", "pixelkiln")
  for (const required of [
    "dist/index.js",
    "dist/index.cjs",
    "dist/index.d.ts",
    "bin/pixelkiln.js",
    "schema/manifest.schema.json",
    "docs/GETTING_STARTED.md",
    "SECURITY.md",
  ]) {
    if (!existsSync(path.join(installed, required))) {
      throw new Error(`published package is missing ${required}`)
    }
  }
  if (existsSync(path.join(installed, "src"))) {
    throw new Error("published package unexpectedly contains raw src/")
  }

  run(process.execPath, [
    "--input-type=module",
    "--eval",
    "const m = await import('pixelkiln'); if (typeof m.buildPlan !== 'function') process.exit(1)",
  ], consumer)
  run(process.execPath, [
    "--input-type=commonjs",
    "--eval",
    "const m = require('pixelkiln'); if (typeof m.buildPlan !== 'function') process.exit(1)",
  ], consumer)

  const cli = path.join(installed, "bin", "pixelkiln.js")
  const version = run(process.execPath, [cli, "--version"], consumer).trim()
  if (!/^pixelkiln \d+\.\d+\.\d+/.test(version)) {
    throw new Error(`installed CLI returned an unexpected version: ${version}`)
  }

  console.log(`package smoke passed: ESM, CommonJS, CLI (${version})`)
} finally {
  rmSync(scratch, { recursive: true, force: true })
}
