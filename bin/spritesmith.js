#!/usr/bin/env node
// Thin launcher so `spritesmith` works without a build step.
import { spawn } from "node:child_process"
import { fileURLToPath } from "node:url"
import path from "node:path"
const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const child = spawn(
  process.execPath,
  [path.join(root, "node_modules", "tsx", "dist", "cli.mjs"), path.join(root, "src", "cli.ts"), ...process.argv.slice(2)],
  { stdio: "inherit" },
)
child.on("exit", (code) => process.exit(code ?? 0))
