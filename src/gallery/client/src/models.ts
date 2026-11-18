import { glbImageBytes, parseGlb, type GlbDocument } from "../../../glb.ts"
import { pieceLabel, regionColour, uvGuide, type UvGuide } from "../../../glb-guide.ts"
import type { GalleryModel } from "../../models.ts"
import { $, S, el, fmtBytes, fmtWhen, postEdit, savePrefs, ui } from "./core.ts"
import { markActive, render, row, syncHash } from "./drawer.ts"
import { installEditor } from "./editor.ts"
import { openEditorSheet, toBase64 } from "./sheet.ts"
import { createModelViewer, type ModelViewer, type ViewerScene } from "./viewer.ts"

// ---- 3D models --------------------------------------------------------------
// A model is a `.glb` under a style's output folder: a file the project
// holds, not a manifest asset. Its record draws it, lists its textures, and
// (with --edit) opens one texture in the editor with a guide over it that
// says which piece of the unwrap is which part of the body. A save writes an
// edited copy of the model under edits/; the model as built is never touched.

const EDIT_STATUS: Record<string, [string, string]> = {
  edited: ['ok', 'An edited copy of the model as it is now. The model as built is untouched.'],
  'rebuilt-since': ['warn', 'The model was rebuilt after this edit was made; the edit is based on the older build.'],
  unrecorded: ['dim', 'A file placed at the edit path by hand; nothing records what it was based on.'],
};

const REFERENCE_CHOICES: Array<[string, string]> = [
  ['guide', 'the guide'],
  ['guide+original', 'the guide over the texture as built'],
  ['original', 'the texture as built'],
  ['none', 'nothing'],
];

/** What the open record keeps between redraws: the canvas must not be rebuilt every refresh. */
interface Live {
  id: string
  drawer: HTMLElement
  scrim: HTMLElement
  info: HTMLElement
  controls: HTMLElement
  stage: HTMLElement
  viewer: ModelViewer | null
  /** Url of the file the viewer shows, or is loading. */
  url: string | null
  doc: GlbDocument | null
  scene: ViewerScene | null
  error: string | null
  loading: boolean
}
let live: Live | null = null

/** For browser tests and the console: what the open record is drawing. */
export const modelState = () => live && {
  id: live.id, url: live.url, loading: live.loading, error: live.error, scene: live.scene,
  coverage: live.viewer ? live.viewer.coverage() : 0, clip: live.viewer?.clip() ?? null, viewer: live.viewer,
};

const docs = new Map<string, Promise<GlbDocument>>();
/** One parse per file version; the url carries the file's hash. */
function fetchDoc(url: string): Promise<GlbDocument> {
  let doc = docs.get(url);
  if (!doc) {
    doc = fetch(url, { cache: 'no-store' }).then(async (res) => {
      if (!res.ok) throw new Error(await res.text());
      return parseGlb(new Uint8Array(await res.arrayBuffer()));
    });
    doc.catch(() => docs.delete(url));
    docs.set(url, doc);
    // Two versions of a few models is all a session looks at; older ones go.
    while (docs.size > 6) docs.delete(docs.keys().next().value!);
  }
  return doc;
}

const modelOf = (id: string | null): GalleryModel | undefined => S.snap.models.find((m) => m.id === id);
const canWrite = () => EDITABLE;

// ---- card thumbnails ----
// Each model is drawn once, at rest, by one hidden viewer shared by every
// card (a page may hold only a handful of WebGL contexts), and kept as an
// image keyed by the file's url, which carries its hash: a new save or
// rebuild draws a new one. A card shows what ships, so an edit when there is one.

const thumbs = new Map<string, string>();
const queued: GalleryModel[] = [];
let thumbViewer: ModelViewer | null | undefined;
let drawing = false;

const thumbSource = (model: GalleryModel) => model.edit ?? model.file;

function thumbFor(model: GalleryModel): string | null {
  if (model.error) return null;
  const url = thumbs.get(thumbSource(model).url);
  if (url) return url;
  if (!queued.some((m) => thumbSource(m).url === thumbSource(model).url)) queued.push(model);
  void drainThumbs();
  return null;
}

