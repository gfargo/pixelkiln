import type { CSSProperties } from "react";

/**
 * Plays a horizontal sprite strip in place, one cell per step, with the
 * strip itself as the only asset: no GIF, crisp at integer zoom, and still
 * under `prefers-reduced-motion`, where it shows the first cell.
 */
export function SpriteLoop({
  strip,
  width,
  frames,
  start = 0,
  cell,
  stride,
  scale = 1,
  seconds,
  label,
}: {
  strip: string;
  /** The strip's own width in source pixels, so it is scaled by an integer and never resampled. */
  width: number;
  /** Cells to play. */
  frames: number;
  /** First cell to play, so a strip's resting pose can sit out of the loop. */
  start?: number;
  /** Cell edge in source pixels; cells are square. */
  cell: number;
  /** Distance from one cell's left edge to the next, source pixels. */
  stride: number;
  scale?: number;
  /** One full cycle. */
  seconds: number;
  label: string;
}) {
  const style = {
    "--sprite": `url(${strip})`,
    "--cell": `${cell * scale}px`,
    "--from": `${-stride * start * scale}px`,
    "--travel": `${-stride * (start + frames) * scale}px`,
    "--strip-width": `${width * scale}px`,
    "--frames": frames,
    "--seconds": `${seconds}s`,
  } as CSSProperties;
  return <div className="sprite-loop" role="img" aria-label={label} style={style} />;
}
