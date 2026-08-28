# pixelkiln

![PixelKiln](https://wp.griffen.codes/wp-content/uploads/2026/08/download.png)

Manifest-driven pixel-art generation, review, recovery, quality control, and
game-ready asset packaging.

PixelKiln treats generated art like a build pipeline: declare assets once,
preview cost and drift, generate only the missing work, review candidates in a
local contact sheet, and commit exact provenance beside the files. No LLM is in
the orchestration loop; provider calls, polling, hashing, downloads, and filing
are deterministic software mechanics.

> **Release status:** the package is pre-1.0 and the first npm publication is
> tracked in [issue #1](https://github.com/gfargo/pixelkiln/issues/1). Until it
> is live, use a repository checkout.

## Why PixelKiln

A typical image-generation account becomes two unrelated piles: remote objects
that cost money and local files with no durable explanation of where they came
from. Handwritten prompts drift, failed downloads look like failed generations,
and regenerating a whole set is easier than determining what is actually stale.

PixelKiln supplies the missing project model:

- a committed manifest defines assets, styles, generators, budgets, and output;
- a committed lockfile maps each style/asset to paid provider work and exact
  output hashes;
- planning distinguishes missing, stale, recoverable, in-flight, untracked, and
  manually changed files before money is spent;
- local review keeps human judgment where it matters—choosing artwork;
- content-addressed recovery prevents a transient URL failure from buying the
  same image twice;
- derived artifact bundles retain source provenance and recover across ordinary
  write failures or abrupt process termination.

## Capabilities

| Workflow | What PixelKiln provides |
|---|---|
| Plan and budget | Offline manifest/lock/disk diff, provider-unit estimates, hard `--budget` ceiling, JSON/CI gate. |
| Generate and review | Resumable submit/poll/pick/fetch pipeline with a fast local candidate sheet. |
| Existing-art onboarding | Manifest scaffolding, exact-hash account adoption, and prompt recovery. |
| Recovery | Validated local content cache, provider URL restore, account object-hash cache, and resumable jobs. |
| Shared-account safety | Cross-project claim files, sibling-style exclusion, reviewed salvage, keep/discard tags, separate confirmed purge. |
| Quality control | Palette distance, transparency, color-count, relative outlier, cache-integrity, and doctor gates. |
| Sprite packaging | Deterministic RGBA packing, stable-cell mounting, explicit external input lists, structural output roles. |
| Engine export | Lossless generic tile contract, Tiled Wang sets, and Godot 4 terrain sets. |
| Artifact integrity | Portable source/output hashes, canonical fingerprints, manual-edit protection, transactional promotion, crash journal recovery. |
| Library/extension | Public TypeScript primitives, provider capability interface, and deterministic `FakeProvider`. |

## Install from a checkout

Requires Node.js 20 or newer.

```bash
git clone https://github.com/gfargo/pixelkiln.git
cd pixelkiln
npm ci
npm run pixelkiln -- help
npm test
```

`npm run pixelkiln -- …` executes the TypeScript source. `npm run build`
creates the ESM, CommonJS, declarations, and CLI distribution used by the
published package.

## Five-minute start

Copy the minimal example into a project and edit its output path and prompts:

```bash
cp examples/minimal/pixelkiln.manifest.json ../my-game/pixelkiln.manifest.json
cd ../my-game
```

Put the provider credential in `.env.local` beside the manifest:

```dotenv
PIXELLAB_API_KEY=...
```

Validate locally, inspect exact work/cost, then generate with a hard ceiling:

```bash
/path/to/pixelkiln/node_modules/.bin/tsx /path/to/pixelkiln/src/cli.ts doctor --dry-run
/path/to/pixelkiln/node_modules/.bin/tsx /path/to/pixelkiln/src/cli.ts plan
/path/to/pixelkiln/node_modules/.bin/tsx /path/to/pixelkiln/src/cli.ts gen --budget 120
```

Once installed from npm, those commands become `pixelkiln doctor`,
`pixelkiln plan`, and `pixelkiln gen`.

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

## Manifest

```jsonc
{
  "$schema": "./node_modules/pixelkiln/schema/manifest.schema.json",
  "name": "my-game",
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
prompt settings participate in deterministic spec identity.

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
pass every other project lockfile via `--claims` so shipped art cannot appear
unowned. Purge only targets objects already tagged discard and requires an
explicit confirmation. See [Recovery and account safety](./docs/RECOVERY.md).

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
  PixelLabProvider,
  resolveSpecs,
} from "pixelkiln"

const loaded = await loadManifest("pixelkiln.manifest.json")
const provider = PixelLabProvider.forOffline()
const specs = await resolveSpecs(loaded, { provider })
const plan = await buildPlan(specs, await loadLock("pixelkiln.lock.json"))

console.log(plan.cost, plan.costUnit, plan.actionable.length)
```

The package also exports audit gates, lock/output helpers, provider contracts,
pipeline stages, sprite packing/mounting, tile exporters, managed artifact
writes, and offline provenance verification. See [Library API](./docs/LIBRARY.md).

## Documentation

| Guide | Covers |
|---|---|
| [Documentation index](./docs/README.md) | All user, workflow, reference, and architecture guides. |
| [Getting started](./docs/GETTING_STARTED.md) | First project, existing-art onboarding, everyday workflow, and what to commit. |
| [CLI reference](./docs/CLI.md) | Every command, flag, JSON mode, and exit contract. |
| [Manifest reference](./docs/MANIFEST.md) | Every style/asset field and generator constraint. |
| [Generators](./docs/GENERATORS.md) | Capability choice, measured costs, palettes, style references, and tiles. |
| [Derived artifacts](./docs/ARTIFACTS.md) | Pack, mount, export, provenance, ownership, transactions, and recovery. |
| [Recovery](./docs/RECOVERY.md) | Restore, caches, adopt, salvage, claims, and purge safety. |
| [Quality gates](./docs/QUALITY.md) | Plan, doctor, audit, cache, JSON, and CI. |
| [Architecture](./docs/ARCHITECTURE.md) | State model, lockfile, providers, concurrency, and output identity. |
| [Library API](./docs/LIBRARY.md) | Public TypeScript contracts and examples. |
| [Tiles](./docs/TILES.md) | Structural outputs and generic/Tiled/Godot formats. |
| [Endpoint research](./docs/ENDPOINTS.md) | Measured PixelLab API behavior and recipes. |

Project policies: [Contributing](./CONTRIBUTING.md),
[Security](./SECURITY.md), and [provider notes](./PROVIDERS.md).

## Scope

Animated eight-direction characters and their ZIP/engine-resource export are not
currently implemented. See the open
[roadmap issues](https://github.com/gfargo/pixelkiln/issues) for provider and
workspace-catalog work.

## License

[MIT](./LICENSE)
