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

### Tool models as image-to-image

Scenario's single-image tools (pixel snapper, pixelate, background removal,
upscalers) are models like any other, so they run through the same
`image-to-image` revision with no extra mode: point the style at the tool's
model, name its input `image`, and put its settings in `parameters`. The
adapter's other fields (`prompt`, `width`, `height`, `numOutputs`, `seed`) are
accepted and ignored by these tools, and the free dry run prices the exact
request. Free dry runs on October 5, 2026 quoted these on a `cu-basic` account:

| Model | CU | Inputs besides `image` |
|---|---:|---|
| `model_birefnet-background-removal` | 2 | none |
| `model_recraft-crisp-upscale` | 2 | none |
| `model_bria-remove-background`, `model_photoroom-background-removal` | 3 | none |
| `model_pixel-snapper` | 5 | `colors` 8 to 256 (default 16) |
| `model_sc-pixelate` | 5 | `pixelGridSize` 1 to 512, `removeNoise`, `colorPalette`, `colorPaletteSize` |
| `model_upscale-v3`, `model_topaz-image-upscale` | 10 | none |

```jsonc
{
  "styles": {
    "snap": {
      "generator": "map",
      "size": 512,
      "outDir": "assets/snapped",
      "providerOptions": {
        "scenario": {
          "modelId": "model_pixel-snapper",
          "maxComputeUnits": 5,
          "referenceParameter": "image",
          "referenceArray": false,
          "parameters": { "colors": 16 }
        }
      }
    }
  },
  "assets": {
    "keep-snapped": {
      "prompt": "snap to the pixel grid",
      "revision": { "mode": "image-to-image", "from": "keep" }
    }
  }
}
```

Birefnet and Pixel Snapper were then run once each through the adapter (7 CU,
quoted and billed identically; see the
[tool-model smoke](../benchmarks/provider-scenario-tools/README.md)). Pixel
Snapper returned an 83×83, exactly-16-colour native-grid version of a 512×512
image, a different size than the manifest's canvas, and Birefnet's cutout kept
its subject at alpha 254 rather than 255. Pixelate (5 CU) was run too and returned a 23-colour, crisp pixel version at the
source's size; of the upscalers, Topaz smoothed the art, Upscale V3 repainted it
as a photoreal castle, and Recraft Crisp returned WebP, which the adapter refuses,
so none of them suits pixel art. Pixelate's output also passed `pixelkiln refine`'s
high-confidence grid gate as a 102×102, 23-colour asset, where the raw image
(low confidence) and Pixel Snapper's output (medium) did not: GPT Image 2,
then Pixelate, then free refinement made one gate-passing asset for 16 CU. They overlap PixelKiln's own offline work: `pixelkiln refine` snaps
the grid and palette for free, and PixelLab's `remove-background` revision costs
one generation. Reach for these when the art is already on Scenario.

### Retro Diffusion on Scenario

Scenario hosts three Retro Diffusion models, and they are the most pixel-art-specific
models in its catalog: `model_retrodiffusion-plus` (18 styles from `default` and
`retro` to `isometric_asset`, `topdown_asset`, `character_turnaround`, and
`ui_element`), `model_retrodiffusion-tile` (`tileset`, `tileset_advanced`,
`single_tile`, `tile_variation`, `tile_object`, `scene_object`), and
`model_retrodiffusion-animation` (`four_angle_walking`, `walking_and_idle`,
`small_sprites`, `vfx`). On a `cu-basic` account every dry run answered
`ModelAccessRestrictedError` with `requiredPlan: cu-pro-q3-25`, so none of this
has been run, and no price is known until the plan is upgraded.

Judging from Scenario's parameter reference (nothing here was exercised), what
the adapter already supports and what it does not:

| Need | Status |
|---|---|
| `style`, `removeBg`, `tileX`, `tileY`, `strength`, `bypassPromptExpansion` | Pass-through `parameters`. |
| 16 to 384 px canvas | Accepted now; the model's bound comes from the free dry run. |
| `image` (image-to-image) | Supported through an `image-to-image` revision with `referenceParameter: "image"` and `referenceArray: false`. |
| `inputPalette` (a palette image) | Not supported: the adapter has one reference input. |
| More than 4 outputs (Plus and Tile allow 10) | Not supported: `numOutputs` stops at 4. |
| Animation as a PNG spritesheet (`returnSpritesheet: true`) | Lands as one still image; there is no frame-set output for Scenario, so a person would slice it. The default GIF output is refused. |
| Tilesets | Land as one still; PixelKiln's tile roles and exports do not apply. |

PixelKiln also has a direct [Retro Diffusion](./RETRO_DIFFUSION.md) provider
with live-tested single stills. Choosing between them is a billing and plan
question (Retro Diffusion's USD credits against Scenario's compute units), not a
feature one, until the Scenario route is measured. The first live check after
upgrading should be one `model_retrodiffusion-plus` still at 64×64 with the
default style: quote, billed amount, dimensions, and whether it comes back as
PNG.

### Chaining models and tools

The [pipeline run](../benchmarks/provider-scenario-pipeline/README.md)
generated a character, pixelated it to a palette, cut out its background, and
refined it, for 8 CU on the cheapest path and 18 CU with GPT Image 2, ending in
a 64×64 transparent sprite that passed the `refine` gate. Three rules came out
of it:

