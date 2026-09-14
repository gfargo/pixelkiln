#!/usr/bin/env node
import { main } from "./cli/main.ts"

main().catch((err) => {
  console.error(`\n  error: ${err instanceof Error ? err.message : String(err)}\n`)
  process.exit(1)
})
