# Scenario cross-style chain

The generate, pixelate, cut out chain from the [pipeline run](../provider-scenario-pipeline/README.md),
declared in one manifest with `revision.fromStyle` and taken to the end by a single
`pixelkiln gen --budget scenario=8`, on October 5, 2026. 8 CU, every quote matched its bill.

| Wave | Style | Model | CU | Parent |
|---|---|---|---:|---|
| 1 | `gen` | `model_bfl-flux-2-klein-9b` | 1 | none |
| 2 | `pixelate` | `model_sc-pixelate` (grid 64, DB32 palette) | 5 | `gen/knight` |
| 3 | `cutout` | `model_birefnet-background-removal`, with a `quality` profile | 2 | `pixelate/knight-px` |

`plan` listed the two later steps as `blocked` until their parent existed and priced
only the first (1 CU). `gen` then ran three waves in one invocation, each link
released by the previous download, with no `--style` flags and no placed `source` files.
`pixelkiln refine --style cutout` followed: a 64×64 RGBA sprite, 76% transparent, 19
colours, `needs-approval`. The `quality` profile sits on the last style, so only its
output is gated and the raw parents in other styles never block it.

The lockfile records `sourceStyleId` on the two revisions. The sprite is not approved:
that needs a person's 1× review.

Files: `pixelkiln.manifest.json`, `pixelkiln.lock.json`, `out/gen/`, `out/pixelate/`,
`out/cutout/`, `out/final/` (the refined sprite and its quality record).
