import { S, el, field, fmtCost, numberInput, numberOrNull, postEdit, projectOf, splitTags, ui } from "./core.ts"
import { openItem, render, renderDrawer } from "./drawer.ts"

/**
 * A new pose or outfit of `item`, an existing `character`/`objectPro` base
 * or state — the same family, restricted to `item`'s own style. A larger
 * canvas needs both width and height; leaving either blank keeps the
 * parent's.
 */
export function newStateForm(item) {
  const pr = projectOf(item);
  const form = el('form', 'edit');
  form.append(el('h3', null, 'New state of ' + item.assetId));
  const id = el('input'); id.type = 'text'; id.placeholder = 'asset-id'; id.required = true; id.autocomplete = 'off';
  id.pattern = '[^\\/\\\\]+';
  const prompt = el('textarea'); prompt.placeholder = 'What changes, e.g. "the chest lid open".'; prompt.required = true;
  const paletteFromReference = el('input'); paletteFromReference.type = 'checkbox';
  const paletteField = el('label', 'field check'); paletteField.append(paletteFromReference, el('span', null, 'snap colours to the parent'));
  const width = numberInput(null, 'parent’s'), height = numberInput(null, 'parent’s');
  const row1 = el('div', 'row');
  row1.append(field('new asset id', id), field('canvas width', width), field('canvas height', height));
  form.append(row1, field('what changes', prompt, 'The style still adds its prefix and suffix.'), paletteField);
  const actions = el('div', 'actions');
  const save = el('button', 'primary', 'Create state'); save.type = 'submit';
  const cancel = el('button', null, 'Cancel'); cancel.type = 'button'; cancel.onclick = () => { ui.editing = null; renderDrawer(); };
  const msg = el('span', 'msg');
  actions.append(save, cancel, msg);
  form.append(actions);
  form.onsubmit = async (e) => {
    e.preventDefault();
    save.disabled = true; msg.className = 'msg'; msg.textContent = 'saving…';
    const state: any = { of: item.assetId };
    if (paletteFromReference.checked) state.paletteFromReference = true;
    const w = numberOrNull(width), h = numberOrNull(height);
    if (w !== null && h !== null) state.canvas = { width: w, height: h };
    const asset = { prompt: prompt.value, styles: [item.styleId], state };
    try {
      const body: any = { action: 'add-asset', assetId: id.value.trim(), expectedSha256: pr!.manifestSha256, asset };
      if (item.project) body.project = item.project;
      S.snap = await postEdit(body);
      const newId = (item.project ? item.project + ':' : '') + item.styleId + '/' + id.value.trim();
      ui.editing = null;
      ui.notice = { id: newId, text: 'Added to the manifest. Nothing is generated until you run pixelkiln gen.' };
      render();
      if (S.snap.items.some((i) => i.id === newId)) openItem(newId);
    } catch (err) {
      save.disabled = false;
      msg.className = 'msg bad';
      msg.textContent = err.message + (err.status === 409 ? ' Press Refresh.' : '');
    }
  };
  setTimeout(() => id.focus(), 0);
  return form;
}

/**
 * A new loop of `item`, an existing `character`/`objectPro` base or state.
 * `objectPro` has no skeleton/template concept, so `template` and `subject`
 * are only offered for a `character`; `startFrame`/`endFrame` and template
 * `outline`/`shading`/`detail` hints need a manifest-relative image the
 * gallery does not offer, so hand-edit the manifest for those.
 */
