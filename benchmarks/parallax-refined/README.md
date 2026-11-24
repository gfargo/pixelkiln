# Refined parallax sets

Step 18 of the [parallax research note](../../docs/RESEARCH_PARALLAX.md) and the
worked example in the [parallax guide](../../docs/PARALLAX.md): two biomes,
volcanic dusk and alpine dusk, each with silhouettes and whole layers.

- `volcanic/` and `alpine/` hold a manifest and its lockfile. Each asset lists
  two or three pixflux styles that differ only in seed (101, 202, 303), so every
  asset has two or three candidates. The `silhouette-*` assets are the first
  round, with the scene-style prompt; `landform-*` is the retry with the sprite
  prompt. The lockfiles record 51 generations: 27 volcanic, 24 alpine.
- `build.sh` post-processes the picked candidates and renders the previews.
  It is free. Run it from the repository root with numpy, pillow and scipy.
- `silhouettes.json` and `layers.json` in each biome are the preview specs for
  `parallax.py skyline`.

The candidates, the processed pieces and the previews are in
`website/public/research/parallax/refined/`.
