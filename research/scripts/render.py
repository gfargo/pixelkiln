"""Render a textured mesh at sprite size from sixteen directions and score it against the sprites.

  render.py <textured.glb> <sprite-dir> <name> <out.png> [elevation-degrees=10]

The mesh is y-up with its front towards +z and one unit per sprite pixel, as texture.py and the
paint scripts write it. Writes a sheet of three rows (the sprites, the mesh from the same eight
directions, the mesh from the eight between) and prints the same scores texture.py does, with each
render slid to where it overlaps its sprite best.

Environment:
  TOON=1   add three flat bands of light from the upper left
  COLOURS  reduce each render to this many colours taken from the sprites (default 0, off)
  SAMPLE   mean: each pixel is the average of the surface under it, then snapped to COLOURS (default: its commonest colour)
"""
import json, math, os, sys
import numpy as np
import trimesh
from PIL import Image
from scipy.spatial import cKDTree

D = ['south', 'south-east', 'east', 'north-east', 'north', 'north-west', 'west', 'south-west']
glb, sprite_dir, name, out = sys.argv[1:5]
theta = math.radians(float(sys.argv[5]) if len(sys.argv) > 5 else 10)
sprites = [np.array(Image.open(f'{sprite_dir}/{name}-{d}.png').convert('RGBA')) for d in D]
size = sprites[0].shape[0]

mesh = trimesh.load(glb, force='mesh')
points, faces = trimesh.sample.sample_surface(mesh, 900000, seed=3)
bary = trimesh.triangles.points_to_barycentric(mesh.triangles[faces], points)
uv = (mesh.visual.uv[mesh.faces[faces]] * bary[:, :, None]).sum(1)
texture = np.array(mesh.visual.material.baseColorTexture.convert('RGB'))
th, tw = texture.shape[:2]
colour = texture[np.clip(((1 - uv[:, 1]) * th).astype(int), 0, th - 1), np.clip((uv[:, 0] * tw).astype(int), 0, tw - 1)].astype(np.int64)
world = np.stack([points[:, 0], -points[:, 2], points[:, 1]], 1)
normal = mesh.face_normals[faces]
normal = np.stack([normal[:, 0], -normal[:, 2], normal[:, 1]], 1)
if os.environ.get('TOON') == '1':
    soft = mesh.copy()
    trimesh.smoothing.filter_taubin(soft, iterations=40)
    smooth = soft.face_normals[faces]
    normal = np.stack([smooth[:, 0], -smooth[:, 2], smooth[:, 1]], 1)

def pick_palette(pixels, count):
    """Colours spread across everything the sprites use. Median cut spends most of its colours on the
    commonest ones, which here are near-blacks; this starts from the distinct colours and keeps the ones
    furthest apart, then settles each on the middle of the colours nearest it."""
    distinct, uses = np.unique(pixels.reshape(-1, 3), axis=0, return_counts=True)
    distinct = distinct.astype(np.float64)
    if len(distinct) <= count: return distinct
    chosen = [int(uses.argmax())]; gap = np.linalg.norm(distinct - distinct[chosen[0]], axis=1)
    while len(chosen) < count:
        chosen.append(int(gap.argmax())); gap = np.minimum(gap, np.linalg.norm(distinct - distinct[chosen[-1]], axis=1))
    centres = distinct[chosen]
    for _ in range(8):
        nearest = np.linalg.norm(distinct[:, None] - centres[None], axis=2).argmin(1)
        for k in range(count):
            mine = nearest == k
            if mine.any(): centres[k] = (distinct[mine] * uses[mine, None]).sum(0) / uses[mine].sum()
    return centres


palette = None
WEIGH = np.array([0.55, 1.0, 0.4])  # green counts most when judging which palette colour is nearest
if int(os.environ.get('COLOURS', '0')) > 0:
    pixels = np.concatenate([s[s[:, :, 3] > 127][:, :3] for s in sprites])
    palette = pick_palette(pixels.astype(np.uint8), int(os.environ['COLOURS']))


