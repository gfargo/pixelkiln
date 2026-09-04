import { execFileSync } from "node:child_process"
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
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
    "schema/recipe.schema.json",
    "docs/README.md",
    "docs/CLI.md",
    "docs/GETTING_STARTED.md",
    "docs/MANIFEST.md",
    "docs/ARTIFACTS.md",
    "skills/pixelkiln/SKILL.md",
    "skills/pixelkiln/references/pixellab.md",
    "skills/pixelkiln/references/retro-diffusion.md",
    "skills/pixelkiln/references/mixed-providers.md",
    "skills/pixelkiln/references/recipes.md",
    "recipes/comfyui/pixel-art-xl-environment/1.0.0/pixelkiln.recipe.json",
    "recipes/comfyui/pixel-art-xl-environment/1.0.0/workflow-api.json",
    "SECURITY.md",
  ]) {
    if (!existsSync(path.join(installed, required))) {
      throw new Error(`published package is missing ${required}`)
    }
  }
  if (existsSync(path.join(installed, "src"))) {
    throw new Error("published package unexpectedly contains raw src/")
  }

  const installedManifest = JSON.parse(readFileSync(path.join(installed, "package.json"), "utf8"))
  if (installedManifest.bin?.pixelkiln !== "bin/pixelkiln.js") {
    throw new Error(
      `published package has an invalid pixelkiln bin mapping: ${String(installedManifest.bin?.pixelkiln)}`,
    )
  }

  run(process.execPath, [
    "--input-type=module",
    "--eval",
    "const m = await import('pixelkiln'); if (typeof m.buildPlan !== 'function' || typeof m.verifyArtifactBundle !== 'function' || typeof m.verifyRecipe !== 'function') process.exit(1)",
  ], consumer)
  run(process.execPath, [
    "--input-type=commonjs",
    "--eval",
    "const m = require('pixelkiln'); if (typeof m.buildPlan !== 'function' || typeof m.verifyArtifactBundle !== 'function' || typeof m.verifyRecipe !== 'function') process.exit(1)",
  ], consumer)

  const cli = path.join(
    consumer,
    "node_modules",
    ".bin",
    process.platform === "win32" ? "pixelkiln.cmd" : "pixelkiln",
  )
  if (!existsSync(cli)) throw new Error("package install did not create the pixelkiln CLI shim")
  const version = run(cli, ["--version"], consumer).trim()
  if (!/^pixelkiln \d+\.\d+\.\d+/.test(version)) {
    throw new Error(`installed CLI returned an unexpected version: ${version}`)
  }
  const recipes = run(cli, ["recipe", "list", "--json"], consumer)
  if (!recipes.includes("comfyui/pixel-art-xl-environment@1.0.0")) {
    throw new Error("installed CLI did not expose the bundled ComfyUI recipe")
  }

  console.log(`package smoke passed: ESM, CommonJS, CLI (${version})`)
} finally {
  rmSync(scratch, { recursive: true, force: true })
}