async function drainThumbs() {
  if (drawing) return;
  drawing = true;
  try {
    while (queued.length) {
      const model = queued.shift()!;
      const source = thumbSource(model).url;
      if (thumbs.has(source)) continue;
      if (thumbViewer === undefined) {
        const host = el('div', 'model-thumb-host');
        host.setAttribute('aria-hidden', 'true');
        document.body.append(host);
        try { thumbViewer = createModelViewer(host); } catch { thumbViewer = null; }
      }
      if (!thumbViewer) return;
      try {
        await thumbViewer.show(await fetchDoc(source));
        // The first frame of its idle (or first) animation, still.
        const clip = thumbViewer.clip();
        thumbViewer.setPlaying(false);
        thumbViewer.setClip(null);
        thumbViewer.setClip(clip);
        thumbViewer.resetCamera();
        thumbs.set(source, thumbViewer.snapshot());
      } catch {
        continue;
      }
      const card = document.querySelector<HTMLElement>('.card.model-card[data-key="' + CSS.escape(model.id) + '"] .cell');
      if (card && !card.querySelector('img.model-thumb')) {
        const img = el('img', 'model-thumb'); img.src = thumbs.get(source)!; img.alt = model.name;
        card.prepend(img);
        card.querySelector<HTMLElement>('.model-glyph')!.hidden = true;
      }
    }
  } finally {
    drawing = false;
  }
}

/** For browser tests: how many thumbnails are drawn. */
export const thumbCount = () => thumbs.size;

// ---- on the grid ----

function visibleModels(): GalleryModel[] {
  const q = ui.q.trim().toLowerCase();
  return S.snap.models.filter((m) => (!ui.projects.size || ui.projects.has(m.project ?? '')) &&
    (!q || (m.id + ' ' + m.file.path + ' ' + m.styleId).toLowerCase().includes(q)));
}

function modelCard(model: GalleryModel) {
  const c = el('button', 'card model-card' + (ui.model === model.id ? ' active' : ''));
  c.type = 'button';
  c.dataset.key = model.id;
  c.setAttribute('aria-label', '3D model ' + model.name + (model.edit ? ', edited' : ''));
  const cell = el('div', 'cell');
  const thumbUrl = thumbFor(model);
  if (thumbUrl) {
    const img = el('img', 'model-thumb'); img.src = thumbUrl; img.alt = model.name;
    cell.append(img);
  }
  const glyph = el('div', 'model-glyph');
  if (thumbUrl) glyph.hidden = true;
  glyph.append(el('b', null, '.glb'));
  if (model.summary) {
    const tris = model.summary.meshes.reduce((sum, mesh) => sum + mesh.triangles, 0);
    glyph.append(el('span', null, model.summary.meshes.length + (model.summary.meshes.length === 1 ? ' mesh' : ' meshes') + ' · ' + tris.toLocaleString() + ' triangles'));
    if (model.summary.animations.length) glyph.append(el('span', null, model.summary.animations.length + (model.summary.animations.length === 1 ? ' animation' : ' animations')));
  } else glyph.append(el('span', null, 'could not be read'));
  cell.append(glyph, el('span', 'badge', '3D'));
  if (model.edit) { const pen = el('span', 'pen', '✎'); pen.title = 'has an edited copy'; cell.append(pen); }
  const body = el('div', 'cbody');
  body.append(el('div', 'aid', model.name));
  const meta = el('div', 'cmeta');
  meta.append(el('span', null, model.styleId), el('span', null, fmtBytes(model.file.bytes)));
  body.append(meta);
  c.append(cell, body);
  c.onclick = () => openModel(model.id);
  return c;
}

/** The "3D models" section of the grid, one per project in a workspace; empty when there are none. */
export function modelSections(): HTMLElement[] {
  const models = visibleModels();
  if (!models.length) return [];
  const projects = [...new Set(models.map((m) => m.project))];
  return projects.map((project) => {
    const mine = models.filter((m) => m.project === project);
    const wrap = el('section', 'style models');
    const head = el('div', 'shead');
    head.append(el('h2', null, (project ? project + ' · ' : '') + '3D models'));
    const meta = el('div', 'meta');
    meta.append(el('span', null, mine.length + (mine.length === 1 ? ' model' : ' models')),
      el('span', null, '.glb files under the styles’ output folders; not manifest assets, so they have no plan state or cost'));
    head.append(meta);
    const grid = el('div', 'grid');
    for (const model of mine) grid.append(modelCard(model));
    wrap.append(head, grid);
    return wrap;
  });
}

// ---- the record ----