- A style has one model, so a chain spans styles. Name the parent's style with
  `revision.fromStyle` (see [Across styles](./REVISIONS.md#across-styles)); the
  child is blocked until the parent is generated, and `gen` runs the whole chain
  in one invocation, one wave per link. The
  [chain run](../benchmarks/provider-scenario-chain/README.md) did this live in
  8 CU. (The pipeline benchmark was run before `fromStyle` existed, so it
  restates each output as a placed `source` and runs `gen --style` per step.)
- A `quality` profile gates every asset in its style, parents included, so a raw
  parent in the same style blocks its own child. Put `quality` on the last style
  of the chain, whose parents are in other styles, then run
  `pixelkiln refine --style`.
- Pass the same palette to the tool (Pixelate's `colorPalette`) and to
  `quality.palette`. The output then stays inside it.

A palette that is too small for the art costs fidelity (a bright blue cape
became navy under a 32-colour palette), so passing the gate is not approval.

### Large and illustrative art: render big, pixelate, refine

A [game pilot](../benchmarks/provider-scenario-game-pilot/README.md) ran the
chain on a real game's large landmarks (240 px wide, 176 to 224 px tall) and on a
course cover, and it is where Scenario earned a place: a strong model renders the
art at four times its final size, Pixelate reduces it to the target grid on a
bounded palette, Birefnet removes the background, and `refine` confirms the
grid. It is poor at the opposite end: 32 px props lose their shape.

| Step | Setting that worked |
|---|---|
| Render | GPT Image 2 (`quality: medium`, flat 11 CU at any canvas size; `high` is 44), or FLUX.2 Klein 9b (1 CU). Ask for the subject isolated on a plain white background, with no ground or shadow. Canvas four times the target. |
| Pixelate | `pixelGridSize` and `colorPaletteSize` 64. **On an input wider than about 512 px the grid is not literal:** 240 asked on a 960 px image gave 2 px blocks (480 cells), 120 gave 4 px blocks (240 cells). Test one image and read the blocks before a batch. |
| Cut out | Birefnet, 2 CU. |
| Refine | `pixelkiln refine` with the image's own 64 most common colours. |

With the right grid, a 960×832 render of a ski lodge came back as a **240×208**
native grid at **high** confidence, the same size as the game's existing
sprite, and visibly more detailed. At twice the grid the detector reported
medium confidence and a doubled grid, so a result that is not high is a sign the
grid was mis-set, not that the art is bad. The 1 CU Klein render of a temple was
about as good as the 11 CU GPT one. One chain costs 8 CU (Klein) or 18 CU (GPT
Image 2).

For a **cover or key art**, GPT Image 2 at four times the size, then Pixelate at a
grid giving the target width, produced a convincing pixel scene with 31 colours.
It renders legible title text, which PixelLab does not, and the text survives
Pixelate. Before pixelating it is a painterly illustration, not pixel art.

Do not use this for small native-size props. A winter pine and an autumn tree at
32 px came back as different trees, and Birefnet left holes in the canopy. A
free recolour of the original, or a PixelLab generation at the native size, is
the better tool there.

### Sound effects and other non-image models

The adapter handles still images only, but Scenario's audio models are reachable
through the same account. A call outside PixelKiln (`POST /generate/custom/{model}`,
then poll `/jobs/{id}` and fetch the asset) produced a sound effect for 1 CU;
nothing about it is recorded in a lockfile. Measured on October 5, 2026:

| Model | CU | Output |
|---|---:|---|
| `model_mm-audio-2-t2a` (MM Audio SFX) | 1, flat at any duration | Mono MP3, 44.1 kHz, 64 kbps |
| `model_elevenlabs-sound-effects-v2` | 30, flat at any duration | Stereo MP3, 44.1 kHz, 128 kbps |

Both ignore the duration for pricing, so ask for the length the game needs. A
prompt that narrates a sequence ("chains rattle, then the disc drops into the
tray") came back at the full requested length with the events spread out;
asking for one fast sound and a duration of 1.0 to 1.4 seconds, then trimming
leading and trailing silence, helps, but it was not enough on its own.

**What finally worked for a two-part impact** (a disc hitting a basket's chains,
then landing on its bars), judged by the game's owner by ear:

- **Generate each event as its own sound and layer them.** One prompt cannot carry
  two events. MM Audio returned ambience for an impact prompt (its "drop" came
  back at -50 dB, near silence) and ElevenLabs was the only model that made
  distinct hits; an envelope check (the share of time within 20 dB of the peak,
  and the count of sharp onsets) caught the ambience before anyone listened.
- **Describe the physical object, not a word that implies a cavity.** "Hollow
  steel basket" produced a bucket-like clank with echo. What worked was "a plastic
  disc landing on a ring of thin steel bars: a dry plastic-on-metal clack followed
  by a quick tinny rattle against the metal rods, outdoors in open air,
  completely dry, no echo, no reverb, no hollow resonance, no bucket sound."
  The chain layer used "loose steel chain links rattling and jangling ... close up,
  dry, no room reverb, no background noise."
- **Expect big variation between takes.** Re-running the same ElevenLabs prompt
  gave drops of 65 ms, 114 ms, 166 ms and 274 ms; the owner picked the second of
  three re-runs. There is no seed, so keep the chosen file and note the prompt.
- **Layer with ffmpeg:** trim silence below -50 dB at both ends, high-pass at
  60 Hz, `loudnorm` each part to -18 LUFS, delay the second part about 260 ms,
  `amix` without normalisation, limit at 0.89, then `loudnorm` the mix to -16 LUFS.

One finished two-part effect cost about 210 CU of ElevenLabs generations here (a
chain layer and six drop attempts at 30 CU each), after about 70 CU of cheaper
attempts that did not work, so budget for several takes of each part. Because a game's sounds should share one tone, fix the prompt
wording ("close up, dry, no room reverb, no background noise"), the model, and
the post chain above for every effect, and record each effect's prompts, model
and post steps beside the file.

Music models (ACE-Step, MusicGen, ElevenLabs Music, Lyria 3.5) quoted 10 to 30
CU; Sonilo and Lyria 3 Pro need the `cu-pro-q3-25` plan. Music was not generated.

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
