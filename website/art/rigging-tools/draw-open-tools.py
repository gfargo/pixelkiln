"""Draw rtmlib's body (RTMW, balanced, at the sprite's own size) beside MediaPipe's, and
SAM 2.1's prop masks.

  python3 draw-open-tools.py   # writes ../../public/showcase/skeleton/open-tools.png
"""
import json
import os
from PIL import Image, ImageDraw, ImageFont

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "..", "..", "public", "showcase", "skeleton", "open-tools.png")
ROWS = ["adventurer64", "bare64", "knight128", "mage128", "cape256"]
# The prop mask shown per row: (overlay file, model size, label)
PROP = {"knight128": ("sword", "large", "sword, SAM 2.1 large"), "mage128": ("staff", "small", "staff, SAM 2.1 small"),
        "cape256": ("cape", "small", "cape, SAM 2.1 small")}
CELL, PAD, LABEL = 236, 18, 150
GREEN, TEAL = (90, 220, 140), (80, 200, 255)
COCO = [(5, 6), (5, 7), (7, 9), (6, 8), (8, 10), (5, 11), (6, 12), (11, 12), (11, 13), (13, 15), (12, 14), (14, 16), (0, 5), (0, 6)]
MP = [(11, 12), (11, 13), (13, 15), (12, 14), (14, 16), (11, 23), (12, 24), (23, 24), (23, 25), (25, 27), (24, 26), (26, 28), (0, 11), (0, 12)]

rt = {r["sprite"]: r for r in json.load(open(os.path.join(HERE, "rtmlib-balanced.json")))["body"] if r["scale"] == 1}
mp = json.load(open(os.path.join(HERE, "mediapipe.json")))["sprites"]
font, small = ImageFont.load_default(size=19), ImageFont.load_default(size=15)


def frame(img, sprite_size):
    box = img.getbbox()
    side = max(box[2] - box[0], box[3] - box[1]) + 6
    cx, cy = (box[0] + box[2]) / 2, (box[1] + box[3]) / 2
    left, top = round(cx - side / 2), round(cy - side / 2)
    scale = (CELL - 16) / side
    crop = img.crop((left, top, left + side, top + side)).resize((CELL - 16, CELL - 16), Image.NEAREST)
    base = Image.new("RGBA", (CELL, CELL), (27, 25, 19, 255))
    base.alpha_composite(crop, (8, 8))
    return base, (lambda x, y: ((x - left) * scale + 8, (y - top) * scale + 8))


def note(img, text, colour=(240, 120, 110)):
    g = ImageDraw.Draw(img)
    g.rectangle([0, CELL - 30, CELL, CELL], fill=(20, 18, 14, 230))
    g.text((8, CELL - 26), text, font=small, fill=colour)


sheet = Image.new("RGBA", (LABEL + 3 * (CELL + PAD), 60 + len(ROWS) * (CELL + PAD) + 10), (20, 18, 14, 255))
d = ImageDraw.Draw(sheet)
for c, title in enumerate(["rtmlib RTMW: body", "MediaPipe: body", "SAM 2.1: one click on a prop"]):
    d.text((LABEL + c * (CELL + PAD), 22), title, font=small, fill=(240, 232, 214))
for r, name in enumerate(ROWS):
    y0 = 60 + r * (CELL + PAD)
    d.text((16, y0 + CELL // 2 - 10), name.rstrip("0123456789"), font=font, fill=(240, 232, 214))
    d.text((16, y0 + CELL // 2 + 14), name[len(name.rstrip("0123456789")):] + "px", font=small, fill=(170, 162, 146))
    sprite = Image.open(os.path.join(HERE, "sprites", f"{name}.png")).convert("RGBA")
    # rtmlib
    img, at = frame(sprite, sprite.width)
    k = rt[name]["coco17"]
    g = ImageDraw.Draw(img)
    for a, b in COCO:
        g.line([at(*k[a]), at(*k[b])], fill=TEAL, width=3)
    note(img, f"score {rt[name]['body_score']}", (170, 162, 146))
    sheet.alpha_composite(img, (LABEL, y0))
    # MediaPipe
    img, at = frame(sprite, sprite.width)
    if "pose" in mp[name]:
        p = mp[name]["pose"]
        g = ImageDraw.Draw(img)
        for a, b in MP:
            g.line([at(*p[a][:2]), at(*p[b][:2])], fill=GREEN, width=3)
    else:
        note(img, "no body found")
    sheet.alpha_composite(img, (LABEL + CELL + PAD, y0))
    # SAM
    if name in PROP:
        prop, size, label = PROP[name]
        overlay = Image.open(os.path.join(HERE, f"out-{size}", f"sam-{prop}.png")).convert("RGBA")
        img, _ = frame(overlay, overlay.width)
        note(img, label, (255, 150, 220))
    else:
        img, _ = frame(sprite, sprite.width)
        note(img, "no prop tried", (170, 162, 146))
    sheet.alpha_composite(img, (LABEL + 2 * (CELL + PAD), y0))
sheet.convert("RGB").save(OUT, optimize=True)
print(OUT, sheet.size)
