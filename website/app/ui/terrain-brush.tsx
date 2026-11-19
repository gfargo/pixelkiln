"use client";

/* eslint-disable @next/next/no-img-element -- pixel art at its own size; next/image would resample it. */

import { useCallback, useMemo, useRef, useState } from "react";
import type { KeyboardEvent, PointerEvent } from "react";
import { BRUSH_SETS } from "@/app/lib/brush-tilesets";
import type { BrushSet } from "@/app/lib/brush-tilesets";

/** Cells across and down, by shape. A corner set paints the corners between cells, one more each way. */
function gridFor(set: BrushSet): { x: number; y: number } {
  if (set.iso) return { x: 10, y: 10 };
  return set.tile.w >= 64 ? { x: 8, y: 6 } : { x: 10, y: 7 };
}

/**
 * Where everything sits on the stage, in the tile art's own pixels. A square set is a plain
 * grid. An isometric one puts vertex (vx, vy) at ((vx - vy) * fw / 2, (vx + vy) * fh / 2), so
 * a cell's top corner is the vertex with its own coordinates, and its right, left and bottom
 * corners are the vertices one over, one down, and one over and down: the same NW, NE, SW and
 * SE as a square tile has.
 */
function layoutFor(set: BrushSet) {
  const { x: cols, y: rows } = gridFor(set);
  const { w, h } = set.tile;
  if (!set.iso) {
    return {
      cols, rows, width: cols * w, height: rows * h,
      vertex: (vx: number, vy: number) => ({ x: vx * w, y: vy * h }),
      tileAt: (x: number, y: number) => ({ x: x * w, y: y * h }),
      toVertex: (px: number, py: number) => ({ x: px / w, y: py / h }),
    };
  }
  const { fw, fh, fx, fy } = set.iso;
  const originX = (rows * fw) / 2 + fx;
  const originY = fy;
  const vertex = (vx: number, vy: number) => ({ x: originX + ((vx - vy) * fw) / 2, y: originY + ((vx + vy) * fh) / 2 });
  // The image hangs from the diamond: its left edge is the diamond's less where the diamond sits in it.
  const tileAt = (x: number, y: number) => {
    const top = vertex(x, y);
    return { x: top.x - fw / 2 - fx, y: top.y - fy };
  };
  const width = originX + (cols * fw) / 2 + Math.max(w - fw - fx, 0) + 6;
  const height = Math.max(originY + ((cols + rows) * fh) / 2 + 6, originY - fy + ((cols + rows - 2) * fh) / 2 + h);
  return {
    cols, rows, width, height, vertex, tileAt,
    toVertex: (px: number, py: number) => {
      const u = (px - originX) / (fw / 2);
      const v = (py - originY) / (fh / 2);
      return { x: (u + v) / 2, y: (v - u) / 2 };
    },
  };
}

/** Which terrains share a tile, and for two that never do, the terrain that sits between them. */
function neighbours(set: BrushSet) {
  const n = set.terrains.length;
  const joins = Array.from({ length: n }, () => new Array<boolean>(n).fill(false));
  for (const key of Object.keys(set.tiles)) {
    if (set.mode !== "corner") break;
    const parts = key.split(",").map(Number);
    for (const a of parts) for (const b of parts) joins[a]![b] = true;
  }
  /** The step from `from` toward `to` along terrains that do share tiles. */
  const step = (from: number, to: number): number => {
    const seen = new Set([from]);
    let frontier = [[from, from]] as Array<[number, number]>;
    while (frontier.length) {
      const next: Array<[number, number]> = [];
      for (const [at, first] of frontier) {
        for (let other = 0; other < n; other++) {
          if (seen.has(other) || !joins[at]![other]) continue;
          if (other === to) return at === from ? other : first;
          seen.add(other);
          next.push([other, at === from ? other : first]);
        }
      }
      frontier = next;
    }
    return from;
  };
  return { joins, step };
}

