import { renderTray, toggleCompare } from "./compare.ts"
import { $, S, STATE_TONE, backdropControl, displayScale, el, fmtBytes, fmtCost, fmtWhen, formRegion, isFrameSet, projectOf, savePrefs, ui } from "./core.ts"
import { editForm, newAnimationForm, newStateForm } from "./family-forms.ts"
import { familyMembers, familyRoot, openFamily, refreshFamily } from "./family.ts"
import { renderSelectionBar } from "./selection.ts"
import { newRevisionForm } from "./forms.ts"
import { generateActions, historySection, jobStrip, renderHeader, renderMain, upstreamSection, visibleItems } from "./grid.ts"
import { handEditSection } from "./hand-edit.ts"
import { activeJobFor, isRevisable } from "./jobs.ts"
import { displayUrl, poseStrip, skeletonAnimationForm, skeletonPoseForm } from "./skeleton.ts"

// ---- detail drawer -------------------------------------------------------

export function row(dl, label, value, opts: any = {}) {
  if (value === null || value === undefined || value === '') return;
  dl.append(el('dt', null, label));
  const dd = el('dd', opts.mono ? 'mono' : null);
  if (value instanceof Node) dd.append(value); else dd.textContent = String(value);
  if (opts.copy) {
    const b = el('button', 'copy', 'copy');
    b.type = 'button';
    b.onclick = async () => {
      try { await navigator.clipboard.writeText(String(opts.copy)); b.textContent = 'copied'; }
      catch { b.textContent = 'select to copy'; }
      setTimeout(() => (b.textContent = 'copy'), 1200);
    };
    dd.append(b);
  }
  dl.append(dd);
}
export function section(title) {
  const s = el('section', 'meta');
  s.append(el('h3', null, title));
  const dl = el('dl');
  s.append(dl);
  return { s, dl };
}
export function stateNode(state, reason) {
  const box = el('div', 'status');
  const st = el('span', 'st state-' + STATE_TONE[state]);
  st.append(el('i', 'dot ' + STATE_TONE[state]), document.createTextNode(state));
  box.append(st, el('span', 'why', reason));
  return box;
}
export function sibling(item, key) {
  return S.snap.items.find((i) => i.key === key && i.project === item.project);
}
export function keyLink(item, key, label?) {
  const b = el('button', 'linkish', label || key);
  b.type = 'button';
  const target = sibling(item, key);
  if (!target) { b.disabled = true; b.title = 'not in this snapshot'; }
  b.onclick = () => { if (target) openItem(target.id); };
  return b;
}
export function jsonDetails(title, value) {
  const d = el('details');
  d.append(el('summary', null, title), el('pre', null, JSON.stringify(value, null, 2)));
  return d;
}

export function stopPlayback() {
  if (ui.playing) { clearInterval(ui.playing); ui.playing = null; }
}

