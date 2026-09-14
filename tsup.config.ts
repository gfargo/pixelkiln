import { cpSync, mkdirSync } from "node:fs"
import { defineConfig } from "tsup"

/**
 * Two bundles from one config: the library (ESM + CJS with types) and the
 * CLI (ESM). The gallery page reads its stylesheet and client script from
 * `client/` next to the module at runtime, so those files are copied beside
 * the bundles; `shims` gives the CJS build an `import.meta.url` to resolve
 * them from.
 */
export default defineConfig([
  {
    entry: ["src/index.ts"],
    format: ["esm", "cjs"],
    dts: true,
    clean: true,
    sourcemap: true,
    shims: true,
    onSuccess: async () => {
      mkdirSync("dist/client", { recursive: true })
      cpSync("src/gallery/client", "dist/client", { recursive: true })
    },
  },
  {
    entry: ["src/cli.ts"],
    format: ["esm"],
    dts: true,
    sourcemap: true,
  },
])
