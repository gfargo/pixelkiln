# Manifest reference

`pixelkiln.manifest.json` is the hand-authored, committed declaration of styles
and assets. Paths resolve relative to the manifest file, not the current shell
directory. The canonical machine-readable contract is
[`schema/manifest.schema.json`](../schema/manifest.schema.json).

```jsonc
{
  "$schema": "./node_modules/pixelkiln/schema/manifest.schema.json",
  "name": "my-game",
  "provider": "pixellab",
  "styles": {
    "base": {
      "generator": "map",
      "promptPrefix": "Pixel-art game prop: ",
      "promptSuffix": ", isolated, transparent background",
      "outDir": "assets/generated/base"
    }
  },
  "assets": {
    "anvil": { "prompt": "a compact blacksmith anvil" }
  }
}
```

Unknown properties are rejected at every level.

## Top level

| Field | Required | Meaning |
|---|---|---|
| `$schema` | no | Editor schema URL/path. It does not affect generation identity. |
| `name` | yes | Project/account tag namespace. |
| `provider` | no | Default provider registry id. Defaults to `pixellab`; `retrodiffusion` and `comfyui` are experimental. |
| `styles` | yes | Map of style id to inherited generation/output settings. |
| `assets` | yes | Map of stable asset id to subject and per-asset overrides. |

A resolved unit of work is one `styleId/assetId`. Asset ids are stable lookup
keys, atlas frame ids, and default filenames; changing one is a data migration,
not merely a label edit.

## Style fields

| Field | Type/default | Meaning |
|---|---|---|
| `provider` | top-level default | Provider registry id for this style. Assets cannot override it. |
| `generator` | `map` | `map`, `1dir`, `pixflux`, `tiles`, or provider-specific `animation`. |
| `outDir` | string, required | Output directory relative to the manifest. |
| `promptPrefix` | `""` | Prepended to every participating asset prompt. |
| `promptSuffix` | `""` | Appended to every participating asset prompt. |
| `styleImages` | `[]` | `{ "path": "..." }` reference images. Paths are manifest-relative. |
| `size` | integer 16–8192 | Square size. Each provider and generator applies its own narrower limits. For PixelLab `1dir`, a style reference's dimensions take precedence. |
| `view` | string | PixelLab `map`: `low top-down`, `high top-down`, or `side`. Other generators interpret this separately. |
| `outline` | string | PixelLab `map`: `single color outline`, `selective outline`, or `lineless`. |
| `shading` | string | PixelLab `map`: `flat shading`, `basic shading`, `medium shading`, or `detailed shading`. |
| `detail` | string | PixelLab `map`: `low detail`, `medium detail`, or `high detail`. |
| `seed` | integer | Deterministic provider seed where supported. |
| `palette` | hex array, `[]` | Forced palette for `pixflux`; `#` is optional. |
| `noBackground` | boolean, `true` | `pixflux` background removal. Set false for scenes/backdrops. |
| `providerOptions` | object, `{}` | Options grouped by provider id. Only the active provider's object is resolved and hashed. |
| `tileSize` | integer 16–256 | Edge length for `tiles` when no style reference supplies geometry. |
| `tileType` | enum | `hex`, `hex_pointy`, `isometric`, `oblique`, `octagon`, or `square_topdown`. |
| `tileView` | enum | `top-down`, `high top-down`, `low top-down`, or `side`. |
| `tileFeature` | enum | Connectable `roads`, `tileset`, or `building` structural set. |
| `outlineMode` | enum | `outline` or `segmentation`; segmentation avoids quilted ground seams. |
| `mount` | object | Stable-cell sheet placement; documented below. |
| `tags` | string array, `[]` | Tags inherited by every generated provider object in the style. |

Generator-specific fields are validated before planning. Important constraints:

- `1dir` is square; use style/asset `size` rather than width/height.
- When `size` and `styleImages` are both present, PixelLab derives size from
  the largest reference image and the declared size is advisory.
- `map` supports arbitrary asset `width` and `height` but not forced palettes
  or style images.
- `pixflux` accepts a forced `palette` and returns inline output; it has no
  style-image support.
- `tiles` cannot combine `tileFeature` with `styleImages` because the provider
  rejects connectable features in style-tile mode.

See [generator selection](./GENERATORS.md) for costs and trade-offs.
See [mixed-provider projects](./MIXED_PROVIDERS.md) when styles in one manifest
need different backends and budget units.

## Experimental Retro Diffusion

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

## Experimental ComfyUI

