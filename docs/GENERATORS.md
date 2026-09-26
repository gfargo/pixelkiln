# Generator selection

Choosing the generator is the largest cost and capability decision in a
PixelKiln manifest. The figures here were measured against a live PixelLab
account; [ENDPOINTS.md](./ENDPOINTS.md) contains the detailed experiments.

## Quick choice

| You need | Generator | Measured cost | Candidates/output |
|---|---|---:|---|
| Standalone prop or icon with arbitrary dimensions | `map` (default) | 1 generation | 1 |
| Exact fixed palette | `pixflux` | 1 generation | 1 inline image |
| Candidate variety, richer rendering, future rotation/animation | `1dir` | 20–40 generations | 4–64 by size |
| Ground tiles or connectable structural sets | `tiles` | 20–40 generations | variations or complete set |
| A single elevation tile — a raised mesa, a cliff block | `isometricTile` | 1 generation | 1 |
| Controlled pose/expression sequence in ComfyUI | `frames` | 0 `free` provider units | one atomic ordered set |
| A character facing 4 or 8 directions, its poses, and its animations | `character` | 1 per base (standard), 20–40 per pose, 1 per template loop | one set of directions, or one ordered loop |
| UI chrome — panels, buttons, health bars, toolbars | `uiAsset` | 20 generations (measured once, at 256x192) | 1 composited image |
| One UI element from a description, 16px and up, optionally guided by a concept image | `uiElement` | 20–40 generations (unmeasured) | 1 image |

Start with `map` unless a required capability points elsewhere. Forty `map`
re-rolls cost the same as one 64×64 `1dir` call.

## `map`

`map` calls PixelLab's map-object endpoint. It is purpose-built for isolated
props, badges, and icons, supports arbitrary width/height, and costs a flat one
generation at every supported size.

Use it when:

- one result per prompt is acceptable;
- prompt prose can carry the style;
- exact palette conformance and reference-image transfer are not required.

It does not accept style images or a forced palette. On a measured 1-bit restyle,
switching from reference-anchored generation to `map` changed median palette
distance from 6.6 to 41.9; cheap output is not cheap when unusable.

The API describes map objects as transparent, but both 256px isolated-object
attempts in the [environment provider benchmark](./PROVIDER_BENCHMARK.md) were
opaque. `map` has no `noBackground` control in PixelKiln. Check alpha before
assuming the file can be placed directly over a map.

## `1dir`

`1dir` is the single-facing sibling of PixelLab's rotatable/animated object
pipeline. It is square and priced by canvas area:

| Pixel area | Cost |
|---:|---:|
| ≤1024 | 20 |
| ≤2048 | 25 |
| larger | 40 |

Candidate count is also size-derived and does not reduce price:

| Square size | Candidates |
|---:|---:|
| ≤42 | 64 |
| ≤85 | 16 |
| ≤170 | 4 |
| >170 | 1 |

Use `1dir` when candidate comparison, rendering detail, rotations, or animation
justify the price. Style reference images are its strongest consistency tool.
The largest reference determines output size, so references should already be
at the target resolution. Keep style references separate from live assets:
editing a reference intentionally invalidates every spec using it.

Candidate scoring is deterministic RGB palette-distance arithmetic. No LLM
selects the artwork; the local contact sheet exists for human judgment.

### Batch: several distinct objects for one call's cost

`1dir`'s own candidate mechanic (the table above) normally returns several
variations of *one* prompt to choose from. PixelLab's
`/create-1-direction-object` also accepts `item_descriptions`: instead of N
variations of one thing, N *different* described things, for the exact same
canvas-tiered price — a loot table's worth of icons for the cost of one call.

One asset is the batch leader (an ordinary `1dir` asset; its own `prompt` is
implicitly slot 0), and its siblings claim the remaining slots:

```jsonc
{
  "assets": {
    "chest": { "prompt": "a treasure chest" },
    "potion": { "prompt": "a health potion", "batch": { "of": "chest", "index": 1 } },
    "key": { "prompt": "a rusty key", "batch": { "of": "chest", "index": 2 } }
  }
}
```

`index` is 1-based, unique, and contiguous among siblings (the leader is
implicitly 0); the total (1 + members) cannot exceed the size's own candidate
count from the table above (16 at ≤85px, for example). Every member must
share the leader's exact canvas size — they are one API call, one size.

**Only the leader spends.** Its `estimate()` prices the whole call, same as a
standalone `1dir` asset of that size; every member reports zero cost, so
`--budget` never double-counts one call across N lock entries. Submitting
fans the leader's one job out to every member's own lock entry directly —
members never call the provider a second time.

