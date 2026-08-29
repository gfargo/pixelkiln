# CLI reference

```text
pixelkiln <command> [options]
```

Unknown commands, positional arguments, and flags are errors. Repeated
`--style`, `--only`, `--claims`, and `--output-role` values accumulate; comma-
separated values work too. This strict parsing prevents a misspelled filter
from widening a paid run.

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
provider. It reports current, missing, untracked, stale, failed, recoverable,
in-flight, and orphaned entries plus estimated cost in the provider's unit.

```bash
pixelkiln plan
pixelkiln plan --style neon --only anvil,hammer --json --check
```

`--check` exits nonzero unless every selected entry is current.

### `doctor`

Validate the manifest, references, lockfile recovery sources, output ownership,
writability, stale jobs, current plan, API-key configuration, and provider
connectivity. `--dry-run` skips only live connectivity. Supports `--json` and
exits nonzero for unsafe state.

### `gen`

Run `submit` → `poll` → `pick` → `fetch`. This is the normal paid workflow.
Use `--budget` as a hard ceiling and filters to limit scope.

```bash
pixelkiln gen --style neon --only anvil,hammer --budget 80
```

### `submit`

Queue selected missing/stale generation work without polling it. Enforces the
provider spacing and concurrency limits, validates estimates at the spending
boundary, and saves each remote id immediately.

### `poll`

Advance submitted jobs to completed, failed, or selection-ready states. It can
be rerun safely after an interrupted session.

### `pick`