export function openModel(id: string) {
  ui.open = null; ui.editing = null;
  if (ui.model !== id) { ui.notice = null; ui.modelSide = 'edited'; }
  ui.model = id;
  syncHash();
  markActive(id);
  $('drawer-host').textContent = '';
  renderModelDrawer();
}
export function closeModel() {
  const id = ui.model;
  ui.model = null;
  ui.notice = null;
  syncHash();
  markActive(null);
  teardown();
  const focus = id && document.querySelector<HTMLElement>('.card[data-key="' + CSS.escape(id) + '"]');
  if (focus) focus.focus({ preventScroll: true });
}
function teardown() {
  if (!live) return;
  live.viewer?.dispose();
  live.drawer.remove();
  live.scrim.remove();
  live = null;
}

/** Which file the preview draws: the edit when there is one and it is chosen, else the model as built. */
const shownFile = (model: GalleryModel) => model.edit && ui.modelSide === 'edited' ? model.edit : model.file;

/** Draws or updates the open model's record. False when no model is open. */
export function renderModelDrawer(): boolean {
  const model = modelOf(ui.model);
  if (!model) { teardown(); if (ui.model) { ui.model = null; syncHash(); } return false; }
  const host = $('drawer-host');
  if (!live || live.id !== model.id || !live.drawer.isConnected) {
    teardown();
    host.textContent = '';
    const scrim = el('div', 'scrim');
    scrim.onclick = () => closeModel();
    const drawer = el('aside', 'drawer model-drawer');
    drawer.setAttribute('role', 'dialog');
    drawer.setAttribute('aria-label', model.id);
    const head = el('div', 'dhead');
    const title = el('div', 'title');
    if (model.project) title.append(el('span', 'sid project', model.project), ' ');
    title.append(el('span', 'sid', model.styleId), ' ', el('span', 'sid', '3D model'), el('div', 'aid', model.name));
    const close = el('button', null, 'Close'); close.type = 'button'; close.onclick = () => closeModel();
    const nav = el('div', 'nav'); nav.append(close);
    head.append(title, nav);
    const body = el('div', 'dbody');
    const stage = el('div', 'preview model-stage');
    stage.setAttribute('role', 'img');
    stage.setAttribute('aria-label', 'A 3D view of ' + model.name + '. Drag to turn it.');
    const controls = el('div', 'model-controls');
    const info = el('div');
    body.append(stage, controls, info);
    drawer.append(head, body);
    host.append(scrim, drawer);
    let viewer: ModelViewer | null = null;
    let error: string | null = null;
    try { viewer = createModelViewer(stage); }
    catch (err) { error = err.message; }
    if (!viewer) stage.append(el('div', 'none', error ? 'This browser could not draw the model: ' + error : 'This browser has no WebGL2, so the model cannot be drawn here. Its record is below.'));
    live = { id: model.id, drawer, scrim, info, controls, stage, viewer, url: null, doc: null, scene: null, error, loading: false };
    close.focus({ preventScroll: true });
  }
  const state = live;
  const file = shownFile(model);
  if (state.viewer && !model.error && state.url !== file.url) {
    state.url = file.url;
    state.loading = true;
    state.error = null;
    const wanted = file.url;
    fetchDoc(wanted).then(async (doc) => {
      if (live !== state || state.url !== wanted) return;
      const scene = await state.viewer!.show(doc);
      if (live !== state || state.url !== wanted) return;
      state.doc = doc; state.scene = scene; state.loading = false;
      renderControls(state); renderInfo(state);
    }).catch((err) => {
      if (live !== state || state.url !== wanted) return;
      state.loading = false; state.error = err.message;
      renderControls(state); renderInfo(state);
    });
  }
  renderControls(state);
  renderInfo(state);
  return true;
}

