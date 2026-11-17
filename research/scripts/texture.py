"""Texture a mesh from eight directional sprites, in stages: fit, unwrap, project, fill, render.

usage: texture.py <sprite-dir> <name> <mesh.glb> <out-dir> [texture-size=256]
env:   SKIP=north-east,north-west   views to leave out (drawn tilted)
       FACES=30000                  triangle budget after simplifying
       MODE=best|blend              one view per texel, or a weighted blend snapped to the palette
       SNAP=0                       how far, in sprite pixels, a texel may reach for the nearest pixel inside the sprite
       EDGE=0                       a depth jump, in sprite pixels, that marks a contour to keep colour away from; 0 turns it off
       SMOOTH=2                     rounds of agreeing with neighbouring texels on which view to use

Needs numpy, scipy, pillow, trimesh, xatlas, fast-simplification.
Writes <name>.texture.png, <name>.views.png, <name>.textured.glb, <name>.textured.png (a sheet:
sprites, the model from the same eight directions, the model from the eight in between) and prints scores.
"""
import json, os, sys, math
import numpy as np
from PIL import Image
import trimesh, xatlas, fast_simplification
from scipy.spatial import cKDTree
from scipy.ndimage import distance_transform_edt

D = ["south", "south-east", "east", "north-east", "north", "north-west", "west", "south-west"]
sprite_dir, name, glb, out = sys.argv[1:5]
R = int(sys.argv[5]) if len(sys.argv) > 5 else 256
SKIP = {D.index(d) for d in os.environ.get("SKIP", "").split(",") if d}
USE = [v for v in range(8) if v not in SKIP]
MODE = os.environ.get("MODE", "best")
SNAP = float(os.environ.get("SNAP", "0"))
EDGE = float(os.environ.get("EDGE", "0"))
rng = np.random.default_rng(7)
os.makedirs(out, exist_ok=True)

sprites = [np.array(Image.open(f"{sprite_dir}/{name}-{d}.png").convert("RGBA")) for d in D]
size = sprites[0].shape[0]
alpha = [s[:, :, 3] > 127 for s in sprites]
def bbox_centre(a):
    ys, xs = np.nonzero(a)
    return (xs.min() + xs.max() + 1) / 2, (ys.min() + ys.max() + 1) / 2
centre = [bbox_centre(a) for a in alpha]

# ---- the mesh, simplified, y-up as glTF has it
mesh = trimesh.load(glb, force="mesh")
verts, faces = np.asarray(mesh.vertices, np.float64), np.asarray(mesh.faces)
budget = int(os.environ.get("FACES", "30000"))
if len(faces) > budget:
    verts, faces = fast_simplification.simplify(verts.astype(np.float32), faces, target_count=budget)
    verts = verts.astype(np.float64)
mesh = trimesh.Trimesh(verts, faces, process=True)
verts, faces = np.asarray(mesh.vertices), np.asarray(mesh.faces)
verts = verts - (verts.min(0) + verts.max(0)) / 2
mesh = trimesh.Trimesh(verts, faces, process=False)
normals = mesh.face_normals.copy()
if (np.einsum("ij,ij->i", normals, mesh.triangles_center) > 0).mean() < 0.5:
    faces = faces[:, ::-1]; mesh = trimesh.Trimesh(verts, faces, process=False); normals = mesh.face_normals.copy()

# ---- stage 1: fit the mesh to the sprites' cameras
def to_world(p, yaw, mirror, sc):
    """glTF (x, up, z) -> the sprites' frame (x, y, up), turned about the vertical and scaled per axis."""
    # glTF is right-handed with y up and the front toward +z; here the front faces -y, toward the south camera.
    x, up, z = p[:, 0] * mirror * sc[0], p[:, 1] * sc[1], -p[:, 2] * sc[2]
    c, s = math.cos(yaw), math.sin(yaw)
    return np.stack([x * c - z * s, x * s + z * c, up], 1)
