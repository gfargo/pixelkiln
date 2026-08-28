# Recovery and account safety

PixelKiln separates local file recovery, account reconciliation, unclaimed-work
review, and irreversible deletion. A failed download never needs to become a
new paid generation, and salvage never deletes by implication.

## Restore missing output

```bash
pixelkiln restore
pixelkiln restore --style neon --only anvil
```

`restore` repairs a missing lock output from validated content-cache bytes or
the provider URL. It does not submit generation and refuses to replace a file
whose current bytes differ from the recorded hash.

Generation and download failures are separate lock states. A CDN failure after
successful generation becomes `download-failed`; the next `fetch` or `restore`
retries at zero generation cost.

## Local caches

Two ignored caches accelerate recovery:

- `.pixelkiln/cache/<sha256>.png`: content-addressed generated PNG bytes;
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
files.
