"use client";

import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { trackCta } from "@/app/lib/analytics";

type Entry = {
  slug: string;
  doc: string;
  group: string;
  heading: string;
  path: string;
  id: string;
  text: string;
};

type Hit = { entry: Entry; score: number; snippet: string };

const MAX_HITS = 12;

function tokens(value: string) {
  return value.toLowerCase().split(/[^a-z0-9.-]+/).filter((token) => token.length > 1);
}

/**
 * Score one section against the query terms. Every term has to appear
 * somewhere; a term in the heading counts most, one in the doc title next,
 * one in the prose least, and a whole-word match beats a substring.
 */
function scoreEntry(entry: Entry, terms: string[], lower: { heading: string; doc: string; text: string }) {
  let score = 0;
  for (const term of terms) {
    const inHeading = lower.heading.indexOf(term);
    const inDoc = lower.doc.indexOf(term);
    const inText = lower.text.indexOf(term);
    if (inHeading < 0 && inDoc < 0 && inText < 0) return 0;
    if (inHeading >= 0) score += lower.heading === term ? 40 : inHeading === 0 ? 24 : 16;
    if (inDoc >= 0) score += 8;
    if (inText >= 0) {
      score += 4;
      if (new RegExp(`(^|[^a-z0-9])${term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}([^a-z0-9]|$)`).test(lower.text)) score += 3;
    }
  }
  // Intros are a coarse match; a specific section is the better landing.
  if (!entry.id) score -= 2;
  return score;
}

function snippetFor(text: string, terms: string[]) {
  const lower = text.toLowerCase();
  let at = -1;
  for (const term of terms) {
    const index = lower.indexOf(term);
    if (index >= 0 && (at < 0 || index < at)) at = index;
  }
  if (at < 0) return text.slice(0, 150);
  const start = Math.max(0, at - 60);
  const cut = text.slice(start, start + 170);
  return `${start > 0 ? "…" : ""}${cut}${start + 170 < text.length ? "…" : ""}`;
}

function search(index: Entry[], query: string): Hit[] {
  const terms = tokens(query);
  if (!terms.length) return [];
  const hits: Hit[] = [];
  for (const entry of index) {
    const lower = { heading: entry.heading.toLowerCase(), doc: entry.doc.toLowerCase(), text: entry.text.toLowerCase() };
    const score = scoreEntry(entry, terms, lower);
    if (score > 0) hits.push({ entry, score, snippet: snippetFor(entry.text, terms) });
  }
  return hits.sort((a, b) => b.score - a.score).slice(0, MAX_HITS);
}

function Mark({ text, terms }: { text: string; terms: string[] }) {
  if (!terms.length) return <>{text}</>;
  const pattern = new RegExp(`(${terms.map((term) => term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})`, "ig");
  const parts = text.split(pattern);
  return (
    <>
      {parts.map((part, index) =>
        terms.includes(part.toLowerCase()) ? <mark key={index}>{part}</mark> : <span key={index}>{part}</span>,
      )}
    </>
  );
}

const subscribeNothing = () => () => {};

let cachedIndex: Promise<Entry[]> | null = null;
function loadIndex() {
  if (!cachedIndex) {
    cachedIndex = fetch("/docs/search-index").then((response) => {
      if (!response.ok) throw new Error(`search index ${response.status}`);
      return response.json() as Promise<Entry[]>;
    });
    cachedIndex.catch(() => { cachedIndex = null; });
  }
  return cachedIndex;
}

