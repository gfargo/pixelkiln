import "server-only";

import { readFile } from "node:fs/promises";
import path from "node:path";

export type DocGroup = "Start here" | "Providers" | "Guides" | "Reference" | "Policies";

export type DocEntry = {
  slug: string;
  title: string;
  description: string;
  file: string;
  group: DocGroup;
  /**
   * Render as a parent page with one child page per heading at this depth.
   * The Markdown stays one file; see `doc-sections.ts`.
   */
  split?: 2 | 3;
};

export const docs: DocEntry[] = [
  {
    slug: "getting-started",
    title: "Getting started",
    description: "Create a project, adopt existing art, run the everyday workflow, and touch art up by hand.",
    file: "docs/GETTING_STARTED.md",
    group: "Start here",
  },
  {
    slug: "pixellab",
    title: "Set up PixelLab",
    description: "Configure the production provider, choose a generator, and use its account workflows.",
    file: "docs/PIXELLAB.md",
    group: "Providers",
  },
  {
    slug: "retro-diffusion",
    title: "Set up Retro Diffusion",
    description: "Configure the experimental provider, choose a style, and understand its tested boundary.",
    file: "docs/RETRO_DIFFUSION.md",
    group: "Providers",
  },
  {
    slug: "comfyui",
    title: "Set up ComfyUI",
    description: "Connect a self-hosted server for stills, revisions, and atomic frame sets, then apply its quality gate.",
    file: "docs/COMFYUI.md",
    group: "Providers",
    split: 2,
  },
  {
    slug: "scenario",
    title: "Set up Scenario",
    description: "Configure hosted models, two-part credentials, CU preflight, and durable downloads.",
    file: "docs/SCENARIO.md",
    group: "Providers",
  },
  {
    slug: "cli",
    title: "CLI reference",
    description: "Every command and flag, including gallery, edit, history, tools, the PixelLab unzoom, font, and estimate-skeleton utilities, automation, and exit behavior.",
    file: "docs/CLI.md",
    group: "Reference",
    split: 3,
  },
  {
    slug: "manifest",
    title: "Manifest reference",
    description: "Styles, assets, quality profiles, mounting, and validation.",
    file: "docs/MANIFEST.md",
    group: "Reference",
    split: 2,
  },
  {
    slug: "mixed-providers",
    title: "Mixed-provider projects",
    description: "Route styles across providers with separate budgets and safe recovery.",
    file: "docs/MIXED_PROVIDERS.md",
    group: "Providers",
  },
  {
    slug: "agents",
    title: "Agent workflows",
    description: "Install the skill and see what it tells an agent to do.",
    file: "docs/AGENTS.md",
    group: "Start here",
  },
  {
    slug: "characters",
    title: "Characters",
    description: "A base in 4 or 8 directions from a prompt or your own sprite, states, loops, mirrors, portraits, outfit transfer, and what each PixelLab engine costs.",
    file: "docs/CHARACTERS.md",
    group: "Guides",
  },
  {
    slug: "generators",
    title: "Generator selection",
    description: "Choose the right capability and understand measured costs.",
    file: "docs/GENERATORS.md",
    group: "Guides",
  },
  {
    slug: "provider-benchmark",
    title: "Environment provider benchmark",
    description: "Thirty provider outputs, including ComfyUI cleanup, native-grid limits, final-palette refinement, and measured quality findings.",
    file: "docs/PROVIDER_BENCHMARK.md",
    group: "Providers",
  },
  {
    slug: "recipes",
    title: "Versioned recipes",
    description: "Install and verify pinned workflows, model hashes, and quality contracts.",
    file: "docs/RECIPES.md",
    group: "Guides",
  },
  {
    slug: "revisions",
    title: "Controlled asset revisions",
    description: "Revise current art with hashed parents, masks, approval gates, and side-by-side review, including PixelLab palette cleanup, animation, and interpolation.",
    file: "docs/REVISIONS.md",
    group: "Guides",
  },
  {
    slug: "artifacts",
    title: "Derived artifacts",
    description: "Refine, pack, mount, export, hand-edit companions, approval provenance, and recovery.",
    file: "docs/ARTIFACTS.md",
    group: "Guides",
  },
  {
    slug: "recovery",
    title: "Recovery and account safety",
    description: "Restore, generation history, cache, adopt, salvage, claims, and confirmed purge.",
    file: "docs/RECOVERY.md",
    group: "Guides",
  },
  {
    slug: "quality",
    title: "Quality gates",
    description: "Manifest quality profiles, image baselines, human review, and CI contracts.",
    file: "docs/QUALITY.md",
    group: "Guides",
  },
  {
    slug: "architecture",
    title: "Architecture",
    description: "The state machine, provider boundary, output identity, hand edits, the pinned editor, and durable writes.",
    file: "docs/ARCHITECTURE.md",
    group: "Reference",
  },
  {
    slug: "library",
    title: "Library API",
    description: "Public TypeScript contracts for composing PixelKiln workflows.",
    file: "docs/LIBRARY.md",
    group: "Reference",
    split: 2,
  },
  {
    slug: "tiles",
    title: "Tiles and engine exports",
    description: "Structural roles, generic output, Tiled Wang sets, and Godot terrains.",
    file: "docs/TILES.md",
    group: "Guides",
  },
  {
    slug: "endpoints",
    title: "Measured endpoints",
    description: "Live-account PixelLab costs, payloads, limits, and open questions.",
    file: "docs/ENDPOINTS.md",
    group: "Reference",
    split: 2,
  },
  {
    slug: "provider-notes",
    title: "Provider comparison",
    description: "Compare PixelLab, Retro Diffusion, ComfyUI, and Scenario.",
    file: "PROVIDERS.md",
    group: "Providers",
  },
  {
    slug: "contributing",
    title: "Contributing",
    description: "Set up the repository and follow its test, release, and safety rules.",
    file: "CONTRIBUTING.md",
    group: "Policies",
  },
  {
    slug: "security",
    title: "Security",
    description: "Supported versions, sensitive areas including the downloaded editor, and private vulnerability reporting.",
    file: "SECURITY.md",
    group: "Policies",
  },
];

export const docGroups: DocGroup[] = ["Start here", "Providers", "Guides", "Reference", "Policies"];

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

export type LinkResolver = (slug: string, anchor: string | undefined) => string;

export function docHref(sourceFile: string, href?: string, resolve?: LinkResolver) {
  if (!href || /^(?:https?:|mailto:)/.test(href)) return href;
  if (href.startsWith("#")) {
    // A same-page anchor on a split doc may live on a sibling page.
    const self = docs.find((doc) => path.resolve(/* turbopackIgnore: true */ process.cwd(), "..", doc.file) === sourceFile);
    return self && resolve ? resolve(self.slug, href.slice(1)) : href;
  }

  const [filePart, anchor] = href.split("#", 2);
  const target = path.resolve(path.dirname(sourceFile), decodeURIComponent(filePart));
  const repoRoot = path.resolve(/* turbopackIgnore: true */ process.cwd(), "..");
  const publicRoot = path.join(repoRoot, "website", "public");
  const publicRelative = path.relative(publicRoot, target).split(path.sep).join("/");
  if (!publicRelative.startsWith("../")) {
    return `/${publicRelative}${anchor ? `#${anchor}` : ""}`;
  }
  const match = docs.find(
    (doc) => path.resolve(repoRoot, doc.file) === target,
  );

  if (match) return resolve ? resolve(match.slug, anchor) : `/docs/${match.slug}${anchor ? `#${anchor}` : ""}`;

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
