"""Clear the background of refined native frames and crop each motion to one shared box.

  python3 key-and-crop.py <native-dir> <out-dir> knight=#848485,goblin=#434d50

<native-dir>/<character>/<motion>/frame-NN.png are `pixelkiln refine` outputs, already
on one palette whose last colour is the background. A pixel becomes transparent when it
is exactly that colour and connected to the frame's edge (a flood fill), so a grey inside
the character stays. The drop shadow is a different grey and stays too; the README says
what that means. Every frame of a motion is cropped to the union of their opaque boxes plus
a 1px margin, so the feet keep one ground line and the loop does not jump.

Writes <out-dir>/<character>/<motion>/frame-NN.png (native, RGBA), <character>-<motion>-strip.png
(the frames side by side at 1x) and <character>-<motion>-x4.gif (4x nearest-neighbour preview).
"""
import os
import sys
from collections import deque

from PIL import Image

FPS = {"idle": 4, "walk": 8, "attack": 6}
src, out = sys.argv[1], sys.argv[2]
# knight=#848485,goblin=#434d50: each character's palette has its own background colour
BGS = {name: tuple(int(h.lstrip("#")[i:i + 2], 16) for i in (0, 2, 4))
       for name, h in (pair.split("=") for pair in sys.argv[3].split(","))}


def key(img, BG):
    img = img.convert("RGBA")
    w, h = img.size
    px = img.load()
    seen = set()
    queue = deque((x, y) for x in range(w) for y in (0, h - 1))
    queue.extend((x, y) for y in range(h) for x in (0, w - 1))
    while queue:
        x, y = queue.popleft()
        if (x, y) in seen or not (0 <= x < w and 0 <= y < h) or px[x, y][:3] != BG:
            continue
        seen.add((x, y))
        px[x, y] = (0, 0, 0, 0)
        queue.extend(((x + 1, y), (x - 1, y), (x, y + 1), (x, y - 1)))
    return img


for character in sorted(os.listdir(src)):
    for motion in sorted(os.listdir(os.path.join(src, character))):
        folder = os.path.join(src, character, motion)
        names = sorted(f for f in os.listdir(folder) if f.endswith(".png"))
        frames = [key(Image.open(os.path.join(folder, n)), BGS[character]) for n in names]
        boxes = [f.getbbox() for f in frames]
        left = max(min(b[0] for b in boxes) - 1, 0)
        top = max(min(b[1] for b in boxes) - 1, 0)
        right = min(max(b[2] for b in boxes) + 1, frames[0].width)
        bottom = min(max(b[3] for b in boxes) + 1, frames[0].height)
        cropped = [f.crop((left, top, right, bottom)) for f in frames]
        dest = os.path.join(out, character, motion)
        os.makedirs(dest, exist_ok=True)
        for n, f in zip(names, cropped):
            f.save(os.path.join(dest, n))
        w, h = cropped[0].size
        strip = Image.new("RGBA", (w * len(cropped), h))
        for i, f in enumerate(cropped):
            strip.paste(f, (i * w, 0))
        strip.save(os.path.join(out, f"{character}-{motion}-strip.png"))
        preview = []
        for f in cropped:
            canvas = Image.new("RGBA", (w, h), (40, 44, 52, 255))
            canvas.alpha_composite(f)
            preview.append(canvas.convert("RGB").resize((w * 4, h * 4), Image.NEAREST))
        preview[0].save(os.path.join(out, f"{character}-{motion}-x4.gif"), save_all=True,
                        append_images=preview[1:], duration=1000 // FPS.get(motion, 6), loop=0)
        print(character, motion, f"{w}x{h}", len(cropped), "frames")
