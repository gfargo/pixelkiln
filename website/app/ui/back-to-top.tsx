"use client";

import { useEffect, useRef, useState } from "react";

/**
 * A button that returns to the top of a long page. It appears once the visitor
 * is a screen and a half down on a page that is at least three screens tall,
 * so a short page never shows it. Focus moves to the header's first link, so a
 * keyboard user lands where they would at the top.
 */
export function BackToTop() {
  const [shown, setShown] = useState(false);
  const frame = useRef(0);

  useEffect(() => {
    const update = () => {
      frame.current = 0;
      const view = window.innerHeight;
      const tall = document.documentElement.scrollHeight >= view * 3;
      setShown(tall && window.scrollY > view * 1.5);
    };
    const onScroll = () => {
      if (!frame.current) frame.current = window.requestAnimationFrame(update);
    };
    update();
    window.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("resize", onScroll);
    return () => {
      window.removeEventListener("scroll", onScroll);
      window.removeEventListener("resize", onScroll);
      if (frame.current) window.cancelAnimationFrame(frame.current);
    };
  }, []);

  const toTop = () => {
    const calm = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    window.scrollTo({ top: 0, behavior: calm ? "auto" : "smooth" });
    document.querySelector<HTMLElement>(".site-header a")?.focus({ preventScroll: true });
  };

  return (
    <button type="button" className={`back-to-top${shown ? " is-shown" : ""}`} onClick={toTop} aria-label="Back to top" tabIndex={shown ? 0 : -1} aria-hidden={shown ? undefined : true}>
      <span aria-hidden="true" />
    </button>
  );
}
