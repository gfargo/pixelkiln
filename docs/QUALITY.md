# Quality and automation gates

PixelKiln exposes local, deterministic checks separately from paid provider
work. Run them before generation and in CI.

## Plan gate

```bash
pixelkiln plan
pixelkiln plan --json --check
```

Planning compares resolved specs with lock state and on-disk hashes. It calls no
provider and reports estimated spend before work starts. `--check` succeeds only
when every selected entry is current.

Plan states include:

| State | Meaning |
|---|---|
| `ok` | Current spec, lock, and output bytes agree. |
| `missing` | No satisfying generation is recorded. |
| `untracked` | Local art exists without known provider provenance. |
| `stale` | Generation identity changed. |
| `failed` | Provider generation failed. |
| `recoverable` | Paid output can be fetched/restored without regeneration. |
| `in-flight` | Submitted work has not settled. |
| `orphaned` | Recorded output exists but current bytes differ. |

## Doctor gate

```bash
pixelkiln doctor
pixelkiln doctor --dry-run --json
```

Doctor validates schema and references, output authority/writability, lock
recovery sources, stale jobs, plan state, API-key configuration, and live
connectivity. `--dry-run` skips only provider connectivity. It changes nothing
and exits nonzero for unsafe state.

## Visual consistency audit

```bash
pixelkiln audit --style neon
pixelkiln audit --style neon --json --check \
  --max-distance 35 \
  --min-transparency 0.10 \
  --max-colors 128 \
  --sigma 1.5
```

Audit measures:

- palette distance from style reference images (or the set average when no
  references exist);
- transparent canvas share;
- distinct opaque color count;
- relative palette outliers by standard-deviation cutoff.

Missing and unreadable files are always unsafe. Structural output sets are
measured member-by-member with stable role-qualified ids. Standard
non-interlaced greyscale, indexed, RGB, greyscale-alpha, and RGBA PNGs are
normalized to RGBA before measurement.

## Human pixel-art gate

The audit catches measurable drift; it does not decide whether an image is good
pixel art. A grid-aligned file can still contain painterly gradients, noisy
single-pixel marks, weak silhouettes, or clusters inherited from a blurred
source. Review every candidate at its native 1× size and at an integer zoom.

For each candidate, verify:

- every required subject and landmark from the brief is present and readable;
- the silhouette and focal point read at 1×;
- clusters look deliberate instead of averaged or smeared;
- contours do not contain accidental stair-steps or isolated noise;
- the palette separates depth and gameplay-relevant shapes;
- transparency and tile seams are clean when applicable;
- the asset still fits the project's shared grid, palette, and perspective.

Reject a candidate that fails those checks even when dimensions, hashes,
transparency, palette count, and grid recovery all pass. For the tested ComfyUI
pixel-art stack, begin with 48–128px native components and compose larger scenes
from reviewed parts. Apply the final palette after grid recovery. Resolution is
a ceiling imposed by quality, not a target.

### Refinement quality record

`pixelkiln refine` makes the mechanical half of this gate repeatable for any
provider. It runs the pinned open Pixel Art Fixer, requires high-confidence
grid recovery, applies an explicit final palette without dithering, checks the
native dimensions, color count, and optional transparency floor, then writes a
hash-bound `.pixelkiln.json` record.

```bash
pixelkiln refine \
  --from candidates/mountain.png \
  --out art/mountain-native.png \
  --palette "#141b1e,#23312a,#384d4f,#526a8d,#709fcf,#865c45,#c6a766,#f1bb70" \
  --fixer-python .pixelkiln/pixelfixer/bin/python

pixelkiln refine approve \
  --from art/mountain-native.pixelkiln.json \
  --reviewer "Mina"

pixelkiln refine check --from art/mountain-native.pixelkiln.json
```

The first command deliberately leaves review pending. `approve` records the
named person's 1× review. `check` fails closed until that happens and fails
again if the source, final PNG, palette or tool metadata, audit, or review is
edited. Rerun the refiner after an intentional change, inspect the new output,
and approve that revision separately.

## Cache integrity gate

```bash
pixelkiln cache --check
```

This validates both local caches, including complete PNG decoding. Add
`--prune` only in a maintenance workflow because it mutates disposable cache
state, though it never deletes provider objects or generated destinations.

## Recommended CI

```bash
npm ci
npm run typecheck
npm test
npm run test:docs
npm run build
npm run test:package
npm audit

pixelkiln doctor --dry-run
pixelkiln plan --json --check
pixelkiln audit --json --check --max-distance 35 --max-colors 128
pixelkiln cache --check
pixelkiln refine check --from art/mountain-native.pixelkiln.json
```

Choose audit thresholds per project; do not copy a palette distance or color
ceiling without checking representative art. The repository's core test suite
uses `FakeProvider`, so money-spending stages are deterministic and offline.

## JSON and exit behavior

- JSON contracts are versioned/stable enough for automation where documented.
- Partial provider pipeline failures and timeouts exit nonzero.
- `salvage --dry-run --json` reserves stdout for JSON and sends diagnostics to
  stderr.
- A failed CI job should distinguish provider/output drift from repository test
  failures rather than regenerating automatically.
- `refine check` exits nonzero for pending approval and for any quality-record
  drift. CI must never add or renew human approval.

Generation should remain an explicit, budgeted human action; CI is for proving
that committed declarations, state, and artifacts still agree.
