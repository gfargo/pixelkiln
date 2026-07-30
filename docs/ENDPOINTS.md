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

- `image-to-pixelart` / `-pro` — convert an existing image to pixel art
- `inpaint`, `inpaint-v3`, `edit-image`, `edit-images-v2` — targeted edits
- `remove-background`, `resize`, `rotate` — utilities, all synchronous
- `create-tileset`, `create-tileset-sidescroller`, `create-isometric-tile`,
  `create-tiles-pro` — tiles; all accept palette and style references
- `create-ui-asset`, `generate-font-pro` — UI panels and fonts
- the character family — out of pixelkiln's scope by design

---

## Reproducing these numbers

```bash
curl -s -H "Authorization: Bearer $PIXELLAB_API_KEY" \
  https://api.pixellab.ai/v2/balance
```

Take a balance reading, make one call, wait a few seconds, read again. Prefer
the response's `usage` field where present.