def render(az):
    u = world[:, 0] * math.cos(az) - world[:, 1] * math.sin(az)
    d = world[:, 0] * math.sin(az) + world[:, 1] * math.cos(az)
    s = world[:, 2] * math.cos(theta) + d * math.sin(theta)
    depth = d * math.cos(theta) - world[:, 2] * math.sin(theta)
    px = np.floor(u + size / 2).astype(int)
    py = np.floor(-s + size / 2).astype(int)
    ok = (px >= 0) & (py >= 0) & (px < size) & (py < size)
    cell = py[ok] * size + px[ok]
    near = np.full(size * size, np.inf)
    np.minimum.at(near, cell, depth[ok])
    front = depth[ok] <= near[cell] + 1.2
    cell, col = cell[front], colour[ok][front]
    if os.environ.get('TOON') == '1':
        cam = np.array([-math.sin(az) * math.cos(theta), -math.cos(az) * math.cos(theta), math.sin(theta)])
        right = np.array([math.cos(az), -math.sin(az), 0.0])
        up = np.cross(right, -cam)
        light = cam * 0.55 - right * 0.45 + up * 0.7
        lit = normal[ok][front] @ (light / np.linalg.norm(light))
        band = np.where(lit > 0.55, 1.0, np.where(lit > 0.1, 0.8, 0.58))
        col = (col * band[:, None]).astype(np.int64)
    if os.environ.get('SAMPLE') == 'mean':
        # A detailed texture has many colours under one pixel. Their average, moved to the nearest palette colour,
        # is what a renderer that filters its texture shows; the commonest single colour is noise.
        total = np.zeros((size * size, 3)); np.add.at(total, cell, col)
        count = np.bincount(cell, minlength=size * size)
        image = np.zeros((size * size, 4), np.uint8); has = count > 0
        rgb = total[has] / count[has, None]
        if palette is not None:
            rgb = palette[cKDTree(palette * WEIGH).query(rgb * WEIGH)[1]]
        image[has, :3] = rgb; image[has, 3] = 255
        image = image.reshape(size, size, 4)
        alpha = np.pad(image[:, :, 3] > 0, 1)
        edge = (image[:, :, 3] > 0) & ~(alpha[:-2, 1:-1] & alpha[2:, 1:-1] & alpha[1:-1, :-2] & alpha[1:-1, 2:])
        image[edge, :3] = (image[edge, :3] * 0.3).astype(np.uint8)
        return image
    # Each pixel takes its commonest colour, sorted into coarse bins, not the average: averages are mud.
    key = cell * 4096 + (col[:, 0] >> 4) * 256 + (col[:, 1] >> 4) * 16 + (col[:, 2] >> 4)
    keys, inverse, counts = np.unique(key, return_inverse=True, return_counts=True)
    sums = np.zeros((len(keys), 3))
    np.add.at(sums, inverse, col)
    order = np.lexsort((counts, keys // 4096))
    last = np.r_[(keys[order] // 4096)[1:] != (keys[order] // 4096)[:-1], True]
    pick = order[last]
    image = np.zeros((size * size, 4), np.uint8)
    rgb = sums[pick] / counts[pick, None]
    if palette is not None:
        rgb = palette[cKDTree(palette).query(rgb)[1]]
    image[keys[pick] // 4096, :3] = rgb
    image[keys[pick] // 4096, 3] = 255
    image = image.reshape(size, size, 4)
    alpha = np.pad(image[:, :, 3] > 0, 1)
    edge = (image[:, :, 3] > 0) & ~(alpha[:-2, 1:-1] & alpha[2:, 1:-1] & alpha[1:-1, :-2] & alpha[1:-1, 2:])
    image[edge, :3] = (image[edge, :3] * 0.3).astype(np.uint8)
    return image


def slide(image, sprite):
    """Move the render to where its silhouette overlaps the sprite's best."""
    target = sprite[:, :, 3] > 127
    best = (-1, 0, 0)
    for dy in range(-10, 11):
        for dx in range(-10, 11):
            moved = np.roll(image[:, :, 3] > 0, (dy, dx), (0, 1))
            score = (moved & target).sum() / max((moved | target).sum(), 1)
            if score > best[0]:
                best = (score, dy, dx)
    return np.roll(image, best[1:], (0, 1)), best


sheet = np.zeros((size * 3, size * 8, 4), np.uint8)
shape, error, close = [], [], []
shift = []
for v in range(8):
    image, best = slide(render(v * math.pi / 4), sprites[v])
    shift.append(best[1:])
    both = (image[:, :, 3] > 0) & (sprites[v][:, :, 3] > 127)
    gap = np.abs(image[:, :, :3].astype(int) - sprites[v][:, :, :3].astype(int))[both]
    shape.append(best[0]); error.append(gap.mean()); close.append((gap.max(1) <= 24).mean())
    sheet[:size, v * size:(v + 1) * size] = sprites[v]
    sheet[size:2 * size, v * size:(v + 1) * size] = image
for v in range(8):
    a, b = shift[v], shift[(v + 1) % 8]
    image = np.roll(render((v + 0.5) * math.pi / 4), (round((a[0] + b[0]) / 2), round((a[1] + b[1]) / 2)), (0, 1))
    sheet[2 * size:, v * size:(v + 1) * size] = image
Image.fromarray(sheet).save(out)
print(json.dumps({'silhouetteMatch': round(100 * float(np.mean(shape)), 1), 'colourError': round(float(np.mean(error)), 1), 'pixelsClose': round(100 * float(np.mean(close)), 1)}))
