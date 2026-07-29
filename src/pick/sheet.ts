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
    assetId: escapeHtml(g.assetId),
    prompt: escapeHtml(g.prompt),
  }))
  const data = JSON.stringify(safe).replace(/<\//g, "<\\/")
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>spritesmith — pick candidates</title>
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
  .aid { font-weight:650; font-family:ui-monospace,SFMono-Regular,Menlo,monospace; }
  .prompt { color:var(--dim); font-size:12.5px; max-width:80ch; }
  .frames { display:flex; flex-wrap:wrap; gap:10px; }
  .cand { border:2px solid var(--line); border-radius:9px; padding:6px; background:var(--panel);
    cursor:pointer; display:flex; flex-direction:column; align-items:center; gap:5px; position:relative; }
  .cand:hover { border-color:var(--dim); }
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
  <h1>spritesmith</h1>
  <span class="count"><span id="picked">0</span> of <span id="total">0</span> chosen</span>
  <span id="status"></span>
  <span style="flex:1"></span>
  <button id="submit" class="primary" disabled>Apply selections</button>
</header>
<main id="root"></main>
<footer>
  Click a candidate to choose it; click again to unchoose. <kbd>1</kbd>–<kbd>9</kbd> picks within the
  focused row, <kbd>0</kbd> skips it. Unchosen rows are left in review and can be picked later —
  nothing is discarded by closing this page.
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
    '<div class="ghead"><span class="aid">' + g.assetId + '</span>' +
    '<span class="prompt">' + g.prompt + '</span></div>' +
    '<div class="frames"></div>';
  const frames = el.querySelector('.frames');
  g.frameUrls.forEach((url, i) => {
    const c = document.createElement('div');
    c.className = 'cand';
    c.innerHTML =
      '<img src="' + url + '" width="' + g.size * scale + '" height="' + g.size * scale + '" loading="lazy">' +
      '<span class="idx">' + (i + 1) + '</span>' +
      '<img class="actual" src="' + url + '" width="' + g.size + '" height="' + g.size + '" loading="lazy">';
    c.onclick = () => choose(gi, i, c, frames, el);
    frames.appendChild(c);
  });
  root.appendChild(el);
});

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
  if (!g || !/^[0-9]$/.test(e.key)) return;
  const gi = Number(g.dataset.gi);
  const frames = g.querySelector('.frames');
  if (e.key === '0') {
    picks.delete(gi); g.classList.remove('done');
    frames.querySelectorAll('.cand').forEach(n => n.classList.remove('sel'));
    refresh();
  } else {
    const i = Number(e.key) - 1;
    const node = frames.querySelectorAll('.cand')[i];
    if (node) choose(gi, i, node, frames, g);
  }
  const next = g.nextElementSibling;
  if (next) { next.focus(); next.scrollIntoView({ block: 'center', behavior: 'smooth' }); }
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
