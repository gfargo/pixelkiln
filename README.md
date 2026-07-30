# pixelkiln

> **`pixelkiln` is a working title.** The name is taken on npm by an unrelated,
> established package. See [NAMING.md](./NAMING.md) for the shortlist and the
> prior-art survey. `package.json` is `private: true` until it is settled.

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

```bash
npm install
node bin/pixelkiln.js --help
npm test
```

Requires Node 20+ and `PIXELLAB_API_KEY` in the environment. See
[`examples/minimal`](./examples/minimal) for a three-asset starter manifest.

## The two files

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

**Cost carries a unit.** `generations` (PixelLab subscription), `usd`
(per-image providers), or `free` (local models). `plan` prints the unit, and
`--budget` is interpreted in it — so a per-image price can never be silently
read as a subscription quota.

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

`parseLock` reads either version and migrates v1 transparently. A committed
lockfile is the record of what you have paid for, so a version bump must never
make one unreadable — that would present every tracked asset as missing and
offer to regenerate the lot. A v1 entry whose file had no recorded hash is
dropped rather than carried over, so `plan` reports it `untracked` instead of
vouching for bytes that were never verified.

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

It opens a contact sheet of everything no lockfile claims. Each card gets one of
three verdicts (hover + `i` / `k` / `d`):

| Verdict | Effect |
|---|---|
| **import** | Downloads it, adds a manifest asset and a lock entry with the recovered prompt. It becomes a fully tracked asset. |
| **keep** | Tags it `pixelkiln:keep` upstream. Nothing local changes. |
| **discard** | Tags it `pixelkiln:discard`. **Does not delete.** |

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
pixelkiln gen                     # submit → poll → pick → fetch
pixelkiln gen --only first_review --force   # regenerate exactly one asset
pixelkiln gen --style neon --budget 800     # a whole variant set, capped
pixelkiln adopt --write-prompts   # map account objects to files, recover prompts
pixelkiln accept                  # keep existing art after rewording a style
pixelkiln audit --style neon      # measure style consistency, offline
pixelkiln salvage --claims a.json # triage objects no lockfile claims
pixelkiln balance                 # generations remaining
```

`plan` is the habit worth forming — it is free, and it prints exactly what a run
would cost before anything is spent.

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
import { loadManifest, resolveSpecs, buildPlan, loadLock } from "pixelkiln"

const loaded = await loadManifest("pixelkiln.manifest.json")
const specs = await resolveSpecs(loaded)
const plan = await buildPlan(specs, await loadLock("pixelkiln.lock.json"))
console.log(plan.cost, "generations")
```

## Not covered

Animated 8-direction **characters** are out of scope. PixelLab models those as a
separate entity with a ZIP bundle export, and the `super-disc-golf` repo already
has a mature importer for them (`tools/sync_pixellab_characters.py`).
