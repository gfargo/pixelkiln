import { refresh } from "./refresh.ts"

import { $, S, el, isFrameSet, projectOf, ui } from "./core.ts"
import { render } from "./drawer.ts"
import { editableOutputs, memberNoun, postHandEdit } from "./hand-edit.ts"

// ---- the in-browser editor sheet -------------------------------------------
// The page is the protocol host: it hands the editor the PNG and palette,
// asks it for the image back, and does the authenticated write itself. The
// iframe never sees the session token, and the server validates, sizes, and
// declares the file the same way pixelkiln edit does.

// What the editor gets: the edit files when they are all there, else the
// generated outputs (one PNG, or every frame of a set).
export const editorSources = (item) => {
  if (item.edits.length && item.edits.every((e) => e.exists)) return { files: item.edits, fromEdit: true };
  if (editableOutputs(item)) return { files: item.outputs, fromEdit: false };
  return null;
};
export const editorSource = (item) => { const s = editorSources(item); return s ? s.files[0] : null; };
export const canEditInBrowser = (item) => EDITOR && EDITABLE && item.declared && item.asset && projectOf(item)?.manifestSha256 && editorSources(item);
export const toBase64 = (buf) => new Promise((resolve, reject) => {
  const r: any = new FileReader();
  r.onload = () => resolve(String(r.result).slice(String(r.result).indexOf(',') + 1));
  r.onerror = () => reject(r.error);
  r.readAsDataURL(new Blob([buf]));
});
export function sheetStatus(tone, text) {
  if (!S.SHEET) return;
  S.SHEET.status.textContent = '';
  S.SHEET.status.append(el('i', 'dot ' + tone), document.createTextNode(text));
}
export function sheetButtons() {
  if (!S.SHEET) return;
  const busy = !S.SHEET.opened || S.SHEET.pending !== null;
  S.SHEET.save.disabled = busy || !S.SHEET.dirty;
  S.SHEET.saveClose.disabled = busy;
}
export function openEditorSheet(item) {
  if (S.SHEET) return;
  const src = editorSource(item);
  const host = $('dialog-host');
  host.textContent = '';
  const scrim = el('div', 'sheet-scrim');
  scrim.onclick = () => closeEditorSheet();
  const panel = el('div', 'sheet editor-host');
  const bar = el('div', 'rbar');
  const close = el('button', null, 'Close'); close.type = 'button';
  close.onclick = () => closeEditorSheet();
  const title = el('b', null, (item.project ? item.project + ':' : '') + item.styleId + '/' + item.assetId + ' · ' + item.width + '×' + item.height + (item.outputs.length > 1 ? ' · ' + item.outputs.length + ' ' + memberNoun(item, item.outputs.length) : ''));
  const status = el('span', 'st');
  const acts = el('div', 'acts');
  const msg = el('span', 'msg');
  const compare = el('label', 'chip'); compare.hidden = true;
  compare.title = 'The generated art on a locked layer at 50%, for comparison; never part of the saved file';
  const compareBox = el('input'); compareBox.type = 'checkbox'; compareBox.checked = true;
  compareBox.onchange = () => showReference(compareBox.checked);
  compare.append(compareBox, document.createTextNode(' show generated'));
  const save = el('button', 'primary', 'Save to project'); save.type = 'button';
  save.onclick = () => requestEditorSave(false);
  const saveClose = el('button', null, 'Save & close'); saveClose.type = 'button';
  saveClose.onclick = () => requestEditorSave(true);
  acts.append(msg, compare, save, saveClose);
  bar.append(close, title, status, acts);
  const stage = el('div', 'stage');
  const frame = el('iframe');
  frame.title = 'Pixelorama';
  frame.src = S.ED.url;
  const loading = el('div', 'loading');
  const loadText = el('div');
  loadText.append(el('b', null, 'Loading the editor'), document.createTextNode('The first open compiles a 40 MB build; later opens come from the browser cache.'));
  loading.append(loadText);
  stage.append(frame, loading);
  panel.append(bar, stage);
  host.append(scrim, panel);
  S.SHEET = { item, frame, loading, status, msg, save, saveClose, compare, dirty: false, opened: false, ready: null, pending: null, requests: 0, source: src, sentProject: false, sentReference: false, reference: false, roles: null };
  sheetStatus('cool', 'loading');
  sheetButtons();
  close.focus({ preventScroll: true });
}
// The edit files are what the editor gets; when a browser save kept the
// layered project beside them, that goes along too and the editor restores
// the layers, falling back to the flattened PNGs if the file cannot be read.
// A frame set is sent as frames, one per member, and comes back the same way.
export async function sendOpen() {
  const { item } = S.SHEET;
  const sources = editorSources(item)!;
  const style = S.snap.styles.find((s) => s.id === item.styleId && s.project === item.project);
  const projectUrl = sources.fromEdit && item.editMeta && item.editMeta.projectUrl && S.SHEET.ready.version >= 2 ? item.editMeta.projectUrl : null;
  const set = sources.files.length > 1;
  if (set && S.SHEET.ready.version < 3) {
    S.SHEET.msg.textContent = 'This editor build cannot open sets; reinstall it with pixelkiln tools install editor.';
    sheetStatus('bad', 'unsupported');
    return;
  }
  // When an edit is being opened, the generated art rides along as a
  // reference layer: what the editor shows through at 50% for comparison.
  const referenceFiles = sources.fromEdit && S.SHEET.ready.version >= 4 && item.outputs.every((o) => o.exists && o.url) ? item.outputs : null;
  const pngs: any = [];
  const reference: any = [];
  let pxo: any = null;
  try {
    for (const file of sources.files) {
      const res = await fetch(file.url, { cache: 'no-store' });
      if (!res.ok) throw new Error(await res.text());
      pngs.push(await res.arrayBuffer());
    }
    if (projectUrl) {
      const p = await fetch(projectUrl, { cache: 'no-store' });
      if (p.ok) pxo = await p.arrayBuffer();
    }
    for (const file of referenceFiles || []) {
      const res = await fetch(file.url, { cache: 'no-store' });
      if (res.ok) reference.push({ role: file.role || null, png: await res.arrayBuffer() });
    }
  } catch (err) {
    if (S.SHEET) { S.SHEET.msg.textContent = 'Could not load the image: ' + err.message; sheetStatus('bad', 'failed'); }
    return;
  }
  if (!S.SHEET) return;
  const request = 'open-' + (++S.SHEET.requests);
  S.SHEET.sentProject = !!pxo;
  S.SHEET.roles = set ? item.outputs.map((o) => o.role || null) : null;
  const message: any = {
    type: 'pixelkiln:open', request,
    asset: { key: item.styleId + '/' + item.assetId, id: item.id, name: item.assetId, width: item.width, height: item.height },
    png: pngs[0], palette: style ? style.palette : [],
  };
  const transfer: any = [pngs[0]];
  if (set) {
    message.frames = pngs.map((png, i) => ({ role: S.SHEET.roles[i], png }));
    // A tile set is not an animation; a slow rate keeps its timeline still-ish.
    message.fps = isFrameSet(item) ? (item.fps || 12) : 1;
    for (const png of pngs.slice(1)) transfer.push(png);
    // The first frame is both png (older editors) and frames[0]; copy it so both transfer.
    message.png = pngs[0].slice(0);
    transfer.push(message.png);
  }
  if (pxo) { message.pxo = pxo; transfer.push(pxo); }
  if (reference.length === (referenceFiles || []).length && reference.length) {
    message.reference = reference;
    for (const r of reference) transfer.push(r.png);
  }
  S.SHEET.sentReference = !!message.reference;
  S.SHEET.frame.contentWindow.postMessage(message, location.origin, transfer);
  sheetStatus('cool', 'opening');
}
export function showReference(visible) {
  if (!S.SHEET || !S.SHEET.opened || !S.SHEET.reference) return;
  S.SHEET.frame.contentWindow.postMessage({ type: 'pixelkiln:reference', visible }, location.origin);
}
export function requestEditorSave(close) {
  if (!S.SHEET || !S.SHEET.opened || S.SHEET.pending) return;
  const request = 'save-' + (++S.SHEET.requests);
  S.SHEET.pending = { request, close };
  S.SHEET.msg.textContent = '';
  sheetStatus('cool', 'saving');
  sheetButtons();
  S.SHEET.frame.contentWindow.postMessage({ type: 'pixelkiln:request-save', request }, location.origin);
}
export async function onEditorMessage(m) {
  switch (m.type) {
    case 'pixelkiln:ready':
      S.SHEET.ready = m;
      if (m.version !== S.ED.protocol) {
        S.SHEET.msg.textContent = 'The editor speaks protocol ' + m.version + '; this gallery expects ' + S.ED.protocol + '. Reinstall it with pixelkiln tools install editor.';
        sheetStatus('bad', 'mismatch');
        return;
      }
      sendOpen();
      break;
    case 'pixelkiln:opened':
      S.SHEET.opened = true;
      S.SHEET.loading.remove();
      S.SHEET.reference = !!m.reference;
      S.SHEET.compare.hidden = !S.SHEET.reference;
      if (m.source === 'pxo') sheetStatus('ok', 'editing the edit file' + (m.frames > 1 ? 's' : '') + ' with ' + (m.layers === 1 ? 'the layer' : m.layers + ' layers') + (m.frames > 1 ? ' and ' + m.frames + ' ' + memberNoun(S.SHEET.item, m.frames) : '') + ' restored');
      else if (S.SHEET.sentProject) sheetStatus('warn', 'editing the flattened edit file' + (m.frames > 1 ? 's' : '') + '; the layer file could not be opened');
      else if (m.source === 'frames') sheetStatus('ok', (S.SHEET.item.edits.length ? 'editing the edit files' : 'editing a copy of the generated ' + memberNoun(S.SHEET.item, m.frames)) + ' as ' + m.frames + ' frames' + (isFrameSet(S.SHEET.item) ? '' : ', one per ' + memberNoun(S.SHEET.item, 1)));
      else sheetStatus('ok', S.SHEET.item.edit && S.SHEET.item.edit.exists ? 'editing the edit file' : 'editing a copy of the generated art');
      if (S.SHEET.reference) S.SHEET.status.append(document.createTextNode(' · generated art shown through at 50%'));
      sheetButtons();
      break;
    case 'pixelkiln:dirty':
      S.SHEET.dirty = !!m.dirty;
      if (S.SHEET.opened && !S.SHEET.pending) sheetStatus(S.SHEET.dirty ? 'warn' : 'ok', S.SHEET.dirty ? 'unsaved changes' : 'saved');
      sheetButtons();
      break;
    case 'pixelkiln:save': {
      const pending = S.SHEET.pending;
      if (!pending || pending.request !== m.request) return;
      try {
        const body: any = { editor: S.SHEET.ready.editor, protocol: S.SHEET.ready.version };
        if (S.SHEET.roles) {
          if (!Array.isArray(m.frames)) throw new Error('the editor returned no frames');
          body.frames = [];
          for (const f of m.frames) body.frames.push({ role: f.role === undefined ? null : f.role, png: await toBase64(f.png) });
        } else {
          body.png = await toBase64(m.png);
        }
        if (m.pxo && m.pxo.byteLength) body.pxo = await toBase64(m.pxo);
        await postHandEdit(S.SHEET.item, 'save-edit', body);
        const saved = S.snap.items.find((i) => i.id === S.SHEET.item.id);
        if (saved) S.SHEET.item = saved;
        S.SHEET.dirty = false;
        S.SHEET.pending = null;
        ui.notice = { id: S.SHEET.item.id, text: 'Saved ' + (saved && saved.edits.length > 1 ? saved.edits.length + ' ' + memberNoun(saved, saved.edits.length) + ' to ' + saved.source : saved && saved.edit ? saved.edit.path : 'the edit') + '. mount and pack place ' + (saved && saved.edits.length > 1 ? 'them' : 'it') + ' in place of the generated art.' };
        render();
        if (pending.close) { closeEditorSheet(true); return; }
        sheetStatus('ok', 'saved');
      } catch (err) {
        S.SHEET.pending = null;
        S.SHEET.msg.textContent = err.message + (err.status === 409 ? ' Press Refresh, then save again.' : '');
        sheetStatus('bad', 'not saved');
      }
      sheetButtons();
      break;
    }
    case 'pixelkiln:error':
      S.SHEET.msg.textContent = m.message || 'The editor reported an error.';
      if (S.SHEET.pending) { S.SHEET.pending = null; sheetStatus('bad', 'not saved'); sheetButtons(); }
      break;
  }
}
export function closeEditorSheet(force?) {
  if (!S.SHEET) return;
  if (S.SHEET.dirty && !force && !confirm('Discard unsaved changes in the editor?')) return;
  S.SHEET = null;
  $('dialog-host').textContent = '';
  refresh();
}
window.addEventListener('beforeunload', (e) => {
  if (S.SHEET && S.SHEET.dirty) { e.preventDefault(); e.returnValue = ''; }
});
