# Parallax layer sets

Step 15 of the [parallax research note](../../docs/RESEARCH_PARALLAX.md): a sky, a far range, a volcano and near ridges, generated one layer at a time.

- `pixellab/` was generated through PixelKiln (`gen --budget pixellab=10`); its lockfile records the four layers and the three silhouettes of step 16.
- `retrodiffusion/` holds the manifest only. PixelKiln refused to send it, because Retro Diffusion quoted $0.06 an image against an offline estimate of $0.044, so the four images were sent straight to the API with the same bodies and a quote check. They have no lockfile. PixelKiln 0.138.1 plans Retro Diffusion stills at the flat live prices, so it no longer refuses this manifest.

The pictures are in `website/public/research/parallax/generated/`.
