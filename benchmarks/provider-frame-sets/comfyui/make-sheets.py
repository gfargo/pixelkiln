"""Contact sheets and side-by-side GIFs from a run-benchmark.py output folder.

  python3 make-sheets.py runs/<name> results/<name>

Writes, per character:
  sheet-<character>.png        one row per lane, the 16 frames (idle 4, walk 8, attack 4) left to right
  <character>-<motion>.gif     the four lanes side by side, playing the motion
Frames are reduced to a fixed size with a box filter; the sheets are for comparing lanes,
not for judging pixels (judge the native refined frames at 1x for that).
"""
import os
import sys

from PIL import Image, ImageDraw

LANES = ["A", "B-0.55", "B-0.75", "B-0.90"]
MOTIONS = {"idle": 4, "walk": 8, "attack": 4}
CELL = 160
GIF_CELL = 256
LABEL = 90
FPS = {"idle": 4, "walk": 8, "attack": 6}
BG = (32, 32, 36)
INK = (230, 230, 230)

src, out = sys.argv[1], sys.argv[2]
os.makedirs(out, exist_ok=True)


def frame(lane, character, motion, i, size):
    img = Image.open(os.path.join(src, lane, character, motion, f"frame-{i:02d}.png")).convert("RGB")
    return img.resize((size, size), Image.BOX)


characters = sorted(os.listdir(os.path.join(src, "B-0.75")))
for character in characters:
    total = sum(MOTIONS.values())
    sheet = Image.new("RGB", (LABEL + total * CELL, 24 + len(LANES) * CELL), BG)
    draw = ImageDraw.Draw(sheet)
    x = LABEL
    for motion, count in MOTIONS.items():
        draw.text((x + 4, 6), motion, fill=INK)
        x += count * CELL
    for row, lane in enumerate(LANES):
        y = 24 + row * CELL
        draw.text((6, y + CELL // 2 - 6), lane, fill=INK)
        x = LABEL
        for motion, count in MOTIONS.items():
            for i in range(count):
                sheet.paste(frame(lane, character, motion, i, CELL), (x, y))
                x += CELL
    sheet.save(os.path.join(out, f"sheet-{character}.png"), optimize=True)

    for motion, count in MOTIONS.items():
        frames = []
        for i in range(count):
            canvas = Image.new("RGB", (len(LANES) * GIF_CELL, GIF_CELL + 20), BG)
            d = ImageDraw.Draw(canvas)
            for col, lane in enumerate(LANES):
                canvas.paste(frame(lane, character, motion, i, GIF_CELL), (col * GIF_CELL, 20))
                d.text((col * GIF_CELL + 6, 4), lane, fill=INK)
            frames.append(canvas.quantize(colors=255, method=Image.Quantize.MEDIANCUT))
        frames[0].save(os.path.join(out, f"{character}-{motion}.gif"), save_all=True,
                       append_images=frames[1:], duration=1000 // FPS[motion], loop=0, optimize=True)
    print(character, "done")
