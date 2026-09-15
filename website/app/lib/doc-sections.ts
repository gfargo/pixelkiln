import "server-only";

import { docs, headingId, readDoc, type DocEntry, type LinkResolver } from "@/app/lib/docs";

/**
 * A long reference renders as a parent page plus one child page per
 * section. The Markdown stays one file, so the package, GitHub, and the
 * site share it; only the site cuts it up, at the heading depth the
 * registry names (`split: 2` for a page per H2, `split: 3` for a page per
 * H3 with the H2s as groups on the parent).
 */
export type DocChild = {
  /** URL segment under the parent: the heading's id. */
  slug: string;
  title: string;
  /** The heading id, so links to `#id` in the source resolve to this page. */
  id: string;
  /** H2 group this child sits under, for a `split: 3` doc. */
  group: string | null;
  /** The section's Markdown, heading included, with headings lifted so the child renders from H2. */
  content: string;
  /** First sentence of the section's prose, for cards and metadata. */
  summary: string;
};

export type DocGroupIndex = { title: string | null; id: string | null; intro: string; children: DocChild[] };

export type SplitDoc = {
  doc: DocEntry;
  /** Markdown above the first section: the page's own introduction. */
  preamble: string;
  groups: DocGroupIndex[];
  children: DocChild[];
  /** Every heading id in the source and the child that holds it; `own` when it is the child's title. */
  anchors: Record<string, { child: string; own: boolean }>;
};

/** The first sentence of the first prose paragraph: no code, tables, lists, or HTML. */
const summaryOf = (markdown: string) => {
  const paragraphs: string[][] = [[]];
  let inFence = false;
  for (const line of markdown.split("\n")) {
    if (line.startsWith("```")) { inFence = !inFence; continue; }
    if (inFence) continue;
    if (!line.trim()) { paragraphs.push([]); continue; }
    paragraphs[paragraphs.length - 1].push(line);
  }
  const candidates = paragraphs
    .map((lines) => lines.join(" "))
    .filter((text) => text && !/^(#|\||[-*] |\d+\. |<|!\[)/.test(text))
    .map((text) => text
      .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
      .replace(/[`*_]/g, "")
      .replace(/\s+/g, " ")
      .replace(/:$/, ".")
      .trim());
  // A one-line note under a table says little; take the first real paragraph.
  const prose = candidates.find((text) => text.length >= 60) ?? candidates.sort((a, b) => b.length - a.length)[0];
  if (!prose) return "";
  const sentence = prose.match(/^.*?[.!?](\s|$)/)?.[0] ?? prose;
  return sentence.length > 180 ? `${sentence.slice(0, 177).trimEnd()}…` : sentence.trim();
};

/** Lift every heading in a child by `by` levels so a section renders as its own page from H2. */
const lift = (markdown: string, by: number) => {
  if (by <= 0) return markdown;
  let inFence = false;
  return markdown
    .split("\n")
    .map((line) => {
      if (line.startsWith("```")) inFence = !inFence;
      if (inFence) return line;
      const match = line.match(/^(#{2,6})\s/);
      if (!match) return line;
      return `${"#".repeat(Math.max(2, match[1].length - by))} ${line.slice(match[1].length + 1)}`;
    })
    .join("\n");
};

function splitContent(doc: DocEntry, content: string, depth: 2 | 3): SplitDoc {
  const lines = content.split("\n");
  type Raw = { level: number; title: string; lines: string[] };
  const raws: Raw[] = [];
  let current: Raw = { level: 0, title: "", lines: [] };
  let inFence = false;
  for (const line of lines) {
    if (line.startsWith("```")) inFence = !inFence;
    const match = !inFence && line.match(/^(##|###)\s+(.+)$/);
    if (match && match[1].length <= depth) {
      raws.push(current);
      current = { level: match[1].length, title: match[2].trim(), lines: [line] };
    } else {
      current.lines.push(line);
    }
  }
  raws.push(current);

  const preamble = raws[0].lines.join("\n").trim();
  const groups: DocGroupIndex[] = [];
  const children: DocChild[] = [];
  const anchors: SplitDoc["anchors"] = {};
  let group: DocGroupIndex = { title: null, id: null, intro: "", children: [] };
  groups.push(group);

  const addChild = (raw: Raw, groupTitle: string | null) => {
    const id = headingId(raw.title);
    const body = raw.lines.slice(1).join("\n").trim();
    const child: DocChild = {
      slug: id,
      title: raw.title.replace(/[`*_]/g, ""),
      id,
      group: groupTitle,
      content: `## ${raw.title}\n\n${lift(body, raw.level - 2)}`,
      summary: summaryOf(body),
    };
    children.push(child);
    anchors[id] = { child: id, own: true };
    for (const line of raw.lines.slice(1)) {
      const nested = line.match(/^(#{3,6})\s+(.+)$/);
      if (nested) anchors[headingId(nested[2])] = { child: id, own: false };
    }
    return child;
  };

  for (let index = 1; index < raws.length; index++) {
    const raw = raws[index];
    if (depth === 3 && raw.level === 2) {
      const hasChildren = raws[index + 1]?.level === 3;
      if (hasChildren) {
        // The H2 heads a group: its own text introduces the group's pages.
        group = { title: raw.title, id: headingId(raw.title), intro: raw.lines.slice(1).join("\n").trim(), children: [] };
        groups.push(group);
        // A group heading lives on the parent page, which renders it with its id.
        anchors[group.id!] = { child: "", own: false };
        continue;
      }
      // An H2 with no H3s is a page of its own, outside any group.
      group = { title: null, id: null, intro: "", children: [] };
      groups.push(group);
    }
    group.children.push(addChild(raw, group.title));
  }

  return { doc, preamble, groups: groups.filter((entry) => entry.children.length), children, anchors };
}

const cache = new Map<string, Promise<SplitDoc | null>>();

/** The split view of a doc, or null when the registry does not split it. */
export function splitDoc(doc: DocEntry): Promise<SplitDoc | null> {
  if (!doc.split) return Promise.resolve(null);
  let pending = cache.get(doc.slug);
  if (!pending) {
    pending = readDoc(doc).then(({ content }) => splitContent(doc, content, doc.split!));
    cache.set(doc.slug, pending);
  }
  return pending;
}

/** Where a `file#anchor` link lands on the site, taking split pages into account. */
export async function linkResolver(): Promise<LinkResolver> {
  const splits = new Map<string, SplitDoc>();
  for (const doc of docs) {
    const split = await splitDoc(doc);
    if (split) splits.set(doc.slug, split);
  }
  return (slug, anchor) => {
    const split = splits.get(slug);
    if (!split || !anchor) return `/docs/${slug}${anchor ? `#${anchor}` : ""}`;
    const hit = split.anchors[anchor];
    if (!hit || !hit.child) return `/docs/${slug}#${anchor}`;
    return `/docs/${slug}/${hit.child}${hit.own ? "" : `#${anchor}`}`;
  };
}