function renderControls(state: Live) {
  const model = modelOf(state.id);
  const host = state.controls;
  host.textContent = '';
  if (!model) return;
  const viewer = state.viewer;
  if (state.loading && !state.scene) host.append(el('div', 'state-dim', 'Loading the model…'));
  if (state.error) host.append(el('div', 'state-bad', 'The model could not be drawn: ' + state.error));
  if (!viewer || !state.scene) return;
  const scene = state.scene;
  const bar = el('div', 'model-row');
  if (scene.clips.length) {
    const play = el('button', null, viewer.playing() ? 'Pause' : 'Play'); play.type = 'button';
    play.onclick = () => { viewer.setPlaying(!viewer.playing()); renderControls(state); };
    const pick = el('select'); pick.setAttribute('aria-label', 'Animation');
    const none = el('option', null, 'rest pose'); none.value = ''; pick.append(none);
    for (const name of scene.clips) { const o = el('option', null, name.replaceAll('_', ' ')); o.value = name; pick.append(o); }
    pick.value = viewer.clip() ?? '';
    pick.onchange = () => { viewer.setClip(pick.value || null); };
    bar.append(play, pick);
  } else bar.append(el('span', 'state-dim', 'no animations in this file'));
  const out = el('button', null, '−'); out.type = 'button'; out.title = 'Zoom out'; out.setAttribute('aria-label', 'Zoom out'); out.onclick = () => viewer.zoom(1.25);
  const zin = el('button', null, '+'); zin.type = 'button'; zin.title = 'Zoom in'; zin.setAttribute('aria-label', 'Zoom in'); zin.onclick = () => viewer.zoom(0.8);
  const reset = el('button', null, 'Reset view'); reset.type = 'button'; reset.onclick = () => viewer.resetCamera();
  bar.append(el('span', 'grow'), out, zin, reset);
  host.append(bar);
  if (model.edit) {
    const sides = el('div', 'model-row');
    sides.append(el('span', 'lbl', 'Showing'));
    const seg = el('span', 'seg');
    for (const [side, label] of [['edited', 'Edited'], ['original', 'As built']] as const) {
      const b = el('button', ui.modelSide === side ? 'on' : null, label); b.type = 'button';
      b.setAttribute('aria-pressed', String(ui.modelSide === side));
      b.onclick = () => { ui.modelSide = side; renderModelDrawer(); };
      seg.append(b);
    }
    sides.append(seg);
    host.append(sides);
  }
  if (scene.items.length) {
    const worn = el('div', 'model-row');
    worn.append(el('span', 'lbl', 'Parts'));
    for (const item of scene.items) {
      const on = viewer.itemShown(item);
      const b = el('button', 'chip' + (on ? ' on' : ''), item.replaceAll('_', ' ')); b.type = 'button';
      b.setAttribute('aria-pressed', String(on));
      b.title = on ? 'Hide ' + item : 'Show ' + item;
      b.onclick = () => { viewer.setItem(item, !viewer.itemShown(item)); renderControls(state); };
      worn.append(b);
    }
    host.append(worn);
  }
  if (scene.note) host.append(el('div', 'state-warn', scene.note));
  host.append(el('div', 'state-dim model-hint', 'Drag to turn it.'));
}

const section = (title: string) => { const s = el('section', 'meta'); s.append(el('h3', null, title)); return s; };

async function postModel(model: GalleryModel, action: string, extra: Record<string, unknown> = {}) {
  const body: any = { action, path: model.file.path, ...extra };
  if (model.project) body.project = model.project;
  S.snap = await postEdit(body);
}

