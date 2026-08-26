# PixelLab API — measured reference

Every cost here was **measured against a live Tier 2 account**, not read from
documentation. Where a figure came from docs rather than a meter, it says so.

Source of truth for shapes: `https://api.pixellab.ai/v2/openapi.json`
(79 paths, 56 of them POST). A concise index lives at `GET /v2/llms.txt`.

Auth is one long-term key for everything: `Authorization: Bearer $PIXELLAB_API_KEY`.

---

## The API surface

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

## Single-image generators — measured

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

### What the measurements actually showed

**`pixflux` is the workhorse.** 1 generation, returns the PNG inline, and its
`color_image` parameter is a genuine constraint. A two-colour palette produced
130 badges containing **only** `#000000` and `#ffffff` — verified 65/65 in each
of two sets. Prose asking for the same thing gave a yellow star and a brown
chocolate bar.

**`bitforge` disappoints.** It is the only single-image endpoint with palette
*and* style reference *and* synchronous delivery, all for 1 generation — which
should make it ideal. In practice it returned unrecognisable blobs for a simple
"blacksmith anvil" prompt at `style_strength` 0, 10, 25 and 50. The first
failure looked like the style reference overwhelming the prompt; sweeping the
strength proved otherwise. Possibly tuned for a different kind of subject (docs
call it "Create S-M image", max area 200×200). **Do not reach for it on this
evidence alone.**

**`pixen` gave the best unconstrained detail** of anything at 1 generation — a
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

## Post-processing utilities — measured

Five endpoints take an image in and give one back. All are **synchronous**, all
return `{usage, image}` inline, and all cost **1 generation** — including the
ones that sound like pure image manipulation.

| Endpoint | Cost | Palette survives? | What it actually does |
|---|---|---|---|
| `remove-background` | 1 | **yes** | Genuine cleanup — the only safe one |
| `rotate` | 1 | no | Re-renders from a new angle |
| `resize` | 1 | no | **Re-generates**, does not resample |
| `image-to-pixelart` | 1 | no | Destroys alpha too |
| `inpaint` / `edit-image` | 1 | untested | Targeted edits |

Measured on one 64×64 riso badge with an exact 4-colour palette
(`#f4ecd8 #1c1a17 #c1553a #6b7f5e`, 57% transparent):

| | colours out | transparency | result |
|---|---|---|---|
| source | 4 | 0.57 | — |
| `remove-background` | **3** | 0.60 | dropped a stray fringe, kept the rest |
| `rotate` | 30 | 0.58 | anti-aliased new angle |
| `resize` → 32px | 38 | 0.57 | cream+rust came back **gold** |
| `image-to-pixelart` → 32px | **455** | **0.00** | opaque grey background |

**`remove-background` is a de-fringe pass, not just a matte.** It removed the
scattered sage-green speckles around the badge outline and left the three real
inks untouched — colour count went *down*, transparency went *up*. It is the one
utility safe to run on palette-locked art.

**`resize` is generative, not a resampler.** The name is misleading: it takes a
`description` as a *required* field, and it re-renders. A 4-colour cream-and-rust
badge came back as 38 colours of gold.

**`color_image` does not rescue it.** `resize` accepts the parameter in its
schema; passing the exact same swatch that `pixflux` honours changed nothing —
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

## Tilesets — schema only, not yet measured

Called out separately because these are the most capable endpoints for level art
and they are relevant to the disc-golf game. **Costs below are unmeasured.**

`POST /tilesets` (top-down) and `/tilesets-sidescroller` are the current
versions; `/create-tileset*` are the older aliases with identical schemas.

They take `lower_description` + `upper_description` (+ optional
`transition_description`) — you describe two terrains and the transition between
them, and get a tileset that blends them. Distinctively, they accept **both**
`color_image` *and* per-layer reference images (`lower_reference_image`,
`upper_reference_image`, `transition_reference_image`) — the only family that
combines palette forcing with style anchoring.

Useful knobs: `tile_size`, `tileset_adherence` / `tileset_adherence_freedom`
(how strictly tiles must fit together), `raggedness` and `slope_size` for edge
character, plus the usual `outline` / `shading` / `detail`.

`create-tiles-pro` is a different shape — a single `description` plus
`style_images`, `tile_view`, `building_*` fields for structures.

Its `style_images` is a **fourth** convention, and not the one two lines up:
`TilesProStyleImage` is flat, with all three fields required.

```jsonc
// create-tiles-pro
{ "style_images": [ { "base64": "...", "width": 32, "height": 32 } ] }
```

Sending `generate-with-style-v2`'s nested `{image: {...}}` here is rejected as
an extra field. Passing style images at all makes the endpoint ignore
`tile_type` and `tile_view` and copy the reference's tile geometry instead —
which is the only way to land new art on an existing sheet's ground plane.

`GET /tiles-pro/{id}` carries no `status` field. It answers **423 while the set
is still drawing** and 200 with `storage_urls` when it is done, so the HTTP code
is the status. Cost is reported at submit time and lands on the same 20/25/40
canvas tiers as `1dir`, but the canvas is tile size x variation count, not one
sprite — a small tile in a large set still reaches the top tier.

