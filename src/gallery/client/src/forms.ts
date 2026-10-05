import { addAssetAndOpen, showSaveError } from "./form-kit.ts"
import { S, el, field, fmtCost, numberInput, numberOrNull, postEdit, projectOf, ui } from "./core.ts"
import { render, renderDrawer } from "./drawer.ts"
import { maskEditor } from "./mask-editor.ts"
import { displayUrl } from "./skeleton.ts"

// ---- editing (only when the server minted a session) ---------------------

// Styles a parent edit reaches: every descendant (via extends) that does not
// declare the field itself. Child-wins means an omitted field is inherited,
// so the count follows the manifest's own rule rather than guessing.
export function inheritorsOf(style, field) {
  const byId = new Map(S.snap.styles.filter((x) => x.project === style.project).map((x) => [x.id, x]));
  const out: any = [];
  for (const other of byId.values()) {
    if (other.id === style.id) continue;
    let cur: any = other, blocked = false, hops = 0;
    while (cur && cur.id !== style.id && hops++ < 32) {
      if (cur.ownFields.includes(field)) { blocked = true; break; }
      cur = cur.extends ? byId.get(cur.extends) : null;
    }
    if (cur && cur.id === style.id && !blocked) out.push(other.id);
  }
  return out;
}
// noBackground reaches the request only for pixflux and non-PixelLab
// providers; elsewhere a change is recorded but alters nothing.
export const fieldReaches = (field, style) =>
  field === 'enforcePalette' ? false
    : field !== 'noBackground' || style.generator === 'pixflux' || style.provider !== 'pixellab';
