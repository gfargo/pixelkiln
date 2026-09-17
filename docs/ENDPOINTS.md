# Measured PixelLab API reference

Every cost here was **measured against a live Tier 2 account**, not read from
documentation. Where a figure came from docs rather than a meter, it says so.

Source of truth for shapes: `https://api.pixellab.ai/v2/openapi.json`
(79 paths, 56 of them POST). A concise index lives at `GET /v2/llms.txt`.

Auth is one long-term key for everything: `Authorization: Bearer $PIXELLAB_API_KEY`.

---

## Endpoint families

| Family | Paths | What it covers |
|---|---|---|
| characters | 23 | 4/8-direction characters, portraits, outfit transfer, lip-sync |
| single images | 14 | one-off images, inpaint, resize, rotate, background removal |
| tiles / tilesets | 12 | top-down and sidescroller tilesets, isometric tiles |
| objects | 10 | 1- and 8-direction objects, states, animations |
| animation | 9 | skeleton and text-driven animation, interpolation |
| ui / fonts | 6 | UI panels, pixel fonts |
| account | 5 | balance, listing, tags, background jobs |

pixelkiln uses the **single images** and **objects** families. The rest are
listed so it is obvious what exists.

---

## Single-image generators, measured

The endpoints that produce one standalone image. This is the decision that
matters most for icon and prop work.

| Endpoint | Cost | Sync? | Palette | Style ref | Verdict |
|---|---|---|---|---|---|
| `create-image-pixflux` | **1** | sync (~10s) | **yes** | no | **Default for a fixed palette** |
| `create-image-pixen` | **1** | sync (~40s) | no | no | Best raw detail at 1 generation |
| `create-image-bitforge` | **1** | sync (~20s) | yes | yes | Best on paper, poor in practice |
| `map-objects` | **1** | job (~30s) | rejected | no | Fine when the prompt carries the style |
| `create-1-direction-object` | **20–40** | job | no | yes | Only when you need rotations |
| `generate-with-style-v2` (Pro) | **20** | job (~150s) | no | yes | Real style transfer |
| `generate-image-v2` (Pro) | **40** | job (~150s) | no | yes | Real style transfer |

`1dir` prices by canvas area: ≤1024 px = 20, ≤2048 px = 25, larger = 40. A
64×64 icon therefore costs 40. Every other generator above is a flat 1–40
regardless of size.

`generate-image-v2` is wrapped by pixelkiln's `imagePro` generator
(skills/pixelkiln/references/pixellab.md): non-square and larger canvases
than `pixflux` allows, at the flat 40 above. Its `reference_images` and
`style_image` are not modeled, and its completed job's response shape is
inferred from `edit-images-v2`'s (also unmeasured for this endpoint
specifically) rather than confirmed live — see `pollImagePro` in
`src/providers/pixellab.ts`. `generate-with-style-v2` is not wrapped at all.

### What the measurements actually showed

**`pixflux` is the workhorse.** 1 generation, returns the PNG inline, and its
`color_image` parameter is a genuine constraint. A two-colour palette produced
130 badges containing **only** `#000000` and `#ffffff`, verified 65/65 in each
of two sets. Prose asking for the same thing gave a yellow star and a brown
chocolate bar.

**`bitforge` disappoints.** It is the only single-image endpoint with palette
*and* style reference *and* synchronous delivery, all for 1 generation, which
should make it ideal. In practice it returned unrecognisable blobs for a simple
"blacksmith anvil" prompt at `style_strength` 0, 10, 25 and 50. The first
failure looked like the style reference overwhelming the prompt; sweeping the
strength proved otherwise. Possibly tuned for a different kind of subject (docs
call it "Create S-M image", max area 200×200). **Do not reach for it on this
evidence alone.**

**`pixen` gave the best unconstrained detail** of anything at 1 generation, a
properly rendered anvil with sparks where others produced flat shapes. It has no
palette parameter, so it suits styles carried entirely by the prompt.

**The Pro v2 endpoints do real style transfer**, taking labelled reference
images and matching them convincingly. At 20–40 generations and ~150s they are
for cases where that matters more than throughput.

**`color_image` is not universal.** `map-objects` accepts the parameter in its
schema but returns `500 cannot identify image file` for every payload shape
tried. The palette lock works on `pixflux` and `bitforge` only.

### Payload shapes differ between generations of endpoint

Three incompatible conventions, which is a common source of 422s:

