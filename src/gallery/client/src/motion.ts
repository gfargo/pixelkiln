import { ui } from "./core.ts"

/**
 * Loops on the grid: a card's frame set plays while the pointer is over it,
 * or every card's plays at once with "play loops" on. One animation-frame
 * clock drives all of them, and only cards on screen are advanced, so a
 * project with hundreds of loops costs no more than the handful in view.
 */

interface Loop { img: HTMLImageElement; urls: string[]; fps: number; index: number; visible: boolean; hovered: boolean; first: string }

const loops = new Map<HTMLImageElement, Loop>();
let raf: number | null = null;
let t0 = 0;
const seen = typeof IntersectionObserver === 'function'
  ? new IntersectionObserver((entries) => {
      for (const e of entries) {
        const loop = loops.get(e.target as HTMLImageElement);
        if (loop) loop.visible = e.isIntersecting;
      }
      wake();
    })
  : null;

/** Registers a card's thumbnail as a loop; the card calls this as it is built. */
export function registerLoop(img: HTMLImageElement, urls: string[], fps: number, hoverTarget: HTMLElement) {
  if (urls.length < 2) return;
  const loop: Loop = { img, urls, fps: fps || 12, index: 0, visible: !seen, hovered: false, first: img.src };
  loops.set(img, loop);
  seen?.observe(img);
  let warmed = false;
  const warm = () => { if (warmed) return; warmed = true; for (const u of urls) { const p = new Image(); p.src = u; } };
  hoverTarget.addEventListener('pointerenter', () => { warm(); loop.hovered = true; wake(); });
  hoverTarget.addEventListener('pointerleave', () => { loop.hovered = false; rest(loop); });
  hoverTarget.addEventListener('focus', () => { warm(); loop.hovered = true; wake(); });
  hoverTarget.addEventListener('blur', () => { loop.hovered = false; rest(loop); });
  if (ui.playLoops) warm();
}

/** Forgets loops whose cards left the page (the grid is rebuilt on every render). */
export function pruneLoops() {
  for (const [img, loop] of loops) if (!img.isConnected) { seen?.unobserve(img); loops.delete(img); void loop; }
}

/** Turns "play loops" on or off for every card. */
export function setPlayLoops(on: boolean) {
  ui.playLoops = on;
  if (on) for (const loop of loops.values()) for (const u of loop.urls) { const p = new Image(); p.src = u; }
  else for (const loop of loops.values()) if (!loop.hovered) rest(loop);
  wake();
}

function rest(loop: Loop) {
  if (ui.playLoops) return;
  loop.index = 0;
  if (loop.img.src !== loop.first) loop.img.src = loop.first;
}

function wake() {
  if (raf === null && typeof requestAnimationFrame === 'function') {
    t0 = performance.now();
    raf = requestAnimationFrame(tick);
  }
}

function tick(now: number) {
  raf = null;
  let active = false;
  // A frame's timestamp can fall a moment before the clock started.
  const seconds = Math.max(0, (now - t0) / 1000);
  for (const [img, loop] of loops) {
    if (!img.isConnected) continue;
    if (!loop.hovered && !(ui.playLoops && loop.visible)) continue;
    active = true;
    const i = Math.floor(seconds * loop.fps) % loop.urls.length;
    if (i !== loop.index) { loop.index = i; img.src = loop.urls[i]; }
  }
  if (active && !document.hidden) raf = requestAnimationFrame(tick);
}

document.addEventListener('visibilitychange', () => { if (!document.hidden) wake(); });
