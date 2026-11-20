# Rigging tools: props, capes and MediaPipe

The figure on `/skeletons#props` and in `docs/SKELETONS.md` ("Props, capes and
hats"). Made November 19, 2026.

- `sprites/`: `adventurer64` (the old skeleton showcase character),
  `bare256`, `bare64`, `cape256` and `cuirass256` (south rotations of PixelLab
  characters on the account, downloaded, no generation), `knight128` (the
  paperdoll knight's south frame, 92px, on a 128px canvas), `mage128` (the
  paperdoll builder's base, briefs, robe, wizard hat and staff layers, stacked).
- `pixellab/<name>.json`: `pixelkiln estimate-skeleton` (0.1 generation each;
  `adventurer64` is the starting pose of `../pixellab-skeleton/poses/wave.json`).
- `pixellab/custom-rigs.json`: the extra joints `estimate_custom_skeleton` (MCP,
  beta, 1 generation each) added for the cape, the knight and the mage, with the
  descriptions and actions sent.
- `mediapipe-run.py`: MediaPipe 1.2.3's Pose Landmarker (heavy), Holistic
  Landmarker and multiclass segmenter on every sprite. Needs
  `pip install mediapipe pillow numpy` and the model files named in it, from
  `https://storage.googleapis.com/mediapipe-models/` (not committed). Writes
  `mediapipe.json` and `out/<name>-classes.png`. The Interactive Segmenter step
  is skipped: 1.2.3 asks for an `interactive_segmentation.task` bundle that is
  not at the usual address.
- `draw-figure.py` writes `website/public/showcase/skeleton/rigging-tools.png`.
