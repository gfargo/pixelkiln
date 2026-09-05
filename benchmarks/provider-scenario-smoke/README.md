# Scenario live smoke

This project records PixelKiln's first paid Scenario run. It tests the adapter,
not Scenario's full catalog and not the relative quality of other providers.
The run completed on September 5, 2026.

## Request

| Setting | Value |
|---|---|
| Model | `model_bfl-flux-2-dev` |
| Prompt | `a compact stone mountain keep, readable pixel-art silhouette` |
| Canvas | 512×512 |
| Seed | 31415 |
| Guidance | 4 |
| Inference steps | 28 |

The `single` style requested one output with a 16 CU ceiling. The `review`
style requested two outputs with a 32 CU ceiling. Scenario quoted and billed 16
and 32 CU respectively. There was no IP-detection charge or discount.

The two-output job entered PixelKiln's local review sheet. A person chose
candidate 2. Selection reused that Scenario asset; it did not submit another
generation.

## What passed

- Offline doctor and planning made no provider calls and reported a 48 CU total.
- Authenticated doctor reached Scenario through a read-only model request.
- Each paid call received an identical free `dryRun=true` preflight first.
- Both jobs completed, and all three candidates were available for review or
  direct selection.
- The chosen files are valid 512×512, 8-bit RGB, non-interlaced PNGs.
- Quote and final billing matched for both jobs.
- The lockfile contains durable `scenario://` asset references and no signed
  storage query strings.
- With the selected output and local content cache moved aside, `restore`
  resolved a fresh provider URL and reproduced the exact recorded SHA-256.

Scenario returned `outputIndex: 0` for both assets in the two-output job.
PixelKiln preserves the job's asset order when output indices tie and records
its own `candidateIndex`; the lockfile shows that candidate 2 was selected.

The selected multi-output image and the single-output image have identical RGBA
pixels because the same prompt and seed were used, although their encoded PNG
bytes differ. They are kept here because they prove two separate lifecycle
paths, not because they are two visual variants.

## Art-quality boundary

The raw image is opaque and contains 19,619 RGB colors. Its silhouette and
block shapes read as pixel art, but it is not a tightly controlled native-grid,
limited-palette game asset. Treat it as a concept or refinement source. A
production asset still needs palette reduction, pixel-grid inspection, and
human art direction.

This smoke uses a different brief from the main environment benchmark. Do not
read it as a PixelLab, Retro Diffusion, or ComfyUI quality comparison.

## Files

- [`pixelkiln.manifest.json`](./pixelkiln.manifest.json) is the exact request.
- [`pixelkiln.lock.json`](./pixelkiln.lock.json) records jobs, assets, quotes,
  final billing, selection, and output hashes.
- [`outputs/single/mountain-keep.png`](./outputs/single/mountain-keep.png) is the
  one-output path.
- [`outputs/review/mountain-keep.png`](./outputs/review/mountain-keep.png) is the
  human-selected candidate from the two-output path.
