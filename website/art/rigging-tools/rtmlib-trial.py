"""Run rtmlib's whole-body pose models (RTMW, DWPose-style 133 keypoints) on the test sprites.

Each sprite goes on white, enlarged by nearest neighbour 1, 2 and 4 times. Body joints are
compared with PixelLab's 18-joint estimate (pixellab/<name>.json), and the right hand with the
hand-placed points in ../skeleton-resolution/score-hands.py for the bare 64, 128 and 256px figures.

Needs: pip install rtmlib onnxruntime opencv-python-headless (tried with onnxruntime 1.32). The
ONNX models download on first use from download.openmmlab.com. Licences: rtmlib code Apache-2.0;
the YOLOX detector was trained on Human-Art (CC BY-NC-SA 4.0) and RTMW on 14 datasets, so the
model files are not ours to redistribute.

  python3 rtmlib-trial.py [lightweight|balanced|performance] > rtmlib-<mode>.json
"""
import json
import math
import os
import sys
import time

import numpy as np
from PIL import Image
from rtmlib import Wholebody

HERE = os.path.dirname(os.path.abspath(__file__))
MODE = sys.argv[1] if len(sys.argv) > 1 else "balanced"
SPRITES = ["bare64", "bare256", "cape256", "cuirass256", "knight128", "mage128", "adventurer64"]
HANDS = {"bare64": "../skeleton-resolution/body64.png", "bare128": "../skeleton-resolution/body128.png", "bare256": "../skeleton-resolution/body256.png"}
# COCO-17 body index -> PixelLab label
COCO_TO_PL = {0: "NOSE", 1: "LEFT EYE", 2: "RIGHT EYE", 3: "LEFT EAR", 4: "RIGHT EAR", 5: "LEFT SHOULDER", 6: "RIGHT SHOULDER",
              7: "LEFT ELBOW", 8: "RIGHT ELBOW", 9: "LEFT ARM", 10: "RIGHT ARM", 11: "LEFT HIP", 12: "RIGHT HIP",
              13: "LEFT KNEE", 14: "RIGHT KNEE", 15: "LEFT LEG", 16: "RIGHT LEG"}
RIGHT_HAND = 112  # COCO-WholeBody: 91-111 left hand, 112-132 right hand; 21 points each
HAND_KEEP = {0: "wrist", 2: "thumb base", 4: "thumb tip", 9: "knuckles", 12: "fingertip"}

model = Wholebody(mode=MODE, backend="onnxruntime", device="cpu", to_openpose=False)


def run(path, scale):
    sprite = Image.open(path).convert("RGBA")
    flat = Image.new("RGBA", sprite.size, (255, 255, 255, 255))
    flat.alpha_composite(sprite)
    big = flat.convert("RGB").resize((sprite.width * scale, sprite.height * scale), Image.NEAREST)
    bgr = np.asarray(big)[:, :, ::-1].copy()
    t = time.time()
    keypoints, scores = model(bgr)
    ms = round((time.time() - t) * 1000)
    if len(keypoints) == 0:
        return None, ms
    best = int(np.argmax(scores[:, :17].mean(axis=1)))
    return (keypoints[best] / scale, scores[best]), ms


def pixellab(name):
    path = os.path.join(HERE, "pixellab", f"{name}.json")
    if not os.path.exists(path):
        return None
    d = json.load(open(path))
    s = Image.open(os.path.join(HERE, "sprites", f"{name}.png")).width
    return {k["label"]: (k["x"] * s, k["y"] * s) for k in d["firstFrameKeypoints"]}


out = {"mode": MODE, "body": [], "hands": []}
for name in SPRITES:
    path = os.path.join(HERE, "sprites", f"{name}.png")
    size = Image.open(path).width
    pl = pixellab(name)
    for scale in (1, 2, 4):
        res, ms = run(path, scale)
        row = {"sprite": name, "size": size, "scale": scale, "ms": ms}
        if res is None:
            row["found"] = False
        else:
            kp, sc = res
            row["found"] = True
            row["body_score"] = round(float(sc[:17].mean()), 3)
            if pl:
                torso = math.dist(pl["NECK"], ((pl["LEFT HIP"][0] + pl["RIGHT HIP"][0]) / 2, (pl["LEFT HIP"][1] + pl["RIGHT HIP"][1]) / 2))
                d = [math.dist(kp[i], pl[label]) for i, label in COCO_TO_PL.items() if label in pl]
                row["mean_to_pixellab_torso"] = round(sum(d) / len(d) / torso, 3)
            row["coco17"] = [[round(float(x), 2), round(float(y), 2)] for x, y in kp[:17]]
        out["body"].append(row)

for name, rel in HANDS.items():
    path = os.path.join(HERE, rel)
    size = Image.open(path).width
    for scale in (1, 2, 4):
        res, ms = run(path, scale)
        row = {"sprite": name, "size": size, "scale": scale}
        if res is None:
            row["found"] = False
        else:
            kp, sc = res
            row["found"] = True
            row["hand_score"] = round(float(sc[RIGHT_HAND:RIGHT_HAND + 21].mean()), 3)
            row["points"] = {n: [round(float(kp[RIGHT_HAND + i][0]), 2), round(float(kp[RIGHT_HAND + i][1]), 2)] for i, n in HAND_KEEP.items()}
        out["hands"].append(row)

json.dump(out, sys.stdout, indent=1)