def project(w, az, theta):
    u = w[:, 0] * math.cos(az) - w[:, 1] * math.sin(az)
    d = w[:, 0] * math.sin(az) + w[:, 1] * math.cos(az)
    return u, w[:, 2] * math.cos(theta) + d * math.sin(theta), d * math.cos(theta) - w[:, 2] * math.sin(theta)
def to_camera(az, theta):
    return np.array([-math.sin(az) * math.cos(theta), -math.cos(az) * math.cos(theta), math.sin(theta)])

fit_pts = np.asarray(trimesh.sample.sample_surface(mesh, 60000, seed=7)[0])
def silhouettes(p):
    w = to_world(fit_pts, p["yaw"], p["mirror"], p["sc"])
    res = []
    for v in USE:
        u, s, _ = project(w, v * math.pi / 4, p["theta"])
        px = np.floor(u + centre[v][0] + p["off"][v][0]).astype(int); py = np.floor(-s + centre[v][1] + p["off"][v][1]).astype(int)
        ok = (px >= 0) & (py >= 0) & (px < size) & (py < size)
        m = np.zeros(size * size, bool); m[py[ok] * size + px[ok]] = True
        res.append(m.reshape(size, size))
    return res
def iou(p):
    tot = 0
    for v, m in zip(USE, silhouettes(p)):
        tot += (m & alpha[v]).sum() / max(1, (m | alpha[v]).sum())
    return tot / len(USE)

height = np.mean([np.ptp(np.nonzero(alpha[v].any(1))[0]) + 1 for v in USE])
extent = verts.max(0) - verts.min(0)
best, best_s, tried = None, -1, []
for mirror in (1, -1):
    for turn in range(8):
        for deg in (0, 10, 20, 30):
            th = math.radians(deg)
            depth = max(extent[0], extent[2])
            s0 = height / (extent[1] * math.cos(th) + depth * math.sin(th))
            p = {"yaw": turn * math.pi / 4, "mirror": mirror, "theta": th, "sc": [s0, s0, s0], "off": [[0, 0] for _ in range(8)]}
            s = iou(p); tried.append((round(s * 100, 1), mirror, turn * 45, deg))
            # A silhouette cannot tell an object from its mirror image, so a mirrored fit has to win clearly.
            if s > best_s + (0.03 if mirror < 0 else 0): best, best_s = p, s
coarse = sorted(tried, reverse=True)[:4]
def clone(p): return {"yaw": p["yaw"], "mirror": p["mirror"], "theta": p["theta"], "sc": list(p["sc"]), "off": [list(o) for o in p["off"]]}
def attempt(change):
    global best, best_s
    p = clone(best); change(p); s = iou(p)
    if s > best_s + 1e-6: best, best_s = p, s; return True
    return False
for rnd in range(3):
    for step in (8, 4, 2, 1):
        for sign in (1, -1): attempt(lambda p: p.__setitem__("yaw", p["yaw"] + sign * math.radians(step)))
    for f in (1.06, 0.94, 1.03, 0.97, 1.015, 0.985):
        attempt(lambda p: p.__setitem__("sc", [c * f for c in p["sc"]]))
        for k in range(3): attempt(lambda p: p["sc"].__setitem__(k, p["sc"][k] * f))
    for dth in (5, -5, 2.5, -2.5): attempt(lambda p: p.__setitem__("theta", min(math.radians(45), max(0, p["theta"] + math.radians(dth)))))
    for v in USE:
        for dx, dy in ((1, 0), (-1, 0), (0, 1), (0, -1), (2, 0), (-2, 0), (0, 2), (0, -2)):
            attempt(lambda p: p["off"].__setitem__(v, [p["off"][v][0] + dx, p["off"][v][1] + dy]))
fit = best
world = to_world(verts, fit["yaw"], fit["mirror"], fit["sc"])
wmesh = trimesh.Trimesh(world, faces if fit["mirror"] > 0 else faces[:, ::-1], process=False)
wfaces = np.asarray(wmesh.faces); wnormals = wmesh.face_normals

