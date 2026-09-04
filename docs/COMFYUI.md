# Set up ComfyUI

PixelKiln can run a committed ComfyUI workflow on a self-hosted server. This
adapter is experimental. It supports still-image `map` jobs, one or more review
candidates, local provenance, and cache-backed recovery. A core-node Stable
Diffusion 1.5 workflow has passed single-image generation and a four-candidate
review queue on Apple MPS. An SDXL composition workflow has also passed four
building and environment renders. ComfyUI Cloud is not part of this release.

[Visit ComfyUI](https://www.comfy.org/) or continue with the local setup below.

## When to use ComfyUI

Use this adapter when local control, private inputs, or a custom graph justify
the maintenance work. It is not a shortcut to finished pixel art. The tested
SDXL plus Pixel Art XL graph can establish a composition, but its output still
needs native-grid recovery, a final palette, and human review.

If the main goal is the shortest path to usable pixel art, compare PixelLab and
Retro Diffusion first. Choose ComfyUI when owning the workflow is worth the
extra model testing and cleanup.

### Quality-first workflow

1. Generate two to four candidates at the model's normal working size.
2. Reject missing subjects, weak silhouettes, and bad composition before doing
   any cleanup.
3. For isolated art, remove the background at full resolution.
4. Run `pixelkiln refine` to recover one native pixel per detected cell and
   apply the final project palette. Start with 16–32 colors and no dithering.
5. Review the native file at 1× and an integer zoom, then record it with
   `pixelkiln refine approve`.
6. Run `pixelkiln refine check` before packaging or release.
7. Keep the smallest clear result. Start with 48–128px native components and
   compose larger scenes from accepted parts.

Stop after step 2 when the image misses the brief. Background removal,
pixel-grid recovery, and palette reduction cannot restore a missing building or
repair a weak composition.

PixelKiln automates generation, candidate review, cache recovery, grid
reconstruction, palette checks, and the approval record. Background removal
stays in the ComfyUI graph. A person still decides whether the image is good.
Do not package it until `pixelkiln refine check` passes.

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

For the tested SDXL environment graph, start from the bundled versioned recipe
instead of copying node IDs by hand:

```bash
pixelkiln recipe install comfyui/pixel-art-xl-environment@1.0.0
pixelkiln recipe verify \
  pixelkiln-recipes/comfyui/pixel-art-xl-environment/1.0.0 \
  --model-root /path/to/ComfyUI/models
```

Installation prints the manifest style entry. The recipe pins the workflow and
model hashes, records their licenses and source links, and labels the output as
composition source. It does not download models or turn the result into
finished pixel art. See [Versioned recipes](RECIPES.md) for its update and
verification contract.

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

## Install the tested composition stack

The committed composition and post-processing benchmarks use three public model
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

The environment benchmark renders at 1024×1024, where SDXL has enough room to
compose the scene, then uses ComfyUI's core `ImageScale` node with
`nearest-exact` to write the requested 256px or 384px PNG. Asset width and
height are therefore bound to the scale node, not the latent node. Those files
prove exact delivery dimensions; they do not prove a native pixel grid. The
separate native-grid benchmark saves the model canvas and reconstructs its
implied cells afterward.

You can reproduce the four samples with the committed
[ComfyUI benchmark project](../benchmarks/provider-environments/comfyui/README.md).

## Background removal and palette experiments

ComfyUI 0.34.3 has the required nodes in core. No custom-node package is needed.
The tested isolated-asset graph runs these nodes in this order:

1. Decode the 1024×1024 SDXL image.
2. Run `RemoveBackground` with the loaded BiRefNet model.
3. Invert the returned background mask for use as foreground alpha.
4. Run `ImageQuantize` on the RGB image with 64 colors and no dithering.
5. Join the quantized RGB image with the alpha mask.
6. Reduce the RGBA result with `ImageScale` set to `nearest-exact`.

This graph tests the cleanup nodes; it is not the recommended final pipeline.
BiRefNet sees the full-resolution color image, so the graph preserves its alpha
mask. Quantizing before reduction does not cap the later native-grid palette,
because grid recovery can introduce averaged colors.

For an isolated production candidate, use this order instead:

1. decode the full-resolution model output;
2. remove its background and preserve the alpha mask;
3. recover the native pixel grid without resampling the alpha edge;
4. quantize the recovered native RGB image to the final project palette;
5. audit and review the final native RGBA file.

Scenic backgrounds skip background removal. They still need grid recovery,
final palette enforcement, and review.

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

## Recover a native pixel grid

File size is not pixel-art resolution. Keep these three measurements separate:

1. The **generation canvas** is the raster SDXL produces, such as 1024×1024.
2. The **native art grid** has one stored pixel for each editable pixel-art cell.
3. The **display size** is an integer-scaled view of the native art.

Pixel Art XL can draw convincing pixel-shaped texture without producing a
consistent one-pixel grid. Our 1024×1024 test image carried an implied 8px cell
and resolved to 128×128 native art. Its 1344×768 wide version resolved to 168×96.
Nearest-neighbor scaling preserved those fake cells but did not fix them.

Retro Diffusion's MIT-licensed
[Pixel Art Fixer](https://github.com/Retro-Diffusion/pixel-art-fixer) detects the
implied grid and reconstructs one output pixel per cell. Both benchmark sources
returned the high-confidence `fast:ac+rl(S)` decision. The checked-in
[native-grid boundary benchmark](../benchmarks/provider-hires/comfyui/README.md) includes
the source PNGs, native reconstructions, dimensions, hashes, and pinned fixer
revision.

Treat the native PNG as the canonical asset. Edit and compose it at 1×. Scale it
only for display, using integer dimensions and nearest-neighbor rendering. A
2048px file made from a 1024px pseudo-pixel source is not higher-quality pixel
art, even when every source pixel becomes an exact 2×2 block.

The open fixer is deterministic image processing. Its maintainers also offer a
[hosted neural fixer](https://www.retrodiffusion.ai/tools/pixel-art-fixer/) for
damaged inputs where a reliable grid no longer exists. PixelKiln does not yet
call the hosted service. The local `refine` command uses the open fixer's Python
API and records its revision and detector result.

### Install the refiner

Keep the refiner separate from Comfy Desktop's Python environment. These are
the commands used for the checked-in benchmark:

```bash
uv venv .pixelkiln/pixelfixer --python 3.12
uv pip install \
  --python .pixelkiln/pixelfixer/bin/python \
  "git+https://github.com/Retro-Diffusion/pixel-art-fixer.git@ef376e57e1c272633ca2dbf5f29ec3fcf6596465#subdirectory=python"
```

`.pixelkiln/` is ignored by the repository. It is local tooling, not a project
artifact. If `uv` is unavailable, create a Python 3.12 virtual environment and
install the same pinned Git URL with that environment's pip. On Windows, pass
the environment's `Scripts/python.exe` path to `--fixer-python`.

Run refinement only after choosing a candidate and removing the background for
an isolated asset:

```bash
PALETTE="#141b1e,#23312a,#384d4f,#526a8d,#709fcf,#865c45,#c6a766,#f1bb70"

pixelkiln refine \
  --from working-canvas.png \
  --out art/mountain-native.png \
  --palette "$PALETTE" \
  --fixer-python .pixelkiln/pixelfixer/bin/python

pixelkiln refine approve \
  --from art/mountain-native.pixelkiln.json \
  --reviewer "Your Name"

pixelkiln refine check --from art/mountain-native.pixelkiln.json
```

The default requires the fixer's high-confidence result and writes nothing when
the detected dimensions disagree with the reconstructed PNG. It preserves
alpha, uses nearest-color redmean distance, and never dithers. The companion
starts with review status `pending`. Approval becomes stale when the source,
output, palette metadata, fixer revision, audit, or approval record changes.
The pinned fixer's API accepts images with a minimum 16px side and at most four
million source pixels. Crop or split a larger working canvas before refinement.

### Quality-first resolution policy

Use 48×48 through 128×128 as the default native range for an independently
generated component with this tested stack. This is an operating range, not an
adapter restriction: ComfyUI may work on a 1024px canvas internally, and a wide
or tall asset may exceed one native axis when review supports it. Do not grow
both native dimensions merely because the machine can render them. This matches
the [Aseprite Diffusion author's published working range](https://www.reddit.com/r/PixelArt/comments/yv2q51/making_high_quality_game_tiles_in_less_than_a/)
of 48–128px, centered on a 64px native target, and our current 128px recovery.

Start with a 16–32 color project palette. Add colors only when they
improve readable depth, material, or lighting. After grid recovery, review the
asset at 1× and an integer zoom for silhouette, clusters, contours, single-pixel
noise, palette separation, and seams. High-confidence grid detection only
proves structure; it is not an aesthetic approval.

Test a proposed graph and prompt pattern on at least two different scene
families. One prompt can clean up one subject and damage another. Generate a
small candidate set, reject any image that misses required objects, and keep the
prompt and workflow only when the final native files improve consistently.

Stop increasing resolution when clusters become soft, gradients replace
intentional ramps, or important forms stop reading at 1×. Keep the smaller
result when it is clearer. See the [quality gates](./QUALITY.md) for the human
review checklist.

PixelKiln's committed ComfyUI examples also have an automated regression
baseline. `npm run test:quality` checks that their dimensions, palettes, alpha,
edge structure, isolated-pixel noise, and bound refinement records have not
drifted. Use `pixelkiln quality snapshot` to establish the same guard for a
project's reviewed assets. Passing it does not make an image good; it only
proves that measured traits have not regressed from the accepted reference.

## Build larger environments

Do not ask the model for one enormous finished level. Generate and review the
scene as 48–128px native-grid parts:

- sky and atmosphere;
- distant mountains;
- midground terrain and forest;
- buildings and landmarks;
- foreground framing and gameplay tiles.

Keep one grid origin, native scale, and palette contract across the parts, then
compose them at 1×. This preserves editable clusters and lets you regenerate one
weak region without touching the rest of the scene.

ComfyUI's official [outpainting workflow](https://docs.comfy.org/tutorials/basic/outpaint)
can extend a canvas. The official
[crop-and-stitch nodes](https://github.com/comfyorg/comfyui-crop-and-stitch) can
sample a region at the model's working size and blend it back.
[Tiled diffusion](https://github.com/comfyorg/comfyui-tiled-diffusion) can cover
a larger semantic canvas with overlapping windows. These techniques help
composition and regional detail; none guarantees a native pixel grid. Run grid
recovery after accepting each layer or the final composite. Check licenses
before shipping: the linked tiled implementation marks its MultiDiffusion,
Mixture of Diffusers, and tiled VAE code as non-commercial share-alike.

Do not add a latent refinement pass by default. We tested `LatentUpscale` to
1536px and 2048px, low-denoise resampling, and tiled VAE decode. Every version
completed on the 64 GB M1 Max, but the extra interpolation, diffusion, and VAE
round trip visibly blurred the shapes. Reducing the result to 64 colors did not
restore the lost structure.

The neural [ComfyUI Pixelization](https://github.com/DarioFT/ComfyUI-Pixelization)
node is another possible raster-to-pixel-art step, but its underlying model is
limited to non-commercial research use. It is not a safe default for a general
game-asset pipeline.

### What each technique can and cannot do

| Technique | Useful for | Limitation |
|---|---|---|
| [Pixel Art Fixer](https://github.com/Retro-Diffusion/pixel-art-fixer) | Recovering a native grid from softened, non-integer, or oversized pseudo-pixel art | Classical detection can fail when the grid is badly damaged or cells are very small |
| [ComfyUI Pixelization](https://github.com/DarioFT/ComfyUI-Pixelization) | Turning ordinary digital art into sharper, cell-controlled pixel art | Underlying model is non-commercial research only and may damage existing pixel art |
| [Outpainting](https://docs.comfy.org/tutorials/basic/outpaint) | Extending the scene beyond its current borders | Produces more raster canvas, not a guaranteed pixel grid |
| [Crop and Stitch](https://github.com/comfyorg/comfyui-crop-and-stitch) | Repairing one region at the model's preferred resolution | Blending and resampling still need native-grid normalization |
| [Tiled diffusion](https://github.com/comfyorg/comfyui-tiled-diffusion) | Panoramas, regional prompts, and canvases larger than working memory | The linked implementation has non-commercial components and does not enforce pixel cells |
| [MMPX](https://jcgt.org/published/0010/02/04/paper.pdf) | Magnifying true native pixel art while preserving its style | Assumes the input is already real pixel art; it cannot recover a fake grid |

That makes the deterministic fixer the best current structural fallback after
ComfyUI, not a quality generator. Use outpainting, regional generation, or tiles
to solve composition first. Recover the grid next, enforce palette and alpha
rules after that, perform the human art review, and reserve nearest-neighbor or
MMPX for presentation of an already-valid native asset.

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
- Provider generation may exceed the local refiner's four-million-pixel input
  limit. Crop or split those canvases before running `refine`.
- PixelKiln `styleImages` and `palette` are rejected. Put image references,
  ControlNet, LoRA, palette, and other controls inside the committed workflow.
- Video, animation, masks, multiple output nodes, uploads, and ComfyUI Cloud
  authentication are not implemented.
- PixelKiln does not install checkpoints or custom nodes. Every machine running
  the project must provide the models and nodes named by the workflow. The
  benchmark workflows use only core ComfyUI nodes.
- Background removal remains inside the committed ComfyUI graph. `refine`
  automates native-grid recovery, final palette enforcement, and measurable
  checks. A named human still approves the art at 1×; PixelKiln records and
  verifies that decision rather than making it.

For large mountains, buildings, and backgrounds, model choice and working
resolution matter more than the provider label. The SDXL benchmark produced a
coherent 384px cliff fortress and two layered environments where the starter
SD1.5 workflow did not. Those results still required manual structural and
visual review. Benchmark the exact committed workflow on more than one subject
before assigning it a production batch.

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
- **The result looks pixelated but muddy:** reject it as source material. Do not
  upscale it or accept it because grid detection succeeds. Compare a different
  model, prompt pattern, or smaller native target on at least two scene types.

ComfyUI's official server route reference documents the `/prompt`,
`/history/{prompt_id}`, `/view`, and `/system_stats` endpoints used by this
adapter: <https://docs.comfy.org/development/comfyui-server/comms_routes>.
