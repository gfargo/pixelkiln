"""Render the pose-to-frame benchmark through a running ComfyUI (issue #79).

Lanes, each over every motion in poses/ (idle 4, walk 8, attack 4) for each character:
  A        prompt only: no ControlNet, the seed stepped by one per frame, to show how far
           identity and pose drift without structural control.
  B-0.55   OpenPose ControlNet at strength 0.55, fixed seed.
  B-0.75   the same at 0.75 (the smoke test's setting).
  B-0.90   the same at 0.90.
  repeat   B-0.75 for the first character's walk, rendered a second time, to record whether
           the same inputs give the same bytes.
  S        sheet: one render per motion from poses/sheets/<motion>.png, every frame of the loop
           in one image (a row of four 384x640 cells; the walk is two rows), so the model draws
           one character once. Saved as sheet.png; split it into frames afterwards.
  S-1.5    the same sheet on a canvas 1.5x or 2x larger in each direction (ComfyUI scales the
  S-2      pose sheet to fit), to see whether a larger canvas gives finer pixels.
  I-0.6    reference: B-0.75 plus IP-Adapter Plus (SDXL, ViT-H) fed the character's keyframe at
  I-0.9    weight 0.6 or 0.9, so each frame is drawn fresh to its pose but steered toward the
           keyframe's look. Needs the ComfyUI_IPAdapter_plus nodes and both models below.
  SH       the S sheet, then a hires pass: the latent enlarged 1.5x and redrawn at denoise 0.5
           with the same pose control, so the layout and character come from the 1x render and
           only the detail from the larger one.
  SI       the S sheet plus IP-Adapter at 0.6 fed the keyframe, so every motion's sheet is
           steered toward the same character.
  IC       in-context sheet: one row of five cells, the keyframe fixed in cell 0 and four frames
           drawn beside it (inputs from poses/make-incontext-sheets.py; the walk is two renders).
           The latent noise is masked to cells 1-4, so the model sees the finished character at
           every step. Saved as chunk-N.png.
  ICI      IC plus IP-Adapter at 0.6.
  L        B-0.75 plus the character's own LoRA (train-lora.py) at 0.8, with its trigger
           word (pxk<character>) in the prompt.
  LI       L plus IP-Adapter at 0.6 fed the keyframe.
  LSI      the S sheet plus the LoRA and IP-Adapter at 0.6.
  L-0.6    L with the LoRA at 0.6 or 0.5, LI with it at 0.6: does a weaker LoRA let the pose
  L-0.5    move the figure again?
  LI-0.6
  LE2      L with the checkpoint kohya saved after epoch 2 or 4 of 6 (installed as
  LE4      pxk-<character>-e2/-e4), at 0.8: is an earlier, less fitted LoRA freer?
  LE4-P0.9   LE4 with the pose ControlNet at 0.9 or 1.0 instead of 0.75, and L-0.5 with it
  LE4-P1.0   at 1.0: does a stronger pose control give a full stride?
  L-0.5-P1.0
  LE4-W      LE4, LE4-P1.0 and L-0.5 on the exaggerated walk maps in poses/walk-wide/
  LE4-W-P1.0 (longer stride, higher knee, more arm swing, a bob); saved under walk/.
  L-0.5-W
  LW-W       run 8: the LoRA retrained with run 7's best wide-walk frames added (train-lora.py
  LWE4-W     --set w), final and epoch 4, on the wide walk maps; LW-W also renders idle and
             attack on their usual maps.
  LW-A       run 9: LW-W with the exaggerated attack maps in poses/attack-wide/ (sword arm
  LW-A-P1.0  overhead, then straight out, a longer lunge), at pose 0.75 and 1.0.
  LW-AP-0.5  run 10: LW-A plus the weapon drawn as white strokes (poses/attack-wide-prop-
  LW-AP-0.8  <character>/) through the union ControlNet's scribble mode at 0.5 or 0.8.
  CW-s1..3   run 11 candidates: LoRA at 0.5, prop at 0.9, seeds 1-3, to harvest swing frames.
  LWS-A      run 11: the -w-s LoRA (wide walk plus four swing frames), without and with
  LWS-AP-0.8 the prop control at 0.8.
  K-0.55   keyframe: every frame starts from the character's keyframe (--keyframes
  K-0.70   <dir>/<character>.png) encoded as the latent, redrawn at denoise 0.55 or 0.70 with
           the pose ControlNet at 0.90, so colours, props and proportions carry over.

Everything else is workflow-pose-api.json as committed: SDXL base, Pixel Art XL 0.85, 32
steps, cfg 6, dpmpp_2m/karras, 1024x1024. Uses only ComfyUI's HTTP API and only Python's
standard library, so it runs beside ComfyUI on any machine.

  python run-benchmark.py --host http://127.0.0.1:8188 --out runs/<name> [--lanes A,B-0.75] [--characters knight]

Writes <out>/<lane>/<character>/<motion>/frame-NN.png, and <out>/runs.json with each render's
seed, strength, prompt, seconds and output sha256. Skips frames already on disk, so a stopped
run can be started again.
"""
import argparse
import copy
import hashlib
import json
import os
import sys
import time
import urllib.parse
import urllib.request
import uuid

