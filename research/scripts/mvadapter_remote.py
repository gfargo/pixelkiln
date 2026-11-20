"""Run MV-Adapter's image-and-geometry-to-multiview model on prepared inputs. Runs on the GPU machine.

  mvadapter_remote.py <jobs.json>

This is the half of mvadapter_paint_turn.py that needs the GPU. It expects a clone of
https://github.com/huanngzh/MV-Adapter beside it (or at MVADAPTER_REPO) and its Python packages,
without nvdiffrast or CV-CUDA: the position and normal pictures the model is guided by are drawn
by mvadapter_paint_turn.py and arrive as arrays.

<jobs.json> is a list of {"control": <.npy, six views of position and normal, [6, H, W, 6] in 0..1>,
"reference": <.png, the picture to paint from, already on a grey ground>, "out": <prefix>,
"text": <a few words>}. Writes <prefix>-0.png to <prefix>-5.png for each job.

Environment:
  STEPS   sampling steps (default 30)
  SCALE   guidance scale (default 3)
  SEED    (default 7)
  OFFLOAD 1 keeps each part of the model on the GPU only while it runs, for cards with less memory (default 0)
"""
import json, os, sys, time
import numpy as np
import torch
from PIL import Image

sys.path.insert(0, os.environ.get('MVADAPTER_REPO', os.path.join(os.path.dirname(os.path.abspath(__file__)), 'MV-Adapter')))
from diffusers import AutoencoderKL
from mvadapter.models.attention_processor import DecoupledMVRowColSelfAttnProcessor2_0
from mvadapter.pipelines.pipeline_mvadapter_i2mv_sdxl import MVAdapterI2MVSDXLPipeline
from mvadapter.schedulers.scheduling_shift_snr import ShiftSNRScheduler

jobs = json.load(open(sys.argv[1]))
dtype = torch.float16
vae = AutoencoderKL.from_pretrained('madebyollin/sdxl-vae-fp16-fix', torch_dtype=dtype)
pipe = MVAdapterI2MVSDXLPipeline.from_pretrained('stabilityai/stable-diffusion-xl-base-1.0', vae=vae, torch_dtype=dtype, variant='fp16')
pipe.scheduler = ShiftSNRScheduler.from_scheduler(pipe.scheduler, shift_mode='interpolated', shift_scale=8.0)
pipe.init_custom_adapter(num_views=6, self_attn_processor=DecoupledMVRowColSelfAttnProcessor2_0)
pipe.load_custom_adapter('huanngzh/mv-adapter', weight_name='mvadapter_ig2mv_sdxl.safetensors')
if os.environ.get('OFFLOAD', '0') == '1':
    pipe.to(dtype=dtype); pipe.enable_model_cpu_offload()
else:
    pipe.to(device='cuda', dtype=dtype)
pipe.cond_encoder.to(device='cuda', dtype=dtype)
pipe.enable_vae_slicing(); pipe.enable_vae_tiling()

for job in jobs:
    t = time.time()
    control = torch.from_numpy(np.load(job['control']).astype(np.float32)).permute(0, 3, 1, 2).to('cuda', dtype)
    height, width = control.shape[2], control.shape[3]
    reference = Image.open(job['reference']).convert('RGB').resize((width, height), Image.LANCZOS)
    images = pipe(job.get('text', 'high quality'), height=height, width=width, num_inference_steps=int(os.environ.get('STEPS', '30')),
                  guidance_scale=float(os.environ.get('SCALE', '3')), num_images_per_prompt=6, control_image=control, control_conditioning_scale=1.0,
                  reference_image=reference, reference_conditioning_scale=1.0, negative_prompt='watermark, ugly, deformed, noisy, blurry, low contrast',
                  generator=torch.Generator(device='cuda').manual_seed(int(os.environ.get('SEED', '7')))).images
    for k, image in enumerate(images): image.save(f"{job['out']}-{k}.png")
    print(os.path.basename(job['out']), round(time.time() - t), 's', 'peak', round(torch.cuda.max_memory_allocated() / 2 ** 30, 1), 'GB', flush=True)
