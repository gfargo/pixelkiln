# Quality and automation gates

PixelKiln keeps local checks separate from paid provider work. Run them before
generation and in CI.

## Plan gate

```bash
pixelkiln plan
pixelkiln plan --json --check
```

Planning compares resolved specs with lock state and on-disk hashes. It calls no
provider and reports estimated spend before work starts. When a style declares
a quality profile, the plan also reports `blocked`, `needs-refinement`,
`needs-approval`, or `approved`. `--check` requires current raw output and
approved derived output.

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

Doctor validates schema and references, raw and quality output directories,
lock recovery sources, stale jobs, plan state, credential configuration, and
live connectivity. It warns when a configured quality result is not approved.
`--dry-run` skips only provider connectivity. It changes nothing and exits
nonzero for unsafe state.

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

## Image regression gate

Keep a versioned baseline for reviewed PNGs that must not quietly become softer,
noisier, larger-palette images. The snapshot is offline and provider-neutral.

```json
[
  {
    "id": "environment/mountain",
    "path": "../art/mountain-native.png",
    "record": "../art/mountain-native.pixelkiln.json"
  }
]
```

Save that input list, snapshot it once, inspect the result, and commit both files:

```bash
pixelkiln quality snapshot \
  --inputs config/quality-inputs.json \
  --out quality/pixelkiln.quality.json

pixelkiln quality check --from quality/pixelkiln.quality.json
```

`quality check` compares dimensions, colors, transparency, partial alpha, edge
density, mean edge contrast, and isolated-pixel ratio. By default, it permits a
different PNG hash only when every metric remains within the recorded
tolerances. Set `requireExactHash` in a case when any byte change must fail. A
linked refinement record is always hash-bound and must still own the PNG and
verify as current.

The default envelope allows no new colors, no color-count or partial-alpha
increase, at most one percentage point of transparency drift, three points of
edge-density drift or edge-contrast loss, and half a point of added isolated
pixels. Edit per-case tolerances only after reviewing representative changes.
Use `quality snapshot --force` to accept a deliberately changed baseline;
ordinary snapshots refuse to overwrite different expectations.
The public file contract is
[`schema/quality-baseline.schema.json`](../schema/quality-baseline.schema.json).

This gate catches structural regression, not bad art. An unchanged file can
still have a weak composition, missing prompt elements, or poor clusters. Keep
the human gate below.

## Human pixel-art gate

The audit measures drift; it cannot judge the drawing. A grid-aligned file can
still contain painterly gradients, isolated noise, a weak silhouette, or soft
clusters inherited from a blurred source. Review every candidate at native 1×
and at an integer zoom.

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

### Manifest quality profile

Put the release rule beside the style when every asset in that style needs the
same native-grid and palette treatment:

```jsonc
{
  "generator": "map",
  "outDir": "assets/generated/environment",
  "quality": {
    "outDir": "assets/final/environment",
    "palette": ["#141b1e", "#23312a", "#526a8d", "#709fcf", "#f1bb70"],
    "minGridConfidence": "high"
  }
}
```

Then run the selected batch:

```bash
pixelkiln refine --style environment
pixelkiln refine approve \
  --from assets/final/environment/mountain.pixelkiln.json \
  --reviewer "Mina"
pixelkiln refine check --style environment
pixelkiln plan --style environment --check
```

The first command reads the profile's output path, palette, detector threshold,
optional transparency floor, and fixer revision. Do not repeat those as flags;
manifest mode rejects conflicting path-owned settings. `--style` and `--only`
can narrow a batch. A normal rerun skips current pending or approved records,
so it does not erase review work. `--force` rebuilds them and resets approval.

Raw provider files and derived PNGs have separate identities. A profile change
does not make the raw generation stale or add provider cost. It makes the
quality state `needs-refinement`. A changed declared `asset.source` does the
same. Provider output is `blocked` when its generation spec is stale or its
locked PNG is missing, modified, or non-PNG. ComfyUI `frames` is the supported
multi-output exception: every ordered role and hash must be present.

`pack` and `mount` consume the approved PNGs automatically and include their
quality records in the new bundle's provenance. They fail before writing when
any required record is pending, stale, made from a different source, or edited.
Single-image `map`, `1dir`, and `pixflux` styles produce one record per PNG.
ComfyUI `frames` produces one record for the ordered set. It stores fps and
per-frame grid measurements, applies one palette, rejects step/phase drift, and
requires one human approval for the complete loop. Packaging exposes the
approved members as `asset/frame-XX`; it never substitutes a partial set.
`pack` includes the complete approved sequence. `mount` requires the asset's
`outputRole` to name the one approved frame placed in its fixed cell.

### One-off refinement record

`pixelkiln refine --from` applies the same mechanical gate to one PNG outside a
manifest profile. It runs the pinned open Pixel Art Fixer, requires
high-confidence grid recovery, applies the chosen palette without dithering,
checks native dimensions, color count, and optional transparency, then writes a
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
npm run test:security
npm run test:quality
npm run build
npm run test:package
npm audit

pixelkiln doctor --dry-run
pixelkiln plan --json --check
pixelkiln audit --json --check --max-distance 35 --max-colors 128
pixelkiln cache --check
pixelkiln refine check --style environment
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
- Manifest `refine check` exits nonzero unless every selected profile output is
  current and approved. Path mode applies the same gate to one record. CI must
  never add or renew human approval.
- `quality check` exits nonzero when any baseline case is missing, unreadable,
  outside tolerance, or bound to a changed or invalid refinement record.
- `test:security` exits nonzero when tracked JSON contains a credential-bearing
  URL and reports only the file and JSON path.

Generation should remain an explicit, budgeted human action; CI is for proving
that committed declarations, state, and artifacts still agree.