HERE = os.path.dirname(os.path.abspath(__file__))
SEED = 31415
CHARACTERS = {
    "knight": "pixel art, full body side view of a knight in steel armor with a red cape and a sword, facing right, plain flat grey background, game sprite",
    "goblin": "pixel art, full body side view of a small green goblin with big pointed ears, a leather vest and a wooden club, facing right, plain flat grey background, game sprite",
}
MOTIONS = ["idle", "walk", "attack"]
LANES = {"A": None, "B-0.55": 0.55, "B-0.75": 0.75, "B-0.90": 0.90}
KEYFRAME_LANES = {"K-0.55": 0.55, "K-0.70": 0.70, "K-0.85": 0.85}
REFERENCE_LANES = {"I-0.6": 0.6, "I-0.9": 0.9}
IPADAPTER_FILE = "ip-adapter-plus_sdxl_vit-h.safetensors"
CLIP_VISION_FILE = "CLIP-ViT-H-14-laion2B-s32B-b79K.safetensors"
IC_IP_WEIGHT = 0.6  # lanes SI and ICI: run 2's best balance of identity and pose
# lanes L, LI, LSI: the character LoRA from train-lora.py, in ComfyUI's loras folder
# run 5 lanes: a lower strength, or the checkpoint kohya saved after epoch 2 or 4 of 6
LORA_LANES = {"L": {}, "LI": {"ip": True}, "LSI": {"ip": True, "sheet": True},
              "L-0.6": {"strength": 0.6}, "L-0.5": {"strength": 0.5}, "LI-0.6": {"ip": True, "strength": 0.6},
              "LE2": {"epoch": 2}, "LE4": {"epoch": 4},
              # run 6: the pose ControlNet raised from 0.75
              "LE4-P0.9": {"epoch": 4, "pose": 0.9}, "LE4-P1.0": {"epoch": 4, "pose": 1.0},
              "L-0.5-P1.0": {"strength": 0.5, "pose": 1.0},
              # run 7: the exaggerated walk maps (poses/walk-wide/); render with --motions walk
              "LE4-W": {"epoch": 4, "poses": {"walk": "walk-wide"}},
              "LE4-W-P1.0": {"epoch": 4, "pose": 1.0, "poses": {"walk": "walk-wide"}},
              "L-0.5-W": {"strength": 0.5, "poses": {"walk": "walk-wide"}},
              # run 8: LoRAs retrained with run 7's wide-walk frames added (train-lora.py --set w)
              "LW-W": {"set": "w", "poses": {"walk": "walk-wide"}},
              "LWE4-W": {"set": "w", "epoch": 4, "poses": {"walk": "walk-wide"}},
              # run 9: the exaggerated attack maps (poses/attack-wide/); render with --motions attack
              "LW-A": {"set": "w", "poses": {"walk": "walk-wide", "attack": "attack-wide"}},
              "LW-A-P1.0": {"set": "w", "pose": 1.0, "poses": {"walk": "walk-wide", "attack": "attack-wide"}},
              # run 10: plus the weapon drawn in poses/attack-wide-prop-<character>/, at 0.5 or 0.8
              "LW-AP-0.5": {"set": "w", "prop": 0.5, "poses": {"walk": "walk-wide", "attack": "attack-wide"}},
              "LW-AP-0.8": {"set": "w", "prop": 0.8, "poses": {"walk": "walk-wide", "attack": "attack-wide"}},
              # run 11 candidates for training frames with the weapon swung: the LoRA looser (0.5),
              # the weapon control stronger (0.9), three seeds; frames are picked by eye
              **{f"CW-s{n}": {"set": "w", "strength": 0.5, "prop": 0.9, "seed": n, "poses": {"attack": "attack-wide"}}
                 for n in (1, 2, 3)},
              # run 11: the knight's LoRA retrained with swung-sword frames added (train-lora.py --set w,s)
              "LWS-AP-0.8": {"set": "w-s", "prop": 0.8, "poses": {"attack": "attack-wide"}},
              "LWS-A": {"set": "w-s", "poses": {"attack": "attack-wide"}}}
