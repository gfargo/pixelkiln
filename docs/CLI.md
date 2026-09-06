# CLI reference

```text
pixelkiln <command> [options]
```

Unknown commands, positional arguments, and flags are errors. Repeated
`--style`, `--only`, `--claims`, and `--output-role` values accumulate; comma-
separated values work too. This strict parsing prevents a misspelled filter
from widening a paid run.

The manifest's top-level `provider` is the default; each style may select a
different provider. `plan`, `doctor`, and pipeline commands route the resolved
work accordingly. The experimental `retrodiffusion` adapter supports
still-image `map`/`pixflux`, `tiles` sheets, and `animation` GIF/spritesheet
work. The experimental `comfyui` adapter runs committed API-format `map`
workflows on a self-hosted server. The experimental `scenario` adapter runs
hosted still models with Compute Unit preflight and durable asset recovery.

## Everyday pipeline

### `init`

Scaffold a manifest from an existing PNG tree.

```bash
pixelkiln init --from assets/sprites --exclude characters,gifs --generator map
```

Prompts are deliberately empty because plausible text is not provenance. Use
`adopt --write-prompts` to recover exact provider prompts for byte matches.

### `plan`

Diff the resolved manifest against the lockfile and disk without calling a
provider. It reports current, blocked, missing, untracked, stale, failed,
recoverable, in-flight, and orphaned entries plus estimated cost grouped by
provider and unit. A revision is blocked when its parent or mask is missing,
stale, modified, or awaiting quality approval. Blocked work is not actionable
and adds no cost. Single-provider JSON retains `cost` and `costUnit`; mixed
plans set those legacy fields to `null` and expose the exact totals in `groups`.
Revision items in JSON also include their mode, parent id/hash, optional mask
hash, and strength.

```bash
pixelkiln plan
pixelkiln plan --style neon --only anvil,hammer --json --check
```

`--check` exits nonzero unless every selected entry is current. For styles with
`quality`, current raw output is not enough: each derived PNG must also have a
current named approval.

### `doctor`

Validate the manifest, references, lockfile recovery sources, raw and quality
output paths, stale jobs, current plan, credential configuration, and provider
connectivity. A pending or stale quality profile is reported as a warning.
`--dry-run` skips only live connectivity. Supports `--json` and exits nonzero
for unsafe state.

### `gen`

Run `submit` → `poll` → `pick` → `fetch`. This is the normal paid workflow.
Use `--budget` as a hard ceiling and filters to limit scope.

```bash
pixelkiln gen --style neon --only anvil,hammer --budget 80
```

A mixed run requires one named ceiling for every provider it can spend through:

```bash
pixelkiln gen --budget pixellab=12 --budget retrodiffusion=0.20 --budget comfyui=0
```

PixelKiln validates the complete budget set before submitting the first group.
After downloading a style with `quality`, `gen` points to the offline refinement
step. It does not run or approve that step on the user's behalf.

### `submit`

Queue selected missing/stale generation work without polling it. Enforces the
provider spacing and concurrency limits, validates estimates at the spending
boundary, and saves each remote id immediately. Revision inputs are rechecked
after any queue wait and before a provider request begins.

### `poll`

Advance submitted jobs to completed, failed, or selection-ready states. It can
be rerun safely after an interrupted session. When work settles in another
stage, the command prints the exact next command instead of ending silently.

### `pick`

