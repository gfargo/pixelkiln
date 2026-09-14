#!/usr/bin/env node
import { exitCodeFor, PixelKilnError } from "./errors.ts"
import { main } from "./cli/main.ts"

main().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err)
  const hint = err instanceof PixelKilnError && err.hint ? `  ${err.hint}\n` : ""
  console.error(`\n  error: ${message}\n${hint}`)
  process.exit(exitCodeFor(err))
})
