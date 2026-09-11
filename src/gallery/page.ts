import type { GallerySnapshot } from "./snapshot.ts"

/**
 * The gallery page: every generation the project has made, at integer zoom,
 * with the provenance record behind each one a click away.
 *
 * It shares the review sheet's visual language on purpose — same palette, same
 * square corners, same monospace identity — so `pick` and `gallery` read as two
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
  /** Present only when the server accepts edits; the page sends it back on every write. */
  session?: string
}

export function renderGallery(snapshot: GallerySnapshot, opts: RenderGalleryOptions = {}): string {
  const data = JSON.stringify(snapshot)
    .replace(/<\//g, "<\\/")
    .replace(/<!--/g, "<\\u0021--")
  const session = JSON.stringify(opts.session ?? null)
  const title = `pixelkiln — ${snapshot.project?.name ?? "workspace"}`
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<link rel="icon" href="data:,">
<style>
  :root {
    --bg: #17150f; --panel: #201d17; --panel-deep: #100f0c;
    --line: rgba(243,234,214,.16); --line-strong: rgba(243,234,214,.3);
    --text: #f3ead6; --dim: #9b9384; --accent: #ff6b35; --accent-soft: #ff9c5f;
    --ok: #b9f27c; --warn: #ff9c5f; --bad: #ff7a6b; --cool: #8fc7ff;
    --content: 1520px; --drawer: 540px;
    --mono: ui-monospace, SFMono-Regular, Menlo, monospace;
    --checker:
      linear-gradient(45deg,#0000 25%,#7f7f7f22 25%,#7f7f7f22 75%,#0000 75%),
      linear-gradient(45deg,#0000 25%,#7f7f7f22 25%,#7f7f7f22 75%,#0000 75%);
  }
  * { box-sizing: border-box; }
  html { color-scheme: dark; }
  body { margin:0; background:var(--bg); color:var(--text);
    font:14px/1.5 ui-sans-serif,-apple-system,"SF Pro Text",Inter,system-ui,sans-serif; }
  button, input, select { font:inherit; color:inherit; }
  button { border-radius:0; padding:6px 11px; border:1px solid var(--line);
    background:transparent; cursor:pointer; }
  button:hover { border-color:var(--line-strong); }
  button.primary { background:var(--accent); border-color:var(--accent); color:var(--bg); font-weight:600; }
  button:disabled { opacity:.45; cursor:not-allowed; }
  :focus-visible { outline:2px solid var(--accent-soft); outline-offset:2px; }
  a { color:var(--accent-soft); }
  code, .mono { font-family:var(--mono); }

  header { position:sticky; top:0; z-index:10; background:var(--panel);
    border-bottom:1px solid var(--line-strong); }
  .bar { width:min(100%,var(--content)); margin:0 auto; padding:13px 22px 0;
    display:flex; align-items:center; gap:14px; flex-wrap:wrap; }
  h1 { font:700 14px/1 var(--mono); margin:0; letter-spacing:-.02em; white-space:nowrap; }
  h1::before { content:'◆'; color:var(--accent); margin-right:9px; font-size:11px; }
  .project { color:var(--dim); font-size:12.5px; min-width:0; overflow:hidden;
    text-overflow:ellipsis; white-space:nowrap; }
  .project b { color:var(--text); font-weight:600; }
  .grow { flex:1 1 auto; }
  .search { display:flex; align-items:center; gap:8px; border:1px solid var(--line);
    background:var(--panel-deep); padding:0 10px; min-width:min(320px, 100%); }
  .search input { flex:1; border:0; background:transparent; padding:7px 0; min-width:0; }
  .search input:focus { outline:none; }
  .search kbd { color:var(--dim); border:1px solid var(--line); border-bottom-width:2px;
    padding:0 5px; font-size:11px; font-family:var(--mono); }
  select { background:var(--panel-deep); border:1px solid var(--line); padding:6px 8px; border-radius:0; }
  .totals { width:min(100%,var(--content)); margin:0 auto; padding:9px 22px 0;
    display:flex; gap:14px; flex-wrap:wrap; align-items:baseline;
    color:var(--dim); font-size:12.5px; font-variant-numeric:tabular-nums; }
  .totals b { color:var(--text); font-weight:600; }
  .chips { width:min(100%,var(--content)); margin:0 auto; padding:9px 22px 13px;
    display:flex; gap:6px; flex-wrap:wrap; align-items:center; }
  .chips .sep { width:1px; height:18px; background:var(--line); margin:0 4px; }
  .chip { padding:3px 9px; font-size:12px; border:1px solid var(--line); color:var(--dim);
    display:inline-flex; align-items:center; gap:6px; font-variant-numeric:tabular-nums; }
  .chip.on { color:var(--text); border-color:var(--line-strong); background:var(--panel-deep); }
  .chip .n { color:var(--dim); }
  .dot { width:7px; height:7px; display:inline-block; background:var(--dim); flex:none; }
  .dot.ok { background:var(--ok); } .dot.warn { background:var(--warn); }
  .dot.bad { background:var(--bad); } .dot.cool { background:var(--cool); }
  .state-ok { color:var(--ok); } .state-warn { color:var(--warn); }
  .state-bad { color:var(--bad); } .state-cool { color:var(--cool); } .state-dim { color:var(--dim); }

  main { width:min(100%,var(--content)); margin:0 auto; border-inline:1px solid var(--line);
    min-height:60vh; }
  .style { border-bottom:1px solid var(--line); padding:20px 22px 24px; }
  .project { border-bottom:1px solid var(--line-strong); background:var(--panel); padding:14px 22px; }
  .phead { display:flex; align-items:baseline; gap:14px; flex-wrap:wrap; }
  .phead h2 { margin:0; font:700 15px/1.2 var(--mono); }
  .phead h2::before { content:'◆'; color:var(--accent); margin-right:8px; font-size:10px; }
  .phead .meta { color:var(--dim); font-size:12.5px; display:flex; gap:12px; flex-wrap:wrap; }
  .sid.project { color:var(--dim); border-color:var(--line-strong); }
  .shead { display:flex; align-items:baseline; gap:14px; flex-wrap:wrap; margin-bottom:14px; }
  .shead h2 { margin:0; font:650 15px/1.2 var(--mono); }
  .shead .meta { color:var(--dim); font-size:12.5px; display:flex; gap:12px; flex-wrap:wrap;
    align-items:center; }
  .swatches { display:inline-flex; gap:2px; vertical-align:middle; }
  .swatches i { width:12px; height:12px; display:block; border:1px solid var(--line); }
  .grid { display:grid; grid-template-columns:repeat(auto-fill, minmax(176px, 1fr)); gap:10px; }
  .card { border:1px solid var(--line); background:var(--panel); text-align:left; padding:0;
    display:flex; flex-direction:column; cursor:pointer; min-width:0;
    content-visibility:auto; contain-intrinsic-size:auto 176px auto 196px; }
  .card:hover { border-color:var(--line-strong); }
  .card.active { border-color:var(--accent); box-shadow:0 0 0 2px color-mix(in srgb, var(--accent) 25%, transparent); }
  .card.ghost { border-style:dashed; background:transparent; }
  .cell { height:132px; display:grid; place-items:center; background:var(--panel-deep);
    background-image:var(--checker); background-size:12px 12px; background-position:0 0,6px 6px;
    overflow:hidden; position:relative; padding:8px; }
  .card.ghost .cell { background-image:none; color:var(--dim); font-size:12px; }
  .cell img { image-rendering:pixelated; display:block; max-width:100%; max-height:100%; }
  .cell img.fit { width:auto; height:auto; object-fit:contain; }
  .cell .multi { display:grid; grid-template-columns:1fr 1fr; gap:4px; width:100%; height:100%; }
  .cell .multi div { display:grid; place-items:center; overflow:hidden; }
  .badge { position:absolute; right:6px; bottom:6px; background:var(--panel); color:var(--dim);
    border:1px solid var(--line); font:11px/1 var(--mono); padding:3px 6px; }
  .cbody { padding:8px 10px 10px; display:flex; flex-direction:column; gap:3px; min-width:0; }
  .aid { font:600 13px/1.3 var(--mono); overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  .cmeta { display:flex; gap:8px; align-items:center; color:var(--dim); font-size:11.5px;
    font-variant-numeric:tabular-nums; white-space:nowrap; overflow:hidden; }
  .cmeta .st { display:inline-flex; align-items:center; gap:5px; }
  .empty { padding:64px 22px; color:var(--dim); text-align:center; }
  .empty p { margin:0 0 12px; }
  footer { width:min(100%,var(--content)); margin:0 auto; padding:22px 22px 60px; color:var(--dim);
    font-size:12.5px; }
  kbd { border:1px solid var(--line); border-bottom-width:2px; padding:1px 5px; font-size:11px;
    font-family:var(--mono); }

  .scrim { position:fixed; inset:0; background:rgba(0,0,0,.45); z-index:19; }
  .drawer { position:fixed; top:0; right:0; bottom:0; width:min(var(--drawer), 100vw); z-index:20;
    background:var(--panel); border-left:1px solid var(--line-strong); overflow-y:auto;
    display:flex; flex-direction:column; }
  .dhead { position:sticky; top:0; background:var(--panel); border-bottom:1px solid var(--line);
    padding:14px 18px; display:flex; align-items:center; gap:10px; z-index:1; }
  .dhead .title { flex:1; min-width:0; }
  .dhead .title .sid { color:var(--accent-soft); font:650 10.5px/1 var(--mono); border:1px solid var(--accent);
    padding:2px 6px; display:inline-block; margin-bottom:6px; }
  .dhead .title .aid { font-size:16px; white-space:normal; word-break:break-all; }
  .dhead button { padding:5px 9px; }
  .dbody { padding:0 18px 40px; }
  .preview { margin:16px 0 10px; background:var(--panel-deep); background-image:var(--checker);
    background-size:12px 12px; background-position:0 0,6px 6px; border:1px solid var(--line);
    min-height:200px; max-height:60vh; overflow:auto; display:grid; place-items:center; padding:12px; }
  .preview img { image-rendering:pixelated; display:block; }
  .preview .none { color:var(--dim); font-size:12.5px; text-align:center; padding:40px 12px; }
  .zoom { display:flex; gap:6px; align-items:center; flex-wrap:wrap; font-size:12px; color:var(--dim); }
  .zoom button { padding:3px 8px; font-size:12px; }
  .zoom button.on { border-color:var(--accent); color:var(--text); }
  .zoom .grow { text-align:right; font-variant-numeric:tabular-nums; }
  .members { display:flex; gap:6px; overflow-x:auto; padding:10px 0 4px; }
  .members button { flex:none; padding:4px; display:flex; flex-direction:column; align-items:center; gap:3px;
    background:var(--panel-deep); background-image:var(--checker); background-size:8px 8px;
    background-position:0 0,4px 4px; }
  .members button.on { border-color:var(--accent); }
  .members img { image-rendering:pixelated; display:block; width:40px; height:40px; object-fit:contain; }
  .members span { font:10.5px/1 var(--mono); color:var(--dim); background:var(--panel); padding:2px 4px; }
  .status { margin:14px 0 0; padding:10px 12px; border:1px solid var(--line); display:flex; gap:10px;
    align-items:baseline; font-size:13px; }
  .status .st { font-weight:600; display:inline-flex; align-items:center; gap:6px; white-space:nowrap; }
  .status .why { color:var(--dim); }
  section.meta { border-top:1px solid var(--line); padding:14px 0 6px; margin-top:14px; }
  section.meta h3 { margin:0 0 10px; font:650 12.5px/1 var(--mono); color:var(--dim); }
  dl { margin:0; display:grid; grid-template-columns:minmax(96px, 30%) 1fr; gap:6px 12px; font-size:12.5px; }
  dt { color:var(--dim); }
  dd { margin:0; min-width:0; word-break:break-word; }
  dd.mono { font-family:var(--mono); font-size:12px; }
  dd .copy { margin-left:6px; padding:0 5px; font:11px/1.4 var(--mono); color:var(--dim); border-color:transparent; }
  dd .copy:hover { border-color:var(--line); color:var(--text); }
  .prompt { white-space:pre-wrap; }
  .out { border:1px solid var(--line); padding:8px 10px; margin-bottom:8px; }
  .out dl { grid-template-columns:minmax(72px, 24%) 1fr; }
  .out .role { font:600 12px/1 var(--mono); margin-bottom:6px; display:flex; gap:8px; align-items:center; }
  .miss { color:var(--bad); }
  .pal { display:flex; flex-wrap:wrap; gap:3px; }
  .pal i { width:16px; height:16px; display:block; border:1px solid var(--line); }
  details { border:1px solid var(--line); padding:0; margin-top:8px; }
  details summary { cursor:pointer; padding:7px 10px; font:650 12.5px/1 var(--mono); color:var(--dim); }
  details pre { margin:0; padding:10px; border-top:1px solid var(--line); background:var(--panel-deep);
    font:11.5px/1.45 var(--mono); overflow:auto; max-height:320px; }
  .linkish { background:none; border:0; padding:0; color:var(--accent-soft); cursor:pointer;
    font-family:var(--mono); font-size:12px; text-decoration:underline; }
  .nav { display:flex; gap:6px; }
  #note { color:var(--warn); font-size:12.5px; }
  .editing { color:var(--accent-soft); border:1px solid var(--accent); padding:2px 7px; font:650 10.5px/1.4 var(--mono); }
  form.edit { border:1px solid var(--accent); padding:12px 14px 14px; margin-top:14px; display:grid; gap:10px; }
  form.edit h3 { margin:0; font:650 12.5px/1 var(--mono); color:var(--accent-soft); }
  form.edit .row { display:grid; grid-template-columns:repeat(auto-fit, minmax(110px, 1fr)); gap:10px; }
  .field { display:grid; gap:4px; font-size:12px; color:var(--dim); min-width:0; }
  .field span { font-family:var(--mono); font-size:11px; }
  .field small { font-size:11px; color:var(--dim); }
  .field input, .field textarea, .field select { background:var(--panel-deep); border:1px solid var(--line);
    color:var(--text); padding:6px 8px; border-radius:0; font:13px/1.45 inherit; width:100%; min-width:0; }
  .field textarea { resize:vertical; min-height:64px; font-family:inherit; }
  .field input:focus, .field textarea:focus, .field select:focus { outline:none; border-color:var(--accent); }
  .field.check { display:flex; align-items:center; gap:8px; }
  .field.check input { width:auto; }
  form.edit .actions { display:flex; gap:8px; align-items:center; flex-wrap:wrap; }
  form.edit .msg { font-size:12.5px; }
  form.edit .msg.bad { color:var(--bad); }
  .notice { margin:14px 0 0; padding:10px 12px; border:1px solid var(--ok); color:var(--ok); font-size:13px; }
  .shead .add { margin-left:auto; padding:3px 9px; font-size:12px; }
  @media (max-width: 720px) {
    .bar, .totals, .chips, .style, footer { padding-inline:14px; }
    .grid { grid-template-columns:repeat(auto-fill, minmax(140px, 1fr)); }
    .cell { height:112px; }
    .drawer { width:100vw; }
  }
  @media (prefers-reduced-motion: no-preference) {
    .drawer { animation: slide .16s ease-out; }
    @keyframes slide { from { transform: translateX(16px); opacity:.6; } to { transform:none; opacity:1; } }
  }
</style>
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
      <option value="none">Group: none</option>
    </select>
    <span id="editing" class="editing" hidden title="This gallery can write the manifest. It never contacts a provider.">editing</span>
    <button id="refresh" type="button" title="Re-read the manifest, lockfile, and disk">Refresh</button>
    <label class="chip" title="Refresh every 5 seconds while this tab is visible"><input id="auto" type="checkbox"> auto</label>
  </div>
  <div class="totals" id="totals"></div>
  <div class="chips" id="chips"></div>
</header>
<main id="root"></main>
<footer>
  Click a sprite for its full record. <kbd>←</kbd>/<kbd>→</kbd> step through the visible set while a record
  is open, <kbd>Esc</kbd> closes it, and <kbd>/</kbd> jumps to search. This page reads the manifest, lockfile,
  and disk only — it never contacts a provider<span id="foot-edit"> and never writes anything</span><span id="foot-editing" hidden>.
  Editing is on: saving rewrites the manifest and nothing else; generation still goes through <code>pixelkiln gen</code></span>.
  <span id="note"></span>
</footer>
<div id="drawer-host"></div>
<script>
const INITIAL = ${data};
const SESSION = ${session};
const EDITABLE = SESSION !== null;
let snap = INITIAL;
const STATE_TONE = {
  ok: 'ok', stale: 'warn', orphaned: 'warn', untracked: 'warn', blocked: 'warn',
  failed: 'bad', 'in-flight': 'cool', recoverable: 'cool', missing: 'dim', undeclared: 'dim',
};
const STATE_ORDER = ['ok','stale','orphaned','untracked','in-flight','recoverable','blocked','failed','missing','undeclared'];
const ui = {
  q: '', states: new Set(), providers: new Set(), generators: new Set(), projects: new Set(),
  sort: 'key', group: 'style', open: null, member: 0, zoom: 'auto', playing: null,
  /** Cards rendered per pass; a project with thousands of assets opts into the rest. */
  limit: 600,
  /** Item id whose edit form is open, or 'new:<project>:<style>' for an add form. */
  editing: null,
  /** One-shot confirmation shown in the drawer after a save. */
  notice: null,
};
const $ = (id) => document.getElementById(id);
const el = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined && text !== null) n.textContent = String(text);
  return n;
};
const fmtCost = (unit, amount) => {
  if (unit === 'free') return 'free';
  if (unit === 'usd') return '$' + Number(amount).toFixed(2);
  if (unit === 'generations') return amount + ' generation' + (amount === 1 ? '' : 's');
  return amount + ' ' + unit;
};
const fmtSpend = (spend) => Object.entries(spend).filter(([, n]) => n).sort()
  .map(([unit, n]) => fmtCost(unit, Math.round(n * 100) / 100)).join(' + ') || 'no spend recorded';
const fmtBytes = (n) => n == null ? '—' : n < 1024 ? n + ' B' : n < 1048576 ? (n / 1024).toFixed(1) + ' KB' : (n / 1048576).toFixed(2) + ' MB';
const fmtWhen = (iso) => {
  if (!iso) return null;
  const d = new Date(iso);
  return isNaN(d) ? iso : d.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
};
const isFrameSet = (item) => item.generator === 'frames' ||
  (item.outputs.length > 1 && item.outputs.every((o) => o.role && /^frame/i.test(o.role)));
const shortPath = (p) => {
  if (p.length <= 64) return p;
  const parts = p.split('/');
  return parts.length > 4 ? '…/' + parts.slice(-3).join('/') : p;
};
const displayScale = (w, h, boxW, boxH) => {
  const s = Math.min(boxW / w, boxH / h);
  return s >= 1 ? Math.floor(s) : s;
};

const projectOf = (item) => snap.workspace
  ? snap.workspace.projects.find((pr) => pr.id === item.project)
  : snap.project;

// The only write this page ever makes: one manifest edit, quoting the
// manifest hash it was rendered from so a concurrent hand edit is refused
// rather than overwritten. The server answers with the rebuilt gallery.
async function postEdit(body) {
  const res = await fetch('/api/edit', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Pixelkiln-Session': SESSION },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const err = new Error(await res.text());
    err.status = res.status;
    throw err;
  }
  return res.json();
}
const field = (label, input, hint) => {
  const w = el('label', 'field');
  w.append(el('span', null, label), input);
  if (hint) w.append(el('small', null, hint));
  return w;
};
const numberInput = (value, placeholder) => {
  const i = el('input'); i.type = 'number'; i.min = '16'; i.step = '1';
  i.value = value == null ? '' : String(value); i.placeholder = placeholder || '';
  return i;
};
const numberOrNull = (input) => input.value.trim() === '' ? null : Number(input.value);
const splitTags = (value) => value.split(',').map((t) => t.trim()).filter(Boolean);

function visibleItems() {
  const q = ui.q.trim().toLowerCase();
  let items = snap.items.filter((item) => {
    if (ui.states.size && !ui.states.has(item.state)) return false;
    if (ui.providers.size && !ui.providers.has(item.provider)) return false;
    if (ui.generators.size && !ui.generators.has(item.generator)) return false;
    if (ui.projects.size && !ui.projects.has(item.project)) return false;
    if (!q) return true;
    const hay = [item.id, item.prompt, item.currentPrompt, item.jobId, item.objectId,
      item.recordedSpecHash, item.currentSpecHash, item.category, ...(item.tags || []),
      ...item.outputs.flatMap((o) => [o.path, o.sha256])].filter(Boolean).join('\\n').toLowerCase();
    return hay.includes(q);
  });
  const when = (item) => item.downloadedAt || item.submittedAt || '';
  const sorters = {
    key: (a, b) => a.id.localeCompare(b.id),
    newest: (a, b) => when(b).localeCompare(when(a)) || a.id.localeCompare(b.id),
    oldest: (a, b) => when(a).localeCompare(when(b)) || a.id.localeCompare(b.id),
    cost: (a, b) => (b.cost - a.cost) || a.id.localeCompare(b.id),
    size: (a, b) => (b.width * b.height - a.width * a.height) || a.id.localeCompare(b.id),
  };
  items.sort(sorters[ui.sort] || sorters.key);
  return items;
}

function renderHeader() {
  $('editing').hidden = !EDITABLE;
  $('foot-edit').hidden = EDITABLE;
  $('foot-editing').hidden = !EDITABLE;
  const p = $('project');
  p.textContent = '';
  if (snap.workspace) {
    p.append(el('b', null, 'workspace'), ' ', document.createTextNode(shortPath(snap.workspace.path)));
    p.title = snap.workspace.path;
  } else {
    p.append(el('b', null, snap.project.name), ' ', document.createTextNode(shortPath(snap.project.manifest)));
    p.title = snap.project.manifest + '\\nlockfile: ' + snap.project.lock;
  }

  const t = $('totals');
  t.textContent = '';
  if (snap.workspace) {
    const broken = snap.workspace.projects.filter((pr) => pr.error).length;
    const w = el('span', null, '');
    w.append(el('b', null, snap.workspace.projects.length), document.createTextNode(' project' +
      (snap.workspace.projects.length === 1 ? '' : 's') + (broken ? ' (' + broken + ' unreadable)' : '')));
    t.append(w);
  }
  const n = snap.totals.entries;
  t.append(el('span', null, ''));
  t.lastChild.append(el('b', null, n), document.createTextNode(' lock ' + (n === 1 ? 'entry' : 'entries')));
  const declared = snap.items.filter((i) => i.declared).length;
  t.append(el('span', null, declared + ' declared by ' + (snap.workspace ? 'a manifest' : 'the manifest')));
  t.append(el('span', null, fmtSpend(snap.totals.spendByUnit) + ' recorded'));
  if (snap.filter.styles.length || snap.filter.assets.length) {
    t.append(el('span', 'state-warn', 'filtered: ' +
      [snap.filter.styles.length ? '--style ' + snap.filter.styles.join(',') : '',
       snap.filter.assets.length ? '--only ' + snap.filter.assets.join(',') : ''].filter(Boolean).join(' ')));
  }
  t.append(el('span', null, 'snapshot ' + fmtWhen(snap.generatedAt)));

  const chips = $('chips');
  chips.textContent = '';
  const counts = (pick) => {
    const m = new Map();
    for (const item of snap.items) { const k = pick(item); m.set(k, (m.get(k) || 0) + 1); }
    return m;
  };
  const chip = (label, count, set, key, tone) => {
    const b = el('button', 'chip' + (set.has(key) ? ' on' : ''));
    b.type = 'button';
    b.setAttribute('aria-pressed', String(set.has(key)));
    if (tone) b.append(el('i', 'dot ' + tone));
    b.append(document.createTextNode(label), el('span', 'n', count));
    b.onclick = () => { set.has(key) ? set.delete(key) : set.add(key); render(); };
    return b;
  };
  if (snap.workspace) {
    const byProject = counts((i) => i.project);
    for (const pr of snap.workspace.projects) {
      if (byProject.has(pr.id) || ui.projects.has(pr.id)) chips.append(chip(pr.id, byProject.get(pr.id) || 0, ui.projects, pr.id));
    }
    chips.append(el('span', 'sep'));
  }
  const byState = counts((i) => i.state);
  for (const s of STATE_ORDER) if (byState.has(s)) chips.append(chip(s, byState.get(s), ui.states, s, STATE_TONE[s]));
  const byProvider = counts((i) => i.provider);
  if (byProvider.size > 1 || ui.providers.size) {
    chips.append(el('span', 'sep'));
    for (const [k, v] of [...byProvider].sort()) chips.append(chip(k, v, ui.providers, k));
  }
  const byGen = counts((i) => i.generator);
  if (byGen.size > 1 || ui.generators.size) {
    chips.append(el('span', 'sep'));
    for (const [k, v] of [...byGen].sort()) chips.append(chip(k, v, ui.generators, k));
  }
  if (ui.states.size || ui.providers.size || ui.generators.size || ui.projects.size || ui.q) {
    const clear = el('button', 'chip', 'clear filters');
    clear.type = 'button';
    clear.onclick = () => clearFilters();
    chips.append(el('span', 'sep'), clear);
  }
}

function clearFilters() {
  ui.states.clear(); ui.providers.clear(); ui.generators.clear(); ui.projects.clear();
  ui.q = ''; $('q').value = '';
  render();
}

function thumb(item) {
  const cell = el('div', 'cell');
  const shown = item.outputs.filter((o) => o.url);
  if (!shown.length) {
    cell.classList.add('none');
    cell.append(el('span', null, item.state === 'missing' ? 'not generated yet'
      : item.state === 'in-flight' ? (item.status === 'review' ? 'awaiting review' : 'awaiting provider')
      : item.state === 'recoverable' ? 'ready to fetch'
      : item.state === 'failed' ? 'generation failed'
      : item.state === 'blocked' ? 'waiting on its parent'
      : item.outputs.length ? 'file missing on disk' : 'no output recorded'));
    return cell;
  }
  const w = item.width, h = item.height;
  if (shown.length > 1 && !isFrameSet(item)) {
    const multi = el('div', 'multi');
    for (const o of shown.slice(0, 4)) {
      const box = el('div');
      const img = el('img');
      img.src = o.url; img.alt = o.role || item.assetId; img.loading = 'lazy';
      const s = displayScale(w, h, 66, 52);
      if (s >= 1) { img.width = w * s; img.height = h * s; } else img.className = 'fit';
      box.append(img); multi.append(box);
    }
    cell.append(multi, el('span', 'badge', shown.length + ' outputs'));
    return cell;
  }
  const img = el('img');
  img.src = shown[0].url; img.alt = item.assetId; img.loading = 'lazy';
  const s = displayScale(w, h, 156, 116);
  if (s >= 1) { img.width = w * s; img.height = h * s; } else img.className = 'fit';
  cell.append(img);
  if (isFrameSet(item)) cell.append(el('span', 'badge', '▸ ' + shown.length + ' frames'));
  else if (s >= 1 && s !== 1) cell.append(el('span', 'badge', s + '×'));
  return cell;
}

function card(item) {
  const c = el('button', 'card' + (item.outputs.some((o) => o.url) ? '' : ' ghost') + (ui.open === item.id ? ' active' : ''));
  c.type = 'button';
  c.dataset.key = item.id;
  c.setAttribute('aria-label', item.id + ', ' + item.state);
  const body = el('div', 'cbody');
  body.append(el('div', 'aid', item.assetId));
  const meta = el('div', 'cmeta');
  const st = el('span', 'st');
  st.append(el('i', 'dot ' + STATE_TONE[item.state]), document.createTextNode(item.state));
  meta.append(st, el('span', null, item.width + '×' + item.height));
  if (item.cost) meta.append(el('span', null, fmtCost(item.costUnit, item.cost)));
  body.append(meta);
  c.append(thumb(item), body);
  c.onclick = () => openItem(item.id);
  return c;
}

function renderMain(items) {
  const root = $('root');
  root.textContent = '';
  if (!snap.items.length) {
    const e = el('div', 'empty');
    e.append(el('p', null, 'Nothing has been generated for this project yet.'));
    e.append(el('p', null, 'pixelkiln plan shows what the manifest would make; pixelkiln gen makes it.'));
    root.append(e);
    return;
  }
  if (!items.length) {
    const e = el('div', 'empty');
    e.append(el('p', null, 'No generations match these filters.'));
    const b = el('button', null, 'Clear filters');
    b.type = 'button';
    b.onclick = clearFilters;
    e.append(b);
    root.append(e);
    return;
  }
  // Building every card for a very large project on each keystroke is the one
  // thing that makes this page feel slow, so a render is capped and the rest
  // is one click away. Filters usually narrow well below the cap anyway.
  const hidden = Math.max(0, items.length - ui.limit);
  const shown = hidden ? items.slice(0, ui.limit) : items;
  // A workspace always breaks on project: lock keys repeat across projects,
  // so a flat wall of "anvil" cards would be ambiguous. Style grouping stays
  // optional inside each project, exactly as it is for one project.
  const unfiltered = !ui.projects.size && !ui.q && !ui.states.size && !ui.providers.size && !ui.generators.size;
  const projects = snap.workspace
    ? snap.workspace.projects.filter((pr) => ui.projects.size
        ? ui.projects.has(pr.id)
        : unfiltered || shown.some((i) => i.project === pr.id))
    : [null];
  const sections = [];
  for (const pr of projects) {
    const inProject = pr ? shown.filter((i) => i.project === pr.id) : shown;
    const styleSections = ui.group === 'style'
      ? snap.styles.filter((s) => !pr || s.project === pr.id)
          .map((s) => ({ style: s, items: inProject.filter((i) => i.styleId === s.id) })).filter((s) => s.items.length)
      : (inProject.length ? [{ style: null, items: inProject }] : []);
    if (pr) sections.push({ project: pr, style: null, items: null, count: inProject.length });
    sections.push(...styleSections);
  }
  for (const sec of sections) {
    if (sec.project) {
      root.append(projectHeader(sec.project, sec.count));
      continue;
    }
    const wrap = el('section', 'style');
    if (sec.style) {
      const s = sec.style;
      const head = el('div', 'shead');
      head.append(el('h2', null, s.id));
      const meta = el('div', 'meta');
      meta.append(el('span', null, s.provider), el('span', null, s.generator));
      if (s.outDir) meta.append(el('span', 'mono', s.outDir));
      if (s.palette.length) {
        const sw = el('span', 'swatches');
        for (const c of s.palette) { const i = el('i'); i.style.background = c; i.title = c; sw.append(i); }
        meta.append(sw);
      }
      if (s.quality) meta.append(el('span', null, 'quality profile'));
      meta.append(el('span', null, sec.items.length + ' of ' + s.items + (s.items === 1 ? ' asset' : ' assets')));
      if (Object.keys(s.spendByUnit).length) meta.append(el('span', null, fmtSpend(s.spendByUnit)));
      head.append(meta);
      const addKey = 'new:' + (s.project || '') + ':' + s.id;
      if (EDITABLE && s.outDir) {
        const add = el('button', 'add', ui.editing === addKey ? 'Cancel' : '+ Add asset');
        add.type = 'button';
        add.onclick = () => { ui.editing = ui.editing === addKey ? null : addKey; render(); };
        head.append(add);
      }
      wrap.append(head);
      if (ui.editing === addKey) wrap.append(addAssetForm(s));
    }
    const grid = el('div', 'grid');
    for (const item of sec.items) grid.append(card(item));
    wrap.append(grid);
    root.append(wrap);
  }
  if (hidden) {
    const more = el('div', 'empty');
    more.append(el('p', null, hidden + ' more ' + (hidden === 1 ? 'generation is' : 'generations are') + ' not shown.'));
    const b = el('button', null, 'Show all ' + items.length);
    b.type = 'button';
    b.onclick = () => { ui.limit = Infinity; render(); };
    more.append(b);
    root.append(more);
  }
}

function projectHeader(pr, count) {
  const head = el('section', 'project');
  const line = el('div', 'phead');
  line.append(el('h2', null, pr.id));
  const meta = el('div', 'meta');
  if (pr.name !== pr.id) meta.append(el('span', null, pr.name));
  meta.append(el('span', 'mono', shortPath(pr.manifest)));
  if (pr.account) meta.append(el('span', null, pr.account));
  if (pr.error) {
    meta.append(el('span', 'state-bad', 'unreadable: ' + pr.error));
  } else {
    meta.append(el('span', null, count + ' of ' + pr.items + ' shown · ' + pr.entries + ' lock ' + (pr.entries === 1 ? 'entry' : 'entries')));
    if (Object.keys(pr.spendByUnit).length) meta.append(el('span', null, fmtSpend(pr.spendByUnit)));
  }
  line.append(meta);
  head.append(line);
  return head;
}

// ---- editing (only when the server minted a session) ---------------------

function addAssetForm(style) {
  const pr = snap.workspace ? snap.workspace.projects.find((x) => x.id === style.project) : snap.project;
  const siblings = snap.styles.filter((x) => x.project === style.project);
  const form = el('form', 'edit');
  form.append(el('h3', null, 'New asset in ' + style.id));
  const id = el('input'); id.type = 'text'; id.placeholder = 'asset-id'; id.required = true; id.autocomplete = 'off';
  id.pattern = '[^/\\\\]+';
  const prompt = el('textarea'); prompt.placeholder = 'What to generate. The style adds its prefix and suffix.'; prompt.required = true;
  const width = numberInput(null, 'style default'), height = numberInput(null, 'style default');
  const category = el('input'); category.type = 'text'; category.placeholder = 'optional subfolder';
  const only = el('input'); only.type = 'checkbox'; only.checked = siblings.length > 1;
  const onlyField = el('label', 'field check'); onlyField.append(only, el('span', null, 'only in ' + style.id));
  const row1 = el('div', 'row'); row1.append(field('id', id), field('category', category));
  const row2 = el('div', 'row'); row2.append(field('width', width), field('height', height));
  form.append(row1, field('prompt', prompt), row2);
  if (siblings.length > 1) form.append(onlyField);
  const actions = el('div', 'actions');
  const save = el('button', 'primary', 'Add asset'); save.type = 'submit';
  const cancel = el('button', null, 'Cancel'); cancel.type = 'button'; cancel.onclick = () => { ui.editing = null; render(); };
  const msg = el('span', 'msg');
  actions.append(save, cancel, msg);
  form.append(actions);
  form.onsubmit = async (e) => {
    e.preventDefault();
    save.disabled = true; msg.className = 'msg'; msg.textContent = 'saving…';
    const asset = { prompt: prompt.value };
    if (numberOrNull(width) !== null) asset.width = numberOrNull(width);
    if (numberOrNull(height) !== null) asset.height = numberOrNull(height);
    if (category.value.trim()) asset.category = category.value.trim();
    if (siblings.length > 1 && only.checked) asset.styles = [style.id];
    try {
      const body = { action: 'add-asset', assetId: id.value.trim(), expectedSha256: pr.manifestSha256, asset };
      if (style.project) body.project = style.project;
      snap = await postEdit(body);
      const newId = (style.project ? style.project + ':' : '') + style.id + '/' + id.value.trim();
      ui.editing = null;
      ui.notice = { id: newId, text: 'Added to the manifest. Nothing is generated until you run pixelkiln gen.' };
      render();
      if (snap.items.some((i) => i.id === newId)) openItem(newId);
    } catch (err) {
      save.disabled = false;
      msg.className = 'msg bad';
      msg.textContent = err.message + (err.status === 409 ? ' — press Refresh.' : '');
    }
  };
  setTimeout(() => id.focus(), 0);
  return form;
}

function editForm(item) {
  const pr = projectOf(item);
  const a = item.asset;
  const styled = !!(a.promptByStyle && Object.hasOwn(a.promptByStyle, item.styleId));
  const form = el('form', 'edit');
  form.append(el('h3', null, 'Edit intent'));
  const scope = el('select');
  scope.append(new Option('Prompt for every style', 'all'), new Option('Prompt only for ' + item.styleId, 'style'));
  scope.value = styled ? 'style' : 'all';
  const prompt = el('textarea');
  prompt.value = styled ? a.promptByStyle[item.styleId] : a.prompt;
  scope.onchange = () => {
    prompt.value = scope.value === 'style' ? (a.promptByStyle?.[item.styleId] ?? a.prompt) : a.prompt;
  };
  const width = numberInput(a.width, 'style default'), height = numberInput(a.height, 'style default'), size = numberInput(a.size, 'style default');
  const category = el('input'); category.type = 'text'; category.value = a.category || '';
  const tags = el('input'); tags.type = 'text'; tags.value = (a.tags || []).join(', '); tags.placeholder = 'comma-separated';
  form.append(field('prompt', prompt, 'The style adds its prefix and suffix; the sent prompt is shown below.'), field('applies to', scope));
  const row = el('div', 'row'); row.append(field('width', width), field('height', height), field('size', size));
  form.append(row);
  const row2 = el('div', 'row');
  row2.append(field('category', category, 'Output subfolder. The existing file stays put; restore or gen writes the new path.'), field('tags', tags));
  form.append(row2);
  const actions = el('div', 'actions');
  const save = el('button', 'primary', 'Save to manifest'); save.type = 'submit';
  const cancel = el('button', null, 'Cancel'); cancel.type = 'button'; cancel.onclick = () => { ui.editing = null; renderDrawer(); };
  const msg = el('span', 'msg');
  actions.append(save, cancel, msg);
  form.append(actions);
  form.onsubmit = async (e) => {
    e.preventDefault();
    const patch = {};
    if (scope.value === 'style') {
      if (!styled || prompt.value !== a.promptByStyle[item.styleId]) patch.promptForStyle = { styleId: item.styleId, prompt: prompt.value };
    } else {
      if (prompt.value !== a.prompt) patch.prompt = prompt.value;
      if (styled) patch.promptForStyle = { styleId: item.styleId, prompt: null };
    }
    for (const [key, input] of [['width', width], ['height', height], ['size', size]]) {
      const next = numberOrNull(input);
      if (next !== (a[key] ?? null)) patch[key] = next;
    }
    const nextCategory = category.value.trim() || null;
    if (nextCategory !== (a.category || null)) patch.category = nextCategory;
    const nextTags = splitTags(tags.value);
    if (nextTags.join('\\u0000') !== (a.tags || []).join('\\u0000')) patch.tags = nextTags;
    if (!Object.keys(patch).length) { ui.editing = null; renderDrawer(); return; }
    save.disabled = true; msg.className = 'msg'; msg.textContent = 'saving…';
    try {
      const body = { action: 'patch-asset', assetId: item.assetId, expectedSha256: pr.manifestSha256, patch };
      if (item.project) body.project = item.project;
      snap = await postEdit(body);
      const after = snap.items.find((i) => i.id === item.id);
      ui.editing = null;
      ui.notice = {
        id: item.id,
        text: after
          ? 'Saved. plan now reports ' + after.state +
            (after.estimatedCost !== null && (after.state === 'stale' || after.state === 'missing')
              ? ' — ' + fmtCost(after.costUnit, after.estimatedCost) + ' to generate. Nothing is spent until you run pixelkiln gen.'
              : '.')
          : 'Saved.',
      };
      render();
    } catch (err) {
      save.disabled = false;
      msg.className = 'msg bad';
      msg.textContent = err.message + (err.status === 409 ? ' — press Refresh.' : '');
    }
  };
  setTimeout(() => prompt.focus(), 0);
  return form;
}

// ---- detail drawer -------------------------------------------------------

function row(dl, label, value, opts = {}) {
  if (value === null || value === undefined || value === '') return;
  dl.append(el('dt', null, label));
  const dd = el('dd', opts.mono ? 'mono' : null);
  if (value instanceof Node) dd.append(value); else dd.textContent = String(value);
  if (opts.copy) {
    const b = el('button', 'copy', 'copy');
    b.type = 'button';
    b.onclick = async () => {
      try { await navigator.clipboard.writeText(String(opts.copy)); b.textContent = 'copied'; }
      catch { b.textContent = 'select to copy'; }
      setTimeout(() => (b.textContent = 'copy'), 1200);
    };
    dd.append(b);
  }
  dl.append(dd);
}
function section(title) {
  const s = el('section', 'meta');
  s.append(el('h3', null, title));
  const dl = el('dl');
  s.append(dl);
  return { s, dl };
}
function stateNode(state, reason) {
  const box = el('div', 'status');
  const st = el('span', 'st state-' + STATE_TONE[state]);
  st.append(el('i', 'dot ' + STATE_TONE[state]), document.createTextNode(state));
  box.append(st, el('span', 'why', reason));
  return box;
}
function sibling(item, key) {
  return snap.items.find((i) => i.key === key && i.project === item.project);
}
function keyLink(item, key, label) {
  const b = el('button', 'linkish', label || key);
  b.type = 'button';
  const target = sibling(item, key);
  if (!target) { b.disabled = true; b.title = 'not in this snapshot'; }
  b.onclick = () => openItem(target.id);
  return b;
}
function jsonDetails(title, value) {
  const d = el('details');
  d.append(el('summary', null, title), el('pre', null, JSON.stringify(value, null, 2)));
  return d;
}

function stopPlayback() {
  if (ui.playing) { clearInterval(ui.playing); ui.playing = null; }
}

function renderPreview(item, host) {
  host.textContent = '';
  stopPlayback();
  const shown = item.outputs.filter((o) => o.url);
  const preview = el('div', 'preview');
  if (!shown.length) {
    preview.append(el('div', 'none', item.outputs.length ? 'The recorded file is not on disk. pixelkiln restore re-downloads it without spending.' : 'No output to show.'));
    host.append(preview);
    return;
  }
  const member = shown[Math.min(ui.member, shown.length - 1)] || shown[0];
  const frameSet = isFrameSet(item);
  const w = item.width, h = item.height;
  const box = Math.min(window.innerWidth, 540) - 62;
  const auto = displayScale(w, h, box, Math.min(window.innerHeight * 0.55, 560));
  const zoom = ui.zoom === 'auto' ? auto : ui.zoom === 'fit' ? Math.min(auto, 1) : Number(ui.zoom);
  const img = el('img');
  img.src = member.url; img.alt = member.role || item.assetId;
  if (zoom >= 1) { img.width = Math.round(w * zoom); img.height = Math.round(h * zoom); }
  else { img.style.maxWidth = '100%'; img.style.maxHeight = '55vh'; img.style.width = 'auto'; img.style.height = 'auto'; }
  preview.append(img);

  const zoomBar = el('div', 'zoom');
  zoomBar.append(el('span', null, 'zoom'));
  for (const z of ['fit', 1, 2, 4, 8]) {
    const b = el('button', ui.zoom === String(z) || (ui.zoom === 'auto' && z === auto) ? 'on' : null, z === 'fit' ? 'fit' : z + '×');
    b.type = 'button';
    b.onclick = () => { ui.zoom = String(z); renderPreview(item, host); };
    zoomBar.append(b);
  }
  const label = el('span', 'grow', w + '×' + h + (zoom >= 1 ? ' at ' + zoom + '×' : ' fitted'));
  zoomBar.append(label);
  if (frameSet && shown.length > 1) {
    const fps = item.fps || 12;
    const play = el('button', null, 'Play ' + fps + ' fps');
    play.type = 'button';
    let idx = shown.indexOf(member);
    play.onclick = () => {
      if (ui.playing) { stopPlayback(); play.textContent = 'Play ' + fps + ' fps'; return; }
      play.textContent = 'Pause';
      ui.playing = setInterval(() => {
        if (document.hidden) return;
        idx = (idx + 1) % shown.length;
        img.src = shown[idx].url;
        label.textContent = (shown[idx].role || 'frame ' + (idx + 1)) + ' · ' + w + '×' + h + (zoom >= 1 ? ' at ' + zoom + '×' : '');
        for (const [i, b] of [...host.querySelectorAll('.members button')].entries()) b.classList.toggle('on', i === idx);
      }, Math.max(16, Math.round(1000 / fps)));
    };
    zoomBar.append(play);
  }
  host.append(preview, zoomBar);

  if (shown.length > 1) {
    const strip = el('div', 'members');
    shown.forEach((o, i) => {
      const b = el('button', o === member ? 'on' : null);
      b.type = 'button';
      const t = el('img'); t.src = o.url; t.alt = o.role || 'output ' + (i + 1); t.loading = 'lazy';
      b.append(t, el('span', null, o.role || String(i + 1)));
      b.onclick = () => { ui.member = i; renderPreview(item, host); };
      strip.append(b);
    });
    host.append(strip);
  }
}

function renderDrawer() {
  const host = $('drawer-host');
  host.textContent = '';
  stopPlayback();
  const item = ui.open && snap.items.find((i) => i.id === ui.open);
  if (!item) { ui.open = null; return; }
  const items = visibleItems();
  const pos = items.findIndex((i) => i.id === item.id);

  const scrim = el('div', 'scrim');
  scrim.onclick = () => closeItem();
  const drawer = el('aside', 'drawer');
  drawer.setAttribute('role', 'dialog');
  drawer.setAttribute('aria-label', item.id);

  const head = el('div', 'dhead');
  const title = el('div', 'title');
  if (item.project) title.append(el('span', 'sid project', item.project), ' ');
  title.append(el('span', 'sid', item.styleId), el('div', 'aid', item.assetId));
  const nav = el('div', 'nav');
  const prev = el('button', null, '←'); prev.type = 'button'; prev.title = 'Previous (←)';
  prev.disabled = pos <= 0; prev.onclick = () => step(-1);
  const next = el('button', null, '→'); next.type = 'button'; next.title = 'Next (→)';
  next.disabled = pos < 0 || pos >= items.length - 1; next.onclick = () => step(1);
  const close = el('button', null, 'Close'); close.type = 'button'; close.onclick = () => closeItem();
  const canEdit = EDITABLE && item.declared && item.asset && projectOf(item)?.manifestSha256;
  if (canEdit) {
    const edit = el('button', null, ui.editing === item.id ? 'Cancel edit' : 'Edit');
    edit.type = 'button';
    edit.onclick = () => { ui.editing = ui.editing === item.id ? null : item.id; ui.notice = null; renderDrawer(); };
    nav.append(edit);
  }
  nav.append(prev, next, close);
  head.append(title, nav);

  const body = el('div', 'dbody');
  const previewHost = el('div');
  renderPreview(item, previewHost);
  body.append(previewHost);
  if (ui.notice && ui.notice.id === item.id) body.append(el('div', 'notice', ui.notice.text));
  body.append(stateNode(item.state, item.reason));
  if (canEdit && ui.editing === item.id) body.append(editForm(item));
  // Plan already quotes the error as the reason for a failed entry; only a
  // stale or superseded failure needs its own line.
  if (item.error && !item.reason.includes(item.error)) body.append(stateNode('failed', item.error));

  // Generation — what was sent and what it cost.
  {
    const { s, dl } = section('Generation');
    row(dl, 'provider', item.provider);
    row(dl, 'generator', item.generator + (item.tileFeature ? ' · ' + item.tileFeature : ''));
    row(dl, 'lock status', item.status || 'none — nothing submitted');
    const pr = el('div', 'prompt', item.prompt); row(dl, item.status ? 'prompt sent' : 'prompt', pr);
    if (item.currentPrompt) row(dl, 'prompt now', el('div', 'prompt state-warn', item.currentPrompt));
    row(dl, 'size', item.width + ' × ' + item.height + ' px');
    if (item.status) row(dl, 'cost', fmtCost(item.costUnit, item.cost));
    if (item.estimatedCost !== null && (item.estimatedCost !== item.cost || !item.status)) {
      row(dl, 'estimate now', fmtCost(item.costUnit, item.estimatedCost) +
        (item.candidates && item.candidates > 1 ? ' for ' + item.candidates + ' candidates' : ''));
    }
    if (item.candidateIndex !== null) row(dl, 'candidate', '#' + (item.candidateIndex + 1) + ' chosen in review');
    row(dl, 'submitted', fmtWhen(item.submittedAt));
    row(dl, 'downloaded', fmtWhen(item.downloadedAt));
    row(dl, 'job id', item.jobId, { mono: true, copy: item.jobId });
    row(dl, 'object id', item.objectId, { mono: true, copy: item.objectId });
    row(dl, 'review object', item.reviewObjectId, { mono: true, copy: item.reviewObjectId });
    body.append(s);
  }

  // Outputs — every file with its hash and whether it is really there.
  {
    const s = el('section', 'meta');
    s.append(el('h3', null, item.outputs.length === 1 ? 'Output' : 'Outputs (' + item.outputs.length + ')'));
    if (!item.outputs.length) s.append(el('div', 'state-dim', item.source ? 'placed from ' + item.source : 'none recorded'));
    for (const o of item.outputs) {
      const box = el('div', 'out');
      const role = el('div', 'role');
      role.append(document.createTextNode(o.role || (item.outputs.length > 1 ? 'primary' : 'file')));
      if (!o.exists) role.append(el('span', 'miss', 'missing on disk'));
      if (o.url) { const a = el('a', null, 'open'); a.href = o.url.split('?')[0]; a.target = '_blank'; a.rel = 'noopener'; role.append(a); }
      box.append(role);
      const dl = el('dl');
      row(dl, 'path', o.path, { mono: true, copy: o.absolutePath });
      row(dl, 'sha256', o.sha256 ? o.sha256.slice(0, 16) + '…' : (o.exists ? 'not recorded' : null), { mono: true, copy: o.sha256 || undefined });
      row(dl, 'bytes', o.exists ? fmtBytes(o.bytes) : null);
      row(dl, 'type', o.mediaType);
      box.append(dl);
      s.append(box);
    }
    body.append(s);
  }

  if (item.revision || item.revisionParentKey) {
    const { s, dl } = section('Lineage');
    row(dl, 'mode', item.revision ? item.revision.mode : (item.asset && item.asset.revision && item.asset.revision.mode));
    if (item.revisionParentKey) row(dl, 'parent', keyLink(item, item.revisionParentKey));
    if (item.revision) {
      row(dl, 'parent sha256', item.revision.sourceSha256.slice(0, 16) + '…', { mono: true, copy: item.revision.sourceSha256 });
      if (item.revision.maskSha256) row(dl, 'mask sha256', item.revision.maskSha256.slice(0, 16) + '…', { mono: true, copy: item.revision.maskSha256 });
      if (item.revision.strength !== undefined) row(dl, 'strength', item.revision.strength);
    }
    body.append(s);
  }
  const children = snap.items.filter((i) => i.revisionParentKey === item.key && i.project === item.project);
  if (children.length) {
    const { s, dl } = section('Revisions from this asset');
    for (const c of children) row(dl, c.revision ? c.revision.mode : 'child', keyLink(item, c.key));
    body.append(s);
  }

  if (item.quality) {
    const q = item.quality;
    const { s, dl } = section('Quality');
    const tone = q.state === 'approved' ? 'ok' : q.state === 'blocked' ? 'bad' : 'warn';
    const st = el('span', 'state-' + tone); st.append(el('i', 'dot ' + tone + ' '), document.createTextNode(' ' + q.state));
    row(dl, 'state', st);
    row(dl, 'why', q.reason);
    if (q.review) {
      row(dl, 'review', q.review.status === 'approved'
        ? 'approved by ' + q.review.reviewer + ' · ' + fmtWhen(q.review.approvedAt)
        : 'pending human 1× review');
      if (q.review.status === 'approved' && q.review.note) row(dl, 'note', q.review.note);
    }
    if (q.palette) {
      const pal = el('div', 'pal');
      for (const c of q.palette) { const i = el('i'); i.style.background = c; i.title = c; pal.append(i); }
      row(dl, 'palette', pal);
      row(dl, 'colors', q.palette.length + ' declared' + (q.audit ? ', ' + q.audit.colorCount + ' used' : ''));
    }
    if (q.nativeGrid) {
      row(dl, 'native grid', q.nativeGrid.sourceWidth + '×' + q.nativeGrid.sourceHeight + ' → ' +
        q.nativeGrid.nativeWidth + '×' + q.nativeGrid.nativeHeight + ' (step ' + q.nativeGrid.stepX + '×' + q.nativeGrid.stepY +
        ', ' + q.nativeGrid.confidence + ' confidence)');
    }
    if (q.audit) row(dl, 'audit', (q.audit.safe ? 'passed' : 'failed') + ' · ' + Math.round(q.audit.transparency * 100) + '% transparent' +
      (q.audit.reasons.length ? ' · ' + q.audit.reasons.join('; ') : ''));
    if (q.frameSet) row(dl, 'frame set', q.frameSet.count + ' frames at ' + q.frameSet.fps + ' fps');
    row(dl, 'output', q.output, { mono: true });
    row(dl, 'record', q.record + (q.recordExists ? '' : ' (not written yet)'), { mono: true });
    if (q.check && !q.check.safe) row(dl, 'check', el('div', 'state-warn', q.check.reasons.join('\\n')));
    body.append(s);
    if (q.outputs.some((o) => o.url)) {
      const strip = el('div', 'members');
      for (const o of q.outputs.filter((o) => o.url)) {
        const b = el('button'); b.type = 'button';
        const t = el('img'); t.src = o.url; t.alt = 'refined ' + (o.role || item.assetId);
        b.append(t, el('span', null, 'refined')); b.onclick = () => window.open(o.url.split('?')[0], '_blank');
        strip.append(b);
      }
      s.append(strip);
    }
  }

  {
    const { s, dl } = section('Identity');
    if (item.project) row(dl, 'project', item.project);
    row(dl, 'lock key', item.key, { mono: true, copy: item.key });
    if (item.recordedSpecHash) {
      row(dl, 'spec hash', item.recordedSpecHash.slice(0, 16) + '…', { mono: true, copy: item.recordedSpecHash });
    }
    if (item.currentSpecHash && item.currentSpecHash !== item.recordedSpecHash) {
      row(dl, item.recordedSpecHash ? 'spec hash now' : 'spec hash',
        el('span', item.recordedSpecHash ? 'state-warn' : null, item.currentSpecHash.slice(0, 16) + '…'), { mono: true, copy: item.currentSpecHash });
    }
    row(dl, 'declared', item.declared ? 'yes' : 'no — the manifest no longer has this asset in this style');
    row(dl, 'category', item.category);
    row(dl, 'tags', item.tags && item.tags.length ? item.tags.join(', ') : null);
    row(dl, 'source art', item.source, { mono: true });
    body.append(s);
  }

  if (item.asset) {
    // Show the asset as the author would write it: schema defaults that are
    // empty add nothing but noise to a record.
    const declared = Object.fromEntries(Object.entries(item.asset).filter(([, v]) =>
      !(Array.isArray(v) && !v.length) && !(v && typeof v === 'object' && !Array.isArray(v) && !Object.keys(v).length)));
    body.append(jsonDetails('Manifest asset', declared));
  }
  if (item.providerMetadata && Object.keys(item.providerMetadata).length) {
    body.append(jsonDetails('Provider metadata', item.providerMetadata));
  }

  drawer.append(head, body);
  host.append(scrim, drawer);
  close.focus({ preventScroll: true });
}

// View state lives in the URL — filters and sort in the query, the open
// record in the hash — so a link to "every failed generation" or to one
// specific record can be pasted into a review thread and land there.
function readUrlState() {
  const params = new URLSearchParams(location.search);
  const list = (name) => (params.get(name) || '').split(',').map((v) => v.trim()).filter(Boolean);
  ui.q = params.get('q') || '';
  ui.states = new Set(list('state'));
  ui.providers = new Set(list('provider'));
  ui.generators = new Set(list('generator'));
  ui.projects = new Set(list('project'));
  if (['key', 'newest', 'oldest', 'cost', 'size'].includes(params.get('sort'))) ui.sort = params.get('sort');
  if (['style', 'none'].includes(params.get('group'))) ui.group = params.get('group');
}
function writeUrlState() {
  const params = new URLSearchParams();
  if (ui.q) params.set('q', ui.q);
  if (ui.states.size) params.set('state', [...ui.states].join(','));
  if (ui.providers.size) params.set('provider', [...ui.providers].join(','));
  if (ui.generators.size) params.set('generator', [...ui.generators].join(','));
  if (ui.projects.size) params.set('project', [...ui.projects].join(','));
  if (ui.sort !== 'key') params.set('sort', ui.sort);
  if (ui.group !== 'style') params.set('group', ui.group);
  const query = params.toString();
  const next = location.pathname + (query ? '?' + query : '') + (ui.open ? '#' + encodeURIComponent(ui.open) : '');
  if (next !== location.pathname + location.search + location.hash) history.replaceState(null, '', next);
}
function syncHash() { writeUrlState(); }
function keyFromHash() {
  try { return location.hash.length > 1 ? decodeURIComponent(location.hash.slice(1)) : null; }
  catch { return null; }
}
// Opening a record must not rebuild the grid: at a few thousand cards that
// is a visible pause, and nothing in the grid changes except one highlight.
function markActive(key) {
  document.querySelector('.card.active')?.classList.remove('active');
  const card = key && document.querySelector('.card[data-key="' + CSS.escape(key) + '"]');
  if (card) card.classList.add('active');
  return card;
}
function openItem(key) {
  if (ui.open !== key) { ui.editing = null; if (ui.notice && ui.notice.id !== key) ui.notice = null; }
  ui.open = key; ui.member = 0; ui.zoom = 'auto';
  syncHash();
  const card = markActive(key);
  renderDrawer();
  if (card) card.scrollIntoView({ block: 'nearest' });
}
function closeItem() {
  const key = ui.open;
  ui.open = null;
  ui.editing = null;
  ui.notice = null;
  syncHash();
  const card = markActive(null);
  renderDrawer();
  const focus = key && document.querySelector('.card[data-key="' + CSS.escape(key) + '"]');
  if (focus) focus.focus({ preventScroll: true });
}
window.addEventListener('hashchange', () => {
  const key = keyFromHash();
  if (key && key !== ui.open && snap.items.some((i) => i.id === key)) openItem(key);
  else if (!key && ui.open) closeItem();
});
function step(delta) {
  const items = visibleItems();
  const pos = items.findIndex((i) => i.id === ui.open);
  const next = items[pos + delta];
  if (next) openItem(next.id);
}

function render() {
  writeUrlState();
  renderHeader();
  renderMain(visibleItems());
  renderDrawer();
}

// ---- refresh --------------------------------------------------------------

let refreshing = false;
async function refresh() {
  if (refreshing) return;
  refreshing = true;
  const b = $('refresh');
  b.disabled = true;
  try {
    const res = await fetch('/api/gallery.json', { cache: 'no-store' });
    if (!res.ok) throw new Error(await res.text());
    snap = await res.json();
    $('note').textContent = '';
    render();
  } catch (err) {
    $('note').textContent = ' Refresh failed: ' + err.message + ' — is pixelkiln gallery still running?';
  } finally {
    refreshing = false;
    b.disabled = false;
  }
}
$('refresh').onclick = refresh;
let autoTimer = null;
$('auto').onchange = (e) => {
  if (autoTimer) clearInterval(autoTimer);
  autoTimer = e.target.checked ? setInterval(() => { if (!document.hidden) refresh(); }, 5000) : null;
};

// ---- input ----------------------------------------------------------------

let searchTimer = null;
$('q').addEventListener('input', (e) => {
  ui.q = e.target.value;
  clearTimeout(searchTimer);
  searchTimer = setTimeout(render, 90);
});
$('sort').onchange = (e) => { ui.sort = e.target.value; render(); };
$('group').onchange = (e) => { ui.group = e.target.value; render(); };
document.addEventListener('keydown', (e) => {
  const typing = /^(INPUT|SELECT|TEXTAREA)$/.test(document.activeElement?.tagName || '');
  if (e.key === '/' && !typing) { e.preventDefault(); $('q').focus(); return; }
  if (e.key === 'Escape') {
    if (typing && document.activeElement.id === 'q') { document.activeElement.blur(); return; }
    if (ui.open) { e.preventDefault(); closeItem(); }
    return;
  }
  if (ui.open && !typing) {
    if (e.key === 'ArrowLeft') { e.preventDefault(); step(-1); }
    else if (e.key === 'ArrowRight') { e.preventDefault(); step(1); }
  }
});
document.addEventListener('visibilitychange', () => { if (document.hidden) stopPlayback(); });

readUrlState();
$('q').value = ui.q;
$('sort').value = ui.sort;
$('group').value = ui.group;
const initialKey = keyFromHash();
if (initialKey && snap.items.some((i) => i.id === initialKey)) ui.open = initialKey;
render();
if (ui.open) document.querySelector('.card.active')?.scrollIntoView({ block: 'center' });
</script>
</body>
</html>`
}

const escapeHtml = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!)
