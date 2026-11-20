"use client";

import { usePathname } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { DOC_MENU, FEATURE_GROUPS, FEATURES, MENU_ART, MENU_COMMANDS, MENU_LINES, MENU_SHORTCUTS } from "@/app/lib/features";
import { SpriteLoop } from "@/app/ui/sprite-loop";
import { TrackedLink } from "@/app/ui/tracked-link";

type Panel = "features" | "docs" | "all" | null;

/**
 * The header's menus. On a wide screen "Features" and "Docs" each open a
 * panel under the bar; on a narrow one a single "Menu" button opens both
 * lists in one panel. Each is a disclosure: a button that says whether its
 * panel is open. Escape, a click outside, focus leaving the header, and
 * following a link all close it.
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
    const node = root.current;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      setOpen(null);
      node?.querySelector<HTMLButtonElement>(`[data-menu="${open}"]`)?.focus();
    };
    const onPointer = (event: PointerEvent) => {
      if (!node?.contains(event.target as Node)) setOpen(null);
    };
    // Tabbing past the last link closes the panel instead of leaving it open over the page.
    const onFocusOut = (event: FocusEvent) => {
      const next = event.relatedTarget as Node | null;
      if (next && !node?.contains(next)) setOpen(null);
    };
    document.addEventListener("keydown", onKey);
    document.addEventListener("pointerdown", onPointer);
    node?.addEventListener("focusout", onFocusOut);
    // The phone menu covers the screen, so the page behind it should not scroll.
    const lock = open === "all";
    if (lock) document.documentElement.classList.add("menu-open");
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("pointerdown", onPointer);
      node?.removeEventListener("focusout", onFocusOut);
      if (lock) document.documentElement.classList.remove("menu-open");
    };
  }, [open]);

  const toggle = useCallback((panel: Exclude<Panel, null>) => setOpen((current) => (current === panel ? null : panel)), []);
  const current = (href: string) => (pathname === href ? ("page" as const) : undefined);
  const inProviders = pathname === "/providers" || pathname.startsWith("/providers/");
  const inFeatures = !inProviders && FEATURES.some((entry) => pathname === entry.href || pathname.startsWith(`${entry.href}/`));
  const inDocs = pathname.startsWith("/docs");

  const features = (
    <div className="menu-features">
      {FEATURE_GROUPS.map((group) => (
        <div key={group} className="menu-group">
          <h2>{group}</h2>
          {FEATURES.filter((entry) => entry.group === group).map((entry) => {
            const art = MENU_ART[entry.id];
            return (
              <TrackedLink key={entry.id} id={`nav_${entry.id}`} section="header" href={entry.href} className="menu-feature" aria-current={current(entry.href)}>
                <span className={`menu-thumb${art.strip ? " menu-thumb-strip" : ""}`} style={{ backgroundImage: `url(${art.src})` }} aria-hidden="true" />
                <span className="menu-feature-text">
                  <strong>{entry.name}</strong>
                  <span>{MENU_LINES[entry.id]}</span>
                </span>
              </TrackedLink>
            );
          })}
          <div className="menu-shortcuts">
            {MENU_SHORTCUTS[group].map((link) => (
              <TrackedLink key={link.href} id="nav_shortcut" section="header" href={link.href} className="menu-link" aria-current={current(link.href)}>
                {link.label}
              </TrackedLink>
            ))}
          </div>
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

  const foot = (
    <div className="menu-foot">
      <TrackedLink id="nav_start_building" section="header" href="/docs/getting-started" className="menu-foot-action">Start building</TrackedLink>
      <TrackedLink id="nav_docs" section="header" href="/docs" className="menu-link">All documentation</TrackedLink>
      <TrackedLink id="nav_github" section="header" href="https://github.com/gfargo/pixelkiln" external className="menu-link">GitHub</TrackedLink>
      <code className="menu-foot-install">npm install --save-dev pixelkiln</code>
    </div>
  );

  return (
    <div className="site-nav" ref={root}>
      <nav aria-label="Primary navigation" className="site-nav-bar">
        <button type="button" data-menu="features" data-here={inFeatures || undefined} aria-expanded={open === "features"} aria-controls="menu-features" onClick={() => toggle("features")}>
          Features
        </button>
        <button type="button" data-menu="docs" data-here={inDocs || undefined} aria-expanded={open === "docs"} aria-controls="menu-docs" onClick={() => toggle("docs")}>
          Docs
        </button>
        <TrackedLink id="nav_providers" section="header" href="/providers" aria-current={inProviders ? "page" : undefined}>Providers</TrackedLink>
        <TrackedLink id="nav_github" section="header" href="https://github.com/gfargo/pixelkiln" external>GitHub</TrackedLink>
      </nav>
      <button type="button" className="site-nav-toggle" data-menu="all" aria-expanded={open === "all"} aria-controls="menu-all" onClick={() => toggle("all")}>
        {open === "all" ? "Close" : "Menu"}
      </button>

      {open ? <div className="menu-scrim" aria-hidden="true" /> : null}
      {open === "features" ? (
        <div className="menu-panel" id="menu-features">
          {features}
          <TrackedLink id="nav_builder" section="header" href="/paperdoll#paperdoll-builder" className="menu-aside">
            <span className="menu-aside-stage">
              <SpriteLoop strip="/sprites/paperdoll/showcase-8dir.png" width={764} frames={8} cell={92} stride={96} scale={2} seconds={2.4} label="A dressed character turning through its eight directions" />
            </span>
            <strong>Dress a character in your browser</strong>
            <span>Twenty layers, six skins, four walks. Nothing to install.</span>
          </TrackedLink>
          {foot}
        </div>
      ) : null}
      {open === "docs" ? (
        <div className="menu-panel" id="menu-docs">
          {docs}
          <div className="menu-aside menu-aside-commands">
            <h2>Most used commands</h2>
            {MENU_COMMANDS.map((entry) => (
              <TrackedLink key={entry.href} id="nav_docs_command" section="header" href={entry.href} className="menu-command">
                <code>{entry.command}</code>
                <span>{entry.does}</span>
              </TrackedLink>
            ))}
          </div>
          {foot}
        </div>
      ) : null}
      {open === "all" ? (
        <div className="menu-panel menu-panel-all" id="menu-all">
          {features}
          {docs}
          {foot}
        </div>
      ) : null}
    </div>
  );
}
