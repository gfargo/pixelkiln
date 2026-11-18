"""Bake painted views onto a mesh's own texture, on this machine, with control over rims and seams.

  bake.py <name.textured.glb> <views.json> <out-dir> <name> [texture-size=1024]

The mesh is y-up with its front towards +z and already unwrapped, as texture.py writes it.
<views.json> is what hunyuan3d_paint_turn.py writes: a list of {"view", "normal", "ref", "turn"}, where
"view" is a painted picture, "normal" is the paint node's own render of the mesh it painted over
(used only to find where the mesh sits in the picture), "ref" is the sprite picture the view was painted from and "turn" is how far, in degrees about the
up axis, the mesh was turned to face the camera for it.

Each texel takes a weighted blend of the views that see it. A view counts for more the more squarely
the surface faces it, and for nothing near that view's outline or a jump in depth, where a painted
view carries its background or the wrong part of the body.

Environment:
  POWER   how sharply a view's weight falls as the surface turns away (default 8; 16 is close to one view per texel)
  RIM     how far, in view pixels, from an outline or depth jump a view starts to count (default 0, off: on the knight it left speckles where it pushed good views out)
  JUMP    a depth step between neighbouring view pixels, in mesh units, that counts as a jump (default 1.5)
  FLOOR   the least total weight a texel needs to count as seen (default 0.02)
  TONE    1 moves each painted view's colours to its reference's mean and spread. It helped a little when the
          references were sprites (step 23). With redrawn references it turns greys teal, since a view shows more
          of one colour than its reference does (default 0)
  MATCH   1 shifts each view's colour so views agree where they overlap (default 0: it moved colours away from the sprites)
  PALETTE a folder of sprites and their name, "<dir>:<name>": snap the texture to their colours
  COLOURS how many colours PALETTE keeps (default 32)
  TEXEL   with PALETTE: paint the texture in square blocks this many texels wide (default 1, off)

Needs numpy, scipy, pillow, trimesh. Writes <name>.baked.glb, <name>.baked.texture.png and
<name>.baked.weights.png (which view won each texel).
"""
import json, math, os, sys
import numpy as np
import trimesh
from PIL import Image
from scipy.ndimage import distance_transform_edt, map_coordinates, maximum_filter, minimum_filter
from scipy.spatial import cKDTree

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


glb, views_file, out, name = sys.argv[1:5]
R = int(sys.argv[5]) if len(sys.argv) > 5 else 1024
env = os.environ.get
POWER, RIM, JUMP, MATCH = float(env('POWER', '8')), float(env('RIM', '0')), float(env('JUMP', '1.5')), env('MATCH', '0') == '1'
TONE = env('TONE', '0') == '1'
views = json.load(open(views_file))
base = os.path.dirname(os.path.abspath(views_file))

mesh = trimesh.load(glb, force='mesh', process=False)
V, F, UV = np.asarray(mesh.vertices, np.float64), np.asarray(mesh.faces), np.asarray(mesh.visual.uv, np.float64)
VN = np.asarray(mesh.vertex_normals, np.float64)

# ---- where each texel is on the surface
pos = np.zeros((R, R, 3)); nor = np.zeros((R, R, 3)); used = np.zeros((R, R), bool)
tri_uv = UV[F] * R
for f in range(len(F)):
    a, b, c = tri_uv[f]
    x0, x1 = max(0, int(math.floor(min(a[0], b[0], c[0])))), min(R - 1, int(math.ceil(max(a[0], b[0], c[0]))))
    y0, y1 = max(0, int(math.floor(min(a[1], b[1], c[1])))), min(R - 1, int(math.ceil(max(a[1], b[1], c[1]))))
    den = (b[1] - c[1]) * (a[0] - c[0]) + (c[0] - b[0]) * (a[1] - c[1])
    if abs(den) < 1e-12 or x1 < x0 or y1 < y0: continue
    xs, ys = np.meshgrid(np.arange(x0, x1 + 1) + 0.5, np.arange(y0, y1 + 1) + 0.5)
    l1 = ((b[1] - c[1]) * (xs - c[0]) + (c[0] - b[0]) * (ys - c[1])) / den
    l2 = ((c[1] - a[1]) * (xs - c[0]) + (a[0] - c[0]) * (ys - c[1])) / den
    l3 = 1 - l1 - l2
    inside = (l1 >= -0.02) & (l2 >= -0.02) & (l3 >= -0.02)
    if not inside.any(): continue
    yy, xx = np.nonzero(inside); w = np.stack([l1[yy, xx], l2[yy, xx], l3[yy, xx]], 1)
    pos[y0 + yy, x0 + xx] = w @ V[F[f]]; nor[y0 + yy, x0 + xx] = w @ VN[F[f]]; used[y0 + yy, x0 + xx] = True
