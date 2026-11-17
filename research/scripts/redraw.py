"""Redraw small directional sprites as large, detailed pictures, with an image model on ComfyUI.

  redraw.py <sprite-dir> <name> <out-dir> "<what the character is>"

Each <sprite-dir>/<name>-<direction>.png is enlarged smoothly onto a plain ground and redrawn by an
SDXL checkpoint. A tile control model holds the redraw to the sprite's shapes and colours, so the
model adds detail without moving anything. The sprite's own outline, enlarged, is kept as the
transparency, so the result lines up with the sprite pixel for pixel.

The figure is cut out of its frame first, so it fills the picture the model works on, and put back
afterwards. Writes <out-dir>/<name>-<direction>.png: the whole sprite frame, larger, for use wherever
the sprites were.

Environment:
  API       ComfyUI address (default http://127.0.0.1:18188)
  MODEL     checkpoint (default sd_xl_base_1.0.safetensors)
  CONTROL   control model (default controlnet-union-sdxl-promax.safetensors)
  SIZE      size of the picture the model works on (default 1024)
  DENOISE   how far the model may move from the enlarged sprite, 0 to 1 (default 0.9)
  HOLD      strength of the tile control (default 0.6)
  UNTIL     the share of the steps the control applies for (default 0.5): it sets the layout, then lets go
  STEPS, CFG, SEED   sampling (defaults 28, 6, 7)
  DIRS      which directions (default all eight)
  STYLE     words added after the description (default "highly detailed digital painting, sharp focus, clean edges")
  GROUND    grey level behind the figure, 0 to 255 (default 128)

Needs numpy, pillow.
"""
import io, json, os, sys, time, urllib.parse, urllib.request, uuid
import numpy as np
from PIL import Image, ImageFilter

sprite_dir, name, out, what = sys.argv[1:5]
env = os.environ.get
API = env('API', 'http://127.0.0.1:18188'); SIZE = int(env('SIZE', '1024')); GROUND = int(env('GROUND', '128'))
D = ['south', 'south-east', 'east', 'north-east', 'north', 'north-west', 'west', 'south-west']
FACING = {'south': 'front view', 'south-east': 'three-quarter front view', 'east': 'side view', 'north-east': 'three-quarter back view',
          'north': 'back view, seen from behind', 'north-west': 'three-quarter back view', 'west': 'side view', 'south-west': 'three-quarter front view'}
dirs = [d for d in env('DIRS', ','.join(D)).split(',') if d]
os.makedirs(out, exist_ok=True)

def post(path, data, headers):
    return json.load(urllib.request.urlopen(urllib.request.Request(API + path, data=data, headers=headers), timeout=120))

def upload(image, filename):
    b = uuid.uuid4().hex; buffer = io.BytesIO(); image.save(buffer, 'PNG')
    data = (f'--{b}\r\nContent-Disposition: form-data; name="image"; filename="{filename}"\r\nContent-Type: image/png\r\n\r\n').encode() + buffer.getvalue() \
        + (f'\r\n--{b}\r\nContent-Disposition: form-data; name="overwrite"\r\n\r\ntrue\r\n--{b}--\r\n').encode()
    return post('/upload/image', data, {'Content-Type': f'multipart/form-data; boundary={b}'})['name']

def enlarge(sprite):
    """The sprite on the ground colour, enlarged smoothly, and its outline as a soft-edged mask."""
    a = np.array(sprite).astype(np.float32); a[..., :3] *= a[..., 3:4] / 255
    big = np.array(Image.fromarray(a.astype(np.uint8), 'RGBA').resize((SIZE, SIZE), Image.BICUBIC)).astype(np.float32)
    alpha = Image.fromarray(np.array(sprite)[..., 3]).resize((SIZE, SIZE), Image.BICUBIC).filter(ImageFilter.GaussianBlur(SIZE / 170))
    edge = np.clip((np.array(alpha).astype(np.float32) - 112) / 30, 0, 1)
    rgb = big[..., :3] / np.maximum(big[..., 3:4], 1) * 255
    page = rgb.clip(0, 255) * edge[..., None] + GROUND * (1 - edge[..., None])
    return Image.fromarray(page.astype(np.uint8)), edge

