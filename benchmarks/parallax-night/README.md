# Alpine at night

Step 20 of the [parallax research note](../../docs/RESEARCH_PARALLAX.md): step 18's
alpine dusk set at a second time of day, made two ways.

- `reference/` holds the manifest and lockfile for one PixelLab pixflux picture:
  the prompt and seed of PixelLab's alpine valley A from the provider benchmark,
  with "at dusk" changed to "at night". Its 42 colours are the night palette.
- `alpine/` holds the manifest and lockfile for the regenerated set: step 18's
  whole layers (far, middle, near) at seeds 101 and 202 and its three landforms at
  seed 202, with night prompts and the night palette forced on every one. The two
  lockfiles record 10 generations, none failed.
- `regenerated.json`, `recoloured.json` and the two `-silhouettes.json` files are
  the preview specs for `parallax.py skyline`.
- `build.sh` cleans up the regenerated picks, recolours step 18's finished dusk
  pieces to the night palette, and renders the previews. It is free. Run it from
  the repository root with numpy, pillow and scipy, after step 18's own build.

The candidates, the processed pieces and the previews are in
`website/public/research/parallax/night/`.
