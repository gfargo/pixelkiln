import "server-only";

import { readFile } from "node:fs/promises";
import path from "node:path";

export type DocGroup = "Start here" | "Workflows" | "Internals" | "Policies";

export type DocEntry = {
  slug: string;
  title: string;
  description: string;
  file: string;
  group: DocGroup;
};

export const docs: DocEntry[] = [
  {
    slug: "getting-started",
    title: "Getting started",
    description: "Create a project, adopt existing art, and run the everyday workflow.",
    file: "docs/GETTING_STARTED.md",
    group: "Start here",
  },
  {
    slug: "cli",
    title: "CLI reference",
    description: "Every command and flag, including automation and exit behavior.",
    file: "docs/CLI.md",
    group: "Start here",
  },
  {
    slug: "manifest",
    title: "Manifest reference",
    description: "Styles, assets, inheritance, mounting, and validation.",
    file: "docs/MANIFEST.md",
    group: "Start here",
  },
  {
    slug: "generators",
    title: "Generator selection",
    description: "Choose the right capability and understand measured costs.",
    file: "docs/GENERATORS.md",
    group: "Workflows",
  },
  {
    slug: "artifacts",
    title: "Derived artifacts",
    description: "Pack, mount, export, provenance, ownership, and recovery.",
    file: "docs/ARTIFACTS.md",
    group: "Workflows",
  },
  {
    slug: "recovery",
    title: "Recovery and account safety",
    description: "Restore, cache, adopt, salvage, claims, and confirmed purge.",
    file: "docs/RECOVERY.md",
    group: "Workflows",
  },
  {
    slug: "quality",
    title: "Quality gates",
    description: "Plan, doctor, audit, cache integrity, and CI contracts.",
    file: "docs/QUALITY.md",
    group: "Workflows",
  },
  {
    slug: "architecture",
    title: "Architecture",
    description: "The state machine, provider boundary, output identity, and durable writes.",
    file: "docs/ARCHITECTURE.md",
    group: "Internals",
  },
  {
    slug: "library",
    title: "Library API",
    description: "Public TypeScript contracts for composing PixelKiln workflows.",
    file: "docs/LIBRARY.md",
    group: "Internals",
  },
  {
    slug: "tiles",
    title: "Tiles and engine exports",
    description: "Structural roles, generic output, Tiled Wang sets, and Godot terrains.",
    file: "docs/TILES.md",
    group: "Internals",
  },
  {
    slug: "endpoints",
    title: "Measured endpoints",
    description: "Live-account PixelLab costs, payloads, limits, and open questions.",
    file: "docs/ENDPOINTS.md",
    group: "Internals",
  },
  {
    slug: "provider-notes",
    title: "Provider notes",
    description: "The current adapter seam and future backend work.",
    file: "PROVIDERS.md",
    group: "Internals",
  },
  {
    slug: "contributing",
    title: "Contributing",
    description: "Development setup, change guidelines, and architectural boundaries.",
    file: "CONTRIBUTING.md",
    group: "Policies",
  },
  {
    slug: "security",
    title: "Security",
    description: "Supported versions, reporting, and project security posture.",
    file: "SECURITY.md",
    group: "Policies",
  },
  {
    slug: "naming",
    title: "Naming decision",
    description: "Why the project is called PixelKiln.",
    file: "NAMING.md",
    group: "Policies",
  },
];

export const docGroups: DocGroup[] = ["Start here", "Workflows", "Internals", "Policies"];

export function getDoc(slug: string) {
  return docs.find((doc) => doc.slug === slug);
}

export async function readDoc(doc: DocEntry) {
  const absolute = path.join(/* turbopackIgnore: true */ process.cwd(), "..", doc.file);
  const raw = await readFile(absolute, "utf8");
  return {
    absolute,
    content: raw.replace(/^#\s+[^\n]+\n+/, ""),
  };
}

export function docHref(sourceFile: string, href?: string) {
  if (!href || href.startsWith("#") || /^(?:https?:|mailto:)/.test(href)) return href;

  const [filePart, anchor] = href.split("#", 2);
  const target = path.resolve(path.dirname(sourceFile), decodeURIComponent(filePart));
  const repoRoot = path.resolve(/* turbopackIgnore: true */ process.cwd(), "..");
  const match = docs.find(
    (doc) => path.resolve(repoRoot, doc.file) === target,
  );

  if (match) return `/docs/${match.slug}${anchor ? `#${anchor}` : ""}`;

  const repoRelative = path.relative(repoRoot, target).split(path.sep).join("/");
  if (!repoRelative.startsWith("../")) {
    return `https://github.com/gfargo/pixelkiln/blob/main/${repoRelative}${anchor ? `#${anchor}` : ""}`;
  }
  return href;
}

export function headingId(value: string) {
  return value
    .toLowerCase()
    .replace(/[`*_]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

export function tableOfContents(content: string) {
  return [...content.matchAll(/^(##|###)\s+(.+)$/gm)].map((match) => ({
    depth: match[1].length,
    title: match[2].replace(/[`*_]/g, ""),
    id: headingId(match[2]),
  }));
}
