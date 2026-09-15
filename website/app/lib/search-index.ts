import "server-only";

import { docs, headingId, readDoc, type DocEntry } from "@/app/lib/docs";

/** One searchable section: a heading and the prose under it, with where it lives. */
export type SearchEntry = {
  slug: string;
  doc: string;
  group: string;
  /** The section heading, or the doc title for the text above the first heading. */
  heading: string;
  /** "H2 › H3" when the section is nested, otherwise the heading. */
  path: string;
  /** Fragment on the doc page, or "" for the intro. */
  id: string;
  text: string;
};

const TEXT_LIMIT = 1600;

/** Markdown to searchable prose: links keep their text, code keeps its words, tables lose their rails. */
function plainText(markdown: string) {
  return markdown
    .replace(/^```[^\n]*$/gm, "")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/[`*_>]/g, "")
    .replace(/^\|?[-:| ]+\|?$/gm, "")
    .replace(/\|/g, "  ")
    .replace(/\s+/g, " ")
    .trim();
}

function sectionsOf(doc: DocEntry, content: string): SearchEntry[] {
  const entries: SearchEntry[] = [];
  const lines = content.split("\n");
  let h2 = "";
  let heading = doc.title;
  let path = doc.title;
  let id = "";
  let buffer: string[] = [];
  let inFence = false;

  const flush = () => {
    const text = plainText(buffer.join("\n")).slice(0, TEXT_LIMIT);
    if (text || id) entries.push({ slug: doc.slug, doc: doc.title, group: doc.group, heading, path, id, text });
    buffer = [];
  };

  for (const line of lines) {
    if (line.startsWith("```")) inFence = !inFence;
    const match = !inFence && line.match(/^(##|###)\s+(.+)$/);
    if (!match) {
      buffer.push(line);
      continue;
    }
    flush();
    const title = match[2].replace(/[`*_]/g, "").trim();
    if (match[1] === "##") {
      h2 = title;
      path = title;
    } else {
      path = h2 ? `${h2} › ${title}` : title;
    }
    heading = title;
    id = headingId(match[2]);
  }
  flush();
  return entries;
}

export async function buildSearchIndex(): Promise<SearchEntry[]> {
  const index: SearchEntry[] = [];
  for (const doc of docs) {
    const { content } = await readDoc(doc);
    index.push(...sectionsOf(doc, content));
  }
  return index;
}
