# Provider comparison

PixelKiln can route one manifest through PixelLab, Retro Diffusion, Scenario,
and a self-hosted ComfyUI server. Planning, review, recovery, and packaging stay
the same. Each adapter handles its service's authentication, prices, request
lifecycle, and file formats.

PixelLab remains the default so existing manifests and spec hashes remain
compatible. The manifest's top-level `provider` is the default; a style may
override it. Keep service settings under the matching `providerOptions` key.

To configure a project, use [Set up PixelLab](./docs/PIXELLAB.md),
[Set up Retro Diffusion](./docs/RETRO_DIFFUSION.md),
[Set up ComfyUI](./docs/COMFYUI.md), or
[Set up Scenario](./docs/SCENARIO.md). This page focuses on choosing between
them.

## Support status

| Provider | PixelKiln status | Credential | Cost unit |
|---|---|---|---|
| PixelLab | Production; paid generation and account workflows live-tested | `PIXELLAB_API_KEY` | generations |
| Retro Diffusion | Experimental; authenticated paid still generation, download, provenance, and recovery live-tested; advanced workflows pending | `RD_API_KEY` | USD |
| ComfyUI | Experimental; local single-image generation, four-candidate queue, provenance, and cache-only recovery live-tested on Apple MPS | none; optional `COMFYUI_BASE_URL` | free |
| Scenario | Experimental; BFL Flux 2 Dev authentication, CU preflight, paid single/two-output generation, review, download, and durable recovery live-tested | `SCENARIO_SDK_API_KEY` and `SCENARIO_SDK_API_SECRET` | compute-units |
| FakeProvider | Test-only deterministic lifecycle | none | free |

Live tests now cover single-candidate RD Fast and RD Plus stills from cost quote
through submit, poll, PNG download, lockfile provenance, and cache validation.
The RD Plus run covered isometric-asset, top-down-asset, and environment styles.
Lockfiles retain refreshable `retrodiffusion://` result references rather than
temporary signed storage URLs.
Retro Diffusion's multi-candidate review, tileset, GIF, and spritesheet paths
have mocked integration coverage but still need representative paid live runs.

ComfyUI's `free` unit means PixelKiln cannot identify a metered provider
charge. It does not count hardware, hosting, electricity, or model-license
costs.

Scenario planning uses the manifest's conservative `maxComputeUnits` value.
Immediately before paid work, the adapter asks Scenario for a free live quote
using the identical request. The first live smoke quoted and billed 16 CU for
one image and 32 CU for two. Human selection and a forced provider restore both
passed. The smoke is separate from the visual comparison because it uses a
different brief.

## PixelLab vs. Retro Diffusion

This comparison describes the adapters PixelKiln ships today, not every feature
the providers offer directly.

| Decision | PixelLab | Retro Diffusion |
|---|---|---|
| Best fit today | Existing PixelKiln projects, account reconciliation, and live-tested generation | Native pixel-art styles, USD budgets, animation, and alternate tileset workflows |
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

## Where ComfyUI fits

ComfyUI is different from the hosted providers. PixelKiln does not choose a
model or hide the graph. You commit an API-format workflow and declare the exact
prompt, size, batch, and optional seed inputs PixelKiln may replace.

| Decision | ComfyUI through PixelKiln |
|---|---|
| Best fit today | Local composition experiments, private inputs, and teams prepared to maintain and manually validate custom graphs |
| PixelKiln generator | `map` stills |
| Output | One PNG output node, with 1–16 review candidates |
| Cost model | `0 free`; local compute and hosting are outside PixelKiln's estimate |
| Reproducibility | Workflow content is hashed; model files, custom-node versions, and runtime settings must still be managed outside PixelKiln |
| Account lifecycle | Read-only connectivity check; no balance, remote object listing, tagging, or purge |
| Confidence | Full mocked coverage plus live generation, four-candidate review, cache-only restore, and three provider-neutral refinement runs on Apple MPS; background removal stays in the graph and aesthetic approval remains human |

Choose ComfyUI when control over the graph is worth the extra validation. Start
with a hosted provider when you want less cleanup. Two ComfyUI machines can run
the same graph and still differ because their checkpoint bytes, custom nodes,
or sampler settings differ. Commit the workflow and record the model stack used
to test it.

## Where Scenario fits

Scenario adds hosted third-party models and reusable project-specific models
without requiring a local GPU. PixelKiln's first adapter intentionally covers
only the part that fits its existing still-image pipeline.

| Decision | Scenario through PixelKiln |
|---|---|
| Best fit today | A controlled one-asset spike using a hosted model or project LoRA with a hard CU ceiling |
| PixelKiln generator | `map` stills |
| Output | One to four PNG candidates, 128–2048px in multiples of 16 |
| Cost model | Manifest `maxComputeUnits`, command budget, then free authoritative preflight before each paid request |
| Recovery | Durable job and asset IDs refresh temporary signed original-file URLs |
| Account lifecycle | Read-only connectivity check; no balance, list, adopt, salvage, tag, or purge yet |
| Confidence | BFL Flux 2 Dev live-tested through quote, billing, single/two-output jobs, human selection, PNG download, and provider-backed restore; other model schemas remain unverified |

