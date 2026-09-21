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
sprite with `reference`), states (a pose, an outfit) that PixelLab applies
to every direction of an existing character, and animations, one loop of
one character in one direction. The three share one PixelLab character. A state
or animation depends on its parent the way a revision does: the parent must
be downloaded and current before the child can be submitted, and
regenerating the parent makes the child stale.

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
