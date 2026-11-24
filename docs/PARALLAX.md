# Parallax backgrounds

A parallax background is a stack of layers that scroll at different speeds as
the camera moves. PixelKiln has no parallax command yet, so this guide builds
one from ordinary manifest assets and a free script. Everything below was run
to make the pictures on this page: two biomes, 51 PixelLab generations in all,
including the retries. The evidence behind each choice is in the
[research note](./RESEARCH_PARALLAX.md).

![Volcanic dusk, built from separate silhouettes](../website/public/research/parallax/refined/volcanic/silhouettes.webp)

![Alpine dusk, built from whole layers](../website/public/research/parallax/refined/alpine/layers.webp)

## Pick a route

Both routes start the same way, with one palette and a pixflux style. They
differ in what you generate.

| Route | What you generate | Best for |
|---|---|---|
| Silhouettes | Four or five isolated landforms a biome, each about 240 px wide. The game lays them in overlapping runs. | Levels wider than any picture. No layer needs to loop, and the runs never repeat exactly. |
| Whole layers | A far range, a middle layer and a near layer, each 400×100, looped afterwards. | The fewest steps. A short level, a title screen, a menu. |

The two mix well. Both pictures above use a whole far range and a whole near
layer; the volcanic one puts two runs of silhouettes between them.

The sky is not generated in either route. It is a few flat bands of palette
colours, drawn by the script or by the engine. Hosted generators draw
mountains and suns into a sky whatever the prompt says.

## 1. Choose one palette

Every layer uses the same forced `palette`. It is the single setting that
makes separately generated layers look like one scene. The easiest source is
a picture you already like: its colours, 30 to 50 of them, become the palette.
The volcanic set uses the 44 colours of a PixelLab volcano; the alpine set uses
the 38 colours of a PixelLab mountain valley.

Check the palette has pale colours as well as dark ones. A tier is pushed
toward the sky by mixing its colours and snapping the result back to the
palette (step 5). A palette with few pale colours flattens a tinted tier into
one or two colours.

## 2. Write the manifest

One pixflux style per seed, with background removal, `view: side` and the
palette. Listing several styles on an asset gives several candidates of it,
one per seed, so you can keep the best.

```jsonc
{
  "name": "my-game",
  "provider": "pixellab",
  "styles": {
    "parallax-a": {
      "generator": "pixflux",
      "noBackground": true,
      "view": "side",
      "seed": 101,
      "palette": ["#050a14", "#2e3253", "#7b5f94", "..."],
      "outDir": "assets/parallax/volcanic/a"
    },
    "parallax-b": {
      "generator": "pixflux",
      "noBackground": true,
      "view": "side",
      "seed": 202,
      "palette": ["#050a14", "#2e3253", "#7b5f94", "..."],
      "outDir": "assets/parallax/volcanic/b"
    }
  },
  "assets": {
    "landform-cone": {
      "prompt": "a single dark basalt volcanic cone, muted violet, low contrast, simple shading, about two thirds as wide as the picture, its slopes flare out to a flat base, a lone landform game sprite on a plain empty background, nothing else in the picture: no clouds, no moon, no sun, no hills or ground around it, side view, transparent background",
      "width": 256,
      "height": 128,
      "styles": ["parallax-a", "parallax-b"]
    },
    "layer-near": {
      "prompt": "dark jagged volcanic hills close to the viewer, uneven heights and irregular shapes, a few glowing lava cracks, nearly black, spans the full width, flat bottom edge, no sky, no ground plane, side view, transparent background",
      "width": 400,
      "height": 100,
      "styles": ["parallax-a", "parallax-b"]
    }
  }
}
```

The complete manifests for both biomes are in
[`benchmarks/parallax-refined`](../benchmarks/parallax-refined).

Keep transparent pixflux pictures at 40,000 px or less (400×100, 256×128).
Larger ones come back with their background.

### Prompts that work

For a silhouette, describe one object as a game sprite and list what must not
be in the picture. Leave the distance out of the prompt: the haze comes later,
from the palette.

- Use "a lone landform game sprite on a plain empty background, nothing else in
  the picture: no clouds, no moon, no sun, no hills or ground around it".
- Use "about two thirds as wide as the picture" so it does not run off the
  sides.
- Avoid "distant", "seen from far away", "hazy dusk light" and "fading to
  nothing at its foot". They make pixflux paint a whole scene. In the first
  round, every volcanic silhouette asked for that way came back with ground,
  clouds or a moon, and 14 of 18 silhouettes ran off the canvas.
- Avoid a glow at a crater's top. Pixflux draws it as a setting sun.

![The same three landforms and seed: the scene-style prompt (top) and the sprite prompt (bottom)](../website/public/research/parallax/refined/prompt-compare.png)

For a whole layer, ask for the full width and a flat bottom edge. A far range
comes back as a flat single-colour band, which is right for the farthest layer;
it is recoloured in step 5.

## 3. Plan and generate

```bash
pixelkiln plan
pixelkiln gen --budget pixellab=18
```

`plan` lists one generation an image at these sizes. Three seeds of six assets
is 18 generations a biome. Plan for a retry round: the alpine and volcanic sets
each needed one.

## 4. Keep the best candidate

Look at every candidate on a plain colour, then reject the ones that break the
stack:

- A silhouette that touches the left or right edge. Its cut-off side shows as a
  straight vertical line in a run.
