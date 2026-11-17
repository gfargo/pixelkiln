"""Give a textured character mesh a skeleton, skin it, add a walk, and write a rigged .glb.

usage: rig.py <name.textured.glb> <name.rig.json> <name.vox> <name.camera.json> <out.glb> [preview.png]

The .glb comes from texture.py, the rig from carve.ts run with an anchors file (the 18 joints PixelLab
estimates in each view, triangulated to 3D), the voxels and camera from carve.ts with DUMP=1.
Needs numpy, pillow, trimesh.

The skeleton is fifteen bones named the way game engines name a humanoid (Hips, Spine, Head, LeftUpperArm ...).
Skin weights come from distance to each bone. Given the carved voxels, that is straight-line distance with a
penalty when the line leaves the body, so an arm hanging beside the torso is not pulled along by the spine.
Given "-" for the voxels, the mesh itself is filled in and distance is measured through the inside of the body:
a cape then belongs to the shoulders it hangs from, not to the legs it hangs beside. The limb joints are also
moved to the middle of the mesh's own limbs, since the joints were found on the sprites and the mesh is a redraw.
The rest pose is whatever pose the mesh is in. The walk lowers raised arms to the sides first.
The file is in metres, y up, facing +z, about 1.8 m tall, with one animation called Walk.

Environment:
  ITEMS    separate meshes the character wears, in the body's frame, each put on the same skeleton as its own
           mesh: "Helm=helm.glb:Head;Cape=cape.glb:Hips,Spine;Cuirass=cuirass.glb". The names after the colon are
           the only bones that item may follow; with none it follows whatever the body under it follows.
  FIT      how far above the skin an item is moved when it lands inside the body, in sprite pixels (default 0.6; 0 is off)
  BURIED   how deep an inward-facing item triangle must be to be dropped (default 1.5)
  TEX      shrink textures to this many pixels a side
  PALETTE  <sprite-dir>:<name>, the sprites whose colours are stored on the materials; COLOURS of them (default 24)
  CELL     the size of each preview picture
"""
import io, json, math, os, struct, sys
import numpy as np
from scipy.ndimage import binary_fill_holes, distance_transform_edt, map_coordinates
from scipy.sparse import coo_matrix
from scipy.sparse.csgraph import dijkstra
from scipy.spatial import cKDTree
from PIL import Image
import trimesh

glb_in, rig_file, vox_file, cam_file, out = sys.argv[1:6]
preview = sys.argv[6] if len(sys.argv) > 6 else None

mesh = trimesh.load(glb_in, force="mesh", process=False)
g = np.asarray(mesh.vertices, np.float64); faces = np.asarray(mesh.faces)
uv = np.asarray(mesh.visual.uv, np.float64)
texture = mesh.visual.material.baseColorTexture.convert("RGBA")
if os.environ.get("TEX"):  # shrink the texture to this many pixels a side, to keep the file small
    texture = texture.resize((int(os.environ["TEX"]),) * 2, Image.LANCZOS)
world = np.stack([g[:, 0], -g[:, 2], g[:, 1]], 1)  # glTF (x, up, -y) back to the sprites' frame (x, y, up)
GEODESIC = vox_file == "-"
J = {j["label"]: np.array([j["x"], j["y"], j["z"]]) for j in json.load(open(rig_file))["joints"]}
if GEODESIC:
    # Fill the mesh in on a grid of half sprite pixels: mark the cells its surface passes through, then the cells they enclose.
    G = 0.5; low = world.min(0) - 2
    shape = np.ceil((world.max(0) + 2 - low) / G).astype(int)
    surface, _ = trimesh.sample.sample_surface(trimesh.Trimesh(world, faces, process=False), 3000000, seed=4)
    solid = np.zeros(shape, bool); cells = ((surface - low) / G).astype(int); solid[cells[:, 0], cells[:, 1], cells[:, 2]] = True
    solid = binary_fill_holes(solid)
    solid_at = np.argwhere(solid); centres = (solid_at + 0.5) * G + low; solid_tree = cKDTree(centres)
    for label in J:  # move elbows, wrists, knees and ankles to the middle of the limb they are in
        if label.split()[-1] in ("ELBOW", "ARM", "KNEE", "LEG"):
            for _ in range(4):
                near = solid_tree.query_ball_point(J[label], 4.0)
                if len(near) < 20: near = solid_tree.query(J[label], 60)[1]
                J[label] = centres[near].mean(0)
