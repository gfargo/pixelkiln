# Recovery and account safety

PixelKiln separates local file recovery, account reconciliation, unclaimed-work
review, and irreversible deletion. A failed download never needs to become a
new paid generation, and salvage never deletes by implication.

## Restore missing output

```bash
pixelkiln restore
pixelkiln restore --style neon --only anvil
```

`restore` repairs a missing lock output from validated content-cache bytes or a
durable provider reference. It does not submit generation and refuses to
replace a file whose current bytes differ from the recorded hash.

Generation and download failures are separate lock states. A CDN failure after
successful generation becomes `download-failed`; the next `fetch` or `restore`
retries at zero generation cost.

Use the lock state rather than guessing which stage to rerun:

| State | Safe next command |
|---|---|
| incomplete submission checkpoint | `pixelkiln submit` |
| complete `pending` or `processing` submission | `pixelkiln poll` |
| `review` | `pixelkiln pick` |
| `selected` or `download-failed` | `pixelkiln fetch` |
| downloaded output is missing | `pixelkiln restore` |

`plan`, `doctor`, and completed stages print these remaining actions. If a
manifest change causes a deliberate regeneration, PixelKiln carries the old
output hash until the replacement is fetched. An unchanged PixelKiln-owned file
can then be replaced automatically. A hand-edited or untracked destination is
still refused; after inspecting it, `pixelkiln fetch --force` explicitly lets
the new result take ownership. This also recovers interrupted jobs created by
older PixelKiln versions that could not retain the prior output hash.

ComfyUI frame sets submit one prompt per frame. PixelKiln saves the compound
job after every accepted prompt, before asking ComfyUI to queue the next one.
If submission stops halfway through, `plan` reports the saved checkpoint and
`pixelkiln submit` continues at the first missing frame. `poll` will not advance
an incomplete set into review. A changed prompt, workflow, input image, seed
schedule, or other spec identity starts a fresh set instead of appending to old
prompt ids.

Provider adapters should keep expiring signed result URLs transient and store a
provider-neutral reference that can refresh them. Once ingestion succeeds,
PixelKiln removes credential-bearing URLs, inline data URLs, and local file URLs
from the lock entry. A failed download temporarily retains its source so a local
retry remains possible; do not commit that in-flight lockfile.

## Local caches

Two ignored caches accelerate recovery:

- `.pixelkiln/cache/<sha256>.png` or `<sha256>.gif`: content-addressed,
  structurally validated generated media bytes;
- `pixelkiln.cache.json`: provider object id → remote image hash.

```bash
pixelkiln cache
pixelkiln cache --check
pixelkiln cache --prune
```

Cache checks verify filenames/hashes and fully decode PNG chunks, checksums,
palettes, scanlines, and decompressed size. Pruning removes corrupt/partial and
unreferenced content plus malformed object-hash entries. Caches are disposable
and should not be committed.

## Adopt existing art

```bash
pixelkiln init --from assets/sprites --generator map
pixelkiln adopt --write-prompts
```

`adopt` hashes local files and provider objects, then maps exact matches into
the lockfile. `--write-prompts` recovers the real upstream prompts. Retouched
files remain `untracked`: provenance is unknown, but the art is not overwritten
or automatically scheduled for paid regeneration.

The account object-hash cache avoids repeated full downloads. It is pruned for
deleted remote ids only after `adopt` has seen the provider's complete object
list.

## Salvage unclaimed work

An account can contain paid objects that no current project lockfile claims.
Inventory them before generating replacements:

```bash
pixelkiln salvage --claims ../other-project/pixelkiln.lock.json --dry-run
pixelkiln salvage --claims ../other-project/pixelkiln.lock.json
```

On shared accounts, supply every other project lockfile with repeatable
`--claims`. Missing claim files are errors. PixelKiln loads sibling manifests
where available to recognize another project's style patterns; incomplete
claims could otherwise make shipped art look unowned.