Open the local candidate-review UI for jobs with alternatives. The page keeps
native aspect ratios, uses exact integer zoom for small art, fits large work,
and centers the decision surface on wide displays. A revision row shows its
parent source beside the new candidates. Arrow keys navigate, Enter
selects, 1–9 choose directly, and 0 leaves a row unresolved. Only rows submitted
with **Apply selections** are written to the lockfile. Closing the window applies
nothing. See the [Getting started guide](GETTING_STARTED.md#start-a-new-project)
for a screenshot of the interface.

The live localhost URL is progress, not piped command output. In a terminal it
prints normally; when stdout is piped, PixelKiln sends it to stderr immediately
so commands such as `pixelkiln pick | tail -20` cannot hide it until review ends.

### `fetch`

Download completed or selected outputs, validate complete PNG or GIF structure,
write the manifest-authoritative destinations, populate the content cache, and
update output hashes. `--tag` also pushes manifest tags after successful
downloads when the provider supports tagging.

After a stale spec is deliberately regenerated, `fetch` replaces the prior file
only if its hash still proves PixelKiln wrote it. A changed or untracked
destination is refused; inspect it, then pass `fetch --force` only when the new
provider result should take ownership. `gen --force` applies the same rule.

### `restore`

Repair missing generated files without buying new generations. It prefers
validated local content-addressed cache bytes and otherwise reuses provider
references. It never replaces a destination whose bytes disagree with the lock.

The paid-work states have one safe next step:

| Lock state | Resume command |
|---|---|
| `pending`, `processing` | `pixelkiln poll` |
| `review` | `pixelkiln pick` |
| `selected`, `download-failed` | `pixelkiln fetch` |
| `downloaded` with a missing file | `pixelkiln restore` |

`plan`, `doctor`, and each pipeline stage name these commands. None submits a
new generation. Missing recovery ids are reported by `doctor` instead of being
presented as resumable work.

## Reconciliation and lifecycle

### `adopt`

Match local files to existing provider objects by SHA-256. `--write-prompts`
copies recovered prompts into the manifest; `--tag` pushes project tags. Local
retouches remain untracked rather than being regenerated or overwritten. Pass
`--provider` when the manifest uses more than one provider.

### `accept`

Re-baseline intact existing art after prompt/style prose changes. Artwork bytes
do not change; only the recorded spec hash moves. Missing or modified output is
not accepted.

### `salvage`

Review remote objects that no supplied lockfile claims. On shared accounts, pass
every other project lock via repeatable `--claims`; sibling manifests are used
to exclude objects matching another project's styles. `--dry-run --json`
provides a scriptable inventory. Import, keep, and discard are review decisions;
discard only tags an object. Pass `--provider` when the manifest uses more than
one provider.

### `purge`

Delete provider objects previously tagged `pixelkiln:discard`. It is separate
from salvage, lists targets, asks for confirmation, and refuses non-interactive
deletion without `--yes`. Use `--dry-run` first. Pass `--provider` when the
manifest uses more than one provider.

### `prune`

Remove lock entries that no style/asset pair in the manifest resolves to. These
accumulate when an asset is renamed or moved between styles: the old entry keeps
claiming the output path the new one now owns, which is what `doctor` reports as
`lock-outputs`.

Offline. It lists what it would remove, asks for confirmation, and refuses
non-interactive removal without `--yes`. Use `--dry-run` first. The artwork on
disk is untouched and nothing is deleted from the provider account, but the
pruned entries' provenance is gone, so those objects read as unclaimed the next
time you run `salvage`.

`--style` and `--only` are rejected: prune compares the lockfile against the
whole manifest, so a filter would make every entry it excluded look undeclared.

### `tag`

Push current manifest tags to tracked provider objects. This does not generate
or download artwork.

### `balance`

Show one provider's remaining balance and cost unit. A mixed manifest requires
`--provider`; a single-provider manifest infers it. Reports a capability error
when an installed provider, such as local ComfyUI, has no balance endpoint.

### `status`

Summarize lock entries by state and successful submission spend by cost unit.
Supports `--json`; unlike units are never added together.

### `workspace`

Register sibling projects in a schema-versioned catalog file, outside any one
manifest, so a shared provider account's complete claim set no longer depends
on remembering every `--claims` path. Offline throughout.

```bash
pixelkiln workspace add ../other-game/pixelkiln.manifest.json
pixelkiln workspace add ../another-game/pixelkiln.manifest.json --name another
pixelkiln workspace list
pixelkiln workspace status --json
pixelkiln workspace claims
pixelkiln workspace remove another
```

Subcommands:

| Subcommand | Effect |
|---|---|
| `add <manifest>` | Registers a project. Id defaults to the manifest's `name`; `--name` overrides it. Lock defaults to `pixelkiln.lock.json` beside the manifest; `--lock` overrides it. `--provider` overrides the manifest's provider id; `--account` sets a free-form account label. Refuses a duplicate id or a lockfile already registered under another id. Warns, but does not refuse, when the lock does not exist yet. |
| `remove <id-or-manifest>` | Drops a registration by project id or by manifest path. Touches no art, no lock, no provider account. |
| `list` | Lists registered projects and catalog diagnostics. Refuses if the catalog file does not exist. |
| `status` | Aggregate provider, spend-by-unit, plan state, and claim count, offline. Provider cost units are never summed across each other. Refuses if the catalog file does not exist. |
| `claims` | Validates the catalog and emits the exact union of provider-qualified `objectId`/`reviewObjectId`/`jobId` claims across every registered lock. Refuses to omit a project when any registered lock is missing or unreadable, or when the catalog has a duplicate id or lock path. |

`--workspace <path>` selects the catalog file; it defaults to
`pixelkiln.workspace.json` in the current directory. Stored paths are relative
to the catalog file's own directory, so a catalog survives a clone or move.
`list`/`status` support `--json` and `--check` (nonzero exit on any error-level
diagnostic); both treat a nonexistent catalog file as a hard error rather than
an empty, vacuously-safe one. This is the same hazard class as an incomplete
claim set. In `--json` output, the `workspace` key always names the catalog *file*;
`status` also reports `dir`, the catalog's own directory that
registered paths resolve against.

Passing `--workspace <path>` to `salvage` derives its claim set and its
sibling-manifest style signal from every project the catalog registers.
`--claims` still works and joins both the lockfile claim set and sibling
manifest list. A missing or unreadable registered lock is a hard error there
too. PixelKiln never skips one because the catalog exists to guarantee a
complete account-wide claim set. See
[Recovery and account safety](./RECOVERY.md#shared-workspace-catalog).

### `recipe`

Manage versioned provider setup packs without contacting a provider. Recipe
metadata includes a manifest style template, included workflow hashes, external
model hashes and licenses, and an explicit quality stage.

```bash
pixelkiln recipe list
pixelkiln recipe inspect comfyui/pixel-art-xl-environment
pixelkiln recipe install comfyui/pixel-art-xl-environment@1.0.0
pixelkiln recipe verify \
  pixelkiln-recipes/comfyui/pixel-art-xl-environment/1.0.0 \
  --model-root /path/to/ComfyUI/models
```

| Subcommand | Effect |
|---|---|
| `list` | Lists every recipe bundled with this PixelKiln version. |
| `inspect <id-or-path>` | Shows identity, provider, quality stage, native/palette targets, workflow, and required models. |
| `install <id-or-path>` | Verifies and copies a pack. The default versioned destination is `pixelkiln-recipes/<provider>/<name>/<version>`; `--out` names a different directory. Prints a manifest-ready style entry with the installed workflow path. |
| `verify <id-or-path>` | Checks the metadata digest and included workflow bytes. `--model-root` also hashes every required model and exits nonzero for a missing or mismatched model. |

An unversioned id selects the newest bundled version. Exact selectors use
`provider/name@x.y.z`. Install refuses to replace a locally changed declared
file unless `--force` is passed. It never downloads dependencies or removes
extra files. `list`, `inspect`, `install`, and `verify` support `--json`.

Without `--model-root`, external models are reported as `unchecked` and do not
make the recipe itself invalid. This distinction lets CI verify the committed
pack while workstation setup verifies multi-gigabyte model files. See
[Versioned recipes](./RECIPES.md) for the file contract and update policy.

## Local quality and derived output

### `audit`

Measure palette distance, transparent canvas share, and opaque color count for
every selected output. Structural sets are evaluated member-by-member.

```bash
pixelkiln audit --style neon --json --check \
  --max-distance 35 --min-transparency 0.1 --max-colors 128 --sigma 1.5
```

### `refine`

Build or verify the quality profile declared by selected manifest styles. This
work is provider-neutral and offline:

```bash
pixelkiln refine --style environment --only mountain,fortress
pixelkiln refine check --style environment --json
```

Manifest mode reads the final output directory, palette, detector confidence,
optional transparency floor, and fixer revision from `style.quality`. It uses a
declared asset `source`, or exactly one intact downloaded PNG from the lockfile.
Raw provider output stays untouched. A repeated run skips current pending and
approved records; `--force` rebuilds them and resets approval.

`refine check` exits nonzero until every selected profile result is current and
approved. `plan` shows the same quality state without changing provider cost or
generation actionability. `pack` and `mount` fail closed and use only approved
profile output.

Pass `--from` to refine one PNG without a manifest. Path mode also needs
`--out` and an explicit palette.

Install the pinned Pixel Art Fixer package into an isolated Python environment
before the first run. The [ComfyUI guide](./COMFYUI.md#install-the-refiner) has
the exact command and revision.

```bash
PALETTE="#141b1e,#23312a,#384d4f,#526a8d,#709fcf,#865c45,#c6a766,#f1bb70"

pixelkiln refine \
  --from working-canvas.png \
  --out art/mountain-native.png \
  --palette "$PALETTE" \
  --fixer-python .pixelkiln/pixelfixer/bin/python
```

Both modes run Pixel Art Fixer at its recorded revision, require high grid
confidence by default, reconstruct one stored pixel per detected cell, and
maps every visible pixel to the nearest supplied color without dithering. The
palette size becomes the color-count ceiling. `--min-transparency` can add an
alpha threshold for isolated assets. Failed checks write nothing.

The output is accompanied by `<name>.pixelkiln.json`. The record hashes the
source and output and stores the fixer revision, detected grid, palette, audit,
and review state. It starts as `pending`; an automated pass is not art approval.

```bash
pixelkiln refine approve \
  --from art/mountain-native.pixelkiln.json \
  --reviewer "Mina" \
  --note "Readable at 1x; alpha edge is clean"

pixelkiln refine check \
  --from art/mountain-native.pixelkiln.json \
  --json
```

`approve` remains record-based because approval belongs to one exact PNG. It
asks the reviewer to confirm the native 1× and integer-zoom checks. Use `--yes`
only when that review already happened and the named person is recording it
non-interactively. `check` exits nonzero when approval is pending or when the
source, output, palette metadata, fixer revision, or audit record has changed.
Any actual rebuild resets approval to pending.

`--min-grid-confidence medium` or `low` weakens the structural gate. Do that
only after inspecting a representative batch. `--fixer-revision` records a
different pinned installation; it does not install or verify that revision for
you.

### `quality`

Snapshot measurable PNG traits, then fail CI when committed assets drift beyond
their reviewed envelope. This command is offline, provider-neutral, and does not
approve art.

```bash
pixelkiln quality snapshot \
  --inputs config/quality-inputs.json \
  --out quality/pixelkiln.quality.json
pixelkiln quality check --from quality/pixelkiln.quality.json
```

The input file is a JSON array of `{ id, path, record?, tolerances? }`. Paths
are relative to that file. The baseline stores portable paths relative to
itself and records dimensions, palette, transparency, partial alpha, edge
density and contrast, isolated-pixel ratio, and the PNG hash. A linked
refinement record must be current and own the image.

`snapshot` leaves a different existing baseline untouched unless `--force` is
explicit. `check` exits nonzero for missing files, dimension or metric drift,
new colors, soft or partial-alpha edges, excessive isolated pixels, exact-hash
violations, or changed refinement records. Hash-only changes are warnings unless
`requireExactHash` is enabled or a linked record binds the bytes. Review changes
visually before replacing a baseline.

### `cache`

Inspect the local content cache and account object-hash cache. `--check` exits
nonzero for unsafe state. `--prune` removes malformed, corrupt, partial, and
unreferenced cache data; it does not delete provider objects.

### `pack`

Build a deterministic RGBA sprite sheet, JSON atlas, and `.pixelkiln.json`
provenance companion. Manifest mode reads lock outputs. When the style has a
quality profile, it requires current human approval, packs the derived PNGs,
and binds their quality records into sheet provenance. Explicit-input mode needs
no manifest:

```bash
pixelkiln pack --style neon --columns 8
pixelkiln pack --inputs sprites.json --out dist/sheet
```

Use repeatable `--output-role` for structural members or `--primary-only` for
unambiguous single outputs. These modes are mutually exclusive.

### `mount`

Write sprites into manifest-declared cells, optionally over an existing base
sheet. Undeclared cells survive byte-for-byte; each declared cell is cleared
before its sprite is placed. A quality profile overrides raw and declared
sources for participating cells only after its record passes the approval gate.

### `export`

Build a structural tile atlas plus generic JSON, Tiled TSJ, or Godot TRES
metadata and a provenance companion.

```bash
pixelkiln export --style ground --only terrain --format tiled --columns 8
```

See [derived artifacts](./ARTIFACTS.md) and [tiles](./TILES.md).

## Utility commands

### `help`

Print the built-in command and option summary. `--help` and `-h` are aliases.

### `--version`

Print the package version. `-v` is an alias.

## Options

| Option | Applies to | Meaning |
|---|---|---|
| `--manifest <path>` | manifest commands | Manifest path; defaults to `pixelkiln.manifest.json`. |
| `--lock <path>` | manifest commands | Lock path; defaults beside the manifest. |
| `--style a,b` | most workflows | Restrict styles; repeatable. |
| `--only id1,id2` | most workflows | Restrict asset ids; repeatable. |
| `--budget <n\|provider=n>` | submit/gen | Refuse work above this cost. Repeat `provider=n` for every provider in a mixed run; do not mix keyed and unkeyed forms. |
| `--force` | gen/fetch/derived commands/recipe install/quality snapshot | Regenerate current work, replace a changed or untracked fetch destination, rebuild current quality-profile output, take ownership of modified/unowned derived output, replace changed recipe files, or replace a changed quality baseline. A refinement rebuild resets approval. |
| `--dry-run` | supported mutating commands | Inspect without spending or mutating provider state. |
| `--json` | plan/doctor/audit/cache/status/salvage/refine/recipe/quality | Machine-readable stdout where supported. |
| `--check` | plan/audit/cache | Exit nonzero when selected state is unsafe. |
| `--yes`, `-y` | confirmed operations | Skip an interactive confirmation. For `refine approve`, it records an already-completed human review; it does not replace one. |
| `--no-open` | pick/salvage | Do not automatically open the browser. |
| `--tag` | fetch/adopt | Also push tags after the command's primary work. |
| `--claims <paths>` | salvage | Other project lockfiles; repeatable and comma-separated. |
| `--workspace <path>` | workspace/salvage | Workspace catalog path; defaults to `pixelkiln.workspace.json`. On salvage, derives the claim set instead of repeated `--claims`. |
| `--provider <id>` | balance/adopt/salvage/purge/workspace add | Select the account provider for a mixed manifest, or set the workspace catalog's default provider hint. |
| `--account <label>` | workspace add | Free-form account label, e.g. distinguishing sandboxes. |
| `--all` | salvage dry run | List every unclaimed object rather than the first 30. |
| `--from <path>` | init/refine/quality check | Existing source tree for init; source PNG or quality record for one-file refine mode; baseline for quality check. Omit it to use manifest `style.quality`. |
| `--exclude <names>` | init | Directory/name fragments to exclude; repeatable. |
| `--generator <name>` | init | Generator assigned to the scaffolded style. |
| `--name <name>` | init | Project name for the scaffolded manifest. |
| `--write-prompts` | adopt | Recover provider prompts into the manifest. |
| `--port <n>` | pick/salvage | Local review server port; otherwise chooses a free port. |
| `--out <path>` | pack/export/refine/recipe install/quality snapshot | Output base override, final native PNG for path-mode refine, exact recipe destination, or quality baseline path. Export requires one selected tileset. |
| `--inputs <path>` | pack/quality snapshot | JSON input array; requires `--out`. Quality cases use `{ id, path, record?, tolerances? }`. |
| `--columns <n>` | pack/export | Grid columns, 1–1024; default is near-square. |
| `--format <name>` | export | `generic` (default), `tiled`, or `godot`. |
| `--output-role <role>` | pack | Include named structural roles; repeatable. |
| `--primary-only` | pack | Include only unambiguous primary/single outputs. |
| `--max-distance <n>` | audit | Absolute palette-distance ceiling. |
| `--min-transparency <0..1>` | audit/refine | Minimum transparent canvas share. |
| `--max-colors <n>` | audit | Maximum distinct opaque colors. |
| `--sigma <n>` | audit | Relative outlier cutoff; defaults to 1.5. |
| `--prune` | cache | Remove invalid and unreferenced cache data. |
| `--palette <hexes>` | refine | Final `#rrggbb` colors; repeatable and comma-separated. Requires 2–256 unique colors. |
| `--fixer-python <path>` | refine | One-run Python override containing Pixel Art Fixer. Manifest mode otherwise uses `quality.fixerPython`, then `PIXELKILN_PIXEL_FIXER_PYTHON`, then `python3`. |
| `--fixer-revision <sha>` | refine | Revision recorded in the quality companion. Defaults to PixelKiln's tested pin. |
| `--min-grid-confidence <level>` | refine | Minimum accepted detector confidence: `high` (default), `medium`, or `low`. |
| `--reviewer <name>` | refine approve | Human reviewer stored in the quality companion. |
| `--note <text>` | refine approve | Optional review note stored in the quality companion. |
| `--model-root <path>` | recipe verify | ComfyUI `models` directory. Enables streamed hash checks for every external model declared by the recipe. |

## Exit and output contract

- Parse, schema, ownership, provider, and filesystem errors exit nonzero.
- `submit`, `poll`, `fetch`, and `gen` exit nonzero on partial failure or
  timeout; automation cannot mistake an incomplete batch for success.
- Human progress goes to stderr when `salvage --dry-run --json` reserves stdout
  for JSON.
- `plan --check`, `audit --check`, and `cache --check` are intended as CI gates.
  Manifest quality profiles also make `plan --check` require current approval.
- `refine check` is fail-closed in both modes. Pending review, the wrong raw
  source, or recorded-byte and metadata drift exit nonzero.
- `recipe verify` exits nonzero for changed metadata/workflows and, when
  `--model-root` is supplied, missing or mismatched models.
- `quality check` is fail-closed for missing or unreadable images, measurements
  outside tolerance, exact-hash violations, and changed or invalid linked
  refinement records.
- Commands that can spend or delete expose their scope before doing so; budget
  and confirmation are separate protections.
