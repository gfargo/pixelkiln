import { copyFileSync, mkdirSync, writeFileSync } from "node:fs"
import { defineConfig } from "tsup"
import { bundleGalleryClient } from "./src/gallery/client-bundle.ts"

/**
 * Two bundles from one config: the library (ESM + CJS with types) and the
 * CLI (ESM). The gallery page reads its stylesheet and client script from
 * `client/` next to the module at runtime, so the stylesheet is copied and
 * the client script bundled beside them; `shims` gives the CJS build an
 * `import.meta.url` to resolve them from.
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
      copyFileSync("src/gallery/client/gallery.css", "dist/client/gallery.css")
      writeFileSync("dist/client/gallery.js", bundleGalleryClient())
    },
  },
  {
    entry: ["src/cli.ts"],
    format: ["esm"],
    dts: true,
    sourcemap: true,
  },
])
