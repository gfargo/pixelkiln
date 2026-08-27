export interface SheetGroup {
  key: string
  assetId: string
  styleId: string
  prompt: string
  reviewObjectId: string
  frameUrls: string[]
  size: number
}

const escapeHtml = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!)

/**
 * A contact sheet for choosing among generated candidates.
 *
 * This is the only step that needs human judgement, so it is optimised for one
 * thing: deciding fast. Candidates render at 4x with a transparency
 * checkerboard and a true-size swatch beside them, because a pixel icon that
 * looks good enlarged can still be unreadable at its real size. Keyboard-first,
 * one row per asset, and the page posts back and closes itself.
 */
export function renderSheet(groups: SheetGroup[]): string {
  // Prompts are author-controlled but arbitrary text, and they reach the page
  // both as JSON inside a <script> and via innerHTML. Escape for both: HTML
  // entities for the markup path, and `<\/` for the script-tag path so a
  // prompt containing "</script>" cannot break out.
  const safe = groups.map((g) => ({
    ...g,
    styleId: escapeHtml(g.styleId),
    assetId: escapeHtml(g.assetId),
    prompt: escapeHtml(g.prompt),
  }))
  const data = JSON.stringify(safe).replace(/<\//g, "<\\/")
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>pixelkiln — pick candidates</title>
<style>
  :root {
    --bg: #0f1115; --panel: #171a21; --line: #262b36;
    --text: #e6e8ee; --dim: #8b93a7; --accent: #6ee7a8; --warn: #f6c177;
  }
  @media (prefers-color-scheme: light) {
    :root { --bg:#f6f7f9; --panel:#fff; --line:#dfe3ea; --text:#1a1d23; --dim:#666e80; --accent:#0a8f52; }
  }
  * { box-sizing: border-box; }
  body { margin:0; background:var(--bg); color:var(--text);
    font:14px/1.5 ui-sans-serif,-apple-system,"SF Pro Text",Inter,system-ui,sans-serif; }
  header { position:sticky; top:0; z-index:10; background:var(--panel);
    border-bottom:1px solid var(--line); padding:14px 20px;
    display:flex; align-items:center; gap:16px; flex-wrap:wrap; }
  h1 { font-size:15px; margin:0; font-weight:600; letter-spacing:-0.01em; }
  .count { color:var(--dim); font-variant-numeric:tabular-nums; }
  button { font:inherit; font-weight:550; border-radius:7px; padding:8px 15px;
    border:1px solid var(--line); background:transparent; color:var(--text); cursor:pointer; }
  button.primary { background:var(--accent); border-color:var(--accent); color:#08130d; }
  button:disabled { opacity:.45; cursor:not-allowed; }
  .group { border-bottom:1px solid var(--line); padding:18px 20px; }
  .group.done { opacity:.5; }
  .ghead { display:flex; align-items:baseline; gap:12px; margin-bottom:12px; flex-wrap:wrap; }
  .style { font-size:10.5px; font-weight:650; text-transform:uppercase; letter-spacing:.03em;
    color:var(--accent); border:1px solid var(--accent); border-radius:4px; padding:2px 6px; }
  .aid { font-weight:650; font-family:ui-monospace,SFMono-Regular,Menlo,monospace; }
  .prompt { color:var(--dim); font-size:12.5px; max-width:80ch; }
  .frames { display:flex; flex-wrap:wrap; gap:10px; }
  .cand { border:2px solid var(--line); border-radius:9px; padding:6px; background:var(--panel);
    cursor:pointer; display:flex; flex-direction:column; align-items:center; gap:5px; position:relative; }
  .cand:hover { border-color:var(--dim); }
  .cand.active { border-color:var(--dim); box-shadow:0 0 0 2px color-mix(in srgb, var(--dim) 20%, transparent); }
  .cand.sel { border-color:var(--accent); box-shadow:0 0 0 3px color-mix(in srgb, var(--accent) 25%, transparent); }
  .cand img { image-rendering:pixelated; display:block;
    background-image:
      linear-gradient(45deg,#0000 25%,#7f7f7f22 25%,#7f7f7f22 75%,#0000 75%),
      linear-gradient(45deg,#0000 25%,#7f7f7f22 25%,#7f7f7f22 75%,#0000 75%);
    background-size:12px 12px; background-position:0 0,6px 6px; border-radius:4px; }
  .idx { font-size:10.5px; color:var(--dim); font-variant-numeric:tabular-nums; }
  .actual { position:absolute; right:-3px; bottom:-3px; image-rendering:pixelated;
    border:1px solid var(--line); border-radius:3px; background:var(--panel); }
  .skip { align-self:center; color:var(--dim); font-size:12px; }
  footer { padding:26px 20px 60px; color:var(--dim); }
  kbd { border:1px solid var(--line); border-bottom-width:2px; border-radius:4px;
    padding:1px 5px; font-size:11px; font-family:ui-monospace,Menlo,monospace; }
  #status { color:var(--warn); }
</style>
</head>
<body>
<header>
  <h1>pixelkiln</h1>
  <span class="count"><span id="picked">0</span> of <span id="total">0</span> chosen</span>
  <span id="status"></span>
  <span style="flex:1"></span>
  <button id="submit" class="primary" disabled>Apply selections</button>
</header>
<main id="root"></main>
<footer>
  Click a candidate to choose it; click again to unchoose. In the focused row,
  <kbd>←</kbd>/<kbd>→</kbd> browses every candidate and <kbd>Enter</kbd> chooses;
  <kbd>1</kbd>–<kbd>9</kbd> picks directly, <kbd>0</kbd> skips, and
  <kbd>↑</kbd>/<kbd>↓</kbd> changes rows. Unchosen rows stay in review — nothing is
  discarded by closing this page.
</footer>
<script>
const GROUPS = ${data};
const picks = new Map();
const root = document.getElementById('root');
document.getElementById('total').textContent = GROUPS.length;

GROUPS.forEach((g, gi) => {
  const el = document.createElement('section');
  el.className = 'group';
  el.tabIndex = 0;
  el.dataset.gi = String(gi);
  const scale = g.size <= 48 ? 4 : g.size <= 96 ? 3 : 2;
  el.innerHTML =
    '<div class="ghead"><span class="style">' + g.styleId + '</span>' +
    '<span class="aid">' + g.assetId + '</span>' +
    '<span class="prompt">' + g.prompt + '</span></div>' +
    '<div class="frames"></div>';
  const frames = el.querySelector('.frames');
  g.frameUrls.forEach((url, i) => {
    const c = document.createElement('button');
    c.type = 'button';
    c.className = 'cand';
    c.tabIndex = -1;
    c.setAttribute('aria-label', 'Choose candidate ' + (i + 1) + ' of ' + g.frameUrls.length);

    const preview = document.createElement('img');
    preview.src = url;
    preview.width = g.size * scale;
    preview.height = g.size * scale;
    preview.loading = 'lazy';
    const index = document.createElement('span');
    index.className = 'idx';
    index.textContent = String(i + 1);
    const actual = document.createElement('img');
    actual.className = 'actual';
    actual.src = url;
    actual.width = g.size;
    actual.height = g.size;
    actual.loading = 'lazy';
    c.append(preview, index, actual);

    c.onclick = () => {
      activate(i, frames);
      choose(gi, i, c, frames, el);
      // Keep the row as the keyboard target. Otherwise a clicked <button>
      // receives focus and Enter would invoke both its native click and the
      // row shortcut, toggling the same choice twice.
      el.focus();
    };
    c.onmouseenter = () => activate(i, frames);
    frames.appendChild(c);
  });
  frames.dataset.active = '0';
  frames.querySelector('.cand')?.classList.add('active');
  root.appendChild(el);
});

function activate(i, frames) {
  const candidates = [...frames.querySelectorAll('.cand')];
  if (!candidates.length) return null;
  const next = ((i % candidates.length) + candidates.length) % candidates.length;
  candidates.forEach(n => n.classList.remove('active'));
  candidates[next].classList.add('active');
  frames.dataset.active = String(next);
  candidates[next].scrollIntoView({ block: 'nearest', inline: 'nearest' });
  return candidates[next];
}

function choose(gi, i, node, frames, groupEl) {
  const current = picks.get(gi);
  frames.querySelectorAll('.cand').forEach(n => n.classList.remove('sel'));
  if (current === i) { picks.delete(gi); groupEl.classList.remove('done'); }
  else { picks.set(gi, i); node.classList.add('sel'); groupEl.classList.add('done'); }
  refresh();
}
function refresh() {
  document.getElementById('picked').textContent = picks.size;
  document.getElementById('submit').disabled = picks.size === 0;
}
document.addEventListener('keydown', e => {
  const g = document.activeElement?.closest?.('.group');
  if (!g) return;
  const gi = Number(g.dataset.gi);
  const frames = g.querySelector('.frames');
  const candidates = [...frames.querySelectorAll('.cand')];
  const active = Number(frames.dataset.active || 0);
  let advance = false;

  if (e.key === 'ArrowLeft') activate(active - 1, frames);
  else if (e.key === 'ArrowRight') activate(active + 1, frames);
  else if (e.key === 'Home') activate(0, frames);
  else if (e.key === 'End') activate(candidates.length - 1, frames);
  else if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
    const sibling = e.key === 'ArrowUp' ? g.previousElementSibling : g.nextElementSibling;
    if (sibling) { sibling.focus(); sibling.scrollIntoView({ block: 'center', behavior: 'smooth' }); }
  } else if (e.key === 'Enter' || e.key === ' ') {
    const node = candidates[active];
    if (!node) return;
    choose(gi, active, node, frames, g);
    advance = true;
  } else if (e.key === '0') {
    picks.delete(gi); g.classList.remove('done');
    frames.querySelectorAll('.cand').forEach(n => n.classList.remove('sel'));
    refresh();
    advance = true;
  } else if (/^[1-9]$/.test(e.key)) {
    const i = Number(e.key) - 1;
    const node = candidates[i];
    if (!node) return;
    activate(i, frames);
    choose(gi, i, node, frames, g);
    advance = true;
  } else {
    return;
  }
  if (advance) {
    const next = g.nextElementSibling;
    if (next) { next.focus(); next.scrollIntoView({ block: 'center', behavior: 'smooth' }); }
  }
  e.preventDefault();
});

document.getElementById('submit').onclick = async () => {
  const btn = document.getElementById('submit');
  btn.disabled = true;
  const status = document.getElementById('status');
  status.textContent = 'applying…';
  const selections = [...picks.entries()].map(([gi, index]) => ({ key: GROUPS[gi].key, index }));
  try {
    const res = await fetch('/apply', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ selections }),
    });
    if (!res.ok) throw new Error(await res.text());
    status.textContent = 'done — you can close this tab';
    document.body.style.opacity = '.6';
  } catch (err) {
    status.textContent = 'failed: ' + err.message;
    btn.disabled = false;
  }
};
</script>
</body>
</html>`
}