function renderInfo(state: Live) {
  const model = modelOf(state.id);
  const host = state.info;
  host.textContent = '';
  if (!model) return;
  if (ui.notice && ui.notice.id === model.id) host.append(el('div', 'notice', ui.notice.text));
  if (model.error) host.append(el('div', 'state-bad', 'This file could not be read as a model: ' + model.error));

  // Textures: the base colour ones can be painted; the rest are listed.
  const images = model.summary?.images ?? [];
  if (images.length) {
    const s = section('Textures');
    const editable = canWrite() && EDITOR && S.ED;
    if (canWrite() && EDITOR && S.ED && S.ED.installed) {
      const pickRow = el('label', 'model-row');
      pickRow.append(el('span', 'lbl', 'Locked layer shows'));
      const pick = el('select');
      for (const [value, label] of REFERENCE_CHOICES) { const o = el('option', null, label); o.value = value; pick.append(o); }
      pick.value = REFERENCE_CHOICES.some(([value]) => value === ui.modelReference) ? ui.modelReference : 'guide';
      pick.onchange = () => { ui.modelReference = pick.value; savePrefs(); };
      pick.title = 'What the editor’s locked reference layer carries, at 50%: the guide outlines each piece of the unwrap and names the body part it covers. It is never part of the saved texture.';
      pickRow.append(pick);
      s.append(pickRow);
    }
    const list = el('div', 'model-textures');
    for (const image of images) {
      const paintable = image.roles.includes('baseColor') && image.embedded && image.width && image.height;
      const entry = el('div', 'model-texture');
      const thumb = el('canvas'); thumb.width = 72; thumb.height = 72;
      const bitmap = state.viewer?.image(image.index);
      if (bitmap) thumb.getContext('2d')!.drawImage(bitmap, 0, 0, 72, 72);
      const text = el('div', 'tx');
      const role = image.roles.map((r) => r === 'baseColor' ? 'base colour' : r === 'normal' ? 'normal map' : r).join(', ') || 'not used by a material';
      text.append(el('b', null, (image.materials.join(', ') || 'image ' + image.index) + ' · ' + role));
      const guide = paintable && state.doc ? guideFor(state.doc, image.index) : null;
      text.append(el('span', null, (image.width ? image.width + '×' + image.height : 'size unknown') + ' · ' + (image.mimeType || 'unknown type').replace('image/', '') +
        ' · ' + fmtBytes(image.bytes) + (guide ? ' · ' + guide.pieces.length + (guide.pieces.length === 1 ? ' piece over ' : ' pieces over ') + guide.regions.length + (guide.regions.length === 1 ? ' region' : ' regions') : '')));
      if (image.meshes.length) text.append(el('span', null, 'on ' + image.meshes.join(', ')));
      const edited = model.edit?.textures.find((t) => t.image === image.index);
      if (edited) text.append(el('span', 'state-ok', 'painted in ' + edited.editor + ', ' + fmtWhen(edited.savedAt) + (edited.project ? ' · layers kept' : '')));
      entry.append(thumb, text);
      if (paintable && editable) {
        const acts = el('div', 'acts');
        if (S.ED.installed) {
          const b = el('button', 'primary', 'Edit texture in browser'); b.type = 'button';
          b.title = 'Open this texture in Pixelorama here; Save writes an edited copy of the model under edits/';
          b.onclick = () => openTextureSheet(model, image.index);
          acts.append(b);
        } else if (S.ED.release && !S.ED.installing) {
          const b = el('button', null, 'Install editor to paint'); b.type = 'button';
          b.onclick = () => { installEditor(); window.scrollTo({ top: 0 }); };
          acts.append(b);
        }
        entry.append(acts);
      }
      list.append(entry);
    }
    s.append(list);
    if (!canWrite()) s.append(el('div', 'state-dim readonly-hint', 'Start the gallery with --edit to paint a texture here or open the model in Blender.'));
    host.append(s);
  }

  // The edit, and the way in and out of Blender.
  {
    const s = section('Edited copy');
    const dl = el('dl');
    if (model.edit) {
      const [tone, why] = EDIT_STATUS[model.edit.status];
      const st = el('span', 'state-' + tone); st.append(el('i', 'dot ' + tone), document.createTextNode(' ' + model.edit.status));
      row(dl, 'status', st);
      row(dl, 'why', why + (model.edit.changedSince ? ' The file changed on disk after its record was written.' : ''));
      row(dl, 'file', model.edit.path, { mono: true, copy: model.edit.absolutePath });
      row(dl, 'size', fmtBytes(model.edit.bytes));
      row(dl, 'sha256', model.edit.sha256.slice(0, 16) + '…', { mono: true, copy: model.edit.sha256 });
      if (model.edit.editor) row(dl, 'saved', model.edit.editor + ', ' + fmtWhen(model.edit.savedAt));
    } else {
      s.append(el('div', 'state-dim', 'None yet. Painting a texture, or adopting an export from Blender, writes a copy of the model to ' + model.editPath + '; the model as built stays as it is.'));
    }
    row(dl, 'export to', model.exportPath, { mono: true, copy: model.exportAbsolutePath });
    s.append(dl);
    if (canWrite()) {
      const acts = el('div', 'hand-actions');
      const msg = el('span', 'msg');
      const act = (label: string, primary: boolean, title: string, run: () => Promise<string>) => {
        const b = el('button', primary ? 'primary' : null, label); b.type = 'button'; b.title = title;
        b.onclick = async () => {
          b.disabled = true; msg.className = 'msg'; msg.textContent = '…';
          try { const done = await run(); ui.notice = { id: model.id, text: done }; render(); }
          catch (err) { b.disabled = false; msg.className = 'msg bad'; msg.textContent = err.message; }
        };
        acts.append(b);
        return b;
      };
      const blender = act('Open in Blender', false, 'Start Blender with this model imported and File > Export > PixelKiln edit (.glb) added',
        async () => { await postModel(model, 'open-model'); return 'Started Blender on ' + (model.edit ? model.edit.path : model.file.path) + '. Paint there, then use File > Export > PixelKiln edit (.glb) and press Refresh here.'; });
      if (!S.snap.tools.blender) {
        blender.disabled = true;
        blender.title = 'Blender was not found in its usual place. Set PIXELKILN_BLENDER to the program and start the gallery again.';
      }
      if (model.exportWaiting) {
        act('Adopt the export’s textures', true, 'Take the base colour textures from ' + model.exportPath + ' into a copy of the model as built; meshes, normal maps, and animations stay exactly as built',
          async () => { await postModel(model, 'adopt-model-export', { mode: 'textures' }); ui.modelSide = 'edited'; return 'Adopted the exported textures into ' + model.editPath + '.'; });
        act('Adopt the whole file', false, 'Use ' + model.exportPath + ' as the edit exactly as exported',
          async () => { await postModel(model, 'adopt-model-export', { mode: 'whole' }); ui.modelSide = 'edited'; return 'Adopted the exported file as ' + model.editPath + '.'; });
      }
      acts.append(msg);
      s.append(acts);
      if (model.exportWaiting) s.append(el('div', 'state-cool', 'An export is waiting at ' + model.exportPath + ' (' + fmtBytes(model.exportWaiting.bytes) + ', ' + fmtWhen(model.exportWaiting.modifiedAt) + ').'));
      else if (!S.snap.tools.blender) s.append(el('div', 'state-dim', 'Blender was not found on this machine. Set PIXELKILN_BLENDER to start it from here, or export a .glb to the path above from any program and Refresh.'));
    }
    host.append(s);
  }

  {
    const s = section('Model');
    const dl = el('dl');
    row(dl, 'file', model.file.path, { mono: true, copy: model.file.absolutePath });
    row(dl, 'size', fmtBytes(model.file.bytes));
    row(dl, 'sha256', model.file.sha256.slice(0, 16) + '…', { mono: true, copy: model.file.sha256 });
    row(dl, 'modified', fmtWhen(model.file.modifiedAt));
    if (model.summary) {
      row(dl, 'made by', model.summary.generator);
      row(dl, 'meshes', model.summary.meshes.map((mesh) => mesh.name + ' (' + mesh.triangles.toLocaleString() + ' triangles)').join(', '));
      row(dl, 'skeleton', model.summary.bones.length ? model.summary.bones.length + ' bones: ' + model.summary.bones.join(', ') : 'none');
      row(dl, 'animations', model.summary.animations.join(', ') || 'none');
    }
    s.append(dl);
    host.append(s);
  }
}

