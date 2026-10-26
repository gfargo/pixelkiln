/**
 * What the home page's "Latest updates from our providers" section shows.
 *
 * To add an update, put a new entry at the TOP of `providerUpdates`. The
 * newest entry gets the full treatment (large figures, a code sample, and a
 * checklist); every earlier one collapses to a row with a short list and, if
 * it has `figures`, a small strip beneath it (its `code` is ignored). Only
 * list what PixelKiln can use today, and only show images that came from a
 * real call with a bill the docs record.
 */

export type UpdateProvider = "PixelLab" | "Retro Diffusion" | "ComfyUI" | "Scenario";

export type UpdateFigure = {
  src: string;
  /** A still frame for visitors who prefer reduced motion, when `src` is a GIF. */
  still?: string;
  alt: string;
  width: number;
  height: number;
  /** A bold lead-in, then the rest of the caption. */
  title: string;
  caption: string;
  /** `wide` figures take half the row, the rest a third. */
  wide?: boolean;
  /** Stretch the image to its cell, for a long, thin picture. */
  fill?: boolean;
};

export type ProviderUpdate = {
  id: string;
  provider: UpdateProvider;
  /** The provider's own release name, when it has one. Leave it out otherwise. */
  release?: string;
  /** As shown, such as "October 2026". */
  date: string;
  title: string;
  /** `Backticks` mark code. */
  summary: string;
  /** One line each, as a checklist on the newest entry and a list on the rest. `Backticks` mark code. */
  features: string[];
  figures?: UpdateFigure[];
  code?: { title: string; language: "shell" | "json"; copyId: string; code: string };
  links: { id: string; label: string; href: string }[];
};

