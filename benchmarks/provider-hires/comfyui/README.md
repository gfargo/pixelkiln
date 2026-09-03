# ComfyUI high-resolution benchmark

This project compares four deterministic 1024×1024 treatments of the same SDXL
and Pixel Art XL environment, plus a 2048×2048 ceiling test. Every output uses
the same prompt and base seed.

| Style | Working graph | Palette | Purpose |
|---|---|---:|---|
| `baseline-64` | One 1024px sampling pass | 64 | Existing quality baseline |
| `hires-balanced-64` | 1024px base, 1536px latent pass at 0.28 denoise | 64 | More redrawn detail within a strict palette |
| `hires-balanced-128` | 1024px base, 1536px latent pass at 0.28 denoise | 128 | Showcase master with smoother color transitions |
| `hires-conservative-64` | 1024px base, 1536px latent pass at 0.16 denoise | 64 | Preserve more of the base pixel structure |
| `ultra-64` | 1024px base, 2048px latent pass at 0.14 denoise | 64 | Test the practical limit on the reference Mac |

Run the benchmark against a local ComfyUI server:

```bash
npm run pixelkiln -- doctor --manifest benchmarks/provider-hires/comfyui/pixelkiln.manifest.json
npm run pixelkiln -- plan --manifest benchmarks/provider-hires/comfyui/pixelkiln.manifest.json
npm run pixelkiln -- gen --manifest benchmarks/provider-hires/comfyui/pixelkiln.manifest.json --budget 0
npm run pixelkiln -- audit --manifest benchmarks/provider-hires/comfyui/pixelkiln.manifest.json --max-colors 128 --check
```

The two-pass workflows use only ComfyUI core nodes: `LatentUpscale`, a second
`KSampler`, `VAEDecodeTiled`, `ImageQuantize`, and `ImageScale`. They require no
new models or custom nodes beyond the files in the main ComfyUI setup guide.

This benchmark increases genuine working detail to 1536px. Merely scaling a
smaller decoded image to 1024px would increase file dimensions without adding
scene information.

Measured on the committed PNGs:

| Style | RGB colors | File size | Mean neighbor delta | Strong edges |
|---|---:|---:|---:|---:|
| `baseline-64` | 64 | 373.8 KiB | 2.11 | 0.80% |
| `hires-balanced-64` | 64 | 330.5 KiB | 2.13 | 0.48% |
| `hires-balanced-128` | 127 | 463.8 KiB | 2.22 | 0.54% |
| `hires-conservative-64` | 64 | 392.8 KiB | 2.67 | 0.96% |
| `ultra-64` | 64 | 1,220.6 KiB | 2.93 | 1.07% |

Neighbor delta is the mean RGB difference between adjacent pixels. Strong
edges are adjacent pairs whose mean channel difference is at least 32. These
measurements do not decide taste, but they confirm the visual read: the
conservative pass preserves the crispest local structure, while the balanced
passes trade some hard edges for smoother detail and lighting.

In a warm-cache run on a 64 GB M1 Max, the 0.16-denoise second pass took about
90 seconds and the 0.28-denoise pass took about 129 seconds. The cached base
render took about seven seconds to decode and save; an earlier cold base pass
took about 88 seconds. Expect a complete uncached high-resolution render to
take the base time plus its second pass.

The 2048px pass completed in 183 seconds with the base render cached. It did
not exhaust memory on the 64 GB reference machine, but it softened the broad
forms and grew the PNG to 1.2 MiB. It is a proven ceiling, not the recommended
default. The 1536px conservative pass is the better balance for this brief.
