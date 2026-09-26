import { $, el, field, fmtCost, postEdit, S, ui } from "./core.ts"
import { openItem, render } from "./drawer.ts"
import { nextStep, showSaveError } from "./form-kit.ts"
import { pollJobs, postGenerate, remainingBudget } from "./jobs.ts"

/**
 * The character studio: a new character (its style when it needs one, its
 * base, its loops, a portrait) drafted in one sheet, priced live as it is
 * drafted, and saved as one batch edit, so the manifest gains all of it or
 * none. With generation on, "Create & generate" hands every new key to one
 * job, which works in waves (the base first, then everything drawn from it)
 * under the session budget.
 *
 * Engine defaults follow PixelLab's own recommendations: v3 for bases (its
 * "recommended entry point"), skeleton-v3 for template loops.
 */

const ENGINES = [
  { id: 'v3', label: 'v3: PixelLab\'s recommended base engine (2 to 9 by size; 1 from a sprite)', min: 32, max: 256, directions: [8] },
  { id: 'pro-flash', label: 'pro-flash: the newest image model draws the south sprite (6 to 17 by size)', min: 16, max: 256, directions: [8] },
  { id: 'pro', label: 'pro: reference-based, 20 to 40 by size', min: 32, max: 168, directions: [8] },
  { id: 'standard', label: 'standard: skeleton template, 1 generation', min: 16, max: 256, directions: [8, 4] },
];
const BODIES = ['mannequin', 'bear', 'cat', 'dog', 'horse', 'lion'];
const VIEWS = ['low top-down', 'high top-down', 'side'];
const COMPASS = ['south', 'south-east', 'east', 'north-east', 'north', 'north-west', 'west', 'south-west'];
const FOUR = ['south', 'east', 'north', 'west'];
const PORTRAIT_SIZES = [16, 32, 48, 64, 128, 160];
const LOOP_MODES = [
  { id: 'skeleton-v3', label: 'skeleton-v3: a template, posed by the skeleton model (steadiest; 2-4 per direction)' },
  { id: 'template', label: 'template: a template, redrawn (1 per direction)' },
  { id: 'v3', label: 'v3: described in words' },
  { id: 'pro', label: 'pro: described in words, sequential (20-40 per direction)' },
];
const templated = (mode: string) => mode === 'skeleton-v3' || mode === 'template';
const idPattern = '[^\\/\\\\:]+';

interface LoopRow { id: HTMLInputElement; mode: HTMLSelectElement; what: HTMLInputElement; directions: Map<string, HTMLInputElement>; wrap: HTMLElement }

