# Getting started

PixelKiln reads a committed asset manifest and records generated files in a
committed lockfile. Planning, auditing, packing, mounting, and exporting stay
local. Generation and account commands connect to the selected provider.

## Requirements

- Node.js 22 or newer. Node.js 24 LTS is the recommended default.
- A credential for the selected hosted provider: `PIXELLAB_API_KEY` for
  PixelLab, `RD_API_KEY` for Retro Diffusion, or both
  `SCENARIO_SDK_API_KEY` and `SCENARIO_SDK_API_SECRET` for Scenario.
  Self-hosted ComfyUI needs a reachable server instead of an API key.

Install the published package in the project that owns the art:

```bash
npm install --save-dev pixelkiln
npx pixelkiln --help
```

The rest of this guide uses `pixelkiln` for readability. With a project-local
installation, prefix commands with `npx` or call them from an npm script.

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
and output directory. Then add one manifest entry per asset. For PixelLab, put
the credential in `.env.local` beside the manifest:

```dotenv
PIXELLAB_API_KEY=...
```

For experimental Retro Diffusion generation, set the manifest's
top-level `provider` to `retrodiffusion` and use:

```dotenv
RD_API_KEY=...
```

Its still, tileset-sheet, animated-GIF, and PNG-spritesheet workflows are
implemented. Authenticated single-candidate RD Fast and RD Plus stills have
passed from quote through validated download, provenance, and cache.
Multi-candidate, tileset, GIF, and spritesheet live runs remain, so PixelLab
remains the production adapter. See
[Manifest reference](MANIFEST.md#experimental-retro-diffusion) for
provider options and current limits, or
[provider comparison](../PROVIDERS.md) for selection guidance.

For experimental Scenario still generation, use both credentials:

```dotenv
SCENARIO_SDK_API_KEY=...
SCENARIO_SDK_API_SECRET=...
```

Scenario also requires a model ID and a conservative per-asset Compute Unit
ceiling in the manifest. Its quote, async job, review, download, and recovery
paths are mock-tested. BFL Flux 2 Dev has also passed paid single- and two-output
generation, human review, and provider-backed recovery. Start with
[Set up Scenario](SCENARIO.md), one disposable asset, and a small budget.

For self-hosted generation, set `provider` to `comfyui`, commit an API-format
workflow, and bind the inputs PixelKiln may replace. Local ComfyUI jobs use a
zero `free` budget, which describes the lack of a metered provider charge, not
the cost of hardware or electricity. ComfyUI is not the shortest path to
game-ready pixel art: use it only when local control justifies manual grid
recovery, palette enforcement, and art review. See [Set up ComfyUI](COMFYUI.md).
The bundled environment recipe can install the tested graph and print its
manifest style entry without making a provider call:

```bash
pixelkiln recipe install comfyui/pixel-art-xl-environment@1.0.0
```

To revise an existing square asset, install the separate
`comfyui/pixel-art-xl-img2img` recipe and declare `asset.revision`. Keep the
parent and child as different asset ids. PixelKiln blocks the child until the
exact parent bytes are current and, when a quality profile exists, approved.
See [Controlled asset revisions](REVISIONS.md).

Verify an installed recipe's workflow and the workstation's model bytes before
generation. See
[Versioned recipes](RECIPES.md).

The provider setup guides give the shortest path for
[PixelLab](PIXELLAB.md), [Retro Diffusion](RETRO_DIFFUSION.md), and
[ComfyUI](COMFYUI.md), plus the experimentally live-tested
[Scenario](SCENARIO.md) adapter.
If one project needs several, set `provider` on the styles that differ from the
top-level default. One lockfile can retain all of their provenance. See
[Mixed-provider projects](MIXED_PROVIDERS.md).

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

For a run spanning several providers, pass one named ceiling per provider:

```bash
pixelkiln gen --budget pixellab=12 --budget scenario=60 --budget comfyui=0
```

The command submits jobs, polls them, opens the local review sheet when a
generator returns alternatives, downloads the selected images, and updates the
lockfile. In review, use Left/Right to browse every candidate, Enter to select,
1–9 for direct choices, 0 to leave a row unresolved, and Up/Down to change
rows. The page preserves non-square aspect ratios, fits large candidates, and
keeps the review surface readable on ultrawide displays. Closing the sheet
without applying discards no provider objects.

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

# When the style declares quality, build and verify its final PNGs.
pixelkiln refine --style neon
pixelkiln refine check --style neon

# Rebuild missing files from durable provider references or the local content cache.
pixelkiln restore
```

Manifest refinement prints one record path for each new result. Inspect that PNG
at 1× and integer zoom, then run `pixelkiln refine approve --from <record>
--reviewer <name>` before expecting the check or packaging to pass.

Repeated `--style`, `--only`, `--claims`, and `--output-role` flags accumulate;
comma-separated values also work. Unknown flags are errors, so a misspelled
filter cannot accidentally widen a paid run.

## Automation

Use machine-readable planning and auditing as build gates:

```bash
pixelkiln plan --json --check
pixelkiln refine check --style neon --json
pixelkiln audit --json --check --max-distance 35 --max-colors 128
```

Both commands exit nonzero when the selected state is unsafe. Provider-backed
pipeline stages also exit nonzero after partial failures or timeouts.

## Recovery

- `restore` repairs missing generated outputs without buying new generations.
- `.pixelkiln/cache/` stores downloaded PNG bytes by SHA-256, so restoration can
  still work after a temporary provider URL expires. Hosted adapters keep
  refreshable references in the lock instead of signed storage URLs.
- `cache --check` verifies hashes and structurally validates cached PNG/GIF
  media before trusting recovery bytes, then validates the account object-hash cache.
  `cache --prune` removes corrupt, partial, and unreferenced project content
  plus invalid hash entries. It does not mistake
  objects belonging to another project for disposable account data.
- `adopt` maps existing local files to exact remote objects.
- `salvage --claims <every-other-lockfile>` reviews remote objects no project
  currently claims. `salvage` never deletes; `purge` is a separate confirmed
  operation.
- PixelKiln refuses to overwrite a file whose bytes differ from its recorded
  hash. Resolve intentional hand edits explicitly.

## What belongs in Git

Commit:

- `pixelkiln.manifest.json`
- `pixelkiln.lock.json`
- generated art and any derived sheets/export metadata your application uses
- `.pixelkiln.json` provenance companions written beside refined art, managed
  sheets, mounted trees, and tileset exports

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