export function newAnimationForm(item) {
  const pr = projectOf(item);
  const c = item.character;
  const isCharacter = c.generator === 'character';
  const form = el('form', 'edit');
  form.append(el('h3', null, 'New animation of ' + item.assetId));
  const id = el('input'); id.type = 'text'; id.placeholder = 'asset-id'; id.required = true; id.autocomplete = 'off';
  id.pattern = '[^\\/\\\\]+';
  const prompt = el('textarea'); prompt.placeholder = 'What the loop does, e.g. "a slow idle sway".'; prompt.required = true;
  const mode = el('select');
  if (isCharacter) mode.append(new Option('template', 'template'));
  mode.append(new Option('v3 (text-described)', 'v3'), new Option('pro (sequential, high quality)', 'pro'));
  mode.value = 'v3';
  const template = el('input'); template.type = 'text'; template.placeholder = 'e.g. walk, breathing-idle';
  const templateField = field('template id', template, 'A PixelLab template; costs 1 generation regardless of frame count.');
  const frames = el('input'); frames.type = 'number'; frames.min = '4'; frames.max = '16'; frames.step = '2'; frames.placeholder = '8';
  const fps = el('input'); fps.type = 'number'; fps.min = '1'; fps.max = '60'; fps.placeholder = '8';
  const directionField = (() => {
    if (c.directions === 1) return null;
    const set = c.directions === 4 ? ['south', 'west', 'east', 'north'] : ['south', 'south-east', 'east', 'north-east', 'north', 'north-west', 'west', 'south-west'];
    const select = el('select');
    for (const d of set) select.append(new Option(d, d));
    return { select, wrap: field('direction', select) };
  })();
  const subject = isCharacter ? el('input') : null;
  if (subject) { subject.type = 'text'; subject.placeholder = 'optional, when the prompt alone would mislead the model'; }
  const row1 = el('div', 'row');
  row1.append(field('new asset id', id), field('mode', mode));
  if (directionField) row1.append(directionField.wrap);
  form.append(row1, field('what it does', prompt, 'The style still adds its prefix and suffix.'));
  if (isCharacter) form.append(templateField);
  const row2 = el('div', 'row'); row2.append(field('frames', frames), field('fps', fps));
  form.append(row2);
  if (subject) form.append(field('subject override', subject));
  const syncMode = () => {
    const isTemplate = isCharacter && mode.value === 'template';
    templateField.style.display = isTemplate ? '' : 'none';
    row2.style.display = isTemplate ? 'none' : '';
  };
  if (isCharacter) { mode.onchange = syncMode; syncMode(); } else { templateField.style.display = 'none'; }
  const actions = el('div', 'actions');
  const save = el('button', 'primary', 'Create animation'); save.type = 'submit';
  const cancel = el('button', null, 'Cancel'); cancel.type = 'button'; cancel.onclick = () => { ui.editing = null; renderDrawer(); };
  const msg = el('span', 'msg');
  actions.append(save, cancel, msg);
  form.append(actions);
  form.onsubmit = async (e) => {
    e.preventDefault();
    save.disabled = true; msg.className = 'msg'; msg.textContent = 'saving…';
    const animation: any = { of: item.assetId };
    if (directionField) animation.direction = directionField.select.value;
    if (isCharacter && mode.value === 'template' && template.value.trim()) {
      animation.template = template.value.trim();
    } else {
      animation.mode = mode.value;
      if (frames.value.trim() !== '') animation.frames = Number(frames.value);
      if (fps.value.trim() !== '') animation.fps = Number(fps.value);
    }
    if (subject && subject.value.trim()) animation.subject = subject.value.trim();
    const asset = { prompt: prompt.value, styles: [item.styleId], animation };
    try {
      const body: any = { action: 'add-asset', assetId: id.value.trim(), expectedSha256: pr!.manifestSha256, asset };
      if (item.project) body.project = item.project;
      S.snap = await postEdit(body);
      const newId = (item.project ? item.project + ':' : '') + item.styleId + '/' + id.value.trim();
      ui.editing = null;
      ui.notice = { id: newId, text: 'Added to the manifest. Nothing is generated until you run pixelkiln gen.' };
      render();
      if (S.snap.items.some((i) => i.id === newId)) openItem(newId);
    } catch (err) {
      save.disabled = false;
      msg.className = 'msg bad';
      msg.textContent = err.message + (err.status === 409 ? ' Press Refresh.' : '');
    }
  };
  setTimeout(() => id.focus(), 0);
  return form;
}

