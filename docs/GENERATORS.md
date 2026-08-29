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

## Style variants

Styles are namespaces. Add another style to re-derive the same asset ids into a
separate output directory and separate lock keys:

```jsonc
"styles": {
  "base": { "generator": "map", "outDir": "art/base" },
  "neon": {
    "generator": "1dir",
    "size": 64,
    "promptPrefix": "Neon-noir game icon: ",
    "promptSuffix": ", magenta/cyan rim light, transparent background",
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
palette fidelity matters; background removal is the measured exception that
acts as a genuine de-fringe pass.

Animated eight-direction characters and their ZIP/engine-resource export are
outside the current library scope.
