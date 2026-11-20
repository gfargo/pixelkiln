"""Draw the rigging-tools comparison: one row per sprite, one column per tool.

Columns: PixelLab's 18 joints (estimate-skeleton), MediaPipe's 33-point body (Pose
Landmarker, heavy), the extra joints PixelLab's custom skeleton added (props, capes,
hats), and MediaPipe's multiclass segmenter (skin, clothes, accessories).

  python3 draw-figure.py   # writes ../../public/showcase/skeleton/rigging-tools.png
"""
import json
import os
from PIL import Image, ImageDraw, ImageFont

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "..", "..", "public", "showcase", "skeleton", "rigging-tools.png")
ROWS = ["adventurer64", "cape256", "knight128", "mage128"]
COLUMNS = ["PixelLab: 18 joints", "MediaPipe: 33-point body", "PixelLab: custom rig, extra joints", "MediaPipe: skin, clothes, accessories"]
CELL, PAD, LABEL = 236, 18, 150
RIGHT, LEFT, MID, GREEN, GOLD = (255, 140, 40), (70, 150, 255), (235, 235, 235), (90, 220, 140), (255, 215, 70)

PL_BONES = [("NECK", "NOSE"), ("NECK", "RIGHT SHOULDER"), ("RIGHT SHOULDER", "RIGHT ELBOW"), ("RIGHT ELBOW", "RIGHT ARM"),
            ("NECK", "LEFT SHOULDER"), ("LEFT SHOULDER", "LEFT ELBOW"), ("LEFT ELBOW", "LEFT ARM"),
            ("NECK", "RIGHT HIP"), ("RIGHT HIP", "RIGHT KNEE"), ("RIGHT KNEE", "RIGHT LEG"),
            ("NECK", "LEFT HIP"), ("LEFT HIP", "LEFT KNEE"), ("LEFT KNEE", "LEFT LEG")]
MP_BONES = [(11, 12), (11, 13), (13, 15), (12, 14), (14, 16), (11, 23), (12, 24), (23, 24), (23, 25), (25, 27), (24, 26), (26, 28),
            (15, 17), (15, 19), (15, 21), (16, 18), (16, 20), (16, 22), (0, 11), (0, 12)]
# Body joints the custom rigs name, mapped to the 18-joint labels so chains can be drawn from them.
ANCHOR = {"right_wrist": "RIGHT ARM", "left_wrist": "LEFT ARM", "right_shoulder": "RIGHT SHOULDER", "left_shoulder": "LEFT SHOULDER",
          "head": "NOSE", "hips": None}

mp = json.load(open(os.path.join(HERE, "mediapipe.json")))["sprites"]
custom = json.load(open(os.path.join(HERE, "pixellab", "custom-rigs.json")))
font, small = ImageFont.load_default(size=19), ImageFont.load_default(size=15)


def cell(name):
    sprite = Image.open(os.path.join(HERE, "sprites", f"{name}.png")).convert("RGBA")
    box = sprite.getbbox()
    side = max(box[2] - box[0], box[3] - box[1]) + 6
    cx, cy = (box[0] + box[2]) / 2, (box[1] + box[3]) / 2
    left, top = cx - side / 2, cy - side / 2
    scale = (CELL - 16) / side
    crop = sprite.crop((round(left), round(top), round(left + side), round(top + side)))
    big = crop.resize((CELL - 16, CELL - 16), Image.NEAREST)
    base = Image.new("RGBA", (CELL, CELL), (27, 25, 19, 255))
    base.alpha_composite(big, (8, 8))
    at = lambda x, y: ((x - round(left)) * scale + 8, (y - round(top)) * scale + 8)
    return sprite, base, at


def pixellab18(name):
    d = json.load(open(os.path.join(HERE, "pixellab", f"{name}.json")))
    s = Image.open(os.path.join(HERE, "sprites", f"{name}.png")).width
    return {k["label"]: (k["x"] * s, k["y"] * s) for k in d["firstFrameKeypoints"]}


def colour(a, b):
    return RIGHT if "RIGHT" in a + b else LEFT if "LEFT" in a + b else MID


