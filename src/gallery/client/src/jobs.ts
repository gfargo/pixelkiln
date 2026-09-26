import { refresh } from "./refresh.ts"

import { $, S, el, formRegion, ui } from "./core.ts"
import { renderDrawer } from "./drawer.ts"
import { openReview } from "./editor.ts"
import { card, renderHeader } from "./grid.ts"

// ---- generation (only when the server holds a session budget) -------------

export const ACTIVE_PHASES = new Set(['queued', 'submitting', 'polling', 'fetching', 'review']);
export const PHASE_TONE = { queued: 'cool', submitting: 'cool', polling: 'cool', fetching: 'cool', review: 'warn', done: 'ok', failed: 'bad' };
// The job still working on this record, if any: what the drawer and its card
// show while a regeneration, restore, or pull is in flight.
/** "state of mira", "loop of mira.chair_spin, east": where a character family member sits. */
export const familyLabel = (item) => {
  const c = item.character;
  if (item.mirrorOfKey) return 'mirror of ' + item.mirrorOfKey.split('/').slice(1).join('/') + (c && c.direction ? ', ' + c.direction : '');
  if (!c || c.kind === 'base') return null;
  const parent = c.parentKey ? c.parentKey.split('/').slice(1).join('/') : null;
  if (c.kind === 'state') return parent ? 'state of ' + parent : 'state';
  return (parent ? 'loop of ' + parent : 'loop') + (c.direction ? ', ' + c.direction : '');
};
/** The style's palette rule as the manifest has it now, or null. */
export const paletteRuleOf = (item) => {
  const style = S.snap.styles.find((s) => s.id === item.styleId && s.project === item.project);
  return style && style.enforcePalette && style.palette.length >= 2 ? style.palette : null;
};
/**
 * Whether this item has usable pixels to revise: committed `source` art
 * always qualifies, otherwise it needs a current, downloaded generation, or
 * (for a quality-gated style) a current, human-approved refined output. This
 * mirrors docs/REVISIONS.md's dependency gate closely enough to gate the
 * button; the server's own plan is still the final word once the revision
 * asset exists, and reports `blocked` with the real reason if this guess
 * were ever wrong.
 */
export const isRevisable = (item) => {
  if (item.source) return true;
  if (item.quality) return item.quality.review?.status === 'approved' && !!item.quality.check?.current;
  return item.status === 'downloaded' && item.state === 'ok';
};
export const activeJobFor = (item) => S.GEN.jobs.find((job) => ACTIVE_PHASES.has(job.phase) && job.project === item.project && job.keys.includes(item.key)) || null;
export const JOB_VERB = { generate: 'regenerating', resume: 'resuming', refresh: 'pulling upstream changes for', restore: 'restoring', revert: 'bringing back a previous generation of' };
export const PHASE_TEXT = { queued: 'queued', submitting: 'submitting to the provider', polling: 'waiting for the provider to finish', fetching: 'downloading the result', review: 'candidates are ready to review' };
export const remainingBudget = (provider) => {
  const keyed = S.GEN.budget.byProvider[provider];
  const ceiling = keyed !== undefined ? keyed : S.GEN.budget.amount;
  return ceiling === undefined ? null : Math.max(0, ceiling - (S.GEN.spent[provider] || 0));
};
export async function postGenerate(body) {
  const res = await fetch('/api/generate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Pixelkiln-Session': SESSION ?? '' },
    body: JSON.stringify(body),
  });
  if (!res.ok) { const err: Error & { status?: number } = new Error(await res.text()); err.status = res.status; throw err; }
  return res.json();
}
let jobsTimer: ReturnType<typeof setTimeout> | null = null;
export async function pollJobs() {
  if (!GENERATION) return;
  try {
    const res = await fetch('/api/jobs', { cache: 'no-store' });
    if (!res.ok) throw new Error(await res.text());
    S.GEN = await res.json();
  } catch (err) {
    $('note').textContent = ' Job status unavailable: ' + err.message;
    return;
  }
  renderJobs();
  renderHeader();
  let changed = false;
  for (const job of S.GEN.jobs) {
    if (!ACTIVE_PHASES.has(job.phase) && !ui.settled.has(job.id)) {
      ui.settled.add(job.id); changed = true;
      notifyJob(job);
      // The open record hears how its job ended, where the strip was.
      const open = ui.open && S.snap.items.find((i) => i.id === ui.open);
      if (open && job.project === open.project && job.keys.includes(open.key)) {
        ui.notice = { id: open.id, text: job.phase === 'failed'
          ? (JOB_VERB[job.mode] || job.mode).replace(/ing$/, 'ing') + ' this asset failed: ' + (job.error || 'see the log above')
          : job.mode === 'generate' ? 'Regenerated. The new result is on disk and recorded as this generation.'
          : job.mode === 'restore' ? 'Restored. The recorded bytes are back on disk.'
          : job.mode === 'revert' ? 'Brought back generation #' + job.revert + '. The one it replaced is now #1 in the list below.'
          : job.mode === 'refresh' ? (job.counts.downloaded ? 'Pulled the upstream change; the lockfile records the new bytes.' : 'Nothing changed upstream; the file was left alone.')
          : job.mode === 'resume' && job.counts.downloaded ? 'Done. The file on disk and the record now match the manifest.'
          : 'Done.' };
      }
    }
    if (job.phase === 'review' && !ui.settled.has(job.id + ':review')) { ui.settled.add(job.id + ':review'); changed = true; notifyJob(job); }
  }
  if (changed) refresh();
  else {
    // A job in flight: keep the open record's strip and the card badges honest without a full re-render.
    if (ui.open && !$('dialog-host').childNodes.length && formRegion() !== 'drawer') renderDrawer();
    for (const c of document.querySelectorAll('.card')) {
      const item = S.snap.items.find((i) => i.id === (c as HTMLElement).dataset.key);
      const job = item && activeJobFor(item);
      const badge = c.querySelector('.busy-badge');
      if (job && !badge) c.replaceWith(card(item));
      else if (!job && badge) badge.remove();
    }
  }
  const active = S.GEN.jobs.some((job) => ACTIVE_PHASES.has(job.phase) && job.phase !== 'review');
  clearTimeout(jobsTimer ?? undefined);
  if (active) jobsTimer = setTimeout(pollJobs, 2000);
}
const DONE_VERB = { generate: 'Generated', resume: 'Resumed', refresh: 'Pulled upstream changes for', restore: 'Restored', revert: 'Brought back a generation of' };

