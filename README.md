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

## Economics

The two generators are priced completely differently, and the gap decides which
one to reach for. All figures measured against a live account.

**`1dir`** — fixed per call, does not scale with candidates returned:

| Canvas | Generations | Candidates returned |
|---|---|---|
| ≤1024 px (e.g. 32×32) | 20 | 64 (size ≤42) |
| ≤2048 px | 25 | 16 (size ≤85) |
| larger (e.g. 64×64 = 4096 px) | 40 | 4 (size ≤170), 1 above |

**`map`** — a flat **1 generation at any size**, returning a single result.
Verified: a 32×36 and a 64×96 map object each cost exactly 1.

So the choice is not "square vs non-square" but **variety vs volume**:

- `1dir` buys 4–64 candidates for one price. Worth it when you want to *pick* —
  a badge set, a hero prop, anything where the look matters more than the count.
- `map` is ~20–40× cheaper and takes arbitrary dimensions. Worth it for volume,
  and for anything non-square. **Forty re-rolls of a map object cost the same as
  one `1dir` call**, so iterating one-at-a-time is the cheap strategy here, not
  the expensive one.

A 111-asset non-square set costs ~111 generations via `map`. The same set via
`1dir` would be ~3,500 and could not express the dimensions at all.

Limits: submissions must be **>2s apart**, and concurrent background jobs are
capped by tier (1: 8, 2: 10, 3: 20). `submit` enforces both — a global spacing
gate plus real in-flight tracking, rather than parallel workers that would
quietly breach the rate limit.

## Generator differences that matter

| | `1dir` | `map` |
|---|---|---|
| Shape | square only | arbitrary width × height |
| Retention | **permanent** | **deleted after 8 hours** |
| Candidates | many (free) | exactly one |
| Selection step | yes | no |

For `map`, `fetch` must run in the same session as `submit`. `poll` marks
entries past the window as failed rather than letting them look pending forever.

## Gotchas encoded in the tool

- **`size` and `styleImages` are mutually exclusive.** When style images are
  supplied the *largest one* determines output size — so references must already
  be at the target resolution. A 128 px reference silently yields 128 px output
  and a different candidate count.
- **`select-frames` returns `created_object_ids`.** The review parent survives
  until emptied, so recording the parent id gives you a transient pointer.
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
