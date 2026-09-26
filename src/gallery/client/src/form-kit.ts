import { postEdit, S, ui } from "./core.ts"
import { openItem, render } from "./drawer.ts"

/** What happens after a manifest-only save, which depends on whether this page can generate. */
export const nextStep = () => GENERATION
  ? 'Generate it from its record when you are ready.'
  : 'Nothing is generated until you run pixelkiln gen.'

/**
 * Posts a new asset, closes the form, and opens the new record with a note
 * on what comes next. `where` is the style the asset was added in, which
 * names the record the save creates.
 */
export async function addAssetAndOpen(body: { assetId: string }, where: { project: string | null; styleId: string }, what = 'Added to the manifest.') {
  S.snap = await postEdit(body);
  const newId = (where.project ? where.project + ':' : '') + where.styleId + '/' + body.assetId;
  ui.editing = null;
  ui.notice = { id: newId, text: what + ' ' + nextStep() };
  render();
  if (S.snap.items.some((i) => i.id === newId)) openItem(newId);
}

/** A refused save: re-enable the button and say why, pointing at Refresh when the manifest moved underneath. */
export function showSaveError(msg: HTMLElement, save: HTMLButtonElement | null, err: Error & { status?: number }) {
  if (save) save.disabled = false;
  msg.className = 'msg bad';
  msg.textContent = err.message + (err.status === 409 ? ' Press Refresh.' : '');
}
