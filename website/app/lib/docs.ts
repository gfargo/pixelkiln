import "server-only";

import { readFile } from "node:fs/promises";
import path from "node:path";

export type DocGroup = "Start here" | "Providers" | "Guides" | "Reference" | "Research" | "Policies";

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
    description: "Create a project, bring in art you already have, plan and generate, and fix sprites by hand.",
    file: "docs/GETTING_STARTED.md",
    group: "Start here",
  },
  {
    slug: "pixellab",
    title: "Set up PixelLab",
    description: "Add your key, choose a generator, and manage the objects in your PixelLab account.",
    file: "docs/PIXELLAB.md",
    group: "Providers",
  },
  {
    slug: "retro-diffusion",
    title: "Set up Retro Diffusion",
    description: "Add your key, pick a style, and see what has and has not been tested.",
    file: "docs/RETRO_DIFFUSION.md",
    group: "Providers",
  },
  {
    slug: "comfyui",
    title: "Set up ComfyUI",
    description: "Connect your own ComfyUI server, generate stills and frame sets, and run the quality gate on them.",
    file: "docs/COMFYUI.md",
    group: "Providers",
    split: 2,
  },
  {
    slug: "scenario",
    title: "Set up Scenario",
    description: "Add Scenario's two-part credentials, pick a model, and see what each run cost.",
    file: "docs/SCENARIO.md",
    group: "Providers",
  },
  {
    slug: "cli",
    title: "CLI reference",
    description: "Every command and flag, with its JSON output and exit codes.",
    file: "docs/CLI.md",
    group: "Reference",
    split: 3,
  },
  {
    slug: "manifest",
    title: "Manifest reference",
    description: "The fields of a manifest: styles, assets, quality profiles, and how it is validated.",
    file: "docs/MANIFEST.md",
    group: "Reference",
    split: 2,
  },
  {
    slug: "mixed-providers",
    title: "Mixed-provider projects",
    description: "Send different styles to different providers, each with its own budget.",
    file: "docs/MIXED_PROVIDERS.md",
    group: "Providers",
  },
  {
    slug: "agents",
    title: "Agent workflows",
    description: "Install the agent skill and see what it tells an agent to do.",
    file: "docs/AGENTS.md",
    group: "Start here",
  },
  {
    slug: "characters",
    title: "Characters",
    description: "Draw a base in 4 or 8 directions from a prompt or your own sprite, then add states, loops, mirrors and portraits. Includes what each PixelLab engine costs.",
    file: "docs/CHARACTERS.md",
    group: "Guides",
  },
  {
    slug: "skeletons",
    title: "Skeletons and rigging",
    description: "The 18-joint skeleton every pose tool shares: estimate and correct one, animate from poses, pin items to a hand, pose frames with OpenPose, and rig a 3D model.",
    file: "docs/SKELETONS.md",
    group: "Guides",
  },
  {
    slug: "paperdoll",
    title: "Paperdoll layers",
    description: "Dress one bare character in outfits, hats and held items, each a transparent layer that matches every frame.",
    file: "docs/PAPERDOLL.md",
    group: "Guides",
    split: 2,
  },
  {
    slug: "characters-3d",
    title: "3D characters from sprites",
    description: "An experimental pipeline from directional sprites to a rigged, animated 3D character with separate items: a pixel path, a painted path, the steps, and what each costs.",
    file: "docs/CHARACTERS_3D.md",
    group: "Guides",
  },
  {
    slug: "generators",
    title: "Generator selection",
    description: "Pick a generator for the asset you need and see what it costs.",
    file: "docs/GENERATORS.md",
    group: "Guides",
  },
  {
    slug: "provider-benchmark",
    title: "Environment provider benchmark",
    description: "Thirty outputs from four providers, with ComfyUI cleanup, native-grid limits, and palette results.",
    file: "docs/PROVIDER_BENCHMARK.md",
    group: "Providers",
  },
  {
    slug: "research-3d",
    title: "Research: 3D models from sprites",
    description: "Every attempt to turn directional sprites into a 3D model, with pictures: from carving and sixteen redrawn directions to a rigged, animated character in separate parts.",
    file: "docs/RESEARCH_3D.md",
    group: "Research",
  },
  {
    slug: "recipes",
    title: "Versioned recipes",
    description: "Install pinned workflows and check their model hashes and quality rules.",
    file: "docs/RECIPES.md",
    group: "Guides",
  },
  {
    slug: "revisions",
    title: "Controlled asset revisions",
    description: "Change art you already have, keeping the parent's hash, with masks, approval gates and side-by-side review.",
    file: "docs/REVISIONS.md",
    group: "Guides",
  },
  {
    slug: "artifacts",
    title: "Derived artifacts",
    description: "Refine, pack, mount and export finished art, with a record of who approved it.",
    file: "docs/ARTIFACTS.md",
    group: "Guides",
  },
  {
    slug: "recovery",
    title: "Recovery and account safety",
    description: "Get paid work back without paying again, and clean up an account safely.",
    file: "docs/RECOVERY.md",
    group: "Guides",
  },
  {
    slug: "quality",
    title: "Quality gates",
    description: "Quality profiles, image baselines, human review, and checks for CI.",
    file: "docs/QUALITY.md",
    group: "Guides",
  },
  {
    slug: "architecture",
    title: "Architecture",
    description: "How the lockfile, providers, hand edits and the pinned editor fit together, and how files are written safely.",
    file: "docs/ARCHITECTURE.md",
    group: "Reference",
  },
  {
    slug: "library",
    title: "Library API",
    description: "The TypeScript functions and types PixelKiln exports.",
    file: "docs/LIBRARY.md",
    group: "Reference",
    split: 2,
  },
  {
    slug: "tiles",
    title: "Tiles and engine exports",
    description: "Tile roles, generic output, Tiled Wang sets and Godot terrains.",
    file: "docs/TILES.md",
    group: "Guides",
  },
  {
    slug: "endpoints",
    title: "Measured endpoints",
    description: "What PixelLab's API cost, accepted and refused in live runs, and what is still unknown.",
    file: "docs/ENDPOINTS.md",
    group: "Reference",
    split: 2,
  },
  {
    slug: "provider-notes",
    title: "Provider comparison",
    description: "PixelLab, Retro Diffusion, ComfyUI and Scenario side by side.",
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
    description: "Supported versions, the areas that need care, and how to report a vulnerability privately.",
    file: "SECURITY.md",
    group: "Policies",
  },
  {
    slug: "third-party",
    title: "Third-party notices",
    description: "Credit and licence text for other people's work that PixelKiln builds on, such as the pixelfx effects library.",
    file: "docs/THIRD_PARTY.md",
    group: "Policies",
  },
];

export const docGroups: DocGroup[] = ["Start here", "Providers", "Guides", "Reference", "Research", "Policies"];

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
