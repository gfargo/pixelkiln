# Environment provider benchmark

This benchmark compares PixelLab and Retro Diffusion on three 256×256 game-art
briefs. Each brief has two attempts. The test uses the same prompt text and seed
numbers for both providers, but seeds are not portable between models.

The benchmark tests the adapters that PixelKiln ships. It does not rank every
model or endpoint sold by either provider.

## Setup

| Brief | PixelLab route | Retro Diffusion style | Intended output |
|---|---|---|---|
| Mountain observatory | `map`, high top-down view | `rd_plus__isometric_asset` | Isolated building on a snowy ridge |
| River gate | `map`, low top-down view | `rd_plus__topdown_asset` | Isolated landmark spanning water |
| Alpine valley | `pixflux`, background kept | `rd_plus__environment` | Full scenic background |

Both manifests request 256×256 output with seeds `31415` and `27182`. The
provider-specific route or style is allowed to do its job. No image was picked,
edited, cropped, or post-processed.

PixelLab rejected `view: "isometric"` on the `map` endpoint with HTTP 422. The
successful observatory attempts use the supported `high top-down` view while
the shared prompt still asks for an isometric three-quarter view. This is a
real adapter constraint, so the benchmark records it instead of hiding it.

The committed manifests and lockfiles are here:

- [PixelLab manifest](../benchmarks/provider-environments/pixellab/pixelkiln.manifest.json)
- [PixelLab lockfile](../benchmarks/provider-environments/pixellab/pixelkiln.lock.json)
- [Retro Diffusion manifest](../benchmarks/provider-environments/retrodiffusion/pixelkiln.manifest.json)
- [Retro Diffusion lockfile](../benchmarks/provider-environments/retrodiffusion/pixelkiln.lock.json)

## Mountain observatory

Prompt: `a compact stone observatory built into a snowy mountain ridge,
isometric three-quarter view, cedar roof, warm windows, isolated with no
scenery`

| PixelLab A | PixelLab B | Retro Diffusion A | Retro Diffusion B |
|---|---|---|---|
| ![PixelLab mountain observatory attempt A](../website/public/benchmarks/provider-environments/pixellab/isolated/a/mountain-observatory.png) | ![PixelLab mountain observatory attempt B](../website/public/benchmarks/provider-environments/pixellab/isolated/b/mountain-observatory.png) | ![Retro Diffusion mountain observatory attempt A](../website/public/benchmarks/provider-environments/retrodiffusion/isolated/a/mountain-observatory.png) | ![Retro Diffusion mountain observatory attempt B](../website/public/benchmarks/provider-environments/retrodiffusion/isolated/b/mountain-observatory.png) |

PixelLab followed more of the brief. Both attempts place a substantial stone
building on a snowy ridge, and the first reads as an observatory. Retro
Diffusion produced tidy cutouts, but both are small cabins on snow-covered
rocks. The observatory and mountain-ridge ideas mostly disappeared.

The trade-off is file readiness. Retro Diffusion removed the background and
used 35 and 36 colors. PixelLab returned opaque pale backgrounds and used 264
and 266 colors. PixelLab wins prompt coverage. Retro Diffusion needs less
cleanup before placement in a game map.

## River gate

Prompt: `a fortified village gate spanning a narrow river, three-quarter
top-down view, stone towers, timber bridge, isolated with no scenery`

| PixelLab A | PixelLab B | Retro Diffusion A | Retro Diffusion B |
|---|---|---|---|
| ![PixelLab river gate attempt A](../website/public/benchmarks/provider-environments/pixellab/topdown/a/river-gate.png) | ![PixelLab river gate attempt B](../website/public/benchmarks/provider-environments/pixellab/topdown/b/river-gate.png) | ![Retro Diffusion river gate attempt A](../website/public/benchmarks/provider-environments/retrodiffusion/topdown/a/river-gate.png) | ![Retro Diffusion river gate attempt B](../website/public/benchmarks/provider-environments/retrodiffusion/topdown/b/river-gate.png) |

All four results are usable concepts. PixelLab shows more of the surrounding
riverbank and makes the bridge-water relationship obvious. Its outputs are
opaque scene patches. Retro Diffusion gives cleaner standalone fortifications.
Attempt B carries water through the gate; attempt A reads more like a drawbridge
than a river crossing.

PixelLab again follows the whole brief more reliably. Retro Diffusion is easier
to drop onto an existing map because its outputs have 56% to 64% transparent
pixels. The Retro Diffusion files also stay between 43 and 47 colors, compared
with PixelLab's 226 to 240.

## Alpine valley background

Prompt: `a wide alpine valley at dusk, layered mountains, pine forest, winding
river, small warm-lit village, full-bleed scenic background`

| PixelLab A | PixelLab B | Retro Diffusion A | Retro Diffusion B |
|---|---|---|---|
| ![PixelLab alpine valley attempt A](../website/public/benchmarks/provider-environments/pixellab/background/a/alpine-valley.png) | ![PixelLab alpine valley attempt B](../website/public/benchmarks/provider-environments/pixellab/background/b/alpine-valley.png) | ![Retro Diffusion alpine valley attempt A](../website/public/benchmarks/provider-environments/retrodiffusion/background/a/alpine-valley.png) | ![Retro Diffusion alpine valley attempt B](../website/public/benchmarks/provider-environments/retrodiffusion/background/b/alpine-valley.png) |

PixelLab's Pixflux route is the surprise here. Both results preserve the wide
valley, layered mountains, dusk light, winding river, and tiny settlement. They
also use only 22 and 38 colors. The shapes read cleanly at native size.

Retro Diffusion produced attractive scenes with stronger foreground framing
and more conventional depth. They feel like places the player could enter, but
the framing narrows the valley and pushes the result toward illustration rather
than a reusable background layer. They use 37 and 46 colors.

For this brief, PixelLab wins on prompt coverage, graphic clarity, consistency,
and cost. Retro Diffusion wins if the desired result is a closer, more cinematic
scene.

## Cost and operational results

| Provider | Successful images | Charged amount | Final balance |
|---|---:|---:|---:|
| PixelLab | 6 | 6 generations | 4,415 generations |
| Retro Diffusion | 6 | $0.348 | $0.135 |

PixelLab charged one generation per image. Retro Diffusion quoted and charged
$0.058 per RD Plus image.

The run also caught two integration details:

- PixelLab's `map` endpoint rejected the literal `isometric` view. PixelKiln
  should document or validate the accepted values before submission.
- Retro Diffusion rounded its live quote up from PixelKiln's formula result of
  $0.057768 to $0.058. PixelKiln now rounds offline estimates up to the live
  quote precision, so planning remains a safe ceiling.

Both manifests now pass `doctor`, report a current plan, and have six healthy
PNG cache entries.

## Recommendation

For large isolated buildings or landmarks, start with PixelLab when prompt
coverage matters most. Budget for background cleanup. Start with Retro
Diffusion when a transparent, compact, low-color asset matters more than
capturing every noun in a complex prompt.

For full scenic backgrounds, start with PixelLab Pixflux. These two attempts
were cheaper and more faithful to the brief. Try Retro Diffusion when you want
foreground framing and a closer illustrated scene.

Do not ask either provider for one giant finished level. Generate terrain,
background, buildings, landmarks, and foreground pieces separately. Compose
them in the engine, then use integer nearest-neighbor scaling for display.

This sample is useful, not definitive. Two attempts expose obvious tendencies,
but they do not measure every style, prompt family, or model update. Rerun the
committed manifests when either provider changes its models.
