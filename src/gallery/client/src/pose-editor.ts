import { el } from "./core.ts"
import { boneColor, poseSvg, SKELETON_BONES, svgEl } from "./skeleton.ts"

/** One joint as PixelLab takes it: x and y are fractions of the sprite. */
export interface Joint {
  label: string
  x: number
  y: number
  z_index: number
  depth?: number
}

/** A keypoints file: the pose the sprite is already in, then the motion. */
export interface PoseSet {
  firstFrameKeypoints: Joint[]
  frames: Joint[][]
}

const MIN_FRAMES = 3
const MAX_FRAMES = 15
const HISTORY = 100
/** Arrow-key nudge, as a fraction of the sprite; shift moves four times as far. */
const NUDGE = 1 / 128
const PLAY_MS = 125

const clone = (set: PoseSet): PoseSet => JSON.parse(JSON.stringify(set));
const clamp = (v: number) => Math.min(1, Math.max(0, Math.round(v * 1000) / 1000));
const mirrorLabel = (label: string) =>
  label.startsWith('RIGHT ') ? 'LEFT ' + label.slice(6) : label.startsWith('LEFT ') ? 'RIGHT ' + label.slice(5) : label;

/**
 * A drag-to-edit editor for a keypoints file.
 *
 * The stage shows the sprite with the pose being edited over it and the
 * pose before it faint underneath, so each frame is placed relative to the
 * last. Joints are dragged with pointer capture and moved in place (the SVG
 * is not rebuilt mid-drag, which would drop the capture); arrow keys nudge
 * the selected joint, and `,`/`.` step frames. Every committed change goes
 * on an undo stack and out through `onChange` as a fresh copy, so the
 * caller's JSON, preview, or save button always sees the whole file.
 *
 * Index 0 is the starting pose (`firstFrameKeypoints`, which must match the
 * sprite as drawn); 1..n are the frames. The starting pose cannot be
 * removed, and the frame count stays within PixelLab's 3 to 15.
 */
