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
| `provider` | no | Default provider registry id. Defaults to `pixellab`; `retrodiffusion`, `comfyui`, and `scenario` are experimental. |
| `styles` | yes | Map of style id to inherited generation/output settings. |
| `assets` | yes | Map of stable asset id to subject and per-asset overrides. |

A resolved unit of work is one `styleId/assetId`. Asset ids are stable lookup
keys, atlas frame ids, and default filenames; changing one is a data migration,
not merely a label edit.

## Style fields

| Field | Type/default | Meaning |
|---|---|---|
| `extends` | style id | Optional parent style. The child inherits resolved settings but must declare its own `outDir`. |
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
| `quality` | object | Optional native-grid, final-palette, and human-approval contract; documented below. |
| `tags` | string array, `[]` | Tags inherited by every generated provider object in the style. |

### Style inheritance

Use `extends` for a real variant that differs from a base style by a few
settings. Do not copy the whole style:

```jsonc
{
  "styles": {
    "pony-character": {
      "generator": "map",
      "promptPrefix": "score_9, score_8_up, rating_safe",
      "promptSuffix": "clean pixel clusters",
      "seed": 24000,
      "outDir": "art/generated/pony-character",
      "quality": {
        "outDir": "art/native/pony-character",
        "palette": ["#17111f", "#76506f", "#e5a9b8", "#fff1de"],
        "minGridConfidence": "high"
      }
    },
    "pony-explicit": {
      "extends": "pony-character",
      "promptPrefix": "score_9, score_8_up, rating_explicit",
      "seed": 24001,
      "outDir": "art/generated/pony-explicit",
      "quality": {
        "outDir": "art/native/pony-explicit"
      }
    }
  }
}
```

The child wins for ordinary fields. Arrays and nested objects are replaced,
not concatenated or recursively merged. Two fields get a focused merge:

- `quality` keeps parent keys that the child does not override;
- `providerOptions` keeps parent provider namespaces and merges each provider's
  immediate option keys. A deeper object such as `bindings` is still replaced
  as a whole.

Inheritance may span several styles. Unknown parents, self-reference, and
cycles are errors. Every child must declare `outDir`; output ownership is never
inherited. Omission means inherit, and there is no `null` deletion marker.
Defaults and generator constraints are applied after the chain is resolved.

Only the resolved style reaches planning. A parent edit to a pixel-affecting
field therefore changes every child's spec hash; a quality-policy edit changes
the child's derived quality state without buying new provider art. `extends`
itself is not runtime or lockfile state.

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

## Quality profiles

A style can declare the derived art it is willing to ship:

```jsonc
{
  "styles": {
    "environment": {
      "generator": "map",
      "outDir": "assets/generated/environment",
      "quality": {
        "outDir": "assets/final/environment",
        "palette": ["#141b1e", "#23312a", "#526a8d", "#709fcf", "#f1bb70"],
        "minGridConfidence": "high",
        "minTransparency": 0.2
      }
    }
  }
}
```

| Field | Type/default | Meaning |
|---|---|---|
| `outDir` | string, required | Manifest-relative root for refined PNGs and their `.pixelkiln.json` quality records. |
| `palette` | 2–256 unique hex colors | Closed final palette. PixelKiln applies it without dithering after native-grid recovery. |
| `minGridConfidence` | `high` | Lowest accepted Pixel Art Fixer result: `high`, `medium`, or `low`. |
| `minTransparency` | number 0–1 | Optional minimum transparent share for isolated assets. Omit it for opaque scenes. |
| `fixerRevision` | tested pinned revision | Exact Pixel Art Fixer revision recorded in the quality companion. |

The raw provider output remains under the style's normal `outDir`. The quality
output keeps the asset's relative category and filename under `quality.outDir`
and always uses PNG. PixelKiln reads `asset.source` when one is declared;
otherwise it requires one intact downloaded PNG from the lockfile.

Quality settings do not participate in the provider spec hash. Changing the
palette, threshold, fixer revision, or final output directory marks only the
derived art for refinement. It never schedules a paid generation.

Run the profile as a batch, review its PNGs, and record approval per result:

```bash
pixelkiln refine --style environment
pixelkiln refine approve \
  --from assets/final/environment/mountain.pixelkiln.json \
  --reviewer "Your Name"
pixelkiln refine check --style environment
```