export function renderPreview(item, host) {
  host.textContent = '';
  stopPlayback();
  const shown = item.outputs.filter((o) => o.url);
  const preview = el('div', 'preview');
  if (!shown.length) {
    preview.append(el('div', 'none', item.outputs.length ? 'The recorded file is not on disk. pixelkiln restore re-downloads it without spending.' : 'No output to show.'));
    host.append(preview);
    return;
  }
  let idx = Math.min(ui.member, shown.length - 1);
  const frameSet = isFrameSet(item) && shown.length > 1;
  const w = item.width, h = item.height;
  const box = Math.min(window.innerWidth, 540) - 62;
  const auto = displayScale(w, h, box, Math.min(window.innerHeight * 0.55, 560));
  const zoom = ui.zoom === 'auto' ? auto : ui.zoom === 'fit' ? Math.min(auto, 1) : Number(ui.zoom);
  const sized = (img: HTMLImageElement) => {
    if (zoom >= 1) { img.width = Math.round(w * zoom); img.height = Math.round(h * zoom); }
    else { img.style.maxWidth = '100%'; img.style.maxHeight = '55vh'; img.style.width = 'auto'; img.style.height = 'auto'; }
    return img;
  };
  const stack = el('div', 'stack');
  const img = sized(el('img'));
  img.src = shown[idx].url; img.alt = shown[idx].role || item.assetId;
  // Onion skin: the frame before, faint, under the current one.
  const onion = sized(el('img', 'onion'));
  onion.alt = ''; onion.setAttribute('aria-hidden', 'true');
  onion.hidden = !(frameSet && ui.onion);
  stack.append(onion, img);
  preview.append(stack);

  const zoomBar = el('div', 'zoom');
  zoomBar.append(el('span', null, 'zoom'));
  for (const z of ['fit', 1, 2, 4, 8]) {
    const b = el('button', ui.zoom === String(z) || (ui.zoom === 'auto' && z === auto) ? 'on' : null, z === 'fit' ? 'fit' : z + '×');
    b.type = 'button';
    b.onclick = () => { ui.zoom = String(z); renderPreview(item, host); };
    zoomBar.append(b);
  }
  const label = el('span', 'grow', w + '×' + h + (zoom >= 1 ? ' at ' + zoom + '×' : ' fitted'));
  zoomBar.append(label, backdropControl());
  host.append(preview, zoomBar);

  let strip: HTMLElement | null = null;
  const show = (i: number) => {
    idx = (i + shown.length) % shown.length;
    ui.member = idx;
    img.src = shown[idx].url;
    img.alt = shown[idx].role || item.assetId;
    if (frameSet) {
      onion.src = shown[(idx - 1 + shown.length) % shown.length].url;
      scrub.value = String(idx);
      count.textContent = (idx + 1) + ' / ' + shown.length;
    }
    if (strip) for (const [j, b] of [...strip.querySelectorAll('button')].entries()) b.classList.toggle('on', j === idx);
  };

  // A frame set gets a player: step, scrub, speed, and onion skin.
  const scrub = el('input'); const count = el('span', 'count');
  if (frameSet) {
    const bar = el('div', 'frames-bar');
    const own = item.fps || 12;
    const fps = () => ui.fps || own;
    const prev = el('button', null, '◀'); prev.type = 'button'; prev.title = 'Previous frame (,)';
    const next = el('button', null, '▶'); next.type = 'button'; next.title = 'Next frame (.)';
    const play = el('button', 'play', 'Play'); play.type = 'button'; play.title = 'Play or pause (space)';
    const pause = () => { stopPlayback(); play.textContent = 'Play'; };
    const start = () => {
      stopPlayback();
      play.textContent = 'Pause';
      ui.playing = setInterval(() => { if (!document.hidden) show(idx + 1); }, Math.max(16, Math.round(1000 / fps())));
    };
    play.onclick = () => (ui.playing ? pause() : start());
    prev.onclick = () => { pause(); show(idx - 1); };
    next.onclick = () => { pause(); show(idx + 1); };
    scrub.type = 'range'; scrub.min = '0'; scrub.max = String(shown.length - 1); scrub.step = '1';
    scrub.setAttribute('aria-label', 'Frame');
    scrub.oninput = () => { pause(); show(Number(scrub.value)); };
    const speed = el('select');
    speed.setAttribute('aria-label', 'Frames per second');
    const rates = [...new Set([own, 4, 6, 8, 10, 12, 15, 24])].sort((a, b) => a - b);
    for (const r of rates) speed.append(new Option(r + ' fps' + (r === own ? ' (its own)' : ''), String(r)));
    speed.value = String(fps());
    speed.onchange = () => { ui.fps = Number(speed.value) === own ? null : Number(speed.value); if (ui.playing) start(); };
    const onionBox = el('label', 'chip');
    const onionToggle = el('input'); onionToggle.type = 'checkbox'; onionToggle.checked = ui.onion;
    onionToggle.onchange = () => { ui.onion = onionToggle.checked; onion.hidden = !ui.onion; savePrefs(); };
    onionBox.title = 'Show the previous frame faintly under this one';
    onionBox.append(onionToggle, document.createTextNode(' onion skin'));
    bar.append(prev, play, next, scrub, count, speed, onionBox);
    host.append(bar);
    (host as any).__frames = { step: (n: number) => { pause(); show(idx + n); }, toggle: () => play.click() };
  } else {
    (host as any).__frames = null;
  }

  if (shown.length > 1) {
    strip = el('div', 'members');
    shown.forEach((o, i) => {
      const b = el('button', i === idx ? 'on' : null);
      b.type = 'button';
      const t = el('img'); t.src = o.url; t.alt = o.role || 'output ' + (i + 1); t.loading = 'lazy';
      b.append(t, el('span', null, o.role || String(i + 1)));
      b.onclick = () => { if (frameSet) { stopPlayback(); } show(i); if (!frameSet) renderPreview(item, host); };
      strip!.append(b);
    });
    host.append(strip);
  }
  show(idx);
}

