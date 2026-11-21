"""Lay each motion's pose maps side by side, so one render draws the whole loop (lane S).

  python3 make-pose-sheets.py          # writes poses/sheets/<motion>.png

Every pose map is cropped to the same window around the figure (x 256-768, y 128-981 of the
1024px map, which holds every figure in poses/), scaled by 0.75 to a 384x640 cell, and placed
in a row of four. A 4-frame motion is one row (1536x640); the 8-frame walk is two rows
(1536x1280). Every figure is scaled the same, so the ground line and size match across
motions. The split back into frames is cell by cell: frame N is column N % 4, row N // 4.
"""
import os

from PIL import Image

HERE = os.path.dirname(os.path.abspath(__file__))
WINDOW = (256, 128, 768, 981)  # 512 x 853
CELL = (384, 640)
PER_ROW = 4

out = os.path.join(HERE, "sheets")
os.makedirs(out, exist_ok=True)
for motion in ("idle", "walk", "attack"):
    names = sorted(f for f in os.listdir(os.path.join(HERE, motion)) if f.endswith(".png"))
    rows = (len(names) + PER_ROW - 1) // PER_ROW
    sheet = Image.new("RGB", (CELL[0] * PER_ROW, CELL[1] * rows), (0, 0, 0))
    for i, name in enumerate(names):
        pose = Image.open(os.path.join(HERE, motion, name)).convert("RGB").crop(WINDOW)
        sheet.paste(pose.resize(CELL, Image.LANCZOS), ((i % PER_ROW) * CELL[0], (i // PER_ROW) * CELL[1]))
    sheet.save(os.path.join(out, f"{motion}.png"))
    print(motion, sheet.size, len(names), "frames")