// ---- the guide ----

const guides = new WeakMap<GlbDocument, Map<number, UvGuide>>();
function guideFor(doc: GlbDocument, image: number): UvGuide {
  let perDoc = guides.get(doc);
  if (!perDoc) guides.set(doc, perDoc = new Map());
  let guide = perDoc.get(image);
  if (!guide) {
    try { guide = uvGuide(doc, image); }
    catch { guide = { pieces: [], regions: [] }; }
    perDoc.set(image, guide);
  }
  return guide;
}

/**
 * Draw the guide for one texture: every piece outlined in its region's
 * colour, and named where the name fits inside it. A piece too small for its
 * name gets its region's number, which the legend beside the editor spells
 * out; one too small for that keeps the colour alone.
 */
export function drawGuide(ctx: CanvasRenderingContext2D, guide: UvGuide, width: number, height: number) {
  const line = Math.max(1, Math.round(width / 512));
  ctx.lineCap = 'round';
  for (const pass of ['halo', 'line'] as const) {
    for (const piece of guide.pieces) {
      ctx.beginPath();
      for (let at = 0; at < piece.outline.length; at += 4) {
        ctx.moveTo(piece.outline[at] * width, piece.outline[at + 1] * height);
        ctx.lineTo(piece.outline[at + 2] * width, piece.outline[at + 3] * height);
      }
      ctx.lineWidth = pass === 'halo' ? line + 2 : line;
      ctx.strokeStyle = pass === 'halo' ? 'rgba(0,0,0,.85)' : regionColour(guide.regions.indexOf(piece.region));
      ctx.stroke();
    }
  }
  const size = Math.max(9, Math.min(18, Math.round(width / 56)));
  ctx.font = '600 ' + size + 'px ui-sans-serif, system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.lineJoin = 'round';
  for (const piece of guide.pieces) {
    const boxW = (piece.bounds[2] - piece.bounds[0]) * width, boxH = (piece.bounds[3] - piece.bounds[1]) * height;
    const number = String(guide.regions.indexOf(piece.region) + 1);
    const candidates = [pieceLabel(piece), piece.region, number];
    const text = candidates.find((candidate) => ctx.measureText(candidate).width + 6 <= boxW && size + 4 <= boxH);
    if (!text) continue;
    const half = ctx.measureText(text).width / 2 + 2;
    const x = Math.max(half, Math.min(width - half, piece.anchor[0] * width));
    const y = Math.max(size / 2 + 1, Math.min(height - size / 2 - 1, piece.anchor[1] * height));
    ctx.lineWidth = 3;
    ctx.strokeStyle = 'rgba(0,0,0,.9)';
    ctx.strokeText(text, x, y);
    ctx.fillStyle = '#fff';
    ctx.fillText(text, x, y);
  }
}