# ---- stage 2: unwrap
vmap, uv_faces, uvs = xatlas.parametrize(world.astype(np.float32), wfaces.astype(np.uint32))
tex_pos = np.zeros((R, R, 3)); tex_face = -np.ones((R, R), int)
tri_uv = uvs[uv_faces] * R; tri_w = world[vmap][uv_faces]
for f in range(len(uv_faces)):
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
    yy, xx = np.nonzero(inside)
    tex_pos[y0 + yy, x0 + xx] = l1[yy, xx, None] * tri_w[f, 0] + l2[yy, xx, None] * tri_w[f, 1] + l3[yy, xx, None] * tri_w[f, 2]
    tex_face[y0 + yy, x0 + xx] = f
used = tex_face >= 0
P = tex_pos[used]; N = wnormals[tex_face[used]]

# ---- stage 3: project each sprite onto the texels it can see
dense, dense_face = trimesh.sample.sample_surface(wmesh, 600000, seed=11)
dense = np.asarray(dense)
Z = 3  # depth buffer cells per sprite pixel
weights = np.full((len(P), 8), -np.inf); colours = np.zeros((len(P), 8, 3), np.uint8)
for v in USE:
    az = v * math.pi / 4; cam = to_camera(az, fit["theta"])
    ox, oy = centre[v][0] + fit["off"][v][0], centre[v][1] + fit["off"][v][1]
    u, s, d = project(dense, az, fit["theta"])
    zx = np.floor((u + ox) * Z).astype(int); zy = np.floor((-s + oy) * Z).astype(int)
    ok = (zx >= 0) & (zy >= 0) & (zx < size * Z) & (zy < size * Z)
    zbuf = np.full(size * Z * size * Z, np.inf); np.minimum.at(zbuf, zy[ok] * size * Z + zx[ok], d[ok])
    # Where the mesh's depth jumps (its outer edge, an arm in front of the body) the sprite has a drawn contour,
    # and a pixel either side of it belongs to a different surface. Colour is not taken from those pixels.
    depth = zbuf.reshape(size, Z, size, Z).min((1, 3)); dp = np.pad(depth, 1, constant_values=np.inf)
    with np.errstate(invalid="ignore"):
        jump = np.zeros((size, size), bool)
        for nb in (dp[:-2, 1:-1], dp[2:, 1:-1], dp[1:-1, :-2], dp[1:-1, 2:]):
            jump |= ~(np.abs(nb - depth) <= EDGE)
    u, s, d = project(P, az, fit["theta"])
    fx, fy = u + ox, -s + oy
    px, py = np.floor(fx).astype(int), np.floor(fy).astype(int)
    zx, zy = np.clip(np.floor(fx * Z).astype(int), 0, size * Z - 1), np.clip(np.floor(fy * Z).astype(int), 0, size * Z - 1)
    inside = (px >= 0) & (py >= 0) & (px < size) & (py < size)
    pxc, pyc = np.clip(px, 0, size - 1), np.clip(py, 0, size - 1)
    rgba = sprites[v][pyc, pxc]
    opaque = inside & (rgba[:, 3] > 127)
    # The mesh is not the sprite's exact shape, so a texel near the edge can land on the outline or just
    # outside it. Within SNAP pixels, it takes the nearest pixel inside the sprite instead.
    am = np.pad(alpha[v], 1); rim = ~(am[:-2, 1:-1] & am[2:, 1:-1] & am[1:-1, :-2] & am[1:-1, 2:])
    interior = alpha[v] & ~(rim & (sprites[v][:, :, :3].max(2) < 70))
    dist, (iy, ix) = distance_transform_edt(~interior, return_indices=True)
    snap = dist[pyc, pxc]; near_ok = (snap > 0) & (snap <= SNAP) & (np.abs(fx - size / 2) < size) & (np.abs(fy - size / 2) < size)
    rgba = np.where(near_ok[:, None], sprites[v][iy[pyc, pxc], ix[pyc, pxc]], rgba)
    opaque = opaque | near_ok
    visible = d <= zbuf[zy * size * Z + zx] + 1.0
    facing = N @ cam
    # An outline pixel: dark, and touching the transparent background.
    a = np.pad(alpha[v], 1)
    edge = ~(a[:-2, 1:-1] & a[2:, 1:-1] & a[1:-1, :-2] & a[1:-1, 2:])
    outline = edge[pyc, pxc] & (rgba[:, :3].max(1) < 70) & ~near_ok
    # Outline pixels never give colour: the render draws its own outline.
    w = np.where(opaque & visible & (facing > 0.15) & ~outline & ~(jump[pyc, pxc] & (EDGE > 0)), facing - np.where(near_ok, 0.08 * snap, 0), -np.inf)
    weights[:, v] = w; colours[:, v] = rgba[:, :3]
