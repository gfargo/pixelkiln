"""Cut props out of sprites with SAM 2.1 and turn each mask into a bone.

One click per prop (the point is a joint PixelLab's custom skeleton placed on it, so
both tools are asked about the same thing). The mask is kept only where the sprite has
pixels. A rigid prop's bone is the long axis of its mask (principal components), from
end to end; a cape's is its thinned centre line (scikit-image skeletonize).

Needs: pip install torch transformers pillow scikit-image numpy (tried with torch 2.15,
transformers 5.23). Model: facebook/sam2.1-hiera-<size> from Hugging Face, Apache-2.0.

  python3 sam-trial.py [tiny|small|base-plus|large] [cpu|mps|cuda]   # writes sam-<size>.json, out-<size>/sam-*.png
"""
import json
import math
import os
import sys
import time

import numpy as np
import torch
from PIL import Image
from skimage.morphology import skeletonize
from transformers import Sam2Model, Sam2Processor

HERE = os.path.dirname(os.path.abspath(__file__))
SIZE = sys.argv[1] if len(sys.argv) > 1 else "small"
DEVICE = sys.argv[2] if len(sys.argv) > 2 else ("cuda" if torch.cuda.is_available() else "mps" if torch.backends.mps.is_available() else "cpu")
MODEL = f"facebook/sam2.1-hiera-{SIZE}"
SCALE = 4  # enlarge by nearest neighbour; SAM works at 1024px
custom = json.load(open(os.path.join(HERE, "pixellab", "custom-rigs.json")))

# prop -> sprite, the PixelLab joint used as the click, the PixelLab joints that make its bone, rigid or not
PROPS = {
    "staff": ("mage128", "staff_mid", ["staff_grip", "staff_mid", "staff_top"], True),
    "sword": ("knight128", "sword_mid", ["sword_hilt", "sword_mid", "sword_tip"], True),
    "shield": ("knight128", None, ["shield_top", "shield_bottom"], True),
    "knight cape": ("knight128", "cape_3", ["cape_1", "cape_2", "cape_3", "cape_4"], False),
    "cape": ("cape256", "cape_left_3", ["cape_left_1", "cape_left_2", "cape_left_3", "cape_left_4", "cape_left_tip"], False),
}

processor = Sam2Processor.from_pretrained(MODEL)
model = Sam2Model.from_pretrained(MODEL).to(DEVICE)
OUT = os.path.join(HERE, f"out-{SIZE}")
os.makedirs(OUT, exist_ok=True)


def joints(sprite):
    s = Image.open(os.path.join(HERE, "sprites", f"{sprite}.png")).width
    return {e[0]: (e[2] * s, e[3] * s) for e in custom[sprite]["extra"]}


def segment(sprite, point):
    img = Image.open(os.path.join(HERE, "sprites", f"{sprite}.png")).convert("RGBA")
    flat = Image.new("RGBA", img.size, (255, 255, 255, 255))
    flat.alpha_composite(img)
    big = flat.convert("RGB").resize((img.width * SCALE, img.height * SCALE), Image.NEAREST)
    inputs = processor(images=big, input_points=[[[[point[0] * SCALE, point[1] * SCALE]]]], input_labels=[[[1]]], return_tensors="pt").to(DEVICE)
    t = time.time()
    with torch.no_grad():
        out = model(**inputs, multimask_output=True)
    ms = round((time.time() - t) * 1000)
    masks = processor.post_process_masks(out.pred_masks.cpu(), inputs["original_sizes"])[0][0]  # 3 candidates
    best = int(out.iou_scores[0, 0].argmax())
    big_mask = masks[best].numpy().astype(np.uint8) * 255
    mask = np.asarray(Image.fromarray(big_mask).resize(img.size, Image.NEAREST)) > 0
    mask &= np.asarray(img.split()[-1]) > 0
    return img, mask, float(out.iou_scores[0, 0, best]), ms


def axis(mask):
    ys, xs = np.nonzero(mask)
    pts = np.stack([xs + 0.5, ys + 0.5], 1)
    centre = pts.mean(0)
    _, _, vt = np.linalg.svd(pts - centre, full_matrices=False)
    t = (pts - centre) @ vt[0]
    return (centre + vt[0] * t.min()).tolist(), (centre + vt[0] * t.max()).tolist()


results = {"model": MODEL, "device": DEVICE, "props": {}}
for prop, (sprite, click, chain, rigid) in PROPS.items():
    j = joints(sprite)
    point = j[click] if click else tuple(np.mean([j[n] for n in chain], 0))
    img, mask, score, ms = segment(sprite, point)
    row = {"sprite": sprite, "click": [round(point[0], 1), round(point[1], 1)], "iou_score": round(score, 3), "ms": ms, "pixels": int(mask.sum())}
    if mask.sum() >= 3:
        a, b = axis(mask)
        row["axis"] = [[round(v, 1) for v in a], [round(v, 1) for v in b]]
        row["axis_length"] = round(math.dist(a, b), 1)
        ends = [j[chain[0]], j[chain[-1]]]
        # distance of PixelLab's chain ends from the nearest end of the SAM axis
        row["pixellab_end_offsets"] = [round(min(math.dist(e, a), math.dist(e, b)), 1) for e in ends]
        if not rigid:
            row["centre_line_pixels"] = int(skeletonize(mask).sum())
    results["props"][prop] = row
    overlay = img.copy()
    tint = Image.new("RGBA", img.size, (255, 90, 200, 170))
    overlay.paste(tint, mask=Image.fromarray((mask * 255).astype(np.uint8)))
    overlay.save(os.path.join(OUT, f"sam-{prop.replace(' ', '-')}.png"))

json.dump(results, open(os.path.join(HERE, f"sam-{SIZE}.json"), "w"), indent=1)
for prop, r in results["props"].items():
    print(prop, r["sprite"], "pixels", r["pixels"], "iou", r["iou_score"], "axis", r.get("axis_length"), "pixellab ends off by", r.get("pixellab_end_offsets"), f'{r["ms"]}ms')
