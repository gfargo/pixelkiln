"""Train a character LoRA with kohya sd-scripts, on a GPU that a ComfyUI shares, once it is idle.

  python train-lora.py --character knight --data H:/pixelkiln-comfy/lora/data \
      --out H:/pixelkiln-comfy/lora/out --loras F:/ComfyUI-Shared/models/loras/pixelkiln \
      [--set w] [--wait-idle 600] [--max-steps 0] [--host http://127.0.0.1:8188]

Steps:
  1. Wait until ComfyUI's queue is empty and the GPU is under 10% busy for --wait-idle
     seconds in a row (checked every 30 s), so the training never takes the card from a
     render someone is waiting on.
  2. Ask ComfyUI to unload its cached models (POST /free). The server keeps running.
  3. Write a kohya config and run sdxl_train_network.py: SDXL base with Pixel Art XL at
     0.85 merged in (--base_weights), the same stack the benchmark renders with, so the
     LoRA only has to learn the character. UNet only, rank 16, AdamW8bit, bf16, latents and
     text-encoder outputs cached: settings that fit SDXL in 12 GB.
  4. Copy the finished LoRA into --loras, where ComfyUI's LoraLoader finds it.

--data holds lora/pixelkiln-lora-<character>/ from this benchmark (512x1024 crops of frames
that match the keyframe, each with a caption starting with the trigger word pxk<character>).
--set w adds lora/pixelkiln-lora-<character>-w/ (run 7's wide-walk frames, 832x1024 crops)
to the base set and names the LoRA pxk-<character>-w; --set w,s also adds -s/ (run 11's
frames with the weapon swung) as pxk-<character>-w-s. Kohya buckets by size without
upscaling, so the 512x1024 and 832x1024 crops both train at their own pixel scale.
Python standard library only; run it with the kohya venv's interpreter.
"""
import argparse
import json
import os
import shutil
import subprocess
import sys
import time
import urllib.request

KOHYA = "C:/kohya/sd-scripts"
CHECKPOINT = "F:/ComfyUI-Shared/models/checkpoints/sd_xl_base_1.0.safetensors"
STYLE_LORA = "F:/ComfyUI-Shared/models/loras/pixel-art-xl.safetensors"
REPEATS = 10
EPOCHS = 6
EXTRA_REPEATS = {"s": 30}  # run 11's four swung-sword frames

CONFIG = """pretrained_model_name_or_path = "{checkpoint}"
base_weights = ["{style}"]
base_weights_multiplier = [0.85]
train_data_dir = "{img}"
output_dir = "{out}"
output_name = "{name}"
save_model_as = "safetensors"
resolution = "832,1024"
enable_bucket = true
bucket_no_upscale = true
min_bucket_reso = 256
max_bucket_reso = 1024
bucket_reso_steps = 64
caption_extension = ".txt"
network_module = "networks.lora"
network_dim = 16
network_alpha = 8
network_train_unet_only = true
cache_text_encoder_outputs = true
cache_latents = true
learning_rate = 1e-4
unet_lr = 1e-4
lr_scheduler = "cosine"
lr_warmup_steps = 50
optimizer_type = "AdamW8bit"
train_batch_size = 1
{length}
save_every_n_epochs = 2
mixed_precision = "bf16"
save_precision = "bf16"
gradient_checkpointing = true
sdpa = true
max_data_loader_n_workers = 0
seed = 31415
"""


def comfy(host, path, body=None):
    req = urllib.request.Request(host + path, data=json.dumps(body).encode() if body is not None else None,
                                 headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=60) as res:
        text = res.read()
    return json.loads(text) if text.strip() else None


def gpu_busy():
    out = subprocess.run(["nvidia-smi", "--query-gpu=utilization.gpu", "--format=csv,noheader,nounits"],
                         capture_output=True, text=True).stdout
    return int(out.strip().splitlines()[0])


