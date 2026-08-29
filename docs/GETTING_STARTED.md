# Getting started

Pixelkiln turns a committed asset manifest into generated files with a
committed provenance lockfile. Planning, auditing, packing, mounting, and
exporting are local operations. Only generation, provider polling, candidate
selection, downloads, tagging, account adoption, salvage, purge, and balance
checks need provider access.

## Requirements

- Node.js 20 or newer
- A PixelLab API key for provider-backed commands
- A repository checkout until the first npm release in
  [issue #1](https://github.com/gfargo/pixelkiln/issues/1) is complete

From a checkout:

```bash
npm ci
npm run pixelkiln -- help
```

The rest of this guide uses `pixelkiln` for readability. In the checkout,
replace it with `npm run pixelkiln --`.

## Using an agent

Install the repository's PixelKiln skill when an agent will help operate the
workflow:

```bash
npx skills add gfargo/pixelkiln@pixelkiln
```

The skill teaches compatible agents to plan first, preserve provenance, and
use explicit budgets. It does not grant permission to spend provider credits;
you still approve the generation command and its hard `--budget` ceiling. See
[Agent workflows](AGENTS.md) for the full safety contract and example prompts.

## Start a new project

Copy the minimal manifest into the project root:

```bash
cp examples/minimal/pixelkiln.manifest.json pixelkiln.manifest.json
```

Set each style's generator, dimensions, prompt prefix/suffix, reference images,
and output directory. Then add one manifest entry per asset. Put the credential
in `.env.local` beside the manifest:

```dotenv
PIXELLAB_API_KEY=...
```

Before spending anything, validate and price the selected work:

```bash
pixelkiln doctor
pixelkiln plan
pixelkiln plan --style base --only anvil,hammer
```

Generate with a hard cap copied from the plan:

```bash
pixelkiln gen --style base --budget 120
```

The command submits jobs, polls them, opens the local review sheet when a
generator returns alternatives, downloads the selected images, and updates the
lockfile. In review, use Left/Right to browse every candidate, Enter to select,
1–9 for direct choices, 0 to leave a row unresolved, and Up/Down to change
rows. Closing the sheet without applying discards no provider objects.

![PixelKiln local candidate review UI](../website/public/review-ui-showcase.jpg)

The sheet is served only on localhost and selection remains human-controlled.
Only rows submitted with **Apply selections** are recorded; unresolved rows can
be reopened later with [`pixelkiln pick`](CLI.md#pick).

## Start from existing art

Scaffold the manifest from PNGs, then reconcile exact file hashes with the
provider account:

```bash
pixelkiln init --from assets/sprites --exclude characters,gifs --generator map
pixelkiln adopt --write-prompts
pixelkiln plan
```

`init` leaves prompts empty rather than inventing provenance. `adopt` recovers
the original prompts for exact byte matches. Locally retouched files remain
`untracked`; they are not silently overwritten or scheduled for paid
regeneration.

## Everyday workflow

```bash
# Free: inspect drift, missing files, recovery, and estimated spend.
pixelkiln plan

# Optional safety and quality checks.
pixelkiln doctor --dry-run
pixelkiln audit --check --max-distance 35 --min-transparency 0.1
pixelkiln cache --check

# Generate only the intended slice.
pixelkiln gen --style neon --only anvil,hammer --budget 80

# Rebuild missing files from provider URLs or the local content cache.
pixelkiln restore
```

Repeated `--style`, `--only`, `--claims`, and `--output-role` flags accumulate;
comma-separated values also work. Unknown flags are errors, so a misspelled
filter cannot accidentally widen a paid run.

## Automation

Use machine-readable planning and auditing as build gates:

```bash
pixelkiln plan --json --check
pixelkiln audit --json --check --max-distance 35 --max-colors 128
```

Both commands exit nonzero when the selected state is unsafe. Provider-backed
pipeline stages also exit nonzero after partial failures or timeouts.

## Recovery

- `restore` repairs missing generated outputs without buying new generations.
- `.pixelkiln/cache/` stores downloaded PNG bytes by SHA-256, so restoration can
  still work after a temporary provider URL expires.
- `cache --check` verifies hashes and fully decodes cached PNG structure before
  trusting recovery bytes, then validates the account object-hash cache.
  `cache --prune` removes corrupt, partial, and unreferenced project content
  plus invalid hash entries. It does not mistake
  objects belonging to another project for disposable account data.
- `adopt` maps existing local files to exact remote objects.
- `salvage --claims <every-other-lockfile>` reviews remote objects no project
  currently claims. `salvage` never deletes; `purge` is a separate confirmed
  operation.
- Pixelkiln refuses to overwrite a file whose bytes differ from its recorded
  hash. Resolve intentional hand edits explicitly.

## What belongs in Git

Commit:

- `pixelkiln.manifest.json`
- `pixelkiln.lock.json`
- generated art and any derived sheets/export metadata your application uses
- `.pixelkiln.json` provenance companions written beside managed sheets,
  mounted trees, and tileset exports

Do not commit:

- `.env` or `.env.local`
- `.pixelkiln/` caches, transaction journals, staging trees, and backups
- `pixelkiln.cache.json`

The caches are disposable performance and recovery aids. The manifest,
lockfile, output files, and provenance companions are the durable project
record. Lock output paths are manifest-relative, so that committed record
survives moving or cloning the project instead of pointing back to an old
machine's checkout. See [Artifacts and provenance](ARTIFACTS.md) for the
ownership and transaction model.