ComfyUI runs a committed API-format workflow on a self-hosted server. The
workflow file is resolved relative to the manifest and its parsed content is
part of the spec hash. Adapter success proves transport and output structure,
not pixel-art quality. Use provider-neutral `pixelkiln refine` for native-grid,
final-palette, and recorded audit checks. Prompt coverage and human 1× approval
still require a person.

```jsonc
{
  "name": "my-game",
  "provider": "comfyui",
  "styles": {
    "local": {
      "generator": "map",
      "outDir": "assets/generated/local",
      "seed": 31415,
      "providerOptions": {
        "comfyui": {
          "workflowFile": "workflows/pixel-api.json",
          "outputNodeId": "9",
          "numImages": 4,
          "bindings": {
            "prompt": { "nodeId": "6", "input": "text" },
            "width": { "nodeId": "5", "input": "width" },
            "height": { "nodeId": "5", "input": "height" },
            "batchSize": { "nodeId": "5", "input": "batch_size" },
            "seed": { "nodeId": "3", "input": "seed" }
          }
        }
      }
    }
  },
  "assets": {
    "mountain": {
      "prompt": "a snowbound mountain pass",
      "width": 768,
      "height": 512
    }
  }
}
```

Node IDs come from the exported workflow; they are not stable across unrelated
workflows. The current adapter supports `map`, PNG output from one node, 1–16
candidates, and dimensions from 16–4096px. It rejects manifest `styleImages`
and `palette`; keep those controls inside the workflow. See
[Set up ComfyUI](COMFYUI.md) for the complete procedure, safe workflow, and
quality limits. The 4096px adapter ceiling is not a recommended generation or
native-art size.

## Asset fields

| Field | Type/default | Meaning |
|---|---|---|
| `prompt` | string, required | Subject-specific prompt. It may be empty only during existing-art onboarding. |
| `category` | string | Human grouping metadata. |
| `width` | integer 16–8192 | Per-asset width override. Each provider applies its own ceiling. |
| `height` | integer 16–8192 | Per-asset height override. Each provider applies its own ceiling. |
| `size` | integer 32–256 | Per-asset square size override. |
| `file` | string | Filename/path override beneath the style output root. |
| `styles` | string array, `[]` | If non-empty, generate this asset only in the named styles. |
| `promptByStyle` | object, `{}` | Replace the asset prompt for specific style ids. |
| `tags` | string array, `[]` | Asset tags combined with style tags. |
| `cell` | `[column,row]` | Non-negative stable grid cell used by `mount`. |
| `source` | string | Manifest-relative post-processed/hand-drawn source used by `mount` instead of lock output. |
| `outputRole` | string | Select one member of a structural output set for mounting. |

## Prompt and override resolution

For each participating style/asset pair:

1. Resolve the style provider, falling back to the top-level default.
2. Choose `promptByStyle[styleId]` when present, otherwise `prompt`.
3. Apply the style prefix and suffix.
4. Apply generator dimensions and the effective provider's settings.
5. Merge style and asset tags.
6. Derive a deterministic spec hash from every setting that changes generated
   pixels, including style-image hashes.

Project root, output path, and tags are excluded from the pixel identity, so
moving a checkout or retagging does not buy new art. Prompt, size, palette,
seed, view, provider choice, and reference-image bytes do change identity.

## Stable-cell mounting

```jsonc
{
  "styles": {
    "ground": {
      "generator": "tiles",
      "outDir": "assets/tiles/src",
      "mount": {
        "base": "assets/tiles/spritesheet.png",
        "cellWidth": 32,
        "cellHeight": 32,
        "out": "assets/tiles/spritesheet.png"
      }
    }
  },
  "assets": {
    "rough_grass": {
      "prompt": "unmown dark grass",
      "cell": [6, 2],
      "outputRole": "tile-03"
    }
  }
}
```

`base` is optional; omission starts from transparency. `out` may equal `base`.
Assets without `cell` are not mounted. Two assets cannot own one cell. A
sprite larger than its cell is reported and skipped rather than cropped.
`source` lets a remapped or hand-edited committed file replace generated input
without losing the declarative placement.

## Filenames and output roles

The default output is `<outDir>/<category>/<assetId>.png` when `category` is
set, otherwise `<outDir>/<assetId>.png`; `file` overrides it. Structural sets
expand one asset into `outputs[]` with stable roles such as `tile-00` and
filenames such as `terrain-tile-00.png`. Consumers should use roles rather than
assuming array position. See [tiles](./TILES.md).

## Validation and editor setup

Regenerate the checked-in schema after changing the Zod manifest types:

```bash
npm run schema
git diff -- schema/manifest.schema.json
```

Run `pixelkiln doctor --dry-run` for local references and project-state checks,
then `pixelkiln plan` to see the resolved work and cost before spending.
