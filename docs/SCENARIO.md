# Set up Scenario

[Scenario](https://www.scenario.com/) is an experimental hosted provider for
project-specific models and third-party image models. PixelKiln currently
supports still PNG generation through Scenario's universal model endpoint,
free Compute Unit preflight, asynchronous jobs, multi-output review, and
refreshable asset downloads.

The adapter has comprehensive mocked coverage. Authentication and a free BFL
Flux 2 Dev cost preflight have passed against Scenario's live API, but no paid
job has run. Start with one disposable asset and a small ceiling. Do not treat
this integration as production-ready until the live checklist at the end of
this guide passes for your chosen model.

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
and an optional `seed`. It accepts dimensions from 128–2048px in multiples of
16 and one to four PNG outputs.

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

Style reference uploads are not implemented. A `styleImages` entry fails
during free manifest resolution rather than uploading the same image on every
run. Train or reuse a Scenario model for the first integration.

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

The command budget is still a hard ceiling over the whole selected run. The
manifest ceiling protects each request from a changed live quote.

### Current live validation

On September 5, 2026, PixelKiln authenticated against the read-only model
endpoint and preflighted `model_bfl-flux-2-dev` with a 512×512 canvas, one
output, guidance 4, and 28 inference steps. Scenario returned a 16 CU
`custom-generation` quote. The request used `dryRun=true`; no generation was
submitted and no CU was spent.

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
