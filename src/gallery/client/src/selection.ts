import { openCompare } from "./compare.ts"
import { $, S, el, postEdit, projectOf, ui } from "./core.ts"
import { render } from "./drawer.ts"
import { generateDialog } from "./editor.ts"
import { actionable, priceOf } from "./grid.ts"

/**
 * Selecting several records and acting on them together: generate what is
 * missing, regenerate what is done, compare, or tag. "Select" in the header
 * turns it on (so is ctrl/⌘-click on any card); a click then picks a card
 * instead of opening it, and the bar at the bottom holds the actions, each
 * with its count and price.
 */

const selectedItems = () => S.snap.items.filter((i) => ui.selected.has(i.id));
const regenerable = (i) => i.declared && i.currentSpecHash !== null && i.state === 'ok';

export function setSelecting(on: boolean) {
  ui.selecting = on;
  if (!on) ui.selected.clear();
  $('select').textContent = on ? 'Done selecting' : 'Select';
  $('select').classList.toggle('on', on);
  render();
}

export function toggleSelected(id: string) {
  if (!ui.selecting) { ui.selecting = true; $('select').textContent = 'Done selecting'; $('select').classList.add('on'); }
  if (ui.selected.has(id)) ui.selected.delete(id); else ui.selected.add(id);
  const c = document.querySelector('.card[data-key="' + CSS.escape(id) + '"]');
  if (c) { c.classList.toggle('selected', ui.selected.has(id)); c.setAttribute('aria-pressed', String(ui.selected.has(id))); }
  if (!document.querySelector('.card .sel')) render();
  else { refreshSelectAll(); renderSelectionBar(); }
}

/** "Select all n" for a style or family, or "Clear n" once they all are. */
export function selectAllButton(items) {
  const b = el('button', 'select-all');
  b.type = 'button';
  const ids = items.map((i) => i.id);
  (b as any).__ids = ids;
  const label = () => { b.textContent = ids.every((id) => ui.selected.has(id)) ? 'Clear ' + ids.length : 'Select all ' + ids.length; };
  (b as any).__label = label;
  label();
  b.onclick = () => {
    const all = ids.every((id) => ui.selected.has(id));
    for (const id of ids) { if (all) ui.selected.delete(id); else ui.selected.add(id); }
    for (const id of ids) {
      const c = document.querySelector('.card[data-key="' + CSS.escape(id) + '"]');
      if (c) { c.classList.toggle('selected', ui.selected.has(id)); c.setAttribute('aria-pressed', String(ui.selected.has(id))); }
    }
    refreshSelectAll();
    renderSelectionBar();
  };
  return b;
}

function refreshSelectAll() {
  for (const b of document.querySelectorAll('.select-all')) (b as any).__label?.();
}

