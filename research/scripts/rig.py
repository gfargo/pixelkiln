"""Give a textured character mesh a skeleton, skin it, add a walk, and write a rigged .glb.

usage: rig.py <name.textured.glb> <name.rig.json> <name.vox> <name.camera.json> <out.glb> [preview.png]

The .glb comes from texture.py, the rig from carve.ts run with an anchors file (the 18 joints PixelLab
estimates in each view, triangulated to 3D), the voxels and camera from carve.ts with DUMP=1.
Needs numpy, pillow, trimesh.

The skeleton is fifteen bones named the way game engines name a humanoid (Hips, Spine, Head, LeftUpperArm ...).
Skin weights come from distance to each bone, with a penalty when the straight line from a vertex to a bone
leaves the body, so an arm hanging beside the torso is not pulled along by the spine.
The file is in metres, y up, facing +z, about 1.8 m tall, with one animation called Walk.
"""
import io, json, math, struct, sys
import numpy as np
from PIL import Image
import trimesh

glb_in, rig_file, vox_file, cam_file, out = sys.argv[1:6]
preview = sys.argv[6] if len(sys.argv) > 6 else None

mesh = trimesh.load(glb_in, force="mesh", process=False)
g = np.asarray(mesh.vertices, np.float64); faces = np.asarray(mesh.faces)
uv = np.asarray(mesh.visual.uv, np.float64)
texture = mesh.visual.material.baseColorTexture.convert("RGBA")
world = np.stack([g[:, 0], -g[:, 2], g[:, 1]], 1)  # glTF (x, up, -y) back to the sprites' frame (x, y, up)
cam = json.load(open(cam_file)); N = cam["size"]
vox = np.fromfile(vox_file, np.uint8).reshape(N, N, N) > 0
J = {j["label"]: np.array([j["x"], j["y"], j["z"]]) for j in json.load(open(rig_file))["joints"]}
mid = lambda a, b: (a + b) / 2
hips, neck = mid(J["LEFT HIP"], J["RIGHT HIP"]), J["NECK"]
head = mid(J["LEFT EAR"], J["RIGHT EAR"])
top = np.array([head[0], head[1], world[:, 2].max()])
down = np.array([0, 0, -1.0])
def past(a, b, by):  # a point `by` beyond b on the line from a
    d = b - a; return b + d / (np.linalg.norm(d) + 1e-9) * by

# name, parent, where the joint is, where its bone ends
BONES = [("Hips", None, hips, mid(hips, neck)), ("Spine", "Hips", mid(hips, neck), neck), ("Head", "Spine", neck, top)]
for side, s in (("Left", "LEFT"), ("Right", "RIGHT")):
    sh, el, wr = J[s + " SHOULDER"], J[s + " ELBOW"], J[s + " ARM"]
    hp, kn, an = J[s + " HIP"], J[s + " KNEE"], J[s + " LEG"]
    BONES += [(side + "UpperArm", "Spine", sh, el), (side + "LowerArm", side + "UpperArm", el, wr), (side + "Hand", side + "LowerArm", wr, past(el, wr, 3)),
              (side + "UpperLeg", "Hips", hp, kn), (side + "LowerLeg", side + "UpperLeg", kn, an), (side + "Foot", side + "LowerLeg", an, an + down * 3 + np.array([0, -2.0, 0]))]
names = [b[0] for b in BONES]; parent = [names.index(b[1]) if b[1] else -1 for b in BONES]
head_pos = np.array([b[2] for b in BONES]); tail_pos = np.array([b[3] for b in BONES])

# ---- skin weights
def inside(p):
    i = np.floor(p + N / 2).astype(int)
    ok = ((i >= 0) & (i < N)).all(-1); i = i.clip(0, N - 1)
    return vox[i[..., 2], i[..., 1], i[..., 0]] & ok
dist = np.zeros((len(world), len(BONES)))
for b in range(len(BONES)):
    a, c = head_pos[b], tail_pos[b]; ab = c - a
    t = np.clip(((world - a) @ ab) / (ab @ ab + 1e-9), 0, 1)
    closest = a + t[:, None] * ab
    d = np.linalg.norm(world - closest, axis=1)
    # Walk the line from just inside the surface to the bone; count the share of it that is outside the body.
    steps = np.linspace(0.15, 0.9, 7)
    pts = world[:, None, :] + (closest - world)[:, None, :] * steps[None, :, None]
    outside = (~inside(pts)).mean(1)
    dist[:, b] = d * (1 + 4 * outside)