/** An island with a beach, so the first look is a map and not a blank. */
function starting(set: BrushSet): number[] {
  const { x: cols, y: rows } = gridFor(set);
  if (set.mode === "edge") {
    const cells = new Array<number>(cols * rows).fill(1);
    const road = (x: number, y: number) => { cells[y * cols + x] = 0; };
    for (let x = 1; x < cols - 1; x++) road(x, 3);
    for (let y = 3; y < rows - 1; y++) road(5, y);
    for (let x = 2; x < 5; x++) road(x, 6);
    for (let y = 5; y < 7; y++) road(2, y);
    return cells;
  }
  const n = set.terrains.length;
  const radii = n >= 3 ? [0.44, 0.26] : [0.4];
  const corners: number[] = [];
  for (let y = 0; y <= rows; y++) {
    for (let x = 0; x <= cols; x++) {
      let terrain = 0;
      radii.forEach((radius, index) => {
        const a = (x - cols / 2) / (cols * radius);
        const b = (y - rows / 2) / (rows * radius * (set.iso ? 1 : 0.94));
        if (a * a + b * b < 1) terrain = index + 1;
      });
      corners.push(terrain);
    }
  }
  return corners;
}

/** The tile for a corner pattern, or the nearest one the set has when it has none for exactly that. */
function pick(set: BrushSet, key: string): string {
  const exact = set.tiles[key];
  if (exact) return exact;
  const want = key.split(",");
  let best = "";
  let bestScore = 5;
  for (const [candidate, url] of Object.entries(set.tiles)) {
    const have = candidate.split(",");
    if (have.length !== 4) continue;
    const score = have.filter((value, index) => value !== want[index]).length;
    if (score < bestScore) { best = url; bestScore = score; }
  }
  return best || Object.values(set.tiles)[0]!;
}

/** A road cell's tile: the sides it shares with a neighbouring road cell (north, east, south, west). */
function roadTile(set: BrushSet, cells: number[], cols: number, rows: number, x: number, y: number): string {
  const road = (cx: number, cy: number) => cx >= 0 && cy >= 0 && cx < cols && cy < rows && cells[cy * cols + cx] === 0;
  if (!road(x, y)) return set.tiles["0"]!;
  const mask = (road(x, y - 1) ? 1 : 0) | (road(x + 1, y) ? 2 : 0) | (road(x, y + 1) ? 4 : 0) | (road(x - 1, y) ? 8 : 0);
  return mask === 0 ? set.tiles.solid ?? set.tiles["0"]! : set.tiles[String(mask)]!;
}

/**
 * Paint a terrain and every tile picks itself from the rules PixelLab returned with the set:
 * the same table the exports write into Tiled, Godot and LDtk. A corner set paints the
 * corners between tiles. A road paints cells, and each tile reads which of its four sides
 * the road crosses.
 */