else:
    cam = json.load(open(cam_file)); N = cam["size"]
    vox = np.fromfile(vox_file, np.uint8).reshape(N, N, N) > 0
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
if GEODESIC:
    number = -np.ones(shape, int); number[solid] = np.arange(len(solid_at))
    rows, cols, steps_len = [], [], []
    for dx in (-1, 0, 1):
        for dy in (-1, 0, 1):
            for dz in (0, 1):
                if (dz, dy, dx) <= (0, 0, 0): continue
                a = number[max(0, -dx):shape[0] - max(0, dx), max(0, -dy):shape[1] - max(0, dy), :shape[2] - dz]
                c = number[max(0, dx):shape[0] - max(0, -dx), max(0, dy):shape[1] - max(0, -dy), dz:]
                both = (a >= 0) & (c >= 0)
                rows.append(a[both]); cols.append(c[both]); steps_len.append(np.full(both.sum(), G * math.sqrt(dx * dx + dy * dy + dz * dz)))
    graph = coo_matrix((np.concatenate(steps_len), (np.concatenate(rows), np.concatenate(cols))), shape=(len(solid_at),) * 2).tocsr()
    at = solid_tree.query(world)[1]
    through = np.zeros((len(BONES), len(solid_at)))  # from every cell inside the body to each bone, for the items
    for b in range(len(BONES)):
        along = head_pos[b] + (tail_pos[b] - head_pos[b]) * np.linspace(0, 1, 24)[:, None]
        gap, seeds = solid_tree.query(along)
        seeds = np.unique(seeds[gap < 1.5]) if (gap < 1.5).any() else np.unique(seeds)
        through[b] = dijkstra(graph, directed=False, indices=seeds, min_only=True)
        dist[:, b] = through[b][at] + 0.5
    dist[~np.isfinite(dist)] = 1e6; through[~np.isfinite(through)] = 1e6
for b in range(len(BONES) if not GEODESIC else 0):
    a, c = head_pos[b], tail_pos[b]; ab = c - a
    t = np.clip(((world - a) @ ab) / (ab @ ab + 1e-9), 0, 1)
    closest = a + t[:, None] * ab
    d = np.linalg.norm(world - closest, axis=1)
    # Walk the line from just inside the surface to the bone; count the share of it that is outside the body.
    steps = np.linspace(0.15, 0.9, 7)
    pts = world[:, None, :] + (closest - world)[:, None, :] * steps[None, :, None]
    outside = (~inside(pts)).mean(1)
    dist[:, b] = d * (1 + 4 * outside)
# Anything above the ears is head: horns and hats reach out past the body and would otherwise follow an arm.
dist[world[:, 2] > head[2], names.index("Head")] = 1e-3
def skin(dist):
    order = np.argsort(dist, 1)[:, :4]
    w = 1.0 / (np.take_along_axis(dist, order, 1) ** 4 + 1e-6)
    w[w < w.max(1, keepdims=True) * 0.05] = 0
    w /= w.sum(1, keepdims=True)
    return np.where(w > 0, order, 0).astype(np.uint8), w.astype(np.float32)
joints_attr, weights_attr = skin(dist)

# ---- items: separate meshes in the body's frame, skinned to the body's bones
# ITEMS="helm=helm.textured.glb:Head;cape=cape.textured.glb:Hips,Spine". An item vertex takes its distances from
# the nearest point inside the body, plus the gap to it, and may only follow the bones its slot names: a cape
# hangs from the spine however close it comes to a leg.
ITEMS = []
FIT = float(os.environ.get("FIT", "0.6")); BURIED = float(os.environ.get("BURIED", "1.5"))
if os.environ.get("ITEMS") and GEODESIC:
    # How far each point is outside the body (negative inside), on the same grid, and which way is out.
    sdf = (distance_transform_edt(~solid) - distance_transform_edt(solid)) * G
    slope = np.gradient(sdf, G)
    def body_distance(p):
        at_cell = ((p - low) / G - 0.5).T
        d = map_coordinates(sdf, at_cell, order=1, mode="nearest")
        n = np.stack([map_coordinates(s_, at_cell, order=1, mode="nearest") for s_ in slope], 1)
        return d, n / (np.linalg.norm(n, axis=1, keepdims=True) + 1e-9)
