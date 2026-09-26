import { addAssetAndOpen, showSaveError } from "./form-kit.ts"
import { S, el, field, fmtCost, numberInput, numberOrNull, postEdit, projectOf, ui } from "./core.ts"
import { render, renderDrawer } from "./drawer.ts"

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
 * A new `image-to-image` revision of `item`, restricted to `item`'s own
 * style (a revision's `from` resolves per style, and this button starts
 * from one specific generation). `inpaint` needs a mask upload the gallery
 * does not offer yet, so this form only ever creates `image-to-image`.
 */
export function newRevisionForm(item) {
  const pr = projectOf(item);
  const form = el('form', 'edit');
  form.append(el('h3', null, 'New revision of ' + item.assetId));
  const id = el('input'); id.type = 'text'; id.placeholder = 'asset-id'; id.required = true; id.autocomplete = 'off';
  id.pattern = '[^\\/\\\\]+';
  const prompt = el('textarea'); prompt.placeholder = 'Edit instruction, e.g. "add snow on the roof".'; prompt.required = true;
  const strength = el('input'); strength.type = 'number'; strength.min = '0'; strength.max = '1'; strength.step = '0.05'; strength.placeholder = 'provider default';
  const row1 = el('div', 'row');
  row1.append(field('new asset id', id), field('strength', strength, 'PixelLab rejects an explicit strength for image-to-image; leave this blank there.'));
  form.append(row1, field('edit instruction', prompt, 'The style still adds its prefix and suffix.'));
  const actions = el('div', 'actions');
  const save = el('button', 'primary', 'Create revision'); save.type = 'submit';
  const cancel = el('button', null, 'Cancel'); cancel.type = 'button'; cancel.onclick = () => { ui.editing = null; renderDrawer(); };
  const msg = el('span', 'msg');
  actions.append(save, cancel, msg);
  form.append(actions);
  form.onsubmit = async (e) => {
    e.preventDefault();
    save.disabled = true; msg.className = 'msg'; msg.textContent = 'saving…';
    const revision: any = { mode: 'image-to-image', from: item.assetId };
    if (strength.value.trim() !== '') revision.strength = Number(strength.value);
    const asset = { prompt: prompt.value, styles: [item.styleId], revision };
    try {
      const body: any = { action: 'add-asset', assetId: id.value.trim(), expectedSha256: pr!.manifestSha256, asset };
      if (item.project) body.project = item.project;
      await addAssetAndOpen(body, { project: item.project, styleId: item.styleId }, 'Added to the manifest.');
    } catch (err) {
      showSaveError(msg, save, err);
    }
  };
  setTimeout(() => id.focus(), 0);
  return form;
}