Open the local candidate-review UI for jobs with alternatives. Arrow keys
navigate, Enter selects, 1–9 choose directly, and 0 leaves a row unresolved.
Only rows submitted with **Apply selections** are written to the lockfile;
unchosen rows remain ready for later review, and closing the window applies
nothing. See the [Getting started guide](GETTING_STARTED.md#start-a-new-project)
for a screenshot of the actual interface.

### `fetch`

Download completed or selected outputs, validate complete PNG structure, write
the manifest-authoritative destinations, populate the content cache, and update
output hashes. `--tag` also pushes manifest tags after successful downloads.

### `restore`

Repair missing generated files without buying new generations. It prefers
validated local content-addressed cache bytes and otherwise reuses provider
URLs. It never replaces a destination whose bytes disagree with the lock.

## Reconciliation and lifecycle

### `adopt`

Match local files to existing provider objects by SHA-256. `--write-prompts`
copies recovered prompts into the manifest; `--tag` pushes project tags. Local
retouches remain untracked rather than being regenerated or overwritten.

### `accept`

Re-baseline intact existing art after prompt/style prose changes. Artwork bytes
do not change; only the recorded spec hash moves. Missing or modified output is
not accepted.

### `salvage`

Review remote objects no supplied lockfile claims. On shared accounts, pass
every other project lock via repeatable `--claims`; sibling manifests are used
to exclude objects matching another project's styles. `--dry-run --json`
provides a scriptable inventory. Import, keep, and discard are review decisions;
discard only tags an object.

### `purge`

Delete provider objects previously tagged `pixelkiln:discard`. It is separate
from salvage, lists targets, asks for confirmation, and refuses non-interactive
deletion without `--yes`. Use `--dry-run` first.

### `prune`

Remove lock entries no style/asset pair in the manifest resolves to. These
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

Show the provider's remaining balance and cost unit.

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
| `add <manifest>` | Registers a project. Id defaults to the manifest's `name`; `--name` overrides it. Lock defaults to `pixelkiln.lock.json` beside the manifest; `--lock` overrides it. Refuses a duplicate id or a lockfile already registered under another id. Warns, but does not refuse, when the lock does not exist yet. |
| `remove <id-or-manifest>` | Drops a registration by project id or by manifest path. Touches no art, no lock, no provider account. |
| `list` | Lists registered projects and catalog diagnostics. |
| `status` | Aggregate provider, spend-by-unit, plan state, and claim count, offline. Provider cost units are never summed across each other. |
| `claims` | Validates the catalog and emits the exact union of `objectId`/`reviewObjectId`/`jobId` across every registered lock. Refuses — rather than silently omitting a project — when any registered lock is missing, unreadable, or the catalog itself has a duplicate id or duplicate lock path. |

`--workspace <path>` selects the catalog file; it defaults to
`pixelkiln.workspace.json` in the current directory. Stored paths are relative
to the catalog file's own directory, so a catalog survives a clone or move.
`list`/`status` support `--json` and `--check` (nonzero exit on any error-level
diagnostic).

Passing `--workspace <path>` to `salvage` derives its claim set from the
catalog instead of a repeated `--claims` list; `--claims` still works and
unions with it. A missing or unreadable registered lock is a hard error there
too — never silently skipped — because it is precisely the account-wide claim
completeness this catalog exists to guarantee. See
[Recovery and account safety](./RECOVERY.md#shared-workspace-catalog).

## Local quality and derived output

### `audit`

Measure palette distance, transparent canvas share, and opaque color count for
every selected output. Structural sets are evaluated member-by-member.

```bash
pixelkiln audit --style neon --json --check \
  --max-distance 35 --min-transparency 0.1 --max-colors 128 --sigma 1.5
```

### `cache`

Inspect the local content cache and account object-hash cache. `--check` exits
nonzero for unsafe state. `--prune` removes malformed, corrupt, partial, and
unreferenced cache data; it does not delete provider objects.

### `pack`

Build a deterministic RGBA sprite sheet, JSON atlas, and `.pixelkiln.json`
provenance companion. Manifest mode reads lock outputs. Explicit-input mode
needs no manifest:

```bash
pixelkiln pack --style neon --columns 8
pixelkiln pack --inputs sprites.json --out dist/sheet
```

Use repeatable `--output-role` for structural members or `--primary-only` for
unambiguous single outputs. These modes are mutually exclusive.

### `mount`

Write sprites into manifest-declared cells, optionally over an existing base
sheet. Undeclared cells survive byte-for-byte; each declared cell is cleared
before its sprite is placed.

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
| `--budget <n>` | submit/gen | Refuse work above this provider-unit cost. |
| `--force` | gen/derived commands | Regenerate current work or explicitly take ownership of modified/unowned derived output. |
| `--dry-run` | supported mutating commands | Inspect without spending or mutating provider state. |
| `--json` | plan/doctor/audit/cache/status/salvage | Machine-readable stdout where supported. |
| `--check` | plan/audit/cache | Exit nonzero when selected state is unsafe. |
| `--yes`, `-y` | confirmed operations | Skip an interactive confirmation. |
| `--no-open` | pick/salvage | Do not automatically open the browser. |
| `--tag` | fetch/adopt | Also push tags after the command's primary work. |
| `--claims <paths>` | salvage | Other project lockfiles; repeatable and comma-separated. |
| `--workspace <path>` | workspace/salvage | Workspace catalog path; defaults to `pixelkiln.workspace.json`. On salvage, derives the claim set instead of repeated `--claims`. |
| `--all` | salvage dry run | List every unclaimed object rather than the first 30. |
| `--from <dir>` | init | Existing source tree to scan. |
| `--exclude <names>` | init | Directory/name fragments to exclude; repeatable. |
| `--generator <name>` | init | Generator assigned to the scaffolded style. |
| `--name <name>` | init | Project name for the scaffolded manifest. |
| `--write-prompts` | adopt | Recover provider prompts into the manifest. |
| `--port <n>` | pick/salvage | Local review server port; otherwise chooses a free port. |
| `--out <path>` | pack/export | Output base override. Export requires one selected tileset. |
| `--inputs <path>` | pack | JSON array of `{ id, path }`; requires `--out`. |
| `--columns <n>` | pack/export | Grid columns, 1–1024; default is near-square. |
| `--format <name>` | export | `generic` (default), `tiled`, or `godot`. |
| `--output-role <role>` | pack | Include named structural roles; repeatable. |
| `--primary-only` | pack | Include only unambiguous primary/single outputs. |
| `--max-distance <n>` | audit | Absolute palette-distance ceiling. |
| `--min-transparency <0..1>` | audit | Minimum transparent canvas share. |
| `--max-colors <n>` | audit | Maximum distinct opaque colors. |
| `--sigma <n>` | audit | Relative outlier cutoff; defaults to 1.5. |
| `--prune` | cache | Remove invalid and unreferenced cache data. |

## Exit and output contract

- Parse, schema, ownership, provider, and filesystem errors exit nonzero.
- `submit`, `poll`, `fetch`, and `gen` exit nonzero on partial failure or
  timeout; automation cannot mistake an incomplete batch for success.
- Human progress goes to stderr when `salvage --dry-run --json` reserves stdout
  for JSON.
- `plan --check`, `audit --check`, and `cache --check` are intended as CI gates.
- Commands that can spend or delete expose their scope before doing so; budget
  and confirmation are separate protections.