Multi-style manifests group matching objects into one review session per style.
Unmatched objects are listed separately. `--style` deliberately overrides
grouping when a human wants to force one destination.

Review verdicts:

| Verdict | Effect |
|---|---|
| import | Download, add a manifest asset and lock entry, and recover its prompt. |
| keep | Add `pixelkiln:keep` upstream; no local change. |
| discard | Add `pixelkiln:discard`; does not delete. |

`--dry-run --all` lists the full inventory. `--dry-run --json` writes the JSON
array to stdout and human diagnostics to stderr for piping into `jq`.

Imported ids are derived from prompts and land under `_salvaged/`; review and
rename them before treating them as stable application ids.

## Shared workspace catalog

For a single project, its own lockfile is the whole claim set. On a shared
account with several sibling projects, repeating `--claims` on every salvage
run is easy to get wrong. A forgotten lockfile makes another project's paid
art look unclaimed. `workspace` fixes that by registering every sibling once,
outside any one manifest:

```bash
pixelkiln workspace add ../other-game/pixelkiln.manifest.json
pixelkiln workspace add ../another-game/pixelkiln.manifest.json --name another
pixelkiln workspace status
pixelkiln workspace claims
```

`workspace status` reports each project's effective providers, spend-by-unit,
and plan state offline. `workspace claims` validates the catalog and emits the
exact union of provider-qualified `objectId`/`reviewObjectId`/`jobId` claims
across every registered lock. Qualifying the IDs prevents two providers that
reuse the same remote identifier from colliding. This is the same union rule
`--claims` uses, so the two paths cannot drift.

A registered lockfile that is missing or unreadable is a hard error for
`claims`, never a silent skip: an incomplete claim set is precisely what makes
another project's shipped art look orphaned. `workspace add` still lets you
register a brand-new project before its first `gen`. It warns rather than
refusing because the project has no lock yet, but `claims` and
`salvage --workspace` both refuse until every registered project has one.

Salvage accepts the catalog directly instead of a repeated `--claims` list:

```bash
pixelkiln salvage --workspace pixelkiln.workspace.json --dry-run
pixelkiln salvage --workspace pixelkiln.workspace.json
```

`--claims` still works and unions with a workspace's claim set. This helps a
one-off lockfile that isn't part of the catalog. Choose one workflow per
account: `--claims` for an occasional cross-project check, `workspace` once
sibling projects are a standing arrangement worth registering once.

The catalog stores paths and project identity, never a credential. Each
project still loads its own provider key from its own `.env`. `workspace
remove` only edits the catalog file; it never touches art, a lock, or the
provider account.

In a mixed-provider manifest, account-wide operations require an explicit
backend: for example, `salvage --provider retrodiffusion` or `adopt --provider
pixellab`. The selected operation only sees styles and lock entries for that
provider. Restore does not need the flag because each lock entry already records
where its work came from.

## Confirmed purge

Deletion is a separate command:

```bash
pixelkiln purge --dry-run
pixelkiln purge
pixelkiln purge --yes
```

Only objects already tagged `pixelkiln:discard` are eligible. The command lists
targets, asks interactively, and refuses non-interactive deletion without
`--yes`. A shared account should be fully adopted/salvaged before purge.

## Accept intentional spec prose changes

```bash
pixelkiln accept --style base --only anvil
```

`accept` re-baselines an intact output against the current spec hash when prose
changed but the existing pixels are intentionally retained. It does not modify
art and skips missing or hash-mismatched files.

## Derived output recovery

Pack, mount, and export bundles have a separate ownership and crash-recovery
system based on `.pixelkiln.json` companions and transaction journals. See
[derived artifacts](./ARTIFACTS.md).

## What to commit

Commit manifests, lockfiles, generated art, derived output used by the
application, and its `.pixelkiln.json` companions. Do not commit credentials,
`.pixelkiln/`, `pixelkiln.cache.json`, or short-lived transaction/stage/backup
files. In the PixelKiln repository, `npm run test:security` rejects tracked JSON
that contains a credential-bearing URL.
