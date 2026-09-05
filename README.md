# pixelkiln

![PixelKiln](https://wp.griffen.codes/wp-content/uploads/2026/08/download.png)

[Website](https://pixelkiln.griffen.codes) · [Documentation](https://pixelkiln.griffen.codes/docs) · [GitHub](https://github.com/gfargo/pixelkiln)

Generate pixel art from a manifest, review it locally, recover paid work, and
package the accepted files for a game engine.

PixelKiln treats generated art as build output. Declare assets once, inspect the
cost and changed work, generate only what is missing, choose candidates in a
local contact sheet, and commit the source and output hashes. No LLM chooses
what to run or which image wins. The CLI handles provider calls, polling,
hashing, downloads, and file placement.

PixelLab is the production backend. Retro Diffusion, self-hosted ComfyUI, and
Scenario are experimental. The Retro Diffusion adapter has live coverage for
RD Fast and RD Plus stills; its multi-candidate, tileset, GIF, and spritesheet
paths are tested with fixtures but still need paid live runs. ComfyUI has passed
local generation, four-candidate review, cache recovery, and native-grid
refinement on Apple MPS. Its tested SDXL workflow can find a composition, but
it is not a finished pixel-art preset. Scenario has live-tested authentication,
CU preflight, single- and two-output generation, human review, and durable
restore with BFL Flux 2 Dev. It remains experimental. Styles may use different providers with separate
budget ceilings. The [provider comparison](./PROVIDERS.md) lists the tested limits
and best routes. `FakeProvider` covers the same contract in automated tests.

## Release

PixelKiln is published on npm. Merges to `main` use Semantic Release and npm
Trusted Publishing, with signed provenance and no long-lived npm token.

## Why PixelKiln

Image generators leave two piles behind: remote jobs that cost money and local
files that no longer explain where they came from. Prompts drift. Failed
downloads look like failed generations. Teams rerun whole sets because they
cannot tell which asset changed.

PixelKiln keeps the missing record:

- a committed manifest defines assets, styles, generators, budgets, and output;
- a committed lockfile maps each style/asset to paid provider work and exact
  output hashes;
- planning distinguishes missing, stale, recoverable, in-flight, untracked, and
  manually changed files before money is spent;
- local review keeps human judgment where it matters, choosing artwork;
- content-addressed recovery prevents a transient URL failure from buying the
  same image twice;
- derived artifact bundles retain source provenance and recover across ordinary
  write failures or abrupt process termination.

## Capabilities

| Workflow | What PixelKiln provides |
|---|---|
| Plan and budget | Offline manifest/lock/disk diff, provider-grouped estimates, keyed mixed-provider budget ceilings, JSON/CI gate. |
| Generate and review | Resumable submit/poll/pick/fetch pipeline with a fast local candidate sheet. |
| Existing-art onboarding | Manifest scaffolding, exact-hash account adoption, and prompt recovery. |
| Recovery | Validated local content cache, durable provider-reference restore, account object-hash cache, and resumable jobs. |
| Shared-account safety | Cross-project claim files or a registered workspace catalog, sibling-style exclusion, reviewed salvage, keep/discard tags, separate confirmed purge. |
| Quality control | Palette distance, transparency, color-count, relative outlier, cache-integrity, and doctor gates. |
| Sprite packaging | Deterministic RGBA packing, stable-cell mounting, explicit external input lists, structural output roles. |
| Engine export | Lossless generic tile contract, Tiled Wang sets, and Godot 4 terrain sets. |
| Artifact integrity | Portable source/output hashes, canonical fingerprints, manual-edit protection, transactional promotion, crash journal recovery. |
| Library/extension | Public TypeScript primitives, provider capability interface, and deterministic `FakeProvider`. |

### Local human review

`pixelkiln pick` opens an actual local candidate sheet; the orchestration layer
never asks a model to choose artwork for you.

![PixelKiln candidate review UI](./website/public/review-ui-showcase.jpg)

Use Left/Right to inspect alternatives, Enter or 1–9 to select, and 0 to leave
a row unresolved. Nothing is applied when the window is closed without using
**Apply selections**. See the [CLI reference](docs/CLI.md#pick) for the full
review workflow.

## Install

Requires Node.js 22 or newer. Use the latest Node.js 24 LTS release for local
development.

```bash
npm install --save-dev pixelkiln
npx pixelkiln --help
```

For library use, both `import("pixelkiln")` and `require("pixelkiln")` are
supported. Contributors can still run `npm run pixelkiln -- …` from a checkout
to execute the TypeScript source directly.

## Five-minute start

Copy the minimal example into a project and edit its output path and prompts:

```bash
cp examples/minimal/pixelkiln.manifest.json ../my-game/pixelkiln.manifest.json
cd ../my-game
```

Put a hosted provider's credential in `.env.local` beside the manifest:

```dotenv
# PixelLab (the default provider)
PIXELLAB_API_KEY=...
# Or Retro Diffusion when `provider` is `retrodiffusion`
RD_API_KEY=...
# Scenario needs both values when `provider` is `scenario`
SCENARIO_SDK_API_KEY=...
SCENARIO_SDK_API_SECRET=...
# Self-hosted ComfyUI needs no key; override its local URL only when needed
COMFYUI_BASE_URL=http://127.0.0.1:8188
```

Validate locally, inspect exact work/cost, then generate with a hard ceiling:

```bash
npx pixelkiln doctor --dry-run
npx pixelkiln plan
npx pixelkiln gen --budget 120
```

`gen` submits, polls, opens the candidate-review sheet when necessary,
downloads validated output, populates the recovery cache, and updates
`pixelkiln.lock.json`. Commit the manifest, lockfile, generated art, and any
derived artifact companions. Do not commit credentials or `.pixelkiln/`.

For an existing art tree:

```bash
pixelkiln init --from assets/sprites --exclude characters,gifs --generator map
pixelkiln adopt --write-prompts
pixelkiln plan
```

See [Getting started](./docs/GETTING_STARTED.md) for new and existing projects.
Use [Set up PixelLab](./docs/PIXELLAB.md),
[Set up Retro Diffusion](./docs/RETRO_DIFFUSION.md),
[Set up ComfyUI](./docs/COMFYUI.md), or
[Set up Scenario](./docs/SCENARIO.md) for provider-specific configuration,
manifest examples, and current limits. See [Mixed-provider projects](./docs/MIXED_PROVIDERS.md)
when styles in one manifest need different backends.

## Agent skill

Install the official PixelKiln skill so Codex, Claude Code, Cursor, and other
compatible agents know the safe plan → budget → generate → review → recover
workflow:

```bash
npx skills add gfargo/pixelkiln@pixelkiln
```

The skill guides an agent around PixelKiln; it does not replace a generation
provider. PixelLab's MCP server is a complementary direct-generation surface,
while PixelKiln remains the project state, budget, provenance, review, and
packaging layer.

## Manifest

```jsonc
{
  "$schema": "./node_modules/pixelkiln/schema/manifest.schema.json",
  "name": "my-game",
  "provider": "pixellab",
  "styles": {
    "base": {
      "generator": "map",
      "promptPrefix": "Pixel-art game prop: ",
      "promptSuffix": ", isolated, transparent background",
      "outDir": "assets/generated/base",
      "tags": ["my-game"]
    }
  },
  "assets": {
    "anvil": { "prompt": "a compact blacksmith anvil" },
    "hammer": { "prompt": "a worn forging hammer" }
  }
}
```

Styles are namespaces. Adding a second style re-derives the same asset ids into
a separate output directory and separate lock keys without clobbering the first
set. Generator choice, reference-image bytes, dimensions, palette, seed, and
prompt settings participate in deterministic spec identity. A manifest may
select another provider and pass namespaced `providerOptions`; see
[Set up PixelLab](./docs/PIXELLAB.md),
[Set up Retro Diffusion](./docs/RETRO_DIFFUSION.md),
[Set up ComfyUI](./docs/COMFYUI.md), and
[Set up Scenario](./docs/SCENARIO.md). The
[provider comparison](./PROVIDERS.md) covers costs,
current confidence, and limitations. The committed ComfyUI projects now include
transparent cutouts, palette-controlled backgrounds, wide environment canvases,
and native-grid recovery for model output that only looks like pixel art. The
ComfyUI guidance is quality-first: start with 48–128px native components,
apply the final palette after grid recovery, require prompt-coverage and human
cluster-and-silhouette review, and compose larger scenes from accepted parts
instead of chasing a larger raster. Background removal and the art decision
still need the graph and a person. `pixelkiln refine` now handles grid recovery,
final palette enforcement, measurable checks, and the hash-bound approval
record.

Versioned recipes capture tested workflows, model hashes, license links, and
manifest-ready styles with quality boundaries. Start with `pixelkiln recipe install comfyui/pixel-art-xl-environment@1.0.0`.
Recipes install no models and make no provider calls. See [Versioned recipes](./docs/RECIPES.md).

The schema rejects unknown fields and invalid generator combinations before
planning. See the [Manifest reference](./docs/MANIFEST.md).

## Everyday workflow

```bash
# Free: validate and inspect drift, recovery, and estimated spend.
pixelkiln doctor --dry-run
pixelkiln plan

# Generate only an intended slice with a provider-unit ceiling.
pixelkiln gen --style base --only anvil,hammer --budget 80

# Repair paid output without regenerating.
pixelkiln restore

# Optional local gates.
pixelkiln audit --check --max-distance 35 --min-transparency 0.1
pixelkiln cache --check

# Provider-neutral pixel cleanup after selecting a generated candidate.
pixelkiln refine --from candidate.png --out art/native.png \
  --palette "#141b1e,#23312a,#384d4f,#526a8d,#709fcf,#865c45,#c6a766,#f1bb70"
pixelkiln refine approve --from art/native.pixelkiln.json --reviewer "Your Name"
pixelkiln refine check --from art/native.pixelkiln.json
```

Repeated `--style`, `--only`, `--claims`, and `--output-role` filters
accumulate; comma-separated values also work. Unknown flags are hard errors, so
a typo cannot silently widen paid work.

## Choose the right generator

Measured PixelLab economics vary by 40×:

| Need | Generator | Measured cost |
|---|---|---:|
| Standalone arbitrary-size prop/icon | `map` (default) | 1 generation |
| Exact closed palette | `pixflux` | 1 generation |
| Candidate variety/reference anchoring/future animation | `1dir` | 20–40 generations |
| Independent or connectable ground tiles | `tiles` | 20–40 generations |

Start with the required capability, not the most expensive endpoint. Forty
`map` re-rolls cost the same as one 64×64 `1dir` call; conversely, `map` cannot
replace a hard palette or reference-image constraint. See
[Generator selection](./docs/GENERATORS.md) and the
[measured endpoint reference](./docs/ENDPOINTS.md).

Generator names describe PixelKiln workflows; their exact capabilities and
prices depend on the selected provider. Retro Diffusion also supports the
provider-specific `animation` generator. ComfyUI currently supports `map`
through an operator-supplied workflow. Scenario currently supports `map`
with a required offline CU ceiling and a live quote before each paid call.
Compare the adapters in the [provider comparison](./PROVIDERS.md).

## Derived artifacts

```bash
# Deterministic sheet + atlas + provenance.
pixelkiln pack --style base
# Stable declared cells in an existing sheet.
pixelkiln mount --style ground
# Structural atlas + engine metadata + provenance.
pixelkiln export --style ground --only terrain --format tiled
```

Pack, mount, and export write managed bundles. A `.pixelkiln.json` companion
records portable source paths/hashes, layout/export options, output hashes, and
a canonical fingerprint. Existing unowned output is adopted only when already
byte-identical; manual edits stop the whole write unless `--force` explicitly
takes ownership.

All changing members stage before promotion. Ordinary failures roll back.
Abrupt termination leaves a validated transaction journal: the next invocation
restores an incomplete old bundle or finishes cleanup for a committed new one.
See [Derived artifacts](./docs/ARTIFACTS.md) and
[Tiles and engine exports](./docs/TILES.md).

## Recovery and shared accounts

```bash
# Reconcile existing files with account objects.
pixelkiln adopt --write-prompts

# Review paid account objects no known project claims.
pixelkiln salvage --claims ../other-game/pixelkiln.lock.json --dry-run
pixelkiln salvage --claims ../other-game/pixelkiln.lock.json

# Deletion is deliberately separate and confirmed.
pixelkiln purge --dry-run
pixelkiln purge
```

Salvage imports, keeps, or tags discard; it never deletes. On shared accounts,
pass every other project lockfile via `--claims`, or register siblings once in
a workspace catalog and pass `--workspace`, so shipped art cannot appear
unowned:

```bash
pixelkiln workspace add ../other-game/pixelkiln.manifest.json
pixelkiln workspace status
pixelkiln salvage --workspace pixelkiln.workspace.json
```

A registered project's missing or unreadable lockfile is a hard error for
`workspace claims` and `salvage --workspace`. Missing claims are never skipped.
Purge only targets objects already tagged discard and requires an explicit
confirmation.
See [Recovery and account safety](./docs/RECOVERY.md).

## Automation

```bash
pixelkiln doctor --dry-run --json
pixelkiln plan --json --check
pixelkiln audit --json --check --max-distance 35 --max-colors 128
pixelkiln cache --check
```

Pipeline stages exit nonzero after partial failures or timeouts. JSON modes
separate machine output from human diagnostics where necessary. Generation
should remain an explicit budgeted action; CI should prove committed state and
artifacts agree rather than regenerate them. See
[Quality and automation gates](./docs/QUALITY.md).

## TypeScript library

```ts
import {
  buildPlan,
  loadLock,
  loadManifest,
  resolveSpecs,
} from "pixelkiln"
const loaded = await loadManifest("pixelkiln.manifest.json")
const specs = await resolveSpecs(loaded)
const plan = await buildPlan(specs, await loadLock("pixelkiln.lock.json"))
console.log(plan.groups, plan.actionable.length)
```

The package also exports audit and image-regression gates, provider-neutral refinement, lock/output
helpers, provider contracts, pipeline stages, sprite packing/mounting, tile
exporters, managed artifact writes, and offline provenance verification. See
[Library API](./docs/LIBRARY.md).

## Documentation

| Guide | Covers |
|---|---|
| [Documentation index](./docs/README.md) | All user, workflow, reference, and architecture guides. |
| [Getting started](./docs/GETTING_STARTED.md) | First project, existing-art onboarding, everyday workflow, and what to commit. |
| [Set up PixelLab](./docs/PIXELLAB.md) | Production-provider credentials, manifest, generators, and account workflows. |
| [Set up Retro Diffusion](./docs/RETRO_DIFFUSION.md) | Experimental-provider credentials, styles, formats, cost checks, and limits. |
| [Set up ComfyUI](./docs/COMFYUI.md) | Experimental self-hosted server, workflow bindings, local cost semantics, and limits. |
| [Set up Scenario](./docs/SCENARIO.md) | Experimental hosted models, two-part credentials, CU preflight, review, and durable downloads. |
| [Versioned recipes](./docs/RECIPES.md) | Pinned workflow packs, model hashes, manifest templates, and quality contracts. |
| [CLI reference](./docs/CLI.md) | Every command, flag, JSON mode, and exit contract. |
| [Manifest reference](./docs/MANIFEST.md) | Every style/asset field and generator constraint. |
| [Mixed-provider projects](./docs/MIXED_PROVIDERS.md) | Per-style routing, provider-keyed budgets, recovery, and account commands. |
| [Agent workflows](./docs/AGENTS.md) | Official skill install, operating model, and provider-aware safety. |
| [Generators](./docs/GENERATORS.md) | Capability choice, measured costs, palettes, style references, and tiles. |
| [Environment provider benchmark](./docs/PROVIDER_BENCHMARK.md) | Thirty provider outputs plus native-grid and final-palette results comparing large scenes, transparency, palette size, and file readiness. |
| [Derived artifacts](./docs/ARTIFACTS.md) | Refine, pack, mount, export, provenance, ownership, transactions, and recovery. |
| [Recovery](./docs/RECOVERY.md) | Restore, caches, adopt, salvage, claims, and purge safety. |
| [Quality gates](./docs/QUALITY.md) | Image baselines, plan, doctor, refine, audit, cache, human approval, JSON, and CI. |
| [Architecture](./docs/ARCHITECTURE.md) | State model, lockfile, providers, concurrency, and output identity. |
| [Library API](./docs/LIBRARY.md) | Public TypeScript contracts and examples. |
| [Tiles](./docs/TILES.md) | Structural outputs and generic/Tiled/Godot formats. |
| [Endpoint research](./docs/ENDPOINTS.md) | Measured PixelLab API behavior and recipes. |
| [Provider comparison](./PROVIDERS.md) | Provider selection, costs, supported workflows, confidence, and limitations. |

The [public documentation site](https://pixelkiln.griffen.codes/docs) is built by
the application in [`website/`](./website/README.md). It reads these Markdown
files directly at build time, so the website and published package share one
documentation source.

Project policies: [Contributing](./CONTRIBUTING.md),
[Security](./SECURITY.md), and [provider comparison](./PROVIDERS.md).

## Scope

Animated eight-direction characters and their ZIP/engine-resource export are
not currently implemented. Cross-project content-cache reuse and
`workspace find <hash|asset-id>` are deferred beyond the current read-only
workspace catalog. See the open
[roadmap issues](https://github.com/gfargo/pixelkiln/issues) for additional
provider adapters and this remaining workspace work.

## License

[MIT](./LICENSE)
