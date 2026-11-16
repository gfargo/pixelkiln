"use client";

import { useEffect, useState, useSyncExternalStore } from "react";
import type { CSSProperties } from "react";
import { BUILDER_CELL, BUILDER_COLUMNS, BUILDER_ROWS, BUILDER_WALK_FPS, BUILDER_WALK_FRAMES, builderAtlas } from "@/app/lib/paperdoll-builder";

/**
 * The hero's picture: one character from the paperdoll showcase, walking, and
 * the record PixelKiln keeps for each asset it is made of. The cost of each
 * line is what PixelLab billed for it and the hash is its south-facing file's,
 * both from that project's lockfile. A line is a switch: turn one off and the
 * layer leaves the character and its cost leaves the total.
 */
const LINES: Array<{ id: string; layers: string[]; name: string; made: string; cost: number; hash: string; fixed?: boolean }> = [
  { id: "body", layers: ["hero", "hero.briefs"], name: "Body, four walks, underwear", made: "generated", cost: 21, hash: "baf2e379e0f5", fixed: true },
  { id: "greaves", layers: ["hero.greaves"], name: "Plate greaves", made: "inpainted", cost: 15, hash: "b62942a0eafe" },
  { id: "plate", layers: ["hero.plate"], name: "Dragon plate", made: "inpainted", cost: 15, hash: "4204c1432b9d" },
  { id: "cape", layers: ["hero.warcape"], name: "War cape", made: "inpainted", cost: 25, hash: "83d9bdd6cef3" },
  { id: "shield", layers: ["hero.kiteshield"], name: "Dragon shield", made: "placed", cost: 10, hash: "7da3ea75f0ac" },
  { id: "sword", layers: ["hero.greatsword"], name: "Runed greatsword", made: "placed, gripped", cost: 35, hash: "30826bb3bb96" },
  { id: "helm", layers: ["hero.helm"], name: "Horned helm", made: "inpainted", cost: 25, hash: "fec907e6a5fa" },
];
/** Frames each asset writes: eight rotations and four six-frame walks. */
const FILES_PER_ASSET = 32;
/** The walk rows of the atlas, in the order the character turns through them. */
const WALK_ROWS = [1, 2, 3, 4];
const LOOPS_PER_TURN = 2;

function subscribeReducedMotion(callback: () => void) {
  const list = window.matchMedia("(prefers-reduced-motion: reduce)");
  list.addEventListener("change", callback);
  return () => list.removeEventListener("change", callback);
}

export function HeroReceipt() {
  const [off, setOff] = useState<string[]>([]);
  const [tick, setTick] = useState(0);
  const reducedMotion = useSyncExternalStore(
    subscribeReducedMotion,
    () => window.matchMedia("(prefers-reduced-motion: reduce)").matches,
    () => false,
  );

  useEffect(() => {
    if (reducedMotion) return;
    const timer = setInterval(() => setTick((current) => current + 1), 1000 / BUILDER_WALK_FPS);
    return () => clearInterval(timer);
  }, [reducedMotion]);

  const frame = reducedMotion ? 0 : tick % BUILDER_WALK_FRAMES;
  const row = reducedMotion ? WALK_ROWS[0]! : WALK_ROWS[Math.floor(tick / (BUILDER_WALK_FRAMES * LOOPS_PER_TURN)) % WALK_ROWS.length]!;
  const scale = 4;
  const cell = BUILDER_CELL * scale;
  const stage = {
    "--builder-cell": `${cell}px`,
    "--builder-size": `${BUILDER_COLUMNS * cell}px ${BUILDER_ROWS * cell}px`,
    "--builder-at": `${-frame * cell}px ${-row * cell}px`,
  } as CSSProperties;

  const on = LINES.filter((line) => !off.includes(line.id));
  const total = on.reduce((sum, line) => sum + line.cost, 0);
  const toggle = (id: string) => setOff((current) => (current.includes(id) ? current.filter((entry) => entry !== id) : [...current, id]));

  return (
    <div className="hero-receipt">
      <div className="hero-stage" style={stage}>
        <div className="builder-figure" role="img" aria-label={`A pixel-art knight walking, wearing ${on.slice(1).map((line) => line.name.toLowerCase()).join(", ") || "only underwear"}`}>
          {on.flatMap((line) => line.layers).map((id) => (
            <div key={id} className="builder-layer" style={{ backgroundImage: `url(${builderAtlas(id)})` }} />
          ))}
        </div>
      </div>
      <div className="receipt">
        <h2>One knight, seven assets. Switch a line off.</h2>
        <ul>
          {LINES.map((line) => {
            const included = !off.includes(line.id);
            const body = (
              <>
                <span className="receipt-mark" aria-hidden="true" />
                <span className="receipt-name">
                  {line.name}
                  <small>{line.made} · sha256 <code>{line.hash}</code></small>
                </span>
                <span className="receipt-cost">{line.cost}</span>
              </>
            );
            return (
              <li key={line.id}>
                {line.fixed ? (
                  <div className="receipt-line" data-on="true">{body}</div>
                ) : (
                  <button type="button" className="receipt-line" data-on={included} aria-pressed={included} onClick={() => toggle(line.id)}>
                    {body}
                  </button>
                )}
              </li>
            );
          })}
        </ul>
        <p className="receipt-total" aria-live="polite">
          <span>{on.length * FILES_PER_ASSET} files hashed</span>
          <strong>{total} generations</strong>
        </p>
      </div>
    </div>
  );
}