order = np.argsort(dist, 1)[:, :4]
w = 1.0 / (np.take_along_axis(dist, order, 1) ** 4 + 1e-6)
w[w < w.max(1, keepdims=True) * 0.05] = 0
w /= w.sum(1, keepdims=True)
joints_attr = np.where(w > 0, order, 0).astype(np.uint8); weights_attr = w.astype(np.float32)

# ---- to metres, y up, facing +z
height = world[:, 2].max() - world[:, 2].min(); S = 1.8 / height; floor = world[:, 2].min()
def gl(p): p = np.atleast_2d(p); return np.stack([p[:, 0], p[:, 2] - floor, -p[:, 1]], 1) * S
pos = gl(world).astype(np.float32); jpos = gl(head_pos)
normals = trimesh.Trimesh(pos, faces, process=False).vertex_normals.astype(np.float32)

# ---- a walk: thighs and arms swing, knees bend on the back swing
def quat_x(deg): r = math.radians(deg) / 2; return [math.sin(r), 0.0, 0.0, math.cos(r)]
KEYS = 9; DURATION = 0.9
times = np.linspace(0, DURATION, KEYS).astype(np.float32)
tracks = {}
for k, t in enumerate(times):
    ph = 2 * math.pi * t / DURATION
    for side, sg in (("Left", 1), ("Right", -1)):
        swing = math.sin(ph) * sg
        tracks.setdefault(side + "UpperLeg", []).append(quat_x(-28 * swing))
        tracks.setdefault(side + "LowerLeg", []).append(quat_x(32 * max(0.0, math.sin(ph + sg * math.pi / 2 + (0 if sg > 0 else math.pi)))))
        tracks.setdefault(side + "UpperArm", []).append(quat_x(22 * swing))
        tracks.setdefault(side + "LowerArm", []).append(quat_x(-10 - 8 * max(0.0, swing)))

# ---- write the .glb
chunks, views, accessors = [], [], []
def add(arr, target=None, minmax=False, ctype=5126, kind="SCALAR"):
    data = np.ascontiguousarray(arr).tobytes(); off = sum(len(c) for c in chunks)
    chunks.append(data + b"\x00" * ((4 - len(data) % 4) % 4))
    v = {"buffer": 0, "byteOffset": off, "byteLength": len(data)}
    if target: v["target"] = target
    views.append(v)
    a = {"bufferView": len(views) - 1, "componentType": ctype, "count": len(arr), "type": kind}
    if minmax: a["min"] = np.atleast_1d(np.asarray(arr).min(0)).tolist(); a["max"] = np.atleast_1d(np.asarray(arr).max(0)).tolist()
    accessors.append(a); return len(accessors) - 1
a_pos = add(pos, 34962, True, kind="VEC3"); a_nrm = add(normals, 34962, kind="VEC3")
a_uv = add(np.stack([uv[:, 0], 1 - uv[:, 1]], 1).astype(np.float32), 34962, kind="VEC2")
a_j = add(joints_attr, 34962, ctype=5121, kind="VEC4"); a_w = add(weights_attr, 34962, kind="VEC4")
a_idx = add(faces.astype(np.uint32).reshape(-1), 34963, ctype=5125)
ibm = np.tile(np.eye(4, dtype=np.float32), (len(BONES), 1, 1)); ibm[:, 3, :3] = -jpos  # column-major: translation in the last row
a_ibm = add(ibm.reshape(-1, 16), kind="MAT4")
a_time = add(times, minmax=True)
png = io.BytesIO(); texture.save(png, "PNG"); data = png.getvalue(); off = sum(len(c) for c in chunks)
chunks.append(data + b"\x00" * ((4 - len(data) % 4) % 4)); views.append({"buffer": 0, "byteOffset": off, "byteLength": len(data)}); image_view = len(views) - 1
nodes = [{"name": n, "translation": (jpos[i] - (jpos[parent[i]] if parent[i] >= 0 else 0)).tolist()} for i, n in enumerate(names)]
for i, p in enumerate(parent):
    if p >= 0: nodes[p].setdefault("children", []).append(i)
