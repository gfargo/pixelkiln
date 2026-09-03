# PixelLab and Retro Diffusion

PixelKiln can route one manifest through either PixelLab or Retro Diffusion.
The project model keeps planning, hard budgets, lockfile provenance, human
review, recovery, and packaging. Each adapter owns its service's
authentication, pricing, validation, request lifecycle, and output formats.

PixelLab remains the default so existing manifests and spec hashes remain
compatible. Select Retro Diffusion with the manifest's top-level `provider`
field and keep its settings under `providerOptions.retrodiffusion`.

Ready to configure a project? Use [Set up PixelLab](./docs/PIXELLAB.md) for the
production provider or
[Set up Retro Diffusion](./docs/RETRO_DIFFUSION.md) for the experimental
adapter. This page focuses on choosing between them.

## Support status

| Provider | PixelKiln status | Credential | Cost unit |
|---|---|---|---|
| PixelLab | Production; paid generation and account workflows live-tested | `PIXELLAB_API_KEY` | generations |
| Retro Diffusion | Experimental; authenticated paid still generation, download, provenance, and recovery live-tested; advanced workflows pending | `RD_API_KEY` | USD |
| FakeProvider | Test-only deterministic lifecycle | none | free |

Live tests now cover single-candidate RD Fast and RD Plus stills from cost quote
through submit, poll, PNG download, lockfile provenance, and cache validation.
The RD Plus run covered isometric-asset, top-down-asset, and environment styles.
Retro Diffusion's multi-candidate review, tileset, GIF, and spritesheet paths
have mocked integration coverage but still need representative paid live runs.

## PixelLab vs. Retro Diffusion

This comparison describes the adapters PixelKiln ships today, not every feature
the providers offer directly.

| Decision | PixelLab | Retro Diffusion |
|---|---|---|
| Best fit today | Established PixelKiln projects, account reconciliation, and fully live-tested generation | Native pixel-art styles, cash-denominated cost control, animation, and alternate tileset workflows |
| PixelKiln generators | `map`, `pixflux`, `1dir`, `tiles` | `map` and `pixflux` stills, `tiles`, `animation` |
| Output | PNG stills, candidates, and structural tile members | PNG stills/tiles/spritesheets or animated GIF |
| Candidate review | Yes; count varies by generator and size | Yes for 1–16 still candidates; animations and tilesets currently use one result |
| References | `1dir` and tile style modes | Up to nine for supported RD Pro/user still styles; constrained inputs for animation and tiles |
| Cost model | Subscription generations | Prepaid USD balance |
| Cost safety | Offline estimate plus hard generation budget | Offline estimate, hard USD budget, then a free authoritative quote before submission |
| Account lifecycle | Balance, list, adopt, salvage, tag, and confirmed purge | Balance only in the current adapter |
| Live confidence | Full paid generation workflows exercised | RD Fast and RD Plus single-candidate stills exercised end to end; multi-candidate, tileset, GIF, and spritesheet runs pending |

Choose PixelLab when mature account-object recovery and reconciliation matter,
or when the measured one-generation `map`/`pixflux` routes fit the work. Choose
Retro Diffusion when a native animation or spritesheet is required, an RD style
is the desired look, or a USD quote is easier to budget. For a production batch,
run one representative asset through the selected provider before expanding the
scope.

## Large environments, mountains, and buildings

Start by deciding whether the result is an isolated map object or a complete
background. That distinction matters more than raw canvas size.

| Asset type | PixelLab through PixelKiln | Retro Diffusion through PixelKiln |
|---|---|---|
| Isolated house, building, mountain, or landmark | Start with `map`: arbitrary dimensions up to 400×400 and a measured one-generation cost. Live benchmark outputs had opaque backgrounds, so plan for cleanup. Use `1dir` only when references or candidate variety justify 20–40 generations and a square canvas. | Start with `rd_plus__topdown_asset`, `rd_plus__isometric_asset`, or `rd_tile__scene_object`, depending on perspective. `rd_tile__scene_object` is specifically intended for 64–384px objects placed on tile maps. |
| Full scenic background | Use `pixflux` with `noBackground: false` when an exact palette matters, or `map` for a simple scene. Current PixelKiln routes top out at 400×400. | `rd_plus__environment` targets one-point-perspective scenes; `rd_plus__topdown_map` targets 3/4 top-down maps. These styles support up to 384×384. |
| Style consistency across a set | `1dir` accepts a style reference and returns size-dependent candidates, but it is more expensive and capped at the square-object range. | RD Pro accepts up to nine references and has stronger prompt following, but its common styles top out at 256×256 and cost $0.18 per image. Environment-specific RD Plus styles trade references for a larger 384px canvas. |
| Very large final scene | Generate reusable objects, terrain, and background layers separately; assemble them deterministically and integer-upscale the result. | Use the same layered approach. The API has a 512px overall ceiling, but the useful environment and scene-object styles currently cap at 384px. |

For production environments, prefer a kit over a monolith: seamless terrain,
separate landmarks/buildings, foreground occluders, and a distant backdrop.
This produces reusable assets, cleaner parallax, easier collision/lighting, and
cheaper targeted re-rolls. Generate at the intended native pixel resolution,
then scale by an integer with nearest-neighbor filtering.

