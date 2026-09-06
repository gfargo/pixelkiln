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
  fps?: number
  revision?: {
    mode: "image-to-image" | "inpaint" | "outpaint"
    sourceAssetId: string
    sourceUrl: string
    width: number
    height: number
  }
}

const escapeHtml = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!)

/**
 * A contact sheet for choosing among generated candidates.
 *
 * This is the only step that needs human judgement, so it is optimised for one
 * thing: deciding fast. Small candidates render at an exact integer zoom with
 * a transparency checkerboard and a true-size swatch. Large candidates are
 * fitted without changing their aspect ratio, so a wide browser cannot turn a
 * review into an oversized or stretched image wall. Keyboard-first, one row
 * per asset, and the page posts back and closes itself.
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
    ...(g.revision
      ? {
          revision: {
            ...g.revision,
            sourceAssetId: escapeHtml(g.revision.sourceAssetId),
          },
        }
      : {}),
  }))
  const data = JSON.stringify(safe).replace(/<\//g, "<\\/")
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>pixelkiln — pick candidates</title>
<style>
  :root {
    --bg: #17150f; --panel: #201d17; --panel-deep: #100f0c;
    --line: rgba(243,234,214,.16); --line-strong: rgba(243,234,214,.3);
    --text: #f3ead6; --dim: #9b9384; --accent: #ff6b35;
    --accent-soft: #ff9c5f; --ok: #b9f27c; --warn: #ff9c5f;
    --content: 1440px; --preview: 560px;
  }
  * { box-sizing: border-box; }
  body { margin:0; background:var(--bg); color:var(--text);
    font:14px/1.5 ui-sans-serif,-apple-system,"SF Pro Text",Inter,system-ui,sans-serif; }
  header { position:sticky; top:0; z-index:10; background:var(--panel);
    border-bottom:1px solid var(--line-strong); }
  .bar { width:min(100%,var(--content)); margin:0 auto; padding:15px 22px;
    display:flex; align-items:center; gap:16px; flex-wrap:wrap; }
  h1 { font:700 14px/1 ui-monospace,SFMono-Regular,Menlo,monospace;
    margin:0; letter-spacing:-.02em; }
  h1::before { content:'◆'; color:var(--accent); margin-right:9px; font-size:11px; }
  .count { color:var(--dim); font-variant-numeric:tabular-nums; }
  button { font:inherit; font-weight:600; border-radius:0; padding:9px 16px;
    border:1px solid var(--line); background:transparent; color:var(--text); cursor:pointer; }
  button.primary { background:var(--accent); border-color:var(--accent); color:var(--bg); }
  button:disabled { opacity:.45; cursor:not-allowed; }
  main, footer { width:min(100%,var(--content)); margin-inline:auto; }
  main { border-inline:1px solid var(--line); }
  .group { border-bottom:1px solid var(--line); padding:22px; overflow:hidden; }
  .group.done { background:rgba(185,242,124,.035); }
  .ghead { display:flex; align-items:baseline; gap:12px; margin-bottom:16px; flex-wrap:wrap; }
  .style { font-size:10.5px; font-weight:650; text-transform:uppercase; letter-spacing:.03em;
    color:var(--accent-soft); border:1px solid var(--accent); border-radius:0; padding:2px 6px; }
  .aid { font-weight:650; font-family:ui-monospace,SFMono-Regular,Menlo,monospace; }
  .prompt { flex:1; min-width:280px; color:var(--dim); font-size:12.5px; max-width:80ch; }
  .review { display:grid; grid-template-columns:minmax(180px,280px) minmax(0,1fr); gap:16px;
    align-items:start; }
  .review.no-context { display:block; }
  .context { border:1px solid var(--line); padding:8px; background:var(--panel-deep);
    min-width:0; }
  .context-label { display:flex; justify-content:space-between; gap:8px; margin-bottom:7px;
    color:var(--dim); font-size:10.5px; font-variant-numeric:tabular-nums; }
  .context img { display:block; width:100%; height:auto; max-height:420px; object-fit:contain;
    image-rendering:pixelated;
    background-image:linear-gradient(45deg,#0000 25%,#7f7f7f22 25%,#7f7f7f22 75%,#0000 75%),
      linear-gradient(45deg,#0000 25%,#7f7f7f22 25%,#7f7f7f22 75%,#0000 75%);
    background-size:12px 12px; background-position:0 0,6px 6px; }
  .frames { display:flex; flex-wrap:wrap; gap:10px; max-width:100%; overflow-x:auto; }
  .loop { display:flex; align-items:flex-start; gap:12px; margin-bottom:12px; }
  .loop img { image-rendering:pixelated; border:2px solid var(--accent); padding:7px;
    background:var(--panel-deep); max-width:min(var(--preview),calc(100vw - 62px)); height:auto; }
  .loop-copy { color:var(--dim); font-size:11px; max-width:32ch; }
  .cand { border:2px solid var(--line-strong); border-radius:0; padding:7px; background:var(--panel-deep);
    cursor:pointer; display:flex; flex:0 0 auto; flex-direction:column; align-items:center; gap:5px;
    position:relative; max-width:100%; }
  .cand:hover { border-color:var(--dim); }
  .cand.active { border-color:var(--dim); box-shadow:0 0 0 2px color-mix(in srgb, var(--dim) 20%, transparent); }
  .cand.sel { border-color:var(--ok); box-shadow:0 0 0 3px color-mix(in srgb, var(--ok) 22%, transparent); }
  .cand.set-frame { cursor:pointer; }
  .cand img { image-rendering:pixelated; display:block;
    background-image:
      linear-gradient(45deg,#0000 25%,#7f7f7f22 25%,#7f7f7f22 75%,#0000 75%),
      linear-gradient(45deg,#0000 25%,#7f7f7f22 25%,#7f7f7f22 75%,#0000 75%);
    background-size:12px 12px; background-position:0 0,6px 6px; border-radius:0; }
  .cand img.preview { max-width:min(var(--preview),calc(100vw - 62px)); height:auto; }
  .idx { font-size:10.5px; color:var(--dim); font-variant-numeric:tabular-nums; }
  .actual { position:absolute; right:-3px; bottom:-3px; image-rendering:pixelated;
    border:1px solid var(--line); border-radius:0; background:var(--panel); }
  .skip { align-self:center; color:var(--dim); font-size:12px; }
  footer { padding:26px 20px 60px; color:var(--dim); }
  kbd { border:1px solid var(--line); border-bottom-width:2px; border-radius:0;
    padding:1px 5px; font-size:11px; font-family:ui-monospace,Menlo,monospace; }
  #status { color:var(--warn); }
  @media (max-width:640px) {
    .bar, .group { padding-inline:14px; }
    .prompt { min-width:100%; }
    .cand img.preview { max-width:calc(100vw - 50px); }
  }
  @media (max-width:900px) {
    .review { grid-template-columns:1fr; }
    .context { max-width:280px; }
  }
</style>
</head>
<body>
<header>
  <div class="bar">
    <h1>pixelkiln</h1>
    <span class="count"><span id="picked">0</span> of <span id="total">0</span> chosen</span>
    <span id="status"></span>
    <span style="flex:1"></span>
    <button id="submit" class="primary" disabled>Apply selections</button>
  </div>
</header>
<main id="root"></main>
<footer>
  Click a candidate to choose it, or any ordered frame to accept its whole set;
  click again to undo. In the focused row,
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
  const largestSide = Math.max(g.width, g.height);
  const preferredScale = largestSide <= 48 ? 4 : largestSide <= 96 ? 3 : 2;
  const scale = Math.min(preferredScale, 560 / largestSide);
  const displayScale = scale >= 1 ? Math.floor(scale) : scale;
  const displayWidth = Math.max(1, Math.round(g.width * displayScale));
  const displayHeight = Math.max(1, Math.round(g.height * displayScale));
  const scaleLabel = displayScale >= 1 ? displayScale + '×' : 'fit';
  el.innerHTML =
    '<div class="ghead"><span class="style">' + g.styleId + '</span>' +
    '<span class="aid">' + g.assetId + '</span>' +
    '<span class="prompt">' + g.prompt + '</span></div>' +
    '<div class="review' + (g.revision ? '' : ' no-context') + '">' +
    '<div class="frames"></div></div>';
  const review = el.querySelector('.review');
  const frames = el.querySelector('.frames');
  if (g.revision) {
    const context = document.createElement('aside');
    context.className = 'context';
    const label = document.createElement('div');
    label.className = 'context-label';
    const identity = document.createElement('span');
    identity.textContent = g.revision.mode.toUpperCase() + ' · SOURCE ' + g.revision.sourceAssetId;
    const dimensions = document.createElement('span');
    dimensions.textContent = g.revision.width + '×' + g.revision.height;
    label.append(identity, dimensions);
    const source = document.createElement('img');
    source.src = g.revision.sourceUrl;
    source.alt = 'Revision source ' + g.revision.sourceAssetId;
    context.append(label, source);
    review.insertBefore(context, frames);
  }
  if (g.mode === 'frame-set') {
    const loop = document.createElement('div');
    loop.className = 'loop';
    const preview = document.createElement('img');
    preview.src = g.frameUrls[0];
    preview.width = displayWidth;
    preview.height = displayHeight;
    preview.alt = 'Animated frame-set preview';
    const copy = document.createElement('div');
    copy.className = 'loop-copy';
    copy.textContent = g.frameUrls.length + ' ordered frames · ' + (g.fps || 12) +
      ' fps. Accepting keeps every frame; one bad frame means leave the set unchosen.';
    loop.append(preview, copy);
    review.insertBefore(loop, frames);
    let loopIndex = 0;
    setInterval(() => {
      loopIndex = (loopIndex + 1) % g.frameUrls.length;
      preview.src = g.frameUrls[loopIndex];
    }, Math.max(16, Math.round(1000 / (g.fps || 12))));
  }
  g.frameUrls.forEach((url, i) => {
    const c = document.createElement('button');
    c.type = 'button';
    c.className = 'cand' + (g.mode === 'frame-set' ? ' set-frame' : '');
    c.tabIndex = -1;
    c.setAttribute('aria-label', g.mode === 'frame-set'
      ? 'Accept ordered frame set from frame ' + (i + 1)
      : 'Choose candidate ' + (i + 1) + ' of ' + g.frameUrls.length);

    const preview = document.createElement('img');
    preview.className = 'preview';
    preview.src = url;
    preview.width = displayWidth;
    preview.height = displayHeight;
    preview.loading = 'lazy';
    const index = document.createElement('span');
    index.className = 'idx';
    index.textContent = (g.frameLabels?.[i] || String(i + 1)) + ' · ' +
      g.width + '×' + g.height + ' · ' + scaleLabel;
    c.append(preview, index);
    if (displayScale > 1 && largestSide <= 96) {
      const actual = document.createElement('img');
      actual.className = 'actual';
      actual.src = url;
      actual.width = g.width;
      actual.height = g.height;
      actual.loading = 'lazy';
      actual.setAttribute('aria-label', 'Actual size');
      c.append(actual);
    }

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
  if (GROUPS[gi].mode === 'frame-set') {
    const selected = picks.has(gi);
    frames.querySelectorAll('.cand').forEach(n => n.classList.toggle('sel', !selected));
    if (selected) { picks.delete(gi); groupEl.classList.remove('done'); }
    else { picks.set(gi, 0); groupEl.classList.add('done'); }
    refresh();
    return;
  }
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