UNION_CONTROLNET = "controlnet-union-sdxl-promax.safetensors"
CHAR_LORA = "pixelkiln\\pxk-{character}{suffix}.safetensors"
CHAR_LORA_STRENGTH = 0.8


def prop_control(host, lane, character, motion, pose):
    """The uploaded weapon image and strength for a lane with "prop", else None."""
    spec = LORA_LANES[lane]
    if "prop" not in spec:
        return None
    folder = spec.get("poses", {}).get(motion, motion) + f"-prop-{character}"
    return upload(host, os.path.join(HERE, "poses", folder, pose)), spec["prop"]


def lane_lora(lane, character):
    spec = LORA_LANES[lane]
    suffix = (f"-{spec['set']}" if "set" in spec else "") + (f"-e{spec['epoch']}" if "epoch" in spec else "")
    name = CHAR_LORA.format(character=character, suffix=suffix)
    return name, spec.get("strength", CHAR_LORA_STRENGTH)
HIRES_SCALE = 1.5
HIRES_DENOISE = 0.5
HIRES_STEPS = 24
KEYFRAME_STRENGTH = 0.90
SHEET_NEGATIVE = ("photograph, photorealistic, 3d render, text, watermark, blurry, soft focus, gradients, "
                  "cropped, different characters, inconsistent design, scenery, frame borders, grid lines")


def sheet_prompt(prompt, frames):
    # "pixel art, full body side view of a knight ..." -> a sheet of the same character
    subject = prompt.split("full body side view of ", 1)[1].split(", facing right")[0]
    return (f"pixel art, sprite sheet of {frames} animation frames of the same character, {subject}, "
            "every frame full body side view facing right, identical design and colours in every frame, "
            "evenly spaced, plain flat grey background, game sprite")


def request(host, path, data=None, headers=None):
    req = urllib.request.Request(host + path, data=data, headers=headers or {})
    with urllib.request.urlopen(req, timeout=600) as res:
        return res.read()


def upload(host, path):
    boundary = uuid.uuid4().hex
    name = "pixelkiln-" + "-".join(path.replace("\\", "/").split("/")[-2:])
    body = (
        f"--{boundary}\r\nContent-Disposition: form-data; name=\"image\"; filename=\"{name}\"\r\nContent-Type: image/png\r\n\r\n"
    ).encode() + open(path, "rb").read() + f"\r\n--{boundary}\r\nContent-Disposition: form-data; name=\"overwrite\"\r\n\r\ntrue\r\n--{boundary}--\r\n".encode()
    return json.loads(request(host, "/upload/image", body, {"Content-Type": f"multipart/form-data; boundary={boundary}"}))["name"]


