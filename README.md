# pixelkiln

![Pixelkiln](https://wp.griffen.codes/wp-content/uploads/2026/08/download.png)

Manifest-driven bulk pixel art generation against the PixelLab API.

The point of this tool is that **no LLM is in the loop**. PixelLab exposes a
plain REST API, so generation, polling, downloading and filing are ordinary
scripted mechanics. The only step that needs human judgement is choosing among
candidates, and that happens in a contact sheet you scan in seconds.

## Why

Driving PixelLab conversationally costs far more than the art does. A prior
65-badge set consumed 350 account objects generated one at a time, each with a
bespoke prompt, and left no record of which object produced which file. That is
the failure this tool is built around:

- **Generation is cheap; supervision was expensive.** One call returns many
  candidates at a fixed price, so the economical move is to generate broadly and
  pick quickly.
- **Nothing tracked provenance.** Objects and files were two unrelated piles.
  The lockfile is the missing mapping.
- **No style contract existed.** 65 hand-written prompts drift. A style block
  plus reference images makes the look reproducible.

## Install

The first npm publication is tracked in [issue #1](https://github.com/gfargo/pixelkiln/issues/1).
Until that release is live, run pixelkiln from a repository checkout:

```bash
npm ci
npm run pixelkiln -- help
npm test
```

The checkout command uses the TypeScript source directly. `npm run build`
creates the distributable `dist/` files used by `node bin/pixelkiln.js` and the
published package. Requires Node 20+.

## Five-minute start

1. Copy [`examples/minimal/pixelkiln.manifest.json`](./examples/minimal/pixelkiln.manifest.json)
   into a project as `pixelkiln.manifest.json` and adjust its prompts/output
   directory.
2. Put `PIXELLAB_API_KEY=...` in `.env.local` beside the manifest and add that
   file to the project's `.gitignore`.
3. Preview the exact work and cost, then generate with the same budget as a
   hard ceiling:

```bash
npm run pixelkiln -- plan
npm run pixelkiln -- doctor
npm run pixelkiln -- gen --budget 120
```

`gen` submits work, waits, opens the local candidate-review sheet, downloads
your choices, and updates `pixelkiln.lock.json`. Commit the manifest, lockfile,
and generated art; do not commit `.env.local` or `.pixelkiln/`.

For an existing art tree, start with `pixelkiln init --from <dir>` instead.
The complete first-project and recovery flows are in
[`docs/GETTING_STARTED.md`](./docs/GETTING_STARTED.md).

## Project state

**`pixelkiln.manifest.json`** — hand-authored, committed. Your asset dictionary.

```jsonc
{
  "name": "my-game",
  "styles": {
    "default": {
      "generator": "1dir",          // "1dir" = square, persistent, multi-candidate
      "size": 64,                    // "map"  = arbitrary w/h, single result, 8h TTL
      "promptPrefix": "Premium indie-game achievement icon for X: one centered",
      "promptSuffix": "bold dark outline, isolated subject, transparent background",
      "styleImages": [{ "path": "art/ref-01.png" }],
      "outDir": "public/badges",
      "tags": ["my-game"]
    }
  },
  "assets": {
    "first_review": {
      "prompt": "a speech bubble with a single glowing star inside",
      "category": "milestones"
    }
  }
}
```

**`pixelkiln.lock.json`** — machine-written, committed. Maps every
`<style>/<asset>` to the PixelLab object that satisfies it and the file it
produced, with hashes on both sides.

Two ignored caches make recovery and account reconciliation faster without
becoming project history:

- **`.pixelkiln/cache/`** stores generated PNG bytes by SHA-256. `restore` can
  recover a deleted output from here even after a provider URL expires.
- **`pixelkiln.cache.json`** stores remote object ids mapped to their image
  hashes. `adopt` and `salvage` use it to avoid downloading the entire account
  again. Deleting either cache is safe; the next relevant command rebuilds it.

Inspect both caches offline with `pixelkiln cache`; use `cache --check` as an
integrity gate and `cache --prune` to remove corrupt/partial content files,
content no lock entry references, and malformed object-hash entries. The
account-wide cache is only pruned for deleted remote object ids during
`adopt`, after pixelkiln has seen the provider's complete live object list.

Because entries are keyed `<style>/<asset>`, **a style is a namespace**. Adding
a second style re-derives the whole asset set into a separate output directory
under separate lock keys, so restyling a collection cannot clobber the original.

## Onboarding a project that already has art

You do not have to author a manifest by hand. Point `init` at the existing tree,
then let `adopt` recover the prompts that actually produced the art:

```bash
pixelkiln init --from assets/sprites --exclude characters,gifs --generator map
pixelkiln adopt --write-prompts
```

`init` writes a manifest with **empty prompts on purpose** — for art that already
exists the accurate prompt is the one used upstream, not a plausible-looking
reconstruction. `adopt` matches local files to account objects by exact SHA-256
and backfills the real ones.

Measured on a 111-asset Godot project: **98 adopted with prompts recovered, 13
not matched.** All 13 had been retouched locally after download (11 of the 13
appear in a later commit, against 5 of 40 sampled matches), so their bytes no
longer match anything upstream. Those report as `untracked` — the art is fine,
only its provenance is unknown — and are **not** billed for regeneration.

## Architecture

Two seams, and it matters which is which:

```
manifest + lockfile + plan + salvage + contact sheets   ← backend-agnostic
─────────────────── Provider interface ───────────────────
PixelLabProvider          (future: RetroDiffusionProvider, …)
```

Everything that knows a URL shape or an auth header lives below the line;
everything above is provider-agnostic. `FakeProvider` implements the same
interface in memory, which is how the money-spending stages are tested without
a network or an API key.

Provider HTTP responses are validated at runtime before they reach the state
machine. A successful HTTP status with a missing object id, malformed storage
URL map, or changed field type fails as an explicit schema error instead of
being cast into the lockfile and discovered later as corrupted state.

**Cost carries a unit.** `generations` (PixelLab subscription), `usd`
(per-image providers), or `free` (local models). `plan` prints the unit, and
`--budget` is interpreted in it — so a per-image price can never be silently
read as a subscription quota. Provider estimates are runtime-validated before
they can influence a budget. After submission, the CLI rechecks the provider
balance and reports its observed change separately from the estimate.

**Candidate count is a provider property**, not a universal truth. PixelLab's
`1dir` returns up to 64 for one fixed price; a per-image provider returns one
and charges N times for N. The "generate small, pick from many" strategy only
pays off where `estimate().candidates > 1` at no extra cost.

**Optional members are real capability gaps.** A provider with no queryable
asset list has no `adopt` and no `salvage`, and the CLI says so rather than
failing obscurely.

### Lockfile

Version 2. Each entry records `outputs[]` — a path, a hash, and an optional
`role` — rather than v1's single file. That is what lets one manifest entry
expand into many artifacts, which an animated character needs (~35 spritesheets
plus an engine resource plus a portrait).

Provider-specific structural metadata is retained under `providerMetadata`,
namespaced by provider id. PixelLab connectable sets preserve the response's
tile kind and complete `tile_rules` object there; those rules are what let an
exporter turn ordered PNGs into an adjacency-aware engine tileset instead of
guessing what each index means.

Each successful submission also records `cost` and `costUnit`. `status` keeps
generation quota, fractional USD, and free-provider accounting separate; it
never adds unlike units into a plausible-looking total. Pre-unit v2 lockfiles
default to PixelLab's `generations` and remain readable.

`parseLock` accepts v2 only. The projects using pixelkiln were onboarded after
v2 landed, so a v1 file indicates a hand edit or the wrong file rather than a
legacy project to migrate. It fails loudly instead of reinterpreting a paid-work
record and risking an incorrect regeneration plan.

Writes are atomic and coordinated across processes. A short-lived advisory
writer lock prevents two CLI invocations from renaming over one another, while
field-level dirty patches merge changes made from separate snapshots. Two
commands updating different assets—or different fields of the same asset—no
longer lose whichever write happened first. A stale writer lock is recoverable
after its safety window rather than blocking the project permanently.

## Salvaging unclaimed work

An account accumulates objects that were generated, paid for, and never landed
in a repo. On the account this was built against: **190 of 361 objects were
unclaimed**, and a visual sample showed character portraits, ~30 tree variants,
fence styles, terrain tiles, and UI icons — usable art, not rejects.

`salvage` is a recovery tool, not a cleanup tool:

```bash
pixelkiln salvage --claims ../other-project/pixelkiln.lock.json --dry-run
pixelkiln salvage --claims ../other-project/pixelkiln.lock.json
```

A manifest with more than one style opens **one contact sheet per style**,
one at a time, rather than a single mixed session — each orphan is matched
against every style's `promptPrefix`/`promptSuffix` first, so a session only
ever offers the one destination its items actually look like they belong to.
Objects that match no style in this manifest (likely a different project's
art, on a shared account) are listed separately and left out of every
session; `--style <id>` bypasses grouping and forces one session across
everything, same as before grouping existed. Each tab's title and header
name the style it's scoped to and where an import will land, so several
left open at once are still tellable apart.

A single-style manifest has no pattern of its own to check against, so by
default it still claims everything, same as always — but every `--claims`
lockfile's sibling manifest (same directory, by convention) is loaded
too, purely to recognise ITS styles: an orphan matching a sibling's pattern
is excluded here even though this project would otherwise have swallowed it
by default. This is what lets a single-style project on a shared account
still say "these aren't mine" instead of showing everything.

Each card gets one of three verdicts (hover + `i` / `k` / `d`):

| Verdict | Effect |
|---|---|
| **import** | Downloads it, adds a manifest asset and a lock entry with the recovered prompt. It becomes a fully tracked asset. |
| **keep** | Tags it `pixelkiln:keep` upstream. Nothing local changes. |
| **discard** | Tags it `pixelkiln:discard`. **Does not delete.** |

`--dry-run` prints the same per-style breakdown plus the first 30 unclaimed
objects; add `--all` to list every one, or `--json` to print the full list as
JSON on stdout with everything else on stderr, for scripting:

```bash
pixelkiln salvage --claims a.json --dry-run --json | jq '. | length'
```

Deleting is a separate command that has to be asked for by name, lists what it
will remove, and refuses to run non-interactively without `--yes`:

```bash
pixelkiln purge --dry-run
pixelkiln purge
```

> **Pass every lockfile via `--claims`.** One account is shared across projects,
> so an incomplete claim set makes another project's shipped art look
> unclaimed. `salvage` prints the claim set it used and warns when only one
> lockfile was consulted. Missing `--claims` paths are a hard error, not a
> silent skip.

Imported assets land under `_salvaged/` with ids derived from their prompts.
Those ids are a starting point — rename them.

## Commands

```bash
pixelkiln init --from <dir>       # scaffold a manifest from existing PNGs
pixelkiln plan                    # diff manifest vs lock vs disk. Costs nothing.
pixelkiln plan --check --json     # CI contract: machine output + nonzero when not current
pixelkiln doctor                  # check config, recovery paths, outputs, and provider access
pixelkiln doctor --dry-run        # run every local check without provider access
pixelkiln gen                     # submit → poll → pick → fetch
pixelkiln restore                 # restore missing outputs without generating again
pixelkiln gen --only first_review --force   # regenerate exactly one asset
pixelkiln gen --style neon --budget 800     # a whole variant set, capped
pixelkiln adopt --write-prompts   # map account objects to files, recover prompts
pixelkiln accept                  # keep existing art after rewording a style
pixelkiln audit --style neon      # measure style consistency, offline
pixelkiln cache --check           # verify both local caches, offline
pixelkiln cache --prune           # remove invalid and unreferenced cache data
pixelkiln pack --style neon       # composite a style's sprites into one sheet, offline
pixelkiln export --style ground --only terrain --format tiled  # engine-ready tileset
pixelkiln salvage --claims a.json # triage objects no lockfile claims
pixelkiln balance                 # provider balance and cost unit
```

`plan` is the habit worth forming — it is free, and it prints exactly what a run
would cost before anything is spent.

Generation and download failures are separate lock states. A CDN/network error
after successful generation is `download-failed`, costs zero in the next plan,
and is retried by `fetch`. `restore` additionally repairs generated outputs that
have gone missing from disk. It never overwrites an output whose bytes differ
from the recorded hash. Successful downloads are cached by SHA-256 under
`.pixelkiln/cache/`, so `restore` still works after a temporary provider URL has
expired or while API credentials are unavailable; the cache is local and
ignored by Git. `submit`, `poll`, `fetch`, and `gen` exit nonzero on
partial failure or timeout, so build automation cannot mistake an incomplete
run for success. `plan` and `status` support `--json`; plan JSON includes
`costUnit`, and status JSON reports `spendByUnit`. `plan --check` exits nonzero
unless every selected asset is current.

`doctor` checks the parsed manifest and style references, lockfile recovery
sources, output ownership and writability, stale map jobs, current plan state,
API-key configuration, and live provider connectivity. It changes nothing,
supports `--json`, and exits nonzero for unsafe state. Use `--dry-run` when an
offline environment should skip only the live provider check.

### Auditing art in CI

`audit` measures palette distance, transparency, and opaque colour count for
every generated output. Human-readable output is useful during art review;
`--json --check` turns the same measurements into a stable automation gate:

```bash
pixelkiln audit --style neon --json
pixelkiln audit --style neon --check \
  --max-distance 35 --min-transparency 0.10 --max-colors 128
```

By default, an asset more than 1.5 standard deviations from its style is a
violation; change that relative cutoff with `--sigma`. The absolute flags add
project-specific limits. Missing or unreadable outputs are always unsafe, and
`--check` exits nonzero when any selected style is unsafe. Structural output
sets are measured member-by-member with stable ids such as
`terrain/tile-03`, so a bad tile cannot hide behind the set's average.
Audits accept non-interlaced greyscale, indexed, RGB, greyscale-alpha, and RGBA
PNGs at their standard bit depths; each is normalized to RGBA before measuring.

### Making a variant set

Add a style; keep the assets. Every asset re-derives under the new style.

```jsonc
"styles": {
  "heybud-premium": { "...": "..." },
  "heybud-neon": {
    "generator": "1dir", "size": 64,
    "promptPrefix": "Neon-noir achievement icon: one centered",
    "promptSuffix": "hot magenta and cyan rim light on near-black, bold outline, transparent background",
    "styleImages": [{ "path": "art/neon-ref.png" }],
    "outDir": "public/badges/variants/neon"
  }
}
```

```bash
pixelkiln gen --style heybud-neon
```

**Seed the style with reference images, not just prose.** Measured on a real
8-asset restyle: prose alone carried the new style cleanly on subjects with no
strong inherent colour (a speech bubble, a compass, flames, an eye) but was
largely ignored on subjects that do have one — a chocolate bar stayed brown, a
camera stayed grey. The reliable recipe is two passes:

1. Generate two or three assets with prose only.
2. Pick the best results, save them under `art/style-refs/<style>/`, and list
   them in the style's `styleImages`.
3. Generate the rest.

Keep reference images in their own directory rather than pointing at live asset
files — a style reference is part of the spec hash, so editing a badge that
doubles as a reference invalidates every asset in that style.

## Economics — pick the right generator first

This is the single biggest cost decision, and the gap is 40x. All figures
measured against a live account, not inferred from docs.

| Generator | Cost | Candidates | Shape | Async? |
|---|---|---|---|---|
| **`map`** (default) | **1**, any size | 1 | arbitrary W×H | job + poll |
| `1dir` | 20–40 by canvas tier | 4–64 | square only | job + poll |

**`map` is the default and usually correct.** `POST /map-objects` exists for
standalone props with transparent backgrounds — which is what an icon, a badge
or a prop is. A flat 1 generation regardless of size.

**`1dir` is the single-facing sibling of `create-8-direction-object`**, meant
for objects you may later want rotations or animations of. Its price is by
canvas area: ≤1024 px = 20, ≤2048 px = 25, larger = 40. A 64×64 icon therefore
costs 40.

### The candidates are free, and that is the trap

`1dir` returns multiple candidates for its one fixed price, derived from size —
you cannot ask for fewer to pay less:

| size | candidates |
|---|---|
| ≤42 | 64 |
| ≤85 | 16 |
| ≤170 | 4 |
| >170 | 1 |

So the candidates are not the expense; the generator is. Generating *smaller*
gives you *more* candidates for *less* money, which is counterintuitive but true.

And the value of "pick from 16" collapses once you notice that **forty re-rolls
of a map object cost the same as one `1dir` call**. Unless you specifically want
to compare options side by side, re-rolling is the cheaper loop.

```
65 icons via map    →     65 generations
65 icons via 1dir   →  2,600 generations
```

Reach for `1dir` when you need rotations or animation, or when the extra
rendering detail is genuinely worth 40x. Otherwise use `map`.

### Nothing here is chosen by an LLM

Candidate selection is a palette-distance calculation — RGB arithmetic against
the style's reference images. Deterministic, no model, no inference cost. The
contact sheet exists so a human can override it, not so a model can decide.

### Limits

Submissions must be **>2s apart**, and concurrent background jobs are capped by
tier (1: 8, 2: 10, 3: 20). `submit` enforces both — a global spacing gate plus
real in-flight tracking, rather than parallel workers that would quietly breach
the rate limit.

### `pixflux` — forced palettes

A third generator, and the right one for any style built on a fixed palette.

```jsonc
"styles": {
  "gameboy": {
    "generator": "pixflux",
    "palette": ["#0f380f", "#306230", "#8bac0f", "#9bbc0f"],
    "outDir": "public/badges/variants/gameboy"
  }
}
```

`POST /create-image-pixflux` costs **1 generation**, returns the PNG **inline
with no polling**, and accepts `color_image` — a palette swatch that constrains
output to exactly those colours.

The difference from prose is categorical. A prompt asking for "strict black and
white, no colour" produced a yellow star and a brown chocolate bar. The same
subjects with a two-colour forced palette came back containing exactly
`#000000` and `#ffffff` and nothing else. A prompt is a request; this is a
constraint.

Trade-offs:

- Rendering is **flatter** than `1dir`'s. For a tightly-constrained palette that
  hardly matters; for a rich style it does.
- No `style_images`, so the reference-image technique is unavailable. The
  palette does that job instead.
- The forced palette is **pixflux-only** — the same `color_image` parameter on
  `/map-objects` returns a 500 whatever the payload shape.
- Being synchronous, results are cached under the system temp directory between
  `submit` and `fetch`. If the temp directory is cleared in between, `poll`
  reports it plainly and the asset needs re-submitting. Within one `gen` run
  this never arises.

### Choosing a generator

Measured costs, not documented ones. Full detail in
[docs/ENDPOINTS.md](./docs/ENDPOINTS.md).

| You want | Use | Cost |
|---|---|---|
| A fixed palette held exactly across a set | **`pixflux`** + `palette` | 1 |
| Standalone props, style carried by the prompt | **`map`** | 1 |
| Rotations, animation, or candidate variety | `1dir` | 20–40 |
| Ground tiles, or a connectable tile set | `tiles` | 20–40 |

Two cautions learned the expensive way:

**`map` has no style anchoring at all** — no `style_images`, and it treats
palette prose as a suggestion. Switching a tightly-styled set from `1dir` to
`map` to save generations dropped 1-bit's palette conformance from a median
distance of 6.6 to 41.9, with 35 of 65 badges off-palette. Cheap is only cheap
if the output is usable.

**`bitforge` looks ideal and is not.** It is the only single-image endpoint with
palette *and* style reference *and* synchronous delivery for 1 generation, but
it returned unrecognisable blobs for a plain "blacksmith anvil" at every
`style_strength` from 0 to 50. Measured, not assumed.

Also worth knowing: `pixen` gives the best unconstrained detail at 1 generation
but has no palette parameter, and the Pro endpoints (`generate-with-style-v2` at
20, `generate-image-v2` at 40) do genuine style transfer from labelled reference
images when that is worth the price.

### `pixflux` and backgrounds

`no_background` defaults to **false** on the API. pixelkiln sends `true`,
because the sprites it was built for want their background stripped — a prop
or an icon should sit on whatever is behind it.

That is wrong for anything that *is* a scene: a cover banner, a splash, a
backdrop. Set `noBackground: false` on the style and the image comes back
full-bleed.

```jsonc
"styles": {
  "covers": {
    "generator": "pixflux",
    "noBackground": false,
    "outDir": "assets/sprites/courses"
  }
}
```

Worth knowing because prose does not override it: a prompt asking for an
"opaque background" still comes back as a subject floating in a mostly-empty
frame, since the background is removed after generation rather than never
drawn. Measured on a set of six 192x96 cover banners, five of which filled
25-56% of their canvas.

### `tiles` — ground tiles and connectable sets

`POST /create-tiles-pro` draws tile shape outlines and fills them. One call
returns many variations, so it lands in the same review-then-pick flow as
`1dir` — but the variations arrive as finished storage URLs, and there is no
select-frames step to promote one.

```jsonc
"styles": {
  "ground": {
    "generator": "tiles",
    "tileSize": 32,
    "tileType": "isometric",     // hex | hex_pointy | isometric | oblique
    "tileView": "low top-down",  // octagon | square_topdown
    "outDir": "assets/tiles/src"
  }
}
```

Two things make it worth reaching for over `1dir` with a tile-shaped prompt:

**Style mode overrides geometry.** Give the style a `styleImages` reference and
the API copies the tile's shape and dimensions from it, ignoring `tileType` and
`tileView` entirely. For new art that has to sit in an *existing* sheet this is
the only lever that works — prompting will not move where the tile's ground
plane falls, and being a few pixels out puts every new tile on a different
plane from the ones already there.

**`tileFeature` returns a connectable set** rather than independent variations:

| `tileFeature` | Returns |
|---|---|
| `roads` | 18-configuration path/road autotile set |
| `tileset` | 16-tile Wang corner set for a terrain *transition* |
| `building` | floor / wall / doorway / pillar / staircase kit |

`tileset` is the one to know about: describe the asset as the transition
("fairway grass to rough meadow"), not as one terrain. A terrain-transition set
is what an engine's autotiling needs — without transition tiles, a terrain
solver that cannot find a matching tile for a boundary cell erases it, and the
result is a gap tracing every terrain edge.

**Set `outlineMode: "segmentation"` for ground tiles.** The API default is
`outline`, which draws a dark border around every tile — right for tiles that
read as discrete objects, wrong for ground. Laid on a grid, those borders turn
a continuous surface into visible quilting with a seam at every cell edge.
Measured on a fairway-to-rough set, this one flag decided whether the art was
usable at all.

**`tileFeature` and `styleImages` cannot be combined.** The API rejects the
pair ("Connectable features cannot be combined with style tiles"), so a
connectable set derives its own tile geometry and cannot be anchored to an
existing sheet. pixelkiln refuses this in the manifest, so `plan` reports it
for free rather than a run finding out at submit. In practice that means a
connectable set needs its alignment corrected on the way into an existing
atlas, where independent variations can be anchored up front.

A connectable set is sliced **by index**, so the order matters. It is not a list
of candidates: every returned image is required. PixelKiln sorts
`tile_0, tile_1, …` numerically, downloads the complete set, and records roles
`tile-00`, `tile-01`, … in `outputs[]`. If the manifest target is
`terrain.png`, the files are `terrain-tile-00.png`,
`terrain-tile-01.png`, and so on. Independent tile variations still use the
contact sheet and produce one selected image.

#### Exporting an engine-ready tileset

After fetching a tiles asset, `export` writes a deterministic PNG atlas and a
metadata file beside it:

```bash
pixelkiln export --style ground --only fairway_transition
pixelkiln export --style ground --only fairway_transition --format tiled
pixelkiln export --style ground --only fairway_transition --format godot
```

- `generic` (the default) writes PixelKiln's versioned `.json` contract with
  every frame, raw provider rules, normalized masks, and stamp-only markers.
- `tiled` writes a `.tsj` tileset with a Wang set for four-corner or four-edge
  masks.
- `godot` writes a Godot 4 `.tres` `TileSet` with atlas coordinates and terrain
  peering bits.

The engine formats require uniform tile dimensions. Six-edge hex masks and
outline/stamp-only kits remain available in the lossless generic format but are
rejected by Tiled/Godot export until their engine-specific semantics can be
mapped without guessing. See [Tiles and engine exports](./docs/TILES.md) for the
format contract and mask mapping.

Two API details worth knowing, both confirmed against the OpenAPI schema:

- **The style-image shape is not the one `1dir` uses.** `TilesProStyleImage` is
  flat — `{base64, width, height}`, all three required — where
  `create-1-direction-object` wants `{type, base64, format}`. Sending 1dir's
  shape is rejected as an extra field.
- **The HTTP status *is* the job status.** `GET /tiles-pro/{id}` has no
  `status` field: 423 means still drawing, 200 carries `storage_urls`. Treating
  423 as an error aborts a run that was merely early.

### Don't post-process palette-locked art

The image-in/image-out utilities all cost **1 generation** — the same as a fresh
generation — and all but one *re-render* rather than manipulate:

| Endpoint | Palette survives? |
|---|---|
| `remove-background` | **yes** — a genuine de-fringe pass |
| `rotate` | no |
| `resize` | no — it is generative, and takes a required `description` |
| `image-to-pixelart` | no, and it flattens the alpha channel too |

Resizing a 4-colour badge from 64 px to 32 px returned 38 colours, with the
cream and rust replaced by gold. Passing the exact `color_image` swatch that
`pixflux` honours changed nothing — **the forced palette is wired up on
`pixflux` and `bitforge` only**, and appearing in another endpoint's schema is
not evidence it does anything. Regenerate at the target size instead; it costs
the same and the palette holds.

## Gotchas encoded in the tool

- **`size` and `styleImages` are mutually exclusive.** When style images are
  supplied the *largest one* determines output size — so references must already
  be at the target resolution. A 128 px reference silently yields 128 px output
  and a different candidate count.
- **`select-frames` returns `created_object_ids`.** The review parent survives
  until emptied, so recording the parent id gives you a transient pointer.
- **`1dir` and `map` are priced 20-40x apart.** The default is `map`; only
  reach for `1dir` when you need rotations or animation.
- **`color_image` (forced palette) works on `create-image-pixflux`, not on
  `map-objects`.** The latter returns a 500 "cannot identify image file"
  regardless of payload shape.
- **A failed generation is not billed.** Two failed forced-palette attempts
  moved the balance by zero, so probing an unfamiliar parameter is free.
- **One account is shared across projects.** `adopt` reports unmatched remote
  objects but deliberately does not offer to bulk-delete them; run `adopt` from
  every project before deciding anything is junk.
- **Hand-edited files are detected, not clobbered.** `plan` compares the file
  hash and reports `orphaned` if you retouched a PNG by hand.

## Library use

```ts
import { PixelLabProvider, loadManifest, resolveSpecs, buildPlan, loadLock } from "pixelkiln"

const loaded = await loadManifest("pixelkiln.manifest.json")
const provider = PixelLabProvider.forOffline()
const specs = await resolveSpecs(loaded, { provider })
const plan = await buildPlan(specs, await loadLock("pixelkiln.lock.json"))
console.log(plan.cost, plan.costUnit)
```

The package also exports provider contracts, audit gates, sprite packing,
mounting, and tileset exporters. See [`docs/LIBRARY.md`](./docs/LIBRARY.md) for
the public entry points and composable workflow examples.

## Not covered

Animated 8-direction **characters** are out of scope. PixelLab models those as a
separate entity with a ZIP bundle export, and the `super-disc-golf` repo already
has a mature importer for them (`tools/sync_pixellab_characters.py`).

## Sprite sheets

`pack` composites a style's sprites into one PNG plus a JSON atlas. Offline,
free, and reads the lockfile — so it packs exactly what was generated, not
whatever happens to be sitting in the output directory.

```bash
pixelkiln pack --style heybud-riso
#   heybud-riso — 74 sprite(s), 432x432 in 9 column(s)
#     public/vibe/variants/riso/heybud-riso-sheet.png + .json
```

```jsonc
{
  "style": "heybud-riso",
  "sheet":  { "width": 432, "height": 432 },
  "cell":   { "width": 48,  "height": 48 },   // grid step
  "columns": 9,
  "frames": [
    { "id": "activity_cooking_eating", "x": 0, "y": 0, "width": 48, "height": 48 }
  ]
}
```

Frames are keyed by **asset id**, so a consumer looks a sprite up by name
rather than by a fragile index.

When an asset has multiple structural outputs, `pack` includes every one and
qualifies its frame id by role: `terrain/tile-00`, `terrain/tile-01`, and so on.
Single-output ids remain unchanged.

Four decisions worth knowing:

- **A grid, not a bin-packer.** Every sprite in a style shares a generator and
  a size, so rectangles are near-uniform and tight packing would save a few
  percent of area in exchange for an unpredictable layout. A grid also means a
  frame's position is derivable from its index, which matters when you are
  reading the sheet by eye to work out which sprite is wrong.
- **Sorted by asset id.** The sheet is byte-identical across runs, so
  committing it produces a diff only when the art actually changed.
- **The cell is the largest sprite**, not an assumed uniform size. Assets can
  override `width`/`height` individually, and assuming uniformity would
  silently clip the odd one out. Smaller sprites sit at the cell's top-left
  with their real size recorded, so a consumer that ignores the atlas and
  slices on the grid still gets a correct, if padded, sprite.
- **Common PNG inputs, RGBA output.** Greyscale, indexed, RGB,
  greyscale-alpha, and RGBA inputs are normalized without flattening. The sheet
  is always RGBA because dropping alpha would fill every transparent background
  with black and make it unusable over anything but that colour. Interlaced or
  corrupt inputs are reported in the skipped list.

A missing or unreadable file is reported and skipped rather than aborting the
sheet — one bad asset should not cost you the other seventy-three.

`--columns <n>` overrides the near-square default.

For structural multi-output assets, narrow a sheet to one or more output roles,
or request only assets with an unambiguous single/primary output:

```bash
pixelkiln pack --style ground --output-role tile-00 --output-role tile-01
pixelkiln pack --style mixed --primary-only
```

`--output-role` is repeatable (and accepts comma-separated values).
`--primary-only` deliberately skips ambiguous structural sets; the two modes
are mutually exclusive so a filter is never silently ignored.

### Mounting into an existing sheet

`pack` derives position from index and sorts by asset id, so the sheet is
byte-stable — excellent when pixelkiln owns the whole sheet, and fatal when it
does not. If your atlas coordinates are already load-bearing somewhere else — a
tile engine naming tiles by cell, saved data storing cell indices — a layout
that moves when an asset is added would silently repoint every existing
reference.

`mount` honours a cell you declare instead.

```jsonc
"styles": {
  "ground": {
    "generator": "tiles",
    "mount": {
      "base": "assets/tiles/spritesheet.png",  // omit to start from transparent
      "cellWidth": 32,
      "cellHeight": 32,
      "out": "assets/tiles/spritesheet.png"
    },
    "outDir": "assets/tiles/src"
  }
},
"assets": {
  "rough_grass": { "prompt": "unmown dark grass", "cell": [6, 2] }
}
```

```bash
pixelkiln mount --style ground
#   ground — 1 cell(s) into 352x352 over assets/tiles/spritesheet.png
```

Two properties it guarantees:

- **Only declared cells are touched.** With a `base`, every other pixel
  survives byte-for-byte, so a hand-authored sheet can be part generated and
  part drawn without the generated half claiming the file.
- **A cell is replaced, not blended.** The sprite owns its cell, so the cell is
  cleared first. Compositing would let a regenerated tile show through to
  whatever it replaced, and that residue stays invisible until it ships.

An asset with no `cell` is simply left off the sheet. A sprite larger than the
cell is skipped and reported rather than cropped — cropping produces a sheet
that looks right in isolation and is wrong at every seam. Two assets claiming
one cell is a hard error.

One cell can contain only one file. If a generated asset has several outputs,
name the one to mount with `outputRole`; `mount` refuses to silently use the
first member of a structural set:

```jsonc
"rough_grass": {
  "prompt": "unmown dark grass",
  "cell": [6, 2],
  "outputRole": "tile-03"
}
```

`audit` follows the same output model and measures every member of a structural
set, reporting them with the same role-qualified ids used by the atlas.

#### When the art needs a step pixelkiln doesn't do

`mount` takes its pixels from the lockfile, which records what the API
returned. That is the wrong file whenever the art has to be processed first —
reduced onto a sheet's closed palette, shifted to line up with an existing
ground plane, touched up by hand. Without somewhere to say so, the choice is
to mount the unprocessed art or to composite by hand, and the hand-composited
sheet is exactly the unreproducible artifact `mount` exists to replace.

`source` points at the file that should actually go on the sheet:

```jsonc
"assets": {
  "rough_grass": {
    "prompt": "unmown dark grass",
    "cell": [6, 2],
    "source": "assets/tiles/src/rough/tile_0.png"   // post-remap, committed
  }
}
```

The path is relative to the manifest. An asset with a `source` needs no
lockfile entry at all, so art generated outside pixelkiln — or drawn by hand —
can be placed by cell alongside art that pixelkiln made. `prompt` still records
what was asked for.

An asset that declares a `cell` but has neither generated output nor a
`source` is skipped and named in the report, so a half-wired sheet says so
rather than quietly coming out short.

### Packing sprites that aren't in a manifest

`--inputs <path.json> --out <base>` packs an explicit list instead of a
lockfile — for a consumer whose sprites are drawn from several manifests, or
named in its own vocabulary rather than pixelkiln asset ids. This is how
heybud-admin packs its review-form icon sheets: those sprites come from two
different manifests and are keyed by option ids a website defines, not by
anything pixelkiln knows about.

```bash
pixelkiln pack --inputs sprites.json --out dist/sheet
#   86 sprite(s), 704x704 in 10 column(s) — 42.5 KB
#     dist/sheet.png + .json
```

```jsonc
// sprites.json
[
  { "id": "effect_euphoric", "path": "art/effect_euphoric.png" },
  { "id": "aura_golden_glow", "path": "../shared/aura_golden_glow.png" }
]
```

No manifest is required in this mode — not even an unrelated one sitting in
the working directory. `path` resolves relative to **the JSON file's own
directory**, not the process's cwd, so a caller can write the file into a
scratch directory without rewriting every entry to be absolute; an
already-absolute `path` passes through unchanged. `--out`'s parent directories
are created if they do not exist. Two inputs sharing an `id` is a hard error —
naming the duplicate — since a consumer looking a frame up by id would
otherwise get whichever came first with no signal the other was dropped.

## Documentation

| | |
|---|---|
| [docs/GETTING_STARTED.md](./docs/GETTING_STARTED.md) | First project, existing-art onboarding, the everyday workflow, CI checks, recovery, and what to commit. |
| [docs/LIBRARY.md](./docs/LIBRARY.md) | Public TypeScript API, provider-independent planning, quality checks, packing, and tileset export. |
| [docs/ENDPOINTS.md](./docs/ENDPOINTS.md) | Measured reference for the whole PixelLab API — costs, payload shapes, which parameters are actually wired up, and recipes. Every figure came from a live account, not from docs. |
| [docs/TILES.md](./docs/TILES.md) | Structural tile outputs, preserved adjacency rules, and the generic, Tiled, and Godot export contracts. |
| [PROVIDERS.md](./PROVIDERS.md) | The provider seam: what a backend must implement, which capabilities are optional and why. |
| [CONTRIBUTING.md](./CONTRIBUTING.md) | Local setup, change safety rules, architecture boundaries, and pull-request checks. |
| [SECURITY.md](./SECURITY.md) | Supported versions, private reporting guidance, and sensitive surfaces. |
| [NAMING.md](./NAMING.md) | Why this is called pixelkiln, and what the shortlist was. |

Consumers of this library keep their own project-side notes: heybud-admin's
`.kiro/steering/common-tasks.md` covers generating a badge variant end to end,
and super-disc-golf's `.kiro/steering/pixellab-recipes.md` covers the game's
sprite tiers.
