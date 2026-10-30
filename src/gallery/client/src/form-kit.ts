import { postEdit, S, ui } from "./core.ts"
import { openItem, render } from "./drawer.ts"

/**
 * PixelLab poses a template with the skeleton model only onto a character
 * with a stored 3D skeleton, and a `standard` base has none: `plan` refuses
 * that pairing. `pro` and `pro-flash` are unverified, so they stay allowed.
 */
export const skeletonV3Allowed = (engine: string | null | undefined) => engine !== 'standard';

/** The mode a new template loop starts on for a base made with `engine`. */
export const defaultLoopMode = (engine: string | null | undefined) => skeletonV3Allowed(engine) ? 'skeleton-v3' : 'template';

/**
 * The choice that animates a sentence with the skeleton model. It saves as
 * `mode: 'skeleton-v3'` with no template, so it needs its own value in the
 * pickers, where 'skeleton-v3' means a template.
 */
export const SKELETON_WORDS = 'skeleton-v3-words';

/** PixelLab's frame range for a sentence loop, odd counts included. */
export const SKELETON_WORDS_FRAMES = { min: 3, max: 15, fallback: 8 };

/** Greys out the skeleton-v3 choices for an engine they cannot run on, and says why. */
export function syncSkeletonOption(select: HTMLSelectElement, engine: string | null | undefined) {
  const allowed = skeletonV3Allowed(engine);
  for (const option of select.options) {
    if (option.value !== 'skeleton-v3' && option.value !== SKELETON_WORDS) continue;
    option.disabled = !allowed;
    option.title = allowed ? '' : option.value === SKELETON_WORDS
      ? 'PixelLab writes the motion onto a stored 3D skeleton, which a standard base has none of; use v3 or a template.'
      : 'PixelLab poses a template only onto a v3 character. A standard base has no 3D skeleton; use template.';
  }
}

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