Scenario model schemas differ. The current adapter sends prompt, width, height,
output count, optional seed, and explicitly declared JSON parameters. Verify
the chosen model accepts that shape before spending. Use
[Set up Scenario](./docs/SCENARIO.md) for the safe first-run sequence.

## Large environments, mountains, and buildings

Start by deciding whether the result is an isolated map object or a complete
background. That distinction matters more than raw canvas size.

| Asset type | PixelLab | Retro Diffusion | ComfyUI | Scenario |
|---|---|---|---|---|
| Isolated house, building, mountain, or landmark | Start with `map`: arbitrary dimensions up to 400×400 and a measured one-generation cost. Live benchmark outputs had opaque backgrounds, so plan for cleanup. Use `1dir` only when references or candidate variety justify 20–40 generations and a square canvas. | Start with `rd_plus__topdown_asset`, `rd_plus__isometric_asset`, or `rd_tile__scene_object`, depending on perspective. `rd_tile__scene_object` is intended for 64–384px objects placed on tile maps. | Choose a checkpoint or LoRA trained for the intended perspective, then keep background removal or segmentation in the workflow. For the tested Pixel Art XL stack, target 48–128px native components even though the adapter accepts larger working canvases. | The live BFL smoke produced a readable 512px keep, but it was opaque and used 19,619 colors. Use that profile for concepts or refinement input, not a finished limited-palette asset. A project-specific model may improve consistency but needs its own smoke. |
| Full scenic background | Use `pixflux` with `noBackground: false` when an exact palette matters, or `map` for a simple scene. Current PixelKiln routes top out at 400×400. | `rd_plus__environment` targets one-point-perspective scenes; `rd_plus__topdown_map` targets 3/4 top-down maps. These styles support up to 384×384. | Use composition controls only to establish the scene. Recover and review native components, then compose them at 1× with one grid and palette. A large model canvas is not a large native pixel-art canvas. | The BFL profile accepts canvases up to 2048px, but no Scenario scenic brief has passed the shared benchmark. Treat that as model-canvas capacity, not native pixel resolution. Start with one 512px concept before raising size or steps. |
| Style consistency across a set | `1dir` accepts a style reference and returns size-dependent candidates, but it is more expensive and capped at the square-object range. | RD Pro accepts up to nine references and has stronger prompt following, but its common styles top out at 256×256 and cost $0.18 per image. Environment-specific RD Plus styles trade references for a larger 384px canvas. | LoRAs, reference adapters, ControlNet, and shared latent settings can live in the committed workflow. Reproducibility also depends on external model and custom-node versions. | Scenario's project models and LoRAs are the main reason to use it for a set. PixelKiln can pin the model ID and parameters, but its first live run covers only the public BFL profile. |
| Very large final scene | Generate reusable objects, terrain, and background layers separately; assemble them deterministically and integer-upscale the result. | Use the same layered approach. The API has a 512px overall ceiling, but the useful environment and scene-object styles currently cap at 384px. | The graph can tile, upscale, or composite beyond hosted-provider limits, but memory and seam quality become workflow concerns. Prefer reusable layers unless the scene truly needs one render. | Scenario can request a larger raster from a compatible model, but the same rule applies: generate reusable layers at their useful native detail, compose at 1×, and integer-upscale only the final scene. |

For a production environment, build a kit: seamless terrain, separate
landmarks and buildings, foreground occluders, and a distant backdrop. You can
rerun one weak piece, set collision per object, and move layers independently
for parallax. Generate each piece at its native pixel resolution, then use
integer nearest-neighbor scaling.

A visual benchmark should use the same briefs for an isolated building, a
top-down landmark, and a full scenic background. Use the same intended native
size and review count. Score silhouette readability, perspective, palette,
edge cleanliness, tiling/layerability, prompt adherence, and usable results per
provider unit. Seeds are provider-specific, so equal seed numbers do not make
the outputs directly reproducible across services.

See the [hosted-provider environment benchmark](./docs/PROVIDER_BENCHMARK.md)
for the twenty generated images, prompts, manifests, measured costs, and review. The
384×384 additions test a larger cliffside building and a full volcanic
background. ComfyUI needs a separate benchmark because model and workflow are
part of the provider configuration; comparing an unnamed graph would not be
repeatable.

## Use multiple providers in one project

Set a provider on any style that differs from the manifest default. Planning
and confirmations remain grouped by provider and unit, so PixelLab generations,
Retro Diffusion dollars, Scenario Compute Units, and local free work are never
added together. A mixed run takes a separate named ceiling for each paid
provider; the free group may be explicit:

