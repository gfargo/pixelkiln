"use client";

import Image from "next/image";
import { usePathname } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { DOC_MENU, FEATURE_GROUPS, FEATURES } from "@/app/lib/features";
import { TrackedLink } from "@/app/ui/tracked-link";

type Panel = "features" | "docs" | "all" | null;

/**
 * The header's menus. On a wide screen "Features" and "Docs" each open a
 * panel under the bar; on a narrow one a single "Menu" button opens both
 * lists in one panel. Each is a disclosure: a button that says whether its
 * panel is open, Escape and a click outside close it, and so does following
 * a link.
 */
export function SiteNav() {
  const [open, setOpen] = useState<Panel>(null);
  const root = useRef<HTMLDivElement>(null);
  const pathname = usePathname();

  // Following a link leaves the panel behind.
  const [seen, setSeen] = useState(pathname);
  if (seen !== pathname) {
    setSeen(pathname);
    setOpen(null);
  }

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      setOpen(null);
      root.current?.querySelector<HTMLButtonElement>(`[data-menu="${open}"]`)?.focus();
    };
    const onPointer = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(null);
    };
    document.addEventListener("keydown", onKey);
    document.addEventListener("pointerdown", onPointer);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("pointerdown", onPointer);
    };
  }, [open]);

  const toggle = useCallback((panel: Exclude<Panel, null>) => setOpen((current) => (current === panel ? null : panel)), []);
  const close = useCallback(() => setOpen(null), []);
  const current = (href: string) => (pathname === href ? ("page" as const) : undefined);

  const features = (
    <div className="menu-features">
      {FEATURE_GROUPS.map((group) => (
        <div key={group} className="menu-group">
          <h2>{group}</h2>
          {FEATURES.filter((entry) => entry.group === group).map((entry) => (
            <TrackedLink key={entry.id} id={`nav_${entry.id}`} section="header" href={entry.href} className="menu-feature" aria-current={current(entry.href)}>
              <strong>{entry.name}</strong>
              <span>{entry.summary}</span>
            </TrackedLink>
          ))}
        </div>
      ))}
    </div>
  );

  const docs = (
    <div className="menu-docs">
      {DOC_MENU.map((group) => (
        <div key={group.label} className="menu-group">
          <h2>{group.label}</h2>
          {group.links.map((link) => (
            <TrackedLink key={link.href} id="nav_docs_menu" section="header" href={link.href} className="menu-link" aria-current={current(link.href)}>
              {link.label}
            </TrackedLink>
          ))}
        </div>
      ))}
    </div>
  );

  return (
    <div className="site-nav" ref={root}>
      <nav aria-label="Primary navigation" className="site-nav-bar">
        <button type="button" data-menu="features" aria-expanded={open === "features"} aria-controls="menu-features" onClick={() => toggle("features")}>
          Features
        </button>
        <button type="button" data-menu="docs" aria-expanded={open === "docs"} aria-controls="menu-docs" onClick={() => toggle("docs")}>
          Docs
        </button>
        <TrackedLink id="nav_providers" section="header" href="/providers" aria-current={current("/providers")}>Providers</TrackedLink>
        <TrackedLink id="nav_github" section="header" href="https://github.com/gfargo/pixelkiln" external>GitHub</TrackedLink>
      </nav>
      <button type="button" className="site-nav-toggle" data-menu="all" aria-expanded={open === "all"} aria-controls="menu-all" onClick={() => toggle("all")}>
        {open === "all" ? "Close" : "Menu"}
      </button>

      {open === "features" ? (
        <div className="menu-panel" id="menu-features">
          {features}
          <TrackedLink id="nav_builder" section="header" href="/paperdoll#paperdoll-builder" className="menu-aside">
            <Image src="/sprites/paperdoll/showcase-8dir.png" alt="A dressed character turned through eight directions" width={764} height={92} unoptimized />
            <strong>Dress a character in your browser</strong>
            <span>Twenty layers, six skins, four walks.</span>
          </TrackedLink>
        </div>
      ) : null}
      {open === "docs" ? (
        <div className="menu-panel" id="menu-docs">
          {docs}
          <TrackedLink id="nav_docs" section="header" href="/docs" className="menu-aside menu-aside-plain">
            <strong>All documentation</strong>
            <span>Every guide, rendered from the Markdown in the repository.</span>
          </TrackedLink>
        </div>
      ) : null}
      {open === "all" ? (
        <div className="menu-panel menu-panel-all" id="menu-all">
          {features}
          {docs}
          <div className="menu-group">
            <h2>Project</h2>
            <TrackedLink id="nav_start_building" section="header" href="/docs/getting-started" className="menu-link">Start building</TrackedLink>
            <TrackedLink id="nav_docs" section="header" href="/docs" className="menu-link">All documentation</TrackedLink>
            <TrackedLink id="nav_github" section="header" href="https://github.com/gfargo/pixelkiln" external className="menu-link">GitHub</TrackedLink>
          </div>
          <button type="button" className="menu-close" onClick={close}>Close menu</button>
        </div>
      ) : null}
    </div>
  );
}