`plan` reports raw and quality state separately. `plan --check`, `pack`, and
`mount` fail until each selected profile output is current and approved. Pack
and mount use the approved derived PNG and retain its quality record in their
provenance. A stale generation spec blocks the gate even when an approval for
the old raw bytes still exists. Repeating `refine` preserves pending and approved records; use
`--force` only when you intend to rebuild current output and reset approval.

Quality profiles currently support single-image `map`, `1dir`, and `pixflux`
styles. The schema rejects `tiles` and `animation`, which need role-aware or
multi-frame refinement rather than a one-PNG contract. See
[Quality gates](./QUALITY.md#manifest-quality-profile) for the release workflow.

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

## Experimental Scenario

Scenario uses hosted model IDs and requires a conservative Compute Unit ceiling
for every style:

```jsonc
{
  "provider": "scenario",
  "styles": {
    "environment": {
      "generator": "map",
      "size": 512,
      "outDir": "assets/generated/environment",
      "providerOptions": {
        "scenario": {
          "modelId": "model_bfl-flux-2-dev",
          "projectId": "project_example",
          "numOutputs": 4,
          "maxComputeUnits": 60,
          "parameters": {
            "guidance": 4,
            "numInferenceSteps": 28
          }
        }
      }
    }
  },
  "assets": {
    "mountain-town": { "prompt": "a fortified mountain town" }
  }
}
```

| Option | Meaning |
|---|---|
| `modelId` | Required Scenario endpoint model ID. |
| `maxComputeUnits` | Required positive per-asset offline ceiling and maximum accepted live quote. |
| `numOutputs` | One to four PNG candidates; defaults to one. |
| `projectId` | Optional Scenario ownership/routing project. |
| `parameters` | Additional model-specific JSON inputs. PixelKiln-owned request fields cannot be overridden. |

The current adapter supports `map`, dimensions from 128–2048px in multiples of
16, optional seed, and no style-image uploads. Every paid request is preceded
by an identical `dryRun=true` request. See [Set up Scenario](SCENARIO.md) for
credentials, cost semantics, recovery, and the paid live-test boundary.

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
| `revision` | object | Generate a new asset from another asset's current bytes. `source` and `revision` are mutually exclusive. |
| `outputRole` | string | Select one member of a structural output set for mounting. |

## Controlled revisions

```jsonc
{
  "assets": {
    "keep-rough": {
      "prompt": "rough mountain keep",
      "source": "concepts/keep.png"
    },
    "keep-winter": {
      "prompt": "preserve the keep silhouette; add snow and ice",
      "width": 96,
      "height": 96,
      "revision": {
        "mode": "image-to-image",
        "from": "keep-rough",
        "strength": 0.3
      }
    }
  }
}
```

| Revision field | Type | Meaning |
|---|---|---|
| `mode` | enum, required | `image-to-image`, `inpaint`, or `outpaint`. The selected provider must opt into the mode. |
| `from` | asset id, required | Parent asset in the same style. Self-references, unknown ids, and cycles are rejected. |
| `mask` | string | Manifest-relative PNG required for `inpaint`; rejected for the other modes. Its dimensions must match an available source. |
| `strength` | number 0–1 | Workflow edit/denoise strength. Interpretation is provider- and model-specific. |

The parent may use committed `source`, downloaded generated output, or a
current approved quality output. Parent and mask hashes participate in the
child spec hash; file paths do not. `plan` reports `blocked` and schedules no
spend until every dependency is current. The check repeats immediately before
submission.

ComfyUI is the first adapter with revision support. Its workflow must bind the
source image and, when applicable, mask and strength. Other built-in providers
reject the revision during offline resolution. See
[Controlled asset revisions](REVISIONS.md) for the full gate and
[Set up ComfyUI](COMFYUI.md#controlled-revisions) for workflow details.

## Prompt and override resolution

For each participating style/asset pair:

1. Resolve the style provider, falling back to the top-level default.
2. Choose `promptByStyle[styleId]` when present, otherwise `prompt`.
3. Apply the style prefix and suffix.
4. Apply generator dimensions and the effective provider's settings.
5. Merge style and asset tags.
6. Resolve and hash revision parents and masks, when declared.
7. Derive a deterministic spec hash from every setting that changes generated
   pixels, including style-image and revision-input hashes.

Project root, output path, and tags are excluded from the pixel identity, so
moving a checkout or retagging does not buy new art. Prompt, size, palette,
seed, view, provider choice, reference-image bytes, and revision input bytes do
change identity.

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
