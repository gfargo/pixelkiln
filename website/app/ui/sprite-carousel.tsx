"use client";

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { SpriteLoop } from "@/app/ui/sprite-loop";

export type CarouselSlide = {
  id: string;
  label: string;
  strip: string;
  /** The strip's own width in source pixels. */
  width: number;
  /** Cells to play, including the resting pose when `start` is 0. */
  frames: number;
  start?: number;
  /** Frames PixelLab actually drew, for the label; may differ from `frames` when the resting pose plays too. */
  generated: number;
  cell: number;
  stride: number;
  fps: number;
};

const AUTO_MS = 4200;

function subscribeReducedMotion(callback: () => void) {
  const query = window.matchMedia("(prefers-reduced-motion: reduce)");
  query.addEventListener("change", callback);
  return () => query.removeEventListener("change", callback);
}

function subscribeNarrow(callback: () => void) {
  const query = window.matchMedia("(max-width: 480px)");
  query.addEventListener("change", callback);
  return () => query.removeEventListener("change", callback);
}

/**
 * One animation at a time, larger than the small tiles: arrows, dots, and
 * an auto-advance that stops for good the first time someone drives it
 * themselves, so the visitor's choice sticks. `prefers-reduced-motion`
 * turns auto-advance off from the start; the sprite itself already holds
 * still under that setting.
 */
export function SpriteCarousel({ slides, scale = 3 }: { slides: CarouselSlide[]; scale?: number }) {
  const [index, setIndex] = useState(0);
  const [auto, setAuto] = useState(true);
  const reducedMotion = useSyncExternalStore(
    subscribeReducedMotion,
    () => window.matchMedia("(prefers-reduced-motion: reduce)").matches,
    () => false,
  );
  // A phone-width viewport gets a smaller sprite so the arrows stay beside
  // it instead of being pushed off the edge.
  const narrow = useSyncExternalStore(
    subscribeNarrow,
    () => window.matchMedia("(max-width: 480px)").matches,
    () => false,
  );
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    if (!auto || reducedMotion || slides.length < 2) return;
    timer.current = setInterval(() => setIndex((current) => (current + 1) % slides.length), AUTO_MS);
    return () => { if (timer.current) clearInterval(timer.current); };
  }, [auto, reducedMotion, slides.length]);

  const go = useCallback((delta: number) => {
    setAuto(false);
    setIndex((current) => (current + delta + slides.length) % slides.length);
  }, [slides.length]);

  const jump = useCallback((next: number) => {
    setAuto(false);
    setIndex(next);
  }, []);

  const slide = slides[index]!;
  const effectiveScale = narrow ? Math.min(scale, 2) : scale;

  return (
    <div className="sprite-carousel" role="group" aria-roledescription="carousel" aria-label="The robot's moves">
      <div className="sprite-carousel-stage">
        <button type="button" className="sprite-carousel-arrow" onClick={() => go(-1)} aria-label="Previous move">
          ‹
        </button>
        <div className="sprite-carousel-frame">
          <SpriteLoop
            key={slide.id}
            strip={slide.strip}
            width={slide.width}
            frames={slide.frames}
            start={slide.start}
            cell={slide.cell}
            stride={slide.stride}
            scale={effectiveScale}
            seconds={slide.frames / slide.fps}
            label={slide.label}
          />
        </div>
        <button type="button" className="sprite-carousel-arrow" onClick={() => go(1)} aria-label="Next move">
          ›
        </button>
      </div>
      <div className="sprite-carousel-meta">
        <span className="sprite-carousel-label">
          {slide.label} · {slide.generated} frames · {slide.fps} fps
        </span>
        <div className="sprite-carousel-dots" role="tablist" aria-label="Choose a move">
          {slides.map((item, position) => (
            <button
              key={item.id}
              type="button"
              role="tab"
              aria-selected={position === index}
              aria-label={item.label}
              className={position === index ? "active" : undefined}
              onClick={() => jump(position)}
            />
          ))}
        </div>
      </div>
      <p className="sr-only" aria-live="polite">{slide.label}</p>
    </div>
  );
}
