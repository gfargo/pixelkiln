"""Turn the 8 identical frames `pixelkiln estimate-skeleton --frames 8` writes
into a one-arm wave: the character's right arm (on the left of the picture)
is raised with the elbow out at shoulder height, and the hand swings side to
side above the head. The left arm, the legs and the head stay where the
estimate put them, so the loop has no jump.

Usage: pixelkiln estimate-skeleton base-south.png --out poses/estimate.json --frames 8
       python3 make-wave.py poses/estimate.json poses/wave.json
"""
import copy
import json
import math
import sys

source, target = sys.argv[1], sys.argv[2]
d = json.load(open(source))
base = {k["label"]: k for k in d["firstFrameKeypoints"]}
shoulder = base["RIGHT SHOULDER"]
frames = []
for i in range(8):
    swing = math.sin(2 * math.pi * i / 8)
    f = copy.deepcopy(d["firstFrameKeypoints"])
    for k in f:
        if k["label"] == "RIGHT ELBOW":
            k["x"] = shoulder["x"] - 0.13 + 0.015 * swing
            k["y"] = shoulder["y"] - 0.02
            k["z_index"] = 1
        elif k["label"] == "RIGHT ARM":
            k["x"] = shoulder["x"] - 0.11 + 0.07 * swing
            k["y"] = shoulder["y"] - 0.21
            k["z_index"] = 1
    frames.append(f)
d["frames"] = frames
json.dump(d, open(target, "w"), indent=1)
