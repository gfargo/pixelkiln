"""Run MediaPipe's hand and pose landmarkers on the 64, 128 and 256px figures.

Every picture is tried at several enlargements (nearest neighbour, so no new
detail), on a white and a mid-grey ground, both as the whole figure and as a
close crop of the right hand. Points are mapped back to the sprite's own pixels
and printed as JSON for scoring against the hand-placed points.

Needs: pip install mediapipe pillow numpy (tried with mediapipe 1.2.3), and the
model files hand_landmarker.task and pose_landmarker_heavy.task from
https://storage.googleapis.com/mediapipe-models/ in MODELS (default ./models).

  python3 mediapipe-trial.py > mediapipe-results.json
"""
import json
import os
import sys

import mediapipe as mp
import numpy as np
from mediapipe.tasks import python as mp_python
from mediapipe.tasks.python import vision
from PIL import Image

HERE = os.path.dirname(os.path.abspath(__file__))
MODELS = os.environ.get("MODELS", os.path.join(HERE, "models"))
GROUNDS = {"white": (255, 255, 255), "grey": (128, 128, 128)}
SCALES = [1, 2, 4, 8, 16]
MAX_SIDE = 2048

hands = vision.HandLandmarker.create_from_options(vision.HandLandmarkerOptions(
    base_options=mp_python.BaseOptions(model_asset_path=os.path.join(MODELS, "hand_landmarker.task")),
    num_hands=2, min_hand_detection_confidence=0.1, min_hand_presence_confidence=0.1, min_tracking_confidence=0.1))
pose = vision.PoseLandmarker.create_from_options(vision.PoseLandmarkerOptions(
    base_options=mp_python.BaseOptions(model_asset_path=os.path.join(MODELS, "pose_landmarker_heavy.task")),
    min_pose_detection_confidence=0.1, min_pose_presence_confidence=0.1))

# MediaPipe hand landmarks kept: wrist, thumb base (MCP) and tip, middle knuckle and tip.
HAND_KEEP = {0: "wrist", 2: "thumb base", 4: "thumb tip", 9: "knuckles", 12: "fingertip"}
# Pose landmarks for the figure's right hand (on the left of the picture).
POSE_KEEP = {16: "wrist", 18: "pinky", 20: "index", 22: "thumb"}


def joints(size):
    data = json.load(open(os.path.join(HERE, f"estimate-{size}.json")))
    return {k["label"]: (k["x"] * size, k["y"] * size) for k in data["firstFrameKeypoints"]}


def crops(size):
    """The whole figure, and a close crop around its right hand."""
    wx, wy = joints(size)["RIGHT ARM"]
    w, h = max(8, round(size * 0.19)), max(8, round(size * 0.125))
    left, top = max(0, round(wx - 0.75 * w)), max(0, round(wy - 0.5 * h))
    return {"figure": (0, 0, size, size), "hand": (left, top, left + w, top + h)}


def run(size):
    sprite = Image.open(os.path.join(HERE, f"body{size}.png")).convert("RGBA")
    out = []
    for crop_name, box in crops(size).items():
        part = sprite.crop(box)
        for ground_name, ground in GROUNDS.items():
            flat = Image.new("RGBA", part.size, ground + (255,))
            flat.alpha_composite(part)
            for scale in SCALES:
                if max(part.size) * scale > MAX_SIDE:
                    continue
                big = flat.convert("RGB").resize((part.width * scale, part.height * scale), Image.NEAREST)
                image = mp.Image(image_format=mp.ImageFormat.SRGB, data=np.asarray(big))

                def back(lm):
                    # landmark fractions of the enlarged picture -> the sprite's own pixels
                    return [round(box[0] + lm.x * part.width, 2), round(box[1] + lm.y * part.height, 2)]

                found_hands = []
                for landmarks, handed in zip(hands.detect(image).hand_landmarks, hands.detect(image).handedness):
                    found_hands.append({
                        "score": round(handed[0].score, 3),
                        "label": handed[0].category_name,
                        "points": {name: back(landmarks[i]) for i, name in HAND_KEEP.items()},
                    })
                found_pose = None
                result = pose.detect(image)
                if result.pose_landmarks:
                    lm = result.pose_landmarks[0]
                    found_pose = {name: back(lm[i]) + [round(lm[i].visibility, 3)] for i, name in POSE_KEEP.items()}
                out.append({"size": size, "crop": crop_name, "ground": ground_name, "scale": scale,
                            "input": [part.width * scale, part.height * scale],
                            "hands": found_hands, "pose": found_pose})
    return out


if __name__ == "__main__":
    results = []
    for size in (64, 128, 256):
        results += run(size)
    json.dump({"mediapipe": mp.__version__, "results": results}, sys.stdout, indent=1)