export function openStudio() {
  const host = $('dialog-host');
  host.textContent = '';
  const projects = S.snap.workspace
    ? S.snap.workspace.projects.filter((pr) => pr.manifestSha256)
    : S.snap.project && S.snap.project.manifestSha256 ? [S.snap.project] : [];
  if (!projects.length) return;
  const workspace = Boolean(S.snap.workspace);

  let priceTimer: ReturnType<typeof setTimeout> | null = null;
  let priceSeq = 0;
  const scrim = el('div', 'sheet-scrim');
  const panel = el('div', 'sheet studio');
  let closed = false;
  const close = () => { closed = true; if (priceTimer) clearTimeout(priceTimer); priceSeq++; host.textContent = ''; };
  const bar = el('div', 'rbar');
  const back = el('button', null, 'Back to gallery'); back.type = 'button'; back.onclick = close;
  bar.append(back, el('span', null, 'A new character, priced as you draft it. Nothing is written until you create it.'));
  scrim.onclick = close;
  const form = el('form', 'edit studio-form');
  panel.append(bar, form);
  host.append(scrim, panel);

  // ---- where it goes ------------------------------------------------------
  const project = el('select');
  for (const pr of projects) project.append(new Option(pr.name, pr.id));
  const style = el('select');
  const styleId = el('input'); styleId.type = 'text'; styleId.value = 'characters'; styleId.pattern = idPattern;
  const engine = el('select');
  for (const e of ENGINES) engine.append(new Option(e.label, e.id));
  const size = el('input'); size.type = 'number'; size.value = '64'; size.step = '1';
  const directions = el('select');
  const body = el('select');
  const view = el('select');
  for (const v of VIEWS) view.append(new Option(v, v));
  const outDir = el('input'); outDir.type = 'text';
  let outDirTouched = false;
  outDir.oninput = () => { outDirTouched = true; };

  const styleSection = el('section', 'studio-part');
  styleSection.append(el('h3', null, 'Style'));
  const styleRow = el('div', 'row');
  if (workspace) styleRow.append(field('project', project));
  styleRow.append(field('style', style, 'A character style sets the engine, size, and directions every base in it shares.'));
  const newStyle = el('div', 'studio-new-style');
  const newRow1 = el('div', 'row');
  newRow1.append(field('new style id', styleId), field('size (px)', size), field('directions', directions));
  const newRow2 = el('div', 'row');
  newRow2.append(field('body', body, 'The skeleton template loops move: a biped, or a quadruped.'), field('view', view), field('art folder', outDir));
  newStyle.append(field('engine', engine), newRow1, newRow2);
  styleSection.append(styleRow, newStyle);

  // ---- the base -----------------------------------------------------------
  const baseId = el('input'); baseId.type = 'text'; baseId.required = true; baseId.placeholder = 'e.g. mira'; baseId.pattern = idPattern;
  const prompt = el('textarea'); prompt.required = true; prompt.placeholder = 'Who they are: "a young knight in dented silver armour, red scarf".';
  const refInput = el('input'); refInput.type = 'file'; refInput.accept = 'image/png,image/jpeg';
  const refPreview = el('img', 'studio-ref'); refPreview.hidden = true; refPreview.alt = 'reference sprite';
  let reference: string | null = null;
  const baseSection = el('section', 'studio-part');
  baseSection.append(el('h3', null, 'Character'));
  const baseRow = el('div', 'row');
  baseRow.append(field('asset id', baseId));
  const refField = field('own sprite (optional)', refInput, 'A south-facing sprite at the style\'s size: PixelLab rotates it instead of drawing one, and only the rotations are billed.');
  refField.append(refPreview);
  baseSection.append(baseRow, field('description', prompt), refField);

  // ---- loops --------------------------------------------------------------
  const loops: LoopRow[] = [];
  const loopsSection = el('section', 'studio-part');
  const loopList = el('div', 'studio-loops');
  const addLoop = el('button', 'add', '+ Add a loop'); addLoop.type = 'button';
  loopsSection.append(el('h3', null, 'Loops'), el('small', 'state-dim', 'Each loop is drawn once per ticked direction; a direction whose mirror is ticked is flipped from it for free.'), loopList, addLoop);

  // ---- portrait -----------------------------------------------------------
  const portrait = el('input'); portrait.type = 'checkbox';
  const portraitSize = el('select');
  for (const s of PORTRAIT_SIZES) portraitSize.append(new Option(s + ' px', String(s)));
  portraitSize.value = '64';
  const portraitSection = el('section', 'studio-part');
  const portraitCheck = el('label', 'field check'); portraitCheck.append(portrait, el('span', null, 'add a bust portrait (20 to 40 generations)'));
  portraitSection.append(el('h3', null, 'Portrait'), portraitCheck, field('portrait size', portraitSize));

  // ---- price and actions --------------------------------------------------
  const priceBox = el('section', 'studio-part studio-price');
  const actions = el('div', 'actions');
  const create = el('button', null, 'Create'); create.type = 'submit';
  const createGen = el('button', 'primary', 'Create & generate'); createGen.type = 'button';
  const msg = el('span', 'msg');
  actions.append(create);
  if (GENERATION) actions.append(createGen);
  actions.append(msg);
  form.append(styleSection, baseSection, loopsSection, portraitSection, priceBox, actions);

  // Read from the live snapshot: an upload or another tab's save moves the manifest hash on.
  const currentProject = () => {
    const live = S.snap.workspace ? S.snap.workspace.projects : S.snap.project ? [S.snap.project] : [];
    return live.find((pr) => pr.id === project.value) || live.find((pr) => pr.manifestSha256) || projects[0]!;
  };
  const projectId = () => (workspace ? project.value : null);
  const characterStyles = () => S.snap.styles.filter((s) => s.generator === 'character' && s.project === projectId());
  const chosenEngine = () => ENGINES.find((e) => e.id === engine.value)!;
  const isNewStyle = () => style.value === '';
  const styleDirections = () => {
    if (isNewStyle()) return Number(directions.value) === 4 ? FOUR : COMPASS;
    return COMPASS;
  };

  function fillStyles() {
    const keep = style.value;
    style.textContent = '';
    for (const s of characterStyles()) style.append(new Option(s.id + ' (' + s.outDir + ')', s.id));
    style.append(new Option('a new character style…', ''));
    style.value = [...style.options].some((o) => o.value === keep) ? keep : style.options[0]!.value;
  }
  function syncEngine() {
    const e = chosenEngine();
    size.min = String(e.min); size.max = String(e.max);
    const keep = directions.value;
    directions.textContent = '';
    for (const d of e.directions) directions.append(new Option(d + ' directions', String(d)));
    directions.value = e.directions.map(String).includes(keep) ? keep : String(e.directions[0]);
    const bodies = e.id === 'pro-flash' ? [...BODIES, 'custom'] : BODIES;
    const keepBody = body.value;
    body.textContent = '';
    for (const b of bodies) body.append(new Option(b, b));
    body.value = bodies.includes(keepBody) ? keepBody : 'mannequin';
  }
  function syncStyle() {
    newStyle.hidden = !isNewStyle();
    styleId.required = isNewStyle();
    if (!outDirTouched) outDir.value = 'art/' + (styleId.value.trim() || 'characters');
    for (const row of loops) syncLoopDirections(row);
  }

  function syncLoopDirections(row: LoopRow) {
    const allowed = styleDirections();
    for (const [d, box] of row.directions) {
      const wrap = box.parentElement!;
      wrap.hidden = !allowed.includes(d);
      if (wrap.hidden) box.checked = false;
    }
  }
  function syncLoopMode(row: LoopRow) {
    const t = templated(row.mode.value);
    row.what.placeholder = t ? 'template, e.g. walk, breathing-idle, running-8-frames' : 'the motion, e.g. "swings a sword overhead"';
    row.what.title = t ? 'A PixelLab template id' : 'What the loop does';
  }
  function addLoopRow(defaults: { id?: string; mode?: string; what?: string; directions?: string[] } = {}) {
    const wrap = el('div', 'studio-loop');
    const id = el('input'); id.type = 'text'; id.placeholder = 'walk'; id.required = true; id.pattern = idPattern; id.value = defaults.id ?? '';
    const mode = el('select');
    for (const m of LOOP_MODES) mode.append(new Option(m.label, m.id));
    mode.value = defaults.mode ?? 'skeleton-v3';
    const what = el('input'); what.type = 'text'; what.required = true; what.value = defaults.what ?? '';
    const dirs = el('div', 'studio-dirs');
    const boxes = new Map<string, HTMLInputElement>();
    for (const d of COMPASS) {
      const box = el('input'); box.type = 'checkbox'; box.checked = (defaults.directions ?? ['south', 'west', 'north']).includes(d);
      const label = el('label', 'field check'); label.append(box, el('span', null, d));
      boxes.set(d, box);
      dirs.append(label);
    }
    const remove = el('button', null, 'Remove'); remove.type = 'button';
    const row: LoopRow = { id, mode, what, directions: boxes, wrap };
    remove.onclick = () => { loops.splice(loops.indexOf(row), 1); wrap.remove(); schedulePrice(); };
    mode.onchange = () => { syncLoopMode(row); schedulePrice(); };
    const line = el('div', 'row');
    line.append(field('loop id', id), field('mode', mode), field('template or motion', what));
    wrap.append(line, dirs, remove);
    loopList.append(wrap);
    loops.push(row);
    syncLoopMode(row);
    syncLoopDirections(row);
  }

  // ---- the batch ----------------------------------------------------------
  function edits(): any[] {
    const out: any[] = [];
    const sid = isNewStyle() ? styleId.value.trim() : style.value;
    if (isNewStyle()) {
      const e = chosenEngine();
      out.push({
        action: 'add-style', styleId: sid,
        style: { generator: 'character', outDir: outDir.value.trim(), size: Number(size.value), mode: e.id, directions: Number(directions.value), template: body.value, view: view.value },
      });
    }
    const base = baseId.value.trim();
    out.push({ action: 'add-asset', assetId: base, asset: { prompt: prompt.value.trim(), styles: [sid], ...(reference ? { reference } : {}) } });
    for (const row of loops) {
      const chosen = [...row.directions].filter(([, box]) => box.checked).map(([d]) => d);
      if (!row.id.value.trim() || !chosen.length) continue;
      const animation: any = { of: base, directions: chosen };
      const asset: any = { styles: [sid], animation };
      if (templated(row.mode.value)) {
        animation.template = row.what.value.trim();
        if (row.mode.value === 'skeleton-v3') animation.mode = 'skeleton-v3';
      } else {
        animation.mode = row.mode.value;
        asset.prompt = row.what.value.trim();
      }
      out.push({ action: 'add-asset', assetId: base + '.' + row.id.value.trim(), asset });
    }
    if (portrait.checked) out.push({ action: 'add-asset', assetId: base + '.portrait', asset: { styles: [sid], portrait: { of: base, size: Number(portraitSize.value) } } });
    return out;
  }
  const request = () => {
    const body: any = { action: 'batch', expectedSha256: currentProject().manifestSha256, edits: edits() };
    if (projectId()) body.project = projectId();
    return body;
  };
  const ours = (key: string) => {
    const base = baseId.value.trim();
    const assetId = key.slice(key.indexOf('/') + 1);
    return assetId === base || assetId.startsWith(base + '.');
  };

  // ---- live price ---------------------------------------------------------
  let price: any = null;
  function schedulePrice() {
    if (closed) return;
    if (priceTimer) clearTimeout(priceTimer);
    priceTimer = setTimeout(updatePrice, 350);
  }
  async function updatePrice() {
    const seq = ++priceSeq;
    priceBox.textContent = '';
    priceBox.append(el('h3', null, 'Estimated cost'));
    if (!baseId.value.trim() || !prompt.value.trim() || (isNewStyle() && !styleId.value.trim())) {
      price = null;
      priceBox.append(el('div', 'state-dim', 'Name the character and describe it to see what it costs.'));
      syncButtons();
      return;
    }
    const status = el('div', 'state-dim', 'pricing…');
    priceBox.append(status);
    try {
      const res = await fetch('/api/price', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Pixelkiln-Session': SESSION ?? '' },
        body: JSON.stringify(request()),
      });
      if (seq !== priceSeq) return;
      if (!res.ok) throw new Error(await res.text());
      price = await res.json();
      status.remove();
      renderPrice();
    } catch (err) {
      if (seq !== priceSeq) return;
      price = null;
      status.className = 'msg bad';
      status.textContent = err.message;
    }
    syncButtons();
  }
  function renderPrice() {
    const mine = price.items.filter((i) => ours(i.key));
    const stray = price.items.filter((i) => !ours(i.key));
    const table = el('div', 'studio-price-rows');
    for (const i of mine) {
      const row = el('div');
      const cost = el('span', null, i.cost ? fmtCost(i.costUnit, i.cost) : i.quote === 'live' ? 'free' : 'free (mirrored)');
      if (i.quote === 'live') {
        const tag = el('span', 'quote-live', 'live');
        tag.title = 'PixelLab\'s own Pro Flash quote; the offline estimate was ' + fmtCost(i.costUnit, i.estimate);
        cost.append(' ', tag);
      }
      row.append(el('span', 'mono', i.key), cost);
      table.append(row);
    }
    priceBox.append(table);
    if (mine.some((i) => i.quote === 'live')) {
      priceBox.append(el('small', 'state-dim', 'Rows marked live are PixelLab\'s current Pro Flash quote, which it calls provisional; the lock records what the finished job billed.'));
    } else if (price.quoteError) {
      priceBox.append(el('small', 'state-dim', 'Pro Flash is priced offline: PixelLab\'s quote could not be had (' + price.quoteError + ').'));
    }
    const totals: Record<string, number> = {};
    for (const i of mine) totals[i.costUnit] = (totals[i.costUnit] || 0) + i.cost;
    priceBox.append(el('div', 'studio-total', 'Total: ' + (Object.entries(totals).map(([u, n]) => fmtCost(u, n)).join(' + ') || 'free')));
    if (stray.length) {
      priceBox.append(el('div', 'state-warn', 'A new style also takes in every existing asset that names no styles, so ' + stray.length + ' more would be drawn in it: ' +
        stray.slice(0, 6).map((i) => i.assetId).join(', ') + (stray.length > 6 ? ', …' : '') + '. Give those assets a styles list first, or use an existing style.'));
    }
  }
  function mineTotal(): { provider: string | null; unit: string | null; amount: number } {
    const mine = price ? price.items.filter((i) => ours(i.key)) : [];
    return { provider: mine[0]?.provider ?? null, unit: mine[0]?.costUnit ?? null, amount: mine.reduce((n, i) => n + i.cost, 0) };
  }
  function syncButtons() {
    const t = mineTotal();
    create.disabled = !price;
    if (!GENERATION) return;
    const left = t.provider ? remainingBudget(t.provider) : null;
    const over = left !== null && t.amount > left;
    createGen.disabled = !price || over;
    createGen.textContent = 'Create & generate' + (price && t.unit ? ' · ' + fmtCost(t.unit, t.amount) : '');
    createGen.title = over ? 'More than the ' + fmtCost(t.unit!, left!) + ' left in this session\'s budget' : '';
  }

  // ---- saving -------------------------------------------------------------
  async function save(generate: boolean) {
    if (priceTimer) clearTimeout(priceTimer);
    priceSeq++;
    create.disabled = true; createGen.disabled = true;
    msg.className = 'msg'; msg.textContent = 'saving…';
    const pid = projectId();
    const base = baseId.value.trim();
    const sid = isNewStyle() ? styleId.value.trim() : style.value;
    const keys = price ? price.items.filter((i) => ours(i.key)).map((i) => i.key) : [];
    try {
      S.snap = await postEdit(request());
      const newId = (pid ? pid + ':' : '') + sid + '/' + base;
      if (generate && keys.length) {
        await postGenerate({ keys, ...(pid ? { project: pid } : {}) });
        ui.notice = { id: newId, text: 'Created, and generating ' + keys.length + ' asset(s): the base first, then everything drawn from it, as each lands.' };
        pollJobs();
      } else {
        ui.notice = { id: newId, text: 'Created ' + base + ' with ' + (keys.length - 1) + ' more asset(s). ' + nextStep() };
      }
      close();
      render();
      if (S.snap.items.some((i) => i.id === newId)) openItem(newId);
    } catch (err) {
      showSaveError(msg, create, err);
      syncButtons();
    }
  }
  form.onsubmit = (e) => { e.preventDefault(); void save(false); };
  createGen.onclick = () => { if (form.reportValidity()) void save(true); };

  // ---- the reference sprite ---------------------------------------------
  refInput.onchange = async () => {
    const file = refInput.files && refInput.files[0];
    reference = null; refPreview.hidden = true;
    if (!file) { schedulePrice(); return; }
    if (!baseId.value.trim()) { msg.className = 'msg bad'; msg.textContent = 'Name the character first; the sprite is saved as refs/<id>.'; refInput.value = ''; return; }
    const ext = file.type === 'image/jpeg' ? '.jpg' : '.png';
    const path = 'refs/' + baseId.value.trim() + ext;
    const base64 = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result).split(',')[1] || '');
      reader.onerror = () => reject(reader.error);
      reader.readAsDataURL(file);
    });
    const upload = async (overwrite: boolean) => postEdit({ action: 'upload-image', path, base64, ...(overwrite ? { overwrite: true } : {}), ...(projectId() ? { project: projectId() } : {}) });
    try {
      try { S.snap = await upload(false); } catch (err) {
        if (!/already exists/.test(err.message) || !confirm(path + ' already exists. Replace it?')) throw err;
        S.snap = await upload(true);
      }
      reference = path;
      refPreview.src = URL.createObjectURL(file); refPreview.hidden = false;
      msg.className = 'msg'; msg.textContent = 'Sprite saved as ' + path + '.';
    } catch (err) {
      msg.className = 'msg bad'; msg.textContent = err.message; refInput.value = '';
    }
    schedulePrice();
  };

  // ---- wiring -------------------------------------------------------------
  project.onchange = () => { fillStyles(); syncStyle(); schedulePrice(); };
  style.onchange = () => { syncStyle(); schedulePrice(); };
  engine.onchange = () => { syncEngine(); syncStyle(); schedulePrice(); };
  styleId.oninput = () => { syncStyle(); schedulePrice(); };
  directions.onchange = () => { syncStyle(); schedulePrice(); };
  addLoop.onclick = () => { addLoopRow({}); schedulePrice(); };
  form.addEventListener('input', schedulePrice);
  form.addEventListener('change', schedulePrice);

  fillStyles();
  syncEngine();
  syncStyle();
  addLoopRow({ id: 'walk', mode: 'skeleton-v3', what: 'walk', directions: ['south', 'west', 'north'] });
  addLoopRow({ id: 'idle', mode: 'skeleton-v3', what: 'breathing-idle', directions: ['south'] });
  updatePrice();
  setTimeout(() => baseId.focus(), 0);
}
