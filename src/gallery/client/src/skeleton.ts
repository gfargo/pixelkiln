import { poseEditor } from "./pose-editor.ts"
import { addAssetAndOpen, nextStep, showSaveError } from "./form-kit.ts"
import { S, el, field, fmtCost, postEdit, projectOf, ui } from "./core.ts"
import { render, renderDrawer } from "./drawer.ts"

// ---- skeleton animation ----------------------------------------------------

/** PixelLab's 18-joint body, as src/skeleton.ts draws it: right orange, left blue. */
export const SKELETON_BONES = [
  ['NOSE', 'NECK'],
  ['NECK', 'RIGHT SHOULDER'], ['RIGHT SHOULDER', 'RIGHT ELBOW'], ['RIGHT ELBOW', 'RIGHT ARM'],
  ['NECK', 'LEFT SHOULDER'], ['LEFT SHOULDER', 'LEFT ELBOW'], ['LEFT ELBOW', 'LEFT ARM'],
  ['NECK', 'RIGHT HIP'], ['RIGHT HIP', 'RIGHT KNEE'], ['RIGHT KNEE', 'RIGHT LEG'],
  ['NECK', 'LEFT HIP'], ['LEFT HIP', 'LEFT KNEE'], ['LEFT KNEE', 'LEFT LEG'],
  ['NOSE', 'RIGHT EYE'], ['RIGHT EYE', 'RIGHT EAR'], ['NOSE', 'LEFT EYE'], ['LEFT EYE', 'LEFT EAR'],
];
export const SKELETON_LABELS = [...new Set(SKELETON_BONES.flat())];
export const boneColor = (label) => label.startsWith('RIGHT') ? '#ff8c28' : label.startsWith('LEFT') ? '#3c96ff' : '#f0f0f0';
export const SVG_NS = 'http://www.w3.org/2000/svg';
export const svgEl = (tag, attrs) => {
  const n = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, String(v));
  return n;
};

/** One pose over the sprite, in a unit square: coordinates are fractions, as PixelLab's are. */
export function poseSvg(pose, imageUrl, dim) {
  const svg = svgEl('svg', { viewBox: '0 0 1 1', class: 'pose' });
  if (imageUrl) svg.append(svgEl('image', { href: imageUrl, x: 0, y: 0, width: 1, height: 1, preserveAspectRatio: 'none', opacity: dim ? 0.45 : 1 }));
  const at = new Map<string, { label: string; x: number; y: number }>(pose.map((j) => [j.label, j]));
  for (const outline of [true, false]) {
    for (const [a, b] of SKELETON_BONES) {
      const p = at.get(a), q = at.get(b);
      if (!p || !q) continue;
      svg.append(svgEl('line', { x1: p.x, y1: p.y, x2: q.x, y2: q.y, stroke: outline ? '#000' : boneColor(b), 'stroke-width': outline ? 0.03 : 0.015, 'stroke-linecap': 'round' }));
    }
    for (const j of pose) {
      const title = outline ? null : svgEl('title', {});
      if (title) title.textContent = j.label + ' (' + j.x.toFixed(2) + ', ' + j.y.toFixed(2) + ')';
      const dot = svgEl('circle', { cx: j.x, cy: j.y, r: outline ? 0.025 : 0.016, fill: outline ? '#000' : boneColor(j.label) });
      if (title) dot.append(title);
      svg.append(dot);
    }
  }
  return svg;
}

/** Every pose of a keypoints set: the starting pose over the full sprite, then each frame. */
export function poseStrip(set, imageUrl) {
  const strip = el('div', 'poses');
  [set.firstFrameKeypoints, ...set.frames].forEach((pose, i) => {
    const cell = el('figure');
    cell.append(poseSvg(pose, imageUrl, i > 0), el('figcaption', null, i === 0 ? 'start' : 'frame ' + i));
    strip.append(cell);
  });
  return strip;
}

/** The image a record shows: its hand edit when it has one, else its first output. */
export const displayUrl = (item) => (item && ((item.edit && item.edit.url) || (item.outputs[0] && item.outputs[0].url))) || null;

/** What is wrong with pasted poses, or null; the server validates again before writing. */
export function skeletonProblem(set) {
  if (!set || typeof set !== 'object' || !Array.isArray(set.firstFrameKeypoints) || !Array.isArray(set.frames)) {
    return 'expected { "firstFrameKeypoints": [...], "frames": [[...], ...] }';
  }
  if (set.frames.length < 3 || set.frames.length > 15) return 'frames must hold 3 to 15 poses, not ' + set.frames.length;
  for (const [i, pose] of [set.firstFrameKeypoints, ...set.frames].entries()) {
    const where = i === 0 ? 'the starting pose' : 'frame ' + i;
    if (!Array.isArray(pose) || pose.length !== 18) return where + ' needs all 18 joints';
    const seen = new Set();
    for (const j of pose) {
      if (!SKELETON_LABELS.includes(j && j.label)) return where + ': "' + (j && j.label) + '" is not one of PixelLab\'s 18 joints';
      if (seen.has(j.label)) return where + ': "' + j.label + '" appears twice';
      seen.add(j.label);
      if (!(j.x >= 0 && j.x <= 1 && j.y >= 0 && j.y <= 1)) return where + ': ' + j.label + ' must sit inside the image (x and y 0 to 1)';
    }
  }
  return null;
}

