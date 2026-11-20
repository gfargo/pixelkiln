"""Cut directional sprites into one piece per bone, for drawing a character as sprite cards on a skeleton.

  cards.py <skin.npz> <camera.json> <sprite-dir> <out-prefix>

<skin.npz> is what rig.py writes with SKIN=<file>: the body mesh in the sprites' frame and the bone that
owns each vertex. <camera.json> is the camera carve.ts fitted to the body's sprites. The mesh is drawn
into each of the eight views to find which bone each pixel of the sprite belongs to; the mesh is never
shown. Each sprite is then cut into one piece per bone, and the pieces are packed into one picture.

Environment:
  LAYERS  what to cut, in drawing order: "Body=body;Cuirass=plate;Cape=cape:Spine;Helm=helm:Head".
          Each entry is a name and the sprites <sprite-dir>/<sprites>-<direction>.png. A bone after a
          colon puts the whole layer on that bone. "behind" after a second colon ("Cape=cape:Spine:behind")
          marks a layer that hangs behind the body, for the renderer to order by which side the camera is on.
  MARGIN  how many pixels each piece reaches into its neighbours, to cover the joints (default 2)

Writes <out-prefix>.png and <out-prefix>.json. The .json lists every piece: its bone, layer and view,
where it is in the picture, and where its top left corner is from the bone's joint, in sprite pixels.
It also gives the size of a sprite pixel in metres and the camera's tilt, so a renderer can put each
piece on its bone. Needs numpy, pillow, scipy.
"""
import json, math, os, sys
import numpy as np
from PIL import Image
from scipy.ndimage import binary_dilation, distance_transform_edt

skin_file, camera_file, sprite_dir, out = sys.argv[1:5]
D = ["south", "south-east", "east", "north-east", "north", "north-west", "west", "south-west"]
skin = np.load(skin_file); names = [str(n) for n in skin["names"]]
world, faces, owner = skin["world"], skin["faces"], skin["owner"]
camera = json.load(open(camera_file)); theta = camera["elevation"]; size = camera["size"]
centre = [tuple(c.values()) if isinstance(c, dict) else tuple(c) for c in camera["centre"]]
off = [list(o.values()) if isinstance(o, dict) else list(o) for o in camera["off"]]
for v in range(8):  # the same half-pixel rule texture.py uses to match carve.ts
    off[v][0] = math.floor(centre[v][0] + off[v][0] + 0.5) - centre[v][0]
    if theta == 0: off[v][1] = math.floor(centre[v][1] + off[v][1] + 0.5) - centre[v][1]
margin = int(os.environ.get("MARGIN", "2"))
layers = []
for spec in os.environ.get("LAYERS", "Body=body").split(";"):
    label, rest = spec.split("=", 1); sprites, _, bone = rest.partition(":"); bone, _, where = bone.partition(":")
    layers.append((label, sprites, bone, where))

def project(w, v):
    az = v * math.pi / 4
    u = w[:, 0] * math.cos(az) - w[:, 1] * math.sin(az); d = w[:, 0] * math.sin(az) + w[:, 1] * math.cos(az)
    s = w[:, 2] * math.cos(theta) + d * math.sin(theta)
    return u + centre[v][0] + off[v][0], -s + centre[v][1] + off[v][1], d * math.cos(theta) - w[:, 2] * math.sin(theta)

# Points all over the mesh, each owned by the bone that owns the nearest corner of its triangle.
rng = np.random.default_rng(11)
tri = world[faces]; area = np.linalg.norm(np.cross(tri[:, 1] - tri[:, 0], tri[:, 2] - tri[:, 0]), axis=1)
pick = rng.choice(len(faces), 600000, p=area / area.sum()); bary = rng.dirichlet((1, 1, 1), 600000)
points = np.einsum("ij,ijk->ik", bary, tri[pick]); point_owner = owner[faces[pick, bary.argmax(1)]]

pieces, images = [], []
for v in range(8):
    fx, fy, depth = project(points, v)
    px, py = np.floor(fx).astype(int), np.floor(fy).astype(int)
    ok = (px >= 0) & (py >= 0) & (px < size) & (py < size)
    cell = py[ok] * size + px[ok]; order = np.argsort(-depth[ok])  # far first, so the nearest is written last
    label = -np.ones(size * size, int); label[cell[order]] = point_owner[ok][order]; label = label.reshape(size, size)
    # A sprite pixel the mesh does not reach takes the bone of the nearest pixel it does.
    nearest = distance_transform_edt(label < 0, return_indices=True)[1]
    label = label[nearest[0], nearest[1]]
    jx, jy, _ = project(skin["head"], v)
    for label_name, sprites, forced, _ in layers:
        sprite = np.array(Image.open(f"{sprite_dir}/{sprites}-{D[v]}.png").convert("RGBA"))
        if sprite.shape[0] != size: sys.exit(f"{sprites}-{D[v]}.png is {sprite.shape[0]} pixels; the camera is for {size}")
        solid = sprite[:, :, 3] > 127
        for b, bone in enumerate(names):
            if forced and bone != forced: continue
            mine = solid if forced else binary_dilation(solid & (label == b), iterations=margin) & solid
            if mine.sum() < 2: continue
            ys, xs = np.nonzero(mine); x0, x1, y0, y1 = xs.min(), xs.max() + 1, ys.min(), ys.max() + 1
            cut = sprite[y0:y1, x0:x1].copy(); cut[~mine[y0:y1, x0:x1]] = 0
            images.append(cut)
            pieces.append({"bone": bone, "layer": label_name, "view": v, "w": int(x1 - x0), "h": int(y1 - y0),
                           "dx": round(float(x0 - jx[b]), 2), "dy": round(float(y0 - jy[b]), 2)})

# Pack the pieces in rows, tallest first, with a clear pixel between them.
width = 512; x = y = row = 0
for i in sorted(range(len(pieces)), key=lambda i: -pieces[i]["h"]):
    p = pieces[i]
    if x + p["w"] + 1 > width: x, y, row = 0, y + row + 1, 0
    p["x"], p["y"] = x, y; x += p["w"] + 1; row = max(row, p["h"])
height = 1 << int(math.ceil(math.log2(y + row + 1)))
atlas = np.zeros((height, width, 4), np.uint8)
for p, image in zip(pieces, images): atlas[p["y"]:p["y"] + p["h"], p["x"]:p["x"] + p["w"]] = image
Image.fromarray(atlas).save(out + ".png")
gl = lambda p: [float(p[0]), float(p[2]), float(-p[1])]  # the sprites' frame (x, y, up) as glTF has it (x, up, -y)
axes = {bone: gl((skin["tail"][b] - skin["head"][b]) / (np.linalg.norm(skin["tail"][b] - skin["head"][b]) + 1e-9)) for b, bone in enumerate(names)}
json.dump({"atlas": [width, height], "metresPerPixel": float(skin["scale"]), "tilt": theta, "views": 8,
           "layers": [l[0] for l in layers], "behind": [l[0] for l in layers if l[3] == "behind"], "axes": axes, "pieces": pieces}, open(out + ".json", "w"), separators=(",", ":"))
print(f"{out}.png {width}x{height}, {len(pieces)} pieces in {len(layers)} layers")
