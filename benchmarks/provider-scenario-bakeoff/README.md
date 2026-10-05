# Scenario model bake-off

A cheap, single-sample survey of ten Scenario text-to-image models that a
`cu-basic` account can use, run through PixelKiln's own Scenario adapter on
October 5, 2026. It finds out which models the adapter can drive and what they
cost. It is not a quality ranking: one prompt, one seed, one image per model.

## Request

Every style sends the same brief as the [live smoke](../provider-scenario-smoke/README.md):
`a compact stone mountain keep, readable pixel-art silhouette`, seed 31415, a
512×512 canvas, one output, and each model's own defaults. No model-specific
parameters were set. Each paid request was preceded by the adapter's free
`dryRun=true` quote, and the run was capped at `--budget scenario=33`.

## Results

| Model | CU | Size returned | What came back |
|---|---:|---|---|
| `model_bfl-flux-2-klein-9b` | 1 | 512×512 | A black stone keep on a mountain, two grey tones. Reads as pixel art and as a keep, but is a flat silhouette. |
| `model_bfl-flux-1-schnell` | 1 | 512×512 | A two-tone blue mountain with no keep. Pixel-edged, ignored the subject. |
| `model_p-image` | 1 | **JPEG** | Rejected: the adapter requires PNG. The job was billed. |
| `model_recraft-v4-1-flash` | 2 | **1024×1024** | A small four-colour isometric stone ruin on an opaque black field. |
| `model_krea-2-turbo` | 2 | **1024×1024** | The most convincing pixel look (about 16-pixel blocks, small palette) but a mossy cave mountain, not a keep, on cream. |
| `model_meta-muse-image` | 2 | **1600×1600** | A dusk skyline with a castle silhouette. Blocky and moody; a scene, not an asset. |
| `model_ernie-image-turbo` | 3 | 512×512 | A detailed castle on a cliff with a gradient sky and forest. Reads as a keep; a scene with anti-aliased gradients. |
| `model_z-image-turbo` | 4 | 512×512 | A black mountain silhouette. The weakest result. |
| `model_alibaba-qwen-image-3-0` | 6 | **1024×1024** | A dramatic castle against a dithered sunset. Pixel-flavoured, a scene. |
| `model_openai-gpt-image-2` | 11 | 512×512 | The best keep by far: banners, stairs, roofs, a flag, on white. Fine detail with anti-aliasing (28k colours), so not a native grid. |
| `model_bfl-flux-2-dev` | 16 | 512×512 | From the smoke run: a raw 19.6k-colour opaque concept. |

Spend: 33 CU, all billed.

## What the run showed

- **Price does not predict fit.** The 1 and 2 CU models gave a usable
  silhouette and the most authentic pixel texture. GPT Image 2 at 11 CU followed
  the brief best. The default FLUX.2 Dev at 16 CU was not the best value.
- **Models ignore the requested canvas.** Krea 2 Turbo and Recraft returned
  1024×1024, Qwen 1024×1024, Meta Muse 1600×1600, for a 512×512 request. The
  lockfile still records the requested 512×512. Check real dimensions.
- **No model gave a native-grid, closed-palette asset.** They are concept or
  refinement input; `style.quality` and `pixelkiln refine` still do the work of
  recovering a grid and palette.
- **Subjects came back as scenes.** Prompts for an isolated asset should say so
  ("isolated on a plain background"), and `removeBg` style tools were not
  exercised here.

## Adapter findings

Both were found during this run and fixed alongside it:

1. **Concurrency limit, not request rate.** Four of ten submissions got a 429
   while earlier jobs were still running, and the default retry gave up after
   about half a minute. Generation requests now retry for about 80 seconds; a 429
   means nothing was accepted or billed.
2. **A JPEG result hung polling.** `p-image` finished, was billed, and
   returned a JPEG. The adapter threw on every poll and the run never ended. The
   asset now fails with the message.

The adapter's offline 128 to 2048 px, multiple-of-16 rule was also wrong for
several models (Retro Diffusion Plus is 16 to 384; some Kling models start at
672). It now rules out only nonsense and leaves the model's own bounds to the
free dry run.

## Files

- `pixelkiln.manifest.json`: one style per model.
- `pixelkiln.lock.json`: quotes, job references, and the one failure.
- `outputs/<model>/mountain-keep.png`: the nine downloaded images.
