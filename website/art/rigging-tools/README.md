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

## rtmlib and SAM 2.1

`docs/SKELETONS.md`, "Open-source tools on your own machine", and
`open-tools.png` on `/skeletons#open-tools`.

- `rtmlib-trial.py`: rtmlib 0.0.16 (onnxruntime 1.32, CPU) whole-body pose on
  every sprite at 1, 2 and 4 times, in `balanced` and `performance` modes.
  Results: `rtmlib-balanced.json`, `rtmlib-performance.json`. Its ONNX models
  download from download.openmmlab.com on first use and are not ours to
  redistribute (Human-Art detector, mixed RTMW training data).
- `sam-trial.py`: SAM 2.1 (`facebook/sam2.1-hiera-{tiny,small,large}`, Apache-2.0)
  through `transformers` 5.23 and torch 2.15 on the M1 Max's GPU, one click per
  prop. Results: `sam-<size>.json`; masks in `out-<size>/`. The same script on
  an RTX 3060 (torch 2.6, CUDA 12.4, Windows): `sam-large-cuda.json`,
  `sam-small-cuda.json`, identical masks and scores.
- `draw-open-tools.py` writes `website/public/showcase/skeleton/open-tools.png`.
