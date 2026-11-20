# ComfyUI pose-to-frame benchmark (in progress)

Work toward [#79](https://github.com/gfargo/pixelkiln/issues/79): a versioned
ComfyUI recipe that turns an ordered set of pose maps into a pixel-art frame
set, and a benchmark that shows where it works and where it fails. This folder
holds the first slice: the model audit, the pose maps, the generation graph and
a two-frame smoke test. No benchmark result, recipe or quality claim exists yet.

## Model audit

Every file below was hashed on the test machine and matched to its public
source by the SHA-256 that Hugging Face records for it (November 2026). No
weights are committed or downloaded by PixelKiln.

| Role | File (ComfyUI folder) | SHA-256 | Source | License | Commercial output |
|---|---|---|---|---|---|
| SDXL checkpoint | `checkpoints/sd_xl_base_1.0.safetensors` | `31e35c80fc4829d14f90153f4c74cd59c90b779f6afe05a74cd6120b893f7e5b` | [stabilityai/stable-diffusion-xl-base-1.0](https://huggingface.co/stabilityai/stable-diffusion-xl-base-1.0/blob/main/sd_xl_base_1.0.safetensors) | [CreativeML Open RAIL++-M](https://huggingface.co/stabilityai/stable-diffusion-xl-base-1.0/blob/main/LICENSE.md) | Yes. "Licensor claims no rights in the Output"; the use restrictions in its Attachment A apply. |
| Pixel-art LoRA | `loras/pixel-art-xl.safetensors` | `4234637cb80c998f41e348e6a6cb6bc20d8d038b2b0f256b6129b3b5e353eef7` | [nerijs/pixel-art-xl](https://huggingface.co/nerijs/pixel-art-xl/blob/main/pixel-art-xl.safetensors) | CreativeML Open RAIL-M (model card) | Yes, under the same RAIL terms. The card links no license file of its own. |
| Pose ControlNet | `controlnet/controlnet-openpose-sdxl-1.0.safetensors` | `b8524e557a7df60d081f5d4a0eb109967d107df217943bf88c2d99b9ebcc06c5` | [xinsir/controlnet-openpose-sdxl-1.0](https://huggingface.co/xinsir/controlnet-openpose-sdxl-1.0/blob/main/diffusion_pytorch_model.safetensors) (`diffusion_pytorch_model.safetensors`, renamed) | Apache-2.0 | Yes. |
| Alternative ControlNet | `controlnet/controlnet-union-sdxl-promax.safetensors` | `9fae2e50cb431bfcbe05822b59ec2228df545ef27f711dea8949e9f4ed9f7cdc` | [xinsir/controlnet-union-sdxl-1.0](https://huggingface.co/xinsir/controlnet-union-sdxl-1.0/blob/main/diffusion_pytorch_model_promax.safetensors) (`diffusion_pytorch_model_promax.safetensors`, renamed) | Apache-2.0 | Yes. Takes OpenPose among other controls; a candidate if the dedicated model loses identity. |
| SD 1.5 checkpoint | `checkpoints/v1-5-pruned-emaonly-fp16.safetensors` | `e9476a13728cd75d8279f6ec8bad753a66a1957ca375a1464dc63b37db6e3916` | [Comfy-Org/stable-diffusion-1.5](https://huggingface.co/Comfy-Org/stable-diffusion-1.5/blob/main/v1-5-pruned-emaonly-fp16.safetensors) | CreativeML Open RAIL-M | Yes. |

Rejected or not yet available:

- `thibaud/controlnet-openpose-sdxl-1.0` is tagged `license: other` on
  Hugging Face; not used.
- **The SD 1.5 lane is incomplete.** It needs an SD 1.5 OpenPose ControlNet and
  an SD 1.5 pixel-art LoRA whose license allows commercial use, and neither is
  installed. It is set aside until the SDXL lane has results.

The OpenRAIL licenses restrict uses (Attachment A), not ownership of the
output. Whoever ships the art still has to read them for their own case; this
audit records what each file is and where its terms are.

## Pose maps

[`poses/`](poses) holds the varying input: OpenPose maps (18-keypoint body,
`controlnet_aux` colours, no face or hands) at 1024x1024. Each figure is seen
from the side, faces right, and stands on one ground line (y = 900), so scale
and camera do not move between frames or motions.

| Motion | Frames | What changes |
|---|---|---|
| `idle` | 4 | a breath: hips sink and rise 8px, arms sway |
| `walk` | 8 | contact, down, passing, up on each leg; the planted foot stays on the ground |
| `attack` | 4 | wind-up, lunge and strike, follow-through, recover |

`poses/make-poses.py` draws them; the PNGs are what gets reviewed, hashed and
sent, and a wrong limb can be fixed in the script or by hand.
[`poses/sheet.png`](poses/sheet.png) shows all sixteen.

![The sixteen pose maps](poses/sheet.png)

## Generation graph

[`workflow-pose-api.json`](workflow-pose-api.json) is the pose lane (lane B in
#79) in ComfyUI API format, using only ComfyUI's built-in nodes, no custom
nodes: SDXL base, Pixel Art XL at 0.85, `ControlNetLoader` +
`ControlNetApplyAdvanced` (strength 0.75, start 0, end 1), a 1024x1024 empty
latent, `KSampler` (32 steps, cfg 6, `dpmpp_2m` / `karras`, fixed seed 31415),
then save. Its sampler settings are those of the existing
`comfyui/pixel-art-xl-environment@1.0.0` recipe. The pose image, prompt and seed
are the bindings a recipe will expose.

## Smoke test

Two frames, one prompt ("full body side view of a knight in steel armor with a
red cape and a sword, facing right"), seed 31415, strength 0.75:

![Pose maps beside the frames drawn from them, with the skeleton laid over](smoke/pose-vs-frame.png)

- Both frames follow their pose: the walk's passing step and the attack's lunge
  with the sword arm forward. The knight is drawn taller than the skeleton.
- Both read as pixel art at 1024px; nothing is refined to a native grid yet.
- Time: 223s for the first frame (models loading) and 163s for the second, on
  an Apple M1 Max (64 GB, MPS), ComfyUI 0.35.0, PyTorch 2.12.1.

Raw frames: [`smoke/walk-frame-02.png`](smoke/walk-frame-02.png),
[`smoke/attack-frame-01.png`](smoke/attack-frame-01.png).

## Running the benchmark

[`run-benchmark.py`](run-benchmark.py) renders every lane through a ComfyUI
that is already running, using only its HTTP API and Python's standard library:

```bash
python run-benchmark.py --host http://127.0.0.1:8188 --out runs/<name>
python run-benchmark.py --host http://127.0.0.1:8188 --out runs/<name> --lanes B-0.75 --characters knight
```

| Lane | What it renders |
|---|---|
| `A` | prompt only: the ControlNet nodes removed, the seed stepped by one per frame |
| `B-0.55`, `B-0.75`, `B-0.90` | OpenPose ControlNet at that strength, fixed seed 31415 |
| `repeat` | `B-0.75` for the first character's walk again, to check byte-for-byte repeats |

Two characters (a knight and a goblin) over three motions make 16 frames per
lane per character, or 136 frames for a full run. Each frame lands at
`<out>/<lane>/<character>/<motion>/frame-NN.png`. `runs.json` records each
frame's seed, strength, seconds and SHA-256. Frames already on disk are
skipped, so a stopped run picks up where it left off.

## Findings log

What each run taught us about running this graph, newest first. Quality
findings wait for the rubric scores.

- **November 2026, RTX 3060 12 GB (Windows).** The machine already ran a
  ComfyUI 0.34.0 with the same three models, under the same file names. A
  second ComfyUI 0.46.0 on the same card took 310 to 415 s a frame, because the
  two competed for VRAM. Sending the graph to the existing server instead took
  about 31 s a frame (55 s for the first, while the models loaded), so a full
  136-frame run takes about 75 minutes. The core-node graph ran unchanged on both versions. ComfyUI
  0.46.0 needed PyTorch 2.11 (cu128); on 2.6 it failed at startup.
- **November 2026, Apple M1 Max.** Smoke test: 223 s for the first frame and
  163 s for the second (ComfyUI 0.35.0, MPS).

The machine-level notes are in
[Set up ComfyUI: Run on a shared GPU machine](../../../docs/COMFYUI.md#run-on-a-shared-gpu-machine).

## What is left

1. **Lane A (prompt only) and lane B (pose):** every motion for two characters
   (the knight, and a non-human or heavily armoured silhouette). At about 160s a
   frame, 16 frames x 2 characters is about 85 minutes per lane.
2. **The strength sweep** (0.55, 0.75, 0.90) on lane B, about 4 hours, and
   **lane C** (an identity reference or character LoRA; not chosen yet).
3. **Lane D:** refine the winning sets to a native grid and one palette with
   `pixelkiln refine`, approve and pack them. Grid recovery on SDXL output is the
   open risk; the earlier high-resolution benchmark found these models draw
   pseudo-pixels.
4. **Human scores:** the 1x rubric in #79, by a person.
5. A second run of the winner, to record whether it repeats byte for byte.
6. The recipe (`comfyui/pixel-art-pose-frames@1.0.0`), docs, skill and site.