/** The docs search: a button in the header, a palette on ⌘K or /, results by section. */
export function DocSearch() {
  const router = useRouter();
  const dialog = useRef<HTMLDialogElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [index, setIndex] = useState<Entry[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [cursor, setCursor] = useState(0);
  // The server renders the Mac label; a Windows or Linux client swaps it in after hydration.
  const isMac = useSyncExternalStore(subscribeNothing, () => /Mac|iPhone|iPad/.test(navigator.platform), () => true);

  const show = useCallback(() => {
    setOpen(true);
    if (!index) loadIndex().then(setIndex).catch(() => setFailed(true));
  }, [index]);
  const hide = useCallback(() => setOpen(false), []);

  useEffect(() => {
    const element = dialog.current;
    if (!element) return;
    if (open && !element.open) {
      element.showModal();
      input.current?.focus();
      input.current?.select();
    } else if (!open && element.open) {
      element.close();
    }
  }, [open]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const editing = (event.target as HTMLElement | null)?.closest("input, textarea, select, [contenteditable]");
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        if (open) hide(); else show();
      } else if (event.key === "/" && !open && !editing) {
        event.preventDefault();
        show();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, show, hide]);

  const hits = useMemo(() => (index ? search(index, query) : []), [index, query]);
  const terms = useMemo(() => tokens(query), [query]);

  const go = useCallback((hit: Hit) => {
    const href = `/docs/${hit.entry.slug}${hit.entry.id ? `#${hit.entry.id}` : ""}`;
    trackCta(`docs_search_${hit.entry.slug}`, "docs_search", href);
    hide();
    router.push(href);
  }, [hide, router]);

  const onInputKey = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setCursor((current) => Math.min(current + 1, Math.max(hits.length - 1, 0)));
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setCursor((current) => Math.max(current - 1, 0));
    } else if (event.key === "Enter" && hits[cursor]) {
      event.preventDefault();
      go(hits[cursor]);
    }
  };

  return (
    <>
      <button type="button" className="doc-search-button" onClick={show} aria-label="Search the documentation">
        <span>Search docs</span>
        <kbd>{isMac ? "⌘" : "Ctrl"} K</kbd>
      </button>
      <dialog
        ref={dialog}
        className="doc-search"
        aria-label="Search the documentation"
        onClose={hide}
        onClick={(event) => { if (event.target === dialog.current) hide(); }}
      >
        <div className="doc-search-panel">
          <div className="doc-search-field">
            <input
              ref={input}
              type="search"
              value={query}
              onChange={(event) => { setQuery(event.target.value); setCursor(0); }}
              onKeyDown={onInputKey}
              placeholder="Search commands, fields, and guides"
              aria-label="Search query"
              aria-controls="doc-search-results"
              autoComplete="off"
              spellCheck={false}
            />
            <kbd>esc</kbd>
          </div>
          <div id="doc-search-results" className="doc-search-results" role="listbox" aria-label="Results">
            {failed && <p className="doc-search-note">The search index did not load. The sidebar lists every page.</p>}
            {!failed && !index && open && <p className="doc-search-note">Loading the index…</p>}
            {index && query && !hits.length && (
              <p className="doc-search-note">Nothing matches &ldquo;{query}&rdquo;. Try a command name, a manifest field, or a plainer word.</p>
            )}
            {index && !query && (
              <p className="doc-search-note">Type to search {index.length} sections across the documentation. ↑↓ to move, enter to open.</p>
            )}
            {hits.map((hit, position) => (
              <button
                type="button"
                key={`${hit.entry.slug}-${hit.entry.id}-${position}`}
                role="option"
                aria-selected={position === cursor}
                className={`doc-search-hit${position === cursor ? " active" : ""}`}
                onMouseEnter={() => setCursor(position)}
                onClick={() => go(hit)}
              >
                <span className="doc-search-where">{hit.entry.doc}{hit.entry.id ? ` › ${hit.entry.path}` : ""}</span>
                <span className="doc-search-title"><Mark text={hit.entry.heading} terms={terms} /></span>
                <span className="doc-search-snippet"><Mark text={hit.snippet} terms={terms} /></span>
              </button>
            ))}
          </div>
          <div className="doc-search-foot">
            <span><kbd>↑</kbd><kbd>↓</kbd> move</span>
            <span><kbd>↵</kbd> open</span>
            <span><kbd>/</kbd> or <kbd>{isMac ? "⌘" : "Ctrl"} K</kbd> from any page</span>
          </div>
        </div>
      </dialog>
    </>
  );
}
