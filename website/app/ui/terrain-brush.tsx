"use client";

/* eslint-disable @next/next/no-img-element -- pixel art at its own size; next/image would resample it. */

import { useCallback, useRef, useState } from "react";
import type { KeyboardEvent, PointerEvent } from "react";
import { COAST_TERRAINS, COAST_TILES } from "@/app/lib/coast-tiles";

/** Tiles across and down. The painted values are the corners between tiles, one more each way. */
const TILES_X = 10;
const TILES_Y = 7;
const CORNERS_X = TILES_X + 1;
const CORNERS_Y = TILES_Y + 1;

const OCEAN = 0;
const SAND = 1;
const GRASS = 2;
const LABEL = ["Ocean", "Sand", "Grass"];

/**
 * Keep every tile one the sets have. Ocean and grass share no set, so no tile
 * has both: when a tile would, the corners of the other terrain become sand,
 * which is the surface that does join each of them. Sand never conflicts, so
 * one pass over the tiles around a painted corner is enough.
 */
function settle(corners: number[], x: number, y: number): number[] {
  const painted = corners[y * CORNERS_X + x]!;
  if (painted === SAND) return corners;
  const clash = painted === OCEAN ? GRASS : OCEAN;
  let next = corners;
  for (const ty of [y - 1, y]) {
    for (const tx of [x - 1, x]) {
      if (tx < 0 || ty < 0 || tx >= TILES_X || ty >= TILES_Y) continue;
      for (const [cx, cy] of [[tx, ty], [tx + 1, ty], [tx, ty + 1], [tx + 1, ty + 1]] as const) {
        if (next[cy * CORNERS_X + cx] !== clash) continue;
        if (next === corners) next = corners.slice();
        next[cy * CORNERS_X + cx] = SAND;
      }
    }
  }
  return next;
}

/** An island with a beach, so the first look is a map and not a blank. */
function starting(): number[] {
  const corners: number[] = [];
  for (let y = 0; y < CORNERS_Y; y++) {
    for (let x = 0; x < CORNERS_X; x++) {
      const beach = ((x - 5) / 4.4) ** 2 + ((y - 3.5) / 2.9) ** 2 < 1;
      const meadow = ((x - 5) / 2.6) ** 2 + ((y - 3.4) / 1.5) ** 2 < 1;
      corners.push(meadow ? GRASS : beach ? SAND : OCEAN);
    }
  }
  return corners;
}

const tileAt = (corners: number[], x: number, y: number) =>
  COAST_TILES[
    [
      corners[y * CORNERS_X + x],
      corners[y * CORNERS_X + x + 1],
      corners[(y + 1) * CORNERS_X + x],
      corners[(y + 1) * CORNERS_X + x + 1],
    ].join(",")
  ];

/**
 * Paint ocean, sand or grass on the corners and every tile picks itself from
 * the four around it. The tiles are the 32 of two real connected sets (ocean
 * to sand, sand to grass), and the pick is a lookup: the same corner table the
 * merged export writes into Tiled, Godot and LDtk.
 */
