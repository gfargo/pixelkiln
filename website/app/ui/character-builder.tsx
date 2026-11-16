"use client";

import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from "react";
import type { CSSProperties } from "react";
import {
  BUILDER_ALWAYS,
  BUILDER_CELL,
  BUILDER_COLUMNS,
  BUILDER_DIRECTIONS,
  BUILDER_DRAW_ORDER,
  BUILDER_LOOKS,
  BUILDER_ROWS,
  BUILDER_SLOTS,
  BUILDER_WALK_FPS,
  BUILDER_WALK_FRAMES,
  BUILDER_WALK_ROWS,
  builderAtlas,
} from "@/app/lib/paperdoll-builder";

type Choices = Record<string, string | null>;

const lookChoices = (wears: Record<string, string>): Choices =>
  Object.fromEntries(BUILDER_SLOTS.map((slot) => [slot.id, wears[slot.id] ?? null]));

const INITIAL: Choices = lookChoices(BUILDER_LOOKS[0]!.wears);

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
 * Dress one character from separately generated layers, turn it, and walk it.
 * Nothing here is composited ahead of time: each chosen layer is its own
 * atlas, stacked in order and stepped to the same cell, which is all a game
 * does with the files PixelKiln writes.
 */
export function CharacterBuilder() {
  const [choices, setChoices] = useState<Choices>(INITIAL);
  const [facing, setFacing] = useState(0);
  const [walking, setWalking] = useState(false);
  const [frame, setFrame] = useState(0);
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

  const direction = BUILDER_DIRECTIONS[facing]!;
  const walkRow = BUILDER_WALK_ROWS[direction];
  const moving = walking && walkRow !== undefined;

  useEffect(() => {
    if (!moving || reducedMotion) return;
    const timer = setInterval(() => setFrame((current) => (current + 1) % BUILDER_WALK_FRAMES), 1000 / BUILDER_WALK_FPS);
    return () => clearInterval(timer);
  }, [moving, reducedMotion]);

  // Fetch every atlas once the page is idle, so the first click on an option does not flash.
  useEffect(() => {
    const ids = BUILDER_SLOTS.flatMap((slot) => slot.options.map((option) => option.id));
    const load = () => ids.forEach((id) => { new Image().src = builderAtlas(id); });
    const timer = setTimeout(load, 1500);
    return () => clearTimeout(timer);
  }, []);

  // The walk exists in four directions, so a walking character turns a quarter at a time.
  const turn = useCallback((delta: number) => {
    setFacing((current) => {
      const step = walking ? 2 : 1;
      const snapped = walking ? Math.round(current / 2) * 2 : current;
      return (snapped + delta * step + BUILDER_DIRECTIONS.length) % BUILDER_DIRECTIONS.length;
    });
  }, [walking]);

  const toggleWalk = useCallback(() => {
    setWalking((current) => {
      if (!current) setFacing((value) => (Math.round(value / 2) * 2) % BUILDER_DIRECTIONS.length);
      return !current;
    });
    setFrame(0);
  }, []);

  const choose = useCallback((slot: string, option: string) => {
    setChoices((current) => ({ ...current, [slot]: current[slot] === option ? null : option }));
  }, []);

  const shuffle = useCallback(() => {
    setChoices(Object.fromEntries(BUILDER_SLOTS.map((slot) => {
      const pool: Array<string | null> = [null, ...slot.options.map((option) => option.id)];
      return [slot.id, pool[Math.floor(Math.random() * pool.length)] ?? null];
    })));
  }, []);

  const strip = useCallback(() => {
    setChoices(Object.fromEntries(BUILDER_SLOTS.map((slot) => [slot.id, null])));
  }, []);

  const worn = useMemo(
    () => BUILDER_DRAW_ORDER.map((slot) => choices[slot]).filter((id): id is string => Boolean(id)),
    [choices],
  );
  const layers = [...BUILDER_ALWAYS, ...worn];

  const column = moving ? (reducedMotion ? 0 : frame) : facing;
  const row = moving ? walkRow! : 0;
  const cell = BUILDER_CELL * scale;
  const stage = {
    "--builder-cell": `${cell}px`,
    "--builder-size": `${BUILDER_COLUMNS * cell}px ${BUILDER_ROWS * cell}px`,
    "--builder-at": `${-column * cell}px ${-row * cell}px`,
  } as CSSProperties;

  const description = `The character facing ${direction}${moving ? ", walking" : ""}, wearing ${
    worn.length ? worn.map((id) => id.replace("hero.", "")).join(", ") : "nothing but the base"
  }`;

  return (
    <div className="builder">
      <div className="builder-stage-column">
        <div className="builder-stage" style={stage}>
          <div className="builder-figure" role="img" aria-label={description}>
            {layers.map((id) => (
              <div key={id} className="builder-layer" style={{ backgroundImage: `url(${builderAtlas(id)})` }} />
            ))}
          </div>
        </div>
        <div className="builder-motion">
          <button type="button" className="builder-arrow" onClick={() => turn(1)} aria-label="Turn left">‹</button>
          <button type="button" className="builder-toggle" aria-pressed={walking} onClick={toggleWalk}>
            {walking ? "Stand" : "Walk"}
          </button>
          <button type="button" className="builder-arrow" onClick={() => turn(-1)} aria-label="Turn right">›</button>
        </div>
        <p className="builder-readout" aria-live="polite">
          <span>{layers.length} layers</span> {layers.join(" + ")}
        </p>
      </div>
      <div className="builder-controls">
        {BUILDER_SLOTS.map((slot) => (
          <div key={slot.id} className="builder-slot" role="group" aria-label={slot.label}>
            <span className="builder-slot-label">{slot.label}</span>
            <div className="builder-options">
              {slot.options.map((option) => (
                <button
                  key={option.id}
                  type="button"
                  className="builder-option"
                  aria-pressed={choices[slot.id] === option.id}
                  onClick={() => choose(slot.id, option.id)}
                >
                  {option.label}
                  <small>{option.made}</small>
                </button>
              ))}
            </div>
          </div>
        ))}
        <div className="builder-slot" role="group" aria-label="Looks">
          <span className="builder-slot-label">Looks</span>
          <div className="builder-options">
            {BUILDER_LOOKS.map((look) => (
              <button key={look.id} type="button" className="builder-action" onClick={() => setChoices(lookChoices(look.wears))}>
                {look.label}
              </button>
            ))}
          </div>
        </div>
        <div className="builder-actions">
          <button type="button" className="builder-action" onClick={shuffle}>Shuffle</button>
          <button type="button" className="builder-action" onClick={strip}>Take it all off</button>
        </div>
      </div>
    </div>
  );
}
