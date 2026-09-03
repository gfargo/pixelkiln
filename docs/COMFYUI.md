# Set up ComfyUI

PixelKiln can run a committed ComfyUI workflow on a self-hosted server. This
adapter is experimental. It supports still-image `map` jobs, one or more review
candidates, local provenance, and cache-backed recovery. A core-node Stable
Diffusion 1.5 workflow has passed single-image generation and a four-candidate
review queue on Apple MPS. A higher-quality SDXL workflow has also passed four
building and environment renders. ComfyUI Cloud is not part of this release.

## Start ComfyUI

Install and start ComfyUI using its
[official installation guide](https://docs.comfy.org/installation/overview).
PixelKiln connects to `http://127.0.0.1:8188` by default. Set a different URL
only when ComfyUI listens elsewhere:

```dotenv
COMFYUI_BASE_URL=http://127.0.0.1:8188
```

No API key is required for the standard local server. Keep an unauthenticated
server on loopback. If you expose it to another machine, put authentication and
TLS in front of it, then point `COMFYUI_BASE_URL` at that protected endpoint.

Check the connection without generating an image:

```bash
pixelkiln doctor
```

## Export an API-format workflow

Build and test the workflow in ComfyUI first. Enable developer mode in ComfyUI
settings, then use **Save (API Format)**. Commit the exported JSON beside the
manifest or in a project workflow directory. PixelKiln reads the file during
planning and hashes its parsed JSON, so a node or model change marks dependent
assets stale even if the filename stays the same.

The output node must expose an `images` array in ComfyUI history. A standard
`SaveImage` node does this. Record these node IDs and input names from the
exported JSON:

- the positive text encoder's prompt input;
- the latent image width, height, and batch-size inputs;
- the sampler seed input, when the PixelKiln style declares a seed;
- the final `SaveImage` node.

Node IDs are workflow-specific. Do not copy IDs from an example without
checking the exported file.

The repository includes a working core-node
[smoke project](../examples/comfyui/README.md). It uses the public checkpoint
from ComfyUI's official first-generation guide to test plumbing, not to claim
pixel-art quality.

## Install the tested quality stack

The committed quality benchmark uses two public model files:

| File | ComfyUI folder | SHA-256 | License named by the model card |
|---|---|---|---|
| [`sd_xl_base_1.0.safetensors`](https://huggingface.co/stabilityai/stable-diffusion-xl-base-1.0/blob/main/sd_xl_base_1.0.safetensors) | `models/checkpoints` | `31e35c80fc4829d14f90153f4c74cd59c90b779f6afe05a74cd6120b893f7e5b` | CreativeML Open RAIL++-M |
| [`pixel-art-xl.safetensors`](https://huggingface.co/nerijs/pixel-art-xl/blob/main/pixel-art-xl.safetensors) | `models/loras` | `4234637cb80c998f41e348e6a6cb6bc20d8d038b2b0f256b6129b3b5e353eef7` | CreativeML OpenRAIL-M |

Download each file into the named folder, verify its checksum, then confirm the
checkpoint and LoRA appear in ComfyUI. The files are about 6.9 GB and 171 MB.
They are not bundled with PixelKiln. Read both model cards before distributing
the models or their outputs.

The benchmark renders at 1024×1024, where SDXL has enough room to compose the
scene, then uses ComfyUI's core `ImageScale` node with `nearest-exact` to write
the requested 256px or 384px PNG. Asset width and height are therefore bound to
the scale node, not the latent node. This is the useful trick: keep the model at
its working resolution while PixelKiln still validates the exact game-ready
output dimensions.

You can reproduce the four samples with the committed
[ComfyUI benchmark project](../benchmarks/provider-environments/comfyui/README.md).

## Configure the manifest

Put dimensions on each asset. Put workflow configuration under
`providerOptions.comfyui` on the style:

```jsonc
{
  "name": "my-game",
  "provider": "comfyui",
  "styles": {
    "local-environment": {
      "generator": "map",
      "outDir": "assets/generated/environments",
      "seed": 31415,
      "providerOptions": {
        "comfyui": {
          "workflowFile": "workflows/pixel-environment-api.json",
          "outputNodeId": "9",
          "numImages": 4,
          "bindings": {
            "prompt": { "nodeId": "6", "input": "text" },
            "width": { "nodeId": "5", "input": "width" },
            "height": { "nodeId": "5", "input": "height" },
            "batchSize": { "nodeId": "5", "input": "batch_size" },
            "seed": { "nodeId": "3", "input": "seed" }
          }
        }
      }
    }
  },
  "assets": {
    "cliffside_fortress": {
      "prompt": "a fortified monastery carved into a mountain cliff",
      "width": 768,
      "height": 512
    }
  }
}
```

| Option | Meaning |
|---|---|
| `workflowFile` | API-format workflow JSON, relative to the manifest. |
| `outputNodeId` | Node whose completed history contains the final `images` array. |
| `numImages` | Expected candidates, from 1 to 16. Defaults to 1. |
| `bindings.prompt` | Workflow input replaced with the resolved PixelKiln prompt. |
| `bindings.width` / `height` | Inputs replaced with the asset dimensions. |
| `bindings.batchSize` | Input replaced with `numImages`. |
| `bindings.seed` | Optional sampler seed input. Required when the style declares `seed`. |

PixelKiln refuses missing nodes and inputs during the offline plan. It also
clones the workflow before applying bindings, so one asset cannot mutate the
next asset's request.

## Plan, generate, and review

```bash
pixelkiln doctor --dry-run
pixelkiln plan
pixelkiln gen --style local-environment --only cliffside_fortress --budget 0
```

Local ComfyUI work uses the `free` PixelKiln cost unit and therefore requires a
zero budget. That means there is no metered provider charge. It does not claim
that GPU time, electricity, hosted hardware, or model licenses are free.

When `numImages` is greater than one, `pixelkiln pick` opens the same local
candidate review used by hosted providers. The lockfile stores the ComfyUI
prompt ID, output node, workflow hash, and selected output. Durable source
references use `comfyui://` rather than embedding a workstation hostname.
`pixelkiln restore` first uses the validated local content cache, then resolves
the portable reference against the current `COMFYUI_BASE_URL`.

## Current boundary

- Supported generator: `map`.
- Supported output: PNG images returned by one output node.
- Supported dimensions: 16–4096px per edge, subject to the workflow, model,
  sampler, VRAM, and node constraints.
- PixelKiln `styleImages` and `palette` are rejected. Put image references,
  ControlNet, LoRA, palette, and other controls inside the committed workflow.
- Video, animation, masks, multiple output nodes, uploads, and ComfyUI Cloud
  authentication are not implemented.
- PixelKiln does not install checkpoints or custom nodes. Every machine running
  the project must provide the models and nodes named by the workflow. The
  benchmark workflows use only core ComfyUI nodes.

For large mountains, buildings, and backgrounds, model choice and working
resolution matter more than the provider label. The SDXL benchmark produced a
coherent 384px cliff fortress and two layered environments where the starter
SD1.5 workflow did not. It still returned opaque isolated assets and thousands
of source colors, so transparency and palette reduction remain separate art
pipeline steps. Benchmark the exact committed workflow before assigning it a
production batch.

## Troubleshooting

- **Connection refused:** start ComfyUI or correct `COMFYUI_BASE_URL`.
- **Missing node or input:** export the workflow again and update the manifest
  bindings to match its API JSON.
- **Prompt validation failed:** open the workflow in ComfyUI and check missing
  custom nodes, checkpoints, VAEs, LoRAs, and invalid node values.
- **Wrong image count:** make the bound batch input and `numImages` describe the
  same final output count. PixelKiln fails the job rather than recording a
  partial candidate set.
- **Out of memory:** lower asset dimensions or batch size, or change the
  workflow. PixelKiln's 4096px ceiling is a schema limit, not a promise that a
  particular machine can render that canvas.

ComfyUI's official server route reference documents the `/prompt`,
`/history/{prompt_id}`, `/view`, and `/system_stats` endpoints used by this
adapter: <https://docs.comfy.org/development/comfyui-server/comms_routes>.
