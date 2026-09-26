import type { GallerySnapshot } from "../../snapshot.ts"

/**
 * Everything the page's modules share and replace wholesale: the snapshot
 * (swapped on every refresh or save), generation status, the editor's
 * install status, and the open editor sheet. Kept on one object because a
 * module cannot reassign another module's binding.
 */
export const S = {
  snap: INITIAL as GallerySnapshot,
  /** Generation status from /api/jobs: jobs, session budget, spend so far. */
  GEN: { jobs: [], budget: { byProvider: {} }, spent: {}, units: {} } as any,
  ED: null as any,
  SHEET: null as any,
}
export const STATE_TONE = {
  ok: 'ok', stale: 'warn', orphaned: 'warn', untracked: 'warn', blocked: 'warn',
  failed: 'bad', 'in-flight': 'cool', recoverable: 'cool', missing: 'dim', undeclared: 'dim',
};
export const STATE_ORDER = ['ok','stale','orphaned','untracked','in-flight','recoverable','blocked','failed','missing','undeclared'];
export interface UiState {
  q: string
  states: Set<string>
  providers: Set<string>
  generators: Set<string>
  projects: Set<string>
  sort: string
  group: string
  /** Id of the record whose drawer is open. */
  open: string | null
  member: number
  zoom: string
  playing: ReturnType<typeof setInterval> | null
  /** Cards rendered per pass; a project with thousands of assets opts into the rest. */
  limit: number
  /** Item id whose edit form is open, or 'new:<project>:<style>' for an add form. */
  editing: string | null
  /** One-shot confirmation shown in the drawer after a save. */
  notice: { id: string; text: string } | null
  /** Record ids picked for side-by-side comparison, in pick order (max 4). */
  compare: string[]
  /** Zoom for the comparison panel. */
  compareZoom: string
  /** Jobs expanded to show their log. */
  logs: Set<string>
  /** Job ids already seen finished, so a completion refreshes exactly once. */
  settled: Set<string>
}

export const ui: UiState = {
  q: '', states: new Set(), providers: new Set(), generators: new Set(), projects: new Set(),
  sort: 'key', group: 'style', open: null, member: 0, zoom: 'auto', playing: null,
  limit: 600,
  editing: null,
  notice: null,
  compare: [],
  compareZoom: 'auto',
  logs: new Set(),
  settled: new Set(),
};
/** An element the page's HTML is known to contain (see page.ts). */
export const $ = (id: string): any => document.getElementById(id);
export const el = <K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string | null, text?: unknown): HTMLElementTagNameMap[K] => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined && text !== null) n.textContent = String(text);
  return n;
};
export const fmtCost = (unit, amount) => {
  if (unit === 'free') return 'free';
  if (unit === 'usd') return '$' + Number(amount).toFixed(2);
  if (unit === 'generations') return amount + ' generation' + (amount === 1 ? '' : 's');
  return amount + ' ' + unit;
};
export const fmtSpend = (spend: Record<string, number>) => Object.entries(spend).filter(([, n]) => n).sort()
  .map(([unit, n]) => fmtCost(unit, Math.round(n * 100) / 100)).join(' + ') || 'no spend recorded';
export const fmtBytes = (n) => n == null ? '—' : n < 1024 ? n + ' B' : n < 1048576 ? (n / 1024).toFixed(1) + ' KB' : (n / 1048576).toFixed(2) + ' MB';
export const fmtWhen = (iso) => {
  if (!iso) return null;
  const d = new Date(iso);
  return isNaN(d.getTime()) ? iso : d.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
};
export const isFrameSet = (item) => item.generator === 'frames' ||
  (item.outputs.length > 1 && item.outputs.every((o) => o.role && /^frame/i.test(o.role)));
export const shortPath = (p) => {
  if (p.length <= 64) return p;
  const parts = p.split('/');
  return parts.length > 4 ? '…/' + parts.slice(-3).join('/') : p;
};
export const displayScale = (w, h, boxW, boxH) => {
  const s = Math.min(boxW / w, boxH / h);
  return s >= 1 ? Math.floor(s) : s;
};

export const projectOf = (item) => S.snap.workspace
  ? S.snap.workspace.projects.find((pr) => pr.id === item.project)
  : S.snap.project;

// The only write this page ever makes: one manifest edit, quoting the
// manifest hash it was rendered from so a concurrent hand edit is refused
// rather than overwritten. The server answers with the rebuilt gallery.
export async function postEdit(body) {
  const res = await fetch('/api/edit', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Pixelkiln-Session': SESSION ?? '' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const err: Error & { status?: number } = new Error(await res.text());
    err.status = res.status;
    throw err;
  }
  return res.json();
}
export const field = (label, input, hint?) => {
  const w = el('label', 'field');
  w.append(el('span', null, label), input);
  if (hint) w.append(el('small', null, hint));
  return w;
};
export const numberInput = (value, placeholder) => {
  const i = el('input'); i.type = 'number'; i.min = '16'; i.step = '1';
  i.value = value == null ? '' : String(value); i.placeholder = placeholder || '';
  return i;
};
export const numberOrNull = (input) => input.value.trim() === '' ? null : Number(input.value);
export const splitTags = (value) => value.split(',').map((t) => t.trim()).filter(Boolean);