P = pos[used]; N = nor[used]; N /= np.linalg.norm(N, axis=1, keepdims=True) + 1e-9
dense, _ = trimesh.sample.sample_surface(mesh, 1500000, seed=5)


def turned(points, degrees):
    """The mesh as the camera saw it: right, up, and towards the camera."""
    t = math.radians(degrees)
    return np.stack([points[:, 0] * math.cos(t) + points[:, 2] * math.sin(t), points[:, 1], -points[:, 0] * math.sin(t) + points[:, 2] * math.cos(t)], 1)


def place(view, size):
    """Scale and offset from mesh units to this view's pixels, read from the node's own render of the mesh."""
    normal = np.array(Image.open(os.path.join(base, view['normal'])).convert('RGB').resize((size, size), Image.BILINEAR)).astype(int)
    mask = np.abs(normal - normal[0, 0]).sum(2) > 24
    ys, xs = np.nonzero(mask)
    q = turned(V, view['turn'])
    best = None
    for flip in (1, -1):
        x = q[:, 0] * flip
        scale = ((xs.max() - xs.min() + 1) / (x.max() - x.min()) + (ys.max() - ys.min() + 1) / (q[:, 1].max() - q[:, 1].min())) / 2
        ox = (xs.max() + xs.min() + 1) / 2 - scale * (x.max() + x.min()) / 2
        oy = (ys.max() + ys.min() + 1) / 2 + scale * (q[:, 1].max() + q[:, 1].min()) / 2
        d = turned(dense, view['turn'])
        cover = np.zeros((size, size), bool)
        px = np.clip((d[:, 0] * flip * scale + ox).astype(int), 0, size - 1); py = np.clip((oy - d[:, 1] * scale).astype(int), 0, size - 1)
        cover[py, px] = True
        score = (cover & mask).sum() / max((cover | mask).sum(), 1)
        if best is None or score > best[0]: best = (score, flip, scale, ox, oy)
    return best


colour = np.zeros((len(views), len(P), 3)); weight = np.zeros((len(views), len(P)))
for k, view in enumerate(views):
    picture = np.array(Image.open(os.path.join(base, view['view'])).convert('RGB')).astype(np.float64)
    size = picture.shape[0]
    fit, flip, scale, ox, oy = place(view, size)
    d = turned(dense, view['turn'])
    px = np.clip((d[:, 0] * flip * scale + ox).astype(int), 0, size - 1); py = np.clip((oy - d[:, 1] * scale).astype(int), 0, size - 1)
    depth = np.full((size, size), -np.inf); np.maximum.at(depth, (py, px), d[:, 2])
    solid = np.isfinite(depth)
    filled = np.where(solid, depth, -1e9)
    edge = ~solid | (maximum_filter(filled, 3) - minimum_filter(np.where(solid, depth, 1e9), 3) > JUMP)
    far = distance_transform_edt(~edge)
    q = turned(P, view['turn']); n = turned(N, view['turn'])
    fx, fy = q[:, 0] * flip * scale + ox, oy - q[:, 1] * scale
    ix, iy = np.clip(fx.astype(int), 0, size - 1), np.clip(fy.astype(int), 0, size - 1)
    seen = (q[:, 2] >= depth[iy, ix] - 1.0) & (n[:, 2] > 0.05)
    rim = np.clip((far[iy, ix] - RIM / 2) / (RIM / 2), 0, 1) if RIM > 0 else 1.0
    weight[k] = np.where(seen, np.clip(n[:, 2], 0, 1) ** POWER * rim, 0)
    if TONE and view.get('ref'):
        # The paint model redraws the sprite a little lighter and warmer than it is. Move each channel of the
        # painted figure back to the sprite's own mean and spread.
        ref = np.array(Image.open(os.path.join(base, view['ref'])).convert('RGB')).astype(np.float64)
        figure = ref[np.abs(ref - ref[0, 0]).sum(2) > 24]; painted = picture[solid & (far > RIM)]
        if len(figure) > 100 and len(painted) > 100:
            picture = np.clip((picture - painted.mean(0)) * (figure.std(0) / (painted.std(0) + 1e-6)) + figure.mean(0), 0, 255)
    for channel in range(3):
        colour[k, :, channel] = map_coordinates(picture[:, :, channel], [fy - 0.5, fx - 0.5], order=1, mode='nearest')
    print(f"{view['view']}: placed {100 * fit:.1f}%, sees {100 * seen.mean():.0f}% of texels", flush=True)

