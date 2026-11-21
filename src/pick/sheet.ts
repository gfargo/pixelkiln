import type { RevisionMode } from "../types.ts"

export interface SheetGroup {
  key: string
  assetId: string
  styleId: string
  prompt: string
  reviewObjectId: string
  frameUrls: string[]
  width: number
  height: number
  mode?: "candidates" | "frame-set"
  frameLabels?: string[]
  /** Each frame's own size where it could be read (a locally cached PNG); null or absent, the sheet reads it off the loaded image. */
  frameSizes?: ({ width: number; height: number } | null)[]
  fps?: number
  revision?: {
    mode: RevisionMode
    sourceAssetId: string
    sourceUrl: string
    width: number
    height: number
  }
  /** The art this generation replaces, shown beside the candidates. */
  current?: {
    url: string
    width: number
    height: number
  }
  /**
   * A batch member's declared slot in the shared candidate set (confirmed
   * live: `item_descriptions[i]` reliably lands at candidate index `i`; see
   * docs/GENERATORS.md#1dir). The page starts that asset on this candidate
   * instead of the first: still a starting point, not an auto-pick.
   */
  recommendedIndex?: number
}

export interface RenderSheetOptions {
  /** Where selections are POSTed. Default `/apply`, the standalone review server. */
  applyUrl?: string
  /** Extra headers on every request the page makes, e.g. a gallery session token. */
  applyHeaders?: Record<string, string>
  /**
   * Hosted inside another page: after a successful apply the sheet tells its
   * parent window (same origin only) so the host can close it and refresh.
   */
  embedded?: boolean
  /** GET: the live groups, saved selections and reroll progress. Absent, the page keeps selections in the browser only. */
  sessionUrl?: string
  /** POST `{ key, chosen, flagged, later }`: saves one asset's selection to the review state. */
  stateUrl?: string
  /** POST `{ key }`: regenerates one asset with `--force` inside the running review. Absent, the page offers no reroll. */
  rerollUrl?: string
}

const escapeHtml = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!)

/**
 * Groups as the page receives them. Prompts and ids are author-controlled but
 * arbitrary text, and they reach the page both as JSON inside a <script> and
 * as text in the DOM: escape HTML entities here, and `<\/` where the JSON is
 * embedded, so neither path can break out.
 */
export function renderableGroups(groups: SheetGroup[]): SheetGroup[] {
  return groups.map((g) => ({
    ...g,
    styleId: escapeHtml(g.styleId),
    assetId: escapeHtml(g.assetId),
    prompt: escapeHtml(g.prompt),
    ...(g.revision ? { revision: { ...g.revision, sourceAssetId: escapeHtml(g.revision.sourceAssetId) } } : {}),
  }))
}

