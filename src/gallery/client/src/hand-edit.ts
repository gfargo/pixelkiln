import { S, displayScale, el, fmtWhen, isFrameSet, postEdit, projectOf, ui } from "./core.ts"
import { render, row } from "./drawer.ts"
import { installEditor } from "./editor.ts"
import { editorSource, openEditorSheet } from "./sheet.ts"

// ---- hand edits -------------------------------------------------------------

export const EDIT_STATUS_TEXT = {
  same: 'The generated art’s pixels, not changed yet. Open it in your editor and save.',
  edited: 'Differs from the generated art. mount and pack place this file; the generated file stays as the record.',
  'regenerated-since': 'The generated art changed after this edit was saved; the edit is based on an older generation.',
  missing: 'The declared file is not on disk.',
};
export async function postHandEdit(item, action, extra) {
  const pr = projectOf(item);
  const body = { action, assetId: item.assetId, styleId: item.styleId, expectedSha256: pr!.manifestSha256, ...extra };
  if (item.project) body.project = item.project;
  S.snap = await postEdit(body);
}
// A single PNG or a set of them (frames, tiles) is hand-editable, one file
// per member; a set with a GIF in it is not.
export const editableOutputs = (item) => item.outputs.length && item.outputs.every((o) => o.exists && o.mediaType === 'image/png');
// What the members of a set are called: frames for an animation, tiles for a tile set.
export const memberNoun = (item, n) => isFrameSet(item) ? (n === 1 ? 'frame' : 'frames')
  : item.outputs.every((o) => o.role && /^tile/i.test(o.role)) ? (n === 1 ? 'tile' : 'tiles') : (n === 1 ? 'member' : 'members');