export function TerrainBrush() {
  const [corners, setCorners] = useState<number[]>(starting);
  const [brush, setBrush] = useState(GRASS);
  const [cursor, setCursor] = useState<{ x: number; y: number } | null>(null);
  const [said, setSaid] = useState("");
  const map = useRef<HTMLDivElement>(null);
  const painting = useRef(false);

  const paint = useCallback(
    (x: number, y: number) => {
      setCorners((previous) => {
        if (previous[y * CORNERS_X + x] === brush) return previous;
        const next = previous.slice();
        next[y * CORNERS_X + x] = brush;
        return settle(next, x, y);
      });
    },
    [brush],
  );

  /** The corner nearest a pointer, as the column and row it is on. */
  const cornerAt = (event: PointerEvent) => {
    const box = map.current!.getBoundingClientRect();
    const x = Math.round(((event.clientX - box.left) / box.width) * TILES_X);
    const y = Math.round(((event.clientY - box.top) / box.height) * TILES_Y);
    return { x: Math.min(TILES_X, Math.max(0, x)), y: Math.min(TILES_Y, Math.max(0, y)) };
  };

  const down = (event: PointerEvent) => {
    painting.current = true;
    event.currentTarget.setPointerCapture(event.pointerId);
    const { x, y } = cornerAt(event);
    paint(x, y);
  };
  const move = (event: PointerEvent) => {
    if (!painting.current) return;
    const { x, y } = cornerAt(event);
    paint(x, y);
  };
  const up = () => {
    painting.current = false;
  };

  const key = (event: KeyboardEvent) => {
    const at = cursor ?? { x: 0, y: 0 };
    const step: Record<string, [number, number]> = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };
    const delta = step[event.key];
    if (delta) {
      event.preventDefault();
      setCursor({ x: Math.min(TILES_X, Math.max(0, at.x + delta[0])), y: Math.min(TILES_Y, Math.max(0, at.y + delta[1])) });
    } else if (event.key === " " || event.key === "Enter") {
      event.preventDefault();
      paint(at.x, at.y);
      setSaid(`Corner ${at.x + 1}, ${at.y + 1} is ${COAST_TERRAINS[brush]}`);
    }
  };

  const tiles = [];
  for (let y = 0; y < TILES_Y; y++) {
    for (let x = 0; x < TILES_X; x++) {
      tiles.push(<img key={`${x}-${y}`} src={tileAt(corners, x, y)} alt="" width={32} height={32} draggable={false} />);
    }
  }

  const dots = [];
  for (let y = 0; y < CORNERS_Y; y++) {
    for (let x = 0; x < CORNERS_X; x++) {
      dots.push(
        <span
          key={`${x}-${y}`}
          className={`brush-dot brush-dot-${corners[y * CORNERS_X + x]}${cursor && cursor.x === x && cursor.y === y ? " brush-dot-cursor" : ""}`}
          style={{ left: `${(x / TILES_X) * 100}%`, top: `${(y / TILES_Y) * 100}%` }}
        />,
      );
    }
  }

  return (
    <div className="tiles-brush">
      <div className="tiles-brush-bar" role="group" aria-label="Brush">
        <b className="tiles-brush-title">Paint it yourself.</b>
        {LABEL.map((label, value) => (
          <button key={label} type="button" className="builder-toggle brush-choice" aria-pressed={brush === value} onClick={() => setBrush(value)}>
            <i className={`brush-swatch brush-dot-${value}`} aria-hidden="true" />
            {label}
          </button>
        ))}
        <button type="button" className="builder-action" onClick={() => setCorners(starting())}>Reset</button>
        <button type="button" className="builder-action" onClick={() => setCorners(new Array(CORNERS_X * CORNERS_Y).fill(OCEAN))}>Clear</button>
      </div>
      <div
        ref={map}
        className="tiles-brush-map"
        style={{ gridTemplateColumns: `repeat(${TILES_X}, 1fr)`, aspectRatio: `${TILES_X} / ${TILES_Y}` }}
        tabIndex={0}
        role="application"
        aria-label="Terrain brush. Arrow keys move between corners, Space paints the corner."
        onPointerDown={down}
        onPointerMove={move}
        onPointerUp={up}
        onPointerCancel={up}
        onKeyDown={key}
        onFocus={() => setCursor((at) => at ?? { x: 0, y: 0 })}
        onBlur={() => setCursor(null)}
      >
        {tiles}
        {dots}
      </div>
      <p className="tiles-brush-caption" aria-live="polite">
        Click or drag to paint a corner dot. Each tile is chosen by the four dots around it, from the 32 tiles of two
        connected sets. No set joins ocean to grass, so painting one beside the other leaves sand between them.
        <span className="sr-only">{said}</span>
      </p>
    </div>
  );
}
