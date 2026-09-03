# ComfyUI large-output benchmark

This project tests two ways to deliver larger ComfyUI environments without
blurring the pixel grid. Every output uses SDXL Base 1.0, Pixel Art XL, the same
brief, a fixed seed, and a 64-color palette.

| Style | Generation and delivery | Purpose |
|---|---|---|
| `baseline-64` | Generate and save at 1024×1024 | Square quality baseline |
| `pixel-perfect-2x` | Generate at 1024×1024, then scale to 2048×2048 with `nearest-exact` | Larger delivery file with identical hard edges |
| `native-wide-64` | Generate and save directly at 1344×768 | More horizontal scene area without a refinement pass |

Run the benchmark against a local ComfyUI server:

```bash
npm run pixelkiln -- doctor --manifest benchmarks/provider-hires/comfyui/pixelkiln.manifest.json
npm run pixelkiln -- plan --manifest benchmarks/provider-hires/comfyui/pixelkiln.manifest.json
npm run pixelkiln -- gen --manifest benchmarks/provider-hires/comfyui/pixelkiln.manifest.json --budget 0
npm run pixelkiln -- audit --manifest benchmarks/provider-hires/comfyui/pixelkiln.manifest.json --max-colors 64 --check
```

The workflows use ComfyUI core nodes only and require no extra model. The 2×
workflow quantizes before integer scaling, so each source pixel becomes an
exact 2×2 block. The wide workflow samples once at its final aspect ratio; it
does not make a second trip through the VAE.

Measured on the committed PNGs:

| Style | RGB colors | File size | Mean neighbor delta | Strong edges |
|---|---:|---:|---:|---:|
| `baseline-64` | 64 | 373.8 KiB | 2.11 | 0.80% |
| `pixel-perfect-2x` | 64 | 479.1 KiB | 1.06 | 0.40% |
| `native-wide-64` | 64 | 467.3 KiB | 2.20 | 0.43% |

Neighbor delta is the mean RGB difference between adjacent pixels. Strong
edges are adjacent pairs whose mean channel difference is at least 32. These
measurements do not decide taste. The 2× values are exactly half the baseline
because adjacent pixels are duplicated; that is expected and does not indicate
blur. Every original boundary remains a hard boundary at twice the width and
height.

We also tested 1536px and 2048px latent refinement. Those passes completed on a
64 GB M1 Max, but `bislerp`, another diffusion pass, and another VAE decode
softened the shapes. Palette quantization could not restore the lost edges.
Those workflows and images were rejected rather than published as recommended
quality presets.