export function TerrainBrush() {
  const [setId, setSetId] = useState(BRUSH_SETS[0]!.id);
  const set = BRUSH_SETS.find((candidate) => candidate.id === setId)!;
  const [maps, setMaps] = useState<Record<string, number[]>>({});
  const [brush, setBrush] = useState(1);
  const [cursor, setCursor] = useState<{ x: number; y: number } | null>(null);
  const [said, setSaid] = useState("");
  const map = useRef<HTMLDivElement>(null);
  const painting = useRef(false);

  const layout = useMemo(() => layoutFor(set), [set]);
  const joins = useMemo(() => neighbours(set), [set]);
  const edge = set.mode === "edge";
  const { cols, rows } = layout;
  const across = edge ? cols : cols + 1;
  const down = edge ? rows : rows + 1;
  const values = maps[set.id] ?? starting(set);
  const activeBrush = Math.min(brush, set.terrains.length - 1);

  const update = useCallback(
    (change: (previous: number[]) => number[]) => setMaps((all) => ({ ...all, [set.id]: change(all[set.id] ?? starting(set)) })),
    [set],
  );

  /** Keep every tile one the set has: a terrain no set joins to the painted one becomes the one between. */
  const settle = useCallback(
    (cells: number[], x: number, y: number): number[] => {
      const painted = cells[y * across + x]!;
      let next = cells;
      for (const ty of [y - 1, y]) {
        for (const tx of [x - 1, x]) {
          if (tx < 0 || ty < 0 || tx >= cols || ty >= rows) continue;
          for (const [cx, cy] of [[tx, ty], [tx + 1, ty], [tx, ty + 1], [tx + 1, ty + 1]] as const) {
            const other = next[cy * across + cx]!;
            if (other === painted || joins.joins[painted]![other]) continue;
            if (next === cells) next = cells.slice();
            next[cy * across + cx] = joins.step(other, painted);
          }
        }
      }
      return next;
    },
    [across, cols, rows, joins],
  );

  const paint = useCallback(
    (x: number, y: number) => {
      update((previous) => {
        if (previous[y * across + x] === activeBrush) return previous;
        const next = previous.slice();
        next[y * across + x] = activeBrush;
        return edge ? next : settle(next, x, y);
      });
    },
    [update, across, activeBrush, edge, settle],
  );

  /** The corner (or, for a road, the cell) under a pointer. */
  const pointAt = (event: PointerEvent) => {
    const box = map.current!.getBoundingClientRect();
    const px = ((event.clientX - box.left) / box.width) * layout.width;
    const py = ((event.clientY - box.top) / box.height) * layout.height;
    const at = layout.toVertex(px, py);
    const round = edge ? Math.floor : Math.round;
    return {
      x: Math.min(across - 1, Math.max(0, round(at.x))),
      y: Math.min(down - 1, Math.max(0, round(at.y))),
    };
  };

  const last = useRef<{ x: number; y: number } | null>(null);
  /** Paint from where the pointer was to where it is, so a fast stroke leaves no gaps. */
  const stroke = (to: { x: number; y: number }) => {
    const from = last.current ?? to;
    const steps = Math.max(Math.abs(to.x - from.x), Math.abs(to.y - from.y), 1);
    for (let i = 1; i <= steps; i++) {
      paint(Math.round(from.x + ((to.x - from.x) * i) / steps), Math.round(from.y + ((to.y - from.y) * i) / steps));
    }
    last.current = to;
  };

  const down_ = (event: PointerEvent) => {
    painting.current = true;
    last.current = null;
    event.currentTarget.setPointerCapture(event.pointerId);
    stroke(pointAt(event));
  };
  const move = (event: PointerEvent) => {
    if (!painting.current) return;
    stroke(pointAt(event));
  };
  const up = () => {
    painting.current = false;
    last.current = null;
  };

  const key = (event: KeyboardEvent) => {
    const at = cursor ?? { x: 0, y: 0 };
    const step: Record<string, [number, number]> = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };
    const delta = step[event.key];
    if (delta) {
      event.preventDefault();
      setCursor({ x: Math.min(across - 1, Math.max(0, at.x + delta[0])), y: Math.min(down - 1, Math.max(0, at.y + delta[1])) });
    } else if (event.key === " " || event.key === "Enter") {
      event.preventDefault();
      paint(at.x, at.y);
      setSaid(`${edge ? "Cell" : "Corner"} ${at.x + 1}, ${at.y + 1} is ${set.terrains[activeBrush]!.label}`);
    }
  };

  const percentX = (px: number) => `${(px / layout.width) * 100}%`;
  const percentY = (py: number) => `${(py / layout.height) * 100}%`;

  // Draw back to front: on a diamond grid a tile in front covers the tile behind.
  const tiles = [];
  const order: Array<[number, number]> = [];
  for (let y = 0; y < rows; y++) for (let x = 0; x < cols; x++) order.push([x, y]);
  if (set.iso) order.sort((a, b) => a[0] + a[1] - (b[0] + b[1]));
  for (const [x, y] of order) {
    const src = edge
      ? roadTile(set, values, cols, rows, x, y)
      : pick(set, [values[y * across + x], values[y * across + x + 1], values[(y + 1) * across + x], values[(y + 1) * across + x + 1]].join(","));
    const at = layout.tileAt(x, y);
    tiles.push(
      <img
        key={`${x}-${y}`}
        src={src}
        alt=""
        width={set.tile.w}
        height={set.tile.h}
        draggable={false}
        style={{ left: percentX(at.x), top: percentY(at.y), width: percentX(set.tile.w) }}
      />,
    );
  }

  const marks = [];
  const lookAt = (x: number, y: number) => (edge ? layout.vertex(x + 0.5, y + 0.5) : layout.vertex(x, y));
  if (!edge) {
    for (let y = 0; y < down; y++) {
      for (let x = 0; x < across; x++) {
        const at = lookAt(x, y);
        marks.push(
          <span
            key={`${x}-${y}`}
            className={`brush-dot${cursor && cursor.x === x && cursor.y === y ? " brush-dot-cursor" : ""}`}
            style={{ left: percentX(at.x), top: percentY(at.y), background: set.terrains[values[y * across + x]!]!.color }}
          />,
        );
      }
    }
  } else if (cursor) {
    const at = lookAt(cursor.x, cursor.y);
    marks.push(<span key="cursor" className="brush-dot brush-dot-cursor" style={{ left: percentX(at.x), top: percentY(at.y), background: "transparent" }} />);
  }

  const choose = (id: string) => {
    setSetId(id);
    setCursor(null);
    setBrush(BRUSH_SETS.find((candidate) => candidate.id === id)!.mode === "edge" ? 0 : 1);
  };

  return (
    <div className="tiles-brush">
      <div className="tiles-brush-bar" role="group" aria-label="Tileset">
        <b className="tiles-brush-title">Paint it yourself.</b>
        {BRUSH_SETS.map((candidate) => (
          <button key={candidate.id} type="button" className="builder-toggle" aria-pressed={candidate.id === set.id} onClick={() => choose(candidate.id)}>
            {candidate.name}
          </button>
        ))}
      </div>
      <div className="tiles-brush-bar tiles-brush-bar-brush" role="group" aria-label="Brush">
        {set.terrains.map((terrain, value) => (
          <button key={terrain.label} type="button" className="builder-toggle brush-choice" aria-pressed={activeBrush === value} onClick={() => setBrush(value)}>
            <i className="brush-swatch" style={{ background: terrain.color }} aria-hidden="true" />
            {terrain.label}
          </button>
        ))}
        <button type="button" className="builder-action" onClick={() => update(() => starting(set))}>Reset</button>
        <button
          type="button"
          className="builder-action"
          onClick={() => update(() => new Array(across * down).fill(edge ? 1 : 0))}
        >
          Clear
        </button>
      </div>
      <div
        ref={map}
        className="tiles-brush-map"
        style={{ aspectRatio: `${layout.width} / ${layout.height}`, maxWidth: set.iso ? 640 : 760 }}
        tabIndex={0}
        role="application"
        aria-label={edge ? "Road brush. Arrow keys move between cells, Space paints the cell." : "Terrain brush. Arrow keys move between corners, Space paints the corner."}
        onPointerDown={down_}
        onPointerMove={move}
        onPointerUp={up}
        onPointerCancel={up}
        onKeyDown={key}
        onFocus={() => setCursor((at) => at ?? { x: 0, y: 0 })}
        onBlur={() => setCursor(null)}
      >
        {tiles}
        {marks}
      </div>
      <p className="tiles-brush-caption" aria-live="polite">
        {set.blurb}{" "}
        {edge
          ? "Click or drag to lay road, or pick grass to take it up."
          : "Click or drag to paint a corner dot. Each tile is chosen by the four dots around it."}
        {!edge && joins.joins.some((row, a) => row.some((joined, b) => a < b && !joined))
          ? " No set joins every pair, so painting two that never meet leaves the terrain between them."
          : ""}
        <span className="sr-only">{said}</span>
      </p>
    </div>
  );
}
