# Paperdoll example

The manifest behind the character builder on the PixelKiln home page: one
bare base, a walk in four directions, ten layers drawn over those 32 frames,
and three items pinned to a hand. See the
[Paperdoll layers guide](../../docs/PAPERDOLL.md) for how each part works.

```bash
export PIXELLAB_API_KEY=...

# Free. Prices every drawn layer at 25, the top tier; most bill less.
pixelkiln plan --manifest pixelkiln.manifest.json

# The base, then the walks, then the layers, in waves.
pixelkiln gen --manifest pixelkiln.manifest.json --budget 260
```

What that cost when it was run in November 2026: 2 for the base, 4 for the
walks, and 165 billed for the ten layers (10 each for the five clothing
layers, 15 for the cloak, 25 each for the hat, the helmet, the hair and the
backpack).

## The held items

`hero.sword`, `hero.shield` and `hero.lantern` draw nothing. Each needs a
sprite per direction in `items/` and the anchors file, and stays `blocked`
until both exist.

1. Put the sprites in place: `items/sword-south.png`,
   `items/sword-south-east.png` and so on for all eight directions, and the
   same for `shield` and `lantern`. The ones on the site came from PixelLab's
   8-direction object tool at 32px (24px for the lantern), 10 generations
   each. The sword was described as held, "the blade leans forward at 45
   degrees, tip pointing forward and up", so that it leans the way the
   character faces.
2. Find the hands, once for all three items, at 0.1 generation a frame:

   ```bash
   pixelkiln anchors hero.sword --manifest pixelkiln.manifest.json
   ```

3. Place them, for nothing:

   ```bash
   pixelkiln gen --manifest pixelkiln.manifest.json --budget 0
   ```

## Things this manifest does on purpose

- **`hero.briefs` is a layer.** The base stays bare, which is what keying its
  skin needs, and a game draws the underwear under everything.
- **`hero.hair`, `hero.helmet` and `hero.pack` put the walks first and set
  `columns` to 6**, so each walk is one row of the sheet, and their prompts
  say which way each row faces. Drawn on a sheet whose rows mixed directions,
  all three came back back-to-front on some front-facing frames.
- **The lantern's `grip` is at its top** and the shield's is `"center"`; the
  sword uses the default, the middle of its lowest fifth.

A model draws a different character every time, so your run will not match
the site pixel for pixel.