```jsonc
// pixflux / bitforge / map-objects
{ "color_image": { "type": "base64", "base64": "...", "format": "png" } }

// generate-image-v2 (Pro)
{ "style_image": { "image": {...}, "size": {"width":64,"height":64},
                   "usage_description": "art style to match" } }

// generate-with-style-v2 (Pro)
{ "style_images": [ { "image": {...}, "width": 64, "height": 64 } ] }
```

A palette swatch must also be **chunky**: a 4×1 image was rejected outright with
"cannot identify image file", a 64×64 block swatch was accepted.

---

## Post-processing utilities, measured

Five endpoints take an image in and give one back. All are **synchronous**, all
return `{usage, image}` inline, and all cost **1 generation**, including the
ones that sound like pure image manipulation.

| Endpoint | Cost | Palette survives? | What it actually does |
|---|---|---|---|
| `remove-background` | 1 | **yes** | Genuine cleanup, the only safe one |
| `rotate` | 1 | no | Re-renders from a new angle |
| `resize` | 1 | no | **Re-generates**, does not resample |
| `image-to-pixelart` | 1 | no | Destroys alpha too |
| `inpaint` / `edit-image` | 1 | untested | Targeted edits |

Measured on one 64×64 riso badge with an exact 4-colour palette
(`#f4ecd8 #1c1a17 #c1553a #6b7f5e`, 57% transparent):

| | colours out | transparency | result |
|---|---|---|---|
| source | 4 | 0.57 | n/a |
| `remove-background` | **3** | 0.60 | dropped a stray fringe, kept the rest |
| `rotate` | 30 | 0.58 | anti-aliased new angle |
| `resize` → 32px | 38 | 0.57 | cream+rust came back **gold** |
| `image-to-pixelart` → 32px | **455** | **0.00** | opaque grey background |

**`remove-background` also de-fringes.** It removed the
scattered sage-green speckles around the badge outline and left the three real
inks untouched. Colour count went *down*, transparency went *up*. It is the one
utility safe to run on palette-locked art.

**`resize` is generative, not a resampler.** The name is misleading: it takes a
`description` as a *required* field, and it re-renders. A 4-colour cream-and-rust
badge came back as 38 colours of gold.

**`color_image` does not rescue it.** `resize` accepts the parameter in its
schema; passing the exact same swatch that `pixflux` honours changed nothing.
56 colours, still gold. The forced palette works on **`pixflux` and `bitforge`
only**, and being in another endpoint's schema is not evidence it is wired up.

> **Never round-trip palette-locked art through `resize` or `rotate`.**
> Regenerating at the target size with `pixflux` costs the same 1 generation and
> the palette holds exactly.

**`image-to-pixelart` is for photographs and 3-D renders**, not for reprocessing
pixel art. It returned 455 colours on a 4-colour input and flattened the alpha
channel to an opaque grey field. There is no `no_background` parameter to
prevent that.

---

## Cleanup tier, measured

