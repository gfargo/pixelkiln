import type { GalleryItem } from "../../snapshot.ts"
import { $, S, displayScale, el, fmtCost, fmtWhen, ui, backdropControl } from "./core.ts"
import { openItem, render } from "./drawer.ts"

// ---- compare ---------------------------------------------------------------

export function toggleCompare(id) {
  const at = ui.compare.indexOf(id);
  if (at >= 0) ui.compare.splice(at, 1);
  else if (ui.compare.length >= 4) { $('note').textContent = ' Compare holds four records; remove one first.'; return; }
  else ui.compare.push(id);
  $('note').textContent = '';
  render();
}
export function renderTray() {
  let tray = $('tray');
  if (!ui.compare.length) { if (tray) tray.remove(); return; }
  if (!tray) { tray = el('div', 'tray'); tray.id = 'tray'; document.body.append(tray); }
  tray.textContent = '';
  const chips = el('div', 'chipset');
  for (const id of ui.compare) {
    const item = S.snap.items.find((i) => i.id === id);
    if (!item) continue;
    const pick = el('span', 'pick');
    const shown = item.outputs.find((o) => o.url);
    if (shown) { const t = el('img'); t.src = shown.url!; t.alt = ''; pick.append(t); }
    pick.append(document.createTextNode((item.project ? item.project + ':' : '') + item.styleId + '/' + item.assetId));
    const x = el('button', null, '×'); x.type = 'button'; x.title = 'Remove from comparison';
    x.onclick = () => toggleCompare(id);
    pick.append(x);
    chips.append(pick);
  }
  const go = el('button', 'primary', 'Compare ' + ui.compare.length); go.type = 'button';
  go.disabled = ui.compare.length < 2;
  go.onclick = () => openCompare();
  const clear = el('button', null, 'Clear'); clear.type = 'button';
  clear.onclick = () => { ui.compare = []; render(); };
  tray.append(chips, go, clear);
}
export function openCompare() {
  const items = ui.compare.map((id) => S.snap.items.find((i) => i.id === id)).filter((i): i is GalleryItem => Boolean(i));
  if (items.length < 2) return;
  const host = $('dialog-host');
  host.textContent = '';
  const scrim = el('div', 'sheet-scrim'); scrim.onclick = () => { host.textContent = ''; };
  const panel = el('div', 'sheet compare-host');
  const bar = el('div', 'rbar');
  const close = el('button', null, 'Back to gallery'); close.type = 'button'; close.onclick = () => { host.textContent = ''; };
  bar.append(close, el('span', null, 'Fields that differ are tinted. Shift-click cards in the gallery to change the set.'));
  const zoomBar = el('div', 'zoom');
  zoomBar.append(el('span', null, 'zoom'));
  const columnWidth = Math.max(160, Math.floor((Math.min(window.innerWidth * 0.96, 1500) - 140) / items.length) - 24);
  const largest = Math.max(...items.map((i) => Math.max(i.width, i.height)));
  const auto = displayScale(largest, largest, columnWidth, Math.min(window.innerHeight * 0.5, 520));
  for (const z of ['fit', 1, 2, 4, 8]) {
    const b = el('button', ui.compareZoom === String(z) || (ui.compareZoom === 'auto' && z === auto) ? 'on' : null, z === 'fit' ? 'fit' : z + '×');
    b.type = 'button'; b.onclick = () => { ui.compareZoom = String(z); openCompare(); };
    zoomBar.append(b);
  }
  bar.append(zoomBar, backdropControl());
  const zoom = ui.compareZoom === 'auto' ? auto : ui.compareZoom === 'fit' ? Math.min(auto, 1) : Number(ui.compareZoom);

  const body = el('div', 'compare-body');
  const table = el('table');
  const thead = el('thead'); const hr = el('tr'); hr.append(el('th', null, ''));
  for (const item of items) {
    const th = el('th');
    const head = el('div', 'chead');
    const badges = el('div', 'badges');
    if (item.project) badges.append(el('span', 'sid project', item.project));
    badges.append(el('span', 'sid', item.styleId));
    const aid = el('div', 'aid', item.assetId);
    const openBtn = el('button', 'linkish', 'open record'); openBtn.type = 'button';
    openBtn.onclick = () => { host.textContent = ''; openItem(item.id); };
    head.append(badges, aid, openBtn);
    th.append(head);
    hr.append(th);
  }
  thead.append(hr); table.append(thead);
  const tbody = el('tbody');

  // Images first, at one shared zoom, so like is compared with like.
  const imgRow = el('tr'); imgRow.append(el('td', null, 'art'));
  for (const item of items) {
    const td = el('td');
    const box = el('div', 'cimg');
    const shown = item.outputs.find((o) => o.url);
    if (shown) {
      const img = el('img'); img.src = shown.url!; img.alt = item.assetId;
      if (zoom >= 1) { img.width = Math.round(item.width * zoom); img.height = Math.round(item.height * zoom); }
      else { img.style.maxWidth = '100%'; img.style.height = 'auto'; }
      box.append(img);
    } else box.append(el('span', 'none', 'no art on disk'));
    td.append(box);
    if (item.outputs.filter((o) => o.url).length > 1) td.append(el('div', 'state-dim', item.outputs.length + ' outputs; first shown'));
    imgRow.append(td);
  }
  tbody.append(imgRow);

  const rows = [
    ['state', (i) => i.state + (i.reason ? ': ' + i.reason : ''), (i) => i.state],
    ['provider', (i) => i.provider],
    ['generator', (i) => i.generator + (i.tileFeature ? ' · ' + i.tileFeature : '')],
    ['candidates', (i) => i.candidates ?? '—'],
    ['size', (i) => i.width + ' × ' + i.height],
    ['cost', (i) => i.status ? fmtCost(i.costUnit, i.cost) : (i.estimatedCost !== null ? 'est. ' + fmtCost(i.costUnit, i.estimatedCost) : '—')],
    ['prompt', (i) => i.prompt, null, 'prompt'],
    ['submitted', (i) => fmtWhen(i.submittedAt) || '—'],
    ['downloaded', (i) => fmtWhen(i.downloadedAt) || '—'],
    ['quality', (i) => i.quality ? i.quality.state + (i.quality.review && i.quality.review.status === 'approved' ? ' by ' + i.quality.review.reviewer : '') : '—'],
    ['spec hash', (i) => i.recordedSpecHash ? i.recordedSpecHash.slice(0, 16) + '…' : '—', null, 'mono'],
    ['sha256', (i) => i.outputs[0] && i.outputs[0].sha256 ? i.outputs[0].sha256.slice(0, 16) + '…' : '—', null, 'mono'],
    ['tags', (i) => (i.tags || []).filter((t) => !/^(pixelkiln|asset|style):/.test(t)).join(', ') || '—'],
  ];
  for (const [label, show, keyOf, cls] of rows as any[]) {
    const tr = el('tr'); tr.append(el('td', null, label));
    const keys = items.map((i) => String((keyOf || show)(i)));
    const differs = new Set(keys).size > 1;
    for (const item of items) {
      const td = el('td', (differs ? 'diff' : '') + (cls === 'mono' ? ' mono' : ''));
      if (cls === 'prompt') td.append(el('div', 'prompt', show(item))); else td.textContent = String(show(item));
      tr.append(td);
    }
    tbody.append(tr);
  }
  table.append(tbody);
  body.append(table);
  panel.append(bar, body);
  host.append(scrim, panel);
  close.focus({ preventScroll: true });
}