A visual benchmark should use the same briefs for an isolated building, a
top-down landmark, and a full scenic background. Use the same intended native
size and review count. Score silhouette readability, perspective, palette,
edge cleanliness, tiling/layerability, prompt adherence, and usable results per
provider unit. Seeds are provider-specific, so equal seed numbers do not make
the outputs directly reproducible across services.

See the [environment provider benchmark](./docs/PROVIDER_BENCHMARK.md) for the
twelve generated images, prompts, manifests, measured costs, and review.

## Use both providers in one project

One manifest selects one provider. PixelKiln does not currently support a
provider override on an individual style or asset. The boundary is deliberate:
one command constructs one account adapter, and one `--budget` must have one
meaning. PixelLab generations and Retro Diffusion dollars cannot share a safe
ceiling.

A repository can still use both providers today. Give each provider its own
manifest, lockfile, and output directory:

```text
art/
  pixelkiln.pixellab.manifest.json
  pixelkiln.pixellab.lock.json
  pixelkiln.retrodiffusion.manifest.json
  pixelkiln.retrodiffusion.lock.json
pixelkiln.workspace.json
```

Plan and authorize each manifest separately:

```bash
pixelkiln plan --manifest art/pixelkiln.pixellab.manifest.json --lock art/pixelkiln.pixellab.lock.json
pixelkiln gen --manifest art/pixelkiln.pixellab.manifest.json --lock art/pixelkiln.pixellab.lock.json --budget <generations>

pixelkiln plan --manifest art/pixelkiln.retrodiffusion.manifest.json --lock art/pixelkiln.retrodiffusion.lock.json
pixelkiln gen --manifest art/pixelkiln.retrodiffusion.manifest.json --lock art/pixelkiln.retrodiffusion.lock.json --budget <usd>
```

Register both manifests in the workspace catalog for aggregate status and
complete claim checks. Keep the provider lockfiles separate. Package their
reviewed outputs independently, or combine explicit files with `pixelkiln pack
--inputs <file> --out <path>`.

This is a useful split when PixelLab handles prompt-sensitive buildings and
account recovery while Retro Diffusion handles environment-styled backdrops,
clean cutouts, or native animation. Retro Diffusion is not a higher-resolution
route through PixelKiln today: its useful environment styles cap at 384×384,
while PixelLab `map` reaches 400×400. Its advantage is the model/style and
output type, not raw dimensions.

Native mixed-provider support inside one manifest would be a larger feature,
not a schema-only change. It needs provider selection on each style, plans and
confirmations grouped by provider and cost unit, separate budget ceilings,
per-provider polling and downloads, and an explicit provider for account-wide
commands. The lockfile already records a provider on every entry, so the state
format can support that direction without merging provider identities.

## Cost comparison

The services use different billing units, so PixelKiln never adds their costs
together.

PixelLab figures below are measurements from the endpoints PixelKiln currently
uses; they are not a conversion to dollars:

| PixelLab route | Measured cost |
|---|---:|
| `map` | 1 generation |
| `pixflux` | 1 generation |
| `1dir` | 20–40 generations |
| `tiles` | 20–40 generations |

Retro Diffusion publishes USD formulas and fixed prices. Examples relevant to
PixelKiln include RD Fast from about $0.015 per image, RD Plus from about $0.025,
RD Pro at $0.18, animations from $0.07–$0.25, and tilesets at $0.10. Pixel count,
style, and candidate count affect the exact still-image quote. Treat
`pixelkiln plan` as the offline ceiling and the provider's free preflight quote
as the authoritative submit-time check. See Retro Diffusion's
[official API examples and pricing formulas](https://github.com/Retro-Diffusion/api-examples#pricing).

## Capability boundary

The provider boundary owns behavior that differs between services:

- supported generators and provider-specific validation;
- offline estimates, arbitrary non-empty cost units, and candidate counts;
- submit/poll response schemas and candidate selection when applicable;
- downloads and optional account capabilities such as balance, listing,
  tagging, and deletion.

Planning groups costs by unit instead of adding incompatible values. A budget
is interpreted in the active provider's unit. Providers without a balance or
account-management endpoint can still generate safely because the offline
estimate and hard budget remain enforced.

## Next validation and expansion

1. Complete representative paid Retro Diffusion multi-candidate, tileset, GIF,
   and spritesheet smoke tests without logging credentials. Single-candidate RD
   Fast and RD Plus still paths have passed end to end.
2. Promote only the workflows proven against the live service; keep unsupported
   account operations explicit capability errors.
3. Evaluate Scenario as another hosted game-asset provider.
4. Add a local ComfyUI adapter for GPU-backed, no-per-call-cost generation.
5. Consider general raster providers only with explicit nearest-neighbor,
   palette, transparency, and reproducibility checks.
6. Evaluate per-style provider selection with provider-keyed budgets; do not
   overload the current scalar `--budget` or silently sum incompatible units.

Midjourney is not an adapter target without an official public API. Automating
its consumer UI would be fragile and could violate provider terms.