for spec in filter(None, os.environ.get("ITEMS", "").split(";")):
    if not GEODESIC: sys.exit("ITEMS needs the weights measured through the mesh: pass - for the voxels")
    label, rest = spec.split("=", 1); file, _, allowed = rest.partition(":")
    part = trimesh.load(file, force="mesh", process=False)
    pg = np.asarray(part.vertices, np.float64); pw = np.stack([pg[:, 0], -pg[:, 2], pg[:, 1]], 1)
    pf = np.asarray(part.faces); puv = np.asarray(part.visual.uv, np.float64)
    if FIT > 0:
        # An item is drawn a pixel outside the body and meshed on its own, so some of it lands inside the
        # body's mesh. Drop the triangles buried deep in the body that face inward, which nobody can see, and move what is
        # left out to just above the skin. FIT is how far above, in sprite pixels; 0 leaves the item alone.
        depth, outward = body_distance(pw)
        facing = np.einsum("ij,ij->i", trimesh.Trimesh(pw, pf, process=False).face_normals, outward[pf].mean(1))
        # A buried triangle that faces the way out of the body is the item's outside, drawn too small: keep it.
        pf = pf[~((depth[pf] < -BURIED).all(1) & (facing < 0.3))]
        used, index = np.unique(pf, return_inverse=True); pw, puv, pf = pw[used], puv[used], index.reshape(-1, 3)
        first = body_distance(pw)[0]
        want = np.clip(FIT + 0.08 * first, 0.15, FIT)  # what was deeper stays underneath what was above it
        for _ in range(6):
            d, n = body_distance(pw); short = np.maximum(want - d, 0)
            pw = pw + n * short[:, None]
    gap, cell = solid_tree.query(pw)
    pd = through[:, cell].T + gap[:, None] + 0.5
    if allowed:
        banned = [i for i, n in enumerate(names) if n not in allowed.split(",")]
        if len(banned) == len(names): sys.exit(f"{label}: none of {allowed} is a bone; bones are {names}")
        pd[:, banned] = 1e9
    pj, pwt = skin(pd)
    ptex = part.visual.material.baseColorTexture.convert("RGBA")
    if os.environ.get("TEX"): ptex = ptex.resize((int(os.environ["TEX"]),) * 2, Image.LANCZOS)
    ITEMS.append({"name": label, "world": pw, "faces": pf, "uv": puv, "joints": pj, "weights": pwt, "texture": ptex})

# ---- to metres, y up, facing +z
height = world[:, 2].max() - world[:, 2].min(); S = 1.8 / height; floor = world[:, 2].min()
def gl(p): p = np.atleast_2d(p); return np.stack([p[:, 0], p[:, 2] - floor, -p[:, 1]], 1) * S
pos = gl(world).astype(np.float32); jpos = gl(head_pos)
normals = trimesh.Trimesh(pos, faces, process=False).vertex_normals.astype(np.float32)

# ---- a walk: thighs and arms swing, knees bend on the back swing
def quat_x(deg): r = math.radians(deg) / 2; return [math.sin(r), 0.0, 0.0, math.cos(r)]
def quat_mul(p, q):  # the rotation q, then the rotation p
    px, py, pz, pw = p; qx, qy, qz, qw = q
    return [pw * qx + px * qw + py * qz - pz * qy, pw * qy - px * qz + py * qw + pz * qx, pw * qz + px * qy - py * qx + pz * qw, pw * qw - px * qx - py * qy - pz * qz]
def quat_between(a, b):
    a, b = a / np.linalg.norm(a), b / np.linalg.norm(b); axis = np.cross(a, b); s = np.linalg.norm(axis)
    if s < 1e-6: return [0.0, 0.0, 0.0, 1.0]
    half = math.atan2(s, float(a @ b)) / 2; axis = axis / s * math.sin(half)
    return [float(axis[0]), float(axis[1]), float(axis[2]), math.cos(half)]
# A mesh made in an A-pose or T-pose walks with its arms out unless they are lowered first: turn each upper arm
# from where it rests to hanging 12 degrees out from straight down.
lower = {}
for side, sg in (("Left", 1), ("Right", -1)):
    i = names.index(side + "UpperArm"); rest = gl(tail_pos[i])[0] - gl(head_pos[i])[0]
    out_sign = 1.0 if rest[0] >= 0 else -1.0
    hang = np.array([out_sign * math.sin(math.radians(12)), -math.cos(math.radians(12)), 0.0])
    lower[side] = quat_between(rest, hang) if math.degrees(math.acos(np.clip(rest @ hang / np.linalg.norm(rest), -1, 1))) > 15 else [0.0, 0.0, 0.0, 1.0]
KEYS = 9; DURATION = 0.9
times = np.linspace(0, DURATION, KEYS).astype(np.float32)
tracks = {}
for k, t in enumerate(times):
    ph = 2 * math.pi * t / DURATION
    for side, sg in (("Left", 1), ("Right", -1)):
        swing = math.sin(ph) * sg
        tracks.setdefault(side + "UpperLeg", []).append(quat_x(-28 * swing))
        tracks.setdefault(side + "LowerLeg", []).append(quat_x(32 * max(0.0, math.sin(ph + sg * math.pi / 2 + (0 if sg > 0 else math.pi)))))
        tracks.setdefault(side + "UpperArm", []).append(quat_mul(quat_x(22 * swing), lower[side]))
        down = lower[side]; up = [-down[0], -down[1], -down[2], down[3]]  # the elbow bends forward as seen with the arm lowered
        tracks.setdefault(side + "LowerArm", []).append(quat_mul(up, quat_mul(quat_x(-10 - 8 * max(0.0, swing)), down)))

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


