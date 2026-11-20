"""Score PixelLab's custom-skeleton estimate and MediaPipe against hand points placed by eye.

Error is the distance in the sprite's own pixels, and as a share of the hand's
length (wrist to fingertip, from the hand-placed points). Only the hand on the
left of the picture (the figure's right hand) is scored.

  python3 score-hands.py   # reads pixellab-custom-results.json, mediapipe-results.json
"""
import json
import math
import os

HERE = os.path.dirname(os.path.abspath(__file__))
# Placed by eye on each drawing, sprite pixels. 128px is the 256px drawing halved.
TRUTH_256 = {"knuckles": (25, 67), "fingertip": (12, 68), "thumb base": (29, 70), "thumb tip": (26, 75)}
TRUTH = {
    256: TRUTH_256,
    128: {k: (x / 2, y / 2) for k, (x, y) in TRUTH_256.items()},
    64: {"knuckles": (7.5, 24.5), "fingertip": (4.5, 24.5), "thumb base": (8.5, 25.5), "thumb tip": (7.5, 27.5)},
}
POINTS = ["knuckles", "fingertip", "thumb base", "thumb tip"]


def wrist(size):
    data = json.load(open(os.path.join(HERE, f"estimate-{size}.json")))
    k = {j["label"]: j for j in data["firstFrameKeypoints"]}["RIGHT ARM"]
    return (k["x"] * size, k["y"] * size)


def score(size, found):
    truth = TRUTH[size]
    length = math.dist(wrist(size), truth["fingertip"])
    errors = [math.dist(found[p], truth[p]) for p in POINTS if p in found]
    mean = sum(errors) / len(errors)
    return round(mean, 1), round(100 * mean / length), round(max(errors), 1)


rows = []
pl = json.load(open(os.path.join(HERE, "pixellab-custom-results.json")))["results"]
for size in (64, 128, 256):
    r = pl[str(size)]
    found = {p: (r[p][0] * size, r[p][1] * size) for p in POINTS}
    rows.append(("PixelLab custom skeleton", size, "as sent", *score(size, found)))

mp = json.load(open(os.path.join(HERE, "mediapipe-results.json")))["results"]
for size in (64, 128, 256):
    for r in mp:
        if r["size"] != size or r["crop"] != "figure" or r["ground"] != "white":
            continue
        left = [h for h in r["hands"] if h["points"]["wrist"][0] < size / 2]
        setting = f"figure x{r['scale']}, white"
        if not left:
            rows.append(("MediaPipe Hand Landmarker", size, setting, None, None, None))
            continue
        best = max(left, key=lambda h: h["score"])
        rows.append(("MediaPipe Hand Landmarker", size, setting, *score(size, best["points"])))

print("| Tool | Sprite | Input | Mean error, px | Mean error, % of hand | Worst point, px |")
print("|---|---|---|---|---|---|")
for tool, size, setting, mean, share, worst in rows:
    if mean is None:
        print(f"| {tool} | {size}px | {setting} | no hand found | | |")
    else:
        print(f"| {tool} | {size}px | {setting} | {mean} | {share}% | {worst} |")
