# Set up PixelLab

PixelLab is PixelKiln's default provider and the production choice for current
projects. Its generation and account-management paths have been exercised
against a live account.

[Visit PixelLab](https://www.pixellab.ai/) or open the
[official API reference](https://api.pixellab.ai/v2/docs).

## Add the credential

Create `.env.local` beside `pixelkiln.manifest.json`:

```dotenv
PIXELLAB_API_KEY=...
```

Keep this file out of Git. PixelKiln also reads the variable from the current
process environment.

## Select PixelLab

The `provider` field is optional because `pixellab` is the default. Declaring it
makes the choice clear:

```jsonc
{
  "name": "my-game",
  "provider": "pixellab",
  "styles": {
    "props": {
      "generator": "map",
      "outDir": "assets/generated/props",
      "promptSuffix": "isolated pixel-art game asset"
    }
  },
  "assets": {
    "anvil": {
      "prompt": "a compact blacksmith anvil",
      "width": 64,
      "height": 64
    }
  }
}
```

In a mixed manifest, put `"provider": "pixellab"` on a style only when the
top-level default is another backend.

Run the free checks before a paid request:

```bash
pixelkiln doctor --dry-run
pixelkiln plan
pixelkiln gen --budget 1
```

Copy the exact estimate from `plan` into `--budget`. PixelLab budgets use
subscription generations.

If selected stills need a shared final palette or native-grid gate, add
`style.quality` and run `pixelkiln refine` after download. Those offline settings
do not change PixelLab's request or cost. `pack` and `mount` then refuse raw or
unapproved files. See [Manifest quality profiles](./MANIFEST.md#quality-profiles).

## Choose a generator

| Generator | Start here when | Measured cost |
|---|---|---:|
| `map` | You need one prop, icon, building, or landmark at arbitrary dimensions | 1 generation |
| `pixflux` | You need a closed palette or a full-bleed background | 1 generation |
| `1dir` | You need references or several candidates for human review | 10 to 25 generations |
| `tiles` | You need ground variations or a connected structural set | 10 to 25 generations |
| `terrain` | You need a two-terrain Wang tileset (grass to water, floor to cliff), sets that share a terrain, or a sidescroller platform set | Pro 15 at 32px, 25 at 64px, standard 3, sidescroller 3 (all measured; standard plans at 4) |
| `isometricTile` | You need one standalone isometric tile, 16 to 64px | 1 generation (measured once) |
| `imagePro` | You need a larger or non-square scene, up to 792 wide and 688 tall, optionally held to the style's `palette` | 10 to 25 generations |
| `imageProFlash` | You need a still on the Pro Flash model, optionally styled from one image, 16 to 256px | 5 to 9 generations (provisional quote) |
| `vfx` | You need an animated effect (spell, hit, explosion, aura), on its own or around a sprite | free from presets and parts; 1 to 28 when described to PixelLab's artist (lite measured at 1) |
| `character` | You need a character in 4 or 8 directions, with states, loops, portraits, or outfits | See [Characters](./CHARACTERS.md) |
| `objectPro` | You need a prop or creature with rotations, states, or loops but no character rig | about 6 at 64px (unmeasured) |
| `uiAsset` | You need a UI panel composited from pieces and named elements, 192px and up | 20 generations (measured once) |
| `uiElement` | You need one UI element from a description, 16px and up | 10 to 25 generations (unmeasured) |

`map` accepts these values:

- `view`: `low top-down`, `high top-down`, or `side`
- `outline`: `single color outline`, `selective outline`, or `lineless`
- `shading`: `flat shading`, `basic shading`, `medium shading`, or `detailed shading`
- `detail`: `low detail`, `medium detail`, or `high detail`

PixelLab describes map objects as transparent, but the 256px map objects in our
[environment benchmark](./PROVIDER_BENCHMARK.md) were opaque. Check the alpha
channel before building a production batch. For a scenic background, use
`pixflux` with `noBackground: false`.

Read [Generator selection](./GENERATORS.md) for the full constraints and
measured economics. "10 to 25 generations" is a tier, not an exact figure:
`poll` reads what a completed job actually billed and records it as `billed`
beside the submit-time `cost` estimate a wave budget spends against;
`pixelkiln history`, `plan --json`, and the gallery show both when they
differ (docs/ENDPOINTS.md, "Limits and billing").

## Custom animation on skeleton v3

PixelLab's character creator can now animate a character on its skeleton v3
model from a sentence or from skeletons you pose, and the same two paths are
in the API. PixelKiln sends both from a manifest.

A loop with `mode: "skeleton-v3"` and no `template` animates its `prompt`:

```jsonc
"hero.cheer": {
  "prompt": "cheerfully waving both arms overhead",
  "animation": { "of": "hero", "mode": "skeleton-v3", "frames": 8, "directions": ["south"] }
}
```

An `animate-skeleton` revision poses the sprite along skeletons you give it.
`pixelkiln estimate-skeleton` writes the file from an image, you edit the
joints, and `skeleton-preview` draws them over the sprite before you spend:

```jsonc
"hero-wave": {
  "prompt": "wave",
  "styles": ["rig"],
  "revision": {
    "mode": "animate-skeleton", "from": "hero",
    "keypointsFile": "poses/wave.json", "direction": "south",
    "description": "cheerful adventurer with short auburn hair, blue tunic"
  }
}
```

- Both need a v3 character. A `standard` base has no 3D skeleton for the model
  to pose, so `plan` refuses the loop and names the engine.
- The revision's `prompt` is the motion ("wave") and its `description` is how
  the character looks. PixelLab requires both, and `plan` refuses a revision
  without a description.
- Each billed exactly 3 generations for 8 frames, measured live. The sentence
  loop came back at 96×96 from a 64px character; the posed one stayed 64×64.
  [The home page](https://pixelkiln.griffen.codes/#updates) shows both.
- Each direction of a sentence loop is its own request for now, so a loop with
  several directions can move a little differently in each. PixelLab can draw
  every direction from one motion, but PixelKiln does not send that yet.

See [Loops from a sentence](./CHARACTERS.md#loops-from-a-sentence) and
[Skeleton-driven animation](./REVISIONS.md#skeleton-driven-animation).

## What changed in PixelLab 0.4.130

PixelLab 0.4.130 (October 2026) added four things. PixelKiln covers each:

- **Tileset Pro.** Top-down Pro sets take roundness, connected diagonals, an
  uneven boundary, and edge slope, and sets can share a terrain. These are
  `terrain` style fields plus an asset's `connect`; see the
  [manifest reference](./MANIFEST.md). Sidescroller sets use
  `terrainOrientation: "sidescroller"`. The public API has no Pro mode for
  sidescrollers yet.
- **A target palette for Create Image Pro.** An `imagePro` style's `palette`
  now reaches PixelLab, which draws every pixel from it. `maxColors` caps
  each image and `paletteName` names the palette.
- **VFX in the API.** A `vfx` block with a `description` asks PixelLab's
  effects artist for the effect, at 1 generation and up. Presets, parts, and
  recipes still render free on the workbench. See
  [Generator selection](./GENERATORS.md#described-effects-the-paid-vfx-artist).
- **Normal maps.** A `normal-map` revision makes one for a sprite or a whole
  loop at 0.5 generations, and `pixelkiln normal-map` does it for a loose
  file. See [Controlled asset revisions](./REVISIONS.md#normal-maps).

Each has been billed live and matched the plan: Pro sets at 32px (15) and
64px (25, 25 tiles at transition 0.5), a second set connected to the first
(15), standard sets (3 each), a sidescroller set (3), a 64×64 `imagePro`
call with the Game Boy palette (10, every pixel one of its four colours), a
lite described effect (1), and normal maps (0.5 each). The home page's latest
updates section shows the results.

## Learn from PixelLab's tutorials

PixelLab's YouTube channel teaches its web app, not PixelKiln, but most of
its advice carries over. Two recent videos changed what we recommend.

### Pro tilesets

[PixelLab Pro Tilesets: Full Guide](https://www.youtube.com/watch?v=MbkqpDUFkEg)
covers the `terrain` generator's endpoint.

- End each terrain on the word "texture": `1). deep ocean water texture 2).
  plain smooth sand texture`. Without it, Pro sometimes scatters rocks,
  shells, or plants over the sand.
- Keep terrain prompts short and put style words in the style's
  `promptPrefix` or `promptSuffix`. Color, season, and outline words
  ("autumn", "frosty", "bold black outlines") change a set more than mood
  words do.
- On Pro, `terrainTransitionSize` is wall height. 0 is flat ground, 0.25 a
  low bank, and 0.5 or 1 a full wall in a 25-tile set.
- `terrainRaggedness` roughens the border; 0.8 gives a marsh edge.
  `terrainSpreadX` and `terrainSlopeSize` no longer change anything, because
  PixelLab's Pro pipeline stopped reading them.
- For clean 45° paths and coastlines, set `terrainConnectDiagonals: true`
  and `terrainRoundness: 2`. That is the video's "Connect diagonal corners"
  checkbox with roundness at 45°.
- To paint ocean, sand, and grass on one map, chain sets with `connect`:
  the sand-to-grass set's lower terrain is the ocean-to-sand set's upper.
  Every pair of terrains that touch needs its own set, or they meet with a
  hard edge.
- `terrainOrientation: "sidescroller"` makes platform sets: `1). mossy stone
  bricks texture 2). green grass texture`. The video's Pro sidescroller, at
  64px with a taller top layer, is only in PixelLab's web app.

### Animated effects

[How to Make Animated Pixel Art VFX in PixelLab](https://www.youtube.com/watch?v=t8FIMv-8QpI)
generates effects instead of rendering them. The `vfx` generator is free and
renders the same pixels every time, so try it first. Generate when the
effect is a drawn thing or a character's own motion, like a water hammer
that bursts into a splash or a sword that turns into lightning.

1. Draw a sheet of effects with one `imagePro` call. List one effect per
   frame in the prompt; a 64×64 canvas returns 16 candidates to pick from.
2. Animate the pick with an `animate-pixminimax` revision. Describe the
   motion, not the look, and ask a loop to return to its first state.
3. Pin an ending with `lastFrame` when the motion should land somewhere. An
   ice crystal can grow from a few blue pixels, or a `"engine": "pro-flash"`
   edit of the same sprite can be the ending it transforms into.
4. Clean up. `driftThreshold` or a `reduce-colors` revision fixes
   frame-to-frame color flicker, and `correct-pixelart` or `pixelkiln edit`
   removes stray pixels. Check whether a loop's last frame repeats its
   first.

Pad a growing effect onto a larger canvas before animating it, since a
revision animates its parent at the parent's own size. Long PixMiniMax clips
can also cost more than `plan` says: PixelLab prices a 40-frame 64×64 clip
at 6 generations, and PixelKiln estimates 3. Set `--budget` with that gap in
mind.

## Account workflows

The PixelLab adapter supports `balance`, `adopt`, `salvage`, `tag`, and the
separate confirmed `purge` flow. These are useful when several projects share
one provider account or when existing local art needs its original provenance.
Read [Recovery and account safety](./RECOVERY.md) before changing remote
objects.

### Editing an object in PixelLab's editor

A `map` or `1dir` generation is an object in your PixelLab account, and the
web app can edit it in place with its built-in editor. `pixelkiln gallery`
links each such record to the object (`https://www.pixellab.ai/create-object/<id>`)
and a `tiles` record to its set (`https://www.pixellab.ai/maps/tiles/<id>`),
and `pixelkiln fetch --refresh --only <asset>` pulls the edited bytes back
down: the local file is replaced only if the object changed upstream and the
local file is still exactly what PixelKiln wrote, and the lockfile records the
new bytes as this generation. A `pixflux` image is returned inline and keeps no
account object, so it cannot be edited upstream; use `pixelkiln edit` to touch
it up locally.

A character (a base, a state, or an animation) is an object too, at
`https://www.pixellab.ai/create-character/<id>`; `pixelkiln gallery` links
every character record there, since a state or animation records its base's
id rather than a page of its own. A character edited in PixelLab's character
editor comes back the same way. Its rotation and frame URLs carry the last
edit time (`?t=`), so a refresh asks `GET /characters/{id}` for the current
URLs before comparing bytes rather than trusting the ones the lockfile
recorded, and records the new URLs. A refreshed base makes its states and
animations stale, because their identity hashes the base's south file;
`pixelkiln gen` regenerates them.

## Four ways to drive PixelLab, and why this one

PixelLab is reachable four ways, and it is easy to conflate them when
comparing notes with someone using a different one:

- **PixelLab's Game Builder**, a hosted web IDE with its own chat agent and a
  git-backed project. Good for prototyping a whole game in the browser; not
  something PixelKiln talks to.
- **PixelLab's official
  [MCP server](https://github.com/pixellab-code/pixellab-mcp)**, for a
  third-party coding agent (Claude Code, Cursor) to call PixelLab tools
  directly mid-conversation. PixelLab's own tutorials are explicit that this
  is a deliberately partial surface: "the API provides everything that the
  MCP doesn't." Good for ad hoc, conversational generation; it has no concept
  of a project's state, a budget, or what has already been paid for.
  Complements PixelKiln rather than competing with it. It also carries
  `pixelart_workbench`, a free-for-subscribers command line for art you
  already have: `lint`, `score`, `inspect`, and `compare` report defects, and
  `shade`, `selout`, and `repair` return an improved copy under a new id.
  PixelLab's endpoint list has no matching REST call, so PixelKiln cannot
  drive it, and its subjects are account ids or image references, never file
  paths. Use it for a quick check or touch-up in conversation, then download
  the result and declare it as an asset's `source` to bring it under the
  manifest.
- **PixelLab's editor plugins for Aseprite and Pixelorama**, which bring
  PixelLab's create/edit/inpaint/animate/interpolate/reduce-colors tools into
  an existing pixel-art editor's own canvas and layers. Good for a human
  artist iterating by hand inside a familiar tool; like Game Builder, not
  something PixelKiln talks to — no manifest, no budget, no lockfile.
- **PixelKiln**, calling PixelLab's REST API directly. This is why: a
  manifest is a durable plan an agent can re-read and diff, `--budget` is an
  enforced ceiling instead of trusting an agent's per-call judgement, and the
  lockfile is what makes `plan`/`restore`/`audit` possible at all. It is also,
  independently, ahead of PixelLab's own reference integration for at least
  one concrete path: PixelLab's own Map Workshop → Godot export needs a
  third-party community plugin and manual tile-size entry, where PixelKiln's
  `pack --format godot` writes a native Godot 4 `TileSet` resource directly,
  verified in CI against a real headless Godot.

## What is outside this adapter

PixelLab offers more than PixelKiln currently exposes. Lip-sync and vocal
animation are not part of this adapter. Characters, their states, their
animations, their portraits, and outfit transfer onto their loops are the
`character` generator, with all four creation engines (standard, v3, pro,
pro-flash), reference sprites, concept images, style anchors, mirrors, and
every `animate-character` control; see [Characters](./CHARACTERS.md). Masked
inpainting, whole-image editing, and skeleton-driven animation (posing a
reference image frame-by-frame from a supplied keypoint skeleton, not a text
description) are the `revision` asset shape, not the `character` generator;
see [Controlled asset revisions](./REVISIONS.md). The same revision shape
animates, interpolates, recolors, cleans up, and makes normal maps for any
asset, a whole character or loop at once where the endpoint takes a set; `pixelkiln estimate-skeleton`
starts a skeleton file from an image. Pro Flash stills are the
`imageProFlash` generator, and Pro Flash edit and inpaint are a revision's
`"engine": "pro-flash"`. Object Creator is the
`objectPro` generator, UI panels and elements are `uiAsset` and `uiElement`,
and fonts, unzooming reference art, and normal maps for loose files are the
standalone `pixelkiln font`, `pixelkiln unzoom`, and `pixelkiln normal-map`
commands. Map Workshop
scene composition (placing objects and characters into a map, in-scene
inpainting, export) is a separate PixelLab product surface this adapter does
not model at all — including PixelKiln's own `map` generator, which is
unrelated to PixelLab's "Map Workshop" despite the shared name: `map` returns
one static prop in one generation. The one piece of style matching the public
`/map-objects` endpoint takes, drawing an object into an existing scene image,
is a `map` asset's `scene` field; see
[Drawing into a scene](./GENERATORS.md#drawing-into-a-scene). Use the
[manifest reference](./MANIFEST.md) for the fields PixelKiln supports today.