def graph(prompt, pose_name, strength, seed, size=None, negative=None, keyframe=None, denoise=None, hires=False, reference=None, ip_weight=None, incontext=None, char_lora=None, trigger=None, lora_strength=CHAR_LORA_STRENGTH, prop=None):
    w = copy.deepcopy(json.load(open(os.path.join(HERE, "workflow-pose-api.json"))))
    w["6"]["inputs"]["text"] = prompt.replace("pixel art, ", f"pixel art, {trigger}, ", 1) if trigger else prompt
    if negative:
        w["7"]["inputs"]["text"] = negative
    if size:
        w["5"]["inputs"]["width"], w["5"]["inputs"]["height"] = size
    if incontext:
        # the keyframe stays fixed in cell 0; noise, and so new drawing, only where the mask is white
        image, mask = incontext
        w["60"] = {"class_type": "LoadImage", "inputs": {"image": image}}
        w["61"] = {"class_type": "VAEEncode", "inputs": {"pixels": ["60", 0], "vae": ["4", 2]}}
        w["62"] = {"class_type": "LoadImageMask", "inputs": {"image": mask, "channel": "red"}}
        w["63"] = {"class_type": "SetLatentNoiseMask", "inputs": {"samples": ["61", 0], "mask": ["62", 0]}}
        w["3"]["inputs"]["latent_image"] = ["63", 0]
        del w["5"]
    if keyframe:
        # img2img: the keyframe, encoded, replaces the empty latent
        w["30"] = {"class_type": "LoadImage", "inputs": {"image": keyframe}}
        w["31"] = {"class_type": "VAEEncode", "inputs": {"pixels": ["30", 0], "vae": ["4", 2]}}
        w["3"]["inputs"]["latent_image"] = ["31", 0]
        w["3"]["inputs"]["denoise"] = denoise
        del w["5"]
    w["3"]["inputs"]["seed"] = seed
    if reference:
        w["50"] = {"class_type": "IPAdapterModelLoader", "inputs": {"ipadapter_file": IPADAPTER_FILE}}
        w["51"] = {"class_type": "CLIPVisionLoader", "inputs": {"clip_name": CLIP_VISION_FILE}}
        w["52"] = {"class_type": "LoadImage", "inputs": {"image": reference}}
        w["53"] = {"class_type": "IPAdapterAdvanced", "inputs": {
            "model": ["10", 0], "ipadapter": ["50", 0], "image": ["52", 0], "clip_vision": ["51", 0],
            "weight": ip_weight, "weight_type": "linear", "combine_embeds": "concat",
            "start_at": 0.0, "end_at": 1.0, "embeds_scaling": "V only"}}
        w["3"]["inputs"]["model"] = ["53", 0]
    if hires:
        w["40"] = {"class_type": "LatentUpscaleBy",
                   "inputs": {"samples": ["3", 0], "upscale_method": "nearest-exact", "scale_by": HIRES_SCALE}}
        w["41"] = {"class_type": "KSampler", "inputs": {**w["3"]["inputs"], "latent_image": ["40", 0],
                   "denoise": HIRES_DENOISE, "steps": HIRES_STEPS}}
        w["8"]["inputs"]["samples"] = ["41", 0]
    if char_lora:
        # the character's LoRA after Pixel Art XL: everything that read node 10 reads node 11
        for node in w.values():
            for key, value in node["inputs"].items():
                if isinstance(value, list) and value[0] == "10":
                    node["inputs"][key] = ["11", value[1]]
        w["11"] = {"class_type": "LoraLoader", "inputs": {"model": ["10", 0], "clip": ["10", 1], "lora_name": char_lora,
                                                         "strength_model": lora_strength, "strength_clip": lora_strength}}
    w["9"]["inputs"]["filename_prefix"] = "pixelkiln/bench"
    if pose_name is None:
        # Prompt only: the sampler takes the text conditioning straight, and the pose nodes go.
        w["3"]["inputs"]["positive"] = ["6", 0]
        w["3"]["inputs"]["negative"] = ["7", 0]
        for node in ("20", "21", "22"):
            del w[node]
    else:
        w["20"]["inputs"]["image"] = pose_name
        w["22"]["inputs"]["strength"] = strength
    if prop:
        # run 10: the weapon as white strokes, through the union ControlNet's scribble mode,
        # chained after the pose ControlNet
        prop_name, prop_strength = prop
        w["23"] = {"class_type": "LoadImage", "inputs": {"image": prop_name}}
        w["24"] = {"class_type": "ControlNetLoader", "inputs": {"control_net_name": UNION_CONTROLNET}}
        w["25"] = {"class_type": "SetUnionControlNetType", "inputs": {"control_net": ["24", 0], "type": "hed/pidi/scribble/ted"}}
        w["26"] = {"class_type": "ControlNetApplyAdvanced", "inputs": {
            "positive": ["22", 0], "negative": ["22", 1], "control_net": ["25", 0], "image": ["23", 0], "vae": ["4", 2],
            "strength": prop_strength, "start_percent": 0.0, "end_percent": 1.0}}
        w["3"]["inputs"]["positive"] = ["26", 0]
        w["3"]["inputs"]["negative"] = ["26", 1]
    return w


