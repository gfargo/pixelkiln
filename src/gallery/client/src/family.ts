import { $, S, STATE_TONE, backdropControl, displayScale, el, fmtCost } from "./core.ts"
import { openItem } from "./drawer.ts"
import { generateDialog } from "./editor.ts"

/**
 * The family view: one character (or objectPro object) with everything drawn
 * from it, on one sheet. A turntable turns the base, or any of its states,
 * through its rotations; a grid lays every loop out by direction, all
 * playing on one clock, so a walk can be read around the compass at a
 * glance and a missing or stale direction stands out as a gap.
 *
 * The sheet is rebuilt from the snapshot on every refresh (a job landing
 * fills its cells in), keeping the turntable's direction and the clock.
 */

/** Clockwise from south: the order a base's rotations come back in. */
const COMPASS = ['south', 'south-east', 'east', 'north-east', 'north', 'north-west', 'west', 'south-west'];
const SHORT: Record<string, string> = {
  south: 'S', 'south-east': 'SE', east: 'E', 'north-east': 'NE', north: 'N', 'north-west': 'NW', west: 'W', 'south-west': 'SW',
};
/** The compass rose, read row by row as it is drawn: north at the top. */
const ROSE = ['north-west', 'north', 'north-east', 'west', null, 'east', 'south-west', 'south', 'south-east'];
const SPEEDS = [0.5, 1, 2];
const SPIN_MS = 420;
const DRAG_STEP_PX = 28;
/** The inside of a loop-grid cell. */
const CELL_PX = 68;

interface Anim { img: HTMLImageElement; urls: string[]; fps: number; index: number }
interface FamilyState {
  rootId: string
  /** The snapshot last drawn, so a redraw that brought nothing new leaves the sheet alone. */
  drawn: unknown
  /** Item id the turntable shows: the base or one of its states. */
  source: string
  direction: string
  spinning: boolean
  playing: boolean
  speed: number
  t0: number
  lastSpin: number
  raf: number | null
  panel: HTMLElement | null
  anims: Anim[]
  /** Cells and headers per direction, so turning the table highlights its column without a rebuild. */
  columns: Map<string, HTMLElement[]>
  turn: ((direction: string) => void) | null
}

let F: FamilyState | null = null;

const reducedMotion = () => typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
const byKey = (project, key) => S.snap.items.find((i) => i.key === key && i.project === project);

/** The base a family member descends from, following parents up; null for anything outside a family. */
export function familyRoot(item) {
  let at = item;
  for (let guard = 0; at && at.character && at.character.parentKey && guard < 16; guard++) {
    at = byKey(at.project, at.character.parentKey);
  }
  return at && at.character && !at.character.parentKey ? at : null;
}

/** Every declared or recorded member of a family, the root included. */
export function familyMembers(root) {
  return S.snap.items.filter((i) => i.project === root.project && i.character && familyRoot(i) === root);
}

/** A loop's name without its direction: `mira.walk.south` belongs to `mira.walk`. */
export function loopName(item) {
  const d = item.character && item.character.direction;
  return d && item.assetId.endsWith('.' + d) ? item.assetId.slice(0, -(d.length + 1)) : item.assetId;
}

/** The directions a base or state turns through, in turning order. */
function turnOrder(item) {
  const roles = new Set(item.outputs.map((o) => o.role));
  const shown = COMPASS.filter((d) => roles.has(d));
  if (shown.length) return shown;
  const n = item.character ? item.character.directions : 1;
  return n >= 8 ? COMPASS : n === 4 ? ['south', 'east', 'north', 'west'] : ['south'];
}
const rotationUrl = (item, direction) => {
  const out = item && item.outputs.find((o) => o.role === direction && o.url);
  return out ? out.url : item && direction === 'south' && item.outputs[0] && item.outputs[0].url && !item.outputs[0].role ? item.outputs[0].url : null;
};
const frameUrls = (item) => item.outputs.filter((o) => o.url).map((o) => o.url);