# PALETTE=<sprite-dir>:<name> stores the sprites' colours on the material (COLOURS of them, default 24), so a
# renderer can snap its pixels to them.
PALETTE = None
if os.environ.get("PALETTE"):
    sprite_dir, sprite_name = os.environ["PALETTE"].split(":")
    px = np.concatenate([(lambda a: a[a[:, :, 3] > 127][:, :3])(np.array(Image.open(os.path.join(sprite_dir, f)).convert("RGBA")))
                         for f in sorted(os.listdir(sprite_dir)) if f.startswith(sprite_name + "-") and f.endswith(".png")])
    count = int(os.environ.get("COLOURS", "24"))
    PALETTE = sorted({"#%02x%02x%02x" % tuple(int(round(v)) for v in c) for c in pick_palette(px, count)})

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
PARTS = [{"name": "Character", "pos": pos, "normals": normals, "uv": uv, "faces": faces, "joints": joints_attr, "weights": weights_attr, "texture": texture}]
for item in ITEMS:
    ipos = gl(item["world"]).astype(np.float32)
    PARTS.append({**item, "pos": ipos, "normals": trimesh.Trimesh(ipos, item["faces"], process=False).vertex_normals.astype(np.float32)})
for part in PARTS:
    part["attributes"] = {"POSITION": add(part["pos"], 34962, True, kind="VEC3"), "NORMAL": add(part["normals"], 34962, kind="VEC3"),
                          "TEXCOORD_0": add(np.stack([part["uv"][:, 0], 1 - part["uv"][:, 1]], 1).astype(np.float32), 34962, kind="VEC2"),
                          "JOINTS_0": add(part["joints"], 34962, ctype=5121, kind="VEC4"), "WEIGHTS_0": add(part["weights"], 34962, kind="VEC4")}
    part["indices"] = add(part["faces"].astype(np.uint32).reshape(-1), 34963, ctype=5125)
ibm = np.tile(np.eye(4, dtype=np.float32), (len(BONES), 1, 1)); ibm[:, 3, :3] = -jpos  # column-major: translation in the last row
a_ibm = add(ibm.reshape(-1, 16), kind="MAT4")
a_time = add(times, minmax=True)
for part in PARTS:
    png = io.BytesIO(); part["texture"].save(png, "PNG"); data = png.getvalue(); off = sum(len(c) for c in chunks)
    chunks.append(data + b"\x00" * ((4 - len(data) % 4) % 4)); views.append({"buffer": 0, "byteOffset": off, "byteLength": len(data)}); part["image"] = len(views) - 1
nodes = [{"name": n, "translation": (jpos[i] - (jpos[parent[i]] if parent[i] >= 0 else 0)).tolist()} for i, n in enumerate(names)]
for i, p in enumerate(parent):
    if p >= 0: nodes[p].setdefault("children", []).append(i)
for i, part in enumerate(PARTS): nodes.append({"name": part["name"], "mesh": i, "skin": 0})
samplers, channels = [], []
for n, q in tracks.items():
    samplers.append({"input": a_time, "output": add(np.array(q, np.float32), kind="VEC4"), "interpolation": "LINEAR"})
    channels.append({"sampler": len(samplers) - 1, "target": {"node": names.index(n), "path": "rotation"}})
gltf = {"asset": {"version": "2.0", "generator": "pixelkiln research rig.py"}, "scene": 0, "scenes": [{"nodes": [0] + [len(BONES) + i for i in range(len(PARTS))]}], "nodes": nodes,
        "meshes": [{"name": p["name"], "primitives": [{"attributes": p["attributes"], "indices": p["indices"], "material": i}]} for i, p in enumerate(PARTS)],
        "skins": [{"joints": list(range(len(BONES))), "skeleton": 0, "inverseBindMatrices": a_ibm}],
        "materials": [{"name": "Sprite" if i == 0 else p["name"], **({"extras": {"palette": PALETTE}} if PALETTE else {}), "pbrMetallicRoughness": {"baseColorTexture": {"index": i}, "metallicFactor": 0, "roughnessFactor": 1}} for i, p in enumerate(PARTS)],
        "textures": [{"source": i, "sampler": 0} for i in range(len(PARTS))], "images": [{"bufferView": p["image"], "mimeType": "image/png"} for p in PARTS],
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
    CELL = int(os.environ.get("CELL", "96")); rng = np.random.default_rng(3)  # CELL: the size of each preview picture
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
print(json.dumps({"out": out, "vertices": len(pos), "triangles": len(faces), "items": {i["name"]: len(i["faces"]) for i in ITEMS}, "bones": names, "heightMetres": 1.8, "animation": "Walk", "keys": KEYS,
                  "bytes": 12 + 8 + len(js) + 8 + len(binary), "maxInfluences": int((weights_attr > 0).sum(1).max())}))
