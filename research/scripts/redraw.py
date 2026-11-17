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
  SHEET     1 redraws every direction together on one sheet first, so they share one design, then sharpens
            each on its own (default 0: each direction is redrawn alone and they will not agree on details)
  CELL      with SHEET: the size of each figure on the sheet (default 512)
  REFINE    with SHEET: how far the sharpening pass may move from the sheet, 0 to 1 (default 0.35; 0 skips it)
  COLOUR    1 keeps the sprite's colours: the redraw's broad colour is swapped for the sprite's, region by
            region, and only its detail is kept (default 1)
  OUTLINE   sprite (default) cuts the redraw with the sprite's own enlarged outline, so it lines up with the
            sprite pixel for pixel but keeps its stair steps. own lets the redraw keep the outline the model
            drew: whatever is not the plain ground, within a few sprite pixels of the sprite.
  DIRS      which directions (default all eight)
  STYLE     words added after the description (default "highly detailed digital painting, sharp focus, clean edges")
  GROUND    grey level behind the figure, 0 to 255 (default 128)

Needs numpy, pillow, scipy.
"""
import io, json, os, sys, time, urllib.parse, urllib.request, uuid
import numpy as np
from PIL import Image, ImageFilter
from scipy.ndimage import binary_dilation, gaussian_filter, label

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

def enlarge(sprite, size):
    """The sprite on the ground colour, enlarged smoothly, and its outline as a soft-edged mask."""
    a = np.array(sprite).astype(np.float32); a[..., :3] *= a[..., 3:4] / 255
    big = np.array(Image.fromarray(a.astype(np.uint8), 'RGBA').resize((size, size), Image.BICUBIC)).astype(np.float32)
    alpha = Image.fromarray(np.array(sprite)[..., 3]).resize((size, size), Image.BICUBIC).filter(ImageFilter.GaussianBlur(size / 170))
    edge = np.clip((np.array(alpha).astype(np.float32) - 112) / 30, 0, 1)
    rgb = big[..., :3] / np.maximum(big[..., 3:4], 1) * 255
    page = rgb.clip(0, 255) * edge[..., None] + GROUND * (1 - edge[..., None])
    return page.astype(np.uint8), edge

def draw(page, words, denoise, hold, until, tag):
    """One pass of the model over a picture; returns the redrawn picture at the same size."""
    file = upload(Image.fromarray(page), f'pk_redraw_{name}_{tag}.png')
    g = {'ckpt': {'class_type': 'CheckpointLoaderSimple', 'inputs': {'ckpt_name': env('MODEL', 'sd_xl_base_1.0.safetensors')}},
         'yes': {'class_type': 'CLIPTextEncode', 'inputs': {'clip': ['ckpt', 1], 'text': words}},
         'no': {'class_type': 'CLIPTextEncode', 'inputs': {'clip': ['ckpt', 1], 'text': 'pixel art, pixelated, blurry, low quality, jpeg artifacts, text, watermark, extra limbs'}},
         'image': {'class_type': 'LoadImage', 'inputs': {'image': file}},
         'net': {'class_type': 'ControlNetLoader', 'inputs': {'control_net_name': env('CONTROL', 'controlnet-union-sdxl-promax.safetensors')}},
         'tile': {'class_type': 'SetUnionControlNetType', 'inputs': {'control_net': ['net', 0], 'type': 'tile'}},
         'hold': {'class_type': 'ControlNetApplyAdvanced', 'inputs': {'positive': ['yes', 0], 'negative': ['no', 0], 'control_net': ['tile', 0], 'image': ['image', 0],
                                                                       'strength': hold, 'start_percent': 0.0, 'end_percent': until, 'vae': ['ckpt', 2]}},
         'latent': {'class_type': 'VAEEncode', 'inputs': {'pixels': ['image', 0], 'vae': ['ckpt', 2]}},
         'sample': {'class_type': 'KSampler', 'inputs': {'model': ['ckpt', 0], 'positive': ['hold', 0], 'negative': ['hold', 1], 'latent_image': ['latent', 0],
                                                          'seed': int(env('SEED', '7')), 'steps': int(env('STEPS', '28')), 'cfg': float(env('CFG', '6')),
                                                          'sampler_name': 'dpmpp_2m', 'scheduler': 'karras', 'denoise': denoise}},
         'decode': {'class_type': 'VAEDecode', 'inputs': {'samples': ['sample', 0], 'vae': ['ckpt', 2]}},
         'save': {'class_type': 'SaveImage', 'inputs': {'images': ['decode', 0], 'filename_prefix': f'pk_redraw/{name}_{tag}'}}}
    t = time.time()
    pid = post('/prompt', json.dumps({'prompt': g, 'client_id': uuid.uuid4().hex}).encode(), {'Content-Type': 'application/json'})['prompt_id']
    while True:
        h = json.load(urllib.request.urlopen(f'{API}/history/{pid}', timeout=30))
        if pid in h:
            status = h[pid].get('status', {})
            if status.get('status_str') == 'error': sys.exit('ERROR ' + json.dumps(status)[:1500])
            if h[pid].get('outputs'): break
        if time.time() - t > 1500: sys.exit('timeout')
        time.sleep(3)
    f = h[pid]['outputs']['save']['images'][0]
    q = urllib.parse.urlencode({'filename': f['filename'], 'subfolder': f.get('subfolder', ''), 'type': f.get('type', 'output')})
    drawn = Image.open(io.BytesIO(urllib.request.urlopen(f'{API}/view?{q}', timeout=300).read())).convert('RGB').resize((page.shape[1], page.shape[0]))
    print(tag, round(time.time() - t), 's')
    return np.array(drawn)

def keep_colours(drawn, page, edge):
    """The redraw's detail over the sprite's colours: swap the broad colour of each region for the sprite's."""
    sigma = SIZE / float(env('COLOUR_SCALE', '40')); weight = gaussian_filter(edge, sigma) + 1e-4
    broad = lambda picture: np.stack([gaussian_filter(picture[..., c].astype(np.float32) * edge, sigma) / weight for c in range(3)], -1)
    return (drawn.astype(np.float32) - broad(drawn) + broad(page)).clip(0, 255).astype(np.uint8)