export function openFamily(item) {
  const root = familyRoot(item);
  if (!root) return;
  stopFamily();
  const turnable = item.character && (item.character.kind === 'base' || item.character.kind === 'state') ? item : root;
  F = {
    rootId: root.id,
    drawn: null,
    source: turnable.id,
    direction: item.character && item.character.direction && turnOrder(turnable).includes(item.character.direction) ? item.character.direction : 'south',
    spinning: false,
    playing: !reducedMotion(),
    speed: 1,
    t0: performance.now(),
    lastSpin: 0,
    raf: null,
    panel: null,
    anims: [],
    columns: new Map(),
    turn: null,
  };
  renderFamily();
}

export function closeFamily() {
  stopFamily();
  $('dialog-host').textContent = '';
}

function stopFamily() {
  if (F && F.raf !== null) cancelAnimationFrame(F.raf);
  F = null;
}

/** Called on every gallery redraw: rebuilds an open family sheet from the new snapshot. */
export function refreshFamily() {
  if (!F) return;
  if (!F.panel || !F.panel.isConnected) { stopFamily(); return; }
  if (F.drawn !== S.snap) renderFamily();
}

function renderFamily() {
  if (!F) return;
  const root = S.snap.items.find((i) => i.id === F!.rootId);
  if (!root) { closeFamily(); return; }
  F.drawn = S.snap;
  const members = familyMembers(root);
  const turnables = members.filter((m) => m.character!.kind === 'base' || m.character!.kind === 'state');
  if (!turnables.some((m) => m.id === F!.source)) F.source = root.id;
  const source = turnables.find((m) => m.id === F!.source) || root;
  const order = turnOrder(source);
  if (!order.includes(F.direction)) F.direction = order[0];

  const host = $('dialog-host');
  const scroll = F.panel ? F.panel.scrollTop : 0;
  host.textContent = '';
  F.anims = [];
  F.columns = new Map();
  const scrim = el('div', 'sheet-scrim');
  scrim.onclick = closeFamily;
  const panel = el('div', 'sheet family-sheet');
  panel.setAttribute('role', 'dialog');
  panel.setAttribute('aria-label', 'Family of ' + root.key);
  F.panel = panel;

  const bar = el('div', 'rbar');
  const back = el('button', null, 'Back to gallery'); back.type = 'button'; back.onclick = closeFamily;
  const title = el('b', 'mono', root.key);
  const c = root.character!;
  bar.append(back, title, el('span', null, (c.generator === 'objectPro' ? 'object' : 'character') + ' · ' + c.mode + ' · ' + root.width + '×' + root.height));
  const tally = el('span', 'family-tally');
  const counts: Record<string, number> = {};
  for (const m of members) counts[m.state] = (counts[m.state] || 0) + 1;
  for (const [state, n] of Object.entries(counts)) {
    const t = el('span', 'st');
    t.append(el('i', 'dot ' + STATE_TONE[state]), document.createTextNode(n + ' ' + state));
    tally.append(t);
  }
  bar.append(tally, backdropControl());
  if (GENERATION) {
    const todo = members.filter((m) => m.declared && m.currentSpecHash !== null && ['missing', 'stale', 'failed'].includes(m.state));
    if (todo.length) {
      const totals: Record<string, number> = {};
      for (const m of todo) if (m.estimatedCost !== null) totals[m.costUnit] = (totals[m.costUnit] || 0) + m.estimatedCost;
      const price = Object.entries(totals).map(([unit, n]) => fmtCost(unit, Math.round(n * 100) / 100)).join(' + ');
      const g = el('button', 'primary', 'Generate ' + todo.length + (price ? ' · ' + price : ''));
      g.type = 'button';
      g.title = 'One job for the whole family: parents first, then everything drawn from them';
      g.onclick = () => { stopFamily(); generateDialog(todo, { project: root.project }); };
      bar.append(g);
    }
  }
  panel.append(bar);

  const body = el('div', 'family-body');
  body.append(turntable(root, turnables, source, order));
  body.append(loopGrid(root, members, order));
  const extras = members.filter((m) => m.character!.kind === 'portrait' || m.character!.kind === 'outfit');
  if (extras.length) body.append(extrasStrip(extras));
  panel.append(body);
  host.append(scrim, panel);
  panel.scrollTop = scroll;
  highlight(F.direction);
  if (F.raf === null) F.raf = requestAnimationFrame(tick);
}

// ---- turntable ---------------------------------------------------------------