export function editForm(item) {
  const pr = projectOf(item);
  const a = item.asset;
  const styled = !!(a.promptByStyle && Object.hasOwn(a.promptByStyle, item.styleId));
  const form = el('form', 'edit');
  form.append(el('h3', null, 'Edit intent'));
  const scope = el('select');
  scope.append(new Option('Prompt for every style', 'all'), new Option('Prompt only for ' + item.styleId, 'style'));
  scope.value = styled ? 'style' : 'all';
  const prompt = el('textarea');
  prompt.value = styled ? a.promptByStyle[item.styleId] : a.prompt;
  scope.onchange = () => {
    prompt.value = scope.value === 'style' ? (a.promptByStyle?.[item.styleId] ?? a.prompt) : a.prompt;
  };
  const width = numberInput(a.width, 'style default'), height = numberInput(a.height, 'style default'), size = numberInput(a.size, 'style default');
  const category = el('input'); category.type = 'text'; category.value = a.category || '';
  const tags = el('input'); tags.type = 'text'; tags.value = (a.tags || []).join(', '); tags.placeholder = 'comma-separated';
  form.append(field('prompt', prompt, 'The style adds its prefix and suffix; the sent prompt is shown below.'), field('applies to', scope));
  const row = el('div', 'row'); row.append(field('width', width), field('height', height), field('size', size));
  form.append(row);
  const row2 = el('div', 'row');
  row2.append(field('category', category, 'Output subfolder. The existing file stays put; restore or gen writes the new path.'), field('tags', tags));
  form.append(row2);
  const actions = el('div', 'actions');
  const save = el('button', 'primary', 'Save to manifest'); save.type = 'submit';
  const cancel = el('button', null, 'Cancel'); cancel.type = 'button'; cancel.onclick = () => { ui.editing = null; renderDrawer(); };
  const msg = el('span', 'msg');
  actions.append(save, cancel, msg);
  form.append(actions);
  form.onsubmit = async (e) => {
    e.preventDefault();
    const patch: any = {};
    if (scope.value === 'style') {
      if (!styled || prompt.value !== a.promptByStyle[item.styleId]) patch.promptForStyle = { styleId: item.styleId, prompt: prompt.value };
    } else {
      if (prompt.value !== a.prompt) patch.prompt = prompt.value;
      if (styled) patch.promptForStyle = { styleId: item.styleId, prompt: null };
    }
    for (const [key, input] of [['width', width], ['height', height], ['size', size]] as const) {
      const next = numberOrNull(input);
      if (next !== (a[key] ?? null)) patch[key] = next;
    }
    const nextCategory = category.value.trim() || null;
    if (nextCategory !== (a.category || null)) patch.category = nextCategory;
    const nextTags = splitTags(tags.value);
    if (nextTags.join('\u0000') !== (a.tags || []).join('\u0000')) patch.tags = nextTags;
    if (!Object.keys(patch).length) { ui.editing = null; renderDrawer(); return; }
    save.disabled = true; msg.className = 'msg'; msg.textContent = 'saving…';
    try {
      const body: any = { action: 'patch-asset', assetId: item.assetId, expectedSha256: pr!.manifestSha256, patch };
      if (item.project) body.project = item.project;
      S.snap = await postEdit(body);
      const after = S.snap.items.find((i) => i.id === item.id);
      ui.editing = null;
      ui.notice = {
        id: item.id,
        text: after
          ? 'Saved. plan now reports ' + after.state +
            (after.estimatedCost !== null && (after.state === 'stale' || after.state === 'missing')
              ? ', ' + fmtCost(after.costUnit, after.estimatedCost) + ' to generate. Nothing is spent until you run pixelkiln gen.'
              : '.')
          : 'Saved.',
      };
      render();
    } catch (err) {
      save.disabled = false;
      msg.className = 'msg bad';
      msg.textContent = err.message + (err.status === 409 ? ' Press Refresh.' : '');
    }
  };
  setTimeout(() => prompt.focus(), 0);
  return form;
}