- Anything with a horizon line, a reflection, clouds or a moon in it.
- A whole layer that does not span the width. It leaves gaps when it repeats.
- A middle layer that is one landmark, such as a single volcano. It is fine,
  but draw it once instead of looping it (step 6), or the repeat is obvious.

The script prints the numbers for the first check:

```bash
python3 research/scripts/parallax.py screen assets/parallax/volcanic/*/landform-*.png
```

`edge 0.00/0.00` means nothing touches either side. The script needs numpy,
pillow and scipy.

## 5. Finish the pieces

All of these are free and keep every pixel on the palette.

```bash
P="python3 research/scripts/parallax.py"

# Silhouettes: trim, then thin out the bottom 30% with an ordered dither.
$P foot cone.png cone.foot.png 0.3

# One copy a tier, each pulled toward its own colour and snapped to the palette.
$P tint cone.foot.png cone.far.png  "#7f4776" 0.55 pixelkiln.manifest.json
$P tint cone.foot.png cone.near.png "#403a61" 0.4  pixelkiln.manifest.json

# Whole layers: loop at the best matching columns. Recolour the flat far range.
$P loop layer-far.png far.png cut
$P tint far.png far.png "#936090" 1 pixelkiln.manifest.json
$P loop layer-near.png near.png cut
```

![One landform: as generated, with the dithered foot, then the far-tier and near-tier copies](../website/public/research/parallax/refined/foot-and-tiers.png)

**The dithered foot.** Background removal leaves every pixel fully on or off,
so a silhouette cannot fade by alpha. Thinning its bottom rows with a 4×4
pattern makes it dissolve into whatever is behind it and keeps it pixel art.

**Depth order.** The farther a layer, the closer to the sky's colour and the
lower its contrast. Check the order from back to front: the far range lightest,
then the far tier, the near tier, and the near layer darkest. Snow can stay
bright on a near tier, as long as its shadows are darker than the range behind
it. Tinting every tier toward one light haze colour gets the order backwards:
the near tier ends up lighter than the range behind it.

**The far range.** Pick a palette colour that sits between the sky bands behind
it, darker than the horizon and lighter than the tiers.

## 6. Preview the stack

The script draws the sky and scrolls the whole stack, from a small JSON file:

```jsonc
{
  "view": [384, 216],
  "sky": ["#2e3253", "#503e68", "#7b5f94", "#ad628e", "#d66283", "#f96076"],
  "seed": 7,
  "frames": 120,
  "travel": 480,
  "layers": [
    { "image": "far.png", "bottom": 150, "speed": 0.125, "extend": true },
    { "run": ["cone.far.png", "rim.far.png", "mesa.far.png"], "foot": 158, "speed": 0.25 },
    { "run": ["cone.near.png", "rim.near.png", "mesa.near.png"], "foot": 176, "speed": 0.5 },
    { "fill": "#0e0c20", "top": 206, "speed": 1 },
    { "image": "near.png", "bottom": 246, "speed": 1 }
  ]
}
```

```bash
STILL=still.png SCALE=2 python3 research/scripts/parallax.py skyline preview.webp stack.json
```

- `extend` on the far range repeats its bottom row to the foot of the view, so
  the tiers' dithered feet dissolve into distant land, not into sky.
- A run lays its sprites left to right, each starting 72% of the way across
  the last, flipped at random and never the same one twice in a row.
- An image with `"repeat": false` and an `x` is drawn once: use it for a
  landmark.
- The camera pans `travel` pixels and back. Watch the far end of the pan for
  seams, floating feet and gaps under the near layer.

The specs and the build script for both biomes are in
[`benchmarks/parallax-refined`](../benchmarks/parallax-refined).

## 7. Put it in the engine

Speed is the fraction of the camera's movement a layer follows. The previews
use 0 for the sky, 1/8 for the far range, 1/4 and 1/2 for the two tiers, and 1
for the near layer.

- Round the camera to whole pixels first, then take each layer's offset from
  that rounded position. Rounding each layer on its own moves layers while the
  camera stands still.
- Prefer simple fractions (1/2, 1/4, 1/8). They step on an even rhythm; 0.3 or
  0.6 do not.
- Keep the tiers' speeds close together. A wide spread opens bands of sky
  between them.
- A bounded level needs no loop. Lay each run past both ends of the level by
  the most that layer can drift.

The same layer at a quarter of the camera's speed in each tool:

| Tool | Setting |
|---|---|
| Tiled | `parallaxx: 0.25` |
| Godot 4 | `Parallax2D.scroll_scale = Vector2(0.25, 1)` |
| Phaser 3 | `setScrollFactor(0.25, 1)` |
| LDtk | `parallaxFactorX: 0.75` with `parallaxScaling: false` |

LDtk counts the other way: its factor is how much the layer follows the
camera, so write 1 − speed. With `parallaxScaling` on it also shrinks a far
layer off the pixel grid. PixelKiln's LDtk export writes factor 0 today.

## What this guide does not cover

- Splitting a finished scene into layers. A depth model and inpainting can do
  it, at 10 to 25 PixelLab generations a layer for the fill; see steps 4, 13
  and 14 of the [research note](./RESEARCH_PARALLAX.md).
- Retro Diffusion. Its environment style draws a whole scene whatever the
  prompt says, so it is not a layer generator (step 15).
- A `pixelkiln parallax` command. The research note sketches one.
