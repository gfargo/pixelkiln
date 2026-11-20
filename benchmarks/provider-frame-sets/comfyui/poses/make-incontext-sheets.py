"""Build the inputs for lane IC: the character's keyframe beside the poses it must take.

  python3 make-incontext-sheets.py ../keyframes      # writes poses/incontext/

Each render is one row of five 384x640 cells (1920x640). Cell 0 is the keyframe, cropped to
the same window as make-pose-sheets.py, so the figure is the same size as in the pose cells.
Cells 1-4 are four frames of the motion; the 8-frame walk is two renders (frames 0-3, 4-7),
each with the keyframe in cell 0.

For every character, motion and chunk this writes three files:
  <character>-<motion>-<chunk>-image.png  keyframe in cell 0, flat background elsewhere
  <character>-<motion>-<chunk>-mask.png   white where the model draws (cells 1-4), black on cell 0
  <motion>-<chunk>-pose.png               black cell 0, the four pose maps in cells 1-4

The runner encodes the image, masks the noise to cells 1-4 and keeps cell 0 fixed at every
step, so the model draws the new frames while looking at the finished character beside them.
"""
import os
import sys

from PIL import Image

HERE = os.path.dirname(os.path.abspath(__file__))
WINDOW = (256, 128, 768, 981)
CELL = (384, 640)
CHUNK = 4

keyframes = sys.argv[1]
out = os.path.join(HERE, "incontext")
os.makedirs(out, exist_ok=True)
size = (CELL[0] * (CHUNK + 1), CELL[1])
for motion in ("idle", "walk", "attack"):
    names = sorted(f for f in os.listdir(os.path.join(HERE, motion)) if f.endswith(".png"))
    for chunk in range(0, len(names), CHUNK):
        pose = Image.new("RGB", size, (0, 0, 0))
        for i, name in enumerate(names[chunk:chunk + CHUNK]):
            cell = Image.open(os.path.join(HERE, motion, name)).convert("RGB").crop(WINDOW).resize(CELL, Image.LANCZOS)
            pose.paste(cell, ((i + 1) * CELL[0], 0))
        pose.save(os.path.join(out, f"{motion}-{chunk // CHUNK}-pose.png"))
        mask = Image.new("L", size, 255)
        mask.paste(0, (0, 0, CELL[0], CELL[1]))
        for name in sorted(os.listdir(keyframes)):
            character = name[:-4]
            key = Image.open(os.path.join(keyframes, name)).convert("RGB")
            image = Image.new("RGB", size, key.getpixel((4, 4)))
            image.paste(key.crop(WINDOW).resize(CELL, Image.LANCZOS), (0, 0))
            image.save(os.path.join(out, f"{character}-{motion}-{chunk // CHUNK}-image.png"))
            mask.save(os.path.join(out, f"{character}-{motion}-{chunk // CHUNK}-mask.png"))
        print(motion, chunk // CHUNK, size)
