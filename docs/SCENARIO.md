# Set up Scenario

[Scenario](https://www.scenario.com/) is an experimental hosted provider for
project-specific models and third-party image models. PixelKiln currently
supports still PNG generation through Scenario's universal model endpoint,
free Compute Unit preflight, asynchronous jobs, multi-output review, and
refreshable asset downloads.

Every code path in the adapter has mocked coverage. BFL Flux 2 Dev has also passed
live authentication, cost preflight, paid single- and two-output generation,
human review, PNG download, and provider-backed recovery. Start every untested
model with one disposable asset and a small ceiling. This integration remains
experimental because Scenario model schemas vary.

## Requirements

Scenario API access requires an eligible paid plan. Create an API key in the
Scenario project that should own the generated assets, then put both values in
`.env.local` beside the PixelKiln manifest:

```dotenv
SCENARIO_SDK_API_KEY=...
SCENARIO_SDK_API_SECRET=...
```

Do not commit this file. For a local mock server, `SCENARIO_API_BASE_URL` may
override the production API root. Ordinary projects should leave it unset.

## Choose a model

PixelKiln calls `POST /generate/custom/{modelId}`. Scenario model inputs vary;
inspect the model's current parameter reference before adding optional inputs.
The initial PixelKiln contract sends `prompt`, `width`, `height`, `numOutputs`,
and an optional `seed`. It accepts whole-number dimensions from 16 to 4096px and one to four PNG
outputs. Each model has its own tighter bounds (FLUX takes 128 to 2048 in
steps of 16, Retro Diffusion Plus 16 to 384); the free dry run that precedes
every paid request reports them, for example "Input width must be at least
672", before anything is spent. A model may also return a different canvas than
the one requested, so check real dimensions.

The public `model_bfl-flux-2-dev` profile documents that input shape. A custom
LoRA used with that base can be supplied as `parameters.modelId` when the
Scenario model reference calls for it. Other model-specific values belong in
`parameters`; they are hashed as part of the resolved spec.

```jsonc
{
  "$schema": "./node_modules/pixelkiln/schema/manifest.schema.json",
  "name": "my-game",
  "provider": "scenario",
  "styles": {
    "environment": {
      "generator": "map",
      "size": 512,
      "seed": 31415,
      "outDir": "assets/generated/environment",
      "providerOptions": {
        "scenario": {
          "modelId": "model_bfl-flux-2-dev",
          "projectId": "project_example",
          "numOutputs": 4,
          "maxComputeUnits": 60,
          "parameters": {
            "guidance": 4,
            "numInferenceSteps": 28
          }
        }
      }
    }
  },
  "assets": {
    "mountain-town": {
      "prompt": "a fortified mountain town built across three terraces"
    }
  }
}
```

`modelId` and `maxComputeUnits` are required. `projectId` is optional, but it
keeps job and asset lookup scoped to the intended Scenario project.
`parameters` may contain JSON values accepted by the selected model. It cannot
replace PixelKiln-owned `prompt`, dimensions, seed, output count, project, or
budget fields.

## Reference images and edits

Most Scenario image models take reference images, which serve both as style
guidance and as the image to edit. PixelKiln uploads each local image to
Scenario once (`POST /assets`, free), keeps the returned asset id by content
hash in a temporary cache so a rerun does not upload it again, and sends the ids
as the model's `referenceImages` input. Two things use this:

- A style's `styleImages` are sent as references with every asset in the style.
- An `image-to-image` revision sends its parent first, then any style images.
  The prompt is the edit instruction, as in
  [controlled revisions](./REVISIONS.md). Masked `inpaint` and the
  PixelLab animation and cleanup modes are not available, and `strength` is
  refused because Scenario has no common one; use the model's own `parameters`.

```jsonc
{
  "styles": {
    "edit": {
      "generator": "map",
      "size": 512,
      "outDir": "assets/generated",
      "providerOptions": {
        "scenario": { "modelId": "model_bfl-flux-2-klein-9b", "maxComputeUnits": 1 }
      }
    }
  },
  "assets": {
    "keep": { "prompt": "a stone mountain keep", "source": "art/keep.png" },
    "keep-snow": {
      "prompt": "the same keep in winter: snow on the roofs, pixel art",
      "revision": { "mode": "image-to-image", "from": "keep" }
    }
  }
}
```

The adapter does not know each model's input names, so a model whose image
input is not called `referenceImages` needs `referenceParameter` (for example
`"image"`), and `referenceArray: false` if it takes one image rather than a
list. `parameters` may not also set that input. A model must accept images at
all: the free dry run, which now includes the references, rejects one that
does not before anything is spent. A reference can add to the quote (GPT Image 2
priced one text-only 512×512 request at 11 CU and the same request with a
reference at 12).

On October 5, 2026 a one-image `image-to-image` revision of the bake-off's GPT
Image 2 keep through `model_bfl-flux-2-klein-9b` quoted and billed 1 CU and
returned the same keep with snow on its roofs and battlements, banners and
layout intact. The committed
[Scenario edit smoke](../benchmarks/provider-scenario-edit/README.md) has the
manifest, lockfile, and both images. That is one sample on one model.

## Plan before spending

Scenario prices depend on model, size, steps, and output count, so PixelKiln
does not embed a price table. `maxComputeUnits` is the conservative per-asset
offline estimate. Planning performs no network request:

```bash
pixelkiln doctor --dry-run
pixelkiln plan --style environment --only mountain-town
```

Authenticated doctor checks both credentials with a read-only model request:

```bash
pixelkiln doctor
```

Generation requires a command budget at least as large as the offline plan:

```bash
pixelkiln gen \
  --style environment \
  --only mountain-town \
  --budget 60
```

Immediately before each paid request, the adapter sends the identical body with
`dryRun=true`. A missing, malformed, negative, non-finite, or over-ceiling
quote stops the run before paid work. Scenario's `costDetails` already sum to
`creativeUnitsCost`; PixelKiln records both without double-counting. A separate
IP-detection charge is additive when Scenario reports one.

A 429 on a generation request means the account's concurrent-job limit
refused it: nothing was accepted or billed, and the adapter retries for about
80 seconds. Past that, rerun `gen`; the assets that landed are kept. A finished
job whose asset is not a PNG (some models return JPEG) is billed, so that asset
is marked failed rather than polled again.

The command budget is still a hard ceiling over the whole selected run. The
manifest ceiling protects each request from a changed live quote.

Scenario's current BFL output is best treated as concept or refinement input.
A still-image style can declare `quality` to recover a native grid, enforce a
closed palette, and require named approval before pack or mount. This offline
policy does not change the Scenario request or CU quote. See
[Manifest quality profiles](./MANIFEST.md#quality-profiles).

### Models and what they cost

A free survey on October 5, 2026 quoted every non-deprecated text-to-image
model with a prompt-only 512×512 dry run on a `cu-basic` account. 37 were
usable and 19 were refused with `ModelAccessRestrictedError` (the Retro
Diffusion Plus, Tile, and Animation models need the `cu-pro-q3-25` plan).
Quotes ran from 1 CU (FLUX.2 Klein 9b, FLUX.1 Schnell, P-Image) through 2 to 6
for the Krea 2, Recraft V4.1 Flash, Meta Muse, Ernie, Z-Image, and Qwen Image
models, 11 to 12 for GPT Image 2 and Gemini 3.1 Flash, to 16 for the FLUX.2 Dev
this page was first validated on. The
[model bake-off](../benchmarks/provider-scenario-bakeoff/README.md) ran ten of
them once: price did not predict fit, several models ignore the requested
canvas size, and one returned a JPEG, which the adapter refuses.

Scenario's catalog also lists pixel-art LoRAs, background-removal and upscale
models, and a `pixel-snapper` cleanup tool. LoRA models answer a different
endpoint than `/generate/custom/{modelId}`, which this adapter does not call.

### Current live validation

On September 5, 2026, PixelKiln authenticated against the read-only model
endpoint and preflighted `model_bfl-flux-2-dev` with a 512×512 canvas, guidance
4, and 28 inference steps. The free preflights quoted 16 CU for one output and
32 CU for two. Both costs were reported as `custom-generation`.

The paid smoke then used the same requests. The one-output job quoted and billed 16
CU. The two-output job quoted and billed 32 CU, entered local review, and
downloaded the second human-selected candidate without another generation.
Both files were valid 512×512 RGB PNGs. A forced restore with the output and
local cache removed recovered identical bytes from the durable Scenario asset
ID. Neither credential nor a signed URL entered the lockfile.

Scenario reported `outputIndex: 0` for both candidates in that live job.
PixelKiln therefore retains job asset order when output indices tie and records
its own selected `candidateIndex` alongside the chosen durable asset ID.

The committed [Scenario live smoke](../benchmarks/provider-scenario-smoke/README.md)
contains the manifest, lockfile, measured costs, and selected outputs.

## Manifest fields

Scenario uses hosted model IDs and requires a conservative Compute Unit ceiling
for every style:

```jsonc
{
  "provider": "scenario",
  "styles": {
    "environment": {
      "generator": "map",
      "size": 512,
      "outDir": "assets/generated/environment",
      "providerOptions": {
        "scenario": {
          "modelId": "model_bfl-flux-2-dev",
          "projectId": "project_example",
          "numOutputs": 4,
          "maxComputeUnits": 60,
          "parameters": {
            "guidance": 4,
            "numInferenceSteps": 28
          }
        }
      }
    }
  },
  "assets": {
    "mountain-town": { "prompt": "a fortified mountain town" }
  }
}
```

| Option | Meaning |
|---|---|
| `modelId` | Required Scenario endpoint model ID. |
| `maxComputeUnits` | Required positive per-asset offline ceiling and maximum accepted live quote. |
| `numOutputs` | One to four PNG candidates; defaults to one. |
| `projectId` | Optional Scenario ownership/routing project. |
| `parameters` | Additional model-specific JSON inputs. PixelKiln-owned request fields cannot be overridden. |
| `referenceParameter` | The model input that takes images, default `referenceImages`. |
| `referenceArray` | `false` when that input takes one image rather than a list. |

The current adapter supports `map`, whole-number dimensions from 16 to 4096px,
optional seed, style images and `image-to-image` revisions as reference uploads. Every paid request is preceded
by an identical `dryRun=true` request. See [Set up Scenario](SCENARIO.md) for
credentials, cost semantics, recovery, and the paid live-test boundary.

## Review and recovery

One output moves directly to download. Two to four outputs enter the normal
local review sheet:

```bash
pixelkiln poll --style environment
pixelkiln pick --style environment
pixelkiln fetch --style environment
```

Scenario returns temporary signed URLs. PixelKiln stores `scenario://` job and
asset references instead, then resolves a fresh original URL when it needs the
bytes. The lockfile retains the endpoint model, project, offline ceiling, live
quote, final billing, selected asset ID, output index, and output hash without
retaining credentials or signed query strings. Once cached, `restore` prefers
the validated local content cache.

Scenario account listing, adoption, salvage, tagging, deletion, balance, image
uploads, training, background removal, and upscaling are not part of this first
adapter. PixelKiln reports unavailable account commands instead of pretending
they succeeded.

## Mixed-provider projects

Scenario uses `compute-units`; PixelLab uses generations, Retro Diffusion uses
USD, and local ComfyUI uses `free`. Keep their ceilings separate:

```bash
pixelkiln gen \
  --budget pixellab=12 \
  --budget scenario=60 \
  --budget comfyui=0
```

See [Mixed-provider projects](MIXED_PROVIDERS.md) for routing and recovery.

## Live validation checklist

Before widening a batch:

1. Run `doctor --dry-run`, `plan`, and authenticated `doctor`.
2. Confirm the offline ceiling matches the intended maximum for one asset.
3. Generate one PNG output and verify the quote, final CU charge, dimensions,
   hash, cache entry, and `restore` behavior.
4. Generate two outputs, make a human selection, and verify that no second
   generation occurs during `pick`.
5. Inspect the art at 1×. PixelKiln validates provenance and media structure;
   it does not certify that a model produced good pixel art.

Record the tested model ID and parameters in project documentation. Scenario's
catalog and accepted inputs can change independently of PixelKiln.

## Official references

- [Scenario API authentication](https://docs.scenario.com/get-started/documentation/quick-start-guide/step-2-authenticate-your-requests)
- [Universal model generation](https://docs.scenario.com/api/typescript/resources/generate/methods/run_model)
- [Job retrieval and statuses](https://docs.scenario.com/api/typescript/resources/jobs/methods/retrieve)
- [Asset retrieval](https://docs.scenario.com/api/typescript/resources/assets/methods/retrieve)
- [Compute Unit preflight](https://help.scenario.com/articles/7934059476-api-usage-and-credits-compute-units)
- [BFL model parameters](https://docs.scenario.com/get-started/generation/third-party-model-generation/third-party-model-generation-bfl)
