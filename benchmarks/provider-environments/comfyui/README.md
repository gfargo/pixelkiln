# ComfyUI SDXL environment benchmark

This project extends the hosted-provider environment benchmark with a named,
reproducible ComfyUI stack. It uses SDXL Base 1.0, Pixel Art XL, and core
ComfyUI nodes only.

Install the two files listed in the [ComfyUI setup guide](../../../docs/COMFYUI.md),
start the local server, then run:

```bash
npm run pixelkiln -- doctor --manifest benchmarks/provider-environments/comfyui/pixelkiln.manifest.json
npm run pixelkiln -- plan --manifest benchmarks/provider-environments/comfyui/pixelkiln.manifest.json
npm run pixelkiln -- gen --manifest benchmarks/provider-environments/comfyui/pixelkiln.manifest.json --budget 0
```

The two API-format workflows render a 1024×1024 latent and reduce it with
`nearest-exact` at the end. PixelKiln binds requested width and height to that
final scale node. The isolated workflow applies the LoRA at strength `1.0`; the
background workflow uses `0.85` to leave SDXL more room for landscape depth.

The lockfile records the workflow hashes, seeds, ComfyUI prompt IDs, portable
source references, and output hashes. The PNGs live with the website benchmark
so the documentation shows the files produced by this exact project.
