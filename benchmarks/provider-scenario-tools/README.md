# Scenario tool-model smoke

Two single-image tool models run through PixelKiln's Scenario adapter as
`image-to-image` revisions, on October 5, 2026. The parent is the GPT Image 2
keep from the [bake-off](../provider-scenario-bakeoff/README.md) (512×512 RGB,
28,336 colours, white background), placed as a `source`. One sample per tool.

| Tool | Model | Quoted | Billed | Result |
|---|---|---:|---:|---|
| Background removal | `model_birefnet-background-removal` | 2 CU | 2 CU | 512×512 RGBA. 52.5% of pixels fully transparent, 46.7% semi-transparent, only 0.8% exactly 255. The keep is clean and the white field is gone, but its alpha is 254, not 255. |
| Pixel snapper | `model_pixel-snapper`, `colors: 16` | 5 CU | 5 CU | **83×83 RGB, exactly 16 colours.** A true native-grid, closed-palette version of the keep, muddier in colour than the source. |

Total: 7 CU, quoted and billed identically. Neither tool takes a prompt, canvas
or seed; the adapter's `prompt`, `width`, `height`, `numOutputs` and `seed` were
accepted and ignored.

## What this shows

- Pixel Snapper did what none of the ten generation models in the bake-off
  did: it recovered a native pixel grid (83 px from a 512 px image) with a
  strict palette. It returned a different size than the manifest's 512×512, and
  the lockfile still records 512×512, so read the real dimensions.
- The cutout's near-opaque alpha (254) is worth knowing before a pipeline that
  tests for fully opaque pixels or counts transparency. `pixelkiln refine` can
  threshold it.
- Both ran through the existing `image-to-image` path with `referenceParameter:
  "image"` and `referenceArray: false`; no new revision mode was needed.

## Boundaries

One image, one setting each (16 colours, default removal). Pixel Snapper's
colour loss was not tuned (`colors` goes to 256), and Pixelate and the upscalers
were not run.

## Files

`pixelkiln.manifest.json`, `pixelkiln.lock.json`, `art/keep.png` (parent),
`outputs/cutout/keep-cutout.png`, `outputs/snap/keep-snapped.png`.