STYLE = env('STYLE', 'highly detailed digital painting, sharp focus, clean edges')
DENOISE, HOLD, UNTIL = float(env('DENOISE', '0.9')), float(env('HOLD', '0.6')), float(env('UNTIL', '0.5'))
wholes = {d: Image.open(f'{sprite_dir}/{name}-{d}.png').convert('RGBA') for d in dirs}
boxes = {d: w.getbbox() for d, w in wholes.items()}
side = max(max(b[2] - b[0], b[3] - b[1]) for b in boxes.values()) + 6  # one scale for every direction
corner = {d: ((b[0] + b[2] - side) // 2, (b[1] + b[3] - side) // 2) for d, b in boxes.items()}
sprites = {d: wholes[d].crop((corner[d][0], corner[d][1], corner[d][0] + side, corner[d][1] + side)) for d in dirs}
agreed = {}
if env('SHEET', '0') == '1':
    # Every direction side by side in one picture, so the model draws one design from eight angles.
    cell = int(env('CELL', '512')); columns = 4; rows = (len(dirs) + columns - 1) // columns
    sheet = np.full((rows * cell, columns * cell, 3), GROUND, np.uint8)
    for i, d in enumerate(dirs):
        sheet[i // columns * cell:(i // columns + 1) * cell, i % columns * cell:(i % columns + 1) * cell] = enlarge(sprites[d], cell)[0]
    words = f'character turnaround sheet, the same character seen from {len(dirs)} angles, {what}, {STYLE}, plain grey background'
    drawn = draw(sheet, words, DENOISE, HOLD, UNTIL, 'sheet')
    Image.fromarray(drawn).save(f'{out}/{name}-sheet.png')
    for i, d in enumerate(dirs):
        agreed[d] = Image.fromarray(drawn[i // columns * cell:(i // columns + 1) * cell, i % columns * cell:(i % columns + 1) * cell]).resize((SIZE, SIZE), Image.LANCZOS)
for d in dirs:
    page, edge = enlarge(sprites[d], SIZE)
    words = f'{what}, {FACING[d]}, {STYLE}, plain grey background'
    if d in agreed:
        # Sharpen the sheet's small figure without letting the model redesign it.
        drawn = np.array(agreed[d]); refine = float(env('REFINE', '0.35'))
        if refine > 0: drawn = draw(drawn, words, refine, 0.6, 1.0, d)
    else:
        drawn = draw(page, words, DENOISE, HOLD, UNTIL, d)
    raw = drawn
    if env('COLOUR', '1') == '1': drawn = keep_colours(drawn, page, edge)
    alpha = edge
    if env('OUTLINE', 'sprite') == 'own':
        # The ground is whatever is near the ground colour and joined to the border of the picture.
        plain = np.abs(raw.astype(np.int32) - GROUND).max(-1) < int(env('GROUND_GAP', '22'))
        regions, _ = label(plain)
        border = np.unique(np.concatenate([regions[0], regions[-1], regions[:, 0], regions[:, -1]]))
        ground = np.isin(regions, border[border > 0])
        reach = binary_dilation(edge > 0.5, iterations=round(2.5 * SIZE / side))
        alpha = gaussian_filter((~ground & reach).astype(np.float32), 1.2)
        drawn = np.where((alpha > 0.05)[..., None] & (edge < 0.05)[..., None], raw, drawn)  # outside the sprite there is no sprite colour to keep
    cut = Image.fromarray(np.dstack([drawn, (alpha * 255).astype(np.uint8)]))
    grow = SIZE / side  # the whole frame at the same scale, with the figure back where it was
    frame = Image.new('RGBA', (round(wholes[d].width * grow), round(wholes[d].height * grow)))
    frame.paste(cut, (round(corner[d][0] * grow), round(corner[d][1] * grow)))
    frame.save(f'{out}/{name}-{d}.png')
