"""Render the pose-to-frame benchmark through a running ComfyUI (issue #79).

Lanes, each over every motion in poses/ (idle 4, walk 8, attack 4) for each character:
  A        prompt only: no ControlNet, the seed stepped by one per frame, to show how far
           identity and pose drift without structural control.
  B-0.55   OpenPose ControlNet at strength 0.55, fixed seed.
  B-0.75   the same at 0.75 (the smoke test's setting).
  B-0.90   the same at 0.90.
  repeat   B-0.75 for the first character's walk, rendered a second time, to record whether
           the same inputs give the same bytes.

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


def graph(prompt, pose_name, strength, seed):
    w = copy.deepcopy(json.load(open(os.path.join(HERE, "workflow-pose-api.json"))))
    w["6"]["inputs"]["text"] = prompt
    w["3"]["inputs"]["seed"] = seed
    w["9"]["inputs"]["filename_prefix"] = "pixelkiln/bench"
    if strength is None:
        # Prompt only: the sampler takes the text conditioning straight, and the pose nodes go.
        w["3"]["inputs"]["positive"] = ["6", 0]
        w["3"]["inputs"]["negative"] = ["7", 0]
        for node in ("20", "21", "22"):
            del w[node]
    else:
        w["20"]["inputs"]["image"] = pose_name
        w["22"]["inputs"]["strength"] = strength
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
            for motion in MOTIONS:
                jobs.append((lane, LANES[lane], character, motion))

    for lane, strength, character, motion in jobs:
        poses = sorted(f for f in os.listdir(os.path.join(HERE, "poses", motion)) if f.endswith(".png"))
        for index, pose in enumerate(poses):
            target = os.path.join(args.out, lane, character, motion, pose)
            if os.path.exists(target):
                continue
            os.makedirs(os.path.dirname(target), exist_ok=True)
            seed = SEED + index if strength is None else SEED
            pose_name = upload(args.host, os.path.join(HERE, "poses", motion, pose)) if strength is not None else None
            png, seconds = render(args.host, graph(CHARACTERS[character], pose_name, strength, seed))
            open(target, "wb").write(png)
            runs.append({"lane": lane, "character": character, "motion": motion, "frame": pose, "seed": seed,
                         "strength": strength, "seconds": seconds, "sha256": hashlib.sha256(png).hexdigest()})
            json.dump(runs, open(log_path, "w"), indent=1)
            print(f"{lane} {character} {motion} {pose} {seconds}s", flush=True)


if __name__ == "__main__":
    sys.exit(main())
