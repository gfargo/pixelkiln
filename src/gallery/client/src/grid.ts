import { toggleCompare } from "./compare.ts"
import { $, S, STATE_ORDER, STATE_TONE, displayScale, el, fmtCost, fmtSpend, fmtWhen, isFrameSet, postEdit, projectOf, shortPath, ui } from "./core.ts"
import { openItem, render, renderDrawer, row } from "./drawer.ts"
import { budgetLine, generateDialog, openReview } from "./editor.ts"
import { addAssetForm, styleForm } from "./forms.ts"
import { JOB_VERB, PHASE_TEXT, activeJobFor, familyLabel, paletteRuleOf } from "./jobs.ts"
import { pruneLoops, registerLoop } from "./motion.ts"
import { familyMembers, familyRoot, loopName, openFamily } from "./family.ts"
import { selectAllButton, toggleSelected } from "./selection.ts"

export function visibleItems() {
  const q = ui.q.trim().toLowerCase();
  let items = S.snap.items.filter((item) => {
    if (ui.states.size && !ui.states.has(item.state)) return false;
    if (ui.providers.size && !ui.providers.has(item.provider)) return false;
    if (ui.generators.size && !ui.generators.has(item.generator)) return false;
    if (ui.projects.size && !ui.projects.has(item.project ?? '')) return false;
    if (!q) return true;
    const hay = [item.id, item.prompt, item.currentPrompt, item.jobId, item.objectId,
      item.recordedSpecHash, item.currentSpecHash, item.category, ...(item.tags || []),
      ...item.outputs.flatMap((o) => [o.path, o.sha256])].filter(Boolean).join('\n').toLowerCase();
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

export function renderHeader() {
  $('editing').hidden = !EDITABLE;
  $('foot-edit').hidden = EDITABLE;
  $('foot-editing').hidden = !EDITABLE;
  $('foot-gen').hidden = !GENERATION;
  const p = $('project');
  p.textContent = '';
  if (S.snap.workspace) {
    p.append(el('b', null, 'workspace'), ' ', document.createTextNode(shortPath(S.snap.workspace.path)));
    p.title = S.snap.workspace.path;
  } else {
    p.append(el('b', null, S.snap.project!.name), ' ', document.createTextNode(shortPath(S.snap.project!.manifest)));
    p.title = S.snap.project!.manifest + '\nlockfile: ' + S.snap.project!.lock;
  }

  const t = $('totals');
  t.textContent = '';
  if (S.snap.workspace) {
    const broken = S.snap.workspace.projects.filter((pr) => pr.error).length;
    const w = el('span', null, '');
    w.append(el('b', null, S.snap.workspace.projects.length), document.createTextNode(' project' +
      (S.snap.workspace.projects.length === 1 ? '' : 's') + (broken ? ' (' + broken + ' unreadable)' : '')));
    t.append(w);
  }
  const n = S.snap.totals.entries;
  t.append(el('span', null, ''));
  t.lastChild.append(el('b', null, n), document.createTextNode(' lock ' + (n === 1 ? 'entry' : 'entries')));
  const declared = S.snap.items.filter((i) => i.declared).length;
  t.append(el('span', null, declared + ' declared by ' + (S.snap.workspace ? 'a manifest' : 'the manifest')));
  const recorded = fmtSpend(S.snap.totals.spendByUnit);
  t.append(el('span', null, recorded === 'no spend recorded' ? recorded : recorded + ' recorded'));
  if (S.snap.filter.styles.length || S.snap.filter.assets.length) {
    t.append(el('span', 'state-warn', 'filtered: ' +
      [S.snap.filter.styles.length ? '--style ' + S.snap.filter.styles.join(',') : '',
       S.snap.filter.assets.length ? '--only ' + S.snap.filter.assets.join(',') : ''].filter(Boolean).join(' ')));
  }
  t.append(el('span', null, 'snapshot ' + fmtWhen(S.snap.generatedAt)));
  if (GENERATION) {
    const line = budgetLine();
    if (line) t.append(el('span', 'budget', line));
  }

  const chips = $('chips');
  chips.textContent = '';
  const counts = (pick) => {
    const m = new Map();
    for (const item of S.snap.items) { const k = pick(item); m.set(k, (m.get(k) || 0) + 1); }
    return m;
  };
  const chip = (label, count, set, key, tone?) => {
    const b = el('button', 'chip' + (set.has(key) ? ' on' : ''));
    b.type = 'button';
    b.setAttribute('aria-pressed', String(set.has(key)));
    if (tone) b.append(el('i', 'dot ' + tone));
    b.append(document.createTextNode(label), el('span', 'n', count));
    b.onclick = () => { set.has(key) ? set.delete(key) : set.add(key); render(); };
    return b;
  };
  if (S.snap.workspace) {
    const byProject = counts((i) => i.project);
    for (const pr of S.snap.workspace.projects) {
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

export function clearFilters() {
  ui.states.clear(); ui.providers.clear(); ui.generators.clear(); ui.projects.clear();
  ui.q = ''; $('q').value = '';
  render();
}

export function thumb(item) {
  const cell = el('div', 'cell');
  // A hand edit is what ships, so it is what the card shows.
  const shown = item.edit && item.editStatus === 'edited' && item.edits.every((e) => e.url) ? item.edits : item.outputs.filter((o) => o.url);
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

export function card(item) {
  const slot = ui.compare.indexOf(item.id);
  const picked = ui.selected.has(item.id);
  const c = el('button', 'card' + (item.outputs.some((o) => o.url) ? '' : ' ghost') + (ui.open === item.id ? ' active' : '') + (slot >= 0 ? ' compared' : '') + (picked ? ' selected' : ''));
  if (ui.selecting) c.setAttribute('aria-pressed', String(picked));
  c.type = 'button';
  c.dataset.key = item.id;
  c.setAttribute('aria-label', item.id + ', ' + item.state + (slot >= 0 ? ', in comparison' : ''));
  const body = el('div', 'cbody');
  body.append(el('div', 'aid', item.assetId));
  const meta = el('div', 'cmeta');
  const st = el('span', 'st');
  st.append(el('i', 'dot ' + STATE_TONE[item.state]), document.createTextNode(item.state));
  meta.append(st, el('span', null, item.width + '×' + item.height));
  if (item.cost) meta.append(el('span', null, fmtCost(item.costUnit, item.cost)));
  body.append(meta);
  const family = familyLabel(item);
  if (family) body.append(el('div', 'family', family));
  const cell = thumb(item);
  if (slot >= 0) cell.append(el('span', 'slot', String(slot + 1)));
  if (item.editStatus === 'edited' || item.editStatus === 'regenerated-since') {
    const pen = el('span', 'pen', '✎'); pen.title = 'hand-edited'; cell.append(pen);
  }
  const job = activeJobFor(item);
  if (job) {
    const badge = el('span', 'busy-badge');
    badge.append(el('i', 'dot busy'), document.createTextNode(job.phase === 'review' ? 'review' : job.mode === 'generate' ? 'generating' : job.mode));
    badge.title = (JOB_VERB[job.mode] || job.mode) + ' this asset: ' + (PHASE_TEXT[job.phase] || job.phase);
    cell.append(badge);
  }
  c.append(cell, body);
  if (ui.selecting) cell.append(el('span', 'sel', '✓'));
  c.onclick = (e) => {
    if (e.shiftKey) toggleCompare(item.id);
    else if (ui.selecting || e.metaKey || e.ctrlKey) toggleSelected(item.id);
    else openItem(item.id);
  };
  // A loop plays under the pointer (or always, with "play loops" on).
  const still = cell.querySelector(':scope > img') as HTMLImageElement | null;
  const shown = item.edit && item.editStatus === 'edited' && item.edits.every((e) => e.url) ? item.edits : item.outputs.filter((o) => o.url);
  if (still && isFrameSet(item) && shown.length > 1) registerLoop(still, shown.map((o) => o.url), item.fps || 12, c);
  return c;
}

export function renderMain(items) {
  const root = $('root');
  root.textContent = '';
  pruneLoops();
  if (!S.snap.items.length) {
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
  const projects = S.snap.workspace
    ? S.snap.workspace.projects.filter((pr) => ui.projects.size
        ? ui.projects.has(pr.id)
        : unfiltered || shown.some((i) => i.project === pr.id))
    : [null];
  const sections: any = [];
  for (const pr of projects) {
    const inProject = pr ? shown.filter((i) => i.project === pr.id) : shown;
    const styleSections = ui.group === 'style' || ui.group === 'family'
      ? S.snap.styles.filter((s) => !pr || s.project === pr.id)
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
      if (s.characters) {
        const parts: any = [];
        parts.push(s.characters.bases + (s.characters.bases === 1 ? ' character' : ' characters'));
        if (s.characters.states) parts.push(s.characters.states + (s.characters.states === 1 ? ' state' : ' states'));
        if (s.characters.animations) parts.push(s.characters.animations + (s.characters.animations === 1 ? ' loop' : ' loops'));
        if (s.characters.portraits) parts.push(s.characters.portraits + (s.characters.portraits === 1 ? ' portrait' : ' portraits'));
        if (s.characters.outfits) parts.push(s.characters.outfits + (s.characters.outfits === 1 ? ' outfit' : ' outfits'));
        meta.append(el('span', null, parts.join(', ')));
      }
      meta.append(el('span', null, sec.items.length + ' of ' + s.items + (s.items === 1 ? ' asset' : ' assets')));
      if (Object.keys(s.spendByUnit).length) meta.append(el('span', null, fmtSpend(s.spendByUnit)));
      head.append(meta);
      const addKey = 'new:' + (s.project || '') + ':' + s.id;
      const tools = el('div', 'tools');
      if (s.outDir && s.candidates !== null) tools.append(candidatesControl(s));
      if (GENERATION && s.actionable.keys.length) {
        const g = el('button', 'primary', 'Generate ' + s.actionable.keys.length + ' · ' + fmtCost(s.actionable.costUnit, Math.round(s.actionable.cost * 100) / 100));
        g.type = 'button';
        g.onclick = () => generateDialog(S.snap.items.filter((i) => i.project === s.project && s.actionable.keys.includes(i.key)), { project: s.project });
        tools.append(g);
      }
      const refreshable = S.snap.items.filter((i) => i.project === s.project && i.styleId === s.id && i.refreshable && i.upstreamUrl);
      if (GENERATION && refreshable.length) {
        const r = el('button', null, 'Pull upstream ' + refreshable.length); r.type = 'button';
        r.title = 'Re-download objects edited in the provider’s own editor; no cost';
        r.onclick = () => generateDialog(refreshable, { project: s.project, refresh: true });
        tools.append(r);
      }
      if (ui.selecting && ui.group !== 'family') tools.append(selectAllButton(sec.items));
      const styleKey = 'style:' + (s.project || '') + ':' + s.id;
      if (EDITABLE && s.outDir) {
        const es = el('button', null, ui.editing === styleKey ? 'Cancel' : 'Edit style');
        es.type = 'button';
        es.onclick = () => { ui.editing = ui.editing === styleKey ? null : styleKey; ui.notice = null; render(); };
        tools.append(es);
        const add = el('button', 'add', ui.editing === addKey ? 'Cancel' : '+ Add asset');
        add.type = 'button';
        add.onclick = () => { ui.editing = ui.editing === addKey ? null : addKey; render(); };
        tools.append(add);
      }
      if (tools.childNodes.length) head.append(tools);
      wrap.append(head);
      if (ui.notice && ui.notice.id === styleKey) wrap.append(el('div', 'notice', ui.notice.text));
      if (ui.editing === styleKey) wrap.append(styleForm(s));
      if (ui.editing === addKey) wrap.append(addAssetForm(s));
    }
    if (ui.group === 'family') wrap.append(...familyGroups(sec.items));
    else {
      const grid = el('div', 'grid');
      for (const item of sec.items) grid.append(card(item));
      wrap.append(grid);
    }
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

// ---- families on the grid ------------------------------------------------------

const KIND_ORDER = { base: 0, state: 1, animation: 2, portrait: 3, outfit: 4 };
const TURN = ['south', 'south-east', 'east', 'north-east', 'north', 'north-west', 'west', 'south-west'];

/** A family's members in reading order: base, states, each loop around the compass, portraits, outfits. */
function familyOrder(a, b) {
  const ka = KIND_ORDER[a.character.kind] ?? 9, kb = KIND_ORDER[b.character.kind] ?? 9;
  if (ka !== kb) return ka - kb;
  if (a.character.kind === 'animation') {
    const la = loopName(a), lb = loopName(b);
    if (la !== lb) return la < lb ? -1 : 1;
    return TURN.indexOf(a.character.direction) - TURN.indexOf(b.character.direction);
  }
  return a.assetId < b.assetId ? -1 : a.assetId > b.assetId ? 1 : 0;
}

/**
 * One row per character or object: its header (counts, the family view, one
 * Generate for whatever is missing) over its cards. Anything outside a
 * family keeps the plain grid, after them.
 */
function familyGroups(items) {
  const families = new Map<string, { root: any; members: any[] }>();
  const loose: any[] = [];
  for (const item of items) {
    const root = item.character ? familyRoot(item) : null;
    if (!root) { loose.push(item); continue; }
    if (!families.has(root.id)) families.set(root.id, { root, members: [] });
    families.get(root.id)!.members.push(item);
  }
  const out: HTMLElement[] = [];
  for (const { root, members } of families.values()) {
    members.sort(familyOrder);
    const group = el('div', 'fam-group');
    const head = el('div', 'fam-head');
    head.append(el('b', 'mono', root.assetId));
    const counts: Record<string, number> = {};
    for (const m of members) counts[m.state] = (counts[m.state] || 0) + 1;
    const tally = el('span', 'fam-tally');
    const loops = new Set(members.filter((m) => m.character.kind === 'animation').map(loopName)).size;
    tally.append(document.createTextNode(members.length + (members.length === 1 ? ' asset' : ' assets') + (loops ? ' · ' + loops + (loops === 1 ? ' loop' : ' loops') : '')));
    for (const [state, n] of Object.entries(counts)) {
      const t = el('span', 'st');
      t.append(el('i', 'dot ' + STATE_TONE[state]), document.createTextNode(n + ' ' + state));
      tally.append(t);
    }
    head.append(tally);
    const tools = el('div', 'tools');
    if (ui.selecting) tools.append(selectAllButton(members));
    const view = el('button', null, 'Family view'); view.type = 'button';
    view.onclick = () => openFamily(root);
    tools.append(view);
    const everything = familyMembers(root);
    const todo = everything.filter(actionable);
    if (GENERATION && todo.length) {
      const g = el('button', 'primary', 'Generate ' + todo.length + ' · ' + priceOf(todo)); g.type = 'button';
      g.title = 'One job for the family: parents first, then everything drawn from them';
      g.onclick = () => generateDialog(todo, { project: root.project });
      tools.append(g);
    }
    head.append(tools);
    const grid = el('div', 'grid');
    for (const m of members) grid.append(card(m));
    group.append(head, grid);
    out.push(group);
  }
  if (loose.length) {
    const group = el('div', 'fam-group loose');
    if (families.size) {
      const head = el('div', 'fam-head');
      head.append(el('b', null, 'Not in a family'), el('span', 'fam-tally', loose.length + (loose.length === 1 ? ' asset' : ' assets')));
      if (ui.selecting) { const tools = el('div', 'tools'); tools.append(selectAllButton(loose)); head.append(tools); }
      group.append(head);
    }
    const grid = el('div', 'grid');
    for (const item of loose) grid.append(card(item));
    group.append(grid);
    out.push(group);
  }
  return out;
}

/** Generate would do something for it: nothing made yet, out of date, or failed. */
export const actionable = (item) => item.declared && item.currentSpecHash !== null && ['missing', 'stale', 'failed'].includes(item.state);

/** A total per unit, the way a style header prices its Generate. */
export function priceOf(items) {
  const totals: Record<string, number> = {};
  for (const i of items) if (i.estimatedCost !== null) totals[i.costUnit] = (totals[i.costUnit] || 0) + i.estimatedCost;
  return Object.entries(totals).map(([unit, n]) => fmtCost(unit, Math.round(n * 100) / 100)).join(' + ') || 'free';
}

export function projectHeader(pr, count) {
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

// How many images one generation returns for this style. A provider option
// where the adapter has one; a fact of the generator where it does not.
export function candidatesControl(style) {
  const wrap = el('span', 'cand');
  const editKey = 'cand:' + (style.project || '') + ':' + style.id;
  const declared = S.snap.items.filter((i) => i.project === style.project && i.styleId === style.id && i.declared).length;
  if (!(EDITABLE && style.candidatesEditable) || ui.editing !== editKey) {
    wrap.append(el('span', null, style.candidates + (style.candidates === 1 ? ' candidate' : ' candidates') + ' per generation'));
    if (EDITABLE && style.candidatesEditable) {
      const b = el('button', null, 'change'); b.type = 'button';
      b.onclick = () => { ui.editing = editKey; render(); };
      wrap.append(b);
    } else if (style.provider === 'pixellab') {
      wrap.title = 'PixelLab: map and pixflux return one image per generation; a 1dir style returns 4–64 for its size.';
    }
    return wrap;
  }
  const input = el('input'); input.type = 'number'; input.min = '1'; input.max = '64'; input.value = String(style.candidates);
  const save = el('button', 'primary', 'Save'); save.type = 'button';
  const cancel = el('button', null, 'Cancel'); cancel.type = 'button'; cancel.onclick = () => { ui.editing = null; render(); };
  const note = el('span', null, 'affects ' + declared + (declared === 1 ? ' asset, which becomes stale' : ' assets, which become stale'));
  save.onclick = async () => {
    save.disabled = true;
    try {
      const pr = S.snap.workspace ? S.snap.workspace.projects.find((x) => x.id === style.project) : S.snap.project;
      const body: any = { action: 'patch-style', styleId: style.id, expectedSha256: pr!.manifestSha256, patch: { candidates: Number(input.value) } };
      if (style.project) body.project = style.project;
      S.snap = await postEdit(body);
      ui.editing = null;
      render();
    } catch (err) {
      save.disabled = false;
      note.textContent = err.message;
      note.className = 'state-bad';
    }
  };
  wrap.append(input, save, cancel, note);
  setTimeout(() => input.focus(), 0);
  return wrap;
}

// The generations this one replaced: what the lockfile still remembers, with
// thumbnails from the content cache while the bytes are there, and a way back.
export function historySection(item) {
  const limit = projectOf(item)?.historyLimit;
  if (!item.history.length && !((limit ?? 0) > 0 && item.status === 'downloaded')) return null;
  const s = el('section', 'meta');
  s.append(el('h3', null, item.history.length ? 'Previous generations (' + item.history.length + ')' : 'Previous generations'));
  if (!item.history.length) {
    s.append(el('div', 'state-dim', 'None yet. A regeneration keeps the generation it replaces, up to ' + limit + ' per asset (PIXELKILN_HISTORY, or the manifest’s history), so it can be brought back from here.'));
    return s;
  }
  const list = el('div', 'versions');
  const job = GENERATION ? activeJobFor(item) : null;
  for (const g of item.history) {
    const v = el('div', 'version');
    const thumb = el('div', 'thumb');
    const first = g.outputs[0];
    if (first && first.url) { const img = el('img'); img.src = first.url; img.alt = 'generation #' + g.index; thumb.append(img); }
    else thumb.append(el('span', null, g.cached ? '' : 'not cached'));
    const facts = el('div', 'facts');
    const head = el('div');
    const billedNote = g.billed && (g.billed.unit !== g.costUnit || g.billed.amount !== g.cost)
      ? ' (billed ' + fmtCost(g.billed.unit, g.billed.amount) + ')' : '';
    head.append(el('b', null, '#' + g.index), document.createTextNode(' · ' + fmtWhen(g.downloadedAt || g.submittedAt) + ' · ' + fmtCost(g.costUnit, g.cost) + billedNote +
      (g.outputs.length > 1 ? ' · ' + g.outputs.length + ' files' : '')));
    facts.append(head);
    const prompt = el('div', 'prompt' + (g.promptDiffers ? ' differs' : ''), (g.promptDiffers ? 'prompt: ' : 'same prompt: ') + g.prompt);
    prompt.title = g.prompt;
    facts.append(prompt);
    const meta = el('div', 'meta');
    meta.append(document.createTextNode((first ? first.sha256.slice(0, 12) + '…' : '') + (g.cached ? ' · bytes cached locally' : ' · not in the local cache; a restore re-downloads it')));
    if (g.upstreamUrl) { const a = el('a', null, 'open in ' + item.provider + ' ↗'); a.href = g.upstreamUrl; a.target = '_blank'; a.rel = 'noopener'; meta.append(document.createTextNode(' · '), a); }
    facts.append(meta);
    const acts = el('div', 'acts');
    if (GENERATION) {
      const b = el('button', null, 'Restore this one · no cost'); b.type = 'button';
      b.disabled = !!job;
      b.title = job ? 'Wait for the running job to finish' : 'The current generation moves into history; this one becomes current and its bytes are written back';
      b.onclick = () => generateDialog([item], { project: item.project, revert: String(g.index), generation: g });
      acts.append(b);
    }
    v.append(thumb, facts, acts);
    list.append(v);
  }
  s.append(list);
  s.append(el('div', 'state-dim', 'Keeping up to ' + limit + ' per asset; a restore moves the current generation into this list, so it can be undone the same way.' +
    (GENERATION ? '' : ' Restoring needs the gallery started with --budget (any amount; nothing is spent).')));
  return s;
}

export function upstreamSection(item) {
  if (!item.upstreamUrl && !(GENERATION && item.refreshable)) return null;
  const s = el('section', 'meta');
  s.append(el('h3', null, 'Upstream'));
  const dl = el('dl');
  if (item.upstreamUrl) {
    const a = el('a', null, 'Open in ' + item.provider + ' ↗');
    a.href = item.upstreamUrl; a.target = '_blank'; a.rel = 'noopener';
    const tiles = item.generator === 'tiles';
    row(dl, tiles ? 'tile set' : 'object', a);
    row(dl, 'note', item.provider === 'pixellab'
      ? (tiles ? 'The tile set this generation was chosen from. Edit it there with PixelLab’s editor, then pull the changes back here; the lockfile records the new bytes as this generation.'
        : 'The account object this generation came from. Edit it there with PixelLab’s editor, then pull the changes back here; the lockfile records the new bytes as this generation.')
      : 'The provider’s page for this object.');
  }
  s.append(dl);
  if (GENERATION && item.refreshable) {
    const acts = el('div', 'hand-actions');
    const b = el('button', null, 'Pull upstream changes · no cost'); b.type = 'button';
    b.onclick = () => generateDialog([item], { project: item.project, refresh: true });
    acts.append(b);
    s.append(acts);
  }
  return s;
}

// What a job is doing to this record right now. The record's state line still
// says what is on disk; this says what is about to replace it.
export function jobStrip(item, job) {
  const strip = el('div', 'job-strip');
  const ph = el('span', 'ph');
  ph.append(el('i', 'dot busy'), document.createTextNode(job.phase));
  const last = el('span', 'last', job.messages.length ? job.messages[job.messages.length - 1].trim() : '');
  last.title = job.messages.join('\n');
  const what = el('span', 'what', (JOB_VERB[job.mode] || job.mode) + ' this asset: ' + (PHASE_TEXT[job.phase] || job.phase) +
    (job.mode === 'generate' && job.phase !== 'review' ? '. The current file stays until the new result is downloaded.' : '.'));
  strip.append(ph, last, what);
  const acts = el('div', 'acts');
  if (job.phase === 'review' && job.review.includes(item.key)) {
    const b = el('button', 'primary', 'Review candidates'); b.type = 'button'; b.onclick = () => openReview(job.id);
    acts.append(b);
  }
  const logBtn = el('button', null, ui.logs.has(job.id) ? 'Hide log' : 'Log'); logBtn.type = 'button';
  logBtn.onclick = () => { ui.logs.has(job.id) ? ui.logs.delete(job.id) : ui.logs.add(job.id); renderDrawer(); };
  acts.append(logBtn);
  strip.append(acts);
  if (ui.logs.has(job.id)) { const pre = el('pre', null, job.messages.join('\n')); pre.style.gridColumn = '1 / -1'; strip.append(pre); }
  return strip;
}

export function generateActions(item) {
  const row = el('div', 'gen');
  if (!GENERATION || !item.declared || item.currentSpecHash === null) return row;
  const cost = item.estimatedCost === null ? '' : ' · ' + fmtCost(item.costUnit, item.estimatedCost);
  const add = (label, cls, opts) => {
    const b = el('button', cls, label); b.type = 'button';
    b.onclick = () => generateDialog([item], { project: item.project, ...opts });
    row.append(b);
  };
  if (item.state === 'missing' || item.state === 'stale' || item.state === 'failed') add('Generate' + cost, 'primary', {});
  else if (item.state === 'ok') add('Regenerate' + cost, null, { force: true });
  else if (item.state === 'orphaned' && item.outputs.every((o) => o.exists)) {
    // The file changed after download. Putting the recorded bytes back and
    // regenerating both discard that change, so both say so and ask.
    add('Restore recorded bytes · no cost', null, { restore: true, force: true });
    add('Regenerate' + cost, null, { force: true });
  } else if (item.state === 'orphaned') add('Restore · no cost', 'primary', { restore: true });
  else if (item.state === 'untracked') add('Generate' + cost + ' · replaces the file', null, { force: true });
  if (item.state === 'recoverable' && item.status === 'downloaded') {
    // The files are fine; the manifest's palette rule changed under them.
    // A resume runs the same fetch that re-applies it, from the raw bytes.
    add(paletteRuleOf(item) ? 'Snap to the palette · no cost' : 'Put the provider’s bytes back · no cost', 'primary', { resume: true });
  } else if (item.state === 'in-flight' || item.state === 'recoverable') {
    // A job already parked this asset in review: go straight to its sheet.
    const holder = S.GEN.jobs.find((job) => job.phase === 'review' && job.project === item.project && job.review.includes(item.key));
    if (holder) {
      const b = el('button', 'primary', 'Review candidates'); b.type = 'button';
      b.onclick = () => openReview(holder.id);
      row.append(b);
    } else {
      add(item.status === 'review' ? 'Resume review' : 'Resume · no cost', 'primary', { resume: true });
    }
  }
  return row;
}