function turntable(root, turnables, source, order) {
  const wrap = el('section', 'turntable');
  if (turnables.length > 1) {
    const tabs = el('div', 'family-tabs');
    for (const t of turnables) {
      const b = el('button', t.id === source.id ? 'on' : null, t.id === root.id ? 'base' : t.assetId.replace(root.assetId + '.', ''));
      b.type = 'button';
      b.title = t.key + ' · ' + t.state;
      b.onclick = () => { F!.source = t.id; renderFamily(); };
      tabs.append(b);
    }
    wrap.append(tabs);
  }

  const stage = el('div', 'tt-stage');
  stage.tabIndex = 0;
  stage.setAttribute('role', 'img');
  const img = el('img');
  const empty = el('div', 'tt-empty');
  const scale = displayScale(source.width, source.height, 256, 256);
  img.width = Math.round(source.width * scale);
  img.height = Math.round(source.height * scale);
  img.alt = source.assetId;
  stage.append(img, empty);
  // Warm the cache so turning never flickers.
  for (const d of order) { const u = rotationUrl(source, d); if (u) { const p = new Image(); p.src = u; } }

  const label = el('div', 'tt-label');
  const rose = el('div', 'tt-rose');
  const roseButtons = new Map<string, HTMLButtonElement>();
  for (const d of ROSE) {
    if (!d) { rose.append(el('i', 'tt-hub')); continue; }
    const b = el('button', null, SHORT[d]);
    b.type = 'button';
    b.title = d;
    b.disabled = !order.includes(d);
    b.onclick = () => turn(d);
    roseButtons.set(d, b);
    rose.append(b);
  }

  const show = (direction: string) => {
    const url = rotationUrl(source, direction);
    img.hidden = !url;
    empty.hidden = !!url;
    if (url) img.src = url;
    else empty.textContent = source.state === 'ok' ? 'no ' + direction + ' rotation' : source.state + ': ' + (source.reason || 'not generated yet');
    stage.setAttribute('aria-label', source.assetId + ' facing ' + direction);
    label.textContent = direction + ' · ' + (order.indexOf(direction) + 1) + ' of ' + order.length;
    for (const [d, b] of roseButtons) b.classList.toggle('on', d === direction);
  };
  const turn = (direction: string) => {
    if (!F) return;
    F.direction = direction;
    show(direction);
    highlight(direction);
  };
  const stepBy = (n: number) => {
    const i = order.indexOf(F!.direction);
    turn(order[(i + n + order.length * 4) % order.length]);
  };
  F!.turn = turn;
  show(F!.direction);

  // Drag sideways to turn, a step every few pixels, the way a turntable is spun by hand.
  let dragX: number | null = null;
  stage.onpointerdown = (e) => { dragX = e.clientX; stage.setPointerCapture(e.pointerId); F!.spinning = false; spin.classList.remove('on'); };
  stage.onpointermove = (e) => {
    if (dragX === null) return;
    const steps = Math.trunc((e.clientX - dragX) / DRAG_STEP_PX);
    if (steps) { dragX += steps * DRAG_STEP_PX; stepBy(steps); }
  };
  stage.onpointerup = stage.onpointercancel = () => { dragX = null; };
  stage.onkeydown = (e) => {
    if (e.key === 'ArrowRight') { e.preventDefault(); e.stopPropagation(); stepBy(1); }
    else if (e.key === 'ArrowLeft') { e.preventDefault(); e.stopPropagation(); stepBy(-1); }
  };

  const controls = el('div', 'tt-controls');
  const prev = el('button', null, '◀'); prev.type = 'button'; prev.title = 'Turn back'; prev.onclick = () => stepBy(-1);
  const next = el('button', null, '▶'); next.type = 'button'; next.title = 'Turn on'; next.onclick = () => stepBy(1);
  const spin = el('button', F!.spinning ? 'on' : null, 'Spin'); spin.type = 'button';
  spin.title = 'Turn through every rotation on a loop';
  spin.onclick = () => { F!.spinning = !F!.spinning; F!.lastSpin = performance.now(); spin.classList.toggle('on', F!.spinning); };
  prev.disabled = next.disabled = spin.disabled = order.length < 2;
  controls.append(prev, next, spin);

  const side = el('div', 'tt-side');
  side.append(rose, controls, label);
  const open = el('button', 'linkish', 'Open ' + source.assetId); open.type = 'button';
  open.onclick = () => { closeFamily(); openItem(source.id); };
  side.append(open);
  const row = el('div', 'tt-row');
  row.append(stage, side);
  wrap.append(row);
  wrap.append(el('small', 'state-dim', order.length > 1 ? 'Drag the sprite sideways, use ← and →, or pick a direction to turn it. The loops below follow.' : 'One direction: this ' + (root.character.generator === 'objectPro' ? 'object' : 'character') + ' does not turn.'));
  return wrap;
}