/** The open drawer's frame player, for the keyboard: `,` and `.` step, space plays. */
export function drawerFrames(): { step: (n: number) => void; toggle: () => void } | null {
  const host = document.querySelector('.drawer .dbody > div');
  return host ? (host as any).__frames ?? null : null;
}

/** How the drawer names each member of a character or object family. */
const CHARACTER_KIND = {
  base: 'base',
  state: 'state (a pose or outfit of its parent)',
  animation: 'animation',
  portrait: 'portrait (a bust of its parent)',
  outfit: 'outfit (its parent loop, re-clothed)',
};

export function renderDrawer() {
  const host = $('drawer-host');
  host.textContent = '';
  stopPlayback();
  const item = ui.open && S.snap.items.find((i) => i.id === ui.open);
  if (!item) { ui.open = null; return; }
  const items = visibleItems();
  const pos = items.findIndex((i) => i.id === item.id);

  const scrim = el('div', 'scrim');
  scrim.onclick = () => closeItem();
  const drawer = el('aside', 'drawer');
  drawer.setAttribute('role', 'dialog');
  drawer.setAttribute('aria-label', item.id);

  const head = el('div', 'dhead');
  const title = el('div', 'title');
  if (item.project) title.append(el('span', 'sid project', item.project), ' ');
  title.append(el('span', 'sid', item.styleId), el('div', 'aid', item.assetId));
  const nav = el('div', 'nav');
  const prev = el('button', null, '←'); prev.type = 'button'; prev.title = 'Previous (←)';
  prev.disabled = pos <= 0; prev.onclick = () => step(-1);
  const next = el('button', null, '→'); next.type = 'button'; next.title = 'Next (→)';
  next.disabled = pos < 0 || pos >= items.length - 1; next.onclick = () => step(1);
  const close = el('button', null, 'Close'); close.type = 'button'; close.onclick = () => closeItem();
  const cmp = el('button', null, ui.compare.includes(item.id) ? 'Remove from compare' : 'Compare +');
  cmp.type = 'button'; cmp.onclick = () => toggleCompare(item.id);
  nav.append(cmp);
  const canEdit = EDITABLE && item.declared && item.asset && projectOf(item)?.manifestSha256;
  if (canEdit) {
    const edit = el('button', null, ui.editing === item.id ? 'Cancel edit' : 'Edit');
    edit.type = 'button';
    edit.onclick = () => { ui.editing = ui.editing === item.id ? null : item.id; ui.notice = null; renderDrawer(); };
    nav.append(edit);
  }
  nav.append(prev, next, close);
  head.append(title, nav);

  const body = el('div', 'dbody');
  const previewHost = el('div');
  renderPreview(item, previewHost);
  body.append(previewHost);
  if (ui.notice && ui.notice.id === item.id) body.append(el('div', 'notice', ui.notice.text));
  body.append(stateNode(item.state, item.reason));
  const job = GENERATION ? activeJobFor(item) : null;
  if (job) body.append(jobStrip(item, job));
  else if (GENERATION) body.append(generateActions(item));
  // Writes are opt-in flags on the command line; say so where the buttons would be.
  if ((!EDITABLE || !GENERATION) && item.declared) {
    const missing: any = [];
    if (!EDITABLE) missing.push('--edit to change its prompt, size, and tags or open it in the browser editor');
    if (!GENERATION) missing.push('--budget <n> to generate or regenerate it from here');
    const hint = el('div', 'state-dim readonly-hint');
    hint.append(document.createTextNode('This gallery is read-only. Restart it with '), el('code', null, 'pixelkiln gallery'), document.createTextNode(' plus ' + missing.join(', and ') + '.'));
    body.append(hint);
  }
  if (canEdit && ui.editing === item.id) body.append(editForm(item));
  // Plan already quotes the error as the reason for a failed entry; only a
  // stale or superseded failure needs its own line.
  if (item.error && !item.reason.includes(item.error)) body.append(stateNode('failed', item.error));

  // Generation: what was sent and what it cost.
  {
    const { s, dl } = section('Generation');
    row(dl, 'provider', item.provider);
    row(dl, 'generator', item.generator + (item.tileFeature ? ' · ' + item.tileFeature : ''));
    row(dl, 'lock status', item.status || 'none (nothing submitted)');
    const pr = el('div', 'prompt', item.prompt); row(dl, item.status ? 'prompt sent' : 'prompt', pr);
    if (item.currentPrompt) row(dl, 'prompt now', el('div', 'prompt state-warn', item.currentPrompt));
    row(dl, 'size', item.width + ' × ' + item.height + ' px');
    if (item.status) row(dl, 'cost', fmtCost(item.costUnit, item.cost));
    if (item.billed && (item.billed.unit !== item.costUnit || item.billed.amount !== item.cost)) {
      row(dl, 'billed', fmtCost(item.billed.unit, item.billed.amount));
    }
    if (item.postprocess && item.postprocess.palette) {
      // What fetch did to the provider's bytes before writing them.
      const p = item.postprocess.palette;
      const wrap = el('span');
      const sw = el('span', 'swatches');
      for (const c of p.colors) { const i = el('i'); i.style.background = c; i.title = c; sw.append(i); }
      wrap.append(document.createTextNode('snapped to ' + p.colors.length + ' colours, no dithering '), sw);
      row(dl, 'palette', wrap);
    }
    if (item.estimatedCost !== null && (item.estimatedCost !== item.cost || !item.status)) {
      row(dl, 'estimate now', fmtCost(item.costUnit, item.estimatedCost) +
        (item.candidates && item.candidates > 1 ? ' for ' + item.candidates + ' candidates' : ''));
    }
    if (item.candidateIndex !== null) row(dl, 'candidate', '#' + (item.candidateIndex + 1) + ' chosen in review');
    row(dl, 'submitted', fmtWhen(item.submittedAt));
    row(dl, 'downloaded', fmtWhen(item.downloadedAt));
    row(dl, 'job id', item.jobId, { mono: true, copy: item.jobId });
    row(dl, 'object id', item.objectId, { mono: true, copy: item.objectId });
    row(dl, 'review object', item.reviewObjectId, { mono: true, copy: item.reviewObjectId });
    body.append(s);
  }

  // Outputs: every file with its hash and whether it is really there.
  {
    const s = el('section', 'meta');
    s.append(el('h3', null, item.outputs.length === 1 ? 'Output' : 'Outputs (' + item.outputs.length + ')'));
    if (!item.outputs.length) s.append(el('div', 'state-dim', item.source ? 'placed from ' + item.source : 'none recorded'));
    for (const o of item.outputs) {
      const box = el('div', 'out');
      const role = el('div', 'role');
      role.append(document.createTextNode(o.role || (item.outputs.length > 1 ? 'primary' : 'file')));
      if (!o.exists) role.append(el('span', 'miss', 'missing on disk'));
      if (o.url) { const a = el('a', null, 'open'); a.href = o.url.split('?')[0]; a.target = '_blank'; a.rel = 'noopener'; role.append(a); }
      box.append(role);
      const dl = el('dl');
      row(dl, 'path', o.path, { mono: true, copy: o.absolutePath });
      row(dl, 'sha256', o.sha256 ? o.sha256.slice(0, 16) + '…' : (o.exists ? 'not recorded' : null), { mono: true, copy: o.sha256 || undefined });
      row(dl, 'bytes', o.exists ? fmtBytes(o.bytes) : null);
      row(dl, 'type', o.mediaType);
      box.append(dl);
      s.append(box);
    }
    body.append(s);
  }

  const hand = handEditSection(item);
  if (hand) body.append(hand);
  const upstream = upstreamSection(item);
  if (upstream) body.append(upstream);
  const versions = historySection(item);
  if (versions) body.append(versions);

  if (item.character) {
    const c = item.character;
    const { s, dl } = section('Character');
    row(dl, 'kind', CHARACTER_KIND[c.kind] || c.kind);
    if (c.parentKey) row(dl, 'parent', keyLink(item, c.parentKey));
    row(dl, 'engine', c.mode);
    if (c.kind === 'animation') row(dl, 'direction', c.direction || '—');
    else row(dl, 'directions', String(c.directions));
    if (c.characterId) row(dl, 'character id', c.characterId, { mono: true, copy: c.characterId });
    const root = familyRoot(item);
    const size = root ? familyMembers(root).length : 0;
    if (root && size > 1) {
      const fam = el('button', 'add', 'Family view · ' + size);
      fam.type = 'button';
      fam.title = 'Turn ' + root.assetId + ' through its rotations and play every loop by direction';
      fam.onclick = () => openFamily(item);
      row(dl, 'family', fam);
    }
    const family = S.snap.items.filter((i) => i.character && i.character.parentKey === item.key && i.project === item.project);
    if (family.length) {
      const list = el('div');
      for (const f of family) {
        const line = el('div');
        line.append(document.createTextNode((f.character!.kind === 'state' ? 'state ' : 'loop ') + (f.character!.direction ? f.character!.direction + ' ' : '')), keyLink(item, f.key));
        list.append(line);
      }
      row(dl, family.length === 1 ? 'depends on this' : family.length + ' depend on this', list);
    }
    // Only a base or a state can be posed or animated further; a loop,
    // portrait, or outfit is an end product of its parent.
    if (canEdit && (c.kind === 'base' || c.kind === 'state')) {
      const stateKey = 'state:' + item.id, animKey = 'anim:' + item.id;
      const addState = el('button', ui.editing === stateKey ? null : 'add', ui.editing === stateKey ? 'Cancel' : '+ New state');
      addState.type = 'button';
      addState.onclick = () => { ui.editing = ui.editing === stateKey ? null : stateKey; ui.notice = null; renderDrawer(); };
      const addAnim = el('button', ui.editing === animKey ? null : 'add', ui.editing === animKey ? 'Cancel' : '+ New animation');
      addAnim.type = 'button';
      addAnim.onclick = () => { ui.editing = ui.editing === animKey ? null : animKey; ui.notice = null; renderDrawer(); };
      const buttons = el('div', 'actions'); buttons.append(addState, addAnim);
      s.append(buttons);
      if (ui.editing === stateKey) s.append(newStateForm(item));
      if (ui.editing === animKey) s.append(newAnimationForm(item));
    }
    body.append(s);
  }

  if (item.mirrorOfKey) {
    const { s, dl } = section('Mirror');
    row(dl, 'flipped from', keyLink(item, item.mirrorOfKey));
    row(dl, 'cost', 'none; made locally from that asset\'s files');
    body.append(s);
  }
  const mirrors = S.snap.items.filter((i) => i.mirrorOfKey === item.key && i.project === item.project);
  if (mirrors.length) {
    const { s, dl } = section(mirrors.length === 1 ? 'Mirror of this asset' : 'Mirrors of this asset');
    for (const m of mirrors) row(dl, m.character && m.character.direction ? m.character.direction : 'flipped', keyLink(item, m.key));
    body.append(s);
  }

  if (item.revision || item.revisionParentKey) {
    const { s, dl } = section('Lineage');
    row(dl, 'mode', item.revision ? item.revision.mode : (item.asset && item.asset.revision && item.asset.revision.mode));
    if (item.revisionParentKey) row(dl, 'parent', keyLink(item, item.revisionParentKey));
    if (item.revision) {
      row(dl, 'parent sha256', item.revision.sourceSha256.slice(0, 16) + '…', { mono: true, copy: item.revision.sourceSha256 });
      if (item.revision.maskSha256) row(dl, 'mask sha256', item.revision.maskSha256.slice(0, 16) + '…', { mono: true, copy: item.revision.maskSha256 });
      if (item.revision.strength !== undefined) row(dl, 'strength', item.revision.strength);
    }
    if (item.skeleton) {
      row(dl, 'keypoints', item.skeleton.keypointsFile, { mono: true });
      if (item.skeleton.set) {
        const parent = S.snap.items.find((i) => i.key === item.revisionParentKey && i.project === item.project);
        const posesKey = 'poses:' + item.id;
        if (ui.editing === posesKey) {
          s.append(skeletonPoseForm(item, displayUrl(parent)));
        } else {
          s.append(poseStrip(item.skeleton.set, displayUrl(parent)));
          s.append(el('small', 'state-dim', 'The starting pose must match the sprite; each frame is drawn over a dimmed copy. `pixelkiln skeleton-preview ' + item.assetId + '` writes the same sheet as a PNG.'));
          if (canEdit && item.skeleton.sha256) {
            const b = el('button', 'add', 'Edit poses'); b.type = 'button';
            b.onclick = () => { ui.editing = posesKey; ui.notice = null; renderDrawer(); };
            s.append(b);
          }
        }
      } else {
        row(dl, 'poses', el('span', 'state-warn', 'the keypoints file does not exist yet'));
      }
    }
    body.append(s);
  }
  const children = S.snap.items.filter((i) => i.revisionParentKey === item.key && i.project === item.project);
  const reviseKey = 'revise:' + item.id;
  const canRevise = canEdit && isRevisable(item);
  if (children.length || canRevise) {
    const { s, dl } = section('Revisions from this asset');
    for (const c of children) row(dl, c.revision ? c.revision.mode : 'child', keyLink(item, c.key));
    if (canRevise) {
      const revise = el('button', ui.editing === reviseKey ? null : 'add', ui.editing === reviseKey ? 'Cancel' : '+ New revision');
      revise.type = 'button';
      revise.onclick = () => { ui.editing = ui.editing === reviseKey ? null : reviseKey; ui.notice = null; renderDrawer(); };
      const buttons = el('div', 'actions'); buttons.append(revise);
      // animate-skeleton poses one PixelLab sprite; a set of directions or frames is not one.
      const skeletonKey = 'skeleton:' + item.id;
      if (item.provider === 'pixellab' && item.outputs.length === 1) {
        const animate = el('button', ui.editing === skeletonKey ? null : 'add', ui.editing === skeletonKey ? 'Cancel' : '+ Skeleton animation');
        animate.type = 'button';
        animate.onclick = () => { ui.editing = ui.editing === skeletonKey ? null : skeletonKey; ui.notice = null; renderDrawer(); };
        buttons.append(animate);
      }
      s.append(buttons);
      if (ui.editing === reviseKey) s.append(newRevisionForm(item));
      if (ui.editing === skeletonKey) s.append(skeletonAnimationForm(item));
    }
    body.append(s);
  }

  if (item.quality) {
    const q = item.quality;
    const { s, dl } = section('Quality');
    const tone = q.state === 'approved' ? 'ok' : q.state === 'blocked' ? 'bad' : 'warn';
    const st = el('span', 'state-' + tone); st.append(el('i', 'dot ' + tone + ' '), document.createTextNode(' ' + q.state));
    row(dl, 'state', st);
    row(dl, 'why', q.reason);
    if (q.review) {
      row(dl, 'review', q.review.status === 'approved'
        ? 'approved by ' + q.review.reviewer + ' · ' + fmtWhen(q.review.approvedAt)
        : 'pending human 1× review');
      if (q.review.status === 'approved' && q.review.note) row(dl, 'note', q.review.note);
    }
    if (q.palette) {
      const pal = el('div', 'pal');
      for (const c of q.palette) { const i = el('i'); i.style.background = c; i.title = c; pal.append(i); }
      row(dl, 'palette', pal);
      row(dl, 'colors', q.palette.length + ' declared' + (q.audit ? ', ' + q.audit.colorCount + ' used' : ''));
    }
    if (q.nativeGrid) {
      row(dl, 'native grid', q.nativeGrid.sourceWidth + '×' + q.nativeGrid.sourceHeight + ' → ' +
        q.nativeGrid.nativeWidth + '×' + q.nativeGrid.nativeHeight + ' (step ' + q.nativeGrid.stepX + '×' + q.nativeGrid.stepY +
        ', ' + q.nativeGrid.confidence + ' confidence)');
    }
    if (q.audit) row(dl, 'audit', (q.audit.safe ? 'passed' : 'failed') + ' · ' + Math.round(q.audit.transparency * 100) + '% transparent' +
      (q.audit.reasons.length ? ' · ' + q.audit.reasons.join('; ') : ''));
    if (q.frameSet) row(dl, 'frame set', q.frameSet.count + ' frames at ' + q.frameSet.fps + ' fps');
    row(dl, 'output', q.output, { mono: true });
    row(dl, 'record', q.record + (q.recordExists ? '' : ' (not written yet)'), { mono: true });
    if (q.check && !q.check.safe) row(dl, 'check', el('div', 'state-warn', q.check.reasons.join('\n')));
    body.append(s);
    if (q.outputs.some((o) => o.url)) {
      const strip = el('div', 'members');
      for (const o of q.outputs.filter((o) => o.url)) {
        const b = el('button'); b.type = 'button';
        const t = el('img'); t.src = o.url!; t.alt = 'refined ' + (o.role || item.assetId);
        b.append(t, el('span', null, 'refined')); b.onclick = () => window.open(o.url!.split('?')[0], '_blank');
        strip.append(b);
      }
      s.append(strip);
    }
  }

  {
    const { s, dl } = section('Identity');
    if (item.project) row(dl, 'project', item.project);
    row(dl, 'lock key', item.key, { mono: true, copy: item.key });
    if (item.recordedSpecHash) {
      row(dl, 'spec hash', item.recordedSpecHash.slice(0, 16) + '…', { mono: true, copy: item.recordedSpecHash });
    }
    if (item.currentSpecHash && item.currentSpecHash !== item.recordedSpecHash) {
      row(dl, item.recordedSpecHash ? 'spec hash now' : 'spec hash',
        el('span', item.recordedSpecHash ? 'state-warn' : null, item.currentSpecHash.slice(0, 16) + '…'), { mono: true, copy: item.currentSpecHash });
    }
    row(dl, 'declared', item.declared ? 'yes' : 'no; the manifest no longer has this asset in this style');
    row(dl, 'category', item.category);
    row(dl, 'tags', item.tags && item.tags.length ? item.tags.join(', ') : null);
    row(dl, 'source art', item.source, { mono: true });
    body.append(s);
  }

  if (item.asset) {
    // Show the asset as the author would write it: schema defaults that are
    // empty add nothing but noise to a record.
    const declared = Object.fromEntries(Object.entries(item.asset).filter(([, v]) =>
      !(Array.isArray(v) && !v.length) && !(v && typeof v === 'object' && !Array.isArray(v) && !Object.keys(v).length)));
    body.append(jsonDetails('Manifest asset', declared));
  }
  if (item.providerMetadata && Object.keys(item.providerMetadata).length) {
    body.append(jsonDetails('Provider metadata', item.providerMetadata));
  }

  drawer.append(head, body);
  host.append(scrim, drawer);
  close.focus({ preventScroll: true });
}

