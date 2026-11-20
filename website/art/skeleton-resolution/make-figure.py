"""Draw the figure that compares sprite size with how much skeleton the hand can carry.

Inputs, all in this folder:
  body64.png    a native 64px character (PixelLab, A-pose)
  body256.png   a native 256px character of the same kind (PixelLab, T-pose)
  body128.png   body256.png reduced 2x by nearest neighbour: there is no native 128px drawing
  estimate-*.json   `pixelkiln estimate-skeleton` on each (0.1 generation each)

The hand points beyond the wrist are not estimated by anything; they are read off the 256px
drawing by eye and scaled for 128px, to show what each size has room for.

  python3 make-figure.py     # writes ../../public/showcase/skeleton/resolution.png
"""
import json
import os
from PIL import Image, ImageDraw, ImageFont

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "..", "..", "public", "showcase", "skeleton", "resolution.png")

BG = (20, 18, 14)
PANEL = (27, 25, 19)
RIGHT, LEFT, MID = (255, 140, 40), (70, 150, 255), (235, 235, 235)
HAND = (255, 225, 90)
BONES = [("NECK", "NOSE"), ("NOSE", "RIGHT EYE"), ("NOSE", "LEFT EYE"), ("RIGHT EYE", "RIGHT EAR"), ("LEFT EYE", "LEFT EAR"),
         ("NECK", "RIGHT SHOULDER"), ("RIGHT SHOULDER", "RIGHT ELBOW"), ("RIGHT ELBOW", "RIGHT ARM"),
         ("NECK", "LEFT SHOULDER"), ("LEFT SHOULDER", "LEFT ELBOW"), ("LEFT ELBOW", "LEFT ARM"),
         ("NECK", "RIGHT HIP"), ("RIGHT HIP", "RIGHT KNEE"), ("RIGHT KNEE", "RIGHT LEG"),
         ("NECK", "LEFT HIP"), ("LEFT HIP", "LEFT KNEE"), ("LEFT KNEE", "LEFT LEG")]

# Read off body256.png by eye, in its own pixels: the knuckle line, the tip of the
# fingers (drawn as one block), the base and tip of the thumb.
HAND_256 = {"knuckles": (25, 67), "fingertip": (12, 68), "thumb base": (29, 70), "thumb tip": (26, 75)}


def colour(a, b):
    # Eyes and ears in grey, as skeleton-preview draws them: in the side colours the
    # lines up to the ears look like raised arms.
    if any(part in a + b for part in ("EYE", "EAR")):
        return (150, 150, 150)
    if "RIGHT" in a or "RIGHT" in b:
        return RIGHT
    if "LEFT" in a or "LEFT" in b:
        return LEFT
    return MID


def joints(size):
    data = json.load(open(os.path.join(HERE, f"estimate-{size}.json")))
    return {k["label"]: (k["x"] * size, k["y"] * size) for k in data["firstFrameKeypoints"]}


def hand_points(size):
    """What each size's hand can carry beyond the wrist."""
    if size == 64:
        return {}
    if size == 128:
        return {"fingertip": tuple(v / 2 for v in HAND_256["fingertip"])}
    return HAND_256


def body_panel(size, height=256):
    sprite = Image.open(os.path.join(HERE, f"body{size}.png")).convert("RGBA")
    scale = height // size
    big = sprite.resize((size * scale, size * scale), Image.NEAREST)
    panel = Image.new("RGBA", big.size, PANEL + (255,))
    panel.alpha_composite(big)
    d = ImageDraw.Draw(panel)
    j = joints(size)
    w = max(2, scale // 2 + 1) if size < 256 else 2
    for a, b in BONES:
        d.line([tuple(v * scale for v in j[a]), tuple(v * scale for v in j[b])], fill=colour(a, b), width=w)
    for name, p in j.items():
        r = max(3, scale)
        d.ellipse([p[0] * scale - r, p[1] * scale - r, p[0] * scale + r, p[1] * scale + r], fill=colour(name, name))
    return panel


def hand_panel(size, width=360, height=240):
    """The right hand (on the left of the picture), at the same real-world size for every sprite."""
    sprite = Image.open(os.path.join(HERE, f"body{size}.png")).convert("RGBA")
    # The same share of the picture for every size, with the wrist 70% of the way across.
    j = joints(size)
    wx, wy = j["RIGHT ARM"]
    w, h = max(8, round(size * 0.19)), max(5, round(size * 0.125))
    left, top = round(wx - 0.7 * w), round(wy - 0.5 * h)
    box = (left, top, left + w, top + h)
    crop = sprite.crop(box)
    scale = width // crop.width
    big = crop.resize((crop.width * scale, crop.height * scale), Image.NEAREST)
    panel = Image.new("RGBA", (width, height), PANEL + (255,))
    oy = (height - big.height) // 2
    panel.alpha_composite(big, ((width - big.width) // 2, oy))
    ox = (width - big.width) // 2
    d = ImageDraw.Draw(panel)

    def at(p):
        return ((p[0] - box[0]) * scale + ox, (p[1] - box[1]) * scale + oy)

    elbow, wrist = at(j["RIGHT ELBOW"]), at(j["RIGHT ARM"])
    d.line([elbow, wrist], fill=RIGHT, width=4)
    hand = {k: at(v) for k, v in hand_points(size).items()}
    if "knuckles" in hand:
        d.line([wrist, hand["knuckles"], hand["fingertip"]], fill=HAND, width=4)
        d.line([wrist, hand["thumb base"], hand["thumb tip"]], fill=HAND, width=4)
    elif "fingertip" in hand:
        d.line([wrist, hand["fingertip"]], fill=HAND, width=4)
    for p in hand.values():
        d.ellipse([p[0] - 6, p[1] - 6, p[0] + 6, p[1] + 6], fill=HAND)
    d.ellipse([wrist[0] - 7, wrist[1] - 7, wrist[0] + 7, wrist[1] + 7], fill=RIGHT)
    return panel


LABELS = {
    64: ("64px", "hand 6x5 px: the wrist is all there is"),
    128: ("128px", "hand 12x7 px: wrist and fingertip, a direction"),
    256: ("256px", "hand 24x14 px: knuckles, fingertip, thumb"),
}


def main():
    gap, pad, col = 24, 24, 360
    font = ImageFont.load_default(size=22)
    small = ImageFont.load_default(size=16)
    width = pad * 2 + col * 3 + gap * 2
    height = pad * 2 + 64 + 256 + gap + 240
    sheet = Image.new("RGBA", (width, height), BG + (255,))
    d = ImageDraw.Draw(sheet)
    for i, size in enumerate((64, 128, 256)):
        x = pad + i * (col + gap)
        title, note = LABELS[size]
        d.text((x, pad), title, font=font, fill=(240, 232, 214))
        d.text((x, pad + 30), note, font=small, fill=(170, 162, 146))
        body = body_panel(size)
        sheet.alpha_composite(body, (x + (col - body.width) // 2, pad + 64))
        sheet.alpha_composite(hand_panel(size), (x, pad + 64 + 256 + gap))
    sheet.convert("RGB").save(OUT, optimize=True)
    print(OUT, sheet.size)


if __name__ == "__main__":
    main()
