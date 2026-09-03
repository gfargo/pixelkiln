# Set up ComfyUI

PixelKiln can run a committed ComfyUI workflow on a self-hosted server. This
adapter is experimental. It supports still-image `map` jobs, one or more review
candidates, local provenance, and cache-backed recovery. A core-node Stable
Diffusion 1.5 workflow has passed single-image generation and a four-candidate
review queue on Apple MPS. A higher-quality SDXL workflow has also passed four
building and environment renders. ComfyUI Cloud is not part of this release.

[Visit ComfyUI](https://www.comfy.org/) or continue with the local setup below.

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

The committed quality and post-processing benchmarks use three public model
files:

| File | ComfyUI folder | SHA-256 | License named by the model card |
|---|---|---|---|
| [`sd_xl_base_1.0.safetensors`](https://huggingface.co/stabilityai/stable-diffusion-xl-base-1.0/blob/main/sd_xl_base_1.0.safetensors) | `models/checkpoints` | `31e35c80fc4829d14f90153f4c74cd59c90b779f6afe05a74cd6120b893f7e5b` | CreativeML Open RAIL++-M |
| [`pixel-art-xl.safetensors`](https://huggingface.co/nerijs/pixel-art-xl/blob/main/pixel-art-xl.safetensors) | `models/loras` | `4234637cb80c998f41e348e6a6cb6bc20d8d038b2b0f256b6129b3b5e353eef7` | CreativeML OpenRAIL-M |
| [`birefnet.safetensors`](https://huggingface.co/Comfy-Org/BiRefNet/blob/main/background_removal/birefnet.safetensors) | `models/background_removal` | `9ab37426bf4de0567af6b5d21b16151357149139362e6e8992021b8ce356a154` | MIT |

Download each file into the named folder, verify its checksum, then confirm the
checkpoint, LoRA, and background-removal model appear in ComfyUI. The files are
about 6.9 GB, 171 MB, and 444 MB. They are not bundled with PixelKiln. Read the
model cards before distributing the models or their outputs.

The benchmark renders at 1024×1024, where SDXL has enough room to compose the
scene, then uses ComfyUI's core `ImageScale` node with `nearest-exact` to write
the requested 256px or 384px PNG. Asset width and height are therefore bound to
the scale node, not the latent node. This is the useful trick: keep the model at
its working resolution while PixelKiln still validates the exact game-ready
output dimensions.

You can reproduce the four samples with the committed
[ComfyUI benchmark project](../benchmarks/provider-environments/comfyui/README.md).

## Remove backgrounds and control the palette

ComfyUI 0.34.3 has the required nodes in core. No custom-node package is needed.
The tested isolated-asset graph runs these nodes in this order:

1. Decode the 1024×1024 SDXL image.
2. Run `RemoveBackground` with the loaded BiRefNet model.
3. Invert the returned background mask for use as foreground alpha.
4. Run `ImageQuantize` on the RGB image with 64 colors and no dithering.
5. Join the quantized RGB image with the alpha mask.
6. Reduce the RGBA result with `ImageScale` set to `nearest-exact`.

The order is deliberate. BiRefNet sees the full-resolution, full-color image,
while quantization cannot damage the mask. Scenic backgrounds skip BiRefNet
and use only 64-color quantization before the final scale.

The [post-processing benchmark](../benchmarks/provider-postprocessing/comfyui/README.md)
reuses the same prompts, seeds, SDXL settings, and LoRA strengths as the first
ComfyUI run. Its two isolated assets have 60% and 62% transparent pixels and 55
and 58 RGB colors. The two backgrounds use 64 and 60 colors. The original
files ranged from 16,811 to 50,985 colors.

Use PixelKiln to keep those requirements enforceable:

```bash
pixelkiln audit --style isolated-refined --min-transparency 0.5 --max-colors 64 --check
pixelkiln audit --style background-refined --max-colors 64 --check
```

Start without dithering for compact game art. Floyd-Steinberg can soften bands,
but it adds noisy pixel patterns. Ordered Bayer dithering is easier to art-direct
when a project needs deliberate texture. Whichever mode you choose becomes part
of the committed workflow hash.

## Render larger environment masters

PixelKiln accepts outputs up to 4096px per edge, but file dimensions and
generated detail are separate concerns. The tested pixel-art stack has two
reliable ways to make larger environments:

1. Generate once at a useful SDXL canvas. The benchmark validates 1024×1024
   and a native 1344×768 wide composition.
2. For a larger delivery file, quantize first and scale by an integer with
   `ImageScale` set to `nearest-exact`. The tested 2× workflow turns each source
   pixel into an exact 2×2 block and writes a crisp 2048×2048 PNG.

Do not add a latent refinement pass by default. We tested `LatentUpscale` to
1536px and 2048px, low-denoise resampling, and tiled VAE decode. Every version
completed on the 64 GB M1 Max, but the extra interpolation, diffusion, and VAE
round trip visibly blurred the shapes. Reducing the result to 64 colors did not
restore the lost edges.

The committed [large-output benchmark](../benchmarks/provider-hires/comfyui/README.md)
keeps the crisp results and documents the rejected latent-upscale experiment.
Use the native wide workflow when you need more horizontal composition. Use
integer scaling when you need a larger file or display size without changing
the art. Neither method pretends that duplicated pixels are new generated
detail.

For a scene that needs more distinct objects, generate the terrain, buildings,
foreground, and sky as separate assets and compose them. That gives the model
room to resolve each element and preserves a deliberate pixel grid better than
asking one diffusion pass to invent an enormous finished level.

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
SD1.5 workflow did not. Core post-processing then turned the isolated images
into transparent 64-color assets without changing their composition. Benchmark
the exact committed workflow before assigning it a production batch.

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