export function handEditSection(item) {
  const canStart = EDITABLE && item.declared && item.asset && projectOf(item)?.manifestSha256 && editableOutputs(item);
  if (!item.edit && !canStart) return null;
  const set = item.edits.length > 1;
  const s = el('section', 'meta');
  s.append(el('h3', null, set ? 'Hand edit (' + item.edits.length + ' ' + memberNoun(item, item.edits.length) + ')' : 'Hand edit'));
  if (item.edit) {
    const pair = el('div', 'pair');
    const shared = displayScale(item.width, item.height, 200, 160);
    const fig = (out, label) => {
      const f = el('figure');
      if (out && out.url) {
        const img = el('img'); img.src = out.url; img.alt = label;
        if (shared >= 1) { img.width = item.width * shared; img.height = item.height * shared; }
        f.append(img);
      } else f.append(el('span', 'state-dim', 'not on disk'));
      f.append(el('figcaption', null, label));
      return f;
    };
    // For a set, the member the preview is on; the strip there steps through them.
    const at = set ? Math.min(ui.member, item.edits.length - 1) : 0;
    const which = set ? ' · ' + (item.outputs[at].role || memberNoun(item, 1) + ' ' + (at + 1)) : '';
    pair.append(fig(item.outputs[at], 'generated' + which), fig(item.edits[at], 'edit' + which));
    s.append(pair);
    const dl = el('dl');
    const tone = item.editStatus === 'edited' ? 'ok' : item.editStatus === 'same' ? 'dim' : 'warn';
    const st = el('span', 'state-' + tone); st.append(el('i', 'dot ' + tone), document.createTextNode(' ' + item.editStatus));
    row(dl, 'status', st);
    row(dl, 'why', EDIT_STATUS_TEXT[item.editStatus] || '');
    if (set) {
      row(dl, 'files', item.source + ', one per ' + memberNoun(item, 1) + ': ' + item.edits.map((e) => e.path.split('/').pop()).join(', '), { mono: true, copy: item.edits.map((e) => e.absolutePath).join('\n') });
      const differing = item.editChanged.filter(Boolean).length;
      row(dl, 'changed', differing + ' of ' + item.edits.length + ' ' + memberNoun(item, item.edits.length) + ' differ from the generated art' +
        (differing ? ': ' + item.edits.filter((e, i) => item.editChanged[i]).map((e) => item.outputs[item.edits.indexOf(e)].role || e.path.split('/').pop()).join(', ') : ''));
    } else {
      row(dl, 'file', item.edit.path, { mono: true, copy: item.edit.absolutePath });
      if (item.edit.sha256) row(dl, 'sha256', item.edit.sha256.slice(0, 16) + '…', { mono: true, copy: item.edit.sha256 });
    }
    row(dl, 'saved', fmtWhen(item.edits.reduce((latest, e) => e.modifiedAt && (!latest || e.modifiedAt > latest) ? e.modifiedAt : latest, null)));
    if (item.editMeta) {
      row(dl, 'editor', item.editMeta.editor + ', ' + fmtWhen(item.editMeta.savedAt) + (item.editMeta.changedSince ? '; a file changed since' : ''));
      if (item.editMeta.basedOn && !set) row(dl, 'based on', item.editMeta.basedOn.slice(0, 16) + '…', { mono: true, copy: item.editMeta.basedOn });
      if (item.editMeta.project) row(dl, 'layers', item.editMeta.project, { mono: true });
    }
    s.append(dl);
  } else {
    s.append(el('div', 'state-dim', item.outputs.length > 1
      ? 'Touch the ' + memberNoun(item, 2) + ' up in your own editor or in the browser, where they open as ' + (isFrameSet(item) ? 'one animation' : 'the frames of one project') + '. The generated files stay untouched; the edit is one sibling file per ' + memberNoun(item, 1) + ' that the manifest points at, and mount, pack, and export place those instead.'
      : 'Touch it up in your own editor. The generated file stays untouched; the edit is a sibling file the manifest points at, and mount and pack place that instead.'));
  }
  if (EDITABLE && item.declared && projectOf(item)?.manifestSha256) {
    const acts = el('div', 'hand-actions');
    const msg = el('span', 'msg');
    const go = async (label, action, extra, done) => {
      const b = el('button', label === 'Detach edit' || (EDITOR && S.ED && S.ED.installed) ? null : 'primary', label); b.type = 'button';
      b.onclick = async () => {
        b.disabled = true; msg.className = 'msg'; msg.textContent = '…';
        try { await postHandEdit(item, action, extra); ui.notice = { id: item.id, text: done }; render(); }
        catch (err) { b.disabled = false; msg.className = 'msg bad'; msg.textContent = err.message + (err.status === 409 ? ' Press Refresh.' : ''); }
      };
      acts.append(b);
    };
    if (EDITOR && S.ED && (item.edit || canStart) && editorSource(item)) {
      if (S.ED.installed) {
        const b = el('button', 'primary', 'Edit in browser'); b.type = 'button';
        b.title = 'Open in Pixelorama here; Save writes the edit file and declares it';
        b.onclick = () => openEditorSheet(item);
        acts.append(b);
      } else if (S.ED.release && !S.ED.installing) {
        const b = el('button', null, 'Install editor to edit in browser'); b.type = 'button';
        b.onclick = () => { installEditor(); window.scrollTo({ top: 0 }); };
        acts.append(b);
      }
    }
    if (item.edit) {
      go('Open in desktop editor', 'start-edit', { open: true }, 'Opened ' + item.edit.path + ' in your editor. Save there, then Refresh.');
      go('Detach edit', 'detach-edit', {}, 'Detached. The file' + (set ? 's are' : ' is') + ' still at ' + item.source + '; the generated art is placed again.');
    } else if (canStart) {
      const many = item.outputs.length > 1;
      go('Edit by hand', 'start-edit', { open: true }, 'Created the edit file' + (many ? 's and opened the first ' + memberNoun(item, 1) : ' and opened it') + ' in your editor. Save there, then Refresh to see it here.');
      go('Create edit file' + (many ? 's' : '') + ' only', 'start-edit', { open: false }, 'Created the edit file' + (many ? 's' : '') + ' and declared ' + (many ? 'them' : 'it') + ' in the manifest.');
    }
    acts.append(msg);
    s.append(acts);
  }
  return s;
}
