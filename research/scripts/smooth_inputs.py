"""Make the four smooth pictures the mesh model takes, from directional sprites and paperdoll layers.

  smooth_inputs.py <art-dir> <base> <out-dir> <out-name> [layers]

<base> names the sprites, <art-dir>/<base>-<direction>.png. [layers] is a comma-separated list
of what to stack, in order: "base" for the base sprites themselves, anything else for the layer
files <art-dir>/<layer>-<base>-<direction>.png. The default is "base".

  smooth_inputs.py art body in body          the body alone
  smooth_inputs.py art body in dressed base,body.briefs,body.plate
  FILL=1 smooth_inputs.py art body in plate body.plate   one item with no body, enlarged to fill

Writes <out-dir>/pk3d_<out-name>_{front,left,back,right}.png, 512 pixels square on white, which
is what hunyuan3d.py reads. Sprites are enlarged with bicubic filtering and cut through a blurred
copy of their transparency, so the model sees rounded shapes and not squares (step 22).

Environment:
  FILL  1 to crop to the drawn pixels before enlarging, one scale for all four views (default 0)

Needs numpy, pillow.
"""
import os, sys
import numpy as np
from PIL import Image, ImageFilter

art, base, out, name = sys.argv[1:5]
layers = (sys.argv[5] if len(sys.argv) > 5 else 'base').split(',')
fill = os.environ.get('FILL', '0') == '1'
VIEWS = (('front', 'south'), ('left', 'west'), ('back', 'north'), ('right', 'east'))


def stack(direction):
    # A layer made with padding is larger than the base and shares its centre.
    pictures = [Image.open(f'{art}/{base}-{direction}.png' if layer == 'base' else f'{art}/{layer}-{base}-{direction}.png').convert('RGBA')
                for layer in layers]
    side = max(max(p.size) for p in pictures)
    sprite = Image.new('RGBA', (side, side))
    for picture in pictures:
        sprite.alpha_composite(picture, ((side - picture.width) // 2, (side - picture.height) // 2))
    return sprite


def smooth(sprite, size):
    a = np.array(sprite).astype(np.float32)
    a[..., :3] *= a[..., 3:4] / 255  # premultiply so edges do not pick up black
    big = np.array(Image.fromarray(a.astype(np.uint8), 'RGBA').resize((size, size), Image.BICUBIC)).astype(np.float32)
    alpha = Image.fromarray(np.array(sprite)[..., 3]).resize((size, size), Image.BICUBIC)
    alpha = np.array(alpha.filter(ImageFilter.GaussianBlur(3))).astype(np.float32)
    rgb = big[..., :3] / np.maximum(big[..., 3:4], 1) * 255
    edge = np.clip((alpha - 112) / 30, 0, 1)[..., None]  # a soft cut through the blurred alpha rounds the stair steps
    return Image.fromarray((rgb.clip(0, 255) * edge + 255 * (1 - edge)).astype(np.uint8))


sprites = {view: stack(direction) for view, direction in VIEWS}
if fill:
    boxes = {view: sprite.getbbox() for view, sprite in sprites.items()}
    side = max(max(b[2] - b[0], b[3] - b[1]) for b in boxes.values()) + 4
    for view, b in boxes.items():
        cx, cy = (b[0] + b[2]) // 2, (b[1] + b[3]) // 2
        cell = Image.new('RGBA', (side, side))
        cell.alpha_composite(sprites[view], (side // 2 - cx, side // 2 - cy))
        sprites[view] = cell
os.makedirs(out, exist_ok=True)
for view, sprite in sprites.items():
    page = Image.new('RGB', (512, 512), (255, 255, 255))
    page.paste(smooth(sprite, 480), (16, 16))
    page.save(f'{out}/pk3d_{name}_{view}.png')
