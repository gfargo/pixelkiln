import { $, S, editHooks, el, manifestShaOf, postEdit } from "./core.ts"
import { render } from "./drawer.ts"

/**
 * "Saved · Undo": every edit that rewrites the manifest says what it did,
 * and one click (or ⌘Z / ctrl+Z) puts the previous manifest back. The server
 * refuses when the file has changed since the gallery wrote it, so undo never
 * discards a hand edit.
 */

let lastProject: string | null = null;
let hideTimer: ReturnType<typeof setTimeout> | null = null;

function describe(body): string {
  switch (body.action) {
    case 'batch': return body.edits.length + ' changes to the manifest';
    case 'add-style': return 'added style ' + body.styleId;
    case 'patch-style': return 'changed style ' + body.styleId;
    case 'add-asset': return 'added ' + body.assetId;
    case 'patch-asset': return 'changed ' + body.assetId;
    case 'set-source': case 'clear-source': return 'changed the source of ' + body.assetId;
    case 'create-skeleton-animation': return 'added ' + body.assetId;
    case 'start-edit': return 'started a hand edit of ' + body.assetId;
    case 'save-edit': return 'saved a hand edit of ' + body.assetId;
    case 'detach-edit': return 'detached the hand edit of ' + body.assetId;
    default: return 'the manifest changed';
  }
}

function toast(text: string, canUndo: boolean, tone = '') {
  const host = $('toast');
  host.textContent = '';
  host.className = 'toast' + (tone ? ' ' + tone : '');
  host.append(el('span', null, text));
  if (canUndo) {
    const b = el('button', null, 'Undo'); b.type = 'button';
    b.title = 'Put the manifest back as it was (⌘Z / ctrl+Z)';
    b.onclick = () => void undoLast();
    host.append(b);
  }
  const x = el('button', 'x', '×'); x.type = 'button'; x.setAttribute('aria-label', 'Dismiss');
  x.onclick = () => { host.hidden = true; };
  host.append(x);
  host.hidden = false;
  if (hideTimer) clearTimeout(hideTimer);
  hideTimer = setTimeout(() => { host.hidden = true; }, 12000);
}

export function installUndo() {
  editHooks.saved = (body, changed) => {
    if (!body || body.action === 'undo-edit' || !changed) return;
    lastProject = body.project ?? null;
    toast('Saved: ' + describe(body) + '.', true);
  };
}

export async function undoLast() {
  if (!EDITABLE) return;
  const expected = manifestShaOf(S.snap, lastProject);
  if (!expected) return;
  const body: any = { action: 'undo-edit', expectedSha256: expected };
  if (lastProject) body.project = lastProject;
  try {
    S.snap = await postEdit(body);
    render();
    toast('Undone. The manifest is back as it was before that edit.', true);
  } catch (err) {
    toast(/nothing to undo/.test(err.message) ? 'Nothing left to undo.' : 'Could not undo: ' + err.message, false, 'bad');
  }
}
