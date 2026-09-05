# PixelKiln documentation

Start with the workflow guide, then open the reference for the command or
provider you are using. These Markdown files also render at
[pixelkiln.griffen.codes/docs](https://pixelkiln.griffen.codes/docs).

## Start here

| Guide | Use it for |
|---|---|
| [Getting started](./GETTING_STARTED.md) | Install from a checkout, create or adopt a project, run the everyday workflow, and decide what belongs in Git. |
| [Set up PixelLab](./PIXELLAB.md) | Configure the production provider, choose a generator, and use its account workflows. |
| [Set up Retro Diffusion](./RETRO_DIFFUSION.md) | Configure the experimental provider, choose a style, and understand its live-tested boundary. |
| [Set up ComfyUI](./COMFYUI.md) | Bind a local composition workflow and understand the manual quality boundary. |
| [Set up Scenario](./SCENARIO.md) | Configure hosted models, two-part credentials, CU ceilings, and durable downloads. |
| [CLI reference](./CLI.md) | Every command and flag, offline/provider requirements, JSON output, and exit behavior. |
| [Manifest reference](./MANIFEST.md) | Every style and asset field, quality profiles, generator constraints, mounting, and schema validation. |
| [Mixed-provider projects](./MIXED_PROVIDERS.md) | Route styles to different providers, set separate budget ceilings, and resume safely from one lockfile. |
| [Agent workflows](./AGENTS.md) | Install the official skill and pair agent guidance with the deterministic CLI. |

## Workflows

| Guide | Use it for |
|---|---|
| [Generators](./GENERATORS.md) | Choose between `map`, `1dir`, `pixflux`, and `tiles`; understand measured costs and capability trade-offs. |
| [Environment provider benchmark](./PROVIDER_BENCHMARK.md) | Compare PixelLab, Retro Diffusion, and ComfyUI on buildings, backgrounds, cleanup, and native-grid recovery. |
| [Controlled asset revisions](./REVISIONS.md) | Use image-to-image/inpaint parents, masks, approval gates, side-by-side review, and ComfyUI bindings. |
| [Derived artifacts](./ARTIFACTS.md) | Refine, pack, mount, and export; provenance, approval gates, ownership, and crash recovery. |
| [Recovery and account safety](./RECOVERY.md) | Restore, caches, adopt, salvage, cross-project claims, tagging, and confirmed purge. |
| [Quality gates](./QUALITY.md) | Manifest quality profiles, image baselines, human review, audit, cache, and CI usage. |
| [Versioned recipes](./RECIPES.md) | Install and verify pinned workflow packs, model hashes, manifest templates, and quality contracts. |

## Internals and extension

| Guide | Use it for |
|---|---|
| [Architecture](./ARCHITECTURE.md) | Manifest/lock state, provider boundary, output identity, concurrency, and durable writes. |
| [Library API](./LIBRARY.md) | Public TypeScript imports for planning, quality checks, providers, packing, exporting, and managed artifact writes. |
| [Tiles and engine exports](./TILES.md) | Structural tile roles, provider rule preservation, generic JSON, Tiled Wang sets, and Godot terrain sets. |
| [Measured PixelLab endpoints](./ENDPOINTS.md) | Live-account cost and payload research, endpoint recipes, limits, and unresolved API behavior. |
| [Provider comparison](../PROVIDERS.md) | Provider selection, costs, adapter capabilities, confidence, and next work. Start with the provider-specific setup guides above when you are ready to configure a project. |

## Project policies

- [Contributing](../CONTRIBUTING.md)
- [Security](../SECURITY.md)
- [Naming decision](../NAMING.md)

The Markdown in this directory is the canonical documentation and ships in the
npm package. The Next.js app in `website/` renders this source directly into
the public documentation routes rather than maintaining a second copy.
