# Skeleton showcase: the bare base

The pictures on `/skeletons` and in `docs/SKELETONS.md`. Made on November 19,
2026 from the paperdoll's bare base (`base-south.png`: the south rotation and
briefs from the site's character builder, cropped to 64×64 because
`/estimate-skeleton` takes square 16, 32, 64, 128 or 256px images).

1. `pixelkiln estimate-skeleton base-south.png --out poses/estimate.json --frames 8`
   (0.1 generation). The estimate put both arms at the figure's sides, as drawn.
2. `python3 make-wave.py poses/estimate.json poses/wave.json` raises the right
   arm and swings the hand across eight frames.
3. `pixelkiln skeleton-preview poses/wave.json --from base-south.png` drew the
   pose sheet, locally.
4. `pixelkiln gen --budget 4` ran the `base-wave` revision through
   `/animate-with-skeleton-v3`: 8 frames at 64×64, billed 3 generations
   (`out/`, `pixelkiln.lock.json`).

This replaced an earlier showcase character, an adventurer with a sword and a
pack on its back, after its pose sheet was read as showing both arms raised.
That reading was wrong: the estimate had the arms down. The lines from the nose
to the ears, drawn then in the arms' colours, ran up toward the hilt and the
orb behind its head and looked like arms. `skeleton-preview` now draws the eyes
and ears in grey. The bare base is still the clearer example. The adventurer's
loops illustrate the October 2026 provider update in `../pixellab-skeleton`.