function legend(guide: UvGuide) {
  const strip = el('div', 'model-legend');
  strip.title = 'The guide’s colours and numbers: each piece of the unwrap is outlined in the colour of the body region that moves it';
  guide.regions.forEach((region, index) => {
    const item = el('span');
    const swatch = el('i'); swatch.style.background = regionColour(index);
    item.append(swatch, document.createTextNode((index + 1) + ' ' + region));
    strip.append(item);
  });
  return strip;
}

const canvasPng = (canvas: HTMLCanvasElement): Promise<ArrayBuffer> => new Promise((resolve, reject) => {
  canvas.toBlob((blob) => blob ? blob.arrayBuffer().then(resolve, reject) : reject(new Error('the browser could not encode the image')), 'image/png');
});

async function decode(doc: GlbDocument, image: number): Promise<ImageBitmap> {
  const { bytes, mimeType } = glbImageBytes(doc, image);
  return createImageBitmap(new Blob([bytes.slice()], { type: mimeType || 'image/png' }), { premultiplyAlpha: 'none', colorSpaceConversion: 'none' });
}

// ---- painting one texture ----

function openTextureSheet(model: GalleryModel, image: number) {
  const summary = model.summary!.images[image];
  const name = summary.materials[0] || 'image ' + image;
  const choice = REFERENCE_CHOICES.some(([value]) => value === ui.modelReference) ? ui.modelReference : 'guide';
  // The texture to paint is the edit's when there is one, so earlier work carries on.
  const current = model.edit ?? model.file;
  const strip = el('div', 'model-legend-host');
  // The model beside the editor, painted with what is on the canvas as the author pauses.
  const side = el('div', 'sheet-side model-side');
  const sideStage = el('div', 'model-side-stage');
  const sideBar = el('div', 'model-row');
  const sideNote = el('div', 'state-dim model-hint', 'Loading the model…');
  side.append(sideStage, sideBar, sideNote);
  let viewer: ModelViewer | null = null;
  let updates = 0;
  const sideControls = (scene: ViewerScene) => {
    sideBar.textContent = '';
    if (!viewer) return;
    const v = viewer;
    if (scene.clips.length) {
      const play = el('button', null, v.playing() ? 'Pause' : 'Play'); play.type = 'button';
      play.onclick = () => { v.setPlaying(!v.playing()); play.textContent = v.playing() ? 'Pause' : 'Play'; };
      const pick = el('select'); pick.setAttribute('aria-label', 'Animation');
      const none = el('option', null, 'rest pose'); none.value = ''; pick.append(none);
      for (const n of scene.clips) { const o = el('option', null, n.replaceAll('_', ' ')); o.value = n; pick.append(o); }
      pick.value = v.clip() ?? '';
      pick.onchange = () => v.setClip(pick.value || null);
      sideBar.append(play, pick);
    }
    for (const item of scene.items) {
      const b = el('button', 'chip' + (v.itemShown(item) ? ' on' : ''), item.replaceAll('_', ' ')); b.type = 'button';
      b.onclick = () => { v.setItem(item, !v.itemShown(item)); b.classList.toggle('on', v.itemShown(item)); };
      sideBar.append(b);
    }
  };
  const custom = {
    title: (model.project ? model.project + ':' : '') + model.name + ' · ' + name + ' texture · ' + summary.width + '×' + summary.height,
    referenceLabel: choice === 'original' ? 'show the texture as built' : choice === 'guide' ? 'show the guide' : 'show the guide and the texture as built',
    referenceTitle: 'A locked layer at 50%, for finding your way; never part of the saved texture',
    below: choice === 'guide' || choice === 'guide+original' ? strip : null,
    side: {
      element: side,
      label: '3D view',
      shown: () => ui.side3d,
      setShown: (on: boolean) => { ui.side3d = on; savePrefs(); },
    },
    async live(png: ArrayBuffer) {
      if (!viewer) return;
      const bitmap = await createImageBitmap(new Blob([png], { type: 'image/png' }), { premultiplyAlpha: 'none', colorSpaceConversion: 'none' });
      viewer.setImage(image, bitmap);
      bitmap.close();
      updates++;
      if (S.SHEET) S.SHEET.liveUpdates = updates;
      sideNote.textContent = 'Drag to turn it. Follows the canvas as you paint (' + updates + (updates === 1 ? ' update' : ' updates') + '); nothing is written until you save.';
    },
    async open() {
      const sheet = S.SHEET;
      const [doc, original] = await Promise.all([fetchDoc(current.url), fetchDoc(model.file.url)]);
      try { viewer = createModelViewer(sideStage); }
      catch { viewer = null; }
      if (viewer) {
        viewer.show(doc).then((scene) => { sideControls(scene); sideNote.textContent = 'Drag to turn it. Follows the canvas as you paint; nothing is written until you save.'; });
      } else sideNote.textContent = 'This browser has no WebGL2, so the model cannot be drawn here.';
      const width = summary.width!, height = summary.height!;
      // The editor takes PNG; a JPEG texture is decoded here and handed over as one.
      const paint = el('canvas'); paint.width = width; paint.height = height;
      const bitmap = await decode(doc, image);
      if (bitmap.width !== width || bitmap.height !== height) throw new Error('the edit’s texture is ' + bitmap.width + '×' + bitmap.height + '; the model’s is ' + width + '×' + height);
      paint.getContext('2d')!.drawImage(bitmap, 0, 0);
      bitmap.close();
      const png = await canvasPng(paint);
      let reference: ArrayBuffer | null = null;
      if (choice !== 'none' && sheet.ready.version >= 4) {
        const layer = el('canvas'); layer.width = width; layer.height = height;
        const ctx = layer.getContext('2d')!;
        if (choice !== 'guide') { const built = await decode(original, image); ctx.drawImage(built, 0, 0, width, height); built.close(); }
        if (choice !== 'original') {
          const guide = guideFor(doc, image);
          drawGuide(ctx, guide, width, height);
          strip.textContent = '';
          strip.append(legend(guide));
        }
        reference = await canvasPng(layer);
      }
      let pxo: ArrayBuffer | null = null;
      const kept = model.edit?.textures.find((t) => t.image === image);
      if (kept?.projectUrl) {
        const res = await fetch(kept.projectUrl, { cache: 'no-store' });
        if (res.ok) pxo = await res.arrayBuffer();
      }
      if (S.SHEET !== sheet) return;
      const request = 'open-' + (++sheet.requests);
      sheet.sentProject = !!pxo;
      const message: any = {
        type: 'pixelkiln:open', request,
        asset: { key: model.id + '#image-' + image, id: model.id, name: (model.name + '-' + name).replace(/[^A-Za-z0-9._-]+/g, '-'), width, height },
        png, palette: [],
      };
      const transfer: ArrayBuffer[] = [png];
      if (pxo) { message.pxo = pxo; transfer.push(pxo); }
      if (reference) { message.reference = [{ role: null, png: reference }]; transfer.push(reference); }
      sheet.sentReference = !!reference;
      sheet.frame.contentWindow.postMessage(message, location.origin, transfer);
      sheet.status.textContent = '';
      sheet.status.append(el('i', 'dot cool'), document.createTextNode('opening'));
    },
    opened(m) {
      const from = m.source === 'pxo' ? 'painting the ' + name + ' texture with ' + (m.layers === 1 ? 'its layer' : 'its ' + m.layers + ' layers') + ' restored'
        : S.SHEET.sentProject ? 'painting the flattened ' + name + ' texture; its layer file could not be opened'
        : model.edit ? 'painting the ' + name + ' texture of the edited copy' : 'painting a copy of the ' + name + ' texture';
      return from + (m.reference ? ' · ' + (choice === 'original' ? 'texture as built' : 'guide') + ' shown through at 50%' : '');
    },
    async save(m) {
      const body: any = { image, png: await toBase64(m.png), editor: S.SHEET.ready.editor, protocol: S.SHEET.ready.version };
      if (m.pxo && m.pxo.byteLength) body.pxo = await toBase64(m.pxo);
      await postModel(model, 'save-model-texture', body);
      // The preview follows the save.
      ui.modelSide = 'edited';
      const saved = modelOf(model.id);
      ui.notice = { id: model.id, text: 'Saved the ' + name + ' texture into ' + (saved?.edit?.path ?? model.editPath) + '. The model as built is unchanged.' };
    },
  };
  openEditorSheet(model, custom);
}