/** Asks once for permission to raise system notifications; true when they can be shown. */
export async function enableNotifications(): Promise<boolean> {
  if (typeof Notification === 'undefined') return false;
  if (Notification.permission === 'granted') return true;
  if (Notification.permission === 'denied') {
    $('note').textContent = ' Notifications are blocked for this page in the browser\'s site settings.';
    return false;
  }
  try { return (await Notification.requestPermission()) === 'granted'; }
  catch { return false; }
}

/**
 * A system notification for a job that finished or stopped for review, raised
 * only while this tab is in the background: in front, the page says it itself.
 */
function notifyJob(job) {
  if (!ui.notify || !document.hidden || typeof Notification === 'undefined' || Notification.permission !== 'granted') return;
  const n = job.keys.length;
  const what = n === 1 ? job.keys[0] : n + ' assets';
  const body = job.phase === 'review' ? job.review.length + ' waiting for you to pick a candidate'
    : job.phase === 'failed' ? 'failed: ' + (job.error || 'see the log')
    : (DONE_VERB[job.mode] || 'Finished') + ' ' + what;
  try {
    const note = new Notification('pixelkiln' + (job.project ? ' · ' + job.project : ''), { body, tag: 'pixelkiln-job-' + job.id });
    note.onclick = () => { window.focus(); note.close(); };
  } catch { /* some browsers only allow notifications from a service worker */ }
}

export function renderJobs() {
  const host = $('jobs');
  host.textContent = '';
  if (!GENERATION) return;
  for (const job of S.GEN.jobs) {
    if (ui.settled.has(job.id + ':dismissed')) continue;
    const row = el('div', 'job');
    const ph = el('span', 'ph');
    ph.append(el('i', 'dot ' + PHASE_TONE[job.phase]), document.createTextNode(job.phase));
    const what = (job.mode === 'refresh' ? 'pull upstream for ' : job.mode === 'restore' ? 'restore ' : job.mode === 'revert' ? 'bring back generation #' + job.revert + ' of ' : job.mode === 'resume' ? 'resume ' : 'generate ') + job.keys.length + (job.keys.length === 1 ? ' asset' : ' assets') +
      (job.project ? ' in ' + job.project : '');
    const last = el('span', 'last', what + (job.messages.length ? ': ' + job.messages[job.messages.length - 1].trim() : ''));
    last.title = job.keys.join('\n');
    const acts = el('div', 'acts');
    if (job.phase === 'review' && job.review.length) {
      const b = el('button', 'primary', 'Review ' + job.review.length);
      b.type = 'button'; b.onclick = () => openReview(job.id);
      acts.append(b);
    }
    const logBtn = el('button', null, ui.logs.has(job.id) ? 'Hide log' : 'Log');
    logBtn.type = 'button';
    logBtn.onclick = () => { ui.logs.has(job.id) ? ui.logs.delete(job.id) : ui.logs.add(job.id); renderJobs(); };
    acts.append(logBtn);
    if (!ACTIVE_PHASES.has(job.phase)) {
      const d = el('button', null, 'Dismiss');
      d.type = 'button'; d.onclick = () => { ui.settled.add(job.id + ':dismissed'); renderJobs(); };
      acts.append(d);
    }
    row.append(ph, last, acts);
    if (ui.logs.has(job.id)) row.append(el('pre', null, job.messages.join('\n')));
    host.append(row);
  }
}
