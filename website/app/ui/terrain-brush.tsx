"use client";

/* eslint-disable @next/next/no-img-element -- pixel art at its own size; next/image would resample it. */

import { useCallback, useRef, useState } from "react";
import type { KeyboardEvent, PointerEvent } from "react";

/**
 * The 16 tiles of one real terrain set, by the mask each was drawn for. A mask
 * is four bits, one per corner of the tile: NW, NE, SW, SE are bits 3, 2, 1, 0,
 * and a set bit means grass. This is the table an engine's terrain brush is
 * given, and the export writes it into Tiled, Godot and LDtk.
 */
const TILE_FOR_MASK: Record<number, string> = {
  0: "06-wang-0", 1: "07-wang-1", 2: "10-wang-2", 3: "09-wang-3",
  4: "02-wang-4", 5: "11-wang-5", 6: "04-wang-6", 7: "15-wang-7",
  8: "05-wang-8", 9: "14-wang-9", 10: "01-wang-10", 11: "08-wang-11",
  12: "03-wang-12", 13: "00-wang-13", 14: "13-wang-14", 15: "12-wang-15",
};
const tileSrc = (mask: number) => `/showcase/tilesets/lake-grass-tile-${TILE_FOR_MASK[mask]}.png`;

/** Tiles across and down. The painted values are the corners between tiles, one more each way. */
const TILES_X = 10;
const TILES_Y = 7;
const CORNERS_X = TILES_X + 1;
const CORNERS_Y = TILES_Y + 1;

/** An island with a pond, so the first look is a map and not a blank. */
function starting(): boolean[] {
  const corners: boolean[] = [];
  for (let y = 0; y < CORNERS_Y; y++) {
    for (let x = 0; x < CORNERS_X; x++) {
      const island = ((x - 5) / 3.6) ** 2 + ((y - 3.5) / 2.9) ** 2 < 1;
      const pond = ((x - 5.5) / 1.1) ** 2 + ((y - 3.4) / 0.9) ** 2 < 1;
      corners.push(island && !pond);
    }
  }
  return corners;
}

type Brush = "grass" | "water";

/**
 * Paint grass or water on the corners and every tile picks itself from the
 * four around it. Nothing is computed beyond the lookup: the same 16 tiles,
 * chosen by the same mask, as the files `export` writes.
 */
export function TerrainBrush() {
  const [corners, setCorners] = useState<boolean[]>(starting);
  const [brush, setBrush] = useState<Brush>("grass");
  const [cursor, setCursor] = useState<{ x: number; y: number } | null>(null);
  const [said, setSaid] = useState("");
  const map = useRef<HTMLDivElement>(null);
  const painting = useRef(false);

  const set = useCallback((x: number, y: number, grass: boolean) => {
    setCorners((previous) => {
      const at = y * CORNERS_X + x;
      if (previous[at] === grass) return previous;
      const next = previous.slice();
      next[at] = grass;
      return next;
    });
  }, []);

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
    set(x, y, brush === "grass");
  };
  const move = (event: PointerEvent) => {
    if (!painting.current) return;
    const { x, y } = cornerAt(event);
    set(x, y, brush === "grass");
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
      set(at.x, at.y, brush === "grass");
      setSaid(`Corner ${at.x + 1}, ${at.y + 1} is ${brush}`);
    }
  };

  const tiles = [];
  for (let y = 0; y < TILES_Y; y++) {
    for (let x = 0; x < TILES_X; x++) {
      const mask =
        (corners[y * CORNERS_X + x] ? 8 : 0) |
        (corners[y * CORNERS_X + x + 1] ? 4 : 0) |
        (corners[(y + 1) * CORNERS_X + x] ? 2 : 0) |
        (corners[(y + 1) * CORNERS_X + x + 1] ? 1 : 0);
      tiles.push(<img key={`${x}-${y}`} src={tileSrc(mask)} alt="" width={32} height={32} draggable={false} />);
    }
  }

  const dots = [];
  for (let y = 0; y < CORNERS_Y; y++) {
    for (let x = 0; x < CORNERS_X; x++) {
      dots.push(
        <span
          key={`${x}-${y}`}
          className={`brush-dot${corners[y * CORNERS_X + x] ? " brush-dot-grass" : ""}${cursor && cursor.x === x && cursor.y === y ? " brush-dot-cursor" : ""}`}
          style={{ left: `${(x / TILES_X) * 100}%`, top: `${(y / TILES_Y) * 100}%` }}
        />,
      );
    }
  }

  return (
    <div className="tiles-brush">
      <div className="tiles-brush-bar" role="group" aria-label="Brush">
        <b className="tiles-brush-title">Paint it yourself.</b>
        <button type="button" className="builder-toggle" aria-pressed={brush === "grass"} onClick={() => setBrush("grass")}>Grass</button>
        <button type="button" className="builder-toggle" aria-pressed={brush === "water"} onClick={() => setBrush("water")}>Water</button>
        <button type="button" className="builder-action" onClick={() => setCorners(starting())}>Reset</button>
        <button type="button" className="builder-action" onClick={() => setCorners(new Array(CORNERS_X * CORNERS_Y).fill(false))}>Clear</button>
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
        Click or drag to paint a corner dot. Each tile is chosen by the four dots around it, and sixteen tiles cover every combination.
        <span className="sr-only">{said}</span>
      </p>
    </div>
  );
}