def wait_idle(host, seconds):
    quiet = 0
    while quiet < seconds:
        queue = comfy(host, "/queue")
        busy = gpu_busy()
        idle = not queue["queue_running"] and not queue["queue_pending"] and busy < 10
        quiet = quiet + 30 if idle else 0
        print(time.strftime("%H:%M:%S"), "idle" if idle else "busy", f"gpu {busy}%", f"quiet {quiet}s", flush=True)
        if quiet < seconds:
            time.sleep(30)


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--character", required=True)
    p.add_argument("--data", required=True)
    p.add_argument("--out", required=True)
    p.add_argument("--loras", required=True)
    p.add_argument("--host", default="http://127.0.0.1:8188")
    p.add_argument("--wait-idle", type=int, default=600)
    p.add_argument("--set", default="", help="extra training sets to add, comma-separated, e.g. w or w,s")
    p.add_argument("--max-steps", type=int, default=0, help="stop early, for a speed check")
    a = p.parse_args()
    name = f"pxk-{a.character}" + ("".join(f"-{x}" for x in a.set.split(",")) if a.set else "") + (f"-smoke{a.max_steps}" if a.max_steps else "")
    trigger = f"pxk{a.character}"
    img = os.path.join(a.out, name, "img")
    shutil.rmtree(img, ignore_errors=True)
    shutil.copytree(os.path.join(a.data, f"pixelkiln-lora-{a.character}"), os.path.join(img, f"{REPEATS}_{trigger}"))
    for extra in a.set.split(",") if a.set else []:
        # a small set gets more repeats in its own folder, so a few frames still count
        shutil.copytree(os.path.join(a.data, f"pixelkiln-lora-{a.character}-{extra}"),
                        os.path.join(img, f"{EXTRA_REPEATS.get(extra, REPEATS)}_{trigger}"), dirs_exist_ok=True)
    config = os.path.join(a.out, name, "train.toml")
    with open(config, "w") as fh:
        fh.write(CONFIG.format(checkpoint=CHECKPOINT, style=STYLE_LORA, img=img.replace("\\", "/"),
                               out=os.path.join(a.out, name).replace("\\", "/"), name=name,
                               # kohya lets max_train_epochs override max_train_steps, so set only one
                               length=f"max_train_steps = {a.max_steps}" if a.max_steps else f"max_train_epochs = {EPOCHS}"))

    wait_idle(a.host, a.wait_idle)
    comfy(a.host, "/free", {"unload_models": True, "free_memory": True})
    time.sleep(5)
    print("training", name, time.strftime("%H:%M:%S"), flush=True)
    started = time.time()
    with open(os.path.join(a.out, name, "train.log"), "w") as log:
        code = subprocess.call([sys.executable, os.path.join(KOHYA, "sdxl_train_network.py"), "--config_file", config],
                               cwd=KOHYA, stdout=log, stderr=subprocess.STDOUT,
                               # kohya prints Japanese text; a Windows pipe defaults to cp1252
                               env={**os.environ, "PYTHONUTF8": "1", "PYTHONIOENCODING": "utf-8"})
    print("exit", code, f"{time.time() - started:.0f}s", flush=True)
    if code:
        sys.exit(code)
    os.makedirs(a.loras, exist_ok=True)
    final = os.path.join(a.out, name, f"{name}.safetensors")
    shutil.copy(final, os.path.join(a.loras, f"{name}.safetensors"))
    print("copied", os.path.join(a.loras, f"{name}.safetensors"), flush=True)
    for epoch in range(2, EPOCHS, 2):  # kohya's mid-run saves, as <name>-e<epoch> for run 5's lanes
        saved = os.path.join(a.out, name, f"{name}-{epoch:06d}.safetensors")
        if os.path.exists(saved):
            shutil.copy(saved, os.path.join(a.loras, f"{name}-e{epoch}.safetensors"))


if __name__ == "__main__":
    main()
