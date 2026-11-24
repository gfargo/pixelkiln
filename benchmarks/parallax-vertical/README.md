# Vertical parallax sets

Step 19 of the [parallax research note](../../docs/RESEARCH_PARALLAX.md) and
section 8 of the [parallax guide](../../docs/PARALLAX.md): a camera that climbs.

- `climb/` holds the PixelLab manifest and lockfile: a massif, puffy clouds,
  cloud streaks, cloud banks and a cliff on the alpine palette, at seeds 101,
  202 and 303. The lockfile records 14 generations, one failed.
- `retrodiffusion/` holds the Retro Diffusion manifest and lockfile: a sky and a
  cliff from `rd_plus__default` with `tileY`, $0.12.
- `climb.json` and `loop.json` are the preview specs for `parallax.py climb`.
  The climb also uses step 18's alpine far range and treeline.
- `build.sh` post-processes the picked candidates and renders the previews.
  It is free. Run it from the repository root with numpy, pillow and scipy.

The candidates, the processed pieces and the previews are in
`website/public/research/parallax/vertical/`.
