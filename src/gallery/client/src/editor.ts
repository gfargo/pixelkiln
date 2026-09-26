import { refresh } from "./refresh.ts"

import { $, S, el, fmtCost, ui } from "./core.ts"
import { renderDrawer } from "./drawer.ts"
import { paletteRuleOf, pollJobs, postGenerate, remainingBudget, renderJobs } from "./jobs.ts"
import { onEditorMessage } from "./sheet.ts"

// ---- the in-browser editor (only when the server serves one) -------------
// The build is a 46 MB web export fetched once into a user-level cache and
// verified against hashes this PixelKiln release carries; the page only
// reports and asks, the server downloads. Nothing is fetched without a click.

let edTimer: ReturnType<typeof setTimeout> | null = null;
export const fmtMb = (bytes) => (bytes / 1e6).toFixed(1) + ' MB';
export async function pollEditor() {
  if (!EDITOR) return;
  try {
    const res = await fetch('/api/editor', { cache: 'no-store' });
    if (!res.ok) throw new Error(await res.text());
    S.ED = await res.json();
  } catch (err) {
    S.ED = { error: 'status unavailable: ' + err.message, installed: false, installing: null, missing: [], totalBytes: 0 };
  }
  renderTools();
  clearTimeout(edTimer ?? undefined);
  if (S.ED.installing) edTimer = setTimeout(pollEditor, 1000);
  else if (ui.open) renderDrawer();
}
export async function installEditor() {
  try {
    const res = await fetch('/api/editor/install', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Pixelkiln-Session': SESSION ?? '' },
      body: '{}',
    });
    if (!res.ok) throw new Error(await res.text());
    S.ED = await res.json();
  } catch (err) {
    S.ED = Object.assign({}, S.ED, { error: err.message });
  }
  renderTools();
  clearTimeout(edTimer ?? undefined);
  edTimer = setTimeout(pollEditor, 500);
}
export function renderTools() {
  const host = $('tools');
  host.textContent = '';
  if (!EDITOR || !S.ED) return;
  const row = el('div', 'tool');
  const ph = el('span', 'ph');
  const last = el('span', 'last');
  const acts = el('div', 'acts');
  const name = 'Browser editor' + (S.ED.pixelorama ? ' (Pixelorama ' + S.ED.pixelorama + ')' : '');
  if (S.ED.installing) {
    const p = S.ED.installing;
    ph.append(el('i', 'dot cool'), document.createTextNode('installing'));
    last.textContent = name + ': fetching ' + (p.file || 'the build') + ', ' + fmtMb(p.fetchedBytes) + ' of ' + fmtMb(p.totalBytes);
    row.append(ph, last, acts);
    const bar = el('progress');
    if (p.totalBytes) { bar.max = p.totalBytes; bar.value = p.fetchedBytes; }
    row.append(bar);
  } else if (S.ED.installed) {
    ph.append(el('i', 'dot ok'), document.createTextNode('ready'));
    last.textContent = name + ' is installed and verified; a record’s Hand edit section opens sprites in it.';
    last.title = S.ED.dir || '';
    const b = el('button', null, 'Open editor');
    b.type = 'button'; b.onclick = () => window.open(S.ED.url, '_blank', 'noopener');
    acts.append(b);
    row.append(ph, last, acts);
  } else if (S.ED.error) {
    ph.append(el('i', 'dot bad'), document.createTextNode('failed'));
    last.textContent = name + ': ' + S.ED.error;
    const b = el('button', 'primary', 'Retry install');
    b.type = 'button'; b.onclick = installEditor;
    acts.append(b);
    row.append(ph, last, acts);
  } else if (!S.ED.release) {
    ph.append(el('i', 'dot dim'), document.createTextNode('unavailable'));
    last.textContent = name + ': this PixelKiln version pins no published build.';
    row.append(ph, last, acts);
  } else {
    ph.append(el('i', 'dot dim'), document.createTextNode('not installed'));
    last.textContent = name + ': ' + fmtMb(S.ED.totalBytes - (S.ED.installedBytes || 0)) + ' fetched once from the PixelKiln release ' +
      S.ED.release + ', verified against the hashes this version carries, and kept outside the project.';
    const b = el('button', 'primary', 'Install editor');
    b.type = 'button'; b.onclick = installEditor;
    acts.append(b);
    row.append(ph, last, acts);
  }
  host.append(row);
}