**Every sibling's identity depends on the whole group.** The spec hash
includes the full ordered list of descriptions, not just an asset's own
prompt, so changing any one member's text — or adding or removing a member —
marks every sibling stale together. This isn't a choice pixelkiln made:
PixelLab has no endpoint to add one more item to an already-submitted batch,
so a batch's membership needs deciding before it's generated. Growing an
existing batch later means declaring a new one, not editing the old.

Review works exactly like any other `1dir` asset, once per sibling: each
lands in `pixelkiln pick` independently (all sharing the same, real candidate
set), and picking a different index for each is what actually turns N
generated frames into N separate, kept assets. A member's row starts already
scrolled to, and marked **DECLARED**, at its own declared index — a hint
from the confirmed slot order below, not a forced choice; any candidate in
the set can still be picked for any sibling.

**Confirmed live** against a Tier 2 account: a 32px, 3-item batch (a chest
leader plus a potion and a key member) billed exactly 20 generations — the
ordinary `1dir` floor tier, unaffected by `item_descriptions` — and
`item_descriptions[0]` does own candidate slot 0: frame 0 came back as the
chest, frame 1 as the potion, frame 2 as the key, in exactly the declared
order. The remaining candidates (61 of 64, at this size) are the model's
ordinary per-slot variety, not repeats of any one description — free bonus
material, not additional declared items. Only confirmed at this one size;
whether the cost table's higher tiers hold unchanged is still unconfirmed.

## `pixflux`

`pixflux` costs one generation, returns inline without polling, and supports a
hard `palette` constraint:

```jsonc
"gameboy": {
  "generator": "pixflux",
  "palette": ["#0f380f", "#306230", "#8bac0f", "#9bbc0f"],
  "outDir": "art/gameboy"
}
```

A palette prompt is a request; `pixflux`'s swatch is a constraint. Measured
two- and four-color outputs contained exactly the supplied colors.

Trade-offs:

- rendering is flatter than `1dir`;
- style reference images are unavailable;
- the same `color_image` payload does not work on `map`;
- inline results are temporarily cached between submit and fetch;
- `noBackground` defaults to true in PixelKiln, which is correct for sprites
  but wrong for scenes and banners.

Set `noBackground: false` for full-bleed artwork. Prompt prose cannot undo a
post-generation background-removal step.

## `tiles`

`tiles` calls the tile-pro endpoint and understands tile geometry and
connectable output sets.

```jsonc
"ground": {
  "generator": "tiles",
  "tileSize": 32,
  "tileType": "isometric",
  "tileView": "low top-down",
  "outlineMode": "segmentation",
  "outDir": "assets/tiles/src"
}
```

Independent variations enter the normal review-and-pick flow. A `tileFeature`
instead creates a structural set in provider order:

| Feature | Meaning |
|---|---|
| `roads` | 18-configuration connected path/road set. |
| `tileset` | 16-tile Wang-corner terrain transition. |
| `building` | Floor/wall/doorway/pillar/stair construction kit. |

Describe a `tileset` asset as the transition, "fairway grass to rough meadow",
rather than one terrain. Every returned member is required, so PixelKiln
records numerical roles such as `tile-00` rather than treating them as choices.

Important constraints:

- Style mode copies geometry from `styleImages` and ignores `tileType` and
  `tileView`. It is useful when new independent tiles must match an existing
  ground plane.
- `tileFeature` and `styleImages` cannot be combined; PixelLab rejects it and
  the manifest catches it before spending.
- Use `outlineMode: "segmentation"` for continuous ground. The provider default
  outlines every tile, which produces dark seams when repeated.
- Six-edge and unknown adjacency families remain lossless in generic export but
  are rejected by engine exporters that cannot map them safely.

See [tiles and engine exports](./TILES.md).

## `frames`

`frames` currently belongs to ComfyUI. It repeats one committed still-image
workflow while varying one explicit per-asset binding, such as an ordered set
of pose PNGs. It is not video diffusion. The whole sequence stays one planned,
reviewed, downloaded, refined, and approved asset; partial sets never become
packaging input.