// ---- loop grid -------------------------------------------------------------

function loopGrid(root, members, order) {
  const loops = members.filter((m) => m.character.kind === 'animation');
  const wrap = el('section', 'loop-grid');
  const head = el('div', 'lg-head');
  head.append(el('h3', null, loops.length ? 'Loops' : 'No loops yet'));
  if (loops.length) {
    const play = el('button', null, F!.playing ? 'Pause' : 'Play'); play.type = 'button';
    play.onclick = () => {
      F!.playing = !F!.playing;
      play.textContent = F!.playing ? 'Pause' : 'Play';
      if (F!.playing) F!.t0 = performance.now();
    };
    head.append(play);
    const speed = el('select');
    speed.setAttribute('aria-label', 'Playback speed');
    for (const s of SPEEDS) speed.append(new Option(s + '×', String(s)));
    speed.value = String(F!.speed);
    speed.onchange = () => { F!.speed = Number(speed.value); F!.t0 = performance.now(); };
    head.append(speed);
  }
  wrap.append(head);
  if (!loops.length) {
    wrap.append(el('p', 'state-dim', EDITABLE ? 'Add one from the base\'s drawer (+ New animation), or draft a whole character in the studio.' : 'None declared.'));
    return wrap;
  }

  // Every direction the family turns through or a loop faces, in turning order.
  const used = new Set([...order, ...loops.map((l) => l.character.direction).filter(Boolean)]);
  const columns = COMPASS.filter((d) => used.has(d));
  const rows = new Map<string, any[]>();
  for (const l of loops) {
    const k = (l.character.parentKey || '') + '|' + loopName(l);
    if (!rows.has(k)) rows.set(k, []);
    rows.get(k)!.push(l);
  }

  const table = el('table', 'lg');
  const thead = el('thead');
  const hr = el('tr');
  hr.append(el('th', 'lg-name', ''));
  for (const d of columns) {
    const th = el('th', null);
    const b = el('button', 'lg-dir', SHORT[d]); b.type = 'button'; b.title = 'Turn to ' + d;
    b.disabled = !order.includes(d);
    b.onclick = () => F && F.turn && F.turn(d);
    th.append(b);
    hr.append(th);
    column(d, th);
  }
  thead.append(hr);
  table.append(thead);

  const tbody = el('tbody');
  for (const [k, cells] of rows) {
    const parentKey = k.split('|')[0];
    const parent = byKey(root.project, parentKey) || root;
    const tr = el('tr');
    const th = el('th', 'lg-name');
    const name = loopName(cells[0]);
    th.append(el('b', 'mono', name.startsWith(root.assetId + '.') ? name.slice(root.assetId.length + 1) : name));
    const sample = cells.find((l) => !l.mirrorOfKey) || cells[0];
    const meta = [sample.character.mode, frameUrls(sample).length ? frameUrls(sample).length + ' frames' : null, parent !== root ? 'from ' + parent.assetId.replace(root.assetId + '.', '') : null].filter(Boolean).join(' · ');
    th.append(el('small', null, meta));
    tr.append(th);
    for (const d of columns) {
      const td = el('td');
      column(d, td);
      const item = cells.find((l) => l.character.direction === d);
      td.append(item ? loopCell(item, parent, d) : el('span', 'lg-none', '·'));
      tr.append(td);
    }
    tbody.append(tr);
  }
  table.append(tbody);
  const scroller = el('div', 'lg-scroll');
  scroller.append(table);
  wrap.append(scroller);
  wrap.append(el('small', 'state-dim', 'Every loop plays on one clock. ⇋ marks a mirror, flipped locally at no cost. A dimmed cell is the parent\'s rotation, standing in until that loop is generated.'));
  return wrap;
}

