import { existsSync, readFileSync } from "node:fs"
import { bundleGalleryClient } from "./client-bundle.ts"
import type { GallerySnapshot } from "./snapshot.ts"

/**
 * The gallery page: every generation the project has made, at integer zoom,
 * with the provenance record behind each one a click away.
 *
 * It shares the review sheet's visual language on purpose (same palette, same
 * square corners, same monospace identity) so `pick` and `gallery` read as two
 * rooms of one tool. Where `pick` is built for deciding fast, this page is
 * built for looking things up: search, filter, and a detail drawer that shows
 * the lockfile, quality record, and manifest intent side by side.
 *
 * Everything is rendered client-side from one embedded snapshot, and the same
 * code re-renders from `/api/gallery.json` on Refresh, so the page can stay
 * open while `gen` runs elsewhere. All text reaches the DOM via textContent;
 * the only escaping needed is keeping the JSON from closing its script tag
 * (`<\/` and `<\u0021--` are both still valid JSON, so the page can parse
 * the very same bytes back for the refresh path).
 */
export interface RenderGalleryOptions {
  /** Present when the server accepts any write; the page sends it back on every POST. */
  session?: string
  /** Manifest editing is enabled (`--edit`). */
  editable?: boolean
  /** Generation jobs are enabled (`--budget`). */
  generation?: boolean
  /** The in-browser editor can be installed and served (`--edit` without `--no-editor`). */
  editor?: boolean
  /**
   * Marks the page's one inline script and stylesheet for a
   * `galleryContentSecurityPolicy(nonce)` header, so nothing else inline can run.
   */
  nonce?: string
}

/**
 * The policy the gallery serves its page under. Its own script and styles
 * run by nonce; media, the review sheet, and the editor all come from this
 * server; nothing may frame it or post a form anywhere. A prompt or path
 * that ever reached the DOM as markup could still not run.
 */
export function galleryContentSecurityPolicy(nonce: string): string {
  return [
    "default-src 'self'",
    `script-src 'nonce-${nonce}'`,
    `style-src 'nonce-${nonce}'`,
    "img-src 'self' data: blob:",
    "frame-src 'self'",
    "connect-src 'self'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'",
  ].join("; ")
}

/**
 * The page's stylesheet and client script are real files beside this module,
 * read once per process and inlined into the HTML. They used to live inside
 * this template literal, where a backtick or an unescaped `\n` broke the
 * emitted script silently. The script is written as typed modules in
 * `client/src/`: `dist/` carries them prebuilt as `client/gallery.js`, and a
 * source checkout bundles them on first use (see client-bundle.ts), so the
 * same relative URL resolves in source, in tests, and in `dist/`.
 */
const CLIENT_DIR = new URL("./client/", import.meta.url)
let client: { css: string; js: string } | undefined

function clientAssets(): { css: string; js: string } {
  const prebuilt = new URL("gallery.js", CLIENT_DIR)
  client ??= {
    css: readFileSync(new URL("gallery.css", CLIENT_DIR), "utf8"),
    js: existsSync(prebuilt) ? readFileSync(prebuilt, "utf8") : bundleGalleryClient(),
  }
  return client
}

export function renderGallery(snapshot: GallerySnapshot, opts: RenderGalleryOptions = {}): string {
  const data = JSON.stringify(snapshot)
    .replace(/<\//g, "<\\/")
    .replace(/<!--/g, "<\\u0021--")
  const session = JSON.stringify(opts.session ?? null)
  const editable = JSON.stringify(Boolean(opts.editable && opts.session))
  const generation = JSON.stringify(Boolean(opts.generation && opts.session))
  const editor = JSON.stringify(Boolean(opts.editor && opts.session))
  const title = `${snapshot.project?.name ?? "workspace"} | pixelkiln`
  const { css, js } = clientAssets()
  const nonce = opts.nonce ? ` nonce="${escapeHtml(opts.nonce)}"` : ""
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<link rel="icon" href="data:,">
<style${nonce}>
${css}</style>
</head>
<body>
<header>
  <div class="bar">
    <h1>pixelkiln</h1>
    <span class="project" id="project"></span>
    <span class="grow"></span>
    <label class="search"><input id="q" type="search" placeholder="Search assets, prompts, ids, hashes" autocomplete="off"><kbd>/</kbd></label>
    <select id="sort" aria-label="Sort">
      <option value="key">Sort: style / asset</option>
      <option value="newest">Sort: newest first</option>
      <option value="oldest">Sort: oldest first</option>
      <option value="cost">Sort: cost</option>
      <option value="size">Sort: size</option>
    </select>
    <select id="group" aria-label="Group">
      <option value="style">Group: by style</option>
      <option value="family">Group: by family</option>
      <option value="none">Group: none</option>
    </select>
    <span id="editing" class="editing" hidden title="This gallery can write the manifest. It never contacts a provider.">editing</span>
    <button id="select" type="button" title="Pick several records to generate, regenerate, compare, or tag together (or ctrl/⌘-click a card)">Select</button>
    <button id="studio" type="button" hidden title="Draft a new character: its style, base, loops, and portrait, priced as you go">+ New character</button>
    <button id="refresh" type="button" title="Re-read the manifest, lockfile, and disk">Refresh</button>
    <label class="chip" title="Refresh every 5 seconds while this tab is visible"><input id="auto" type="checkbox"> auto</label>
    <label class="chip" title="Play every loop on the grid; without this, a loop plays while the pointer is over it"><input id="playloops" type="checkbox"> play loops</label>
    <span id="backdrop-slot"></span>
    <label class="chip" id="notify-chip" hidden title="A system notification when a job finishes while this tab is in the background"><input id="notify" type="checkbox"> notify</label>
  </div>
  <div class="totals" id="totals"></div>
  <div class="chips" id="chips"></div>
  <div id="jobs"></div>
  <div id="tools"></div>
</header>
<main id="root"></main>
<div id="selbar" class="selbar" hidden></div>
<footer>
  Click a sprite for its full record; <kbd>shift</kbd>-click adds it to a side-by-side comparison. <kbd>←</kbd>/<kbd>→</kbd> step through the visible set while a record
  is open, <kbd>,</kbd>/<kbd>.</kbd> step a loop's frames and <kbd>space</kbd> plays it, <kbd>Esc</kbd> closes it, and <kbd>/</kbd> jumps to search. This page reads the manifest, lockfile,
  and disk only. It never contacts a provider<span id="foot-edit"> and never writes anything</span><span id="foot-editing" hidden>.
  Editing is on: saving rewrites the manifest and nothing else</span><span id="foot-gen" hidden>.
  Generation is on under the session budget shown above; every run is the same submit, poll, and fetch as <code>pixelkiln gen</code></span>.
  <span id="note"></span>
</footer>
<div id="drawer-host"></div>
<div id="dialog-host"></div>
<datalist id="view-options"><option value="low top-down"><option value="high top-down"><option value="side"><option value="sidescroller"></datalist>
<script${nonce}>
const INITIAL = ${data};
const SESSION = ${session};
const EDITABLE = ${editable};
const GENERATION = ${generation};
const EDITOR = ${editor};
${js}</script>
</body>
</html>`
}

const escapeHtml = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!)