/** "2 of 10 estimates used this session, billed $0.04": spend in whatever unit PixelLab reported. */
const sessionLine = (s: { used: number; limit: number; spent: Record<string, number> }) => {
  const billed = Object.entries(s.spent).map(([unit, n]) => fmtCost(unit, Math.round(n * 100) / 100)).join(' + ');
  return s.used + ' of ' + s.limit + ' estimates used this session' + (billed ? ', billed ' + billed : '') + '.';
};

/** Why PixelLab's estimate would refuse this sprite, or null. */
export const estimateProblem = (item) => item.width === item.height && [16, 32, 64, 128, 256].includes(item.width)
  ? null
  : 'estimates need a square 16, 32, 64, 128, or 256 px sprite; this one is ' + item.width + '×' + item.height;

/**
 * A new `animate-skeleton` revision of `item`, a single PixelLab sprite. The
 * poses come from a keypoints file already in the project, from pasted JSON,
 * or from PixelLab's estimate of the sprite itself (a direct call the page
 * asks about first); pasted and estimated poses are written to the project
 * before the asset is added, and previewed over the sprite as they change.
 */
export function skeletonAnimationForm(item) {
  const pr = projectOf(item);
  const form = el('form', 'edit');
  form.append(el('h3', null, 'New skeleton animation of ' + item.assetId));
  const id = el('input'); id.type = 'text'; id.placeholder = 'asset-id'; id.required = true; id.autocomplete = 'off';
  id.pattern = '[^\\/\\\\]+';
  const prompt = el('input'); prompt.type = 'text'; prompt.placeholder = 'e.g. swinging the sword downward'; prompt.required = true;
  const direction = el('select');
  for (const d of ['south', 'south-east', 'east', 'north-east', 'north', 'north-west', 'west', 'south-west']) direction.append(new Option(d, d));
  const description = el('input'); description.type = 'text'; description.placeholder = 'optional: colours, clothing, held items';
  const row1 = el('div', 'row');
  row1.append(field('new asset id', id), field('facing', direction, 'Which way the sprite faces.'));
  form.append(row1, field('motion', prompt, 'A short label for the movement; sent as PixelLab\'s action.'), field('looks like', description));

  const source = el('select');
  source.append(new Option('estimate from this sprite', 'estimate'), new Option('paste poses', 'paste'), new Option('use a file in the project', 'file'));
  const file = el('input'); file.type = 'text'; file.required = true;
  let fileTouched = false;
  file.oninput = () => { fileTouched = true; };
  id.oninput = () => { if (!fileTouched) file.value = id.value.trim() ? 'poses/' + id.value.trim() + '.json' : ''; };
  const overwrite = el('input'); overwrite.type = 'checkbox';
  const overwriteField = el('label', 'field check'); overwriteField.append(overwrite, el('span', null, 'replace the file if it exists'));
  const json = el('textarea'); json.className = 'mono'; json.rows = 8; json.spellcheck = false;
  json.placeholder = '{ "firstFrameKeypoints": [18 joints], "frames": [[18 joints], ...3 to 15] }';
  const estimate = el('button', null, 'Estimate poses'); estimate.type = 'button';
  const estimateNote = el('small', 'state-dim');
  const problem = estimateProblem(item);
  estimate.disabled = !!problem;
  const baseNote = 'One PixelLab estimate-skeleton call on your account, kept apart from the generation budget (PixelLab documents about $0.02). The estimate becomes the starting pose and four frames to edit.';
  let session: { used: number; limit: number; spent: Record<string, number> } | null = null;
  const showSession = () => {
    if (problem) { estimateNote.textContent = problem; return; }
    estimateNote.textContent = baseNote + (session ? ' ' + sessionLine(session) : '');
    if (session && session.used >= session.limit) estimate.disabled = true;
  };
  showSession();
  fetch('/api/skeleton', { cache: 'no-store' })
    .then((res) => (res.ok ? res.json() : null))
    .then((s) => { if (s) { session = s; showSession(); } })
    .catch(() => {});
  const estimateRow = el('div', 'actions'); estimateRow.append(estimate, estimateNote);
  const status = el('div', 'msg');
  const preview = el('div');
  const row2 = el('div', 'row');
  row2.append(field('poses from', source), field('keypoints file', file, 'Inside the project. The manifest records this path.'));
  form.append(row2, estimateRow, field('poses (JSON)', json, 'Drag joints in the editor below, or edit the JSON; x and y are fractions of the sprite.'), overwriteField, status, preview);

  const imageUrl = displayUrl(item);
  let set: any = null;
  const showPoses = () => {
    preview.textContent = '';
    status.className = 'msg'; status.textContent = '';
    if (source.value === 'file' || !json.value.trim()) { set = null; return; }
    try { set = JSON.parse(json.value); } catch (e) { set = null; status.className = 'msg bad'; status.textContent = 'not valid JSON: ' + e.message; return; }
    const bad = skeletonProblem(set);
    if (bad) { status.className = 'msg bad'; status.textContent = bad; set = null; return; }
    // Dragging writes the JSON back, so pasted text and the editor stay one file.
    preview.append(poseEditor(set, imageUrl, (next) => { set = next; json.value = JSON.stringify(next, null, 2); }));
  };
  const sync = () => {
    const pasting = source.value !== 'file';
    estimateRow.hidden = source.value !== 'estimate';
    json.parentElement!.hidden = !pasting;
    overwriteField.hidden = !pasting;
    showPoses();
  };
  source.onchange = sync;
  json.oninput = showPoses;
  estimate.onclick = async () => {
    if (!confirm('Ask PixelLab to estimate a skeleton for ' + item.assetId + '? This is one paid call on your account, kept apart from the generation budget.' + (session ? ' ' + sessionLine(session) : ''))) return;
    estimate.disabled = true; status.className = 'msg'; status.textContent = 'estimating…';
    try {
      const body: any = { styleId: item.styleId, assetId: item.assetId };
      if (item.project) body.project = item.project;
      const res = await fetch('/api/skeleton/estimate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Pixelkiln-Session': SESSION ?? '' },
        body: JSON.stringify(body),
      });
      if (!res.ok) throw new Error(await res.text());
      const out = await res.json();
      json.value = JSON.stringify(out.set, null, 2);
      showPoses();
      session = out.session;
      showSession();
      status.className = 'msg'; status.textContent = 'Estimated from ' + out.source + '. Move the frames into the motion, then save.';
    } catch (err) {
      status.className = 'msg bad'; status.textContent = err.message;
    } finally {
      estimate.disabled = false;
    }
  };

  const actions = el('div', 'actions');
  const save = el('button', 'primary', 'Create skeleton animation'); save.type = 'submit';
  const cancel = el('button', null, 'Cancel'); cancel.type = 'button'; cancel.onclick = () => { ui.editing = null; renderDrawer(); };
  const msg = el('span', 'msg');
  actions.append(save, cancel, msg);
  form.append(actions);
  form.onsubmit = async (e) => {
    e.preventDefault();
    if (source.value !== 'file' && !set) { msg.className = 'msg bad'; msg.textContent = 'Add poses first: estimate them or paste a keypoints file.'; return; }
    save.disabled = true; msg.className = 'msg'; msg.textContent = 'saving…';
    const body: any = {
      action: 'create-skeleton-animation', expectedSha256: pr!.manifestSha256, styleId: item.styleId, from: item.assetId,
      assetId: id.value.trim(), prompt: prompt.value.trim(), direction: direction.value, keypointsFile: file.value.trim(),
    };
    if (description.value.trim()) body.description = description.value.trim();
    if (source.value !== 'file') { body.set = set; if (overwrite.checked) body.overwrite = true; }
    if (item.project) body.project = item.project;
    try {
      await addAssetAndOpen(body, { project: item.project, styleId: item.styleId }, 'Added to the manifest with ' + body.keypointsFile + '.');
    } catch (err) {
      showSaveError(msg, save, err);
    }
  };
  sync();
  setTimeout(() => id.focus(), 0);
  return form;
}

