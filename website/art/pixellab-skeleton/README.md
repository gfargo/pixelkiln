# PixelLab skeleton v3 showcase

The two waving loops on the home page's provider updates section, both made on
October 30, 2026 from one v3 PixelLab character (64×64, `hero-south.png` is its
south rotation). Each billed exactly 3 generations.

- **Custom poses** (`wave-custom-pose.gif`): `pixelkiln estimate-skeleton
  hero-south.png --out poses/wave.json --frames 8`, then `make-wave.py` edits the
  eight frames into a wave, and the `hero-wave` revision in this manifest sends
  them to `/animate-with-skeleton-v3`. 8 frames at 64×64.
- **A sentence** (`wave-sentence.gif`): `POST /characters/animations` with
  `mode: "skeleton-v3"` and no template, from "cheerfully waving both arms
  overhead", 8 frames, one direction. The frames came back at 96×96. This call
  was made directly over REST, because PixelKiln did not send this mode yet.

The revision's lockfile was not kept: its frames were read straight from the
finished jobs for the page. See `docs/ENDPOINTS.md`, "Skeleton-driven motion,
measured".
