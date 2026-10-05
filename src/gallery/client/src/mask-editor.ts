import { el } from "./core.ts"

/**
 * A paint-the-area editor for an inpaint mask. The canvas is the sprite's own
 * size, drawn up with hard pixels, so one painted cell is one sprite pixel and
 * the exported PNG is the sprite's size, black where the art is kept and white
 * where PixelLab may repaint, which is what the manifest's `mask` must be.
 */

export interface MaskEditor {
  root: HTMLElement
  /** The mask as PNG base64 once the sprite has loaded; null before that. */
  png(): { base64: string; width: number; height: number } | null
  /** True while nothing is painted: an all-black mask repaints nothing. */
  empty(): boolean
}

const HISTORY = 50
const SCALE_BOX = 320

export function maskEditor(imageUrl: string | null, onChange: () => void): MaskEditor {
  const root = el('div', 'mask-editor');
  const canvas = el('canvas', 'mask-stage');
  const tools = el('div', 'pose-tools');
  const status = el('div', 'pose-status', 'loading the sprite…');
  root.append(canvas, tools, status);

  let width = 0, height = 0;
  let mask: Uint8Array = new Uint8Array(0);
  let sprite: HTMLImageElement | null = null;
  let brush = 2;
  let erasing = false;
  let painting = false;
  let last: [number, number] | null = null;
  const past: Uint8Array[] = [];

  const ctx = canvas.getContext('2d')!;
  const count = () => { let n = 0; for (const v of mask) if (v) n++; return n; };

  const draw = () => {
    if (!width) return;
    ctx.imageSmoothingEnabled = false;
    ctx.clearRect(0, 0, width, height);
    if (sprite) ctx.drawImage(sprite, 0, 0, width, height);
    const overlay = ctx.getImageData(0, 0, width, height);
    for (let i = 0; i < mask.length; i++) {
      if (!mask[i]) continue;
      const p = i * 4;
      overlay.data[p] = Math.round(overlay.data[p]! * 0.4 + 255 * 0.6);
      overlay.data[p + 1] = Math.round(overlay.data[p + 1]! * 0.4 + 60 * 0.6);
      overlay.data[p + 2] = Math.round(overlay.data[p + 2]! * 0.4 + 60 * 0.6);
      overlay.data[p + 3] = 255;
    }
    ctx.putImageData(overlay, 0, 0);
    const n = count();
    status.textContent = width + '×' + height + ' px · ' + (n ? n + ' px marked to repaint (' + Math.round((n / mask.length) * 100) + '%)' : 'paint over the area to repaint');
  };

  const stamp = (cx: number, cy: number) => {
    const r = brush - 1;
    const x0 = cx - Math.floor(r / 2), y0 = cy - Math.floor(r / 2);
    for (let y = y0; y < y0 + brush; y++) {
      for (let x = x0; x < x0 + brush; x++) {
        if (x >= 0 && y >= 0 && x < width && y < height) mask[y * width + x] = erasing ? 0 : 1;
      }
    }
  };
  /** Every cell between two pointer samples, so a fast drag leaves no gaps. */
  const line = (from: [number, number], to: [number, number]) => {
    const steps = Math.max(Math.abs(to[0] - from[0]), Math.abs(to[1] - from[1]), 1);
    for (let i = 0; i <= steps; i++) {
      stamp(Math.round(from[0] + ((to[0] - from[0]) * i) / steps), Math.round(from[1] + ((to[1] - from[1]) * i) / steps));
    }
  };
  const cell = (e: PointerEvent): [number, number] => {
    const box = canvas.getBoundingClientRect();
    return [Math.floor(((e.clientX - box.left) / box.width) * width), Math.floor(((e.clientY - box.top) / box.height) * height)];
  };
  const remember = () => { past.push(mask.slice()); if (past.length > HISTORY) past.shift(); };

  canvas.onpointerdown = (e) => {
    if (!width) return;
    e.preventDefault();
    canvas.setPointerCapture(e.pointerId);
    remember();
    painting = true;
    last = cell(e);
    line(last, last);
    draw();
  };
  canvas.onpointermove = (e) => {
    if (!painting || !last) return;
    const next = cell(e);
    line(last, next);
    last = next;
    draw();
  };
  const stop = () => { if (painting) { painting = false; last = null; onChange(); } };
  canvas.onpointerup = stop;
  canvas.onpointercancel = stop;

  const button = (label: string, title: string, run: () => void) => {
    const b = el('button', null, label); b.type = 'button'; b.title = title; b.onclick = run; tools.append(b); return b;
  };
  const size = el('input'); size.type = 'range'; size.min = '1'; size.max = '16'; size.value = String(brush);
  size.oninput = () => { brush = Number(size.value); sizeLabel.textContent = 'brush ' + brush + ' px'; };
  const sizeLabel = el('span', 'state-dim', 'brush ' + brush + ' px');
  const paintBtn = button('Paint', 'Mark pixels to repaint', () => { erasing = false; sync(); });
  const eraseBtn = button('Erase', 'Keep pixels as they are', () => { erasing = true; sync(); });
  const sync = () => { paintBtn.className = erasing ? '' : 'primary'; eraseBtn.className = erasing ? 'primary' : ''; };
  sync();
  tools.append(sizeLabel, size);
  button('Undo', 'Undo the last stroke', () => { const p = past.pop(); if (p) { mask = p; draw(); onChange(); } });
  button('Invert', 'Repaint everything else instead', () => { remember(); mask = Uint8Array.from(mask, (v) => (v ? 0 : 1)); draw(); onChange(); });
  button('Clear', 'Unmark everything', () => { remember(); mask.fill(0); draw(); onChange(); });

  if (!imageUrl) {
    status.textContent = 'this record has no image on disk to paint over';
  } else {
    const img = new Image();
    img.onload = () => {
      sprite = img;
      width = img.naturalWidth; height = img.naturalHeight;
      canvas.width = width; canvas.height = height;
      mask = new Uint8Array(width * height);
      const scale = Math.max(1, Math.floor(SCALE_BOX / Math.max(width, height)));
      canvas.style.width = width * scale + 'px';
      canvas.style.height = height * scale + 'px';
      draw();
    };
    img.onerror = () => { status.textContent = 'the sprite could not be loaded'; };
    img.src = imageUrl;
  }

  return {
    root,
    empty: () => !width || count() === 0,
    png() {
      if (!width) return null;
      const out = document.createElement('canvas');
      out.width = width; out.height = height;
      const octx = out.getContext('2d')!;
      const data = octx.createImageData(width, height);
      for (let i = 0; i < mask.length; i++) {
        const v = mask[i] ? 255 : 0;
        data.data[i * 4] = v; data.data[i * 4 + 1] = v; data.data[i * 4 + 2] = v; data.data[i * 4 + 3] = 255;
      }
      octx.putImageData(data, 0, 0);
      return { base64: out.toDataURL('image/png').split(',')[1]!, width, height };
    },
  };
}
