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
| `history` | no | Replaced generations kept per asset in the lockfile, 0–100. Overrides the personal `PIXELKILN_HISTORY` default (5) for this project; `0` keeps none. See [`history`](CLI.md#history). |
| `styles` | yes | Map of style id to inherited generation/output settings. |
| `assets` | yes | Map of stable asset id to subject and per-asset overrides. |

A resolved unit of work is one `styleId/assetId`. Asset ids are stable lookup
keys, atlas frame ids, and default filenames; changing one is a data migration,
not merely a label edit.

## Asset fields

| Field | Type/default | Meaning |
|---|---|---|
| `prompt` | string, required unless `mirror` | The subject wording wrapped by the selected style's prompt prefix and suffix. |
| `width` / `height` | integer 16–8192 | Per-asset dimensions for generators that accept rectangular output. Provider limits may be lower. |
| `size` | integer 16–8192 | Per-asset square size where the generator uses one dimension. |
| `file` | string | Output path below the style's `outDir`; defaults to `<category>/<assetId>.png`. |
| `category` | string | Optional output subdirectory and logical grouping. |
| `source` | string | Manifest-relative committed art used instead of generation. For a set of PNG outputs (a `frames` animation, a `tiles` set) a path that is not a file is the stem of a hand edit laid beside the generated members (`<stem>-<role>.png` each); the set still generates. Mutually exclusive with `revision`. |
| `sourceByStyle` | object | Per-style `source`, keyed by style id; wins over `source` for that style. Written by `pixelkiln edit` for a hand edit of an asset that is in several styles. |
| `remoteId` | string | The provider's own id for art that already exists on the account, so `adopt` maps it without matching bytes: an object id, a character id, or `<character id>#<animation group id>`. Not part of the spec's identity. |
| `revision` | object | Controlled image-to-image or inpaint dependency. See [controlled revisions](REVISIONS.md). |
| `state` | object | `character` styles: a pose or outfit of another character asset. See [Characters](#characters). |
| `animation` | object | `character` styles: a loop of another character asset in one direction. See [Characters](#characters). |
| `mirror` | string | Another asset of the same style flipped left to right, made locally at no cost. See [Mirrors](#mirrors). |
| `proportions` | preset or object | `character` styles: this base's proportions, over the style's. |
| `reference` | string or object | `character` styles, bases: the character's own south-facing sprite (or `{ "south": ..., "east": ... }`), which PixelLab rotates instead of drawing from the prompt. See [Characters](#characters). |
| `providerInputs` | JSON scalar/sequence map, `{}` | Named per-asset inputs consumed by the active provider. ComfyUI accepts scalars and, for `frames`, one ordered 2–64 value sequence. Image bindings upload PNG/JPEG inputs. |
| `styles` | string array, `[]` | Restrict the asset to named styles; empty means every style. |
| `promptByStyle` | string map, `{}` | Replace only the asset prompt for a named style. |
| `outputRole` | string | Select one structural output when a generator returns a set. |
| `tags` | string array, `[]` | Asset tags added to provider objects where supported. |

`providerInputs` is provider-owned and participates in generation identity.
Changing a value makes only that asset stale. A provider may replace a local
runtime path with a content hash before hashing the spec; unsupported providers
reject non-empty inputs rather than ignoring them.
Only a provider that declares a sequence contract may accept an array. ComfyUI
uses the array named by `providerOptions.comfyui.frames.vary`; other inputs stay
constant across the set.

## Style fields

| Field | Type/default | Meaning |
|---|---|---|
| `extends` | style id | Optional parent style. The child inherits resolved settings but must declare its own `outDir`. |
| `provider` | top-level default | Provider registry id for this style. Assets cannot override it. |
| `generator` | `map` | `map`, `1dir`, `pixflux`, `tiles`, `character`, or provider-specific `animation`/`frames`. |
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
| `palette` | hex array, `[]` | The style's palette; `#` is optional. Sent to providers that take one (`pixflux`, Retro Diffusion, ComfyUI bindings). |
| `enforcePalette` | boolean, `false` | Snap every downloaded PNG to the nearest `palette` colour, no dithering. Needs at least two colours. See [Palette enforcement](#palette-enforcement). |
| `noBackground` | boolean, `true` | `pixflux` background removal. Set false for scenes/backdrops. |
| `providerOptions` | object, `{}` | Options grouped by provider id. Only the active provider's object is resolved and hashed. |
| `tileSize` | integer 16–256 | Edge length for `tiles` when no style reference supplies geometry. |
| `tileType` | enum | `hex`, `hex_pointy`, `isometric`, `oblique`, `octagon`, or `square_topdown`. |
| `tileView` | enum | `top-down`, `high top-down`, `low top-down`, or `side`. |
| `tileFeature` | enum | Connectable `roads`, `tileset`, or `building` structural set. |
| `outlineMode` | enum | `outline` or `segmentation`; segmentation avoids quilted ground seams. |
| `mode` | `standard` | `character` only. `standard`, `v3`, or `pro`; see [Characters](#characters). |
| `directions` | `8` | `character` only. `4` or `8`; `v3` and `pro` always draw 8. |
| `template` | `mannequin` | `character` only. Body template: `mannequin`, or `bear`, `cat`, `dog`, `horse`, `lion`. |
| `proportions` | | `character` only, `standard` humanoid bases. A preset (`default`, `chibi`, `cartoon`, `stylized`, `realistic_male`, `realistic_female`, `heroic`) or multipliers `{ headSize, armsLength, legsLength, shoulderWidth, hipWidth }`, each 0.5 to 2. An asset may override it. |
| `textGuidanceScale` | `8` | `character` only. How closely a `standard` base and a template loop follow their text, 1 to 20. |
| `isometric` | `false` | `character` only. Draw `standard` bases and every loop in isometric view. |
| `enhancePrompt` | `false` | `character` only, `v3` bases. Let PixelLab expand the prompt into a fuller one before drawing. |
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
  or style images. `enforcePalette` still holds its output to the palette.
- `pixflux` accepts a forced `palette` and returns inline output; it has no
  style-image support.
- `tiles` cannot combine `tileFeature` with `styleImages` because the provider
  rejects connectable features in style-tile mode.
- ComfyUI `frames` derives its count from one 2–64 item `providerInputs`
  sequence, renders one still per item, and reviews the ordered set atomically.

See [generator selection](./GENERATORS.md) for costs and trade-offs.
See [mixed-provider projects](./MIXED_PROVIDERS.md) when styles in one manifest
need different backends and budget units.

## Palette enforcement

```json
{
  "styles": {
    "gb": {
      "generator": "map",
      "outDir": "art/gb",
      "palette": ["#0f380f", "#306230", "#8bac0f", "#9bbc0f"],
      "enforcePalette": true
    }
  }
}
```

With `enforcePalette`, `fetch` maps every visible pixel of a downloaded PNG
to the nearest palette colour (redmean distance, no dithering) before the
file is written, and records what it did on the lock entry:

```json
"postprocess": { "palette": { "colors": ["#0f380f", "..."], "dither": "none", "distance": "redmean" } },
"outputs": [{ "path": "art/gb/anvil.png", "sha256": "<snapped>", "raw": "<provider bytes>" }]
```

`sha256` is the file on disk. `raw` is the provider's bytes before snapping,
present only when snapping changed something; a provider that honoured the
palette leaves the file, and the record, exactly as it came. Both live in
the content cache, so the step can be undone or redone without a download.

The flag is not part of the spec hash. Turning it on for a style with
generated art makes `plan` report each entry as `recoverable`, and the next
`fetch` (or `gen`, or `restore`) re-applies the rule to the files already on
disk, spending nothing. Turning it off puts the provider's bytes back the
same way. Changing the colours themselves is a different matter: `palette`
is sent to providers, so it is in the spec hash and a change is `stale`.

A file you changed by hand is never re-snapped; it shows as `orphaned` and
waits for `--force` or `pixelkiln edit`. GIF output passes through untouched.
Transparent pixels keep their alpha and get zeroed colour so the same
picture always has the same bytes.

`enforcePalette` and a `quality` profile are different tools. Enforcement
is one deterministic step on the provider's bytes with no external
dependency and no review gate. A quality profile recovers the native pixel
grid with Pixel Art Fixer first, then applies its own closed palette, and
holds packaging until a person approves the result.

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
        "minTransparency": 0.2,
        "fixerPython": ".pixelkiln/pixelfixer/bin/python"
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
| `fixerPython` | `PIXELKILN_PIXEL_FIXER_PYTHON`, then `python3` | Manifest-relative Python executable containing Pixel Art Fixer. An absolute path is also accepted. |
| `fps` | integer 1–60, `12` for `frames` | Playback rate stored with a ComfyUI frame set and used by its review preview. |

The raw provider output remains under the style's normal `outDir`. The quality
output keeps the asset's relative category and filename under `quality.outDir`
and always uses PNG. A ComfyUI frame set writes role-stable names such as
`walk-frame-00.png` and one shared `walk.pixelkiln.json` record. PixelKiln reads
`asset.source` for an ordinary asset; otherwise it requires intact downloaded
PNG bytes from the lockfile.

Quality settings do not participate in the provider spec hash. Changing the
palette, threshold, fixer revision, interpreter, or final output directory
never schedules paid generation. The interpreter is execution configuration,
so changing only `fixerPython` does not invalidate already-refined output.

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
`pack` includes every approved frame. A mounted frame-set asset must declare
`outputRole`, because one fixed cell cannot hold an animation implicitly.

Quality profiles support single-image `map`, `1dir`, and `pixflux` styles plus
atomic ComfyUI `frames`. The frame record binds every source and output, one
palette, fps, ordered roles, and each frame's detected step and phase. A grid
disagreement rejects the whole set. The schema rejects `tiles` and provider
`animation`, whose output contracts differ. See
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
            "seed": { "nodeId": "3", "input": "seed" },
            "composition": { "nodeId": "19", "input": "image" },
            "controlStrength": { "nodeId": "20", "input": "strength" }
          }
        }
      }
    }
  },
  "assets": {
    "mountain": {
      "prompt": "a snowbound mountain pass",
      "width": 768,
      "height": 512,
      "providerInputs": {
        "composition": "controls/mountain-layout.png",
        "controlStrength": 0.7
      }
    }
  }
}
```

Node IDs come from the exported workflow; they are not stable across unrelated
workflows. Binding names beyond PixelKiln's built-ins are project-defined and
an asset overrides one with a matching `providerInputs` value. A custom
binding aimed at `LoadImage.image` or `LoadImageMask.image` treats its string as
a manifest-relative PNG/JPEG, hashes it, and uploads it at submission. Other
custom inputs accept a string, number, or boolean matching the workflow's
placeholder type. Local paths never enter stable provenance.

The current adapter supports `map` and ordered still-image `frames`, PNG output
from one node, 1–16 `map` candidates, and dimensions from 16–4096px. A frame
style uses `numImages: 1`; the varying input supplies 2–64 renders. It rejects
manifest `styleImages` and `palette`;
use custom image bindings for per-asset ControlNet or reference images, and keep
shared model/LoRA/palette controls inside the workflow. See
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
| `prompt` | string, required unless `mirror` | Subject-specific prompt. It may be empty only during existing-art onboarding. |
| `category` | string | Human grouping metadata. |
| `width` | integer 16–8192 | Per-asset width override. Each provider applies its own ceiling. |
| `height` | integer 16–8192 | Per-asset height override. Each provider applies its own ceiling. |
| `size` | integer 32–256 | Per-asset square size override. |
| `file` | string | Filename/path override beneath the style output root. |
| `styles` | string array, `[]` | If non-empty, generate this asset only in the named styles. |
| `promptByStyle` | object, `{}` | Replace the asset prompt for specific style ids. |
| `tags` | string array, `[]` | Asset tags combined with style tags. |
| `cell` | `[column,row]` | Non-negative stable grid cell used by `mount`. |
| `source` | string | Manifest-relative post-processed/hand-drawn source placed by `mount`, `pack`, and `export` instead of lock output. For a set of PNG outputs, a path that is not a file is a stem: each member is placed from `<stem>-<role>.png`, the rule generated outputs follow. A file that exists there is one image placed for the whole set, as before. |
| `sourceByStyle` | object | The same, for one style only. A hand edit belongs to one generation, so an asset shared by styles keeps one edit per style. |
| `revision` | object | Generate a new asset from another asset's current bytes. `source` and `revision` are mutually exclusive. |
| `outputRole` | string | Select one member of a structural output set for mounting. |
| `mirror` | string | Another asset of this style, flipped left to right. No prompt, no provider, no cost. See [Mirrors](#mirrors). |
| `proportions` | preset or object | This base's body proportions, over the style's. `standard` humanoid bases only. |
| `reference` | string or object | The character's own sprite(s) for PixelLab to rotate. Bases only. |

## Characters

```json
{
  "styles": {
    "cast": {
      "generator": "character",
      "outDir": "art/characters",
      "view": "side",
      "size": 64,
      "mode": "standard",
      "palette": ["#0f380f", "#306230", "#8bac0f", "#9bbc0f"],
      "enforcePalette": true
    }
  },
  "assets": {
    "mira": {
      "prompt": "small young woman, dark curly hair in a bun, oversized hoodie"
    },
    "mira.chair_spin": {
      "prompt": "one hand high on the pole, sitting in the air with knees up, spinning",
      "state": { "of": "mira", "paletteFromReference": true }
    },
    "mira.fireman_spin": {
      "prompt": "spinning around the pole, knees crossed",
      "animation": { "of": "mira.chair_spin", "direction": "east", "frames": 8, "fps": 10 }
    },
    "mira.walk": {
      "prompt": "",
      "animation": { "of": "mira", "template": "walk", "direction": "south" }
    }
  }
}
```

A `character` style holds three shapes of asset that share one PixelLab
character.

A base is a prompt, wrapped in the style's prefix and suffix like any other
asset, that PixelLab draws facing 4 or 8 directions. `mode` picks the
engine: `standard` (1 generation, the skeleton template, `outline`,
`shading`, and `detail` as soft guidance, and `palette` sent as a colour
reference), `v3` (2 to 9 by size, the highest quality, up to 256px), or
`pro` (20 to 40 by size). `size` is the character's size; `view` is `low
top-down` (the default), `high top-down`, or `side`; `template` picks the
body. Each direction lands as `<asset>-<direction>.png`, south first.
Standard mode draws on a canvas 28px larger than `size`, 14px of room on
each side for animation (a 64px character comes back as 92px files, a
104px one as 132px); the lock records the size asked for, and the files
are what PixelLab drew.

Three more knobs shape a `standard` base. `proportions` is a preset
(`chibi`, `heroic`, and so on) or multipliers on the mannequin's head,
arms, legs, shoulders, and hips; it lives on the style and any base may
override it, and only the mannequin template has proportions to set.
`textGuidanceScale` (1 to 20, PixelLab's default 8) is how closely the text
is followed, and applies to template loops as well. `isometric` draws the
base and every loop in isometric view. The v3 and pro engines take none of
the three for a base; a v3 style may still set the last two for its loops.
A `v3` base takes `enhancePrompt` instead, which has PixelLab expand the
prompt into a fuller one before drawing.

A base can also start from your own sprite. `reference` names a
manifest-relative PNG or JPEG of the character facing south, and PixelLab
draws the other directions from it, with the prompt as guidance:

```json
"mira": { "prompt": "small young woman, oversized hoodie", "reference": "refs/mira-south.png" }
```

`standard` uses each image as it is, centred on its larger canvas, and
generates the rest, so the image must be the style's `size` exactly; it
accepts one image per direction
(`{ "south": ..., "east": ... }`), and a quadruped template needs south and
east. `v3` rotates one south image of up to 256px (its `template` must
match the body in the image). `pro` rotates one south image of up to 168px
through its `rotate_character` method. The reference's bytes are part of
the base's identity, so a redrawn file makes the base stale, and the file
is read again at submit time and refused if it changed since `plan`.
States, animations, and mirrors take their look from their parent and
cannot carry a reference.

Style images on a `character` style are a pro-only input: one image of up
to 168px that anchors the look of a `pro` base drawn from text (PixelLab's
`create_with_style`). `standard` and `v3` have no such slot and refuse
them; a pro base with a `reference` refuses them too, since the rotate
method has one image slot and it is the character.

A state is a text edit of an existing character, `state.of`, applied to
every direction at once: a pose, an outfit, a held object. The prompt is
the edit and goes to PixelLab as written, without the style's prefix and
suffix, since the character already carries the look.
`paletteFromReference` snaps the result to the parent's colours; `canvas`
asks for a larger frame when the edit adds something big. A state costs 20
to 40 by canvas and keeps the parent's directions. A state may be a state
of another state.

An animation is one loop of one character (`animation.of`, a base or a
state) in one `direction`. With a `template` (PixelLab's `walk`,
`breathing-idle`, `running-8-frames`, and so on) it costs 1 and the
template decides the frame count; without one the prompt is the motion and
PixelLab's v3 engine draws `frames` frames (4 to 16, even, default 8) for
`ceil(size² × frames / 65536)` generations, one at 64px. `keepFirstFrame`
(on by default) stores the resting pose as frame 0, so 8 frames land as 9
files, `<asset>-frame-00.png` onwards. `fps` is recorded with the frames
for the gallery, `pack`, and the Godot and Aseprite formats; PixelLab does
not keep one. An animation lands in review as an ordered set: `pick` shows
the loop and accepts or rejects it whole. One asset per direction; declare
another asset for another direction, or a [mirror](#mirrors) of this one
for the direction that faces the other way.

A v3 loop can start and end where you say. `startFrame` is a
manifest-relative image of the pose to begin from instead of the
character's rotation; `endFrame` is a pose to reach, and with it the loop
interpolates from the start frame to that image (both up to 256px, and the
end frame the same size as the start frame or, without one, as the
character's rotation, which `plan` checks once the parent is on disk; the
frames can still come back on a taller canvas when the motion needs it, as
a 92px crouch did at 92×104). `subject` replaces the character's own description for this loop when it
would mislead the model (a state that took the armour off), and
`enhancePrompt` lets PixelLab expand the action into a fuller motion
description first. A template loop takes none of those; it takes
`outline`, `shading`, and `detail` overrides instead, over the character's
own. The style's `palette` goes to every loop as a colour reference, as it
does to a `standard` base, and `enforcePalette` still snaps the frames
afterwards. Pose images hash into the loop's identity and are read again
at submit time, like a base's `reference`.

```json
"mira.bow": {
  "prompt": "bowing deeply from the waist",
  "animation": { "of": "mira", "direction": "south", "frames": 6, "endFrame": "poses/mira-bowed.png" }
}
```

States and animations depend on their parent the way a revision does. The
parent must be downloaded and current before the child is actionable;
`plan` reports the child as `blocked` and names the parent until then, and
one `gen` runs the waves in order: bases, then states, then animations,
under one budget. The
child's identity includes the parent's generated south-facing file, so
regenerating the parent makes every state and animation of it `stale`. A
hand edit of the parent does not, because PixelLab draws the child from the
character it holds, not from local bytes.

Regenerating an animation clears PixelKiln's own earlier take of that
direction on the character first, since PixelLab skips a direction that
already exists. The lock records the animation and group ids PixelLab
assigned, and the delete goes by those (PixelLab keeps the name PixelKiln
gives a loop only for text animations, not template ones). Nothing else on
the character is touched, and a base or state is never deleted by
PixelKiln.

`enforcePalette` snaps every direction and every frame. `pack --style cast
--format godot` writes a `SpriteFrames` with each direction of a base or
state as a still and each animation as a looping set at its fps;
`--format aseprite` does the same with `frameTags`.

Characters that already exist on the account come under the manifest with
`adopt`. Declare the asset with `remoteId` (the character id, or
`<character id>#<animation group id>` for a loop; `get_character` in
PixelLab's own tools shows both) and run `pixelkiln adopt`: it records the
character, writes every direction and frame that is not on disk, and costs
nothing. A base can also be matched by the bytes of its south-facing file.
See [`adopt`](CLI.md#adopt).

## Mirrors

Each direction of a loop is its own generation, and a sprite walking east
is the sprite walking west flipped. A `mirror` asset is that flip, made
locally from the source asset's downloaded files:

```json
"hero.walk.west": { "prompt": "", "animation": { "of": "hero", "template": "walk", "direction": "west" } },
"hero.walk.east": { "mirror": "hero.walk.west" }
```

A full 8-direction set of one loop is then 5 generations (south, north,
west, south-west, north-west) and 3 mirrors; a 4-direction set is 3 and 1.
The mirror takes its shape from the source (a loop of the same character,
facing the other way, at the same fps), needs no prompt, and costs
nothing: `plan` lists it under the provider with a cost of 0 and `gen`
flips it in the wave after the source lands. It has its own lock entry and
files (`hero.walk.east-frame-00.png` onwards), so `pack`, the gallery, and
an engine see an ordinary loop. Nothing is sent to the provider, and the
account holds no east animation.

The lock records a hash over the source's output hashes when the flip was
made. A source that is regenerated, restored, or re-snapped makes its
mirrors `stale`, and the next `gen` flips them again for free. A mirror
whose files went missing is `stale` too; one that was hand-edited is
`orphaned`, like generated art. A source that is not downloaded, current,
and untouched blocks its mirrors.

A loop facing south or north cannot be mirrored: the flip would be the same
direction with its asymmetries swapped, not a new one. A single image or a
frame set from any generator can be mirrored, and so can a base or state
(every direction flipped and relabelled, so west becomes east). A tile set
cannot; its edges carry meaning. Mirroring swaps handedness, so a character
who holds a sword in the right hand holds it in the left when facing the
mirrored way. Most games accept that; if yours does not, generate both
sides. `adopt` skips mirrors, since there is nothing upstream to adopt.

Engines that flip sprites at draw time (Godot's `flip_h`, Unity's
`flipX`) do not need mirrored files at all. Declare only the directions
you generate and flip in the engine; mirrors are for pipelines that want
every direction on disk.

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
without losing the declarative placement; `sourceByStyle` does the same for one
style. `pixelkiln edit` manages both for hand edits.

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