owner = weights.argmax(1); seen = np.isfinite(weights.max(1))
# Neighbouring texels should take their colour from the same sprite where they can, or the surface speckles
# at every boundary between two views. Each texel moves to the view most of its neighbours in 3D use.
for _ in range(int(os.environ.get("SMOOTH", "2"))):
    idx = np.nonzero(seen)[0]; near = idx[cKDTree(P[idx]).query(P[idx], k=min(13, len(idx)))[1]]
    votes = np.zeros((len(idx), 8), int)
    for v in range(8): votes[:, v] = (owner[near] == v).sum(1)
    votes = np.where(np.isfinite(weights[idx]), votes, -1)
    owner[idx] = votes.argmax(1)
texel = colours[np.arange(len(P)), owner].astype(np.float64)
if MODE == "blend":
    w = np.where(np.isfinite(weights), np.maximum(weights, 0) ** 4, 0)
    mix = (colours * w[:, :, None]).sum(1) / np.maximum(w.sum(1), 1e-9)[:, None]
    palette = np.unique(np.concatenate([sprites[v][alpha[v]][:, :3] for v in USE]), axis=0).astype(np.float64)
    texel = palette[cKDTree(palette).query(mix)[1]]

# ---- stage 4: fill what no view could see from the nearest texel that was seen, in 3D
if (~seen).any() and seen.any():
    texel[~seen] = texel[seen][cKDTree(P[seen]).query(P[~seen])[1]]
tex = np.zeros((R, R, 4), np.uint8); tex[used, :3] = texel.astype(np.uint8); tex[used, 3] = 255
# Pad the islands so sampling at their edges does not pick up empty texels.
flat_used = np.argwhere(used); pad = np.argwhere(~used)
if len(pad):
    tex[~used, :3] = tex[used][cKDTree(flat_used).query(pad)[1], :3]
Image.fromarray(np.dstack([tex[:, :, :3], np.where(used, 255, 0).astype(np.uint8)])[::-1]).save(f"{out}/{name}.texture.png")
VIEW_COLOURS = np.array([[230, 80, 80], [230, 160, 60], [220, 220, 70], [120, 210, 80], [70, 200, 200], [80, 130, 230], [150, 90, 220], [220, 90, 190]], np.uint8)
vm = np.zeros((R, R, 4), np.uint8); vm[used, :3] = np.where(seen[:, None], VIEW_COLOURS[owner], 40); vm[used, 3] = 255
Image.fromarray(vm[::-1]).save(f"{out}/{name}.views.png")

# A mesh anyone can open: the fitted shape with its texture, z-up turned back to glTF's y-up.
gl = np.stack([world[vmap][:, 0], world[vmap][:, 2], -world[vmap][:, 1]], 1)
material = trimesh.visual.material.PBRMaterial(baseColorTexture=Image.fromarray(tex[::-1][:, :, :3]), metallicFactor=0.0, roughnessFactor=1.0)
textured = trimesh.Trimesh(gl, uv_faces, visual=trimesh.visual.TextureVisuals(uv=uvs, material=material), process=False)
textured.export(f"{out}/{name}.textured.glb")

