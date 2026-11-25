"""Put different consistency approaches side by side, as a still sheet and as looping GIFs.

  python3 compare-lanes.py <out-dir> <label>=<lane-dir> [<label>=<lane-dir> ...]

A lane dir holds <character>/<motion>/frame-NN.png (one render per frame) or
<character>/<motion>/sheet.png (lane S/SH: a row of four cells; the walk is two rows),
which is cut into cells, or <character>/<motion>/chunk-N.png (lane IC: five cells, the keyframe
first, so cells 1-4 are frames). Every frame is scaled to the same height with a box filter, so this
compares consistency and motion, not pixels.

Writes <out-dir>/compare-<character>.png (rows: lanes; columns: the 16 frames) and
<out-dir>/compare-<character>-<motion>.gif (the lanes side by side, playing).
"""
import os
import sys

from PIL import Image, ImageDraw

MOTIONS = {"idle": 4, "walk": 8, "attack": 4}
FPS = {"idle": 4, "walk": 8, "attack": 6}
H = 240
LABEL = 120
BG = (32, 32, 36)
INK = (230, 230, 230)

out = sys.argv[1]
lanes = [arg.split("=", 1) for arg in sys.argv[2:]]
if os.environ.get("MOTIONS"):  # e.g. MOTIONS=walk, for lanes that rendered one motion
    MOTIONS = {m: MOTIONS[m] for m in os.environ["MOTIONS"].split(",")}
os.makedirs(out, exist_ok=True)


def frames(lane_dir, character, motion):
    folder = os.path.join(lane_dir, character, motion)
    sheet = os.path.join(folder, "sheet.png")
    if os.path.exists(os.path.join(folder, "chunk-0.png")):
        # lane IC: rows of five cells, the keyframe in cell 0, frames in cells 1-4
        cells = []
        for chunk in range((MOTIONS[motion] + 3) // 4):
            img = Image.open(os.path.join(folder, f"chunk-{chunk}.png")).convert("RGB")
            cw = img.width // 5
            cells += [img.crop((i * cw, 0, (i + 1) * cw, img.height)) for i in range(1, 5)]
    elif os.path.exists(sheet):
        img = Image.open(sheet).convert("RGB")
        rows = (MOTIONS[motion] + 3) // 4
        cw, ch = img.width // 4, img.height // rows
        cells = [img.crop(((i % 4) * cw, (i // 4) * ch, (i % 4 + 1) * cw, (i // 4 + 1) * ch)) for i in range(MOTIONS[motion])]
    else:
        cells = [Image.open(os.path.join(folder, f"frame-{i:02d}.png")).convert("RGB") for i in range(MOTIONS[motion])]
        # square renders: keep the middle, where the figure stands, at the sheet cells' 3:5 shape
        cells = [c.crop((c.width * 0.2, 0, c.width * 0.8, c.height)) for c in cells]
    return [c.resize((round(c.width * H / c.height), H), Image.BOX) for c in cells]


characters = sorted(os.listdir(lanes[0][1]))
for character in characters:
    table = {label: {m: frames(d, character, m) for m in MOTIONS} for label, d in lanes}
    cw = max(f.width for row in table.values() for fs in row.values() for f in fs)
    sheet = Image.new("RGB", (LABEL + sum(MOTIONS.values()) * cw, len(lanes) * H), BG)
    draw = ImageDraw.Draw(sheet)
    for r, (label, _) in enumerate(lanes):
        draw.text((6, r * H + H // 2), label, fill=INK)
        x = LABEL
        for m in MOTIONS:
            for f in table[label][m]:
                sheet.paste(f, (x + (cw - f.width) // 2, r * H))
                x += cw
    sheet.save(os.path.join(out, f"compare-{character}.png"), optimize=True)
    for m, count in MOTIONS.items():
        anim = []
        for i in range(count):
            canvas = Image.new("RGB", (len(lanes) * cw, H + 18), BG)
            d = ImageDraw.Draw(canvas)
            for c, (label, _) in enumerate(lanes):
                f = table[label][m][i]
                canvas.paste(f, (c * cw + (cw - f.width) // 2, 18))
                d.text((c * cw + 4, 3), label, fill=INK)
            anim.append(canvas.quantize(colors=255, method=Image.Quantize.MEDIANCUT))
        anim[0].save(os.path.join(out, f"compare-{character}-{m}.gif"), save_all=True, append_images=anim[1:],
                     duration=1000 // FPS[m], loop=0, optimize=True)
    print(character, "done")