nodes.append({"name": "Character", "mesh": 0, "skin": 0})
samplers, channels = [], []
for n, q in tracks.items():
    samplers.append({"input": a_time, "output": add(np.array(q, np.float32), kind="VEC4"), "interpolation": "LINEAR"})
    channels.append({"sampler": len(samplers) - 1, "target": {"node": names.index(n), "path": "rotation"}})
gltf = {"asset": {"version": "2.0", "generator": "pixelkiln research rig.py"}, "scene": 0, "scenes": [{"nodes": [0, len(BONES)]}], "nodes": nodes,
        "meshes": [{"primitives": [{"attributes": {"POSITION": a_pos, "NORMAL": a_nrm, "TEXCOORD_0": a_uv, "JOINTS_0": a_j, "WEIGHTS_0": a_w}, "indices": a_idx, "material": 0}]}],
        "skins": [{"joints": list(range(len(BONES))), "skeleton": 0, "inverseBindMatrices": a_ibm}],
        "materials": [{"name": "Sprite", "pbrMetallicRoughness": {"baseColorTexture": {"index": 0}, "metallicFactor": 0, "roughnessFactor": 1}}],
        "textures": [{"source": 0, "sampler": 0}], "images": [{"bufferView": image_view, "mimeType": "image/png"}],
        "samplers": [{"magFilter": 9728, "minFilter": 9728, "wrapS": 33071, "wrapT": 33071}],
        "animations": [{"name": "Walk", "samplers": samplers, "channels": channels}],
        "accessors": accessors, "bufferViews": views, "buffers": [{"byteLength": sum(len(c) for c in chunks)}]}
js = json.dumps(gltf, separators=(",", ":")).encode(); js += b" " * ((4 - len(js) % 4) % 4); binary = b"".join(chunks)
with open(out, "wb") as f:
    f.write(struct.pack("<4sII", b"glTF", 2, 12 + 8 + len(js) + 8 + len(binary)))
    f.write(struct.pack("<I4s", len(js), b"JSON") + js + struct.pack("<I4s", len(binary), b"BIN\x00") + binary)

# ---- preview: pose the mesh ourselves with the same bones and weights, and draw it
def qmat(q):
    x, y, z, s = q
    return np.array([[1 - 2 * (y * y + z * z), 2 * (x * y - z * s), 2 * (x * z + y * s)], [2 * (x * y + z * s), 1 - 2 * (x * x + z * z), 2 * (y * z - x * s)], [2 * (x * z - y * s), 2 * (y * z + x * s), 1 - 2 * (x * x + y * y)]])
def pose(k):
    M = [None] * len(BONES)
    for i in range(len(BONES)):  # parents come before children in BONES
        local = np.eye(4); local[:3, 3] = jpos[i] - (jpos[parent[i]] if parent[i] >= 0 else 0)
        if names[i] in tracks: local[:3, :3] = qmat(tracks[names[i]][k])
        M[i] = local if parent[i] < 0 else M[parent[i]] @ local
    out = np.zeros_like(pos, dtype=np.float64)
    for c in range(4):
        b = joints_attr[:, c]; wt = weights_attr[:, c]
        for i in np.unique(b[wt > 0]):
            m = (b == i) & (wt > 0); skin = M[i].copy(); bind = np.eye(4); bind[:3, 3] = -jpos[i]; skin = skin @ bind
            out[m] += wt[m, None] * (pos[m] @ skin[:3, :3].T + skin[:3, 3])
    return out