for d in dirs:
    whole = Image.open(f'{sprite_dir}/{name}-{d}.png').convert('RGBA')
    box = whole.getbbox(); side = max(box[2] - box[0], box[3] - box[1]) + 6
    left, top = (box[0] + box[2] - side) // 2, (box[1] + box[3] - side) // 2
    sprite = whole.crop((left, top, left + side, top + side))
    page, edge = enlarge(sprite)
    file = upload(page, f'pk_redraw_{name}_{d}.png')
    words = f'{what}, {FACING[d]}, {env("STYLE", "highly detailed digital painting, sharp focus, clean edges")}, plain grey background'
    g = {'ckpt': {'class_type': 'CheckpointLoaderSimple', 'inputs': {'ckpt_name': env('MODEL', 'sd_xl_base_1.0.safetensors')}},
         'yes': {'class_type': 'CLIPTextEncode', 'inputs': {'clip': ['ckpt', 1], 'text': words}},
         'no': {'class_type': 'CLIPTextEncode', 'inputs': {'clip': ['ckpt', 1], 'text': 'pixel art, pixelated, blurry, low quality, jpeg artifacts, text, watermark, extra limbs'}},
         'image': {'class_type': 'LoadImage', 'inputs': {'image': file}},
         'net': {'class_type': 'ControlNetLoader', 'inputs': {'control_net_name': env('CONTROL', 'controlnet-union-sdxl-promax.safetensors')}},
         'tile': {'class_type': 'SetUnionControlNetType', 'inputs': {'control_net': ['net', 0], 'type': 'tile'}},
         'hold': {'class_type': 'ControlNetApplyAdvanced', 'inputs': {'positive': ['yes', 0], 'negative': ['no', 0], 'control_net': ['tile', 0], 'image': ['image', 0],
                                                                       'strength': float(env('HOLD', '0.6')), 'start_percent': 0.0, 'end_percent': float(env('UNTIL', '0.5')), 'vae': ['ckpt', 2]}},
         'latent': {'class_type': 'VAEEncode', 'inputs': {'pixels': ['image', 0], 'vae': ['ckpt', 2]}},
         'sample': {'class_type': 'KSampler', 'inputs': {'model': ['ckpt', 0], 'positive': ['hold', 0], 'negative': ['hold', 1], 'latent_image': ['latent', 0],
                                                          'seed': int(env('SEED', '7')), 'steps': int(env('STEPS', '28')), 'cfg': float(env('CFG', '6')),
                                                          'sampler_name': 'dpmpp_2m', 'scheduler': 'karras', 'denoise': float(env('DENOISE', '0.9'))}},
         'decode': {'class_type': 'VAEDecode', 'inputs': {'samples': ['sample', 0], 'vae': ['ckpt', 2]}},
         'save': {'class_type': 'SaveImage', 'inputs': {'images': ['decode', 0], 'filename_prefix': f'pk_redraw/{name}_{d}'}}}
    t = time.time()
    pid = post('/prompt', json.dumps({'prompt': g, 'client_id': uuid.uuid4().hex}).encode(), {'Content-Type': 'application/json'})['prompt_id']
    while True:
        h = json.load(urllib.request.urlopen(f'{API}/history/{pid}', timeout=30))
        if pid in h:
            status = h[pid].get('status', {})
            if status.get('status_str') == 'error': sys.exit('ERROR ' + json.dumps(status)[:1500])
            if h[pid].get('outputs'): break
        if time.time() - t > 900: sys.exit('timeout')
        time.sleep(3)
    f = h[pid]['outputs']['save']['images'][0]
    q = urllib.parse.urlencode({'filename': f['filename'], 'subfolder': f.get('subfolder', ''), 'type': f.get('type', 'output')})
    drawn = np.array(Image.open(io.BytesIO(urllib.request.urlopen(f'{API}/view?{q}', timeout=300).read())).convert('RGB').resize((SIZE, SIZE)))
    cut = Image.fromarray(np.dstack([drawn, (edge * 255).astype(np.uint8)]))
    grow = SIZE / side  # the whole frame at the same scale, with the figure back where it was
    frame = Image.new('RGBA', (round(whole.width * grow), round(whole.height * grow)))
    frame.alpha_composite(cut, (round(left * grow), round(top * grow))) if left >= 0 and top >= 0 else frame.paste(cut, (round(left * grow), round(top * grow)))
    frame.save(f'{out}/{name}-{d}.png')
    print(d, round(time.time() - t), 's')
