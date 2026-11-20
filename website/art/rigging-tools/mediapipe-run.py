"""Run MediaPipe's body, holistic and segmentation models on every sprite in sprites/.

Each sprite is put on white and enlarged by nearest neighbour to about 512px
(MediaPipe resizes to its own input anyway; this keeps a thin limb from
vanishing). Results are mapped back to the sprite's own pixels.

Writes mediapipe.json and, per sprite, out/<name>-classes.png (the multiclass
segmenter's labels) and out/<name>-touch.png (the interactive segmenter's mask
for the point named in TOUCH).

Needs: pip install mediapipe pillow numpy (tried with 1.2.3) and, in MODELS,
pose_landmarker_heavy.task, holistic_landmarker.task,
selfie_multiclass_256x256.tflite and magic_touch.tflite from
https://storage.googleapis.com/mediapipe-models/.

  python3 mediapipe-run.py
"""
import glob
import json
import os

import mediapipe as mp
import numpy as np
from mediapipe.tasks import python as mp_python
from mediapipe.tasks.python import vision
from mediapipe.tasks.python.components import containers
from PIL import Image

HERE = os.path.dirname(os.path.abspath(__file__))
MODELS = os.environ.get("MODELS", os.path.join(HERE, "models"))
OUT = os.path.join(HERE, "out")
os.makedirs(OUT, exist_ok=True)
base = lambda f: mp_python.BaseOptions(model_asset_path=os.path.join(MODELS, f))

pose = vision.PoseLandmarker.create_from_options(vision.PoseLandmarkerOptions(
    base_options=base("pose_landmarker_heavy.task"), output_segmentation_masks=True,
    min_pose_detection_confidence=0.1, min_pose_presence_confidence=0.1))
holistic = vision.HolisticLandmarker.create_from_options(vision.HolisticLandmarkerOptions(
    base_options=base("holistic_landmarker.task"),
    min_pose_detection_confidence=0.1, min_pose_landmarks_confidence=0.1,
    min_hand_landmarks_confidence=0.1, min_face_detection_confidence=0.1))
classes = vision.ImageSegmenter.create_from_options(vision.ImageSegmenterOptions(
    base_options=base("selfie_multiclass_256x256.tflite"), output_category_mask=True))
try:
    touch = vision.InteractiveSegmenter.create_from_options(vision.InteractiveSegmenterOptions(
        base_options=base("magic_touch.tflite")))
except RuntimeError as err:
    # mediapipe 1.2.3 wants an interactive_segmentation.task bundle that is not at the usual
    # model address; without it the point-to-mask step is skipped.
    touch = None
    print("interactive segmenter not run:", str(err).splitlines()[0][:160])

# selfie_multiclass_256x256 labels, in order.
CLASS_NAMES = ["background", "hair", "body skin", "face skin", "clothes", "accessories"]
CLASS_COLOURS = [(0, 0, 0, 0), (250, 210, 60, 255), (240, 150, 110, 255), (255, 200, 170, 255), (80, 140, 255, 255), (90, 220, 140, 255)]
# A point on the part worth cutting out, as fractions of the sprite (read off each drawing).
TOUCH = {"cape256": (0.30, 0.62), "mage128": (0.36, 0.55), "knight128": (0.40, 0.50), "adventurer64": (0.27, 0.22)}


def prepared(sprite):
    scale = max(1, 512 // sprite.width)
    flat = Image.new("RGBA", sprite.size, (255, 255, 255, 255))
    flat.alpha_composite(sprite)
    big = flat.convert("RGB").resize((sprite.width * scale, sprite.height * scale), Image.NEAREST)
    return big, mp.Image(image_format=mp.ImageFormat.SRGB, data=np.asarray(big))


def mask_png(mask, size, colours):
    small = Image.fromarray(mask.astype(np.uint8)).resize(size, Image.NEAREST)
    a = np.asarray(small)
    rgba = np.zeros((size[1], size[0], 4), np.uint8)
    for value, colour in enumerate(colours):
        rgba[a == value] = colour
    return Image.fromarray(rgba, "RGBA")


results = {"mediapipe": mp.__version__, "sprites": {}}
for path in sorted(glob.glob(os.path.join(HERE, "sprites", "*.png"))):
    name = os.path.splitext(os.path.basename(path))[0]
    sprite = Image.open(path).convert("RGBA")
    size = sprite.width
    big, image = prepared(sprite)
    row = {"size": size, "input": list(big.size)}
    px = lambda lm: [round(lm.x * size, 2), round(lm.y * size, 2)]

    p = pose.detect(image)
    if p.pose_landmarks:
        row["pose"] = [px(lm) + [round(lm.visibility, 3)] for lm in p.pose_landmarks[0]]
        row["pose_world"] = [[round(lm.x, 3), round(lm.y, 3), round(lm.z, 3)] for lm in p.pose_world_landmarks[0]]
        body = np.squeeze(p.segmentation_masks[0].numpy_view()) > 0.5
        sprite_alpha = np.asarray(sprite.split()[-1].resize(big.size, Image.NEAREST)) > 0
        row["body_mask_share_of_sprite"] = round(float((body & sprite_alpha).sum() / max(1, sprite_alpha.sum())), 3)

    h = holistic.detect(image)
    row["holistic"] = {
        "pose": len(h.pose_landmarks) if h.pose_landmarks else 0,
        "left_hand": len(h.left_hand_landmarks) if h.left_hand_landmarks else 0,
        "right_hand": len(h.right_hand_landmarks) if h.right_hand_landmarks else 0,
        "face": len(h.face_landmarks) if h.face_landmarks else 0,
    }

    seg = np.squeeze(classes.segment(image).category_mask.numpy_view())
    mask_png(seg, sprite.size, CLASS_COLOURS).save(os.path.join(OUT, f"{name}-classes.png"))
    alpha = np.asarray(sprite.split()[-1]) > 0
    small = np.asarray(Image.fromarray(seg.astype(np.uint8)).resize(sprite.size, Image.NEAREST))
    row["classes"] = {CLASS_NAMES[v]: round(float(((small == v) & alpha).sum() / alpha.sum()), 3) for v in range(1, 6)}

    if touch is not None and name in TOUCH:
        x, y = TOUCH[name]
        roi = vision.InteractiveSegmenterRegionOfInterest(
            format=vision.InteractiveSegmenterRegionOfInterest.Format.KEYPOINT,
            keypoint=containers.keypoint.NormalizedKeypoint(x, y))
        res = touch.segment(image, roi)
        # 1.2.3 returns a result with confidence masks; take the first, thresholded.
        if getattr(res, "category_mask", None) is not None:
            t = res.category_mask.numpy_view() > 0
        else:
            masks = getattr(res, "confidence_masks", None) or res
            t = masks[0].numpy_view() > 0.5
        t = t.astype(np.uint8)
        mask_png(t, sprite.size, [(0, 0, 0, 0), (255, 90, 200, 255)]).save(os.path.join(OUT, f"{name}-touch.png"))
        row["touch"] = {"point": [x, y], "pixels": int((np.asarray(Image.fromarray(t.astype(np.uint8)).resize(sprite.size, Image.NEAREST)) > 0).sum())}
    results["sprites"][name] = row

json.dump(results, open(os.path.join(HERE, "mediapipe.json"), "w"), indent=1)
for name, r in results["sprites"].items():
    print(name, r["size"], "pose" if "pose" in r else "NO POSE", r["holistic"], r["classes"], r.get("touch", ""))
