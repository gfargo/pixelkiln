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
  /** A bold lead-in, then the rest of the caption (`backticks` mark code). */
  title: string;
  caption: string;
  /** `wide` figures take half the row, the rest a third. */
  wide?: boolean;
  /** Stretch the image to its cell, for a long, thin picture. */
  fill?: boolean;
};

export type UpdateAudio = {
  /** An MP3 or WAV under `public/`, made by a real call the docs record. */
  src: string
  /** A bold lead-in, then the rest of the caption (`backticks` mark code). */
  title: string;
  caption: string;
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
  /** Clips to play, for an update about sound. Nothing loads until one is pressed. */
  audio?: UpdateAudio[];
  code?: { title: string; language: "shell" | "json"; copyId: string; code: string };
  links: { id: string; label: string; href: string }[];
};

export const providerUpdates: ProviderUpdate[] = [
  {
    id: "pixellab-normal-map-controls",
    provider: "PixelLab",
    date: "November 2026",
    title: "Normal maps for a fifth of the price, shaped the way you want",
    summary:
      "PixelLab added a lite mode to its normal maps and made it the default, so a map that billed 0.5 generation now bills 0.1. It also added controls for how a flat sprite is read as a surface. `pixelkiln normal-map` and the `normal-map` revision send them, and `plan` prices the new default.",
    features: [
      "`--mode lite` is 0.1 generation and `--mode pro` 0.5. Both were billed live; on this knight the two maps were close.",
      "`--surface-detail`, `--part-shapes` and `--outline-rounding` set how much relief the map has. All at 0 gives a completely flat map.",
      "`--detail-softness` blurs the detail into a smooth form, and `--strength` scales the tilt, up to 2.",
      "`--kind` tells PixelLab what the picture is, for sidescroller, isometric and UI art.",
      "In a manifest these are fields on a `normal-map` revision, and a map made before them is not stale.",
    ],
    figures: [
      {
        src: "/showcase/normals/knight-controls.png",
        alt: "A knight sprite and four normal maps of it: moderately detailed, completely flat, deeply sculpted, and smooth",
        width: 1328,
        height: 272,
        title: "one sprite, four maps",
        caption: "the sprite, then PixelLab's defaults, every control at 0, every control at its maximum, and maximum softness. 0.1 generation each.",
        wide: true,
        fill: true,
      },
    ],
    code: {
      title: "terminal",
      language: "shell",
      copyId: "updates_normal_map_commands",
      code: `
pixelkiln normal-map --from art/knight.png
pixelkiln normal-map --from art/knight.png --surface-detail 2 --part-shapes 2 --detail-softness 0.6
pixelkiln normal-map --from art/knight.png --mode pro --kind character
`,
    },
    links: [
      { id: "updates_normal_map_reference", label: "Read the normal-map reference", href: "/docs/cli#normal-map" },
      { id: "updates_normal_map_revisions", label: "Normal maps in a manifest", href: "/docs/revisions#normal-maps" },
      { id: "updates_normal_map_measured", label: "See what was measured", href: "/docs/endpoints#normal-map-post-normal-map-measured-once" },
    ],
  },
  {
    id: "pixellab-tileset-options",
    provider: "PixelLab",
    date: "November 2026",
    title: "Tilesets take your own textures, and platform sets cost a third",
    summary:
      "PixelLab replaced its sidescroller tileset model and added controls to both tileset endpoints. PixelKiln sends them from a manifest, and `plan` now prices a standard platform set at 1 generation, where it was 3. Every set below was generated for this page and billed what is shown.",
    features: [
      "`terrainReferences` hands PixelLab a PNG per terrain. It is used almost as the texture itself: the two striped swatches at right became the fill.",
      "A sidescroller set takes `terrainMode`: standard for 1 generation, pro for 15. A standard set cannot connect to another, and `plan` says so before spending.",
      "`terrainSideWallThickness` and `terrainSideWallPlacement` shape the wall on a raised bank; `terrainShapeSeed` reshuffles a ragged border.",
      "`terrainEnhance: false` uses your terrain descriptions as written, and the walkable flags are stored with the set for maps and exports.",
      "None of this moves an existing lockfile: each option enters a set's identity only when you set it.",
    ],
    figures: [
      {
        src: "/showcase/tilesets/references.png",
        alt: "A sixteen-tile set of teal striped pools in a purple striped floor, beside the two small striped swatches it was made from",
        width: 849,
        height: 169,
        title: "your texture, their borders",
        caption: "a standard set from two hand-made 16×16 swatches (right). 1 generation.",
        wide: true,
        fill: true,
      },
      {
        src: "/showcase/tilesets/sidescroller-modes.png",
        alt: "Two sixteen-tile platform sets: light mossy stonework above, denser earth with a bright grass cap below",
        width: 667,
        height: 345,
        title: "standard above, pro below",
        caption: "the same prompt as a sidescroller set on each mode. 1 generation and 15.",
        wide: true,
        fill: true,
      },
    ],
    code: {
      title: "pixelkiln.manifest.json",
      language: "json",
      copyId: "updates_tileset_manifest",
      code: `
"styles": {
  "cave":  { "generator": "terrain", "size": 16, "outDir": "tiles/cave" },
  "ledge": { "generator": "terrain", "size": 16, "outDir": "tiles/ledge",
             "terrainOrientation": "sidescroller", "terrainTransitionSize": 0.25,
             "terrainPlatformThickness": 0.8 }
},
"assets": {
  "pool": {
    "prompt": "1). teal slime pool 2). purple crystal floor", "styles": ["cave"],
    "terrainReferences": { "lower": "refs/slime.png", "upper": "refs/crystal.png" }
  },
  "moss": { "prompt": "1). mossy stone bricks 2). green grass", "styles": ["ledge"] }
}
`,
    },
    links: [
      { id: "updates_tileset_references", label: "Terrain reference images", href: "/docs/tiles#terrain-reference-images" },
      { id: "updates_tileset_fields", label: "Every terrain field", href: "/docs/manifest#style-fields" },
      { id: "updates_tileset_measured", label: "See what was measured", href: "/docs/endpoints#tileset-options-november-2026-measured" },
    ],
  },
  {
    id: "pixellab-asset-upkeep",
    provider: "PixelLab",
    date: "November 2026",
    title: "Bring your own sprite, turn it eight ways, take it to your editor",
    summary:
      "PixelLab opened up the upkeep its website does to an asset. `pixelkiln asset` imports your own art, expands it to 8 directions, resizes its canvas, and exports it, and `pixelate --pro` reaches the strongest converter. The knight below was imported as one PNG; the other seven directions billed exactly 10 generations.",
    features: [
      "`asset import` stores your PNG as an object, exactly as drawn, for free.",
      "`asset expand` draws the 7 missing directions for 10 to 25 generations. `asset review` downloads them first, then `--keep` or `--discard`.",
      "`asset export` writes a ZIP, a spritesheet with its layout, an `.aseprite` file, or a turning GIF. All free.",
      "`asset canvas` adds or trims transparent margin without scaling the art, and PixelLab's own reason is shown when it refuses.",
      "`pixelate --pro` is the careful converter: 20 generations, a larger and more faithful result, plus the same image on a reduced palette.",
    ],
    figures: [
      {
        src: "/showcase/assets/knight-8dir.png",
        alt: "An armored knight with a blue cape seen from eight directions in a row, starting from the front",
        width: 1128,
        height: 568,
        title: "one sprite in, eight directions out",
        caption: "top left is the imported PNG, unchanged; the other seven came from `asset expand`. 10 generations.",
        wide: true,
        fill: true,
      },
      {
        src: "/showcase/assets/pixelate-compare.png",
        alt: "The same knight three times: a smooth render, a chunky pixel art version, and a finer pixel art version",
        width: 1016,
        height: 348,
        title: "render, Pro Flash, Pro",
        caption: "the source, `pixelate` (108×109, 6 generations), and `pixelate --pro` (161×151, 20 generations).",
        wide: true,
        fill: true,
      },
    ],
    code: {
      title: "terminal",
      language: "shell",
      copyId: "updates_asset_commands",
      code: `
pixelkiln asset import --from art/knight.png --name knight
pixelkiln asset expand --id <object id> --direction south
pixelkiln asset review --id <object id> --out review/
pixelkiln asset expand --id <object id> --keep
pixelkiln asset export --id <object id> --format aseprite --out art/knight
`,
    },
    links: [
      { id: "updates_asset_reference", label: "Read the asset reference", href: "/docs/cli#asset" },
      { id: "updates_asset_pixelate", label: "Read the pixelate reference", href: "/docs/cli#pixelate" },
      { id: "updates_asset_measured", label: "See what was measured", href: "/docs/endpoints#asset-upkeep-and-the-pro-converter-measured" },
    ],
  },
  {
    id: "pixellab-ui-states",
    provider: "PixelLab",
    date: "November 2026",
    title: "UI panels become buttons with states and 9-slice",
    summary:
      "A generated UI panel used to be one flat image. PixelLab now splits it into elements, draws their states, and stores stretch insets, and `pixelkiln ui` does all three and pulls the pieces down. The states below billed exactly 10 generations.",
    features: [
      "`ui split` cuts a template into one element per shape, free. `ui show` lists the boxes before you commit.",
      "`ui states` draws hover, pressed, or any state you describe for every element in one generation, so a set matches: 10, 15 or 25 generations by size.",
      "`ui nine-slice` sets the border insets that stay crisp when a panel or button is stretched, free.",
      "`ui pull` writes every image and a `ui.json` with each piece's box, size, insets and hash.",
      "A state is not the size of its element: an 86x38 button came back 85x46 hovered and 82x42 pressed, so anchor by the centre.",
    ],
    figures: [
      {
        src: "/showcase/ui/button-states.png",
        alt: "The same parchment panel piece three times: as generated, brighter with a glowing rim, and darker",
        width: 1076,
        height: 216,
        title: "one element, two states",
        caption: "the split element, then `hover` and `pressed` from one call. 10 generations.",
        wide: true,
        fill: true,
      },
    ],
    code: {
      title: "terminal",
      language: "shell",
      copyId: "updates_ui_commands",
      code: `
pixelkiln ui split --id <template id>
pixelkiln ui nine-slice --id <element id> --insets 8,8,6,6
pixelkiln ui states --id <template id> \\
  --state "hover=brighter, a soft glow on the rim" \\
  --state "pressed=pushed in: darker, the face one pixel lower"
pixelkiln ui pull --id <template id> --out ui/dialog
`,
    },
    links: [
      { id: "updates_ui_reference", label: "Read the ui reference", href: "/docs/cli#ui" },
      { id: "updates_ui_measured", label: "See what was measured", href: "/docs/endpoints#ui-split-states-and-9-slice-measured" },
    ],
  },
  {
    id: "pixellab-audio",
    provider: "PixelLab",
    date: "November 2026",
    title: "Music and sound effects, from the same account as your art",
    summary:
      "PixelLab now makes game music and sound effects. `pixelkiln music` and `pixelkiln sfx` write the audio beside a record of what made it. Every price below was read from a real bill.",
    features: [
      "`music` returns two takes of a song as MP3 for 10 generations. `--loop` adds seamless loops with a loop start and loop end for 4 more.",
      "`sfx` writes one WAV, 0.5 to 30 seconds, from 1 generation: a 1 second laser shot billed 1 and a 3 second clip billed 2.",
      "`music style` turns a short idea into a full style and `music lyrics` drafts two sets of lyrics, at 0.05 generations each.",
      "A loop needs 36 seconds of music between the intro and the ending, so `--loop` on a shorter song is refused before anything is sent.",
      "Audio stays outside the manifest for now: each file gets a `.music.json` or `.sfx.json` record with its id, hash, length, and bill.",
    ],
    audio: [
      { src: "/showcase/audio/town-theme.mp3", title: "town theme", caption: "\"Calm chiptune town theme\", 30 seconds at 100 BPM, take 1 of 2. 10 generations for both." },
      { src: "/showcase/audio/laser.wav", title: "laser shot", caption: "`sfx --seconds 1`. 1 generation." },
      { src: "/showcase/audio/chest.wav", title: "chest opening", caption: "`sfx --seconds 3`. 2 generations." },
    ],
    code: {
      title: "terminal",
      language: "shell",
      copyId: "updates_audio_commands",
      code: `
pixelkiln music --description "Upbeat 8-bit dungeon theme: a fast square-wave lead, a pulsing triangle bass, crisp noise drums" \\
  --bpm 140 --seconds 60 --loop --out audio/dungeon
# writes audio/dungeon.mp3  .take2.mp3  .loop.mp3  .loop.take2.mp3  .music.json

pixelkiln sfx --description "a sci-fi laser gun firing a single shot" --seconds 1 --out audio/laser
# writes audio/laser.wav  .sfx.json
`,
    },
    links: [
      { id: "updates_audio_music", label: "Read the music reference", href: "/docs/cli#music" },
      { id: "updates_audio_sfx", label: "Read the sfx reference", href: "/docs/cli#sfx" },
      { id: "updates_audio_measured", label: "See what was measured", href: "/docs/endpoints#music-and-sound-effects-measured" },
    ],
  },
  {
    id: "pixellab-skeleton-v3-custom",
    provider: "PixelLab",
    date: "October 2026",
    title: "Custom animation on skeleton v3, from a sentence or your own poses",
    summary:
      "PixelLab's character creator now animates a character from one sentence or from skeletons you pose. PixelKiln sends both from a manifest. Each loop below billed exactly 3 generations for 8 frames.",
    features: [
      "A `skeleton-v3` loop with a `prompt` and no `template` animates the sentence: 3 to 15 frames, on a v3 character.",
      "`animate-skeleton` poses your own 18-joint skeletons, and `pixelkiln estimate-skeleton` starts the file from an image.",
      "A standard character has no 3D skeleton, so `plan` refuses it and says why.",
      "Each direction of a sentence loop is its own request for now, so directions can move a little differently.",
    ],
    figures: [
      {
        src: "/showcase/skeleton/wave-sentence.gif",
        still: "/showcase/skeleton/wave-sentence-still.png",
        alt: "An adventurer with auburn hair and a blue tunic waving both arms overhead",
        width: 288,
        height: 288,
        title: "from a sentence",
        caption: "\"cheerfully waving both arms overhead\", 8 frames at 96×96. 3 generations.",
        wide: true,
      },
      {
        src: "/showcase/skeleton/wave-custom-pose.gif",
        still: "/showcase/skeleton/wave-custom-pose-still.png",
        alt: "The same adventurer raising and swinging both arms, following poses drawn by hand",
        width: 256,
        height: 256,
        title: "from hand-edited poses",
        caption: "eight skeletons edited from `estimate-skeleton`, 64×64. 3 generations.",
        wide: true,
      },
    ],
    code: {
      title: "pixelkiln.manifest.json",
      language: "json",
      copyId: "updates_skeleton_manifest",
      code: `
"hero.cheer": {
  "prompt": "cheerfully waving both arms overhead",
  "animation": { "of": "hero", "mode": "skeleton-v3", "frames": 8, "directions": ["south"] }
},
"hero-wave": {
  "prompt": "wave",
  "revision": {
    "mode": "animate-skeleton", "from": "hero",
    "keypointsFile": "poses/wave.json", "direction": "south",
    "description": "cheerful adventurer, blue tunic, red satchel"
  }
}
`,
    },
    links: [
      { id: "updates_skeleton_guide", label: "Read the PixelLab guide", href: "/docs/pixellab#custom-animation-on-skeleton-v3" },
      { id: "updates_skeleton_sentence", label: "Loops from a sentence", href: "/docs/characters#loops-from-a-sentence" },
      { id: "updates_skeleton_poses", label: "Pose a skeleton yourself", href: "/docs/revisions#skeleton-driven-animation" },
    ],
  },
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
      "A style's `palette` now reaches Create Image Pro, and `maxColors` caps each candidate. PixelLab has since added it to more tools, and PixelKiln sends it to Pro Flash stills, tiles, Pro terrain, objects, UI, and Pro characters.",
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
