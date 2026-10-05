# Scenario edit smoke

One paid `image-to-image` revision through PixelKiln's Scenario adapter, run on
October 5, 2026. It checks that the adapter can upload a parent image, send it
as a reference, and bring the edit back through the normal lifecycle. It is one
sample on one model, not a comparison.

## Request

| Setting | Value |
|---|---|
| Model | `model_bfl-flux-2-klein-9b` |
| Parent | `art/keep.png`, the GPT Image 2 keep from the [bake-off](../provider-scenario-bakeoff/README.md), placed as a `source` |
| Prompt | `the same keep in winter: snow on the roofs and battlements, pixel art` |
| Canvas | 512×512, seed 31415, one output |
| Ceiling | 1 CU |

## What passed

- `plan` resolved the revision offline with no request, at the 1 CU ceiling.
- The adapter uploaded the parent (free), then sent the identical body,
  `referenceImages: [<asset id>]`, through the free dry run and the paid
  request. The quote and the bill were both 1 CU.
- The result is a valid 512×512 PNG that keeps the keep's layout, banners and
  stairs and adds snow, a snowy sky and pine trees.
- The edit's lock entry records the parent hash and the uploaded asset id.

## Boundaries

The output is RGB with anti-aliasing, like the other Scenario models: a concept
or refinement source, not a native-grid asset. The edit also repainted the sky
and added trees the prompt did not ask for. Klein 9B is the cheapest editing
model that accepted a reference here; other models will differ.

## Files

- `pixelkiln.manifest.json`, `pixelkiln.lock.json`
- `art/keep.png` (parent), `outputs/keep-snow.png` (result)
