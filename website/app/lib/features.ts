/**
 * The site's feature pages: one entry drives the header menu, the hub on the
 * home page, the "more of PixelKiln" strip under each page, and the sitemap.
 */
export type FeatureGroup = "Run the pipeline" | "Make the art" | "Choose a provider";

export type Feature = {
  id: "pipeline" | "review" | "characters" | "paperdoll" | "effects" | "providers";
  href: string;
  /** Its name in the menu and the hub. */
  name: string;
  group: FeatureGroup;
  /** One sentence for the menu and the hub. */
  summary: string;
  /** The page's own title and opening line. */
  title: string;
  deck: string;
  description: string;
  /** Sections on the page, for the jump list under its title. */
  sections: Array<{ href: string; label: string }>;
  /** Where the documentation for it starts. */
  docs: Array<{ href: string; label: string }>;
};

export const FEATURES: Feature[] = [
  {
    id: "pipeline",
    href: "/pipeline",
    name: "How it works",
    group: "Run the pipeline",
    summary: "One manifest, a price before you spend, and a record of every paid file.",
    title: "Declare, price, generate, ship.",
    deck: "One committed manifest drives every step. PixelKiln prices the run offline, saves each remote id before polling, and can restore paid work without paying twice.",
    description: "How PixelKiln turns one manifest into priced, recoverable, hash-recorded pixel art.",
    sections: [
      { href: "#workflow", label: "The five steps" },
      { href: "#recovery", label: "Recovering paid work" },
    ],
    docs: [
      { href: "/docs/getting-started", label: "Quickstart" },
      { href: "/docs/manifest", label: "Manifest reference" },
      { href: "/docs/recovery", label: "Recovery guide" },
    ],
  },
  {
    id: "review",
    href: "/review",
    name: "Review and gallery",
    group: "Run the pipeline",
    summary: "Pick candidates, touch sprites up in the browser, and approve the exact pixels.",
    title: "Pick, edit, approve.",
    deck: "A local page shows every candidate, loop and file in the project. You choose, retouch and approve; the lockfile records what you decided.",
    description: "PixelKiln's local review sheet and project gallery: choose candidates, edit sprites and approve final pixels.",
    sections: [
      { href: "#review", label: "Choosing candidates" },
      { href: "#gallery", label: "The project gallery" },
    ],
    docs: [
      { href: "/docs/cli/pick", label: "The pick command" },
      { href: "/docs/cli/gallery", label: "The gallery command" },
      { href: "/docs/quality", label: "Quality profiles" },
    ],
  },
  {
    id: "characters",
    href: "/characters",
    name: "Characters and loops",
    group: "Make the art",
    summary: "A base in eight directions, then every animation drawn from it.",
    title: "One base, every animation.",
    deck: "Draw a character once in four or eight directions. Walks, attacks and states are generated from that base, and mirrored loops cost nothing.",
    description: "Generate a character base and its animation loops with PixelKiln, with mirrors and cleaned frames.",
    sections: [{ href: "#characters", label: "Bases and loops" }],
    docs: [
      { href: "/docs/characters", label: "Characters guide" },
      { href: "/docs/characters#mirrors", label: "Mirrors" },
    ],
  },
  {
    id: "paperdoll",
    href: "/paperdoll",
    name: "Paperdoll layers",
    group: "Make the art",
    summary: "Outfits, hair, held items and skin tones as separate layers over one body.",
    title: "Dress one body in layers.",
    deck: "Armour, hair, hats and held items are each their own asset over one bare character, so a game can switch any of them. Colours and skin tones are recoloured for nothing.",
    description: "Paperdoll layers in PixelKiln: outfits, headwear, held items and skin tones generated as separate sprites, with a live character builder.",
    sections: [
      { href: "#paperdoll", label: "How layers are made" },
      { href: "#paperdoll-builder", label: "Build a character" },
    ],
    docs: [
      { href: "/docs/paperdoll", label: "Paperdoll guide" },
      { href: "/docs/paperdoll/cost-and-limits", label: "Cost and limits" },
    ],
  },
  {
    id: "effects",
    href: "/effects",
    name: "Effects",
    group: "Make the art",
    summary: "Auras, lightning, shields and hits rendered on your own sprites, free.",
    title: "Effects on your own sprites.",
    deck: "Spell auras, hits and shields are rendered locally over sprites you already have, as frames a game can play. No provider call, no cost.",
    description: "Free, locally rendered pixel-art effects over your own sprites with PixelKiln's vfx command.",
    sections: [{ href: "#effects", label: "Effect presets" }],
    docs: [{ href: "/docs/cli#vfx", label: "The vfx command" }],
  },
  {
    id: "providers",
    href: "/providers",
    name: "Providers and costs",
    group: "Choose a provider",
    summary: "PixelLab, Retro Diffusion, ComfyUI and Scenario, measured on the same prompts.",
    title: "Four providers, measured.",
    deck: "PixelLab, Retro Diffusion, ComfyUI and Scenario run through the same plan, review and lockfile. These are the results and prices from the same prompts.",
    description: "PixelKiln's provider results: PixelLab, Retro Diffusion, ComfyUI and Scenario compared on the same prompts, with measured costs.",
    sections: [
      { href: "#providers", label: "Results by provider" },
      { href: "#scenario", label: "Scenario, measured" },
      { href: "#costs", label: "What a sprite costs" },
    ],
    docs: [
      { href: "/docs/provider-benchmark", label: "Benchmark" },
      { href: "/docs/provider-notes", label: "Provider notes" },
      { href: "/docs/mixed-providers", label: "Mixing providers" },
    ],
  },
];

export const FEATURE_GROUPS: FeatureGroup[] = ["Run the pipeline", "Make the art", "Choose a provider"];

export function feature(id: Feature["id"]): Feature {
  return FEATURES.find((entry) => entry.id === id)!;
}

/** The documentation menu: where to start, the guides, and each provider's setup. */
export const DOC_MENU: Array<{ label: string; links: Array<{ href: string; label: string }> }> = [
  {
    label: "Start",
    links: [
      { href: "/docs/getting-started", label: "Quickstart" },
      { href: "/docs/cli", label: "Commands" },
      { href: "/docs/manifest", label: "Manifest reference" },
      { href: "/docs/agents", label: "Agent setup" },
    ],
  },
  {
    label: "Guides",
    links: [
      { href: "/docs/characters", label: "Characters" },
      { href: "/docs/paperdoll", label: "Paperdoll layers" },
      { href: "/docs/tiles", label: "Tiles and terrain" },
      { href: "/docs/revisions", label: "Revisions" },
      { href: "/docs/recovery", label: "Recovery" },
      { href: "/docs/quality", label: "Quality profiles" },
    ],
  },
  {
    label: "Provider setup",
    links: [
      { href: "/docs/pixellab", label: "PixelLab" },
      { href: "/docs/retro-diffusion", label: "Retro Diffusion" },
      { href: "/docs/comfyui", label: "ComfyUI" },
      { href: "/docs/scenario", label: "Scenario" },
      { href: "/docs/generators", label: "Generators compared" },
    ],
  },
];