`/reduce-colors` and `/correct-pixelart` are a separate tier from the five
utilities above (PixelLab's own OpenAPI tag: `Cleanup`), synchronous, and
**confirmed at a flat 0.1 generations each** on a 32×32 source, live against a
Tier 2 subscription account (`pixellab balance change: 0.1000000000003638
generations consumed`, floating-point noise aside — same for both calls). The
OpenAPI schema's own response examples are dollar-denominated (`usage:
{type: "usd", usd: 0.005}` for `reduce-colors`, `0.01` for `correct-pixelart`)
and, as with `isometricTile` and `objectPro`, that did not predict real
billing; PixelLab's own MCP tool descriptions claiming a flat 0.1 generations
were the correct source instead. Wired up as the `revision` asset shape's
`reduce-colors`/`correct-pixelart` modes; see [Controlled asset
revisions](./REVISIONS.md#cleanup-reduce-colors-and-correct-pixelart). Only
confirmed at this one size — whether it stays flat at larger canvases (unlike
`inpaint`'s canvas-tiered cost) is not yet known. Multi-frame input (both
endpoints quantize/clean several same-size frames in one call, onto one
shared palette) is now modeled: a revision whose parent is a set sends every
member together; see [Revising a whole set at
once](./REVISIONS.md#revising-a-whole-set-at-once). Its price per call is
unmeasured.

`/unzoom` (same `Cleanup` tag, also synchronous) recovers native-resolution
pixel art from an upscaled image: at least 256×256 in, at most 2048×2048 in
area, and the result is opaque (transparency is composited onto white before
grid detection). PixelLab's own API overview tells integrators to run it on
any user-supplied reference art first. Wired up as `pixelkiln unzoom`, a
standalone command on a loose file rather than a revision mode, since the
art it is for (a reference pulled from outside) is not a manifest asset; see
[the CLI reference](./CLI.md#unzoom). Cost unmeasured; PixelLab's MCP tool
description claims 0.1 generations, the same as the rest of the tier.

---

## Tilesets: schema only, not yet measured

Called out separately because these are the most capable endpoints for level art
and they are relevant to the disc-golf game. **Costs below are unmeasured.**

`POST /tilesets` (top-down) and `/tilesets-sidescroller` are the current
versions; `/create-tileset*` are the older aliases with identical schemas.
The top-down family is wrapped by pixelkiln's `terrain` generator
(skills/pixelkiln/references/pixellab.md); `/create-tileset-sidescroller` and
the reference-image/`color_image` knobs below are not.

They take `lower_description` + `upper_description` (+ optional
`transition_description`). You describe two terrains and the transition between
them, and get a tileset that blends them. Distinctively, they accept **both**
`color_image` *and* per-layer reference images (`lower_reference_image`,
`upper_reference_image`, `transition_reference_image`). They are the only
family that combines palette forcing with style anchoring.

Useful knobs: `tile_size`, `tileset_adherence` / `tileset_adherence_freedom`
(how strictly tiles must fit together), `raggedness` and `slope_size` for edge
character, plus the usual `outline` / `shading` / `detail`.

`create-tiles-pro` is a different shape, a single `description` plus
`style_images`, `tile_view`, `building_*` fields for structures.

Its `style_images` is a **fourth** convention, and not the one two lines up:
`TilesProStyleImage` is flat, with all three fields required.

```jsonc
// create-tiles-pro
{ "style_images": [ { "base64": "...", "width": 32, "height": 32 } ] }
```

Sending `generate-with-style-v2`'s nested `{image: {...}}` here is rejected as
an extra field. Passing style images at all makes the endpoint ignore
`tile_type` and `tile_view` and copy the reference's tile geometry instead.
That is the only way to land new art on an existing sheet's ground plane.

`GET /tiles-pro/{id}` carries no `status` field. It answers **423 while the set
is still drawing** and 200 with `storage_urls` when it is done, so the HTTP code
is the status. Cost is reported at submit time and lands on the same 20/25/40
canvas tiers as `1dir`, but the canvas is tile size x variation count, not one
sprite. A small tile in a large set still reaches the top tier.

All response shapes used by the client are validated at runtime. The TypeScript
interfaces alone are not trusted at the HTTP boundary: missing ids, invalid
object geometry, malformed tile URL maps, or balance fields with changed types
produce an `Invalid PixelLab response` error before pipeline state is updated.

`outline_mode` defaults to `outline`, which draws a dark border around every
tile. For ground tiles that is wrong: laid on a grid the borders read as
quilting, with a seam at every cell edge. `segmentation` omits them and the
same set tiles seamlessly, measured on a fairway-to-rough terrain set, where
it was the difference between usable and unusable.

`tile_feature` and `style_images` are **mutually exclusive**. The API says
"Connectable features (roads/tileset/building) cannot be combined with style
tiles". So the
geometry-anchoring trick above is unavailable for a connectable set, and its
tiles land on whatever ground plane the view angle implies (measured: 32x24
with the diamond midline at y=7, against a 32x32 sheet wanting y=15).

`tile_feature` turns it from independent variations into a connectable set:
`roads` (18-configuration path set), `tileset` (16-tile Wang corner set for a
terrain transition; describe it as the transition, not one terrain), and
`building` (floor/wall/doorway kit). These are sliced by index, so the returned
order is load-bearing. They are structural multi-output results, not candidates
to choose between: PixelKiln persists every URL in numeric order and labels the
downloaded outputs `tile-00`, `tile-01`, … .

The completed response also carries `tile_rules` for connectable sets. Its
placement contract is `rule_type` (`edge`, `corner`, or `outline`), `arity` (4
for square/isometric edges or corners, 6 for hex edges), `connectivity`
(`same`/`other`), two terrain labels, and a `tiles` map of provider tile key to
bitmask. Four-edge masks use N/E/S/W as bits 0/1/2/3. Four-corner masks use
NW/NE/SW/SE as bits 3/2/1/0. Tiles absent from that map are stamp-only. PixelKiln
stores the complete object in `providerMetadata.pixellab.tileRules`; exporters
normalize the documented subset but retain the raw object in the generic file.

Given that `color_image` is honoured on `pixflux` but silently ignored on
`resize`, **verify the palette actually holds on a single tileset before
committing to a set**.

## Standalone isometric tile: schema documented, cost measured once

`POST /create-isometric-tile` (+ `GET`/`DELETE /isometric-tiles/{tile_id}`) is
a *third*, separate path to isometric content, distinct from both
`create-tiles-pro`'s `tile_type: "isometric"` (a full Wang/connectable set)
and the tileset family above (confirmed square-only, no isometric option at
all). This one generates a single standalone tile — no candidates, no
connectable set — and is wrapped by pixelkiln's `isometricTile` generator
(docs/GENERATORS.md).

`isometric_tile_shape` (`"thin tile"` ~15% canvas height, `"thick tile"`
~25%, `"block"` ~50%, the default) is a direct thickness/elevation control,
more granular than anything in `tiles`/`terrain`. `isometric_tile_size` (16
or 32, default 16) is the API's own tile grid, a separate concept from
`image_size` (the generation canvas, 16-64px each side; the endpoint's own
description states "sizes above 24x24 often produce better quality
results"). `outline` defaults to `"lineless"` here specifically — unlike
`create-tiles-pro`'s `"outline"` default — with its own three-value enum
(`"single color outline"`, `"selective outline"`, `"lineless"`); `shading`
and `detail` reuse the same enums as the tileset family above.

`GET /isometric-tiles/{tile_id}` carries no `status` field either: it answers
**423 while still processing** and 200 with the image once done, matching the
tileset family's own polling contract. Unlike every other job resource here,
its response shape is `{ image: Base64Image, usage }` — the finished tile
comes back embedded as base64, not a `storage_urls` link.

**Its own OpenAPI response schema example is misleading on cost.** It shows
`{ type: "usd", usd: 0.02 }`, which reads as billing in real dollars rather
than subscription generations, unlike everything else in this file. A real
call against a live subscription account (Tier 2, "generations" balance)
billed exactly `{ type: "generations", generations: 1 }` instead — the
documented shape never actually appeared. Measured at one size/shape
combination only (32px canvas, `"block"`); the endpoint's own docs give no
size-tiering formula the way `1dir`/`tiles` do, so pixelkiln's
`isometricTileCost()` assumes flat 1-generation pricing across the whole
16-64px range rather than guessing a tier.

`init_image`/`init_image_strength` (image-to-image) and `color_image`
(native forced-palette) both exist on this endpoint and are not modeled by
pixelkiln yet — no `style_images` concept exists here at all, unlike
`create-tiles-pro`.

---

## UI panels: one endpoint, schema documented, cost unverified

`POST /create-ui-asset` (+ `GET`/`DELETE /ui-assets/{id}`, `GET /ui-assets`)
is wrapped by pixelkiln's `uiAsset` generator (docs/GENERATORS.md). A broad
search of the live OpenAPI document for "ui-asset", "element", "split", and
"template" paths found **only these three callable endpoints** — no separate
batch-icon endpoint, no states endpoint, no nine-slice endpoint, contrary to
tutorial-based descriptions elsewhere.

Request fields: `description`, `image_size` (`{width, height}`, 192-688px per
axis, aspect-gated rather than a free rectangle — square tops out at
512x512, 16:9 at 688x384, 9:16 at 384x688, 4:3 at 600x448, 3:4 at 448x600; a
combination outside these five tiers is rejected or silently resolved to a
different tier's ceiling), `pieces` (an array of `rounded_rect`/`circle`/
`polygon` shapes, each with a unique `id` and optional `label`, positioned on
a virtual 0-512 coordinate canvas independent of `image_size`), `elements`
(named auto-positioned scaffolds — `button`, `icon_button`, `toolbar`, `tab`,
`panel`, `window`, `health_bar`, `avatar`, `triangle`, `pentagon`, `hexagon`,
`octagon`), `style_image` (a single `Base64Image`, unlike most generators'
plural `style_images`), `color_palette` (a free-text prompt-level hint, e.g.
"brown and gold" — pixelkiln's own hex-array `palette` field is a different,
local-quantization concept and is deliberately not sent here), `no_background`,
`seed`.

`POST /create-ui-asset` responds `{ui_asset_id, background_job_id, status,
usage}`. `GET /ui-assets/{id}` responds `{id, prompt, size, image_url
(nullable), status ("processing"|"completed"|"failed"), progress_percent,
eta_seconds}` — **one flat composited image**, confirmed by the schema to
carry no per-piece sub-images, no bounding-box data, and no nine-slice
metadata at all, regardless of how many `pieces`/`elements` the request
listed.

The `delete_ui_asset` MCP tool's own description says it removes "a UI panel
(and, for a template, its split elements + their states)", which hints
PixelLab's internal product model has a real split/states concept somewhere.
Nothing found in the public REST surface reaches it — "states" and "splitting
into individual elements" are not buildable from any endpoint listed here,
whatever the product does internally. A themed panel variant (e.g. an empty
vs. full health bar) still costs nothing extra to build: pixelkiln's existing
`revision` mechanism (image-to-image on any generator's output) already does
exactly that.

**Cost: confirmed live at one data point, and it overturned the borrowed
formula.** A real 256x192 (49152px²) call against a Tier 2 subscription
account billed exactly **20 generations** (balance 4979.8 → 4959.8), matching
the low end of the `create_ui_asset` MCP tool description's "20-40
generations" claim. pixelkiln's `generationCost()` has no dedicated branch
for `uiAsset` and falls through to the same canvas-tier formula as
`1dir`/`tiles`, which — given `uiAsset`'s 192px-per-side floor (already
36864px², past that formula's own 2048px² top tier) — always predicts the
40-generation ceiling. The measured call proves that formula wrong for this
generator: 49152px² sits well above the borrowed top tier yet billed the
*floor* price, not the ceiling, so `uiAsset` pricing does not follow
`1dir`/`tiles`' area-based tiers at all. Left unchanged rather than patched
from one data point — over-reading stays the safe direction for `--budget`,
the same policy `tiles`/`terrain` estimates use elsewhere in this file — but
budget a real call at roughly half the number `pixelkiln plan` prints until a
second size is measured.

---

## Recipes

**Lock a palette.** Use `pixflux` with a `color_image` swatch. Build the swatch
with `paletteSwatch()`: 64×64 blocks, one band per colour. It is a real
constraint, not a hint: 130 badges across two sets came back containing *only*
the requested colours.

**Re-roll one bad asset.** 1 generation. `gen --only <id> --force`. Cheaper than
asking for more candidates. A `1dir` call that yields 16 candidates costs 20–40.

**Clean up fringing.** `remove-background` at 1 generation, and it will not
disturb the palette.

**Change the size of an existing asset.** Regenerate with `pixflux` at the new
size. Do not use `resize`.

**Anchor to an existing look rather than a palette.** `generate-with-style-v2`
(20) or `generate-image-v2` (40). `bitforge` claims to do this for 1, but see
above. `map` has no style anchoring at all. A 1-bit set generated through it
came back with a yellow star and a brown chocolate bar.

**Write prompts for a monochrome style.** Strip colour words from the prompt
itself. "a golden trophy" fights a two-tone palette; the neutral noun does not.
pixelkiln's `promptByStyle` exists for exactly this.

**Never let a device or medium name lead a prompt.** `"Original Game Boy DMG
handheld sprite:"` as a prefix produced drawings of handheld consoles across a
whole set. Put the medium in the *suffix*, after the subject.

**Probe an unfamiliar parameter freely.** Failed generations are not billed.

---

## Candidates

Only `create-1-direction-object` returns multiple candidates, and the count is
derived from size, and cannot be requested:

| size | candidates |
|---|---|
| ≤42 | 64 |
| ≤85 | 16 |
| ≤170 | 4 |
| >170 | 1 |

Cost is per call, so the candidates are free. Counterintuitively, generating
*smaller* yields *more* candidates for *less*. But "pick from 16" is poor value
once a 1-generation re-roll exists: forty re-rolls cost one `1dir` call.

**`item_descriptions` turns those same candidate slots into distinct items,
still free.** Instead of N variations of one prompt, `create-1-direction-object`
takes a per-slot description list and returns N *different* described
objects; `select-frames`'s own `indices` field is already plural — several
candidates, not just one, promote to separate permanent objects in a single
call. Wired up as the `1dir` asset shape's `batch` field; see
[`1dir`](./GENERATORS.md#batch-several-distinct-objects-for-one-calls-cost).
**Confirmed live**: a 32px, 3-description call billed exactly 20 generations
(the ordinary floor tier above, unaffected by `item_descriptions`), and
`item_descriptions[0]` owns candidate slot 0 — a `["a wooden treasure
chest", "a red potion...", "a rusty key..."]` call returned exactly a chest
at frame 0, a potion at frame 1, a key at frame 2. Only confirmed at this
one size; the higher cost tiers are still unconfirmed under
`item_descriptions`.

---

## Object lifecycle

- `1dir` and `8dir` objects **persist** with stable public URLs.
- `map-objects` job records are documented to auto-delete after 8 hours. The
  **image survives**: a March 2026 sprite still resolved from `/v2/objects` four
  months on while `/v2/map-objects/{id}` returned 404. pixelkiln's `poll` checks
  the objects collection on a 404 rather than writing the work off.
- `pixflux`/`pixen`/`bitforge` results are **not account objects** at all.
  Bytes come back inline and are never listed. `adopt` and `salvage` cannot see
  them, and they cannot be tagged.
- Character rotation and frame URLs live at a stable path under
  `backblaze.pixellab.ai/file/pixellab-characters/...` but carry
  `?t=<updated_at as epoch seconds>`, and the response is
  `cache-control: public, max-age=31536000`. The path serves the current
  bytes with any `t` (checked September 2026), but a cache between you and
  the bucket may not, so `fetch --refresh` reads `GET /characters/{id}` for
  the current stamp before comparing. Object URLs carry no stamp.

---

## Limits and billing

- **Submissions must be >2s apart.** Concurrent background jobs: Tier 1 = 8,
  Tier 2 = 10, Tier 3 = 20.
- **Failed generations are not billed.** Two failed forced-palette attempts moved
  the balance by zero, so probing an unfamiliar parameter is free.
- **Billing lags slightly.** A bitforge call read as cost 0 immediately after and
  1 a few seconds later. Trust the `usage` field in the response over an
  immediate balance diff. Confirmed again below: a standard character base's
  balance read unchanged immediately after `getCharacter` reported it complete.
- `usage` is returned inline by the synchronous endpoints:
  `{"type":"generations","generations":1}`.
- **`GET /background-jobs/{id}` carries `usage` on a completed job, at the top
  level and duplicated at `last_response.billing_usage`** (same shape, plus
  `billing_charged: true` on the nested copy); confirmed live for a `map`
  object (1 generation, matched a balance diff taken later) and a standard
  character base (1 generation). The resource-level GET does not: neither
  `GET /objects/{id}`/`GET /map-objects/{id}` nor `GET /characters/{id}`
  carries `usage` once the job is gone, completed or not. `poll` reads the
  object/character for the result but would need this same job id, still
  polled separately today, to learn what it actually cost.
- **`inpaint-v3` and `edit-images-v2` both confirmed live at their floor
  size**: a 32×32 masked inpaint and a separate 32×32 whole-image edit each
  billed exactly 20 generations, both matching a balance diff taken after.
  `inpaint-v3`'s `last_response` is `{seed, type, image: {type, base64,
  width, height}, action, progress, billing_usage, generation_id,
  usage_cost_usd, billing_charged, generation_mode: "inpainting_v3",
  quantized_image: {type, base64, width, height}, generation_started_at,
  original_image_n_colors, quantized_image_n_colors}`. `edit-images-v2`'s is
  the same shape except **plural and array-wrapped**: `images: [{type,
  base64, width, height}]` and `quantized_images: [...]` in place of
  `image`/`quantized_image`, and `generation_mode: "edit_images"` — the
  request's own `edit_images` array (which supports several images per call)
  carries through to the response even though pixelkiln always sends and
  reads exactly one. In both, the first field is the edited result and the
  quantized one an automatically color-reduced copy pixelkiln does not read.
  `inpaint-v3` is now also confirmed at the opposite end: a live 512×512
  masked inpaint (the maximum the endpoint accepts) billed exactly 40
  generations, response shape identical in structure to the 32×32 case.
  **Seven more points, bisecting from both sides, disprove the borrowed
  tiering's breakpoints entirely and tightly bracket `inpaint-v3`'s real
  20/25/40 structure**: 40×40 (1600px²), 128×128 (16384px²), and 256×256
  (65536px²) all billed **20** (the borrowed model predicts 25 for
  1600px²); 288×288 (82944px²) and 320×320 (102400px²) both billed **25**
  — the middle tier is real, just starting far higher than the borrowed
  model's 1024px²; 352×352 (123904px²) and 384×384 (147456px²) both billed
  **40**. Nine points now read 1024px²→20, 1600px²→20, 16384px²→20,
  65536px²→20, 82944px²→25, 102400px²→25, 123904px²→40, 147456px²→40,
  262144px²→40. Both breakpoints are now tightly bracketed: 20→25 sits
  somewhere in (65536px², 82944px²] — a 1.27x range — and 25→40 somewhere
  in (102400px², 123904px²] — a 1.21x range. Every point at or above
  2048px² falls into `generationCost`'s `else` branch and returns 40
  regardless: correct for 352×352, 384×384, and 512×512, but a full-tier
  overestimate for 288×288 and 320×320 (predicts 40, actually 25) — still
  safe (never bills more than predicted), just a larger miss than the
  earlier single-tier gap. `edit-images-v2` beyond its own 32×32 floor
  remains completely unmeasured.

---

## Not yet explored

Listed so the gaps are known rather than assumed away:

- `edit-images-v2` and `inpaint-v3` (the `revision` asset shape's
  `image-to-image` and `inpaint` modes; see
  [Controlled asset revisions](./REVISIONS.md)) are confirmed at their floor
  and ceiling sizes; `inpaint-v3` is further confirmed to have a real
  middle (25-generation) tier, just far above where the borrowed tiering
  places it, and bisection has tightly bracketed both real breakpoints
  (see above): 20→25 in (65536px², 82944px²] and 25→40 in
  (102400px², 123904px²]. Exactly where in either range is still
  unconfirmed, and `edit-images-v2` beyond its own floor is unmeasured
  entirely. The older
  `inpaint` and `edit-image` (non-v2/v3)
  endpoints are untouched by any of this. All four accept
  `color_image`, but given that
  `resize` accepts and ignores it, assume nothing until measured.
- `/animate-with-text-v3` and `/animate-pixminimax` — animating any loose
  image from a text description, no `character`/`objectPro` resource
  required — are now wired up as the `revision` asset shape's `animate` and
  `animate-pixminimax` modes; see
  [Animation and interpolation](./REVISIONS.md#animation-and-interpolation).
  `/interpolation-v2` ("Interpolate (Pro)", in-betweens from one keyframe to
  another) and `/edit-animation-v2` ("Edit animation (Pro)", one text edit
  across every frame of a set) are wired the same way, as the `interpolate`
  and `edit-animation` modes; see
  [Interpolate between two keyframes](./REVISIONS.md#interpolate-between-two-keyframes).
  All four are schema-only for the *request* (live OpenAPI document, not an
  observed call); the *completed job* response shape is a genuine unknown —
  no usage example exists for either endpoint at all, only the generic
  background-job one — so `pollAnimateRevision` checks several plausible
  field names defensively rather than assume one. Cost borrows `character`'s
  own measured v3-loop formula as a placeholder, for the same reason
  `objectPro` borrowed `character` pro-flash's; `interpolate` and
  `edit-animation` borrow the 20/25/40 Pro canvas tiers instead, since
  neither schema carries a usage example.
- `/generate-font-pro` (+ `GET /generate-font-pro/{job_id}`) — an 80-glyph
  atlas PNG plus a `.ttf` from a style description, `weight`
  (`Bold`/`Regular`), and `glyph_px` (8/16/32/64). Documented at 25
  generations, unmeasured. Wired up as `pixelkiln font`, outside the
  manifest; see [the CLI reference](./CLI.md#font).
- Everything else PixelLab's own tutorials demonstrate that this file has no
  entry for at all — "animation to animation" motion transfer,
  skeleton-animation's rig/template-style controls, Object Creator, and Map
  Workshop scene composition — is cataloged with tutorial citations in
  [references/pixellab-roadmap.md](../skills/pixelkiln/references/pixellab-roadmap.md)
  rather than duplicated here, since none of it has been measured either.
  UI-kit generation is covered above (`create-ui-asset` is now wrapped as the
  `uiAsset` generator; cost confirmed live at one data point, 20 generations
  for a 256x192 canvas).
- `image-to-pixelart-pro` takes only `image` + `description`, no size fields.
  The non-Pro version is characterised above.
- the tileset family, with schema documented above and costs unmeasured
  (the standalone isometric tile endpoint alongside it now has one real
  measured data point — see above)
- `generate-font-pro`, job-based, with a response shape not in the simple
  `{usage, image}` form (wrapped by `pixelkiln font`, but its cost is not
  yet measured)
- the character family beyond what the `character` generator uses: lip-sync,
  skeleton animation, `portrait_to_character` (a full character from a bust),
  and `source_image_id` on Pro Flash. The four creation engines, states,
  `animate-character`, portraits, and outfit transfer are covered in full; see
  the September 2026 measurements below.

## Characters, measured

- Standard bases draw on a canvas 28px larger than `image_size` (64 → 92,
  104 → 132). A `directions` reference is placed on it as is, centred, pixel
  for pixel.
- Pro Flash returns exactly the requested canvas, and refuses a `style_image`
  larger than it ("Style image must fit the native canvas"). Its
  `/pro-flash/cost` answer for `operation=character` was `image` 5 up to 96px,
  6 from 100 to 208px, 9 at 224px and above, plus `rotations` equal to v3's
  `ceil(side² × 8 / 65536)` on the padded square canvas; two live jobs (7 and
  2) billed exactly the estimate. `first_frame` bills the rotations only.
- A 64px `create-character-state` moved the balance by about 22 against the
  20 to 40 tier documented; other jobs were running on the account, so it is a
  rough number.
- `animate-character` with `custom_start_frame` and `end_frame` may return
  frames taller than the rotation (92 × 104 for a crouch). `enhance_prompt`
  writes the expanded text into the animation's `animation_type`. A v3 text
  loop on a 96px pro-flash base came back at 108 × 108.
- Template loops need a skeleton template. On a pro-flash base with
  `template_id: custom` a `walking-8-frames` job failed upstream at once; on
  a round robot fitted to `mannequin` the same template returned a different,
  humanoid character standing nearly still. A v3 text loop ("walking forward
  in place, short legs stepping") kept the robot and walked. For anything
  that is not a biped or one of the four quadrupeds, animate from text.
- Request validation is strict: an unknown body field is a 422 listing every
  problem at once, which is a free way to check a body's shape.
- **`portrait-character-pro`** (`direction: character_to_portrait`, a full-body
  sprite in, a bust out) is job-based: `POST` returns `background_job_id`,
  `GET /portrait-character-pro/{job_id}` answers 423 while drawing and, once
  `status: "completed"`, a `download_url` (its own `usage` is always `null`;
  read the billed amount from `GET /background-jobs/{background_job_id}`
  instead, same as every other job here). Not the couple-generations
  "conversion" the name suggests: the smallest `result_size` (16px) billed
  **20 generations**, the same order of magnitude as a state or `1dir`.
  `POST /characters/{id}/portrait` (attaching a portrait image to a character
  record) is a separate, synchronous, **free** call (`usage.generations: 0`);
  its response is the only place the stored portrait's URL appears; the
  character's own `GET /characters/{id}` never gains a portrait field, so
  PixelKiln has to remember the URL itself. `character_to_portrait` and
  `SetPortrait` are two independent calls with no automatic link between them.
- **`transfer-outfit-v2`** (a reference outfit image plus 2–16 existing
  frames back wearing it) is job-based the same way, polled through
  `GET /background-jobs/{id}` only (no dedicated status endpoint). A 2-frame,
  92×92 job billed **20 generations** — again a real generation cost, not a
  cheap frame edit. The completed job returns the result frames inline as
  base64 in `last_response.quantized_images`, not as storage URLs like every
  other multi-frame result here.

---

## Reproducing these numbers

```bash
curl -s -H "Authorization: Bearer $PIXELLAB_API_KEY" \
  https://api.pixellab.ai/v2/balance
```

The count lives at **`subscription.generations`**, not at the top level. A
probe reading `.generations` gets `undefined` and silently reports every cost as
`NaN` rather than failing:

```jsonc
{ "credits":      { "type": "usd", "usd": 0.0 },
  "subscription": { "type": "generations", "status": "active",
                    "plan": "Tier 2: Pixel Artisan",
                    "generations": 1281.0, "total": 5000.0 } }
```

Take a balance reading, make one call, wait a few seconds, read again. Prefer
the response's `usage` field where present. It is inline, exact, and immune to
the billing lag.