export function budgetLine() {
  const providers = new Set([...Object.keys(S.GEN.budget.byProvider), ...Object.keys(S.GEN.spent)]);
  const parts: any = [];
  for (const provider of [...providers].sort()) {
    const left = remainingBudget(provider);
    const unit = S.GEN.units[provider] || 'generations';
    if (left !== null) parts.push(provider + ': ' + fmtCost(unit, Math.round(left * 100) / 100) + ' left');
  }
  // An unkeyed ceiling belongs to whichever single provider first spends it.
  if (S.GEN.budget.amount !== undefined && !Object.keys(S.GEN.spent).length) parts.push(S.GEN.budget.amount + ' available');
  return parts.length ? 'session budget ' + parts.join(', ') : '';
}

// The confirm step: what will be sent, what it is estimated to cost, and what
// this session may still spend. Mirrors gen's "Spend … on N asset(s)?" prompt.
/** What a generation dialog is for; each flag mirrors a `gen` option. */
export interface GenerateOptions {
  project?: string | null
  force?: boolean
  resume?: boolean
  refresh?: boolean
  restore?: boolean
  /** A history index to bring back. */
  revert?: string | null
  generation?: any
}

export function generateDialog(items, { project = null, force = false, resume = false, refresh = false, restore = false, revert = null, generation = null }: GenerateOptions = {}) {
  const host = $('dialog-host');
  host.textContent = '';
  const wrap = el('div', 'dialog');
  const form = el('form');
  const noun = items.length + (items.length === 1 ? ' asset' : ' assets');
  const free = resume || refresh || restore || revert !== null;
  const replacing = items.filter((i) => i.state === 'orphaned' && i.outputs.every((o) => o.exists) || i.state === 'untracked');
  form.append(el('h3', null, refresh ? 'Pull upstream changes for ' + noun
    : revert !== null ? 'Bring back generation #' + revert + ' of ' + items[0].key
    : restore ? 'Restore ' + noun
    : resume ? 'Resume ' + noun
    : (force ? 'Regenerate ' : 'Generate ') + noun));
  const table = el('table');
  const thead = el('tr'); thead.append(el('th', null, 'asset'), el('th', null, 'state'), el('th', 'n', 'candidates'), el('th', 'n', 'estimate'));
  table.append(thead);
  const byProvider = new Map();
  for (const item of items) {
    const tr = el('tr');
    tr.append(el('td', 'mono', item.key), el('td', null, item.state), el('td', 'n', item.candidates ?? '—'),
      el('td', 'n', free ? 'no cost' : fmtCost(item.costUnit, item.estimatedCost ?? 0)));
    table.append(tr);
    if (!free) {
      const g = byProvider.get(item.provider) || { cost: 0, unit: item.costUnit };
      g.cost += item.estimatedCost ?? 0; byProvider.set(item.provider, g);
    }
  }
  form.append(table);
  const sum = el('div', 'sum');
  if (refresh) {
    sum.append(el('div', null, 'Re-downloads each object from the provider and replaces the local file only when the object changed upstream, for example after editing it in the provider’s own editor. Unchanged objects are left alone; a file you changed locally is refused. Nothing is submitted.'));
  } else if (revert !== null) {
    sum.append(el('div', null, 'The current generation moves into this asset’s history and generation #' + revert + ' becomes current again: its object, hashes, and cost are recorded as this generation, and its bytes are written back ' +
      (generation && generation.cached ? 'from the local cache.' : 'by re-downloading them from the provider.') + ' Nothing is generated; nothing upstream changes. Undo it from the same list.'));
    if (generation && generation.promptDiffers) sum.append(el('div', 'warn', 'That generation was made with a different prompt than the current one; the record will show it as stale until the manifest matches or it is regenerated.'));
  } else if (restore) {
    sum.append(el('div', null, 'Puts the recorded bytes back on disk from the local cache or the provider object. Nothing is generated or submitted.'));
    if (force && replacing.length) sum.append(el('div', 'warn', 'The file on disk was changed after PixelKiln wrote it. Restoring discards that change. To keep it instead, cancel and use Edit by hand or Edit in browser first: the edit is copied beside the generated file, and the record stays intact.'));
  } else if (resume) {
    const drifted = items.filter((i) => i.state === 'recoverable' && i.status === 'downloaded');
    if (drifted.length === items.length) {
      sum.append(el('div', null, drifted.every((i) => paletteRuleOf(i))
        ? 'Snaps each file to the style’s palette from the provider’s bytes in the local cache (or the file itself). The record keeps both hashes, so this can be undone the same way. Nothing is submitted.'
        : 'Puts the provider’s original bytes back from the local cache, or re-downloads them, and clears the palette record. Nothing is submitted.'));
    } else {
      sum.append(el('div', null, 'Polls, reviews, and downloads existing provider work. Nothing is submitted.'));
    }
  } else {
    for (const [provider, g] of byProvider) {
      const left = remainingBudget(provider);
      const line = el('div');
      line.append(el('b', null, provider + ': ' + fmtCost(g.unit, Math.round(g.cost * 100) / 100)));
      line.append(document.createTextNode(left === null ? ', no session budget for this provider'
        : ' · ' + fmtCost(g.unit, Math.round(left * 100) / 100) + ' of the session budget left'));
      if (left !== null && g.cost > left) line.className = 'warn';
      sum.append(line);
    }
    if (force && replacing.length) sum.append(el('div', 'warn', (replacing.length === 1 ? 'This file' : replacing.length + ' of these files') + ' changed on disk after PixelKiln wrote it (or was never recorded). Generating replaces it and that change is lost. To keep it, cancel and use Edit by hand or Edit in browser first.'));
    else if (force) sum.append(el('div', 'warn', 'Regenerating replaces the current art. The previous file is replaced when the new result is fetched; the provider objects it came from are not deleted.'));
    sum.append(el('div', null, 'Candidate sets land in review; you choose from them here before anything is downloaded.'));
  }
  form.append(sum);
  const actions = el('div', 'actions');
  const go = el('button', 'primary', refresh ? 'Pull changes' : revert !== null ? 'Bring it back' : restore ? (force && replacing.length ? 'Restore and discard my change' : 'Restore') : resume ? 'Resume' : force && replacing.length ? 'Generate and replace' : 'Generate');
  go.type = 'submit';
  const cancel = el('button', null, 'Cancel'); cancel.type = 'button'; cancel.onclick = () => { host.textContent = ''; };
  const msg = el('span', 'msg');
  actions.append(go, cancel, msg);
  form.append(actions);
  form.onsubmit = async (e) => {
    e.preventDefault();
    go.disabled = true; msg.textContent = '';
    try {
      const body: any = { keys: items.map((i) => i.key) };
      if (project) body.project = project;
      if (force) body.force = true;
      if (resume) body.resume = true;
      if (refresh) body.refresh = true;
      if (restore) body.restore = true;
      if (revert !== null) body.revert = revert;
      const job = await postGenerate(body);
      host.textContent = '';
      S.GEN.jobs.unshift(job);
      renderJobs();
      pollJobs();
    } catch (err) {
      go.disabled = false;
      msg.textContent = err.message;
    }
  };
  wrap.append(form);
  host.append(wrap);
  setTimeout(() => go.focus(), 0);
}

export function openReview(jobId) {
  const host = $('dialog-host');
  host.textContent = '';
  const scrim = el('div', 'sheet-scrim');
  scrim.onclick = () => { host.textContent = ''; pollJobs(); refresh(); };
  const panel = el('div', 'sheet review-host');
  const bar = el('div', 'rbar');
  const close = el('button', null, 'Back to gallery'); close.type = 'button';
  close.onclick = () => { host.textContent = ''; pollJobs(); refresh(); };
  bar.append(close, el('span', null, 'Choose from the candidates below. Apply selections writes the lockfile and downloads what you chose; unchosen rows stay in review.'));
  const frame = el('iframe');
  frame.src = '/review/' + encodeURIComponent(jobId);
  frame.title = 'Candidate review';
  panel.append(bar, frame);
  host.append(scrim, panel);
}
window.addEventListener('message', (e) => {
  if (e.origin !== location.origin || !e.data || typeof e.data.type !== 'string') return;
  if (e.data.type === 'pixelkiln:review-applied') {
    setTimeout(() => { $('dialog-host').textContent = ''; pollJobs(); refresh(); }, 600);
    return;
  }
  if (S.SHEET && e.source === S.SHEET.frame.contentWindow) onEditorMessage(e.data);
});
