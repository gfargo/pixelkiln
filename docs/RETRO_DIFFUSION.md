# Set up Retro Diffusion

Retro Diffusion support is experimental. Authenticated RD Fast and RD Plus
single-candidate stills have passed from the provider's cost quote through
validated download, provenance, and recovery. Multi-candidate, tileset, GIF,
and PNG spritesheet paths have integration tests but still need representative
paid live runs.

[Visit Retro Diffusion](https://www.retrodiffusion.ai/) or open the
[official API guide](https://www.retrodiffusion.ai/app/guide/api).

## Add the credential

Create `.env.local` beside `pixelkiln.manifest.json`:

```dotenv
RD_API_KEY=...
```

Keep this file out of Git. PixelKiln also reads the variable from the current
process environment.

## Select Retro Diffusion

Set the top-level provider and keep service-specific choices under the provider
namespace:

```jsonc
{
  "name": "my-game",
  "provider": "retrodiffusion",
  "styles": {
    "props": {
      "generator": "map",
      "outDir": "assets/generated/props",
      "providerOptions": {
        "retrodiffusion": {
          "promptStyle": "rd_plus__default",
          "numImages": 4,
          "removeBg": true
        }
      }
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

Run the free checks before a paid request:

```bash
pixelkiln doctor --dry-run
pixelkiln plan
pixelkiln gen --budget 0.1
```

Copy the exact USD estimate from `plan` into `--budget`. Before PixelKiln sends
the paid request, it asks Retro Diffusion for a free authoritative quote and
stops if that quote exceeds the remaining budget.

## Match the style to the workflow

| PixelKiln generator | Retro Diffusion selector | Output |
|---|---|---|
| `map` or `pixflux` | A normal RD still style such as `rd_fast__default`, `rd_plus__default`, or an environment style | 1 to 16 PNG candidates |
| `tiles` | `rd_tile__*` | One PNG tileset or tile asset |
| `animation` | `rd_animation__*` or `rd_advanced_animation__*` | Animated GIF or PNG spritesheet |

The provider's style catalog can change. Use its live catalog when choosing a
selector instead of assuming an example name will remain available.

Useful options under `providerOptions.retrodiffusion` include:

- `numImages`: 1 to 16 still candidates
- `removeBg`: background removal for stills
- `framesDuration`: 4, 6, 8, 10, 12, or 16 for animation
- `returnSpritesheet`: PNG spritesheet instead of the default GIF
- `tileX` and `tileY`: seamless axes for supported still styles
- `extraPrompt`: outside texture for `rd_tile__tileset_advanced`

RD Pro and user still styles accept up to nine reference images. Advanced
animation and tile modes have narrower input rules. PixelKiln validates those
rules during planning. See the [manifest reference](./MANIFEST.md#experimental-retro-diffusion)
for complete examples.

## Current operational limits

The adapter can report `balance`, but it does not yet expose Retro Diffusion
account listing, adoption, salvage, tagging, or deletion. Paid output still has
PixelKiln lockfile provenance and local cache recovery.

The shared PixelKiln manifest currently allows arbitrary width and height from
16 to 400 pixels, while Retro Diffusion styles can impose smaller limits. In
the current service catalog, the useful environment and scene-object styles
top out at 384px. Build very large scenes from separate terrain, background,
building, landmark, and foreground layers.

The [environment benchmark](./PROVIDER_BENCHMARK.md) found clean transparent,
low-color Retro Diffusion cutouts, while PixelLab followed the more complex
building prompts more closely. Read [PixelLab vs. Retro Diffusion](../PROVIDERS.md)
before committing to a large batch.

Retro Diffusion publishes its API examples and pricing formulas in the
[official API repository](https://github.com/Retro-Diffusion/api-examples).