`outline_mode` defaults to `outline`, which draws a dark border around every
tile. For ground tiles that is wrong: laid on a grid the borders read as
quilting, with a seam at every cell edge. `segmentation` omits them and the
same set tiles seamlessly — measured on a fairway-to-rough terrain set, where
it was the difference between usable and unusable.

`tile_feature` and `style_images` are **mutually exclusive** — "Connectable
features (roads/tileset/building) cannot be combined with style tiles". So the
geometry-anchoring trick above is unavailable for a connectable set, and its
tiles land on whatever ground plane the view angle implies (measured: 32x24
with the diamond midline at y=7, against a 32x32 sheet wanting y=15).

`tile_feature` turns it from independent variations into a connectable set:
`roads` (18-configuration path set), `tileset` (16-tile Wang corner set for a
terrain transition — describe it as the transition, not one terrain), and
`building` (floor/wall/doorway kit). These are sliced by index, so the returned
order is load-bearing. They are structural multi-output results, not candidates
to choose between: PixelKiln persists every URL in numeric order and labels the
downloaded outputs `tile-00`, `tile-01`, … .

Given that `color_image` is honoured on `pixflux` but silently ignored on
`resize`, **verify the palette actually holds on a single tileset before
committing to a set**.

---

## Recipes

**Lock a palette.** Use `pixflux` with a `color_image` swatch. Build the swatch
with `paletteSwatch()` — 64×64 blocks, one band per colour. It is a real
constraint, not a hint: 130 badges across two sets came back containing *only*
the requested colours.

**Re-roll one bad asset.** 1 generation. `gen --only <id> --force`. Cheaper than
asking for more candidates — a `1dir` call that yields 16 candidates costs 20–40.

**Clean up fringing.** `remove-background` at 1 generation, and it will not
disturb the palette.

**Change the size of an existing asset.** Regenerate with `pixflux` at the new
size. Do not use `resize`.

**Anchor to an existing look rather than a palette.** `generate-with-style-v2`
(20) or `generate-image-v2` (40). `bitforge` claims to do this for 1, but see
above. `map` has no style anchoring at all — a 1-bit set generated through it
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
derived from size — it cannot be requested:

| size | candidates |
|---|---|
| ≤42 | 64 |
| ≤85 | 16 |
| ≤170 | 4 |
| >170 | 1 |

Cost is per call, so the candidates are free. Counterintuitively, generating
*smaller* yields *more* candidates for *less*. But "pick from 16" is poor value
once a 1-generation re-roll exists: forty re-rolls cost one `1dir` call.

---

## Object lifecycle

- `1dir` and `8dir` objects **persist** with stable public URLs.
- `map-objects` job records are documented to auto-delete after 8 hours. The
  **image survives**: a March 2026 sprite still resolved from `/v2/objects` four
  months on while `/v2/map-objects/{id}` returned 404. pixelkiln's `poll` checks
  the objects collection on a 404 rather than writing the work off.
- `pixflux`/`pixen`/`bitforge` results are **not account objects** at all —
  bytes come back inline and are never listed. `adopt` and `salvage` cannot see
  them, and they cannot be tagged.

---

## Limits and billing

- **Submissions must be >2s apart.** Concurrent background jobs: Tier 1 = 8,
  Tier 2 = 10, Tier 3 = 20.
- **Failed generations are not billed.** Two failed forced-palette attempts moved
  the balance by zero, so probing an unfamiliar parameter is free.
- **Billing lags slightly.** A bitforge call read as cost 0 immediately after and
  1 a few seconds later. Trust the `usage` field in the response over an
  immediate balance diff.
- `usage` is returned inline by the synchronous endpoints:
  `{"type":"generations","generations":1}`.

---

## Not yet explored

Listed so the gaps are known rather than assumed away:

- `inpaint`, `inpaint-v3`, `edit-image`, `edit-images-v2` — targeted edits.
  Both `inpaint` and `edit-image` accept `color_image`, but given that `resize`
  accepts and ignores it, assume nothing until measured.
- `image-to-pixelart-pro` — takes only `image` + `description`, no size fields.
  The non-Pro version is characterised above.
- the tileset family — schema documented above, costs unmeasured
- `create-isometric-tile`, `create-ui-asset`, `generate-font-pro` — job-based,
  response shapes not in the simple `{usage, image}` form
- the character family (23 paths) — out of pixelkiln's scope by design

---

## Reproducing these numbers

```bash
curl -s -H "Authorization: Bearer $PIXELLAB_API_KEY" \
  https://api.pixellab.ai/v2/balance
```

The count lives at **`subscription.generations`**, not at the top level — a
probe reading `.generations` gets `undefined` and silently reports every cost as
`NaN` rather than failing:

```jsonc
{ "credits":      { "type": "usd", "usd": 0.0 },
  "subscription": { "type": "generations", "status": "active",
                    "plan": "Tier 2: Pixel Artisan",
                    "generations": 1281.0, "total": 5000.0 } }
```

Take a balance reading, make one call, wait a few seconds, read again. Prefer
the response's `usage` field where present — it is inline, exact, and immune to
the billing lag.