```bash
pixelkiln plan
pixelkiln gen \
  --budget pixellab=12 \
  --budget scenario=60 \
  --budget comfyui=0
```

The same lockfile records which provider accepted each item. Resumed polling,
review, download, restore, and tagging follow that recorded provider. Account
operations such as `balance`, `adopt`, `salvage`, and `purge` require an
explicit `--provider` in a mixed manifest.

This works well when PixelLab handles prompt-sensitive buildings and account
recovery, Retro Diffusion handles environment-styled backdrops, clean cutouts,
or native animation, and ComfyUI handles private or project-specific model
experiments that can absorb manual cleanup. Retro Diffusion is not a
higher-resolution route through PixelKiln today: its useful environment styles
cap at 384×384, while PixelLab `map` reaches 400×400. Its advantage is the
model/style and output type, not raw dimensions.

See [Mixed-provider projects](./docs/MIXED_PROVIDERS.md) for the manifest,
budget, recovery, and account-command contract. Separate manifests remain a
good boundary when different teams, credentials, or release schedules should
not share one runtime.

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

Scenario uses Compute Units rather than USD in the API contract. Costs vary by
model and inputs, so the manifest records a conservative per-asset ceiling
instead of a stale formula. PixelKiln records Scenario's live dry-run quote and
final job billing separately. The first BFL Flux 2 Dev smoke measured 16 CU for
one 512px output and 32 CU for two with 28 inference steps.

## Capability boundary

The provider boundary owns behavior that differs between services:

- supported generators and provider-specific validation;
- offline estimates, arbitrary non-empty cost units, and candidate counts;
- submit/poll response schemas and candidate selection when applicable;
- downloads and optional account capabilities such as balance, listing,
  tagging, and deletion.

Planning groups costs by provider and unit instead of adding incompatible
values. Mixed runs use provider-keyed ceilings. Providers without a balance or
account-management endpoint can still generate safely because the offline
estimate and hard budget remain enforced.

## What to build next

The ComfyUI adapter now has a live, versioned core-node workflow. Generation,
candidate review, cache recovery, native-grid recovery, palette enforcement,
and the approval record work. The tested SDXL plus Pixel Art XL graph can find
a composition, but it is not a production preset. Background removal stays in
the graph. A person must still check the brief, pixel clusters, and drawing.

Per-style provider routing now lets one manifest send a building style to
PixelLab, an animation style to Retro Diffusion, and a private model workflow
to ComfyUI. Provider-keyed budgets, independent orchestration, lock-authoritative
recovery, and explicit account-provider selection ship with it.

The Scenario still-image adapter from
[GitHub issue #52](https://github.com/gfargo/pixelkiln/issues/52) now has mocked
edge coverage and a paid BFL Flux 2 Dev lifecycle smoke. It remains
experimental until more model schemas and representative art briefs pass.

| Candidate | What it adds | Fit with PixelKiln | Main cost or risk | Priority |
|---|---|---|---|---:|
| Scenario comparable benchmark | Custom-trained style models and hosted third-party generation | Tests the same environment briefs now that CU accounting, review, PNG output, and signed-URL recovery are proven | Model schemas differ, and the first live smoke is not directly comparable to the existing provider set | 1 |
| ComfyUI Cloud | Managed execution of workflow graphs without running a local GPU | Could reuse part of the workflow model, but authentication, endpoints, billing, and lifecycle must remain separate from the local adapter | Treating cloud as a base-URL swap would hide real security and cost differences | 2 |
| fal | A large hosted model catalog, including pixel-art style controls, LoRAs, editing, upscaling, and background removal | Queue-based requests and model schemas are accessible through one client | Model-specific schemas and prices move the adapter toward a marketplace abstraction rather than one stable art workflow | 3 |

Scenario's [custom generation API](https://docs.scenario.com/get-started/generation/third-party-model-generation)
returns asynchronous jobs, while its
[Compute Unit guidance](https://help.scenario.com/articles/7934059476-api-usage-and-credits-compute-units)
documents free cost preflights. PixelKiln now maps those mechanics into its
normal plan, submit, poll, review, fetch, and restore lifecycle.

Recommended order from here:

1. Finish live Retro Diffusion multi-candidate, tileset, GIF, and spritesheet
   smoke tests.
2. Run the shared environment briefs through Scenario, then add one custom-model
   or project-LoRA benchmark.
3. Benchmark another pinned ComfyUI model and prompt pattern across at least two
   scene families. Reject any improvement that helps only one subject.
4. Design ComfyUI Cloud as a separate authenticated and billable adapter.
5. Consider general raster marketplaces only with explicit nearest-neighbor,
   palette, transparency, and reproducibility checks.

Midjourney is not an adapter target without an official public API. Automating
its consumer UI would be fragile and could violate provider terms.
