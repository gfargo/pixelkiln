# ComfyUI native-grid boundary benchmark

This project separates three sizes that should not be confused:

1. **Generation canvas:** the raster produced by SDXL and Pixel Art XL.
2. **Native art grid:** one stored pixel per editable pixel-art cell.
3. **Display size:** an integer-scaled preview of the native art.

The committed ComfyUI workflows cover two generation canvases. Both use the
same prompt, seed, model stack, and 64-color quantization.

This is a boundary and failure-mode benchmark, not a production preset. It
shows how to distinguish model canvas, recovered grid, and display size. It
does not claim that structural recovery makes the art good.

| Style | Generation canvas | Purpose |
|---|---:|---|
| `baseline-64` | 1024×1024 | Square SDXL baseline |
| `native-wide-64` | 1344×768 | Wider composition without a second diffusion pass |

These are diagnostic generation canvases, not recommended native asset sizes.
For this stack, start each independently generated component between 48×48 and
128×128 native pixels. A wide or tall component may exceed one axis only when
its cluster review passes. Build larger scenes from reviewed components instead
of increasing both native dimensions. That range agrees with the
[Aseprite Diffusion author's public guidance](https://www.reddit.com/r/PixelArt/comments/yv2q51/making_high_quality_game_tiles_in_less_than_a/)
and with the 128px native grid recovered in this benchmark.

Run the provider portion against a local ComfyUI server:

```bash
npm run pixelkiln -- doctor --manifest benchmarks/provider-hires/comfyui/pixelkiln.manifest.json
npm run pixelkiln -- plan --manifest benchmarks/provider-hires/comfyui/pixelkiln.manifest.json
npm run pixelkiln -- gen --manifest benchmarks/provider-hires/comfyui/pixelkiln.manifest.json --budget 0
npm run pixelkiln -- audit --manifest benchmarks/provider-hires/comfyui/pixelkiln.manifest.json --max-colors 64 --check
```

## What the source files actually contain

Large dimensions did not make these images native pixel art. The 1024×1024
source used an implied 8×8 raster cell, while the wide source used the same 8px
step. Scaling the 1024 image to 2048 with nearest-neighbor only duplicated the
fake cells. It preserved the problem exactly, so that output was removed from
the benchmark.

We ran both environment sources and the existing transparent building through
Retro Diffusion's MIT-licensed
[Pixel Art Fixer](https://github.com/Retro-Diffusion/pixel-art-fixer) at commit
`ef376e57e1c272633ca2dbf5f29ec3fcf6596465`. The deterministic Python engine
found high-confidence grids and reconstructed one output pixel per cell.

| Source canvas | Detected step | Native output | Visible colors | Consensus |
|---:|---:|---:|---:|---|
| 384×384 transparent building | 3×3 | 128×128 | 252 | `fast:ac+rl(S)` |
| 1024×1024 | 8×8 | 128×128 | 48 | `fast:ac+rl(S)` |
| 1344×768 | 8×8 | 168×96 | 48 | `fast:ac+rl(S)` |

The source and reconstructed hashes, dimensions, tool revision, and decision
path are recorded in [`pixel-art-fixer-results.json`](pixel-art-fixer-results.json).
The native PNGs live under `website/public/benchmarks/provider-hires/comfyui/native-grid/`.
Display them with nearest-neighbor rendering; do not resample them into a new
canonical asset. Grid recovery can introduce new averaged colors, as the
transparent building demonstrates, so apply the project's palette constraint
after reconstruction when a hard color limit matters.

Grid recovery is not quality approval. It proves that every detected cell has
become one stored pixel; it cannot prove that those pixels form deliberate
clusters, clean contours, readable landmarks, or a coherent palette. The
recovered images remain review candidates. Reject one that still looks muddy at
1× or at an integer zoom, even when the detector reports high confidence.

Use this order for a quality-first decision:

1. Generate two to four candidates and reject missing subjects, weak
   composition, and unreadable silhouettes.
2. Remove the background at full resolution when the asset is isolated.
3. Recover the native grid.
4. Start with a deliberate 16–32 color project palette after recovery; expand
   it only when the art direction needs the extra colors.
5. Review clusters, contours, single-pixel noise, and focal-point readability at
   1× and an integer zoom.
6. Accept the smallest native result that communicates the scene clearly.

## Large-scene guidance

A bigger SDXL canvas can improve composition, but it does not create a larger
editable pixel grid. For a large environment:

1. Break the scene into 48–128px native components or overlapping regions.
2. Generate a stable SDXL working canvas for each component.
3. Reconstruct every accepted result onto a known native grid.
4. Compose sky, distant mountains, terrain, buildings, and foreground at 1×.
5. Keep one grid origin and one palette contract across every layer or tile.
6. Integer-scale only the final preview or runtime presentation.

Outpainting, tiled diffusion, and crop-and-stitch can add scene area or repair a
region. They still produce regular raster images, so the native-grid recovery
step remains necessary. The project does not yet automate that post-processing
step; the checked-in report keeps this experiment honest until PixelKiln has a
provider-neutral postprocessor interface.

We also tested 1536px and 2048px latent refinement. Those passes completed on a
64 GB M1 Max, but interpolation, another diffusion pass, and another VAE decode
softened the shapes. Palette quantization could not restore the lost structure,
so those files remain rejected experiments rather than recommended presets.