export function poseEditor(initial: PoseSet, imageUrl: string | null, onChange: (set: PoseSet) => void): HTMLElement {
  let set = clone(initial);
  let index = set.frames.length ? 1 : 0;
  let selected: string | null = null;
  let playing: ReturnType<typeof setInterval> | null = null;
  const past: string[] = [];
  const future: string[] = [];

  const root = el('div', 'pose-editor');
  const stageWrap = el('div', 'pose-stage');
  const side = el('div', 'pose-side');
  const status = el('div', 'pose-status');
  const strip = el('div', 'poses pose-strip');
  const tools = el('div', 'pose-tools');
  side.append(tools, status);
  root.append(stageWrap, side, strip);

  const poseAt = (i: number): Joint[] => (i === 0 ? set.firstFrameKeypoints : set.frames[i - 1]!);
  const count = () => set.frames.length + 1;
  const name = (i: number) => (i === 0 ? 'start' : 'frame ' + i);

  /** Records the state before a change, so undo returns to it. */
  const remember = (before: string) => {
    past.push(before);
    if (past.length > HISTORY) past.shift();
    future.length = 0;
  };
  const commit = (before: string) => {
    if (JSON.stringify(set) === before) return;
    remember(before);
    onChange(clone(set));
    drawStrip();
    drawTools();
  };
  const edit = (change: () => void) => {
    const before = JSON.stringify(set);
    change();
    commit(before);
    drawStage();
  };

  // ---- stage: the pose being edited, over the sprite ---------------------
  let svg: SVGSVGElement;
  let joints = new Map<string, SVGCircleElement[]>();
  let bones: { a: string; b: string; lines: SVGLineElement[] }[] = [];

  function drawStage() {
    stageWrap.textContent = '';
    svg = svgEl('svg', { viewBox: '0 0 1 1', class: 'pose stage', tabindex: 0 }) as SVGSVGElement;
    svg.setAttribute('aria-label', 'Pose ' + name(index) + ': drag joints, arrow keys nudge the selected one');
    if (imageUrl) svg.append(svgEl('image', { href: imageUrl, x: 0, y: 0, width: 1, height: 1, preserveAspectRatio: 'none' }));
    // The pose before this one, faint: where the motion is coming from.
    if (index > 0) {
      const prev = new Map(poseAt(index - 1).map((j) => [j.label, j]));
      for (const [a, b] of SKELETON_BONES) {
        const p = prev.get(a), q = prev.get(b);
        if (p && q) svg.append(svgEl('line', { x1: p.x, y1: p.y, x2: q.x, y2: q.y, stroke: boneColor(b), 'stroke-width': 0.012, opacity: 0.3, 'stroke-linecap': 'round' }));
      }
    }
    const at = new Map(poseAt(index).map((j) => [j.label, j]));
    joints = new Map();
    bones = [];
    for (const [a, b] of SKELETON_BONES) {
      const p = at.get(a), q = at.get(b);
      if (!p || !q) continue;
      const lines = [
        svgEl('line', { x1: p.x, y1: p.y, x2: q.x, y2: q.y, stroke: '#000', 'stroke-width': 0.03, 'stroke-linecap': 'round' }),
        svgEl('line', { x1: p.x, y1: p.y, x2: q.x, y2: q.y, stroke: boneColor(b), 'stroke-width': 0.015, 'stroke-linecap': 'round' }),
      ] as SVGLineElement[];
      svg.append(...lines);
      bones.push({ a, b, lines });
    }
    for (const j of poseAt(index)) {
      const on = j.label === selected;
      const ring = svgEl('circle', { cx: j.x, cy: j.y, r: on ? 0.034 : 0.026, fill: '#000' }) as SVGCircleElement;
      const dot = svgEl('circle', { cx: j.x, cy: j.y, r: on ? 0.022 : 0.016, fill: on ? '#fff' : boneColor(j.label) }) as SVGCircleElement;
      // A wider, invisible target: joints sit close together on a small sprite.
      const hit = svgEl('circle', { cx: j.x, cy: j.y, r: 0.045, fill: 'transparent', class: 'joint' }) as SVGCircleElement;
      const title = svgEl('title', {});
      title.textContent = j.label;
      hit.append(title);
      hit.addEventListener('pointerdown', (e) => startDrag(e, j.label));
      svg.append(ring, dot, hit);
      joints.set(j.label, [ring, dot, hit]);
    }
    svg.addEventListener('keydown', onKey);
    stageWrap.append(svg);
    drawStatus();
  }

  /** Moves one joint's marks and the bones that meet it, without rebuilding the SVG. */
  function place(label: string, x: number, y: number) {
    for (const c of joints.get(label) || []) { c.setAttribute('cx', String(x)); c.setAttribute('cy', String(y)); }
    for (const bone of bones) {
      for (const line of bone.lines) {
        if (bone.a === label) { line.setAttribute('x1', String(x)); line.setAttribute('y1', String(y)); }
        if (bone.b === label) { line.setAttribute('x2', String(x)); line.setAttribute('y2', String(y)); }
      }
    }
  }

  function toUnit(e: PointerEvent): { x: number; y: number } {
    const m = svg.getScreenCTM();
    if (!m) return { x: 0, y: 0 };
    const p = new DOMPoint(e.clientX, e.clientY).matrixTransform(m.inverse());
    return { x: clamp(p.x), y: clamp(p.y) };
  }

  function startDrag(e: PointerEvent, label: string) {
    if (playing) return;
    e.preventDefault();
    const before = JSON.stringify(set);
    const joint = poseAt(index).find((j) => j.label === label)!;
    const target = e.target as SVGCircleElement;
    target.setPointerCapture(e.pointerId);
    const wasSelected = selected;
    selected = label;
    if (wasSelected !== label) {
      // Re-mark the selection without dropping the capture: only the colours change.
      for (const [l, [ring, dot]] of joints) {
        const on = l === label;
        ring!.setAttribute('r', String(on ? 0.034 : 0.026));
        dot!.setAttribute('r', String(on ? 0.022 : 0.016));
        dot!.setAttribute('fill', on ? '#fff' : boneColor(l));
      }
    }
    const move = (ev: PointerEvent) => {
      const { x, y } = toUnit(ev);
      joint.x = x; joint.y = y;
      place(label, x, y);
      drawStatus();
    };
    const end = () => {
      target.removeEventListener('pointermove', move);
      target.removeEventListener('pointerup', end);
      target.removeEventListener('pointercancel', end);
      commit(before);
      svg.focus({ preventScroll: true });
    };
    target.addEventListener('pointermove', move);
    target.addEventListener('pointerup', end);
    target.addEventListener('pointercancel', end);
    drawStatus();
  }

  function onKey(e: KeyboardEvent) {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') { e.preventDefault(); if (e.shiftKey) redo(); else undo(); return; }
    if (e.key === ',') { e.preventDefault(); go(index - 1); return; }
    if (e.key === '.') { e.preventDefault(); go(index + 1); return; }
    const step = (e.shiftKey ? 4 : 1) * NUDGE;
    const d = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] }[e.key];
    if (!d || !selected || playing) return;
    e.preventDefault();
    const label = selected;
    edit(() => {
      const joint = poseAt(index).find((j) => j.label === label)!;
      joint.x = clamp(joint.x + d[0]!);
      joint.y = clamp(joint.y + d[1]!);
    });
    svg.focus({ preventScroll: true });
  }

  function undo() {
    const before = past.pop();
    if (!before) return;
    future.push(JSON.stringify(set));
    set = JSON.parse(before);
    index = Math.min(index, count() - 1);
    onChange(clone(set));
    redraw();
  }
  function redo() {
    const next = future.pop();
    if (!next) return;
    past.push(JSON.stringify(set));
    set = JSON.parse(next);
    index = Math.min(index, count() - 1);
    onChange(clone(set));
    redraw();
  }
  function go(i: number) {
    if (i < 0 || i >= count()) return;
    index = i;
    redraw();
    svg.focus({ preventScroll: true });
  }

  // ---- tools --------------------------------------------------------------
  const button = (label: string, title: string, onClick: () => void, disabled = false) => {
    const b = el('button', null, label);
    b.type = 'button'; b.title = title; b.disabled = disabled || !!playing && label !== 'Stop';
    b.onclick = onClick;
    return b;
  };
  function drawTools() {
    tools.textContent = '';
    const frameOnly = index === 0;
    tools.append(
      button('◀', 'Previous pose (,)', () => go(index - 1), index === 0),
      button('▶', 'Next pose (.)', () => go(index + 1), index >= count() - 1),
      button(playing ? 'Stop' : 'Play', 'Play the frames in a loop', () => togglePlay(), set.frames.length < 2 && !playing),
      button('Copy previous', 'Replace this pose with the one before it', () => edit(() => {
        set.frames[index - 1] = poseAt(index - 1).map((j) => ({ ...j }));
      }), frameOnly),
      button('Mirror', 'Flip this pose left to right, swapping left and right joints', () => edit(() => {
        const flipped = poseAt(index).map((j) => ({ ...j, label: mirrorLabel(j.label), x: clamp(1 - j.x) }));
        if (index === 0) set.firstFrameKeypoints = flipped; else set.frames[index - 1] = flipped;
      })),
      button('+ Frame', 'Add a copy of this pose after it', () => edit(() => {
        set.frames.splice(index, 0, poseAt(index).map((j) => ({ ...j })));
        index += 1;
      }), set.frames.length >= MAX_FRAMES),
      button('− Frame', 'Remove this frame', () => edit(() => {
        set.frames.splice(index - 1, 1);
        index = Math.min(index, count() - 1);
      }), frameOnly || set.frames.length <= MIN_FRAMES),
      button('Undo', 'Undo (Ctrl+Z)', undo, !past.length),
      button('Redo', 'Redo (Ctrl+Shift+Z)', redo, !future.length),
    );
  }
  function togglePlay() {
    if (playing) { clearInterval(playing); playing = null; redraw(); return; }
    let i = index > 0 ? index : 1;
    playing = setInterval(() => {
      if (!root.isConnected) { clearInterval(playing!); playing = null; return; }
      i = i >= count() - 1 ? 1 : i + 1;
      index = i;
      drawStage();
      drawStrip();
    }, PLAY_MS);
    drawTools();
  }

  function drawStatus() {
    const j = selected && poseAt(index).find((x) => x.label === selected);
    status.textContent = name(index) + ' of ' + set.frames.length + ' frames' +
      (j ? ' · ' + j.label + ' (' + j.x.toFixed(3) + ', ' + j.y.toFixed(3) + ')' : ' · drag a joint to move it') +
      (index === 0 ? ' · the starting pose must match the sprite as drawn' : '');
  }

  function drawStrip() {
    strip.textContent = '';
    for (let i = 0; i < count(); i++) {
      const cell = el('button', i === index ? 'on' : null);
      cell.type = 'button';
      cell.title = name(i);
      cell.append(poseSvg(poseAt(i), imageUrl, i > 0), el('span', null, i === 0 ? 'start' : String(i)));
      const target = i;
      cell.onclick = () => { if (!playing) go(target); };
      strip.append(cell);
    }
  }

  function redraw() {
    drawStage();
    drawStrip();
    drawTools();
  }

  redraw();
  return root;
}
