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
      "promptPrefix": "pixel-art game prop",
      "promptSuffix": "isolated, transparent background",
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

```jsonc
{
  "$schema": "./node_modules/pixelkiln/schema/manifest.schema.json",
  "name": "my-game",          // tags every provider object pixelkiln:my-game
  "provider": "pixellab",     // the default; a style may name another
  "history": 3,               // keep three replaced generations per asset
  "styles": { "base": { "generator": "map", "outDir": "assets/generated/base" } },
  "assets": { "anvil": { "prompt": "a compact blacksmith anvil" } }
}
```

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
| `state` | object | `character` styles: a pose or outfit of another character asset. See [Characters](./CHARACTERS.md). |
| `animation` | object | `character` styles: a loop of another character asset in one direction. `directions` (a list, instead of `direction`) declares the loop for several directions at once and fills the unnamed flips with mirrors; see [One loop, several directions](./CHARACTERS.md#one-loop-several-directions). |
| `mirror` | string | Another asset of the same style flipped left to right, made locally at no cost. See [Mirrors](./CHARACTERS.md#mirrors). |
| `batch` | object | `1dir` styles: rides along on another `1dir` asset's `item_descriptions` submission instead of generating on its own — `{ "of": "<leader asset id>", "index": <1-based slot> }`. See [`1dir`](./GENERATORS.md#1dir). |
| `pieces` | array | `uiAsset` styles: exact shape regions (`rounded_rect`/`circle`/`polygon`) the panel is composited from, each with a unique `id`. See [`uiAsset`](./GENERATORS.md#uiasset). |
| `elements` | string array | `uiAsset` styles: named, auto-positioned UI scaffolds (`button`, `health_bar`, `window`, ...). Combine with `pieces`; omit both for a plain full-canvas panel. See [`uiAsset`](./GENERATORS.md#uiasset). |
| `proportions` | preset or object | `character` styles: this base's proportions, over the style's. |
| `reference` | string or object | `character` styles, bases: the character's own south-facing sprite (or `{ "south": ..., "east": ... }`), which PixelLab rotates instead of drawing from the prompt. See [Characters](./CHARACTERS.md). |
| `concept` | string | `character` styles, `pro` bases: a manifest-relative concept image (up to 1024px) the design is seeded from. |
| `styleCharacter` | string | `character` styles, `pro` bases: this base's style anchor, over the style's. |
| `providerInputs` | JSON scalar/sequence map, `{}` | Named per-asset inputs consumed by the active provider. ComfyUI accepts scalars and, for `frames`, one ordered 2–64 value sequence. Image bindings upload PNG/JPEG inputs. |
| `styles` | string array, `[]` | Restrict the asset to named styles; empty means every style. |
| `promptByStyle` | string map, `{}` | Replace only the asset prompt for a named style. |
| `cell` | `[column,row]` | The grid cell this asset owns in a mounted sheet; see [stable-cell mounting](#stable-cell-mounting). |
| `outputRole` | string | Select one structural output when a generator returns a set. |
| `tags` | string array, `[]` | Asset tags added to provider objects where supported. |

`providerInputs` is provider-owned and participates in generation identity.
Changing a value makes only that asset stale. A provider may replace a local
runtime path with a content hash before hashing the spec; unsupported providers
reject non-empty inputs rather than ignoring them.
Only a provider that declares a sequence contract may accept an array. ComfyUI
uses the array named by `providerOptions.comfyui.frames.vary`; other inputs stay
constant across the set.

One asset using the fields most projects reach for:

```jsonc
{
  "assets": {
    "anvil": {
      "prompt": "a compact blacksmith anvil",
      "promptByStyle": { "mono": "a compact blacksmith anvil, dark iron" },
      "width": 48,
      "height": 32,
      "category": "tools",             // assets/generated/base/tools/anvil.png
      "tags": ["prop", "forge"],
      "styles": ["base", "mono"],      // skip every other style
      "cell": [2, 0],                  // its cell on a mounted sheet
      "source": "edits/anvil.png"      // a hand edit stands in for the generated file
    }
  }
}
```

## Style fields

| Field | Type/default | Meaning |
|---|---|---|
| `extends` | style id | Optional parent style. The child inherits resolved settings but must declare its own `outDir`. |
| `provider` | top-level default | Provider registry id for this style. Assets cannot override it. |
| `generator` | `map` | `map`, `1dir`, `pixflux`, `tiles`, `terrain`, `isometricTile`, `imagePro`, `character`, `objectPro`, `uiAsset`, `uiElement`, or provider-specific `animation`/`frames`. See [GENERATORS.md](./GENERATORS.md). |
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
| `mode` | `standard` | `character` only. `standard`, `v3`, `pro`, or `pro-flash`; see [Characters](./CHARACTERS.md). |
| `directions` | `8` | `character` only. `4` or `8`; every engine but `standard` draws 8. |
| `template` | `mannequin` | `character` only. Body template: `mannequin`, or `bear`, `cat`, `dog`, `horse`, `lion`; `custom` for `pro-flash`. |
| `proportions` | | `character` only, `standard` humanoid bases. A preset (`default`, `chibi`, `cartoon`, `stylized`, `realistic_male`, `realistic_female`, `heroic`) or multipliers `{ headSize, armsLength, legsLength, shoulderWidth, hipWidth }`, each 0.5 to 2. An asset may override it. |
| `textGuidanceScale` | `8` | `character` only. How closely a `standard` base and a template loop follow their text, 1 to 20. |
| `isometric` | `false` | `character` only. Draw `standard` bases and every loop in isometric view. |
| `enhancePrompt` | `false` | `character` only, `v3` bases. Let PixelLab expand the prompt into a fuller one before drawing. |
| `styleCharacter` | | `character` only, `pro` bases. The asset id of a generated 8-direction character in this style whose look bases drawn from text or a concept follow. An asset may override it. |
| `styleTraits` | all true | `character` only, `pro-flash` bases with a style image. `{ palette, outline, detail, shading }` booleans: which traits the style image lends. |
| `mount` | object | Stable-cell sheet placement; documented below. |
| `quality` | object | Optional native-grid, final-palette, and human-approval contract; documented below. |
| `tags` | string array, `[]` | Tags inherited by every generated provider object in the style. |

One style using the common fields, and a `pixflux` style with a locked
palette:

```jsonc
{
  "styles": {
    "base": {
      "generator": "map",
      "outDir": "assets/generated/base",
      "promptPrefix": "pixel-art game prop",
      "promptSuffix": "isolated, transparent background",
      "size": 64,
      "view": "high top-down",
      "outline": "selective outline",
      "shading": "medium shading",
      "detail": "medium detail",
      "seed": 7,
      "tags": ["props"]
    },
    "gb": {
      "generator": "pixflux",
      "outDir": "assets/generated/gb",
      "palette": ["#0f380f", "#306230", "#8bac0f", "#9bbc0f"],
      "enforcePalette": true,
      "noBackground": false
    }
  }
}
```

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

## Provider-specific fields

Each experimental provider adds style and asset fields of its own, under
`providerOptions.<provider>` on the style and `providerInputs` on the asset.
They are documented with the provider:

- [Retro Diffusion](./RETRO_DIFFUSION.md#manifest-fields): still styles,
  tilesets, and GIF or spritesheet animation.
- [ComfyUI](./COMFYUI.md#manifest-fields): a committed workflow, its bindings,
  revisions, and atomic frame sets.
- [Scenario](./SCENARIO.md#manifest-fields): hosted model ids and Compute
  Unit ceilings.

Only the active provider's object is resolved and hashed, so one style can
carry settings for more than one provider and switch between them by
changing `provider` alone:

```jsonc
{
  "provider": "pixellab",
  "styles": {
    "environment": {
      "generator": "map",
      "outDir": "assets/generated/environment",
      "providerOptions": {
        "retrodiffusion": { "promptStyle": "rd_plus__default", "numImages": 4 },
        "comfyui": { "workflowFile": "workflows/still-api.json", "outputNodeId": "9" },
        "scenario": { "modelId": "model_bfl-flux-2-dev", "maxComputeUnits": 60 }
      }
    }
  },
  "assets": { "keep": { "prompt": "a mountain keep at dusk" } }
}
```

`providerInputs` on an asset is the same idea per asset, for providers that
declare bindings (ComfyUI); a provider without them rejects a non-empty
object rather than ignoring it.

## Characters and mirrors

A `character` style holds a base drawn facing 4 or 8 directions, states, and
loops, with a `mirror` asset for the direction that faces the other way,
made locally at no cost. The shapes, engines, references, and costs have
their own page: [Characters](./CHARACTERS.md) and
[Mirrors](./CHARACTERS.md#mirrors).

```jsonc
{
  "styles": {
    "cast": {
      "generator": "character",
      "outDir": "art/characters",
      "mode": "pro-flash",         // standard, v3, pro, or pro-flash
      "template": "custom",        // mannequin, a quadruped, or custom (pro-flash)
      "size": 96
    }
  },
  "assets": {
    "bot": {
      "prompt": "small round orange robot with one blue eye",
      "reference": "refs/bot-south.png"      // rotate this sprite instead of drawing from text
    },
    "bot.dented": {
      "prompt": "shell dented, one arm hanging loose",
      "state": { "of": "bot", "paletteFromReference": true }
    },
    "bot.walk.west": {
      "prompt": "walking in place, short legs stepping",
      "animation": { "of": "bot", "direction": "west", "frames": 12, "fps": 12 }
    },
    "bot.walk.east": { "mirror": "bot.walk.west" },     // flipped locally, 0 generations
    "bot.bust": { "portrait": { "of": "bot", "size": 64 } },  // no prompt; drawn from bot's pixels
    "bot.walk.west.armored": { "outfit": { "of": "bot.walk.west", "reference": "refs/armor.png" } }
  }
}
```

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
| `mode` | enum, required | `image-to-image`, `inpaint`, `outpaint`, `reduce-colors`, `correct-pixelart`, `animate`, `animate-pixminimax`, `interpolate`, or `edit-animation`. The selected provider must opt into the mode. |
| `from` | asset id, required | Parent asset in the same style. Self-references, unknown ids, and cycles are rejected. A parent written as a set (a character's directions, an animation's frames) is read as every member: `reduce-colors`, `correct-pixelart`, and `edit-animation` take the whole set in one call; the other modes refuse it. See [Revising a whole set at once](./REVISIONS.md#revising-a-whole-set-at-once). |
| `mask` | string | Manifest-relative PNG required for `inpaint`; rejected for the other modes. Its dimensions must match an available source. |
| `strength` | number 0–1 | Workflow edit/denoise strength (`image-to-image`, `correct-pixelart`); rejected for `reduce-colors`, `animate`, `animate-pixminimax`, `interpolate`, and `edit-animation`. Interpretation is provider- and model-specific. |
| `numColors` | integer 2–256 | `reduce-colors` only. Target palette size; mutually exclusive with `paletteImage`. |
| `paletteImage` | string | `reduce-colors` only. Manifest-relative image whose colors become the palette; unlike `mask`, no size relationship to the source is required. |
| `dithering` | enum | `reduce-colors` only. `none` (default), `2x2`, `4x4`, or `8x8`. |
| `ditheringStrength` | number 0–10 | `reduce-colors` only. Ignored when `dithering` is `none`. |
| `frames` | integer 4–40, even | `animate`/`animate-pixminimax` only. `animate` caps at 16; `animate-pixminimax` allows up to 40. |
| `fps` | integer 1–60 | `animate`/`animate-pixminimax`/`interpolate`/`edit-animation` only. Playback rate recorded with the frames; the provider does not store one. Defaults to the parent's own rate when it is a loop, else 8. |
| `lastFrame` | string | `animate`/`animate-pixminimax`: manifest-relative image pinning where the motion ends, turning an open-ended animation into an interpolation. `interpolate`: required, the ending keyframe (the parent is the start); it must match the parent's size. |
| `direction` | enum | `animate-pixminimax` only. The sprite's facing, used only alongside `enhancePrompt`. |
| `enhancePrompt` | boolean | `animate`/`animate-pixminimax` only. Lets the provider expand the prompt into a fuller motion description first, for an extra documented +0.05-generation surcharge. |

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

```jsonc
{
  "styles": {
    "base": { "generator": "map", "outDir": "art/base", "promptPrefix": "pixel-art prop", "promptSuffix": "transparent background" },
    "mono": { "extends": "base", "outDir": "art/mono", "promptSuffix": "one-bit, transparent background" }
  },
  "assets": {
    "star": {
      "prompt": "a golden star",
      "promptByStyle": { "mono": "a five-pointed star" }   // colour words would fight the style
    }
  }
}
```

Prefix, subject, and suffix are trimmed and joined with ", ": `base/star`
is sent as "pixel-art prop, a golden star, transparent background" and
`mono/star` as "pixel-art prop, a five-pointed star, one-bit, transparent
background". For each participating style/asset pair:

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

```jsonc
{
  "styles": { "base": { "generator": "map", "outDir": "art/base" } },
  "assets": {
    "anvil": { "prompt": "an anvil" },                              // art/base/anvil.png
    "hammer": { "prompt": "a hammer", "category": "tools" },        // art/base/tools/hammer.png
    "sign": { "prompt": "a shop sign", "file": "ui/shop-sign.png" }  // art/base/ui/shop-sign.png
  }
}
```

A set keeps the same stem and adds the role: a character base `bot` in a
style with `outDir: "art/cast"` lands as `art/cast/bot-south.png`,
`bot-west.png`, and so on; a loop as `bot.walk-frame-00.png` onwards.

## Validation and editor setup

Regenerate the checked-in schema after changing the Zod manifest types:

```bash
npm run schema
git diff -- schema/manifest.schema.json
```

Run `pixelkiln doctor --dry-run` for local references and project-state checks,
then `pixelkiln plan` to see the resolved work and cost before spending.