export const providerUpdates: ProviderUpdate[] = [
  {
    id: "pixellab-0-4-130",
    provider: "PixelLab",
    release: "0.4.130",
    date: "October 2026",
    title: "Connected tilesets, palettes, normal maps, and described effects",
    summary:
      "Every image below came from a real call, and each one billed exactly what `pixelkiln plan` said it would.",
    features: [
      "A connected set waits for the set it shares a terrain with, sends that set's tile id, and goes stale when it is regenerated.",
      "`terrainRoundness: 2` with `terrainConnectDiagonals` cuts the coast at 45°. Sidescroller platform sets cost 3.",
      "A style's `palette` now reaches Create Image Pro, and `maxColors` caps each candidate.",
      "`pixelkiln normal-map` and `vfx --description` do the same for loose files.",
    ],
    figures: [
      {
        src: "/showcase/tilesets/island.png",
        alt: "A sandy island with a grass meadow in the middle, surrounded by ocean, edges cut at 45 degrees",
        width: 448,
        height: 320,
        title: "two connected Pro sets",
        caption: "ocean to sand, then sand to grass, which shares the first set's sand. 15 generations each.",
        wide: true,
      },
      {
        src: "/showcase/tilesets/dungeon.png",
        alt: "Dark stone dungeon floors raised over a lava sea, with brick walls dropping into the lava and lava pits cut into the floors",
        width: 512,
        height: 480,
        title: "one Pro set with tall walls",
        caption: "lava under dungeon stone at 64px, transition 0.5: 25 tiles, walls included. 25 generations.",
        wide: true,
      },
      {
        src: "/showcase/palette/chest.png",
        alt: "A treasure chest drawn in the four Game Boy greens",
        width: 192,
        height: 192,
        title: "Game Boy palette",
        caption: "imagePro, 16 candidates, every pixel one of four colours. 10 generations.",
      },
      {
        src: "/showcase/normals/chest-relit.gif",
        still: "/showcase/normals/chest-relit-still.png",
        alt: "The same chest lit by a light circling it, using its normal map",
        width: 192,
        height: 192,
        title: "normal-map revision",
        caption: "the chest under a moving light. 0.5 generations.",
      },
      {
        src: "/showcase/effects/fireball-described.gif",
        still: "/showcase/effects/fireball-described-still.png",
        alt: "A small orange fireball with a flickering trail",
        width: 326,
        height: 52,
        title: "described effect",
        caption: "\"a small orange fireball flying right\", lite artist. 1 generation.",
        fill: true,
      },
    ],
    code: {
      title: "pixelkiln.manifest.json",
      language: "json",
      copyId: "updates_manifest",
      code: `
"sand-grass": {
  "prompt": "1). plain smooth sand texture 2). plain short grass texture",
  "connect": { "lower": { "of": "ocean-sand", "terrain": "upper" } }
},
"chest-normals": {
  "styles": ["lit"],
  "revision": { "mode": "normal-map", "from": "chest", "fromStyle": "gameboy" }
}
`,
    },
    links: [
      { id: "updates_pixellab_0_4_130", label: "Read what changed in 0.4.130", href: "/docs/pixellab#what-changed-in-pixellab-0-4-130" },
      { id: "updates_tiles", label: "Export tilesets to Tiled and Godot", href: "/docs/tiles" },
    ],
  },
  {
    id: "pixellab-0-4-128",
    provider: "PixelLab",
    release: "0.4.128",
    date: "October 2026",
    title: "A Pro price cut, Image to Pixel Art Pro Flash, and Create VFX",
    summary:
      "Every Pro tool dropped from 20, 25, or 40 generations to 10, 15, or 25, and pixelkiln plans with the new prices.",
    features: [
      "`pixelkiln pixelate` turns a photo, painting, or render into pixel art for 6 generations.",
      "`pixelkiln vfx` renders animated effects from presets and parts, free on a subscription.",
    ],
    links: [
      { id: "updates_pixellab_0_4_128", label: "Pixelate reference", href: "/docs/cli#pixelate" },
      { id: "updates_vfx", label: "vfx reference", href: "/docs/cli#vfx" },
    ],
  },
  {
    id: "scenario-tool-chain",
    provider: "Scenario",
    date: "October 2026",
    title: "Scenario's tool models, chained in one manifest",
    summary:
      "PixelKiln runs Scenario's Pixelate and background-removal models as steps after a render. This chain cost 8 compute units, and every quote matched its bill.",
    features: [
      "`revision.fromStyle` names the parent's style, so `pixelkiln gen` runs the render, the Pixelate step, and the cutout in order, one wave per link.",
      "Pixelate (`model_sc-pixelate`, 5 CU) puts the render on a 64-cell grid and a 32-colour palette, and Birefnet (2 CU) removes the background.",
      "`pixelkiln refine` finishes it for free: a 64×64 transparent sprite that waits for a person's approval.",
    ],
    figures: [
      {
        src: "/benchmarks/provider-scenario-showcase/chain-1-render.png",
        alt: "A knight rendered by FLUX.2 Klein 9b on a white background",
        width: 256,
        height: 256,
        title: "1 CU",
        caption: "render",
      },
      {
        src: "/benchmarks/provider-scenario-showcase/chain-2-pixelate.png",
        alt: "The knight pixelated onto a 32-colour palette",
        width: 256,
        height: 256,
        title: "5 CU",
        caption: "Pixelate",
      },
      {
        src: "/benchmarks/provider-scenario-showcase/chain-3-cutout.png",
        alt: "The pixelated knight with its background removed",
        width: 256,
        height: 256,
        title: "2 CU",
        caption: "Birefnet cutout",
      },
      {
        src: "/benchmarks/provider-scenario-showcase/chain-4-refined.png",
        alt: "The final 64 by 64 transparent knight sprite after refinement",
        width: 256,
        height: 256,
        title: "free",
        caption: "refine, 64×64",
      },
    ],
    links: [
      { id: "updates_scenario_chain", label: "Chaining models and tools", href: "/docs/scenario#chaining-models-and-tools" },
      { id: "updates_scenario_across_styles", label: "Revise across styles", href: "/docs/revisions#across-styles" },
    ],
  },
];