sheet = Image.new("RGBA", (LABEL + 4 * (CELL + PAD), 60 + len(ROWS) * (CELL + PAD) + 30), (20, 18, 14, 255))
d = ImageDraw.Draw(sheet)
for c, title in enumerate(COLUMNS):
    d.text((LABEL + c * (CELL + PAD), 22), title, font=small, fill=(240, 232, 214))
for r, name in enumerate(ROWS):
    y0 = 60 + r * (CELL + PAD)
    d.text((16, y0 + CELL // 2 - 10), name.rstrip("0123456789"), font=font, fill=(240, 232, 214))
    d.text((16, y0 + CELL // 2 + 14), name[len(name.rstrip("0123456789")):] + "px", font=small, fill=(170, 162, 146))
    j = pixellab18(name)
    # 1. PixelLab 18
    sprite, img, at = cell(name)
    g = ImageDraw.Draw(img)
    for a, b in PL_BONES:
        g.line([at(*j[a]), at(*j[b])], fill=colour(a, b), width=3)
    sheet.alpha_composite(img, (LABEL, y0))
    # 2. MediaPipe pose
    sprite, img, at = cell(name)
    g = ImageDraw.Draw(img)
    if "pose" in mp[name]:
        p = mp[name]["pose"]
        for a, b in MP_BONES:
            g.line([at(*p[a][:2]), at(*p[b][:2])], fill=GREEN, width=3)
    else:
        found = mp[name]["holistic"]["pose"]
        g.rectangle([0, CELL - 30, CELL, CELL], fill=(20, 18, 14, 230))
        g.text((8, CELL - 26), "no body found" + (" (Holistic: yes)" if found else ""), font=small, fill=(240, 120, 110))
    sheet.alpha_composite(img, (LABEL + (CELL + PAD), y0))
    # 3. PixelLab custom extras
    sprite, img, at = cell(name)
    g = ImageDraw.Draw(img)
    s = sprite.width
    if name in custom:
        pts = {e[0]: (e[2] * s, e[3] * s) for e in custom[name]["extra"]}
        for joint, parent, x, y in custom[name]["extra"]:
            if parent in pts:
                start = pts[parent]
            elif ANCHOR.get(parent):
                start = j[ANCHOR[parent]]
            else:
                start = None
            if start:
                g.line([at(*start), at(x * s, y * s)], fill=GOLD, width=3)
        for x, y in pts.values():
            px, py = at(x, y)
            g.ellipse([px - 4, py - 4, px + 4, py + 4], fill=GOLD)
    else:
        g.rectangle([0, CELL - 30, CELL, CELL], fill=(20, 18, 14, 230))
        g.text((8, CELL - 26), "not run", font=small, fill=(170, 162, 146))
    sheet.alpha_composite(img, (LABEL + 2 * (CELL + PAD), y0))
    # 4. segmenter classes
    sprite, img, at = cell(name)
    classes = Image.open(os.path.join(HERE, "out", f"{name}-classes.png")).convert("RGBA")
    box = sprite.getbbox()
    side = max(box[2] - box[0], box[3] - box[1]) + 6
    cx, cy = (box[0] + box[2]) / 2, (box[1] + box[3]) / 2
    crop = classes.crop((round(cx - side / 2), round(cy - side / 2), round(cx + side / 2), round(cy + side / 2))).resize((CELL - 16, CELL - 16), Image.NEAREST)
    dim = Image.new("RGBA", (CELL, CELL), (0, 0, 0, 120))
    img.alpha_composite(dim)
    img.alpha_composite(crop, (8, 8))
    if sum(mp[name]["classes"].values()) == 0:
        ImageDraw.Draw(img).text((8, CELL - 26), "nothing found", font=small, fill=(240, 120, 110))
    sheet.alpha_composite(img, (LABEL + 3 * (CELL + PAD), y0))
d.text((16, sheet.height - 28), "segmenter: yellow hair, orange skin, blue clothes, green accessories", font=small, fill=(170, 162, 146))
sheet.convert("RGB").save(OUT, optimize=True)
print(OUT, sheet.size)