/**
 * The pose editor on an existing `animate-skeleton` record: edits a copy of
 * its keypoints file and saves it back, quoting the file's hash so an edit
 * made elsewhere since the page loaded is refused, not overwritten.
 */
export function skeletonPoseForm(item, parentUrl) {
  const form = el('form', 'edit');
  form.append(el('h3', null, 'Edit poses of ' + item.assetId));
  let draft = item.skeleton.set;
  let dirty = false;
  const msg = el('span', 'msg');
  const save = el('button', 'primary', 'Save poses'); save.type = 'submit'; save.disabled = true;
  form.append(poseEditor(draft, parentUrl, (next) => {
    draft = next; dirty = true; save.disabled = false;
    msg.className = 'msg'; msg.textContent = 'unsaved';
  }));
  form.append(el('small', 'state-dim', 'Saving rewrites ' + item.skeleton.keypointsFile + '; the animation is then stale until it is generated again.'));
  const cancel = el('button', null, 'Cancel'); cancel.type = 'button';
  cancel.onclick = () => {
    if (dirty && !confirm('Discard the pose changes?')) return;
    ui.editing = null; renderDrawer();
  };
  const actions = el('div', 'actions');
  actions.append(save, cancel, msg);
  form.append(actions);
  form.onsubmit = async (e) => {
    e.preventDefault();
    save.disabled = true; msg.className = 'msg'; msg.textContent = 'saving…';
    const body: any = { action: 'update-skeleton-keypoints', styleId: item.styleId, assetId: item.assetId, expectedSha256: item.skeleton.sha256, set: draft };
    if (item.project) body.project = item.project;
    try {
      S.snap = await postEdit(body);
      ui.editing = null;
      ui.notice = { id: item.id, text: 'Poses saved to ' + item.skeleton.keypointsFile + '. ' + nextStep().replace('it', 'the animation') };
      render();
    } catch (err) {
      showSaveError(msg, save, err);
    }
  };
  return form;
}