if preview:
    CELL = 96; rng = np.random.default_rng(3)
    tex = np.array(texture); TH, TW = tex.shape[:2]
    area = trimesh.Trimesh(pos, faces, process=False).area_faces
    pick = rng.choice(len(faces), 500000, p=area / area.sum()); bary = rng.dirichlet((1, 1, 1), 500000)
    suv = np.einsum("ij,ijk->ik", bary, uv[faces][pick])
    rgb = tex[np.clip(((1 - suv[:, 1]) * TH).astype(int), 0, TH - 1), np.clip((suv[:, 0] * TW).astype(int), 0, TW - 1), :3].astype(np.int64)
    def draw(p, az, bones_at=None):
        m = trimesh.Trimesh(p, faces, process=False); pts = np.einsum("ij,ijk->ik", bary, p[faces][pick]); nrm = m.face_normals[pick]
        th = math.radians(20); ca, sa = math.cos(az), math.sin(az)
        def proj(q):  # y up, camera circling at az, looking slightly down
            x = q[:, 0] * ca - q[:, 2] * sa; d = q[:, 0] * sa + q[:, 2] * ca
            return x, q[:, 1] * math.cos(th) - d * math.sin(th), -(d * math.cos(th) + q[:, 1] * math.sin(th))
        u, v, depth = proj(pts); sc = (CELL - 12) / 1.9
        px = np.floor(u * sc + CELL / 2).astype(int); py = np.floor(CELL - 6 - v * sc).astype(int)
        ok = (px >= 0) & (py >= 0) & (px < CELL) & (py < CELL); cell = py[ok] * CELL + px[ok]
        zmin = np.full(CELL * CELL, np.inf); np.minimum.at(zmin, cell, depth[ok]); front = depth[ok] <= zmin[cell] + 0.04
        light = np.array([-0.5 * ca + 0.55 * sa, 0.67, 0.5 * sa + 0.55 * ca]); light /= np.linalg.norm(light)
        band = np.where(nrm @ light > 0.35, 1.0, np.where(nrm @ light > -0.1, 0.82, 0.64))
        col = np.clip(rgb * band[:, None], 0, 255).astype(np.int64)[ok]; key = (col[:, 0] << 16) | (col[:, 1] << 8) | col[:, 2]
        combo, counts = np.unique(cell[front] * (1 << 24) + key[front], return_counts=True); cells, keys = combo >> 24, combo & 0xFFFFFF
        o = np.lexsort((counts, cells)); last = np.r_[cells[o][1:] != cells[o][:-1], True]
        img = np.zeros((CELL * CELL, 4), np.uint8); c, k = cells[o][last], keys[o][last]
        img[c] = np.stack([k >> 16, (k >> 8) & 255, k & 255, np.full(len(k), 255)], 1); img = img.reshape(CELL, CELL, 4)
        a = np.pad(img[:, :, 3] > 0, 1); edge = (img[:, :, 3] > 0) & ~(a[:-2, 1:-1] & a[2:, 1:-1] & a[1:-1, :-2] & a[1:-1, 2:])
        img[edge, :3] = (img[edge, :3] * 0.21).astype(np.uint8)
        return img
    frames = [0, 1, 2, 3, 4, 5, 6, 7]
    sheet = np.zeros((CELL * 3, CELL * 8, 4), np.uint8)
    for col, k in enumerate(frames):
        p = pose(k)
        sheet[:CELL, col * CELL:(col + 1) * CELL] = draw(p, math.radians(0))
        sheet[CELL:2 * CELL, col * CELL:(col + 1) * CELL] = draw(p, math.radians(60))
        sheet[2 * CELL:, col * CELL:(col + 1) * CELL] = draw(p, math.radians(90))
    Image.fromarray(sheet).save(preview)
    # Which bone owns each vertex, as a picture: the bind pose coloured by its strongest bone.
    palette = (np.array([[230, 80, 80], [230, 160, 60], [220, 220, 70], [120, 210, 80], [70, 200, 200], [80, 130, 230], [150, 90, 220], [220, 90, 190]]))
    owner = joints_attr[np.arange(len(pos)), weights_attr.argmax(1)]
    rgb = palette[owner % 8][faces[pick][:, 0]].astype(np.int64)
    Image.fromarray(np.hstack([draw(pos.astype(np.float64), math.radians(a)) for a in (0, 60, 180, 240)])).save(preview.replace(".png", ".weights.png"))
print(json.dumps({"out": out, "vertices": len(pos), "triangles": len(faces), "bones": names, "heightMetres": 1.8, "animation": "Walk", "keys": KEYS,
                  "bytes": 12 + 8 + len(js) + 8 + len(binary), "maxInfluences": int((weights_attr > 0).sum(1).max())}))