Keep a fixed seed for identity, or opt into a deterministic `seedStep`. Use a
quality profile so every frame shares one palette and must agree on detected
native grid step and phase. The review page animates the sequence, shows the
ordered strip, and lets the reviewer pause playback. It starts paused when the
system requests reduced motion and stops while it is offscreen. After approval,
`pack` emits the sprite sheet and stable
`asset/frame-XX` atlas ids. See
[Set up ComfyUI](./COMFYUI.md#generate-an-ordered-frame-set).

## `character`

`character` is PixelLab's character family as managed assets: a base drawn
facing 4 or 8 directions (from a prompt, or from your own south-facing
sprite with `reference`), states (a pose or a text-edited outfit) that
PixelLab applies to every direction of an existing character, animations,
one loop of one character in one direction, portraits, a bust made from
the south sprite, and outfit transfers, an existing loop's frames
re-clothed from a reference image instead of text. A state, animation,
portrait, or outfit depends on its parent the way a revision does: the
parent must be downloaded and current before the child can be submitted,
and regenerating the parent makes the child stale.

| Asset | PixelLab call | Cost |
|---|---:|---:|
| base, `mode: standard` | create-character-with-4/8-directions | 1 |
| base, `mode: v3` | create-character-v3 | 1 + ceil(size² × 8 / 65536): 2 at 64px, 3 at 128px |
| base, `mode: pro` | create-character-pro | 20–40 by canvas |
| base, `mode: pro-flash` | create-character-pro-flash | image tier (5 to 96px, 6 to 208px, 9 above) + ceil(size² × 8 / 65536): 6 at 64px, 8 at 128px, 17 at 256px; rotations only from a `reference` |
| state | create-character-state | 20–40 by canvas |
| animation with a `template` | animate-character | 1 |
| animation from text (v3) | animate-character | ceil(size² × frames / 65536): 1 at 64px, 2 at 128px |
| animation, `mode: pro` | animate-character | 20–40 by canvas |
| portrait | portrait-character-pro | 20–40 by `size` (16px billed exactly 20 live) |
| outfit | transfer-outfit-v2 | 20 (a 2-frame, 92×92 job billed exactly this live; not yet measured at other frame counts or canvases) |

The 20–40 tiers are PixelLab's; the tier is resolved from the canvas when
the job runs and reserved against the floor, so `plan` reports the tier the
canvas lands in. `plan` prices a 64px state at 40 (the 1dir tier for that
many pixels); one live 64px state in September 2026 moved the balance by
about 22, so the estimate reads high, which is the safe side for a budget.
`poll` now reads what a job like this actually billed and records it
alongside the estimate as `billed`; `pixelkiln history`, `plan --json`, and
the gallery show both when they differ, though `gen`'s wave budget still
spends against the (safe-high) estimate.
Every direction of a base or state is one file
(`<asset>-south.png`, ...); an animation's frames are `<asset>-frame-00.png`
onwards, with the resting pose as frame 0 unless `keepFirstFrame` is off.
`enforcePalette` snaps all of them. Since each direction of a loop is its
own generation, declare the east-facing loop as a `mirror` of the west one
(and each diagonal as a mirror of the other) and PixelKiln flips it locally
for nothing; see [Mirrors](./CHARACTERS.md#mirrors). `pack --format godot`
writes each base direction as a still and each animation as a looping set.
The gallery
labels a state or loop with its parent ("state of bot", "loop of
bot.dented, east"), links parent and children in the record, and counts the
family in the style header ("3 characters, 4 states, 6 loops"). See
[Characters](./CHARACTERS.md).

## `objectPro`

`objectPro` wraps PixelLab's `/create-object-pro-flash` — the same base
→ state → animation family as `character`, for PixelLab's separate,
skeleton-free "object" entity. Use it for a prop, creature, or vehicle that
needs a pose (`state`) or a directional loop (`animation`) but has no
humanoid/quadruped rig to fit: a floating rune, a treasure chest, a turret,
anything `character`'s template concept does not describe.

It reuses `character`'s own authoring shapes — `asset.state`/`asset.animation`
are the identical fields, and a `mirror` flips an animation's direction the
same way. Everything `character`'s templates/proportions/skeleton bring is
simply absent: no `mode`, `template`, `proportions`, `isometric`, `concept`,
or `styleCharacter` — `/create-object-pro-flash` is the only base-creation
path, and setting `animation.template`/`subject`/`outline`/`shading`/`detail`
on an `objectPro` animation is rejected at resolve time rather than silently
ignored, since none of them reach the API for an object.

- `objectDirections` (1 or 8, default 8, style-level) is the rotation count —
  a real choice `character` does not offer (character pro-flash is always 8).
  A 1-direction object's `animation.direction` must be `south`; anything else
  is rejected, since the endpoint 400s if `directions` is even sent for a
  1-direction object.
- `reference` (asset-level, base only) rotates the author's own south-facing
  sprite instead of drawing from the prompt, same as `character`'s reference
  — but only ever reads the south image, since one frame is all
  `/create-object-pro-flash` takes.
- A style image anchors the look the same way `character` pro-flash's does,
  including `styleTraits` (which of the image's palette/outline/detail/shading
  to carry over).
- Regenerating an already-animated direction is simpler than `character`'s:
  the object endpoint has its own `replace_existing` flag, so PixelKiln
  always passes it rather than fetching the object first to find and delete
  a prior take (`character`'s own workaround for not having one).
- `pixelkiln gallery --edit` shows an `objectPro` family the same way it
  shows a cast — states under their base, loops with their direction — and
  a base or state's drawer offers "+ New state" and "+ New animation",
  restricted to the fields above (no `template`/`subject`, since neither
  applies). See [Working with a cast](./CHARACTERS.md#working-with-a-cast).

**Cost is not independently measured.** `objectProCost()` assumes
`/create-object-pro-flash`/its state/its animation price identically to
`character`'s own measured pro-flash formula (`proFlashCharacterCost`),
since the request bodies are near-identical minus `template_id` — treat it
as a working assumption, not a confirmed number, until checked against a
live account.

Adoption (`pixelkiln adopt`) has not been extended for `objectPro`'s own
`<object id>#<animation group id>` remote-id scheme yet, unlike `character`'s
dedicated adoption path — a base may already be adoptable through the
generic object-matching pixelkiln already does for `1dir`/`map`, since a
pro-flash object shares that same `/objects` identity space, but this is
untested.

## `isometricTile`

`isometricTile` wraps PixelLab's `/create-isometric-tile` — a different
endpoint from both `tiles` (which also has its own `isometric` `tileType`
for full connectable Wang/road/building sets) and `terrain` (`/create-tileset`,
confirmed square-only, no isometric option at all). This one generates a
single standalone isometric tile, no candidates, no connectable set.

Use it when a per-tile height/elevation primitive is what's needed — a raised
mesa, a cliff block, a standalone rock outcrop — rather than a connected
ground set.

- `isometricTileShape` controls vertical thickness: `"thin tile"` (~15% of
  canvas height), `"thick tile"` (~25%), or `"block"` (~50%, the API
  default). This is a more direct elevation control than anything in `tiles`
  or `terrain`.
- `isometricTileSize` is the API's own tile grid size, 16 or 32 (default 16)
  — a separate concept from `size`, the generation canvas (16–64px; the
  endpoint's own guidance is that sizes above 24px "often produce better
  quality results").
- `outline` defaults to `"lineless"` on this endpoint specifically, unlike
  `tiles-pro`'s `"outline"` default — its own valid values are `"single
  color outline"`, `"selective outline"`, or `"lineless"`.

**Cost: 1 generation flat, measured.** PixelLab's own OpenAPI response schema
example shows `{ type: "usd", usd: 0.02 }`, which reads as billing in real
dollars — but a real call against a live subscription account billed exactly
1 generation instead (`usage: { type: "generations", generations: 1 }`), and
`costUnit` here is `"generations"` like every other generator. Only one
size/tile-shape combination (32px canvas, `"block"`) has actually been
measured; the endpoint's own docs give no size-tiering formula the way
`1dir`/`tiles` do, so this assumes flat pricing across the 16–64px range
rather than guessing a tier.

Style images, `init_image`/`init_image_strength` (image-to-image), and
`color_image` (native forced-palette) are not modeled yet — PixelKiln's own
`palette`/`enforcePalette` post-processing works generically on the
downloaded tile regardless, if a closed palette is what's actually needed.

## `uiAsset`

`uiAsset` wraps PixelLab's `/create-ui-asset` — panels, buttons, health bars,
and other UI chrome, composited as one flat image. It is non-square capable
like `imagePro`: `width`/`height` default to 256×256 but can be set per asset,
subject to the endpoint's own aspect-gated size tiers (square up to 512×512,
16:9 up to 688×384, 9:16 up to 384×688, 4:3 up to 600×448, 3:4 up to 448×600;
`pixelkiln` refuses anything under 192 or over 688 per side and leaves the
exact aspect ceiling to the API).

Two asset-level fields, usable together or alone:

- `pieces`: an array of exact shape regions (`rounded_rect`, `circle`, or
  `polygon`, each with a unique `id` and optional `label`) positioned on a
  virtual 0–512 coordinate canvas, independent of the actual output size.
- `elements`: named, auto-positioned scaffolds — `button`, `icon_button`,
  `toolbar`, `tab`, `panel`, `window`, `health_bar`, `avatar`, `triangle`,
  `pentagon`, `hexagon`, `octagon`.

Omit both for a plain full-canvas panel from the prompt alone. A style-level
`uiColorPalette` string (e.g. `"brown and gold"`) is a free-text prompt hint
sent as `color_palette` — a different, PixelLab-side concept from
PixelKiln's own hex-array `palette`/`enforcePalette` (local quantization),
which still applies to the downloaded image afterward if an exact palette is
needed.

**No cropping, no nine-slice, no states.** `GET /ui-assets/{id}` returns one
composited image with no per-piece sub-image or bounding-box data, confirmed
absent from the response schema regardless of how many `pieces`/`elements`
were requested — despite `pieces`' own precise coordinates, PixelLab does not
hand back a way to split them out again. A themed variant of an existing
panel (an empty vs. full health bar, say) needs no new mechanism: it is a
plain `revision` (image-to-image) of the base panel, which already carries
this for every other generator.

**Cost: confirmed live at one data point — 20 generations for a 256x192
canvas**, the low end of the `create_ui_asset` MCP tool's "20–40
generations" claim. PixelKiln still estimates with the same canvas-tier
formula as `1dir`/`tiles`, which predicts the 40 ceiling for every valid
`uiAsset` size (its 192px floor is already past that formula's top tier) —
the measured call proves the formula wrong here, since it billed the floor
price at an area well above where `1dir`/`tiles` would bill the ceiling.
Left as an over-read for `--budget` until a second size is measured; see
[ENDPOINTS.md](./ENDPOINTS.md) for the full writeup.

## `uiElement`

`uiElement` wraps PixelLab's `/generate-ui-v2` ("Generate UI (Pro)"): one UI
element — a button, a health bar, an inventory slot, a dialogue box — from
the prompt alone. Where `uiAsset` lays a panel out from `pieces`/`elements`
on a 192px-and-up canvas, `uiElement` has no layout vocabulary and goes down
to 16×16, which suits icons and small widgets:

```jsonc
{
  "styles": {
    "hud": {
      "generator": "uiElement",
      "uiColorPalette": "brown and gold",
      "styleImages": [{ "path": "refs/hud-concept.png" }],
      "outDir": "art/ui"
    }
  },
  "assets": {
    "slot": { "prompt": "wooden inventory slot with metal corners", "width": 32, "height": 32 },
    "hp-bar": { "prompt": "health bar with a red fill", "width": 96, "height": 16 }
  }
}
```

- `width`/`height` default to 256×256 and can be non-square: 16 up to 792
  wide and 688 tall, with the exact ceiling set by aspect ratio upstream
  (square tops out at 512×512, 16:9 at 688×384).
- The style's single `styleImages` entry, if any, is sent as the endpoint's
  `concept_image`: design guidance for the element, not a strict style
  transfer. More than one is refused.
- `uiColorPalette` is sent as `color_palette`, the same free-text hint
  `uiAsset` takes. PixelLab removes the background by default; set
  `noBackground: false` on the style to keep it.
- One call is expected to return one image, recorded straight away. If the
  endpoint ever returns several, they go to candidate review like
  `imagePro`'s.

**Unmeasured.** The schema carries no usage example and no call has been
billed yet. The plan prices it on the same 20/25/40 canvas tiers as
`1dir`/`tiles`, the safe over-read for a Pro endpoint, and the completed
job's shape is read defensively (`pollUiElement` names the keys it got if
the shape is not the documented `images` list).

## Style variants

Styles are namespaces. Add another style to re-derive the same asset ids into a
separate output directory and separate lock keys:

```jsonc
"styles": {
  "base": { "generator": "map", "outDir": "art/base" },
  "neon": {
    "generator": "1dir",
    "size": 64,
    "promptPrefix": "neon-noir game icon",
    "promptSuffix": "magenta/cyan rim light, transparent background",
    "styleImages": [{ "path": "art/style-refs/neon.png" }],
    "outDir": "art/neon"
  }
}
```

Seed a prose-only variant with two or three assets, commit the best results as
dedicated references, then generate the remainder. Reference images control
inherent subject colors more reliably than prose alone.

## Limits and post-processing

PixelLab submissions must be spaced more than two seconds apart and concurrent
background jobs are tier-limited. PixelKiln enforces both globally.

Image-in/image-out resize, rotate, and pixel-art conversion endpoints are
generative and can change a closed palette or alpha channel. They cost the same
as a fresh one-generation image. Regenerate at the target dimensions when
palette fidelity matters; background removal is the measured exception, a
real de-fringe pass.

PixelLab's portrait, outfit-transfer, lip-sync, and skeleton-driven
animation endpoints are outside the current library scope; the character
family itself is the `character` generator.
