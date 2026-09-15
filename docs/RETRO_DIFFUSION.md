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

Set the top-level provider when the whole manifest uses Retro Diffusion. In a
mixed manifest, set `"provider": "retrodiffusion"` on the relevant styles.
Keep service-specific choices under the provider namespace:

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

For still-image styles, `style.quality` can add the same closed-palette,
native-grid, and named-approval gate used by every provider. It does not change
the Retro Diffusion quote or request. Tilesets and animation are excluded until
refinement can preserve their roles and frames. See
[Manifest quality profiles](./MANIFEST.md#quality-profiles).

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
rules during planning. See [Manifest fields](#manifest-fields) below for complete
examples.

## Manifest fields

Retro Diffusion maps `map` and `pixflux` to still generation, `tiles` to its
tileset family, and `animation` to GIF or PNG-spritesheet generation. Durable
sources and lock outputs record `image/png` or `image/gif`, so recovery retains
the correct extension and validates the correct structure.

```jsonc
{
  "name": "my-game",
  "provider": "retrodiffusion",
  "styles": {
    "base": {
      "generator": "map",
      "outDir": "assets/generated/base",
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
    "anvil": { "prompt": "a compact blacksmith anvil" }
  }
}
```

`promptStyle` accepts a live Retro Diffusion still-style selector,
`numImages` accepts 1–16 candidates, and `removeBg` overrides
`noBackground`. The Retro Diffusion API accepts 16–512px output. Selected
styles can impose smaller limits. RD Pro and user styles accept up to nine
reference images. Costs are
planned in USD and checked again with Retro Diffusion's free authoritative
quote endpoint before the paid request is sent. Authenticated single-candidate
RD Fast and RD Plus paths have passed from quote through validated output and
recovery.
Multi-candidate, tileset, GIF, and spritesheet paths remain mock-tested, so the
adapter is still experimental.

Additional Retro Diffusion options are:

| Option | Meaning |
|---|---|
| `framesDuration` | Animation duration: `4`, `6`, `8`, `10`, `12`, or `16`. |
| `returnSpritesheet` | Return a PNG spritesheet instead of an animated GIF. |
| `extraPrompt` | Outside texture description for `rd_tile__tileset_advanced`. |
| `tileX` / `tileY` | Make supported still styles seamless on either axis. |

An animation style is declared explicitly:

```jsonc
{
  "generator": "animation",
  "size": 64,
  "outDir": "assets/generated/animations",
  "providerOptions": {
    "retrodiffusion": {
      "promptStyle": "rd_animation__any_animation",
      "numImages": 1,
      "framesDuration": 8,
      "returnSpritesheet": false
    }
  }
}
```

The default output is `<assetId>.gif`; `returnSpritesheet: true` produces
`<assetId>.png`. Advanced animation styles require exactly one `styleImages`
input. PixelKiln currently limits animation batches to one so selection never
loses the output media type.

For a Wang-style tileset sheet:

```jsonc
{
  "generator": "tiles",
  "tileSize": 32,
  "outDir": "assets/generated/tiles",
  "providerOptions": {
    "retrodiffusion": {
      "promptStyle": "rd_tile__tileset",
      "numImages": 1
    }
  }
}
```

`rd_tile__tileset_advanced` accepts `extraPrompt` and up to two style images;
`rd_tile__tile_variation` requires one style image. Provider-specific size and
input constraints are checked during the free planning phase.

## Current operational limits

The adapter can report `balance`, but it does not yet expose Retro Diffusion
account listing, adoption, salvage, tagging, or deletion. Paid output still has
PixelKiln lockfile provenance and local cache recovery.

The lockfile records a durable `retrodiffusion://` result reference instead of
Retro Diffusion's temporary signed storage URL or an inline image. `fetch`
resolves that reference to the current result URL and downloads it immediately.
`restore` uses the validated local content cache first; if the cache is missing,
it needs `RD_API_KEY` to refresh the task result. Candidate image URLs are used
only by the local picker and are not written to the lockfile.

The shared PixelKiln manifest currently allows arbitrary width and height from
16 to 400 pixels, while Retro Diffusion styles can impose smaller limits. In
the current service catalog, the useful environment and scene-object styles
top out at 384px. Build very large scenes from separate terrain, background,
building, landmark, and foreground layers.

The [environment benchmark](./PROVIDER_BENCHMARK.md) found clean transparent,
low-color Retro Diffusion cutouts, while PixelLab followed the more complex
building prompts more closely. Read the [provider comparison](../PROVIDERS.md)
before committing to a large batch.

Retro Diffusion publishes its API examples and pricing formulas in the
[official API repository](https://github.com/Retro-Diffusion/api-examples).