export function blastRadius(style, fields) {
  const byId = new Map(S.snap.styles.filter((x) => x.project === style.project).map((x) => [x.id, x]));
  const styleIds = new Set();
  for (const field of fields) {
    for (const id of [style.id, ...inheritorsOf(style, field)]) {
      if (fieldReaches(field, byId.get(id) || style)) styleIds.add(id);
    }
  }
  const affected = S.snap.items.filter((i) => i.project === style.project && i.declared && styleIds.has(i.styleId));
  const units = new Map();
  for (const i of affected) if (i.estimatedCost !== null) units.set(i.costUnit, (units.get(i.costUnit) || 0) + i.estimatedCost);
  return {
    styles: [...styleIds],
    assets: affected.length,
    cost: [...units].map(([unit, n]) => fmtCost(unit, Math.round(n * 100) / 100)).join(' + '),
  };
}
export const parsePalette = (value) => value.split(/[\s,]+/).map((c) => c.trim()).filter(Boolean)
  .map((c) => '#' + c.replace(/^#/, '').toLowerCase());
export const paletteValid = (colors) => colors.every((c) => /^#[0-9a-f]{6}$/.test(c));

export function styleForm(style) {
  const pr = S.snap.workspace ? S.snap.workspace.projects.find((x) => x.id === style.project) : S.snap.project;
  const own = (field) => style.ownFields.includes(field);
  const provenance = (field) => own(field) ? 'set on this style'
    : style.extends ? 'inherited from ' + style.extends + '. Saving sets a value on this style itself; ' + style.extends + ' is unchanged'
    : 'default. Saving sets a value on this style itself';
  const form = el('form', 'edit style-form');
  form.append(el('h3', null, 'Edit style ' + style.id));
  const prefix = el('input'); prefix.type = 'text'; prefix.value = style.promptPrefix; prefix.placeholder = 'none';
  const suffix = el('input'); suffix.type = 'text'; suffix.value = style.promptSuffix; suffix.placeholder = 'none';
  const palette = el('input'); palette.type = 'text'; palette.value = style.palette.join(', '); palette.placeholder = '#rrggbb, #rrggbb (leave empty for no forced palette)';
  const view = el('input'); view.type = 'text'; view.value = style.view || ''; view.placeholder = 'provider default';
  view.setAttribute('list', 'view-options');
  const noBg = el('select');
  noBg.append(new Option(style.extends ? 'inherit from ' + style.extends : 'default (on)', 'default'), new Option('on: strip the generated background', 'on'), new Option('off: keep the background (scenes, banners)', 'off'));
  noBg.value = own('noBackground') ? (style.noBackground ? 'on' : 'off') : 'default';
  const enforce = el('input'); enforce.type = 'checkbox'; enforce.checked = style.enforcePalette;
  const enforceLabel = el('label', 'chip');
  enforceLabel.append(enforce, document.createTextNode(' S.snap downloaded art to this palette (no dithering)'));
  const swatches = el('div', 'pal');
  const drawSwatches = () => {
    swatches.textContent = '';
    for (const c of parsePalette(palette.value)) { const i = el('i'); i.style.background = c; i.title = c; swatches.append(i); }
  };
  drawSwatches();
  form.append(
    field('prompt prefix', prefix, 'Prepended to every asset prompt in this style. ' + provenance('promptPrefix')),
    field('prompt suffix', suffix, 'Appended to every asset prompt in this style. ' + provenance('promptSuffix')),
    field('palette', palette, 'Sent to providers that take a palette; with snapping on, guaranteed on every file after download. ' + provenance('palette')),
    swatches,
    field('after download', enforceLabel, 'Turning this on or off changes no request: the next fetch re-applies it to the files already on disk, spending nothing. ' + provenance('enforcePalette')),
  );
  const row = el('div', 'row');
  row.append(
    field('view', view, 'PixelLab accepts low top-down, high top-down, side; Retro Diffusion reads sidescroller. ' + provenance('view')),
    field('background', noBg, (fieldReaches('noBackground', style) ? 'Sent for this style. ' : 'Not sent for ' + style.provider + ' ' + style.generator + '; recorded only. ') + provenance('noBackground')),
  );
  form.append(row);
  const blast = el('div', 'blast');
  const changed = () => {
    const out: any = [];
    if (prefix.value !== style.promptPrefix) out.push('promptPrefix');
    if (suffix.value !== style.promptSuffix) out.push('promptSuffix');
    if (parsePalette(palette.value).join(',') !== style.palette.map((c) => c.toLowerCase()).join(',')) out.push('palette');
    if (enforce.checked !== style.enforcePalette) out.push('enforcePalette');
    if (view.value.trim() !== (style.view || '')) out.push('view');
    const bgNow = own('noBackground') ? (style.noBackground ? 'on' : 'off') : 'default';
    if (noBg.value !== bgNow) out.push('noBackground');
    return out;
  };
  const updateBlast = () => {
    const fields = changed();
    drawSwatches();
    if (!fields.length) { blast.className = 'blast'; blast.textContent = 'No changes yet. A style change alters the request for every asset that uses it.'; return; }
    const r = blastRadius(style, fields);
    if (!r.assets) {
      blast.className = 'blast';
      blast.textContent = fields.every((f) => f === 'enforcePalette')
        ? 'No request changes. Generated files in ' + style.id + ' become recoverable; the next fetch or restore re-applies the palette rule to them for free.'
        : 'Recorded in the manifest only: nothing in ' + style.id + ' sends this field, so no request changes.';
      return;
    }
    blast.className = 'blast hot';
    blast.textContent = '';
    const others = r.styles.filter((id) => id !== style.id);
    blast.append(el('b', null, 'Affects ' + r.assets + (r.assets === 1 ? ' asset' : ' assets')));
    blast.append(document.createTextNode(others.length
      ? ' in ' + style.id + ' and ' + others.length + (others.length === 1 ? ' style that inherits it (' : ' styles that inherit it (') + others.join(', ') + ').'
      : ' in ' + style.id + '.'));
    blast.append(document.createTextNode(' Generated ones become stale; regenerating all of them is about ' + (r.cost || 'nothing') + '. Nothing is spent until you generate.'));
  };
  for (const input of [prefix, suffix, palette, view]) input.addEventListener('input', updateBlast);
  noBg.addEventListener('change', updateBlast);
  enforce.addEventListener('change', updateBlast);
  updateBlast();
  form.append(blast);
  const actions = el('div', 'actions');
  const save = el('button', 'primary', 'Save to manifest'); save.type = 'submit';
  const cancel = el('button', null, 'Cancel'); cancel.type = 'button'; cancel.onclick = () => { ui.editing = null; render(); };
  const msg = el('span', 'msg');
  actions.append(save, cancel, msg);
  form.append(actions);
  form.onsubmit = async (e) => {
    e.preventDefault();
    const fields = changed();
    if (!fields.length) { ui.editing = null; render(); return; }
    const colors = parsePalette(palette.value);
    if (fields.includes('palette') && !paletteValid(colors)) { msg.className = 'msg bad'; msg.textContent = 'palette must be six-digit hex colours'; return; }
    if (enforce.checked && colors.length < 2) { msg.className = 'msg bad'; msg.textContent = 'snapping needs a palette of at least two colours'; return; }
    const patch: any = {};
    if (fields.includes('promptPrefix')) patch.promptPrefix = prefix.value;
    if (fields.includes('promptSuffix')) patch.promptSuffix = suffix.value;
    if (fields.includes('palette')) patch.palette = colors;
    if (fields.includes('enforcePalette')) patch.enforcePalette = enforce.checked;
    if (fields.includes('view')) patch.view = view.value.trim();
    if (fields.includes('noBackground')) patch.noBackground = noBg.value === 'default' ? null : noBg.value === 'on';
    save.disabled = true; msg.className = 'msg'; msg.textContent = 'saving…';
    const r = blastRadius(style, fields);
    try {
      const body: any = { action: 'patch-style', styleId: style.id, expectedSha256: pr!.manifestSha256, patch };
      if (style.project) body.project = style.project;
      S.snap = await postEdit(body);
      ui.editing = null;
      ui.notice = { id: 'style:' + (style.project || '') + ':' + style.id,
        text: r.assets
          ? 'Saved. The request for ' + r.assets + (r.assets === 1 ? ' asset' : ' assets') + ' changed' + (r.cost ? ', about ' + r.cost + ' to regenerate.' : '.') + ' Nothing is spent until you generate.'
          : 'Saved. Recorded in the manifest; no request changed.' };
      render();
    } catch (err) {
      showSaveError(msg, save, err);
    }
  };
  setTimeout(() => prefix.focus(), 0);
  return form;
}

export function addAssetForm(style) {
  const pr = S.snap.workspace ? S.snap.workspace.projects.find((x) => x.id === style.project) : S.snap.project;
  const siblings = S.snap.styles.filter((x) => x.project === style.project);
  const form = el('form', 'edit');
  form.append(el('h3', null, 'New asset in ' + style.id));
  const id = el('input'); id.type = 'text'; id.placeholder = 'asset-id'; id.required = true; id.autocomplete = 'off';
  id.pattern = '[^\\/\\\\]+';
  const prompt = el('textarea'); prompt.placeholder = 'What to generate. The style adds its prefix and suffix.'; prompt.required = true;
  const width = numberInput(null, 'style default'), height = numberInput(null, 'style default');
  const category = el('input'); category.type = 'text'; category.placeholder = 'optional subfolder';
  const only = el('input'); only.type = 'checkbox'; only.checked = siblings.length > 1;
  const onlyField = el('label', 'field check'); onlyField.append(only, el('span', null, 'only in ' + style.id));
  const row1 = el('div', 'row'); row1.append(field('id', id), field('category', category));
  const row2 = el('div', 'row'); row2.append(field('width', width), field('height', height));
  form.append(row1, field('prompt', prompt), row2);
  if (siblings.length > 1) form.append(onlyField);
  const actions = el('div', 'actions');
  const save = el('button', 'primary', 'Add asset'); save.type = 'submit';
  const cancel = el('button', null, 'Cancel'); cancel.type = 'button'; cancel.onclick = () => { ui.editing = null; render(); };
  const msg = el('span', 'msg');
  actions.append(save, cancel, msg);
  form.append(actions);
  form.onsubmit = async (e) => {
    e.preventDefault();
    save.disabled = true; msg.className = 'msg'; msg.textContent = 'saving…';
    const asset: any = { prompt: prompt.value };
    if (numberOrNull(width) !== null) asset.width = numberOrNull(width);
    if (numberOrNull(height) !== null) asset.height = numberOrNull(height);
    if (category.value.trim()) asset.category = category.value.trim();
    if (siblings.length > 1 && only.checked) asset.styles = [style.id];
    try {
      const body: any = { action: 'add-asset', assetId: id.value.trim(), expectedSha256: pr!.manifestSha256, asset };
      if (style.project) body.project = style.project;
      await addAssetAndOpen(body, { project: style.project, styleId: style.id }, 'Added to the manifest.');
    } catch (err) {
      showSaveError(msg, save, err);
    }
  };
  setTimeout(() => id.focus(), 0);
  return form;
}

/**
 * Revision modes a form can create for `item`, with what each needs. The
 * whole-set modes (`edit-animation`, and `reduce-colors` and `correct-pixelart`
 * over every frame at once) read a frame set; the rest read one image.
 * `inpaint` needs a mask upload and `interpolate` an ending keyframe, which
 * the gallery does not offer, and `animate-skeleton` has its own form. Only
 * PixelLab implements the non-text modes, so other providers keep to
 * `image-to-image`.
 */
export function revisionModesFor(item) {
  const single = item.outputs.length === 1;
  const sized = (min, max) => item.width >= min && item.height >= min && item.width <= max && item.height <= max;
  if (item.provider === 'comfyui') {
    return [['image-to-image', 'edit with a text instruction'], ...(single ? [['inpaint', 'repaint a painted area']] : [])];
  }
  if (item.provider !== 'pixellab') return [['image-to-image', 'edit with a text instruction']];
  if (!single) {
    return [
      ['edit-animation', 'one text edit across every frame'],
      ['reduce-colors', 'fewer colours, across every frame'],
      ['correct-pixelart', 'clean up the pixel grid, across every frame'],
    ];
  }
  return [
    ['image-to-image', 'edit with a text instruction'],
    ...(sized(32, 512) ? [['inpaint', 'repaint a painted area, keep the rest']] : []),
    ['animate', 'animate it from a text description'],
    ['animate-pixminimax', 'animate it, holding the facing direction'],
    ...(sized(16, 128) && endingKeyframes(item).length ? [['interpolate', 'in-betweens toward another sprite']] : []),
    ['reduce-colors', 'fewer colours, optional dithering'],
    ['correct-pixelart', 'clean up the pixel grid'],
    ['remove-background', 'cut the background out to transparency'],
  ];
}

/** Other single-image records in `item`'s style and size, which can end an interpolation. */
export function endingKeyframes(item) {
  return S.snap.items.filter((other) => other.id !== item.id && other.project === item.project && other.styleId === item.styleId &&
    other.outputs.length === 1 && other.outputs[0].exists && other.width === item.width && other.height === item.height);
}

/**
 * A new revision of `item`, restricted to `item`'s own style (a revision's
 * `from` resolves per style, and this button starts from one specific
 * generation). The mode picker offers what the record's provider and shape
 * allow; the server checks the choice again through the real manifest loader.
 */
export function newRevisionForm(item) {
  const pr = projectOf(item);
  const form = el('form', 'edit');
  form.append(el('h3', null, 'New revision of ' + item.assetId));
  const id = el('input'); id.type = 'text'; id.placeholder = 'asset-id'; id.required = true; id.autocomplete = 'off';
  id.pattern = '[^\\/\\\\]+';
  const modes = revisionModesFor(item);
  const mode = el('select');
  for (const [value, label] of modes) mode.append(new Option(value + ': ' + label, value));
  const prompt = el('textarea');
  const strength = el('input'); strength.type = 'number'; strength.min = '0'; strength.max = '1'; strength.step = '0.05'; strength.placeholder = 'provider default';
  const frames = el('input'); frames.type = 'number'; frames.min = '4'; frames.max = '40'; frames.step = '2'; frames.placeholder = 'provider default';
  const fps = el('input'); fps.type = 'number'; fps.min = '1'; fps.max = '60'; fps.step = '1'; fps.placeholder = 'playback rate';
  const enhance = el('input'); enhance.type = 'checkbox';
  const enhanceField = el('label', 'field check'); enhanceField.append(enhance, el('span', null, 'let PixelLab expand the motion description first'));
  const direction = el('select');
  for (const d of ['south', 'south-east', 'east', 'north-east', 'north', 'north-west', 'west', 'south-west']) direction.append(new Option(d, d));
  const numColors = el('input'); numColors.type = 'number'; numColors.min = '2'; numColors.max = '256'; numColors.step = '1'; numColors.placeholder = 'PixelLab default';
  const dithering = el('select');
  for (const d of ['', 'none', '2x2', '4x4', '8x8']) dithering.append(new Option(d || 'default', d));
  const removal = el('select');
  removal.append(new Option('simple: faster, flat backgrounds', 'simple'), new Option('complex: slower, detailed edges', 'complex'));
  const subject = el('input'); subject.type = 'text'; subject.placeholder = 'optional: e.g. a knight holding a sword';
  const ending = el('select');
  for (const other of endingKeyframes(item)) ending.append(new Option(other.assetId, other.outputs[0].path));
  const endingField = field('ending keyframe', ending, 'Another sprite of the same style and size; the parent is the start. Regenerating that sprite makes this stale.');
  const maskPath = el('input'); maskPath.type = 'text';
  let maskTouched = false;
  maskPath.oninput = () => { maskTouched = true; };
  id.oninput = () => { if (!maskTouched) maskPath.value = id.value.trim() ? 'masks/' + id.value.trim() + '.png' : ''; };
  const maskOverwrite = el('input'); maskOverwrite.type = 'checkbox';
  const maskOverwriteField = el('label', 'field check'); maskOverwriteField.append(maskOverwrite, el('span', null, 'replace the mask file if it exists'));
  const masker = maskEditor(displayUrl(item), () => {});
  const maskBox = el('div');
  maskBox.append(masker.root, field('mask file', maskPath, 'Inside the project. A black and white PNG the size of the sprite; white is repainted.'), maskOverwriteField);
  const row1 = el('div', 'row');
  row1.append(field('new asset id', id), field('mode', mode));
  const promptField = field('instruction', prompt);
  const strengthField = field('strength', strength, 'PixelLab rejects an explicit strength for image-to-image; leave this blank there. Optional for correct-pixelart.');
  const framesField = field('frames', frames, 'Even, 4 to 40; animate allows up to 16.');
  const fpsField = field('fps', fps, 'Recorded with the frames; PixelLab does not store one.');
  const directionField = field('facing', direction, 'Holds the sprite\'s facing while the motion is expanded.');
  const colorsField = field('colours', numColors);
  const ditherField = field('dithering', dithering);
  const removalField = field('removal', removal, 'PixelLab takes at most 400 by 400 pixels.');
  const subjectField = field('foreground', subject, 'A hint that helps PixelLab find what to keep.');
  const grids = el('div', 'row'); grids.append(framesField, fpsField);
  const cleanup = el('div', 'row'); cleanup.append(colorsField, ditherField);
  form.append(row1, promptField, maskBox, endingField, strengthField, grids, directionField, enhanceField, cleanup, removalField, subjectField);
  const hints = {
    'image-to-image': ['edit instruction', 'add snow on the roof', 'The style still adds its prefix and suffix.'],
    animate: ['motion', 'the chest wobbling gently', 'Describes the movement; the parent image is the first frame.'],
    'animate-pixminimax': ['motion', 'the chest wobbling gently', 'Describes the movement; the parent image is the first frame.'],
    inpaint: ['paint in', 'a glowing runestone', 'What fills the painted area; the rest of the sprite is kept.'],
    interpolate: ['motion', 'the door swinging open', 'Describes the movement between the two sprites.'],
    'edit-animation': ['edit instruction', 'add a red cape', 'Applied across every frame in one call, so the change stays consistent.'],
    'reduce-colors': ['note', 'optional', 'Cleanup only: the text is kept as a label, not sent.'],
    'correct-pixelart': ['note', 'optional', 'Cleanup only: the text is kept as a label, not sent.'],
    'remove-background': ['note', 'optional', 'Cleanup only: the text is kept as a label, not sent.'],
  };
  const sync = () => {
    const m = mode.value;
    const [label, placeholder, hint] = hints[m];
    promptField.querySelector('span')!.textContent = label;
    promptField.querySelector('small')?.remove();
    promptField.append(el('small', null, hint));
    prompt.placeholder = placeholder;
    prompt.required = !['reduce-colors', 'correct-pixelart', 'remove-background'].includes(m);
    strengthField.hidden = m !== 'image-to-image' && m !== 'correct-pixelart';
    grids.hidden = !(m === 'animate' || m === 'animate-pixminimax' || m === 'edit-animation' || m === 'interpolate');
    maskBox.hidden = m !== 'inpaint';
    endingField.hidden = m !== 'interpolate';
    framesField.hidden = !(m === 'animate' || m === 'animate-pixminimax');
    fpsField.hidden = grids.hidden;
    directionField.hidden = !(m === 'animate-pixminimax' && enhance.checked);
    enhanceField.hidden = !(m === 'animate' || m === 'animate-pixminimax');
    cleanup.hidden = m !== 'reduce-colors';
    removalField.hidden = subjectField.hidden = m !== 'remove-background';
  };
  mode.onchange = sync;
  enhance.onchange = sync;
  sync();
  const actions = el('div', 'actions');
  const save = el('button', 'primary', 'Create revision'); save.type = 'submit';
  const cancel = el('button', null, 'Cancel'); cancel.type = 'button'; cancel.onclick = () => { ui.editing = null; renderDrawer(); };
  const msg = el('span', 'msg');
  actions.append(save, cancel, msg);
  form.append(actions);
  form.onsubmit = async (e) => {
    e.preventDefault();
    save.disabled = true; msg.className = 'msg'; msg.textContent = 'saving…';
    const m = mode.value;
    const revision: any = { mode: m, from: item.assetId };
    if ((m === 'image-to-image' || m === 'correct-pixelart') && strength.value.trim() !== '') revision.strength = Number(strength.value);
    if ((m === 'animate' || m === 'animate-pixminimax') && frames.value.trim() !== '') revision.frames = Number(frames.value);
    if ((m === 'animate' || m === 'animate-pixminimax' || m === 'edit-animation' || m === 'interpolate') && fps.value.trim() !== '') revision.fps = Number(fps.value);
    if ((m === 'animate' || m === 'animate-pixminimax') && enhance.checked) revision.enhancePrompt = true;
    if (m === 'animate-pixminimax' && enhance.checked) revision.direction = direction.value;
    if (m === 'reduce-colors') {
      if (numColors.value.trim() !== '') revision.numColors = Number(numColors.value);
      if (dithering.value) revision.dithering = dithering.value;
    }
    if (m === 'interpolate') revision.lastFrame = ending.value;
    if (m === 'remove-background') {
      revision.removalTask = removal.value;
      if (subject.value.trim()) revision.description = subject.value.trim();
    }
    // Cleanup modes never send the prompt, but an asset still needs one.
    const text = prompt.value.trim() || ({ 'reduce-colors': 'reduce colours', 'correct-pixelart': 'correct pixel art', 'remove-background': 'remove background' } as Record<string, string>)[m] || '';
    const asset = { prompt: text, styles: [item.styleId], revision };
    try {
      let body: any;
      let what = 'Added to the manifest.';
      if (m === 'inpaint') {
        const png = masker.png();
        if (!png || masker.empty()) throw new Error('Paint the area to repaint first.');
        body = {
          action: 'create-inpaint-revision', expectedSha256: pr!.manifestSha256, styleId: item.styleId, from: item.assetId,
          assetId: id.value.trim(), prompt: text, maskPath: maskPath.value.trim(), maskBase64: png.base64,
        };
        if (maskOverwrite.checked) body.overwrite = true;
        what = 'Added to the manifest with ' + body.maskPath + '.';
      } else {
        body = { action: 'add-asset', assetId: id.value.trim(), expectedSha256: pr!.manifestSha256, asset };
      }
      if (item.project) body.project = item.project;
      await addAssetAndOpen(body, { project: item.project, styleId: item.styleId }, what);
    } catch (err) {
      showSaveError(msg, save, err);
    }
  };
  setTimeout(() => id.focus(), 0);
  return form;
}