# ---- stage 5: render at sprite size, unlit, with a drawn outline
bary = rng.dirichlet((1, 1, 1), 900000); pick = rng.choice(len(uv_faces), 900000, p=wmesh.area_faces / wmesh.area_faces.sum())
r_pos = np.einsum("ij,ijk->ik", bary, world[vmap][uv_faces][pick]); r_uv = np.einsum("ij,ijk->ik", bary, uvs[uv_faces][pick])
tx, ty = np.clip((r_uv[:, 0] * R).astype(int), 0, R - 1), np.clip((r_uv[:, 1] * R).astype(int), 0, R - 1)
r_rgb = tex[ty, tx, :3].astype(np.int64); r_key = (r_rgb[:, 0] << 16) | (r_rgb[:, 1] << 8) | r_rgb[:, 2]
def render(az, theta, ox, oy):
    u, s, d = project(r_pos, az, theta)
    px, py = np.floor(u + ox).astype(int), np.floor(-s + oy).astype(int)
    ok = (px >= 0) & (py >= 0) & (px < size) & (py < size)
    cell = py[ok] * size + px[ok]; dd = d[ok]; key = r_key[ok]
    zmin = np.full(size * size, np.inf); np.minimum.at(zmin, cell, dd)
    front = dd <= zmin[cell] + 1.2
    combo, counts = np.unique(cell[front] * (1 << 24) + key[front], return_counts=True)
    cells, keys = combo >> 24, combo & 0xFFFFFF
    order = np.lexsort((counts, cells)); last = np.r_[cells[order][1:] != cells[order][:-1], True]
    img = np.zeros((size * size, 4), np.uint8); c, k = cells[order][last], keys[order][last]
    img[c] = np.stack([k >> 16, (k >> 8) & 255, k & 255, np.full(len(k), 255)], 1)
    img = img.reshape(size, size, 4); a = np.pad(img[:, :, 3] > 0, 1)
    edge = (img[:, :, 3] > 0) & ~(a[:-2, 1:-1] & a[2:, 1:-1] & a[1:-1, :-2] & a[1:-1, 2:])
    img[edge, :3] = (img[edge, :3] * 0.21).astype(np.uint8)
    return img
sheet = np.zeros((size * 3, size * 8, 4), np.uint8); sheet[:, :] = (0, 0, 0, 0)
scores = []
for v in range(8):
    sheet[:size, v * size:(v + 1) * size] = sprites[v]
    ox, oy = centre[v][0] + fit["off"][v][0], centre[v][1] + fit["off"][v][1]
    img = render(v * math.pi / 4, fit["theta"], ox, oy); sheet[size:2 * size, v * size:(v + 1) * size] = img
    nxt = (v + 1) % 8
    mx, my = (ox + centre[nxt][0] + fit["off"][nxt][0]) / 2, (oy + centre[nxt][1] + fit["off"][nxt][1]) / 2
    sheet[2 * size:, v * size:(v + 1) * size] = render((v + 0.5) * math.pi / 4, fit["theta"], mx, my)
    if v in SKIP: continue
    m = img[:, :, 3] > 0; both = m & alpha[v]
    diff = np.abs(img[:, :, :3].astype(int) - sprites[v][:, :, :3].astype(int))[both]
    scores.append(((m & alpha[v]).sum() / (m | alpha[v]).sum(), diff.mean(), (diff.max(1) <= 24).mean()))
Image.fromarray(sheet).save(f"{out}/{name}.textured.png")
sc = np.array(scores)
print(json.dumps({"name": name, "faces": len(wfaces), "texture": R, "mode": MODE,
    "fit": {"mirror": fit["mirror"], "yawDeg": round(math.degrees(fit["yaw"]) % 360, 1), "elevationDeg": round(math.degrees(fit["theta"]), 1), "scale": [round(c, 2) for c in fit["sc"]], "coarseTop": coarse},
    "silhouetteMatch": round(sc[:, 0].mean() * 100, 1), "colourError": round(sc[:, 1].mean(), 1), "pixelsClose": round(sc[:, 2].mean() * 100, 1),
    "texelsUsed": int(used.sum()), "texelsSeen": round(seen.mean() * 100, 1),
    "texelsPerView": {D[v]: int(((owner == v) & seen).sum()) for v in USE}}))
