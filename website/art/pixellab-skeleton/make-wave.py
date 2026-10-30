"""Turn the 8 identical frames `pixelkiln estimate-skeleton --frames 8` writes
into a waving motion: both arms rise above the shoulders and swing side to side.

Usage: pixelkiln estimate-skeleton hero-south.png --out poses/wave.json --frames 8
       python3 make-wave.py poses/wave.json
"""
import copy
import json
import math
import sys

path = sys.argv[1]
d = json.load(open(path))
base = {k["label"]: k for k in d["firstFrameKeypoints"]}
frames = []
for i in range(8):
    t = 2 * math.pi * i / 8
    f = copy.deepcopy(d["firstFrameKeypoints"])
    for k in f:
        for side, phase in (("RIGHT", 0), ("LEFT", math.pi)):
            if k["label"] in (side + " ARM", side + " ELBOW"):
                hand = k["label"].endswith("ARM")
                k["y"] = base[side + " SHOULDER"]["y"] - (0.20 if hand else 0.10)
                k["x"] = base[k["label"]]["x"] + 0.05 * math.sin(t + phase) * (1.4 if hand else 0.7)
    frames.append(f)
d["frames"] = frames
json.dump(d, open(path, "w"), indent=1)
