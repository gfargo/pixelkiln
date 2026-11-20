"""Draw each tool's hand points over each sprite's right hand, beside the hand-placed ones.

  python3 draw-trial.py   # writes ../../public/showcase/skeleton/hand-trial.png
"""
import json
import os
from PIL import Image, ImageDraw, ImageFont

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "..", "..", "public", "showcase", "skeleton", "hand-trial.png")
exec(open(os.path.join(HERE, "score-hands.py")).read().split("rows = []")[0])  # TRUTH, POINTS, wrist()

PL = json.load(open(os.path.join(HERE, "pixellab-custom-results.json")))["results"]
MP = json.load(open(os.path.join(HERE, "mediapipe-results.json")))["results"]
TRUE, PIX, MED = (255, 255, 255), (255, 140, 40), (90, 220, 140)
W, H = 300, 200


def mediapipe_points(size):
    for r in MP:
        if r["size"] == size and r["crop"] == "figure" and r["ground"] == "white" and r["scale"] == 1:
            left = [h for h in r["hands"] if h["points"]["wrist"][0] < size / 2]
            if left:
                return max(left, key=lambda h: h["score"])["points"]
    return None


def panel(size, found, colour):
    sprite = Image.open(os.path.join(HERE, f"body{size}.png")).convert("RGBA")
    wx, wy = wrist(size)
    w, h = max(8, round(size * 0.19)), max(5, round(size * 0.125))
    left, top = round(wx - 0.75 * w), round(wy - 0.5 * h)
    crop = sprite.crop((left, top, left + w, top + h))
    s = min(W // w, H // h)
    big = crop.resize((w * s, h * s), Image.NEAREST)
    out = Image.new("RGBA", (W, H), (27, 25, 19, 255))
    ox, oy = (W - big.width) // 2, (H - big.height) // 2
    out.alpha_composite(big, (ox, oy))
    d = ImageDraw.Draw(out)
    at = lambda p: ((p[0] - left) * s + ox, (p[1] - top) * s + oy)
    for p in TRUTH[size].values():
        x, y = at(p)
        d.ellipse([x - 9, y - 9, x + 9, y + 9], outline=TRUE, width=3)
    if found:
        for name in POINTS:
            x, y = at(found[name])
            d.ellipse([x - 6, y - 6, x + 6, y + 6], fill=colour)
    else:
        d.text((16, H - 34), "no hand found", font=ImageFont.load_default(size=20), fill=(240, 120, 110))
    return out


font, small = ImageFont.load_default(size=22), ImageFont.load_default(size=16)
sheet = Image.new("RGBA", (24 + 130 + 2 * (W + 20), 70 + 3 * (H + 20)), (20, 18, 14, 255))
d = ImageDraw.Draw(sheet)
d.text((24 + 130, 20), "PixelLab custom skeleton", font=font, fill=PIX)
d.text((24 + 130 + W + 20, 20), "MediaPipe Hand Landmarker", font=font, fill=MED)
for i, size in enumerate((64, 128, 256)):
    y = 70 + i * (H + 20)
    d.text((24, y + H // 2 - 12), f"{size}px", font=font, fill=(240, 232, 214))
    r = PL[str(size)]
    sheet.alpha_composite(panel(size, {p: (r[p][0] * size, r[p][1] * size) for p in POINTS}, PIX), (24 + 130, y))
    sheet.alpha_composite(panel(size, mediapipe_points(size), MED), (24 + 130 + W + 20, y))
d.text((24, sheet.height - 26), "white rings: placed by eye   dots: the tool", font=small, fill=(170, 162, 146))
sheet.convert("RGB").save(OUT, optimize=True)
print(OUT, sheet.size)
