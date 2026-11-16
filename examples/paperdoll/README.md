# Paperdoll example

The manifest behind the character builder on the PixelKiln home page: one
bare base, a walk in four directions, fifteen layers drawn over those 32
frames, and five items pinned to a hand. See the
[Paperdoll layers guide](../../docs/PAPERDOLL.md) for how each part works.

```bash
export PIXELLAB_API_KEY=...

# Free. Prices every drawn layer at 25, the top tier; most bill less.
pixelkiln plan --manifest pixelkiln.manifest.json

# The base, then the walks, then the drawn layers, in waves.
pixelkiln gen --manifest pixelkiln.manifest.json --budget 385
```

What that cost when it was run in November 2026: 2 for the base, 4 for the
walks, and 285 billed for the fifteen drawn layers (15 each for the seven
clothing layers, the silver hair and the cowl; 25 each for the mohawk, the
helm, the wizard hat, the wings, the war cape and the quiver).

## The held items

`hero.greatsword`, `hero.staff`, `hero.dagger`, `hero.kiteshield` and
`hero.torch` each need a sprite per direction in `items/` and the anchors
file, and stay `blocked` until both exist.

1. Put the sprites in place: `items/greatsword-south.png`,
   `items/greatsword-south-east.png` and so on for all eight directions, and
   the same for the other four. The ones on the site came from PixelLab's
   8-direction object tool, 10 generations each, at 48px for the greatsword,
   64 for the staff, 32 for the shield and the torch, and 24 for the dagger.
   The blades were described as held, "the blade leans forward at 45 degrees,
   tip pointing forward and up", so that they lean the way the character
   faces. The staff's `grip` in the manifest is where its shaft was in those
   sprites; yours will differ.
2. Find the hands, once for all five items, at 0.1 generation a frame:

   ```bash
   pixelkiln anchors hero.greatsword --manifest pixelkiln.manifest.json
   ```

3. Run `gen` again. The shield is placed for nothing. The other four set
   `grasp`, so each is one more inpaint that redraws the hand around the
   handle: 25 billed each here.

## Things this manifest does on purpose

- **`hero.briefs` is a layer.** The base stays bare, which is what keying its
  skin needs, and a game draws the underwear under everything.
- **Every drawn layer lists the walks first and sets `columns` to 6**, so
  each walk is one row of the sheet, and every prompt says which way each row
  faces. On a sheet whose rows mixed directions, hair, a helmet and a
  backpack came back back-to-front on some front-facing frames.
- **Padding is 10 at most on those sheets.** Six rows of a 64px figure with
  12 pixels of padding is 516 pixels tall, and the limit is 512.
- **`hero.wizardhat` and `hero.helm` set `offset`**, per source asset: the
  hat came back low over the eyes on the eight rotations and the helm low on
  the walk toward the viewer. Those numbers fit one run; a new run needs its
  own, and changing them is free (`pixelkiln fetch`).
- **Nothing is cyan or teal.** That is the colour skin is keyed to, and a
  layer drops it.
- **No gloves.** `grasp` draws fingers in the base's skin colour.

A model draws a different character every time, so your run will not match
the site pixel for pixel.