// View state lives in the URL (filters and sort in the query, the open
// record in the hash) so a link to "every failed generation" or to one
// specific record can be pasted into a review thread and land there.
export function readUrlState() {
  const params = new URLSearchParams(location.search);
  const list = (name) => (params.get(name) || '').split(',').map((v) => v.trim()).filter(Boolean);
  ui.q = params.get('q') || '';
  ui.states = new Set(list('state'));
  ui.providers = new Set(list('provider'));
  ui.generators = new Set(list('generator'));
  ui.projects = new Set(list('project'));
  ui.compare = list('compare').slice(0, 4);
  if (['key', 'newest', 'oldest', 'cost', 'size'].includes(params.get('sort') ?? '')) ui.sort = params.get('sort')!;
  if (['style', 'family', 'none'].includes(params.get('group') ?? '')) ui.group = params.get('group')!;
}
export function writeUrlState() {
  const params = new URLSearchParams();
  if (ui.q) params.set('q', ui.q);
  if (ui.states.size) params.set('state', [...ui.states].join(','));
  if (ui.providers.size) params.set('provider', [...ui.providers].join(','));
  if (ui.generators.size) params.set('generator', [...ui.generators].join(','));
  if (ui.projects.size) params.set('project', [...ui.projects].join(','));
  if (ui.compare.length) params.set('compare', ui.compare.join(','));
  if (ui.sort !== 'key') params.set('sort', ui.sort);
  if (ui.group !== 'style') params.set('group', ui.group);
  const query = params.toString();
  const next = location.pathname + (query ? '?' + query : '') + (ui.open ? '#' + encodeURIComponent(ui.open) : '');
  if (next !== location.pathname + location.search + location.hash) history.replaceState(null, '', next);
}
export function syncHash() { writeUrlState(); }
export function keyFromHash() {
  try { return location.hash.length > 1 ? decodeURIComponent(location.hash.slice(1)) : null; }
  catch { return null; }
}
// Opening a record must not rebuild the grid: at a few thousand cards that
// is a visible pause, and nothing in the grid changes except one highlight.
export function markActive(key) {
  document.querySelector('.card.active')?.classList.remove('active');
  const card = key && document.querySelector('.card[data-key="' + CSS.escape(key) + '"]');
  if (card) card.classList.add('active');
  return card;
}
export function openItem(key) {
  if (ui.open !== key) { ui.editing = null; if (ui.notice && ui.notice.id !== key) ui.notice = null; }
  ui.open = key; ui.member = 0; ui.zoom = 'auto';
  syncHash();
  const card = markActive(key);
  renderDrawer();
  if (card) card.scrollIntoView({ block: 'nearest' });
}
export function closeItem() {
  const key = ui.open;
  ui.open = null;
  ui.editing = null;
  ui.notice = null;
  syncHash();
  markActive(null);
  renderDrawer();
  const focus = key && document.querySelector<HTMLElement>('.card[data-key="' + CSS.escape(key) + '"]');
  if (focus) focus.focus({ preventScroll: true });
}
window.addEventListener('hashchange', () => {
  const key = keyFromHash();
  if (key && key !== ui.open && S.snap.items.some((i) => i.id === key)) openItem(key);
  else if (!key && ui.open) closeItem();
});
export function step(delta) {
  const items = visibleItems();
  const pos = items.findIndex((i) => i.id === ui.open);
  const next = items[pos + delta];
  if (next) openItem(next.id);
}

export function render() {
  writeUrlState();
  renderHeader();
  renderMain(visibleItems());
  renderDrawer();
  renderTray();
  renderSelectionBar();
  refreshFamily();
}

/**
 * A redraw nobody asked for: a job landing, auto-refresh, the editor's
 * status. Everything but the part holding an open form is redrawn; that
 * part catches up when the form is saved or closed, which renders in full.
 */
export function renderQuietly() {
  const region = formRegion();
  writeUrlState();
  renderHeader();
  if (region !== 'main') renderMain(visibleItems());
  if (region !== 'drawer') renderDrawer();
  renderTray();
  renderSelectionBar();
  refreshFamily();
}