const json = (value: unknown) => JSON.stringify(value).replace(/<\//g, "<\\/")

/**
 * The review queue: every asset waiting on a human choice.
 *
 * Built for 50+ assets in one sitting. A master list on the left holds one
 * compact row per asset with its candidate already playing; the stage on the
 * right shows the current asset at the largest integer scale that fits, with
 * the art it replaces one key away. Frames stay hidden until the strip is
 * opened. Every action has a key, and every choice is saved to the server as
 * it is made, so a refresh or a restarted run reopens where it was left.
 *
 * Each frame URL is loaded once into one Image and drawn to canvases from
 * there, so the list thumbnail, the stage and the strip share one request.
 */
export function renderSheet(groups: SheetGroup[], options: RenderSheetOptions = {}): string {
  const config = {
    applyUrl: options.applyUrl ?? "/apply",
    headers: options.applyHeaders ?? {},
    embedded: options.embedded === true,
    sessionUrl: options.sessionUrl ?? null,
    stateUrl: options.stateUrl ?? null,
    rerollUrl: options.rerollUrl ?? null,
  }
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Review candidates | pixelkiln</title>
<style>
  /*
   * True-black flat, warmed for a kiln: elevation by lightness alone
   * (ground, surface, raised), no borders on panels, no shadows at rest.
   * The ember is the one hue and lives only on data: an accepted asset, the
   * chosen frame. Flagged frames take the negative pair. Buttons are neutral;
   * the one primary (Apply) is an inverted white pill.
   */
  :root {
    --ground:#0e0d0c; --surface:#181716; --raised:#26241f; --hover:#1f1d1a; --rule:#22201d;
    --text:#ffffff; --muted:#b4b4b4; --faint:#949494; --control:#46423b;
    --ember:#ff6b35; --ember-bg:#2e1a10;
    --negative:#e5566f; --negative-bg:#2c1a20;
    --list:340px; --head:56px; --pad:22px; --gap:14px; --row:56px;
    --radius-card:14px; --radius-chip:6px;
    --font: ui-sans-serif, -apple-system, "SF Pro Text", "Segoe UI", system-ui, sans-serif;
    --mono: ui-monospace, SFMono-Regular, Menlo, monospace;
    color-scheme: dark;
  }
  * { box-sizing:border-box; }
  html, body { height:100%; }
  body { margin:0; background:var(--ground); color:var(--text); font:14px/1.45 var(--font);
    display:grid; grid-template-rows:auto minmax(0,1fr) auto; overflow:hidden; }
  button { font:inherit; color:inherit; background:none; border:0; cursor:pointer; }
  button:focus-visible, [tabindex]:focus-visible { outline:2px solid var(--text); outline-offset:2px; }
  .num { font-variant-numeric:tabular-nums; }
  .id { font-family:var(--mono); font-size:12px; }

  /* Top bar */
  header { display:flex; align-items:center; gap:20px; min-height:var(--head); padding:0 var(--pad); border-bottom:1px solid var(--rule); min-width:0; }
  .break { display:none; }
  .mark { font-weight:600; display:flex; align-items:center; gap:8px; white-space:nowrap; }
  .mark svg { display:block; }
  .counter { color:var(--muted); white-space:nowrap; }
  .counter b { color:var(--text); font-weight:600; }
  .filters { display:flex; gap:2px; margin-left:8px; }
  .filters button { height:32px; padding:0 10px; border-radius:var(--radius-chip); color:#bbb; white-space:nowrap; }
  .filters button:hover { background:var(--hover); }
  .filters button[aria-pressed="true"] { color:var(--text); background:var(--raised); }
  .filters .n { color:var(--faint); margin-left:6px; }
  .grow { flex:1; }
  .batch { display:flex; gap:2px; }
  .batch button, .tool { height:32px; padding:0 10px; border-radius:var(--radius-chip); color:#bbb; white-space:nowrap; }
  .batch button:hover, .tool:hover { background:var(--hover); color:var(--text); }
  .primary { height:36px; padding:0 18px; border-radius:999px; background:var(--text); color:#000; font-weight:600; white-space:nowrap; }
  .primary:disabled { background:var(--raised); color:var(--faint); cursor:not-allowed; }
  #status { color:var(--muted); white-space:nowrap; overflow:hidden; text-overflow:ellipsis; max-width:28ch; }
  #status.error { color:var(--negative); }

  /* Master list */
  main { display:grid; grid-template-columns:var(--list) minmax(0,1fr); min-height:0; }
  #list { overflow-y:auto; border-right:1px solid var(--rule); padding:8px; scroll-padding:8px; outline:none; }
  .row { display:grid; grid-template-columns:44px minmax(0,1fr) auto; align-items:center; gap:12px;
    width:100%; height:var(--row); padding:6px 10px 6px 6px; border-radius:10px; text-align:left; }
  .row:hover { background:var(--hover); }
  .row[aria-selected="true"] { background:var(--raised); }
  .thumb { width:44px; height:44px; border-radius:8px; background:var(--surface); display:grid; place-items:center; overflow:hidden; }
  .thumb canvas { image-rendering:pixelated; display:block; }
  .row .name { display:block; font-weight:500; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
  .row .meta { display:block; color:var(--faint); font-size:13px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
  .state { font-size:13px; color:var(--faint); white-space:nowrap; }
  .state.accepted { color:var(--ember); }
  .state.flagged { color:var(--negative); }
  .state.later, .state.rerolling { color:var(--muted); }
  .empty { color:var(--muted); padding:24px 12px; }

  /* Stage */
  #stage { display:grid; grid-template-rows:auto minmax(0,1fr) auto auto; min-width:0; min-height:0; padding:18px var(--pad) 16px; gap:var(--gap); }
  .title { display:flex; align-items:baseline; gap:12px; min-width:0; }
  .title h1 { font-size:20px; font-weight:600; margin:0; white-space:nowrap; }
  .title .id { color:var(--faint); white-space:nowrap; }
  .title .pos { margin-left:auto; color:var(--faint); white-space:nowrap; }
  .prompt { color:var(--muted); margin:4px 0 0; max-width:90ch; display:-webkit-box; -webkit-line-clamp:2; -webkit-box-orient:vertical; overflow:hidden; }
  .view { position:relative; min-height:0; border-radius:var(--radius-card); background-color:var(--surface);
    background-image:linear-gradient(45deg,#ffffff08 25%,transparent 25%,transparent 75%,#ffffff08 75%),
      linear-gradient(45deg,#ffffff08 25%,transparent 25%,transparent 75%,#ffffff08 75%);
    background-size:16px 16px; background-position:0 0,8px 8px;
    display:grid; place-items:center; overflow:hidden; }
  .view canvas { image-rendering:pixelated; display:block; }
  .view .tag { position:absolute; left:14px; top:12px; color:var(--muted); font-size:13px; }
  .view .tag b { color:var(--text); font-weight:500; }
  .view .scale { position:absolute; right:14px; top:12px; color:var(--faint); font-size:13px; }
  .view .notice { position:absolute; inset:auto 14px 12px 14px; color:var(--muted); font-size:13px; }
  .view.flipped .tag b { color:var(--ember); }
  .controls { display:flex; align-items:center; gap:4px; flex-wrap:wrap; }
  .tool[aria-pressed="true"] { color:var(--text); background:var(--raised); }
  .tool kbd, .act kbd { color:var(--faint); margin-left:6px; font:13px var(--font); }
  .tool:disabled { color:#8f8a82; cursor:default; background:none; }
  .actions { display:flex; gap:6px; margin-left:auto; }
  .act { height:36px; padding:0 14px; border-radius:999px; background:var(--raised); white-space:nowrap; }
  .act:hover { background:#34312b; }
  .act.on { background:var(--ember-bg); color:var(--ember); }
  .act.warn { background:var(--negative-bg); color:var(--negative); }
  .act:disabled { color:var(--faint); background:var(--surface); cursor:default; }

  /* Frame strip */
  .strip { display:flex; gap:6px; overflow-x:auto; padding-bottom:4px; scroll-padding:8px; }
  .strip[hidden] { display:none; }
  .cell { flex:0 0 auto; display:flex; flex-direction:column; align-items:center; gap:4px; padding:6px; border-radius:10px; min-width:64px; }
  .cell:hover { background:var(--hover); }
  .cell .pic { display:grid; place-items:center; background:var(--surface); border-radius:6px; padding:4px; }
  .cell canvas { image-rendering:pixelated; display:block; }
  .cell .lab { font-size:13px; color:var(--faint); }
  .cell[aria-current="true"] { background:var(--raised); }
  .cell[aria-current="true"] .lab { color:var(--text); }
  .cell.chosen .pic { box-shadow:inset 0 -3px 0 var(--ember); }
  .cell.chosen .lab { color:var(--ember); }
  .cell.flag .pic { box-shadow:inset 0 0 0 2px var(--negative); }
  .cell.flag .lab { color:var(--negative); }

  footer { display:flex; gap:18px; flex-wrap:wrap; padding:8px var(--pad); border-top:1px solid var(--rule); color:var(--faint); font-size:12px; }
  footer kbd { font:12px var(--font); color:var(--muted); }
  body.done main { opacity:.5; pointer-events:none; }

  @media (max-width: 1240px) {
    header { flex-wrap:wrap; row-gap:4px; padding:8px var(--pad); }
    .break { display:block; flex-basis:100%; height:0; order:5; }
    .filters { order:6; margin-left:-10px; }
    .batch { order:7; margin-left:auto; }
  }
  @media (max-width: 900px) {
    body { overflow:auto; grid-template-rows:auto auto auto; height:auto; }
    header { flex-wrap:wrap; padding:10px 16px; gap:10px; }
    .filters { margin-left:0; overflow-x:auto; max-width:100%; }
    main { grid-template-columns:1fr; }
    #list { max-height:38vh; border-right:0; border-bottom:1px solid var(--rule); }
    #stage { padding:14px 16px; grid-template-rows:auto 56vh auto auto; }
    .actions { margin-left:0; flex-wrap:wrap; }
  }
  @media (prefers-reduced-motion: reduce) { * { scroll-behavior:auto !important; } }
</style>
</head>
<body>
<header>
  <span class="mark"><svg width="14" height="14" viewBox="0 0 7 7" aria-hidden="true" shape-rendering="crispEdges"><path fill="#ff6b35" d="M3 0h1v1h1v1h1v1h1v1H6v1H5v1H4v1H3V6H2V5H1V4H0V3h1V2h1V1h1z"/></svg>pixelkiln</span>
  <span class="counter num" id="counter" aria-live="polite"></span>
  <nav class="filters" id="filters" aria-label="Filter by status"></nav>
  <span class="grow"></span>
  <span id="status" role="status"></span>
  <div class="batch">
    <button type="button" id="select-all" title="Accept every asset in this view (Shift+S)">Select all</button>
    <button type="button" id="deselect-all" title="Clear every acceptance (Shift+D)">Deselect all</button>
    <button type="button" id="accept-unflagged" title="Accept every undecided asset with no flags (Shift+A)">Accept unflagged</button>
  </div>
  <button type="button" class="primary num" id="apply" disabled>Apply</button>
  <span class="break"></span>
</header>
<main>
  <div id="list" role="listbox" aria-label="Assets awaiting review" tabindex="0"></div>
  <section id="stage" aria-label="Current asset">
    <div>
      <div class="title"><h1 id="s-name"></h1><span class="id" id="s-key"></span><span class="pos num" id="s-pos"></span></div>
      <p class="prompt" id="s-prompt"></p>
    </div>
    <div class="view" id="view">
      <canvas id="s-canvas" aria-label="Animated frame-set preview"></canvas>
      <span class="tag" id="s-tag"></span>
      <span class="scale num" id="s-scale"></span>
      <span class="notice" id="s-notice"></span>
    </div>
    <div class="controls">
      <button type="button" class="tool" id="t-play" aria-pressed="false">Pause<kbd>Space</kbd></button>
      <button type="button" class="tool" id="t-flip" aria-pressed="false">Show current art<kbd>C</kbd></button>
      <button type="button" class="tool" id="t-strip" aria-pressed="false">Frames<kbd>X</kbd></button>
      <button type="button" class="tool" id="t-onion" aria-pressed="false">Onion skin<kbd>O</kbd></button>
      <button type="button" class="tool" id="t-pong" aria-pressed="false">Ping-pong<kbd>P</kbd></button>
      <div class="actions">
        <button type="button" class="act" id="a-flag">Flag frame<kbd>F</kbd></button>
        <button type="button" class="act" id="a-later">Later<kbd>L</kbd></button>
        <button type="button" class="act" id="a-reroll">Reroll<kbd>R</kbd></button>
        <button type="button" class="act" id="a-accept">Accept<kbd>A</kbd></button>
      </div>
    </div>
    <div class="strip" id="strip" role="listbox" aria-label="Frames" hidden></div>
  </section>
</main>
<footer>
  <span><kbd>↑</kbd> <kbd>↓</kbd> asset</span>
  <span><kbd>←</kbd> <kbd>→</kbd> frame or candidate</span>
  <span><kbd>A</kbd> accept</span>
  <span><kbd>F</kbd> flag frame</span>
  <span><kbd>L</kbd> later</span>
  <span><kbd>R</kbd> reroll</span>
  <span><kbd>X</kbd> frames</span>
  <span><kbd>C</kbd> compare</span>
  <span><kbd>1</kbd>–<kbd>5</kbd> filter</span>
  <span><kbd>Shift</kbd>+<kbd>A</kbd> accept unflagged</span>
  <span><kbd>⌘</kbd>/<kbd>Ctrl</kbd>+<kbd>Enter</kbd> apply</span>
  <span>Unaccepted assets stay in review; closing this page loses nothing.</span>
</footer>
<script>
const CONFIG = ${json(config)};
let GROUPS = ${json(renderableGroups(groups))};
${CLIENT}
</script>
</body>
</html>`
}

/*
 * The page script. Plain ES2020, no framework. Kept as a string here (no
 * backticks or template holes inside) so the page stays one static document.
 */
const CLIENT = String.raw`
const $ = (id) => document.getElementById(id);
const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
const STORE = 'pixelkiln-pick:';
const FILTERS = [
  ['all', 'All'], ['undecided', 'Undecided'], ['accepted', 'Accepted'], ['flagged', 'Flagged'], ['later', 'Later'],
];

let state = {};          // key -> { chosen, flagged, later }
let rerolls = {};        // key -> { state, error }
let canReroll = Boolean(CONFIG.rerollUrl);
let filter = 'all';
let currentKey = GROUPS[0] ? GROUPS[0].key : null;
let cursor = {};         // key -> frame or candidate index on the stage
let playing = !reduced;
let flipped = 0;         // 0 candidate, then each comparison the asset has
let showStrip = false, onion = false, pingpong = false;
let armedReroll = null, armedTimer = null;
let applying = false;

// ---- one request per frame -------------------------------------------------
const images = new Map();
function image(url) {
  let entry = images.get(url);
  if (!entry) {
    const img = new Image();
    img.decoding = 'async';
    entry = { img, ready: false, failed: false };
    img.onload = () => { entry.ready = true; dirty = true; };
    img.onerror = () => { entry.failed = true; dirty = true; };
    img.src = url;
    images.set(url, entry);
  }
  return entry;
}

// ---- state -----------------------------------------------------------------
const blank = () => ({ chosen: null, flagged: [], later: false });
const group = (key) => GROUPS.find((g) => g.key === key);
const st = (key) => state[key] || (state[key] = blank());
function statusOf(g) {
  if (rerolls[g.key] && rerolls[g.key].state === 'running') return 'rerolling';
  const s = st(g.key);
  if (s.chosen !== null) return 'accepted';
  if (s.flagged.length) return 'flagged';
  if (s.later) return 'later';
  return 'undecided';
}
function inFilter(g) {
  const s = statusOf(g);
  return filter === 'all' || s === filter || (filter === 'undecided' && s === 'rerolling');
}
const visible = () => GROUPS.filter(inFilter);
const isSet = (g) => g.mode === 'frame-set';
const startIndex = (g) => (g.recommendedIndex != null && g.recommendedIndex < g.frameUrls.length ? g.recommendedIndex : 0);
const cur = (g) => (cursor[g.key] != null ? cursor[g.key] : (cursor[g.key] = startIndex(g)));

function localKey(g) { return STORE + g.reviewObjectId + ':' + g.key; }
function remember(g) {
  try { localStorage.setItem(localKey(g), JSON.stringify(st(g.key))); } catch (e) { /* private mode */ }
}
function recall(g) {
  try {
    const raw = localStorage.getItem(localKey(g));
    if (raw) state[g.key] = Object.assign(blank(), JSON.parse(raw));
  } catch (e) { /* ignore */ }
}

const pending = new Map();
function save(g) {
  remember(g);
  if (!CONFIG.stateUrl) return;
  clearTimeout(pending.get(g.key));
  pending.set(g.key, setTimeout(async () => {
    pending.delete(g.key);
    try {
      const res = await fetch(CONFIG.stateUrl, {
        method: 'POST',
        headers: Object.assign({ 'Content-Type': 'application/json' }, CONFIG.headers),
        body: JSON.stringify(Object.assign({ key: g.key }, st(g.key))),
      });
      if (!res.ok) throw new Error(await res.text());
    } catch (err) {
      say('Could not save ' + g.assetId + ': ' + err.message + '. It is kept in this browser.', true);
    }
  }, 200));
}

// ---- rendering: list -------------------------------------------------------
const list = $('list');
const rows = new Map();
const thumbsOnScreen = new Set();
const io = 'IntersectionObserver' in window ? new IntersectionObserver((entries) => {
  for (const e of entries) (e.isIntersecting ? thumbsOnScreen.add(e.target.dataset.key) : thumbsOnScreen.delete(e.target.dataset.key));
  dirty = true;
}, { root: list }) : null;

function stateLabel(g) {
  const s = statusOf(g);
  const st0 = st(g.key);
  if (s === 'accepted') return isSet(g) ? 'Accepted' : 'Accepted ' + (st0.chosen + 1);
  if (s === 'flagged') return st0.flagged.length + ' flagged';
  if (s === 'later') return 'Later';
  if (s === 'rerolling') return 'Rerolling';
  if (rerolls[g.key] && rerolls[g.key].state === 'failed') return 'Reroll failed';
  return '';
}

function buildList() {
  list.textContent = '';
  rows.clear();
  if (io) io.disconnect();
  thumbsOnScreen.clear();
  const shown = visible();
  if (!shown.length) {
    const p = document.createElement('p');
    p.className = 'empty';
    p.textContent = filter === 'all' ? 'Nothing is waiting for review.' : 'No assets are ' + filter + '. Press 1 to show all.';
    list.append(p);
    return;
  }
  for (const g of shown) {
    const row = document.createElement('button');
    row.type = 'button';
    row.className = 'row';
    row.id = 'row-' + GROUPS.indexOf(g);
    row.setAttribute('role', 'option');
    row.tabIndex = -1;
    row.dataset.key = g.key;
    const thumb = document.createElement('span');
    thumb.className = 'thumb';
    const c = document.createElement('canvas');
    c.width = c.height = 0;
    thumb.append(c);
    const text = document.createElement('span');
    text.style.minWidth = '0';
    const name = document.createElement('span');
    name.className = 'name';
    name.textContent = decode(g.assetId);
    const meta = document.createElement('span');
    meta.className = 'meta num';
    meta.textContent = decode(g.styleId) + ', ' + g.frameUrls.length + (isSet(g) ? ' frames' : g.frameUrls.length === 1 ? ' candidate' : ' candidates');
    text.append(name, meta);
    const label = document.createElement('span');
    label.className = 'state';
    row.append(thumb, text, label);
    row.addEventListener('click', () => { select(g.key); row.blur(); list.focus({ preventScroll: true }); });
    list.append(row);
    rows.set(g.key, { row, canvas: c, label, drawn: -1 });
    if (io) io.observe(row); else thumbsOnScreen.add(g.key);
  }
  refreshRows();
}
function refreshRows() {
  for (const [key, r] of rows) {
    const g = group(key);
    if (!g) continue;
    r.label.textContent = stateLabel(g);
    r.label.className = 'state ' + statusOf(g);
    r.row.setAttribute('aria-selected', String(key === currentKey));
    r.row.setAttribute('aria-label', decode(g.assetId) + ' in ' + decode(g.styleId) + (stateLabel(g) ? ', ' + stateLabel(g) : ', undecided'));
  }
  const active = rows.get(currentKey);
  if (active) list.setAttribute('aria-activedescendant', active.row.id);
}

// Prompts arrive HTML-escaped; textContent wants them plain.
const decoder = document.createElement('textarea');
function decode(s) { decoder.innerHTML = s; return decoder.value; }

// ---- rendering: header -----------------------------------------------------
function buildFilters() {
  const nav = $('filters');
  nav.textContent = '';
  FILTERS.forEach(([id, label], i) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.dataset.filter = id;
    b.title = label + ' (' + (i + 1) + ')';
    b.addEventListener('click', () => { setFilter(id); b.blur(); });
    nav.append(b);
  });
}
function refreshHeader() {
  const counts = { all: GROUPS.length, undecided: 0, accepted: 0, flagged: 0, later: 0 };
  for (const g of GROUPS) {
    const s = statusOf(g);
    counts[s === 'rerolling' ? 'undecided' : s]++;
  }
  $('counter').innerHTML = '<b>' + counts.accepted + '</b> of ' + GROUPS.length + ' accepted' +
    (counts.flagged ? ', ' + counts.flagged + ' flagged' : '');
  for (const b of $('filters').children) {
    const id = b.dataset.filter;
    b.setAttribute('aria-pressed', String(id === filter));
    b.innerHTML = '';
    b.append(FILTERS.find((f) => f[0] === id)[1]);
    const n = document.createElement('span');
    n.className = 'n num';
    n.textContent = counts[id];
    b.append(n);
  }
  const running = Object.values(rerolls).some((r) => r.state === 'running');
  const apply = $('apply');
  apply.disabled = applying || counts.accepted === 0 || running;
  apply.textContent = counts.accepted ? 'Apply ' + counts.accepted : 'Apply';
  apply.title = running ? 'Wait for the reroll to finish' : 'Commit the accepted assets (Ctrl or Cmd+Enter)';
}

// ---- rendering: stage ------------------------------------------------------
const canvas = $('s-canvas');
const ctx = canvas.getContext('2d');
let dirty = true;

function views(g) {
  const out = [{ label: isSet(g) ? 'Candidate' : 'Candidate', kind: 'candidate' }];
  if (g.current) out.push({ label: 'Current art', kind: 'current', url: g.current.url });
  if (g.revision) out.push({ label: 'Revision source', kind: 'source', url: g.revision.sourceUrl });
  return out;
}
function frameSize(g, i) {
  const known = g.frameSizes && g.frameSizes[i];
  if (known) return known;
  const e = image(g.frameUrls[i]);
  if (e.ready) return { width: e.img.naturalWidth, height: e.img.naturalHeight };
  return { width: g.width, height: g.height };
}
// The largest whole-number zoom that fits; below 1x the frame is fitted and
// labelled so, never stretched.
function fitScale(w, h, boxW, boxH) {
  const s = Math.min(boxW / w, boxH / h);
  return s >= 1 ? Math.min(32, Math.floor(s)) : s;
}

let clock = 0, lastTick = 0;
function playIndex(g) {
  const n = g.frameUrls.length;
  if (n < 2) return 0;
  const step = Math.floor(clock * (g.fps || 12) / 1000);
  if (!pingpong) return step % n;
  const period = 2 * n - 2;
  const k = step % period;
  return k < n ? k : period - k;
}
// What the stage shows right now: frame sets play, candidates hold the cursor.
function stageIndex(g) {
  return isSet(g) && playing ? playIndex(g) : cur(g);
}

function drawStage() {
  const g = group(currentKey);
  const view = $('view');
  if (!g) { canvas.width = canvas.height = 0; return; }
  const vs = views(g);
  const mode = vs[flipped % vs.length];
  view.classList.toggle('flipped', mode.kind !== 'candidate');
  const box = view.getBoundingClientRect();
  const i = stageIndex(g);
  const size = frameSize(g, i);
  const scale = fitScale(size.width, size.height, Math.max(1, box.width - 48), Math.max(1, box.height - 72));
  const w = Math.max(1, Math.round(size.width * scale)), h = Math.max(1, Math.round(size.height * scale));
  if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
  ctx.imageSmoothingEnabled = scale < 1;
  ctx.clearRect(0, 0, w, h);
  const draw = (url, alpha) => {
    const e = image(url);
    if (!e.ready) return false;
    ctx.globalAlpha = alpha;
    // Same scale as the candidate, so a comparison is pixel for pixel.
    ctx.drawImage(e.img, 0, 0, e.img.naturalWidth * scale, e.img.naturalHeight * scale);
    ctx.globalAlpha = 1;
    return true;
  };
  let notice = '';
  if (mode.kind === 'candidate') {
    if (onion && g.frameUrls.length > 1) {
      const prev = (i - 1 + g.frameUrls.length) % g.frameUrls.length;
      draw(g.frameUrls[prev], 0.3);
    }
    const e = image(g.frameUrls[i]);
    if (e.failed) notice = 'This frame did not load. Reroll the asset or check the run log.';
    else if (!draw(g.frameUrls[i], 1)) notice = 'Loading…';
  } else {
    const e = image(mode.url);
    if (e.failed) notice = 'The ' + mode.label.toLowerCase() + ' did not load.';
    else draw(mode.url, 1);
  }
  const n = g.frameUrls.length;
  const s = st(g.key);
  let tag = '<b>' + mode.label + '</b>';
  if (mode.kind === 'candidate') {
    tag += isSet(g)
      ? ', frame ' + (i + 1) + ' of ' + n + ', ' + (g.fps || 12) + ' fps'
      : ', ' + (i + 1) + ' of ' + n + (g.recommendedIndex === i ? ' (declared slot)' : '');
    if (s.flagged.includes(i)) tag += ', flagged';
    if (!isSet(g) && s.chosen === i) tag += ', accepted';
  } else {
    tag += ' at the candidate’s scale';
  }
  $('s-tag').innerHTML = tag;
  $('s-scale').textContent = size.width + '×' + size.height + ', ' + (scale >= 1 ? scale + '×' : 'fitted');
  $('s-notice').textContent = notice;
}

function buildStage() {
  const g = group(currentKey);
  const has = Boolean(g);
  for (const id of ['a-accept', 'a-flag', 'a-later', 'a-reroll', 't-play', 't-flip', 't-strip', 't-onion', 't-pong']) $(id).disabled = !has;
  if (!g) {
    $('s-name').textContent = 'Nothing selected';
    $('s-key').textContent = '';
    $('s-pos').textContent = '';
    $('s-prompt').textContent = visible().length ? '' : 'Change the filter to see more assets.';
    $('strip').hidden = true;
    dirty = true;
    return;
  }
  const shown = visible();
  $('s-name').textContent = decode(g.assetId);
  $('s-key').textContent = decode(g.styleId) + '/' + decode(g.assetId);
  const pos = shown.indexOf(g);
  $('s-pos').textContent = (pos >= 0 ? pos + 1 : '–') + ' of ' + shown.length;
  $('s-prompt').textContent = decode(g.prompt);
  // Warm this asset's frames and the next one's: still one request each.
  g.frameUrls.forEach(image);
  const after = shown[pos + 1];
  if (after) after.frameUrls.forEach(image);
  const vs = views(g);
  $('t-flip').disabled = vs.length < 2;
  const next = vs[(flipped + 1) % vs.length];
  $('t-flip').firstChild.textContent = vs.length < 2 ? 'No current art' : flipped % vs.length ? 'Show candidate' : 'Show ' + next.label.toLowerCase();
  $('t-flip').setAttribute('aria-pressed', String(flipped % vs.length !== 0));
  $('t-play').firstChild.textContent = playing ? 'Pause' : 'Play';
  $('t-play').setAttribute('aria-pressed', String(!playing));
  $('t-strip').setAttribute('aria-pressed', String(showStrip));
  $('t-onion').setAttribute('aria-pressed', String(onion));
  $('t-pong').setAttribute('aria-pressed', String(pingpong));
  $('t-onion').disabled = $('t-pong').disabled = g.frameUrls.length < 2;
  if (!isSet(g)) $('t-pong').disabled = true;

  const s = st(g.key);
  const status = statusOf(g);
  const accept = $('a-accept');
  accept.className = 'act' + (s.chosen !== null ? ' on' : '');
  accept.firstChild.textContent = s.chosen !== null ? 'Accepted' : isSet(g) ? 'Accept set' : 'Accept ' + (cur(g) + 1);
  accept.setAttribute('aria-label', s.chosen !== null ? 'Accepted; press to undo' : isSet(g) ? 'Accept ordered frame set' : 'Choose candidate ' + (cur(g) + 1) + ' of ' + g.frameUrls.length);
  accept.disabled = status === 'rerolling';
  const flag = $('a-flag');
  const flaggedHere = s.flagged.includes(cur(g));
  flag.className = 'act' + (flaggedHere ? ' warn' : '');
  flag.firstChild.textContent = flaggedHere && !(isSet(g) && playing) ? 'Unflag ' + (cur(g) + 1) : isSet(g) ? (playing ? 'Flag this frame' : 'Flag frame ' + (cur(g) + 1)) : 'Flag ' + (cur(g) + 1);
  $('a-later').className = 'act' + (s.later ? ' on' : '');
  const reroll = $('a-reroll');
  reroll.hidden = !canReroll;
  const r = rerolls[g.key];
  reroll.disabled = status === 'rerolling';
  reroll.className = 'act' + (armedReroll === g.key ? ' warn' : '');
  reroll.firstChild.textContent = status === 'rerolling' ? 'Rerolling…' : armedReroll === g.key ? 'Press R again to spend' : 'Reroll';
  if (r && r.state === 'failed') say('Reroll of ' + g.assetId + ' failed: ' + r.error, true);
  buildStrip(g);
  dirty = true;
}

function buildStrip(g) {
  const strip = $('strip');
  strip.hidden = !showStrip;
  if (!showStrip) return;
  strip.textContent = '';
  const s = st(g.key);
  g.frameUrls.forEach((url, i) => {
    const cell = document.createElement('button');
    cell.type = 'button';
    cell.className = 'cell' + (s.flagged.includes(i) ? ' flag' : '') +
      ((isSet(g) ? s.chosen !== null : s.chosen === i) ? ' chosen' : '');
    cell.setAttribute('role', 'option');
    cell.setAttribute('aria-current', String(i === cur(g)));
    cell.setAttribute('aria-label', (isSet(g) ? 'Frame ' : 'Candidate ') + (i + 1) + (s.flagged.includes(i) ? ', flagged' : ''));
    cell.tabIndex = -1;
    const pic = document.createElement('span');
    pic.className = 'pic';
    const c = document.createElement('canvas');
    c.width = c.height = 0;
    pic.append(c);
    const lab = document.createElement('span');
    lab.className = 'lab num';
    lab.textContent = String(i + 1) + (s.flagged.includes(i) ? ' flagged' : '');
    cell.append(pic, lab);
    cell.addEventListener('click', () => { setCursor(g, i); cell.blur(); });
    strip.append(cell);
    const paint = () => {
      const e = image(url);
      if (!e.ready) return;
      const w = e.img.naturalWidth, h = e.img.naturalHeight;
      const k = fitScale(w, h, 96, 72);
      c.width = Math.max(1, Math.round(w * k)); c.height = Math.max(1, Math.round(h * k));
      const x = c.getContext('2d');
      x.imageSmoothingEnabled = k < 1;
      x.drawImage(e.img, 0, 0, c.width, c.height);
    };
    const e = image(url);
    if (e.ready) paint(); else e.img.addEventListener('load', paint, { once: true });
  });
  const active = strip.children[cur(g)];
  if (active) active.scrollIntoView({ block: 'nearest', inline: 'nearest' });
}

function drawThumbs() {
  for (const key of thumbsOnScreen) {
    const r = rows.get(key);
    const g = group(key);
    if (!r || !g) continue;
    const s = st(key);
    const i = isSet(g) ? (playing ? playIndex(g) : 0) : (s.chosen !== null ? s.chosen : cur(g));
    const e = image(g.frameUrls[i]);
    if (!e.ready) continue;
    if (r.drawn === i && r.canvas.width) continue;
    const w = e.img.naturalWidth, h = e.img.naturalHeight;
    const k = fitScale(w, h, 40, 40);
    const cw = Math.max(1, Math.round(w * k)), ch = Math.max(1, Math.round(h * k));
    if (r.canvas.width !== cw || r.canvas.height !== ch) { r.canvas.width = cw; r.canvas.height = ch; }
    const x = r.canvas.getContext('2d');
    x.imageSmoothingEnabled = k < 1;
    x.clearRect(0, 0, cw, ch);
    x.drawImage(e.img, 0, 0, cw, ch);
    r.drawn = i;
  }
}

// One clock for the page: thumbnails and stage advance together, and stop
// when the tab is hidden.
function tick(t) {
  if (playing && lastTick) clock += t - lastTick;
  lastTick = t;
  const g = group(currentKey);
  const before = tick.last;
  const now = g ? stageIndex(g) + ':' + flipped + ':' + onion : '';
  if (dirty || now !== before) { drawStage(); tick.last = now; dirty = false; }
  drawThumbs();
  requestAnimationFrame(tick);
}

// ---- actions ---------------------------------------------------------------
function say(text, error) {
  const s = $('status');
  s.textContent = text;
  s.title = text;
  s.className = error ? 'error' : '';
}
function refresh() { refreshRows(); refreshHeader(); buildStage(); }

function select(key, scroll) {
  currentKey = key;
  flipped = 0;
  if (armedReroll && armedReroll !== key) armedReroll = null;
  refresh();
  const r = rows.get(key);
  if (r && scroll !== false) r.row.scrollIntoView({ block: 'nearest' });
}
function move(delta) {
  const shown = visible();
  if (!shown.length) return;
  const at = shown.findIndex((g) => g.key === currentKey);
  const next = at < 0 ? 0 : Math.max(0, Math.min(shown.length - 1, at + delta));
  select(shown[next].key);
}
function advance() {
  // After a decision, go to the next asset still waiting in this view.
  const shown = visible();
  const at = GROUPS.findIndex((g) => g.key === currentKey);
  const after = GROUPS.slice(at + 1).concat(GROUPS.slice(0, at + 1));
  const next = after.find((g) => inFilter(g) && statusOf(g) === 'undecided');
  if (filter !== 'all' && !inFilter(group(currentKey))) { buildList(); }
  if (next) select(next.key); else if (shown.length) refresh(); else { buildList(); select(visible()[0] ? visible()[0].key : null); }
}
// Pausing holds the frame on screen, so the arrows step from there.
function togglePlay() {
  const g = group(currentKey);
  if (playing && g && isSet(g)) cursor[g.key] = playIndex(g);
  playing = !playing;
  buildStage();
}
function setCursor(g, i) {
  const n = g.frameUrls.length;
  cursor[g.key] = ((i % n) + n) % n;
  if (isSet(g)) playing = false;
  if (!isSet(g) && rows.get(g.key)) rows.get(g.key).drawn = -1;
  buildStage();
  refreshHeader();
}
function changed(g) { save(g); if (!inFilter(g)) buildList(); refresh(); }

function accept() {
  const g = group(currentKey);
  if (!g || statusOf(g) === 'rerolling') return;
  const s = st(g.key);
  const index = isSet(g) ? 0 : cur(g);
  if (s.chosen === index) { s.chosen = null; changed(g); return; }
  s.chosen = index;
  s.later = false;
  save(g);
  if (rows.get(g.key)) rows.get(g.key).drawn = -1;
  advance();
}
function flag() {
  const g = group(currentKey);
  if (!g) return;
  // A playing set flags the frame on screen, and holds it there.
  if (isSet(g) && playing) { cursor[g.key] = playIndex(g); playing = false; }
  const s = st(g.key);
  const i = cur(g);
  s.flagged =s.flagged.includes(i) ? s.flagged.filter((n) => n !== i) : s.flagged.concat(i).sort((a, b) => a - b);
  // A set with a bad frame is not accepted; a flagged candidate cannot be the choice.
  if (s.flagged.length && (isSet(g) || s.chosen === i)) s.chosen = null;
  changed(g);
}
function later() {
  const g = group(currentKey);
  if (!g) return;
  const s = st(g.key);
  s.later = !s.later;
  if (s.later) { s.chosen = null; save(g); advance(); } else changed(g);
}
async function reroll() {
  const g = group(currentKey);
  if (!g || !canReroll || statusOf(g) === 'rerolling') return;
  if (armedReroll !== g.key) {
    armedReroll = g.key;
    clearTimeout(armedTimer);
    armedTimer = setTimeout(() => { armedReroll = null; buildStage(); }, 4000);
    say('Rerolling spends credits. Press R again to regenerate ' + decode(g.assetId) + '.');
    buildStage();
    return;
  }
  armedReroll = null;
  clearTimeout(armedTimer);
  try {
    const res = await fetch(CONFIG.rerollUrl, {
      method: 'POST',
      headers: Object.assign({ 'Content-Type': 'application/json' }, CONFIG.headers),
      body: JSON.stringify({ key: g.key }),
    });
    if (!res.ok) throw new Error(await res.text());
    rerolls[g.key] = { state: 'running' };
    say('Rerolling ' + decode(g.assetId) + '. Keep reviewing; it comes back here when ready.');
    refresh();
    watch();
  } catch (err) {
    say('Reroll failed: ' + err.message, true);
  }
}
function batch(kind) {
  const shown = kind === 'select' ? visible() : GROUPS;
  let n = 0;
  for (const g of shown) {
    if (statusOf(g) === 'rerolling') continue;
    const s = st(g.key);
    if (kind === 'deselect') { if (s.chosen !== null) { s.chosen = null; save(g); n++; } continue; }
    if (s.chosen !== null) continue;
    if (kind === 'unflagged' && (s.flagged.length || s.later)) continue;
    if (isSet(g) && s.flagged.length) continue;
    const index = isSet(g) ? 0 : (s.flagged.includes(cur(g)) ? -1 : cur(g));
    if (index < 0) continue;
    s.chosen = index; s.later = false; save(g); n++;
  }
  say(kind === 'deselect' ? 'Cleared ' + n + ' acceptance' + (n === 1 ? '' : 's') : 'Accepted ' + n + ' asset' + (n === 1 ? '' : 's'));
  for (const r of rows.values()) r.drawn = -1;
  buildList();
  refresh();
}
function setFilter(id) {
  filter = id;
  buildList();
  const shown = visible();
  if (!shown.some((g) => g.key === currentKey)) currentKey = shown[0] ? shown[0].key : null;
  select(currentKey);
}

async function apply() {
  if ($('apply').disabled) return;
  applying = true;
  refreshHeader();
  say('Applying…');
  const selections = GROUPS.filter((g) => st(g.key).chosen !== null).map((g) => ({ key: g.key, index: st(g.key).chosen }));
  try {
    const res = await fetch(CONFIG.applyUrl, {
      method: 'POST',
      headers: Object.assign({ 'Content-Type': 'application/json' }, CONFIG.headers),
      body: JSON.stringify({ selections }),
    });
    if (!res.ok) throw new Error(await res.text());
    const result = await res.json();
    for (const g of GROUPS) { try { localStorage.removeItem(localKey(g)); } catch (e) { /* ignore */ } }
    say(CONFIG.embedded ? 'Applied ' + result.selected : 'Applied ' + result.selected + '. You can close this tab.');
    document.body.classList.add('done');
    if (CONFIG.embedded && window.parent !== window) {
      window.parent.postMessage({ type: 'pixelkiln:review-applied', result }, location.origin);
    }
  } catch (err) {
    applying = false;
    say('Apply failed: ' + err.message, true);
    refreshHeader();
  }
}

// ---- server session --------------------------------------------------------
let watching = null;
async function sync() {
  if (!CONFIG.sessionUrl) return;
  const res = await fetch(CONFIG.sessionUrl, { headers: CONFIG.headers });
  if (!res.ok) throw new Error(await res.text());
  const data = await res.json();
  const before = new Map(GROUPS.map((g) => [g.key, g.reviewObjectId]));
  GROUPS = data.groups;
  canReroll = Boolean(data.canReroll && CONFIG.rerollUrl);
  rerolls = data.rerolls || {};
  for (const g of GROUPS) {
    const fresh = before.get(g.key) !== g.reviewObjectId;
    if (fresh) { delete cursor[g.key]; if (before.has(g.key)) say(decode(g.assetId) + ' is back with a new take.'); }
    state[g.key] = Object.assign(blank(), data.state[g.key] || {});
  }
  buildList();
  refresh();
}
function watch() {
  if (watching || !CONFIG.sessionUrl) return;
  watching = setInterval(async () => {
    try { await sync(); } catch (e) { /* the run may have ended */ }
    if (!Object.values(rerolls).some((r) => r.state === 'running')) { clearInterval(watching); watching = null; }
  }, 2000);
}

// ---- keyboard --------------------------------------------------------------
document.addEventListener('keydown', (e) => {
  if (document.body.classList.contains('done')) return;
  const onButton = e.target instanceof HTMLButtonElement && !e.target.closest('#list');
  if (onButton && (e.key === 'Enter' || e.key === ' ')) return;
  if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') { apply(); e.preventDefault(); return; }
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  const g = group(currentKey);
  const k = e.key;
  if (k === 'ArrowDown' || k === 'j') move(1);
  else if (k === 'ArrowUp' || k === 'k') move(-1);
  else if (k === 'Home') { const v = visible(); if (v[0]) select(v[0].key); }
  else if (k === 'End') { const v = visible(); if (v.length) select(v[v.length - 1].key); }
  else if ((k === 'ArrowRight' || k === 'ArrowLeft') && g) setCursor(g, cur(g) + (k === 'ArrowRight' ? 1 : -1));
  else if (k === ' ') togglePlay();
  else if (k === 'A' && e.shiftKey) batch('unflagged');
  else if (k === 'S' && e.shiftKey) batch('select');
  else if (k === 'D' && e.shiftKey) batch('deselect');
  else if (k === 'a' || k === 'Enter') accept();
  else if (k === 'f') flag();
  else if (k === 'l') later();
  else if (k === 'r') reroll();
  else if (k === 'x') { showStrip = !showStrip; buildStage(); }
  else if (k === 'c' && g) { flipped = (flipped + 1) % views(g).length; buildStage(); }
  else if (k === 'o') { onion = !onion; buildStage(); }
  else if (k === 'p') { pingpong = !pingpong; buildStage(); }
  else if (/^[1-5]$/.test(k)) setFilter(FILTERS[Number(k) - 1][0]);
  else if (k === 'Escape' && armedReroll) { armedReroll = null; say(''); buildStage(); }
  else return;
  e.preventDefault();
});

const press = (id, fn) => $(id).addEventListener('click', (e) => { fn(); e.currentTarget.blur(); });
press('a-accept', accept);
press('a-flag', flag);
press('a-later', later);
press('a-reroll', reroll);
press('t-play', togglePlay);
press('t-flip', () => { const g = group(currentKey); if (g) { flipped = (flipped + 1) % views(g).length; buildStage(); } });
press('t-strip', () => { showStrip = !showStrip; buildStage(); });
press('t-onion', () => { onion = !onion; buildStage(); });
press('t-pong', () => { pingpong = !pingpong; buildStage(); });
press('select-all', () => batch('select'));
press('deselect-all', () => batch('deselect'));
press('accept-unflagged', () => batch('unflagged'));
press('apply', apply);
window.addEventListener('resize', () => { dirty = true; });
document.addEventListener('visibilitychange', () => { lastTick = 0; });

// ---- boot ------------------------------------------------------------------
for (const g of GROUPS) recall(g);
buildFilters();
buildList();
refresh();
list.focus({ preventScroll: true });
requestAnimationFrame(tick);
if (CONFIG.sessionUrl) {
  sync().then(() => { if (Object.values(rerolls).some((r) => r.state === 'running')) watch(); })
    .catch((err) => say('Could not load saved selections: ' + err.message, true));
}
`
