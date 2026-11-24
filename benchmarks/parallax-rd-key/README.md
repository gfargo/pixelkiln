# Retro Diffusion layers keyed by script

Step 21 of the [parallax research note](../../docs/RESEARCH_PARALLAX.md): step
15's volcanic layers again, with `tileX` on and `removeBg` off, and the background
keyed out by script so the seam survives.

- `pixelkiln.manifest.json` and its lockfile: a far range and near ridges from
  `rd_plus__environment`, and a far range, a row of volcanoes and near ridges from
  `rd_plus__default`, all at seed 4242 and 384×96, each prompt asking for a plain
  flat chroma-key green background. The lockfile records 5 images at $0.06, $0.30.
- `set.json` is the preview spec for `parallax.py skyline`. Only its first frame
  is kept, as a still.
- `build.sh` keys each picture, measures the seams before and after, and draws the
  sheets and the still. It is free. Run it from the repository root with numpy,
  pillow and scipy.

The pictures are in `website/public/research/parallax/rd-key/`.