function column(direction: string, node: HTMLElement) {
  if (!F!.columns.has(direction)) F!.columns.set(direction, []);
  F!.columns.get(direction)!.push(node);
}

function loopCell(item, parent, direction) {
  const tone = STATE_TONE[item.state] || 'dim';
  const b = el('button', 'lg-cell tone-' + tone);
  b.type = 'button';
  b.title = item.key + ' · ' + item.state + (item.reason ? ': ' + item.reason : '') + (item.mirrorOfKey ? ' · mirror of ' + item.mirrorOfKey : '');
  b.onclick = () => { closeFamily(); openItem(item.id); };
  const img = el('img');
  img.alt = item.assetId;
  const urls = frameUrls(item);
  if (urls.length) {
    fitCell(img, item.width, item.height);
    img.src = urls[0];
    for (const u of urls) { const p = new Image(); p.src = u; }
    if (urls.length > 1) F!.anims.push({ img, urls, fps: item.fps || 12, index: 0 });
  } else {
    // Nothing drawn yet: the parent's matching rotation stands in, dimmed.
    const ghost = rotationUrl(parent, direction);
    if (ghost) { fitCell(img, parent.width, parent.height); img.src = ghost; b.classList.add('ghost'); } else img.hidden = true;
  }
  b.append(img);
  if (item.mirrorOfKey) b.append(el('span', 'lg-mirror', '⇋'));
  if (item.state !== 'ok') b.append(el('span', 'lg-state', item.state));
  return b;
}

function extrasStrip(extras) {
  const wrap = el('section', 'family-extras');
  wrap.append(el('h3', null, extras.some((e) => e.character.kind === 'outfit') ? 'Portraits and outfits' : extras.length === 1 ? 'Portrait' : 'Portraits'));
  const strip = el('div', 'fx-strip');
  for (const item of extras) {
    const b = el('button', 'lg-cell tone-' + (STATE_TONE[item.state] || 'dim'));
    b.type = 'button';
    b.title = item.key + ' · ' + item.state;
    b.onclick = () => { closeFamily(); openItem(item.id); };
    const img = el('img'); img.alt = item.assetId;
    const urls = frameUrls(item);
    if (urls.length) {
      fitCell(img, item.width, item.height);
      img.src = urls[0];
      if (urls.length > 1) F!.anims.push({ img, urls, fps: item.fps || 12, index: 0 });
    } else img.hidden = true;
    b.append(img);
    if (item.state !== 'ok') b.append(el('span', 'lg-state', item.state));
    const fig = el('figure');
    fig.append(b, el('figcaption', 'mono', item.assetId));
    strip.append(fig);
  }
  wrap.append(strip);
  return wrap;
}

/** Pixel art in a cell: scaled up by whole steps to fill it, or down to fit. */
function fitCell(img: HTMLImageElement, width: number, height: number) {
  const s = displayScale(width, height, CELL_PX, CELL_PX);
  img.width = Math.max(1, Math.round(width * s));
  img.height = Math.max(1, Math.round(height * s));
}

function highlight(direction: string) {
  if (!F) return;
  for (const [d, nodes] of F.columns) for (const n of nodes) n.classList.toggle('col-on', d === direction);
}

// ---- one clock for every loop ---------------------------------------------------

function tick(now: number) {
  if (!F) return;
  if (!F.panel || !F.panel.isConnected) { stopFamily(); return; }
  if (F.playing) {
    // A frame's timestamp can fall a moment before the clock was (re)started.
    const seconds = Math.max(0, ((now - F.t0) / 1000) * F.speed);
    for (const a of F.anims) {
      const i = Math.floor(seconds * a.fps) % a.urls.length;
      if (i !== a.index) { a.index = i; a.img.src = a.urls[i]; }
    }
  }
  if (F.spinning && F.turn && now - F.lastSpin >= SPIN_MS / F.speed) {
    F.lastSpin = now;
    const source = S.snap.items.find((i) => i.id === F!.source);
    const order = source ? turnOrder(source) : COMPASS;
    F.turn(order[(order.indexOf(F.direction) + 1) % order.length]);
  }
  F.raf = requestAnimationFrame(tick);
}

/** For browser tests: what the open family sheet is showing. */
export const familyState = () => F && { rootId: F.rootId, source: F.source, direction: F.direction, playing: F.playing, anims: F.anims.length };
