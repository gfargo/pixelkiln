import type { Orphan } from "../pipeline/salvage.ts"

const escapeHtml = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!)

/**
 * Triage sheet for unclaimed account objects.
 *
 * Optimised for volume: a couple of hundred items, most of which get a
 * one-keystroke verdict. Everything defaults to no decision, so closing the tab
 * changes nothing, and `discard` only ever writes a tag — deletion is a
 * separate command that has to be asked for by name.
 */
export function renderSalvageSheet(orphans: Orphan[]): string {
  const safe = orphans.map((o) => ({ ...o, prompt: escapeHtml(o.prompt) }))
  const data = JSON.stringify(safe).replace(/<\//g, "<\\/")

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>pixelkiln — salvage</title>
<style>
  :root { --bg:#0f1115; --panel:#171a21; --line:#262b36; --text:#e6e8ee; --dim:#8b93a7;
          --import:#6ee7a8; --keep:#7cc4ff; --discard:#f87171; }
  @media (prefers-color-scheme: light) {
    :root { --bg:#f6f7f9; --panel:#fff; --line:#dfe3ea; --text:#1a1d23; --dim:#666e80;
            --import:#0a8f52; --keep:#1a6fd4; --discard:#c0392b; }
  }
  * { box-sizing:border-box; }
  body { margin:0; background:var(--bg); color:var(--text);
    font:14px/1.5 ui-sans-serif,-apple-system,"SF Pro Text",Inter,system-ui,sans-serif; }
  header { position:sticky; top:0; z-index:10; background:var(--panel);
    border-bottom:1px solid var(--line); padding:12px 20px; display:flex; gap:14px;
    align-items:center; flex-wrap:wrap; }
  h1 { font-size:15px; margin:0; font-weight:600; }
  .tally { color:var(--dim); font-variant-numeric:tabular-nums; }
  .tally b { color:var(--text); font-weight:600; }
  button { font:inherit; font-weight:550; border-radius:7px; padding:7px 14px;
    border:1px solid var(--line); background:transparent; color:var(--text); cursor:pointer; }
  button.primary { background:var(--import); border-color:var(--import); color:#08130d; }
  button:disabled { opacity:.45; cursor:not-allowed; }
  main { display:grid; grid-template-columns:repeat(auto-fill,minmax(190px,1fr)); gap:12px; padding:18px 20px 80px; }
  .card { border:2px solid var(--line); border-radius:10px; background:var(--panel);
    padding:10px; display:flex; flex-direction:column; gap:8px; }
  .card.import { border-color:var(--import); }
  .card.keep { border-color:var(--keep); }
  .card.discard { border-color:var(--discard); opacity:.5; }
  .thumb { height:120px; display:flex; align-items:center; justify-content:center;
    border-radius:6px;
    background-image:
      linear-gradient(45deg,#0000 25%,#7f7f7f22 25%,#7f7f7f22 75%,#0000 75%),
      linear-gradient(45deg,#0000 25%,#7f7f7f22 25%,#7f7f7f22 75%,#0000 75%);
    background-size:12px 12px; background-position:0 0,6px 6px; }
  .thumb img { image-rendering:pixelated; max-height:112px; max-width:100%; }
  .meta { font-size:11px; color:var(--dim); font-variant-numeric:tabular-nums; }
  .prompt { font-size:11.5px; color:var(--dim); max-height:3.2em; overflow:hidden; }
  .acts { display:flex; gap:5px; }
  .acts button { flex:1; padding:5px 0; font-size:11.5px; }
  .acts button.on-import { background:var(--import); border-color:var(--import); color:#08130d; }
  .acts button.on-keep { background:var(--keep); border-color:var(--keep); color:#04121f; }
  .acts button.on-discard { background:var(--discard); border-color:var(--discard); color:#fff; }
  footer { position:fixed; bottom:0; left:0; right:0; background:var(--panel);
    border-top:1px solid var(--line); padding:10px 20px; font-size:12px; color:var(--dim); }
  kbd { border:1px solid var(--line); border-bottom-width:2px; border-radius:4px;
    padding:1px 5px; font-size:11px; font-family:ui-monospace,Menlo,monospace; }
</style>
</head>
<body>
<header>
  <h1>pixelkiln salvage</h1>
  <span class="tally"><b id="ti">0</b> import · <b id="tk">0</b> keep · <b id="td">0</b> discard ·
    <b id="tu">0</b> undecided</span>
  <span style="flex:1"></span>
  <button id="allDiscard">Discard all undecided</button>
  <button id="allKeep">Keep all undecided</button>
  <button id="submit" class="primary" disabled>Apply</button>
</header>
<main id="grid"></main>
<footer>
  <b>import</b> downloads it and adds it to your manifest · <b>keep</b> tags it and leaves it ·
  <b>discard</b> only tags it — nothing is deleted here.
  Hover a card and press <kbd>i</kbd> / <kbd>k</kbd> / <kbd>d</kbd>, or <kbd>u</kbd> to undo.
</footer>
<script>
const ITEMS = ${data};
const picks = new Map();
const grid = document.getElementById('grid');
let hovered = null;

ITEMS.forEach((o, i) => {
  const el = document.createElement('div');
  el.className = 'card';
  el.dataset.i = String(i);
  el.innerHTML =
    '<div class="thumb"><img src="' + o.previewUrl + '" loading="lazy"></div>' +
    '<div class="meta">' + o.width + '×' + o.height + ' · ' + o.createdAt.slice(0,10) + '</div>' +
    '<div class="prompt">' + o.prompt + '</div>' +
    '<div class="acts">' +
      '<button data-a="import">import</button>' +
      '<button data-a="keep">keep</button>' +
      '<button data-a="discard">discard</button>' +
    '</div>';
  el.querySelectorAll('.acts button').forEach(b => {
    b.onclick = () => choose(i, b.dataset.a);
  });
  el.onmouseenter = () => { hovered = i; };
  grid.appendChild(el);
});

function choose(i, action) {
  if (picks.get(i) === action) picks.delete(i); else picks.set(i, action);
  const el = grid.children[i];
  el.className = 'card' + (picks.has(i) ? ' ' + picks.get(i) : '');
  el.querySelectorAll('.acts button').forEach(b => {
    b.className = picks.get(i) === b.dataset.a ? 'on-' + b.dataset.a : '';
  });
  refresh();
}

function refresh() {
  const c = { import: 0, keep: 0, discard: 0 };
  for (const a of picks.values()) c[a]++;
  ti.textContent = c.import; tk.textContent = c.keep; td.textContent = c.discard;
  tu.textContent = ITEMS.length - picks.size;
  document.getElementById('submit').disabled = picks.size === 0;
}

document.addEventListener('keydown', e => {
  if (hovered === null) return;
  const map = { i: 'import', k: 'keep', d: 'discard' };
  if (map[e.key]) { choose(hovered, map[e.key]); e.preventDefault(); }
  else if (e.key === 'u') { picks.delete(hovered); choose(hovered, '__none__'); }
});

document.getElementById('allKeep').onclick = () => {
  ITEMS.forEach((_, i) => { if (!picks.has(i)) choose(i, 'keep'); });
};
document.getElementById('allDiscard').onclick = () => {
  ITEMS.forEach((_, i) => { if (!picks.has(i)) choose(i, 'discard'); });
};

document.getElementById('submit').onclick = async () => {
  const btn = document.getElementById('submit');
  btn.disabled = true; btn.textContent = 'applying…';
  const decisions = [...picks.entries()].map(([i, action]) => ({ id: ITEMS[i].id, action }));
  try {
    const res = await fetch('/apply', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ decisions }),
    });
    if (!res.ok) throw new Error(await res.text());
    btn.textContent = 'done — close this tab';
    document.body.style.opacity = '.6';
  } catch (err) {
    btn.textContent = 'failed: ' + err.message; btn.disabled = false;
  }
};
refresh();
</script>
</body>
</html>`
}
