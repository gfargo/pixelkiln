# spritesmith

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
node bin/spritesmith.js --help
```

Requires Node 20+ and `PIXELLAB_API_KEY` in the environment.

## The two files

**`sprites.manifest.json`** — hand-authored, committed. Your asset dictionary.

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

**`sprites.lock.json`** — machine-written, committed. Maps every
`<style>/<asset>` to the PixelLab object that satisfies it and the file it
produced, with hashes on both sides.

Because entries are keyed `<style>/<asset>`, **a style is a namespace**. Adding
a second style re-derives the whole asset set into a separate output directory
under separate lock keys, so restyling a collection cannot clobber the original.

## Commands

```bash
spritesmith plan                    # diff manifest vs lock vs disk. Costs nothing.
spritesmith gen                     # submit → poll → pick → fetch
spritesmith gen --only first_review --force   # regenerate exactly one asset
spritesmith gen --style neon --budget 800     # a whole variant set, capped
spritesmith adopt                   # map pre-existing account objects to files on disk
spritesmith accept                  # keep existing art after rewording a style
spritesmith balance                 # generations remaining
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
spritesmith gen --style heybud-neon
```

## Economics

Cost is **fixed per call** and does not scale with candidates returned:

| Canvas | Generations | Candidates returned |
|---|---|---|
| ≤1024 px (e.g. 32×32) | 20 | 64 (size ≤42) |
| ≤2048 px | 25 | 16 (size ≤85) |
| larger (e.g. 64×64 = 4096 px) | 40 | 4 (size ≤170), 1 above |

A 64×64 icon costs 40 generations and returns 16 candidates. Generating small
and picking from many is strictly better value than one-shot-per-asset.

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
import { loadManifest, resolveSpecs, buildPlan, loadLock } from "spritesmith"

const loaded = await loadManifest("sprites.manifest.json")
const specs = await resolveSpecs(loaded)
const plan = await buildPlan(specs, await loadLock("sprites.lock.json"))
console.log(plan.cost, "generations")
```

## Not covered

Animated 8-direction **characters** are out of scope. PixelLab models those as a
separate entity with a ZIP bundle export, and the `super-disc-golf` repo already
has a mature importer for them (`tools/sync_pixellab_characters.py`).
