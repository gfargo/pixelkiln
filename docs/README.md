# PixelKiln documentation

PixelKiln is a manifest-driven pixel-art pipeline. Start with the workflow
guide, then use the references for the part of the pipeline you are changing.
This source also renders at
[pixelkiln.griffen.codes/docs](https://pixelkiln.griffen.codes/docs).

## Start here

| Guide | Use it for |
|---|---|
| [Getting started](./GETTING_STARTED.md) | Install from a checkout, create or adopt a project, run the everyday workflow, and decide what belongs in Git. |
| [Set up PixelLab](./PIXELLAB.md) | Configure the production provider, choose a generator, and use its account workflows. |
| [Set up Retro Diffusion](./RETRO_DIFFUSION.md) | Configure the experimental provider, choose a style, and understand its live-tested boundary. |
| [Set up ComfyUI](./COMFYUI.md) | Install the tested SDXL and BiRefNet stack, then bind generation and cleanup workflows. |
| [CLI reference](./CLI.md) | Every command and flag, offline/provider requirements, JSON output, and exit behavior. |
| [Manifest reference](./MANIFEST.md) | Every style and asset field, inheritance, generator-specific constraints, mounting, and schema validation. |
| [Agent workflows](./AGENTS.md) | Install the official skill and pair agent guidance with the deterministic CLI. |

## Workflows

| Guide | Use it for |
|---|---|
| [Generators](./GENERATORS.md) | Choose between `map`, `1dir`, `pixflux`, and `tiles`; understand measured costs and capability trade-offs. |
| [Environment provider benchmark](./PROVIDER_BENCHMARK.md) | Compare PixelLab, Retro Diffusion, and a named ComfyUI model stack on buildings and backgrounds. |
| [Derived artifacts](./ARTIFACTS.md) | Pack, mount, and export; provenance companions; ownership; force takeover; transactional and crash recovery. |
| [Recovery and account safety](./RECOVERY.md) | Restore, caches, adopt, salvage, cross-project claims, tagging, and confirmed purge. |
| [Quality gates](./QUALITY.md) | Plan, doctor, audit, cache checks, JSON contracts, and CI usage. |

## Internals and extension

| Guide | Use it for |
|---|---|
| [Architecture](./ARCHITECTURE.md) | Manifest/lock state, provider boundary, output identity, concurrency, and durable writes. |
| [Library API](./LIBRARY.md) | Public TypeScript imports for planning, auditing, providers, packing, exporting, and managed artifact writes. |
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
