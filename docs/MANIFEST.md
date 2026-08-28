# Manifest reference

`pixelkiln.manifest.json` is the hand-authored, committed declaration of styles
and assets. Paths resolve relative to the manifest file, not the current shell
directory. The canonical machine-readable contract is
[`schema/manifest.schema.json`](../schema/manifest.schema.json).

```jsonc
{
  "$schema": "./node_modules/pixelkiln/schema/manifest.schema.json",
  "name": "my-game",
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
| `styles` | yes | Map of style id to inherited generation/output settings. |
| `assets` | yes | Map of stable asset id to subject and per-asset overrides. |

A resolved unit of work is one `styleId/assetId`. Asset ids are stable lookup
keys, atlas frame ids, and default filenames; changing one is a data migration,
not merely a label edit.

## Style fields

| Field | Type/default | Meaning |
|---|---|---|
| `generator` | `map` | `map`, `1dir`, `pixflux`, or `tiles`. |
| `outDir` | string, required | Output directory relative to the manifest. |
| `promptPrefix` | `""` | Prepended to every participating asset prompt. |
| `promptSuffix` | `""` | Appended to every participating asset prompt. |
| `styleImages` | `[]` | `{ "path": "..." }` reference images. Paths are manifest-relative. |
| `size` | integer 32–256 | Square size for `1dir`; a style reference's dimensions take precedence when present. |
| `view` | string | Provider-facing view/direction description. |
| `outline` | string | PixelLab `map` outline setting. |
| `shading` | string | PixelLab shading setting. |
| `detail` | string | PixelLab detail setting. |
| `seed` | integer | Deterministic provider seed where supported. |
| `palette` | hex array, `[]` | Forced palette for `pixflux`; `#` is optional. |
| `noBackground` | boolean, `true` | `pixflux` background removal. Set false for scenes/backdrops. |
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

## Asset fields

| Field | Type/default | Meaning |
|---|---|---|
| `prompt` | string, required | Subject-specific prompt. It may be empty only during existing-art onboarding. |
| `category` | string | Human grouping metadata. |
| `width` | integer 16–400 | Per-asset width override for arbitrary-size generators. |
| `height` | integer 16–400 | Per-asset height override. |
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

1. Choose `promptByStyle[styleId]` when present, otherwise `prompt`.
2. Apply the style prefix and suffix.
3. Apply generator dimensions and generator-specific settings.
4. Merge style and asset tags.
5. Derive a deterministic spec hash from every setting that changes generated
   pixels, including style-image hashes.

Project root, output path, and tags are excluded from the pixel identity, so
moving a checkout or retagging does not buy new art. Prompt, size, palette,
seed, view, and reference-image bytes do change identity.

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
