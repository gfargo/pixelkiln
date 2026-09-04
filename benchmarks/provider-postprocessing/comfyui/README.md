# ComfyUI post-processing benchmark

This project measures two cleanup steps on the SDXL plus Pixel Art XL benchmark:
BiRefNet background removal for isolated assets and fixed 64-color quantization
for every output. It uses ComfyUI 0.34.3 core nodes only.

This is a node and ordering experiment, not a finished pixel-art pipeline. Its
quantization happens before final scaling, so it does not enforce the palette of
a later native-grid reconstruction. Use the output as source material.

Install the three files listed in the [ComfyUI setup guide](../../../docs/COMFYUI.md),
start the local server, then run:

```bash
npm run pixelkiln -- doctor --manifest benchmarks/provider-postprocessing/comfyui/pixelkiln.manifest.json
npm run pixelkiln -- plan --manifest benchmarks/provider-postprocessing/comfyui/pixelkiln.manifest.json
npm run pixelkiln -- gen --manifest benchmarks/provider-postprocessing/comfyui/pixelkiln.manifest.json --budget 0
```

The prompts, seeds, SDXL sampler settings, and LoRA strengths match the original
ComfyUI environment benchmark. Only the post-processing graph changes. This
makes the original and refined PNGs a useful A/B check rather than two unrelated
generations.

For a production candidate, remove the background first, recover the native
grid, quantize the final native RGB image, preserve the recovered alpha channel,
then run the audit and human art review. The graph in this folder does not
automate that complete sequence.

Measured results:

| Asset | Output | Transparent pixels | RGB colors |
|---|---:|---:|---:|
| Mountain observatory | 256×256 | 60% | 55 |
| Cliffside fortress | 384×384 | 62% | 58 |
| Alpine valley | 256×256 | 0% | 64 |
| Volcanic pass | 384×384 | 0% | 60 |

Validate those limits with:

```bash
npm run pixelkiln -- audit --manifest benchmarks/provider-postprocessing/comfyui/pixelkiln.manifest.json --style isolated-refined --min-transparency 0.5 --max-colors 64 --check
npm run pixelkiln -- audit --manifest benchmarks/provider-postprocessing/comfyui/pixelkiln.manifest.json --style background-refined --max-colors 64 --check
```

The lockfile records the workflow hashes, model-bound graph, seeds, ComfyUI
prompt IDs, portable sources, and exact output hashes.