export function renderSelectionBar() {
  const bar = $('selbar');
  bar.textContent = '';
  // Anything no longer in the snapshot drops out of the selection.
  for (const id of [...ui.selected]) if (!S.snap.items.some((i) => i.id === id)) ui.selected.delete(id);
  bar.hidden = !ui.selecting;
  if (!ui.selecting) return;
  const items = selectedItems();
  const projects = new Set(items.map((i) => i.project));
  const oneProject = projects.size <= 1;
  const project = items.length ? items[0].project : null;
  bar.append(el('b', null, items.length ? items.length + ' selected' : 'Click cards to select them'));
  const acts = el('div', 'acts');
  const add = (label: string, run: () => void, opts: { primary?: boolean; disabled?: boolean; title?: string } = {}) => {
    const b = el('button', opts.primary ? 'primary' : null, label); b.type = 'button';
    b.disabled = Boolean(opts.disabled);
    if (opts.title) b.title = opts.title;
    b.onclick = run;
    acts.append(b);
    return b;
  };
  const crossProject = 'Select within one project: a job and an edit each belong to one';
  if (GENERATION) {
    const todo = items.filter(actionable);
    if (todo.length) add('Generate ' + todo.length + ' · ' + priceOf(todo), () => generateDialog(todo, { project }), { primary: true, disabled: !oneProject, title: oneProject ? 'One job: parents first, then everything drawn from them' : crossProject });
    const redo = items.filter(regenerable);
    if (redo.length) add('Regenerate ' + redo.length + ' · ' + priceOf(redo), () => generateDialog(redo, { project, force: true }), { disabled: !oneProject, title: oneProject ? 'Replace these with new generations; each old one stays in its history' : crossProject });
  }
  const shown = items.filter((i) => i.outputs.some((o) => o.url));
  if (shown.length >= 2) {
    add('Compare' + (shown.length > 4 ? ' first 4' : ''), () => { ui.compare = shown.slice(0, 4).map((i) => i.id); openCompare(); });
  }
  if (EDITABLE && items.length) {
    const taggable = items.filter((i) => i.declaredAs && projectOf(i)?.manifestSha256);
    const tag = el('input');
    tag.type = 'text'; tag.placeholder = 'tag'; tag.setAttribute('aria-label', 'Tag to add or remove');
    tag.pattern = '[^,]+';
    const addTag = el('button', null, 'Add tag'); addTag.type = 'button';
    const dropTag = el('button', null, 'Remove tag'); dropTag.type = 'button';
    addTag.disabled = dropTag.disabled = !taggable.length || !oneProject;
    addTag.title = dropTag.title = !oneProject ? crossProject : taggable.length < items.length ? 'Undeclared records have no manifest entry to tag' : 'One manifest write for every selected asset';
    const run = (adding: boolean) => retag(taggable, tag.value.trim(), adding, tag);
    addTag.onclick = () => run(true);
    dropTag.onclick = () => run(false);
    tag.onkeydown = (e) => { if (e.key === 'Enter') { e.preventDefault(); run(true); } };
    const box = el('span', 'tagbox');
    box.append(tag, addTag, dropTag);
    acts.append(box);
  }
  add('Clear', () => { ui.selected.clear(); render(); }, { disabled: !items.length });
  add('Done', () => setSelecting(false));
  bar.append(acts);
  const msg = el('span', 'msg');
  msg.id = 'selmsg';
  bar.append(msg);
}

/** Adds or removes one tag on every selected asset in one batch edit; a loop split by direction is tagged once, on its shorthand. */
async function retag(items, tag: string, adding: boolean, input: HTMLInputElement) {
  const msg = $('selmsg');
  if (!tag || tag.includes(',')) { msg.className = 'msg bad'; msg.textContent = 'Type one tag (no commas).'; input.focus(); return; }
  const byId = new Map<string, string[]>();
  for (const i of items) {
    if (byId.has(i.declaredAs)) continue;
    const now: string[] = (i.asset && i.asset.tags) || [];
    const next = adding ? (now.includes(tag) ? now : [...now, tag]) : now.filter((t) => t !== tag);
    if (next.length !== now.length) byId.set(i.declaredAs, next);
  }
  if (!byId.size) { msg.className = 'msg'; msg.textContent = adding ? 'They all have it already.' : 'None of them has it.'; return; }
  const pr = projectOf(items[0]);
  const body: any = {
    action: 'batch',
    expectedSha256: pr!.manifestSha256,
    edits: [...byId].map(([assetId, tags]) => ({ action: 'patch-asset', assetId, patch: { tags } })),
  };
  if (items[0].project) body.project = items[0].project;
  msg.className = 'msg'; msg.textContent = 'saving…';
  try {
    S.snap = await postEdit(body);
    render();
    const after = $('selmsg');
    if (after) { after.className = 'msg ok'; after.textContent = (adding ? 'Tagged ' : 'Untagged ') + byId.size + (byId.size === 1 ? ' asset' : ' assets') + ' “' + tag + '”.'; }
  } catch (err) {
    msg.className = 'msg bad';
    msg.textContent = err.status === 409 ? 'The manifest changed on disk; refresh and try again.' : err.message;
  }
}
