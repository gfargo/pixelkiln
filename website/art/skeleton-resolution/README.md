# Sprite size and hands

The figure on `/skeletons#resolution` and in `docs/SKELETONS.md`
("How much skeleton a sprite can carry"). Made November 19, 2026.

- `body64.png`: the south rotation of a 64px PixelLab character (a bare A-pose
  base). `body256.png`: the south rotation of a 256px one (a "research body"
  in a T-pose). Both downloaded from the account, no generation.
- `body128.png`: `body256.png` reduced 2x by nearest neighbour. There is no
  native 128px drawing; say so wherever the figure appears.
- `estimate-{64,128,256}.json`: `pixelkiln estimate-skeleton` on each, 0.1
  generation each.
- The hand points beyond the wrist (`HAND_256` in `make-figure.py`) were read off
  the 256px drawing by eye. Nothing estimated them.

`python3 make-figure.py` writes `website/public/showcase/skeleton/resolution.png`.

## The hand-point trial

`docs/SKELETONS.md`, "Finding hand points: PixelLab or MediaPipe", and
`hand-trial.png` on `/skeletons`.

- `pixellab-custom-results.json`: PixelLab's `estimate_custom_skeleton` (MCP,
  beta) on each figure, no rig given, 1 generation each. Only the hand on the
  left of the picture is kept, with the job ids.
- `mediapipe-trial.py` runs MediaPipe 1.2.3's Hand Landmarker and heavy Pose
  Landmarker on every figure, at 1, 2, 4, 8 and 16 times, on white and grey,
  whole and as a hand crop. It needs `pip install mediapipe pillow numpy` and the
  two `.task` model files from `https://storage.googleapis.com/mediapipe-models/`
  in `MODELS` (not committed). Output: `mediapipe-results.json`.
- `score-hands.py` prints the error table; `draw-trial.py` draws `hand-trial.png`.
- The truth is the hand-placed points in `score-hands.py`, good to about a pixel.