def render(host, workflow):
    started = time.time()
    res = json.loads(request(host, "/prompt", json.dumps({"prompt": workflow}).encode(), {"Content-Type": "application/json"}))
    if res.get("node_errors"):
        raise RuntimeError(f"ComfyUI refused the graph: {res['node_errors']}")
    pid = res["prompt_id"]
    while True:
        history = json.loads(request(host, f"/history/{pid}"))
        if pid in history:
            entry = history[pid]
            if entry.get("status", {}).get("status_str") == "error":
                raise RuntimeError(f"ComfyUI failed: {entry['status']}")
            image = [img for out in entry["outputs"].values() for img in out.get("images", [])][0]
            query = urllib.parse.urlencode({"filename": image["filename"], "subfolder": image["subfolder"], "type": image["type"]})
            return request(host, f"/view?{query}"), round(time.time() - started, 1)
        time.sleep(1)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--host", default="http://127.0.0.1:8188")
    parser.add_argument("--out", required=True)
    parser.add_argument("--lanes", default=",".join(list(LANES) + ["repeat"]))
    parser.add_argument("--characters", default=",".join(CHARACTERS))
    parser.add_argument("--keyframes", help="folder with <character>.png, for the K lanes")
    parser.add_argument("--motions", default=",".join(MOTIONS))
    args = parser.parse_args()
    os.makedirs(args.out, exist_ok=True)
    log_path = os.path.join(args.out, "runs.json")
    runs = json.load(open(log_path)) if os.path.exists(log_path) else []
    stats = json.loads(request(args.host, "/system_stats"))
    print("ComfyUI", stats["system"].get("comfyui_version"), [d["name"] for d in stats.get("devices", [])], flush=True)

    jobs = []
    for lane in args.lanes.split(","):
        if lane == "repeat":
            first = args.characters.split(",")[0]
            jobs.append(("repeat", 0.75, first, "walk"))
            continue
        for character in args.characters.split(","):
            for motion in args.motions.split(","):
                jobs.append((lane, None if lane.startswith(("S", "IC")) or lane == "LSI" else LORA_LANES[lane].get("pose", 0.75) if lane in LORA_LANES else {**LANES, **KEYFRAME_LANES, **REFERENCE_LANES}[lane], character, motion))

    for lane, strength, character, motion in jobs:
        if lane.startswith("IC"):
            folder = os.path.join(HERE, "poses", "incontext")
            chunks = sorted(f for f in os.listdir(folder) if f.startswith(motion + "-") and f.endswith("-pose.png"))
            reference = upload(args.host, os.path.join(args.keyframes, f"{character}.png")) if lane == "ICI" else None
            for chunk in range(len(chunks)):
                target = os.path.join(args.out, lane, character, motion, f"chunk-{chunk}.png")
                if os.path.exists(target):
                    continue
                os.makedirs(os.path.dirname(target), exist_ok=True)
                stem = os.path.join(folder, f"{character}-{motion}-{chunk}")
                incontext = (upload(args.host, stem + "-image.png"), upload(args.host, stem + "-mask.png"))
                pose = upload(args.host, os.path.join(folder, f"{motion}-{chunk}-pose.png"))
                png, seconds = render(args.host, graph(sheet_prompt(CHARACTERS[character], 5), pose, 0.75, SEED,
                                                       negative=SHEET_NEGATIVE, incontext=incontext,
                                                       reference=reference, ip_weight=IC_IP_WEIGHT if reference else None))
                open(target, "wb").write(png)
                runs.append({"lane": lane, "character": character, "motion": motion, "frame": f"chunk-{chunk}.png",
                             "seed": SEED, "strength": 0.75, "size": [1920, 640],
                             **({"ipadapterWeight": IC_IP_WEIGHT} if reference else {}),
                             "seconds": seconds, "sha256": hashlib.sha256(png).hexdigest()})
                json.dump(runs, open(log_path, "w"), indent=1)
                print(f"{lane} {character} {motion} chunk-{chunk} {seconds}s", flush=True)
            continue
        if lane.startswith("S") or lane == "LSI":
            target = os.path.join(args.out, lane, character, motion, "sheet.png")
            if os.path.exists(target):
                continue
            os.makedirs(os.path.dirname(target), exist_ok=True)
            frames = len([f for f in os.listdir(os.path.join(HERE, "poses", motion)) if f.endswith(".png")])
            sheet = os.path.join(HERE, "poses", "sheets", f"{motion}.png")
            with open(sheet, "rb") as fh:
                head = fh.read(24)
            scale = float(lane[2:]) if lane.startswith("S-") else 1.0  # SH renders at 1x, then the hires pass
            size = tuple(int(int.from_bytes(head[i:i + 4], "big") * scale) // 64 * 64 for i in (16, 20))  # PNG IHDR
            reference = upload(args.host, os.path.join(args.keyframes, f"{character}.png")) if lane in ("SI", "LSI") else None
            lora = dict(zip(("char_lora", "lora_strength"), lane_lora(lane, character)), trigger=f"pxk{character}") if lane == "LSI" else {}
            png, seconds = render(args.host, graph(sheet_prompt(CHARACTERS[character], frames), upload(args.host, sheet),
                                                   0.75, SEED, size=size, negative=SHEET_NEGATIVE, hires=lane == "SH",
                                                   reference=reference, ip_weight=IC_IP_WEIGHT if reference else None, **lora))
            open(target, "wb").write(png)
            runs.append({"lane": lane, "character": character, "motion": motion, "frame": "sheet.png", **({"lora": lora["char_lora"], "loraStrength": lora["lora_strength"]} if lora else {}), "seed": SEED,
                         "strength": 0.75, "size": list(size), **({"ipadapterWeight": IC_IP_WEIGHT} if reference else {}),
                         **({"hires": {"scale": HIRES_SCALE, "denoise": HIRES_DENOISE, "steps": HIRES_STEPS}} if lane == "SH" else {}), "seconds": seconds, "sha256": hashlib.sha256(png).hexdigest()})
            json.dump(runs, open(log_path, "w"), indent=1)
            print(f"{lane} {character} {motion} sheet {size[0]}x{size[1]} {seconds}s", flush=True)
            continue
        keyframe = None
        if lane in KEYFRAME_LANES or lane in REFERENCE_LANES or LORA_LANES.get(lane, {}).get("ip"):
            keyframe = upload(args.host, os.path.join(args.keyframes, f"{character}.png"))
        # a W lane reads walk-wide/ for the walk, and still saves under walk/
        pose_dir = os.path.join(HERE, "poses", LORA_LANES.get(lane, {}).get("poses", {}).get(motion, motion))
        poses = sorted(f for f in os.listdir(pose_dir) if f.endswith(".png"))
        for index, pose in enumerate(poses):
            target = os.path.join(args.out, lane, character, motion, pose)
            if os.path.exists(target):
                continue
            os.makedirs(os.path.dirname(target), exist_ok=True)
            seed = SEED + index if lane == "A" else SEED + LORA_LANES.get(lane, {}).get("seed", 0)
            pose_name = upload(args.host, os.path.join(pose_dir, pose)) if lane != "A" else None
            if lane in LORA_LANES:
                lora_name, lora_strength = lane_lora(lane, character)
                png, seconds = render(args.host, graph(CHARACTERS[character], pose_name, strength, seed,
                                                       reference=keyframe, ip_weight=IC_IP_WEIGHT if keyframe else None,
                                                       char_lora=lora_name, lora_strength=lora_strength, trigger=f"pxk{character}",
                                                       prop=prop_control(args.host, lane, character, motion, pose)))
            elif lane in REFERENCE_LANES:
                png, seconds = render(args.host, graph(CHARACTERS[character], pose_name, 0.75, seed,
                                                       reference=keyframe, ip_weight=strength))
            elif keyframe:
                png, seconds = render(args.host, graph(CHARACTERS[character], pose_name, KEYFRAME_STRENGTH, seed,
                                                       keyframe=keyframe, denoise=strength))
            else:
                png, seconds = render(args.host, graph(CHARACTERS[character], pose_name, strength, seed))
            open(target, "wb").write(png)
            runs.append({"lane": lane, "character": character, "motion": motion, "frame": pose, "seed": seed,
                         "strength": 0.75 if lane in REFERENCE_LANES else strength if lane in LORA_LANES else KEYFRAME_STRENGTH if keyframe else strength,
                         **({"lora": lane_lora(lane, character)[0], "loraStrength": lane_lora(lane, character)[1], **({"ipadapterWeight": IC_IP_WEIGHT} if keyframe else {})} if lane in LORA_LANES else {"ipadapterWeight": strength} if lane in REFERENCE_LANES else {"denoise": strength} if keyframe else {}),
                         "seconds": seconds, "sha256": hashlib.sha256(png).hexdigest()})
            json.dump(runs, open(log_path, "w"), indent=1)
            print(f"{lane} {character} {motion} {pose} {seconds}s", flush=True)


if __name__ == "__main__":
    sys.exit(main())
