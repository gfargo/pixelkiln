import { createRequire } from "node:module"
import { fileURLToPath } from "node:url"

/**
 * The gallery page's script, bundled from the typed modules in
 * `client/src/` into the one classic script the page inlines. `dist/` ships
 * the result prebuilt (tsup writes `client/gallery.js`); running from source
 * (tests, `tsx`, a checkout) bundles here on first use instead. esbuild is a
 * development dependency, so it is loaded only on this path and never by an
 * installed package, which always has the prebuilt file.
 */
export function bundleGalleryClient(entry = fileURLToPath(new URL("./client/src/main.ts", import.meta.url))): string {
  const esbuild = createRequire(import.meta.url)("esbuild") as typeof import("esbuild")
  const result = esbuild.buildSync({
    entryPoints: [entry],
    bundle: true,
    format: "iife",
    target: "es2020",
    platform: "browser",
    write: false,
    legalComments: "none",
    charset: "utf8",
  })
  return result.outputFiles[0]!.text
}