# ---- make the views agree where they overlap: one colour shift per view, least squares over every pair
if MATCH and len(views) > 1:
    rows, rhs = [], []
    for i in range(len(views)):
        for j in range(i + 1, len(views)):
            both = np.minimum(weight[i], weight[j]); total = both.sum()
            if total < 50: continue
            gap = ((colour[j] - colour[i]) * both[:, None]).sum(0) / total
            row = np.zeros(len(views)); row[i], row[j] = 1, -1
            rows.append(row * math.sqrt(total)); rhs.append(gap * math.sqrt(total))
    rows.append(np.ones(len(views)) * 1e3); rhs.append(np.zeros(3))
    shift = np.linalg.lstsq(np.array(rows), np.array(rhs), rcond=None)[0]
    colour = np.clip(colour + shift[:, None, :], 0, 255)
    print('colour shift per view, largest', np.abs(shift).max().round(1))

# A texel only glimpsed at a grazing angle, or only at a rim, is better filled from its neighbours than
# painted with the dark outline that is all such a view has of it.
total = weight.sum(0); seen = total > float(env('FLOOR', '0.02'))
blend = (colour * weight[:, :, None]).sum(0) / np.maximum(total, 1e-9)[:, None]
if (~seen).any():  # what no view saw takes the nearest texel that was seen, on the surface
    sure = total > min(0.25, np.percentile(total[seen], 50))  # and from one that was seen well, not from the dark line at a rim
    blend[~seen] = blend[sure][cKDTree(P[sure]).query(P[~seen])[1]]
print(f'texels seen {100 * seen.mean():.1f}%')

# ---- back to pixel art: the sprites' own colours, in blocks
if env('PALETTE'):
    sprite_dir, sprite_name = env('PALETTE').split(':')
    pixels = []
    for file in sorted(os.listdir(sprite_dir)):
        if file.startswith(sprite_name + '-') and file.endswith('.png'):
            sprite = np.array(Image.open(os.path.join(sprite_dir, file)).convert('RGBA'))
            pixels.append(sprite[sprite[:, :, 3] > 127][:, :3])
    pixels = np.concatenate(pixels)
    palette = pick_palette(pixels, int(env('COLOURS', '32')))
    block = int(env('TEXEL', '1'))
    if block > 1:  # every texel in a block takes the block's middle colour, so the surface is made of squares
        ty, tx = np.nonzero(used)
        key = (ty // block) * R + tx // block
        keys, inverse = np.unique(key, return_inverse=True)
        mean = np.zeros((len(keys), 3)); np.add.at(mean, inverse, blend); count = np.bincount(inverse)[:, None]
        blend = (mean / count)[inverse]
    blend = palette[cKDTree(palette).query(blend)[1]]

texture = np.zeros((R, R, 3), np.uint8); texture[used] = np.clip(blend, 0, 255).astype(np.uint8)
pad = np.argwhere(~used)
if len(pad): texture[~used] = texture[used][cKDTree(np.argwhere(used)).query(pad)[1]]
os.makedirs(out, exist_ok=True)
Image.fromarray(texture[::-1]).save(f'{out}/{name}.baked.texture.png')
HUES = np.array([[230, 80, 80], [230, 160, 60], [220, 220, 70], [120, 210, 80], [70, 200, 200], [80, 130, 230], [150, 90, 220], [220, 90, 190]], np.uint8)
owner = np.zeros((R, R, 3), np.uint8); owner[used] = np.where(seen[:, None], HUES[weight.argmax(0) % 8], 40)
Image.fromarray(owner[::-1]).save(f'{out}/{name}.baked.weights.png')
material = trimesh.visual.material.PBRMaterial(baseColorTexture=Image.fromarray(texture[::-1]), metallicFactor=0.0, roughnessFactor=1.0)
trimesh.Trimesh(V, F, visual=trimesh.visual.TextureVisuals(uv=UV, material=material), process=False).export(f'{out}/{name}.baked.glb')
print(f'{out}/{name}.baked.glb')
