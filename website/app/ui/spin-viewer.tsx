"use client";

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import type { CSSProperties, PointerEvent as ReactPointerEvent } from "react";

/** Strip cell edge in source pixels, and how many directions a strip holds. */
const CELL = 80;
const FRAMES = 16;
const SPIN_FPS = 6;
/** Pixels of drag per step of rotation. */
const DRAG_STEP = 22;

const DIRECTIONS = ["south", "south-east", "east", "north-east", "north", "north-west", "west", "south-west"];

const SUBJECTS = [
  { id: "knight", label: "Dark knight" },
  { id: "hero", label: "Bare base" },
] as const;

const MODES = [
  { id: "redrawn", label: "Redrawn" },
  { id: "model", label: "Raw model" },
] as const;

type SubjectId = (typeof SUBJECTS)[number]["id"];
type ModeId = (typeof MODES)[number]["id"];

function subscribeQuery(query: string) {
  return (callback: () => void) => {
    const list = window.matchMedia(query);
    list.addEventListener("change", callback);
    return () => list.removeEventListener("change", callback);
  };
}
const subscribeReducedMotion = subscribeQuery("(prefers-reduced-motion: reduce)");
const subscribeNarrow = subscribeQuery("(max-width: 480px)");

/**
 * Turn a character through sixteen directions. Eight were drawn by the
 * generator; the eight between them come from a 3D model carved out of those
 * eight, rendered from the missing angles and redrawn by an image model.
 * "Raw model" shows the render before the redraw, at every angle.
 */
export function SpinViewer() {
  const [subject, setSubject] = useState<SubjectId>("knight");
  const [mode, setMode] = useState<ModeId>("redrawn");
  const [frame, setFrame] = useState(0);
  const [spinning, setSpinning] = useState(false);
  const drag = useRef<{ x: number; frame: number } | null>(null);
  const reducedMotion = useSyncExternalStore(
    subscribeReducedMotion,
    () => window.matchMedia("(prefers-reduced-motion: reduce)").matches,
    () => false,
  );
  const narrow = useSyncExternalStore(
    subscribeNarrow,
    () => window.matchMedia("(max-width: 480px)").matches,
    () => false,
  );
  const scale = narrow ? 3 : 4;

  useEffect(() => {
    if (!spinning || reducedMotion) return;
    const timer = setInterval(() => setFrame((current) => (current + 1) % FRAMES), 1000 / SPIN_FPS);
    return () => clearInterval(timer);
  }, [spinning, reducedMotion]);

  // Fetch the strips that are not showing, so switching does not flash.
  useEffect(() => {
    const timer = setTimeout(() => {
      for (const s of SUBJECTS) for (const m of MODES) new Image().src = `/sprites/spin/${s.id}.${m.id}.png`;
    }, 1500);
    return () => clearTimeout(timer);
  }, []);

  const turn = useCallback((delta: number) => {
    setSpinning(false);
    setFrame((current) => (current + delta + FRAMES) % FRAMES);
  }, []);

  const onPointerDown = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    event.currentTarget.setPointerCapture(event.pointerId);
    drag.current = { x: event.clientX, frame };
    setSpinning(false);
  }, [frame]);

  const onPointerMove = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    if (!drag.current) return;
    const steps = Math.round((event.clientX - drag.current.x) / DRAG_STEP);
    setFrame((((drag.current.frame + steps) % FRAMES) + FRAMES) % FRAMES);
  }, []);

  const onPointerUp = useCallback(() => { drag.current = null; }, []);

  const drawn = frame % 2 === 0;
  const direction = drawn
    ? DIRECTIONS[frame / 2]!
    : `between ${DIRECTIONS[(frame - 1) / 2]!} and ${DIRECTIONS[((frame + 1) / 2) % 8]!}`;
  const source = mode === "model"
    ? "rendered from the carved 3D model, untouched"
    : drawn
      ? "drawn by the generator"
      : "rendered from the 3D model, then redrawn";
  const cell = CELL * scale;
  const stage = {
    "--spin-cell": `${cell}px`,
    "--spin-size": `${FRAMES * cell}px ${cell}px`,
    "--spin-at": `${-frame * cell}px 0`,
    backgroundImage: `url(/sprites/spin/${subject}.${mode}.png)`,
  } as CSSProperties;
  const subjectLabel = SUBJECTS.find((s) => s.id === subject)!.label.toLowerCase();

  return (
    <div className="spin">
      <div className="spin-stage-column">
        <div
          className="spin-stage"
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerUp}
        >
          <div className="spin-figure" style={stage} role="img" aria-label={`The ${subjectLabel} facing ${direction}, ${source}`} />
        </div>
        <div className="builder-motion">
          <button type="button" className="builder-arrow" onClick={() => turn(-1)} aria-label="Turn left">‹</button>
          <button type="button" className="builder-toggle" aria-pressed={spinning} onClick={() => setSpinning((current) => !current)}>
            {spinning ? "Stop" : "Spin"}
          </button>
          <button type="button" className="builder-arrow" onClick={() => turn(1)} aria-label="Turn right">›</button>
        </div>
        <p className="builder-readout" aria-live="polite">
          <span>{frame + 1} of {FRAMES}</span> Facing {direction}: {source}.
        </p>
      </div>
      <div className="builder-controls">
        <div className="builder-slot" role="group" aria-label="Character">
          <span className="builder-slot-label">Character</span>
          <div className="builder-options">
            {SUBJECTS.map((option) => (
              <button key={option.id} type="button" className="builder-option" aria-pressed={subject === option.id} onClick={() => setSubject(option.id)}>
                {option.label}
              </button>
            ))}
          </div>
        </div>
        <div className="builder-slot" role="group" aria-label="What is shown">
          <span className="builder-slot-label">Show</span>
          <div className="builder-options">
            {MODES.map((option) => (
              <button key={option.id} type="button" className="builder-option" aria-pressed={mode === option.id} onClick={() => setMode(option.id)}>
                {option.label}
              </button>
            ))}
          </div>
        </div>
        <p className="spin-note">
          Drag the figure, or use the arrows. Every second direction was drawn
          by the generator. The ones between are new: the eight drawn views are
          carved into a 3D model, the model is rendered from the missing
          angle, and an image model redraws that rough render as a clean
          sprite. Raw model shows the render before the redraw.
        </p>
      </div>
    </div>
  );
}
