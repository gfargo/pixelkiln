# PixelKiln editor: Pixelorama + host bridge

The in-gallery editor is [Pixelorama](https://github.com/Orama-Interactive/Pixelorama)
(MIT), exported for the web with one addition: a **host bridge** extension that
lets the page that embeds it hand over an image and palette and receive the
saved PNG and `.pxo` back over `postMessage`. Nothing else about Pixelorama
changes, and no drawing code lives here.

There is no standing fork. `scripts/build.sh` materialises one at build time:
clone upstream at the tag pinned in `pin.json`, copy `overlay/` in, replace the
empty `_add_internal_extensions()` body in `src/HandleExtensions.gd` with
`_load_extension("PixelKilnBridge", true)`, disable the PWA export option so no
service worker registers under the gallery's origin, and export the `Web`
preset. The GitHub workflow `editor-build.yml` does this in the same container
Pixelorama's own web CI uses, verifies the round trip with `test/smoke.mjs`,
and publishes a release on request. One editor version is pinned per PixelKiln
release; `pin.json` carries the upstream tag, the Godot version, and — once a
build is published — the release tag and file hashes the gallery verifies.

## Publishing a new build

1. Change the overlay or bump `pixelorama`/`godot` in `pin.json`, open a PR;
   the workflow builds and smoke-tests it.
2. Once merged, run the workflow on `main` with `publish` checked:
   `gh workflow run "Editor build" --ref main -f publish=true`. It creates
   release `editor-pixelorama-<tag>-pk.<run>` with the build and `manifest.json`.
3. Copy the tag into `pin.json` `release` and the manifest's `files` map into
   `pin.json` `files`, commit, and ship it with the next PixelKiln release —
   `src/editor/pin.ts` inlines the file, and `test/editor-install.test.ts`
   checks the pin names a release and every file. Until step 3 lands, the
   package keeps trusting the previous build.

## Layout

- `overlay/src/Extensions/PixelKilnBridge/` — the extension: `extension.json`,
  the scene, and `PixelKilnBridge.gd`. Web-only; a no-op elsewhere.
- `host/index.html` — a host page with no PixelKiln code that speaks the
  protocol; the contract the gallery implements.
- `scripts/build.sh`, `scripts/manifest.mjs`, `scripts/serve.mjs`.
- `test/smoke.mjs` — open → paint → save against a built editor, in Chrome.

## Protocol

Same origin only, both directions checked. Bytes are `ArrayBuffer`s
(transferred). Every message has `type: "pixelkiln:<name>"`.

| direction | type | fields |
|---|---|---|
| host → editor | `open` | `request`, `asset: {key, id, name, width, height}`, `png`, `pxo?`, `frames?: [{role, png}]`, `fps?`, `palette: ["#rrggbb", …]`, `reference?: [{role, png}]` |
| host → editor | `request-save` | `request` |
| host → editor | `reference` | `visible` |
| editor → host | `ready` | `version`, `editor`, `api` |
| editor → host | `opened` | `request`, `width`, `height`, `source: "pxo" \| "frames" \| "png"`, `layers`, `frames`, `reference` |
| editor → host | `dirty` | `dirty` |
| editor → host | `save` | `request`, `width`, `height`, `png`, `frames: [{role, png}]`, `pxo` |
| editor → host | `error` | `request?`, `message` |

`save` is every frame flattened (`png` stays the first, for older hosts) plus
Pixelorama's own `.pxo` (layers intact) for re-editing; hand that `.pxo` back
in `open` (protocol 2) and the editor restores the layered project, using the
`png` or `frames` only if the project file cannot be read — `opened.source`
says which. An ordered set (protocol 3) opens as one project with a frame per
member at the given `fps`; each saved frame carries the role it was opened
under, or `null` for a frame added in the editor, so the host can refuse a
set whose shape changed. `reference` (protocol 4) is the generated art the
edit is compared against: it becomes a locked, half-transparent layer on top
with one cel per frame — an onion skin — that `save` never flattens in,
`reference {visible}` shows or hides, and a reopened `.pxo` keeps once,
refreshed with the current bytes; `opened.layers` counts the author's layers
without it. The editor also answers ⌘S / Ctrl+S and a **File → Save to
PixelKiln** item with a `save`; its disk-oriented File items are removed,
since the page owns the file.

## Local build

Needs Godot 4.7.2 with web export templates on `PATH` as `godot` (or set
`GODOT`), plus `git` and `perl`:

```bash
tools/pixelorama-bridge/scripts/build.sh            # → tools/pixelorama-bridge/.work/build
node tools/pixelorama-bridge/scripts/manifest.mjs tools/pixelorama-bridge/.work/build
node tools/pixelorama-bridge/scripts/serve.mjs tools/pixelorama-bridge/.work/build 4321
node tools/pixelorama-bridge/test/smoke.mjs tools/pixelorama-bridge/.work/build   # needs puppeteer-core + Chrome
```
