"""Give a textured character mesh a skeleton, skin it, add a walk, and write a rigged .glb.

usage: rig.py <name.textured.glb> <name.rig.json> <name.vox> <name.camera.json> <out.glb> [preview.png]

The .glb comes from texture.py, the rig from carve.ts run with an anchors file (the 18 joints PixelLab
estimates in each view, triangulated to 3D), the voxels and camera from carve.ts with DUMP=1.
Needs numpy, pillow, trimesh.

The skeleton is twenty-one bones named the way game engines name a humanoid (Hips, Spine, Chest, Neck, Head,
LeftShoulder, LeftUpperArm ... LeftToes), and seven more a hand where the mesh has a thumb to find; BONES=15 gives the first, smaller set without chest, neck, shoulders or toes.
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
           A third field, "loose" ("Cape=cape.glb:Hips,Spine:loose"), marks an item that hides no skin.
           "held" ("Sword=sword.glb:RightHand:held") marks a rigid thing the hand holds: it is turned and placed in
           the grip of that hand, whatever frame its file is in, and follows the hand alone. In a hand drawn as
           a closed fist it runs through the fist, with its guard clear of the fist's side.
           "two-handed" ("Greatsword=greatsword.glb:RightHand:two-handed") is a held thing with room for the
           other hand: the hand named sits under the guard, and a bone <Side>Grip2 marks where the other goes.
           offhand.py then brings the other hand there in every animation.
           "strapped" ("Shield=shield.glb:LeftLowerArm:strapped") marks a rigid, flat thing carried on a forearm.
           Its file must have it upright with its face to the front, as its sprites show it. Its back goes to the
           back of the forearm, its top towards the elbow, and it follows the forearm alone.
  HELD_LENGTH  how long a held item is made, as a share of the body's height (default 0.5)
  GRIP_AT      for a two-handed shaft with no guard: where the leading hand's middle is, as a share of the item's
               length from its butt. Unset, the leading hand sits under the guard.
  GRIP_APART   with GRIP_AT: how far below it the other hand is, as a share of the item's length (default 0.25)
  FIST_LEAN    the angle between a closed fist's hold and its forearm, in degrees, thumb end away from the elbow (default 80)
  STRAPPED_LENGTH  how tall a strapped item is made, as a share of the body's height (default 0.36)
  STRAPPED_TURN    degrees to turn a strapped item about its face, for one carried across the arm (default 0)
  FINGERS  0 leaves out the finger bones. By default a hand whose thumb can be found on the mesh gets a thumb
           of three bones, one chain of three for the fingers, and <Side>Grip, which marks where a grip goes.
           A hand drawn as a closed fist gets <Side>Grip alone, in the middle of the fist.
  COVER    how near an item's surface must be for the skin to count as covered, in sprite pixels (default 1.2)
  ALIGN    1 slides each item to sit evenly round the body before fitting it (default 1; loose items are left)
  CHAINS   bones for hanging items: "Cape=3x4" hangs the item called Cape from three columns of four links,
           named Cape1_1 to Cape3_4, each column parented to the last bone the item is allowed to follow.
           sway.py then makes them swing. CHAIN_TOP is the share of the item, from the top, that stays on the body (default 0.2)
  FIT      how far above the skin an item is moved when it lands inside the body, in sprite pixels (default 0.6; 0 is off)
  BURIED   how deep an inward-facing item triangle must be to be dropped (default 1.5)
  SKIN     also write this .npz for cards.py: the body in the sprites' frame and the bone that owns each vertex
  TEX_ITEM, TEX_NORMAL   the same for items' colour textures and for normal maps, when they should differ from TEX
  JPEG     write textures as JPEG at this quality (for example 90) in place of PNG: far smaller for painted textures
  TEX      shrink textures to this many pixels a side
  PALETTE  <sprite-dir>:<name>, the sprites whose colours are stored on the materials; COLOURS of them (default 24)
  CELL     the size of each preview picture
"""
import io, json, math, os, struct, sys
import numpy as np
from scipy.ndimage import binary_fill_holes, distance_transform_edt, label as connected, map_coordinates
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
def sized(picture, key="TEX"):  # shrink a texture to this many pixels a side, to keep the file small
    if picture is not None and os.environ.get(key) and picture.width > int(os.environ[key]): picture = picture.resize((int(os.environ[key]),) * 2, Image.LANCZOS)
    return picture
texture = sized(mesh.visual.material.baseColorTexture.convert("RGBA"))
relief = sized(getattr(mesh.visual.material, "normalTexture", None), "TEX_NORMAL")  # a normal map, from thin.py
given_normals = np.asarray(mesh.vertex_normals, np.float32) if relief is not None else None  # thin.py's smooth normals, which its normal map was baked against
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

# ---- hands: a thumb and one chain for the fingers, where the mesh has a thumb to find
# A mesh from large sprites has hands like mittens: the four fingers as one slab, and the thumb apart from it.
# That is enough to close a hand round a grip. Each hand is measured on the filled mesh: going back from the
# fingertips, the hand is one piece, then two once the thumb's tip is passed, then one again at the web between
# thumb and fingers. The web is 58% of a hand's length back from the fingertips, which puts the wrist (the joint
# estimated on the sprites sits in the palm), the knuckles 56% of the way along, and the three finger joints.
# The thumb's own line gives its three bones. A hand with no thumb to find gets no finger bones; if it is a closed
# fist it still gets a wrist and a grip (below).
def hand(side, s):
    along_line = lambda p, q, share: p + (q - p) * share
    el, wr = J[s + " ELBOW"], J[s + " ARM"]; forearm = np.linalg.norm(wr - el); a = (wr - el) / forearm
    rel = centres - wr; t = rel @ a
    near = np.nonzero((t > -0.9 * forearm) & (t < 1.6 * forearm) & (np.linalg.norm(rel - np.outer(t, a), axis=1) < 0.8 * forearm))[0]
    def pieces(index):  # the cells given, as connected pieces, largest first
        volume = np.zeros(shape, bool); cell = solid_at[index]; volume[cell[:, 0], cell[:, 1], cell[:, 2]] = True
        labels = connected(volume)[0][cell[:, 0], cell[:, 1], cell[:, 2]]
        return [index[labels == k] for k in np.argsort(-np.bincount(labels)) if k > 0 and (labels == k).sum() >= 12]
    arm = next((piece for piece in pieces(near) if np.linalg.norm(centres[piece] - wr, axis=1).min() < 1.5), None)
    if arm is None: return None
    along = (centres[arm] - wr) @ a; tip_t = along.max(); thumb = fingers = None; thumb_tip = web = None
    for back in np.arange(tip_t - 0.5, -0.3 * forearm, -0.25):
        apart = pieces(arm[along > back])
        if len(apart) >= 2:
            if thumb_tip is None: thumb_tip = back
            fingers = max(apart, key=lambda piece: ((centres[piece] - wr) @ a).max()); thumb = max((piece for piece in apart if piece is not fingers), key=len); web = back
        elif thumb is not None: break
    if thumb is None or thumb_tip - web < 1.0:
        # A hand drawn closed. There is no thumb to find, so no finger bones, but a fist already has the shape of a
        # hold. Going back from the knuckles its cross-section grows to the fist's thickest place and then shrinks
        # to the wrist, the narrowest place before the forearm widens again. The grip goes through the middle of the
        # fist along its wider side where that runs front to back, and leaves towards the front, as the thumb's side of a
        # fist held out palm down does. A fist too round to have a wider side takes the front as it is.
        steps = np.arange(tip_t, along.min() + 1, -1.0); count = np.array([((along <= hi) & (along > hi - 1)).sum() for hi in steps])
        peak = k = int(count[:max(3, int(0.7 * forearm))].argmax())
        while k + 1 < len(count) and count[k + 1] <= count[k] * 1.03: k += 1
        if k + 1 == len(count) or count[peak] < 1.4 * count[k]: return None
        wrist_t = steps[k] - 0.5; length = tip_t - wrist_t; wrist = centres[arm[np.abs(along - wrist_t) <= 0.6]].mean(0)
        ball = centres[arm[along > wrist_t + 0.35 * length]]; centre = ball.mean(0); f = (centre - wrist) / np.linalg.norm(centre - wrist)
        flat = ball - centre; flat = flat - np.outer(flat @ f, f); size, axis = np.linalg.eigh(flat.T @ flat / len(flat))
        front = np.array([0, -1.0, 0]) - f * -f[1]; front /= np.linalg.norm(front); across = axis[:, 2] * np.sign(axis[:, 2] @ front)
        if size[2] < 1.5 * size[1] or across @ front < 0.7: across = front  # too round to tell, or not lying the way the animations expect
        reach = flat @ across; centre = centre + across * (reach.max() + reach.min()) / 2
        # A hand closed on a handle holds it a little short of square to the forearm, the thumb's end further from the
        # elbow. A fist's own shape says nothing reliable about that lean, so it is set.
        square = across - a * (across @ a); square /= np.linalg.norm(square); lean = np.radians(float(os.environ.get("FIST_LEAN", "80")))
        across = square * np.sin(lean) + a * np.cos(lean)
        return {"wrist": wrist, "fingers": [wrist + f * length], "grip": centre, "fist": (reach.max() - reach.min()) / 2,
                "palm": (lambda n: n / np.linalg.norm(n))(np.cross(f, across)) * (1 if side == "Left" else -1), "across": across, "along": f, "length": length}
    length = float(np.clip((tip_t - web) / 0.58, tip_t - web + 1, tip_t + 0.35 * forearm)); wrist_t = tip_t - length
    def slab(at, index=arm):  # the middle of the hand, or of one piece of it, at this distance along
        d = np.abs((centres[index] - wr) @ a - at); return centres[index[d <= max(0.6, d.min() + 0.1)]].mean(0)
    wrist = slab(wrist_t); knuckle_t = max(wrist_t + 0.56 * length, web + 0.25); reach = tip_t - knuckle_t
    knuckle = slab(knuckle_t, fingers); end = slab(tip_t - 0.4, fingers); end = end + a * (tip_t - (end - wr) @ a)
    c = centres[thumb].mean(0); out_side = c - wrist - a * ((c - wrist) @ a)  # from the hand's middle line to the thumb's side of it
    cmc = wrist + a * 0.12 * length + out_side * 0.45; cmc = centres[solid_tree.query(cmc)[1]]
    thumb_end = centres[thumb][np.linalg.norm(centres[thumb] - cmc, axis=1).argmax()]
    inner = lambda q: centres[solid_tree.query_ball_point(q, 1.0)].mean(0) if solid_tree.query_ball_point(q, 1.0) else q  # towards the middle of the flesh
    mcp, ip = inner(along_line(cmc, thumb_end, 0.5)), inner(along_line(cmc, thumb_end, 0.76))
    f = (knuckle - wrist) / np.linalg.norm(knuckle - wrist); across = out_side - f * (out_side @ f); across /= np.linalg.norm(across)
    palm = np.cross(f, across) * (1 if side == "Left" else -1)  # the way the palm faces
    hold = slab(wrist_t + 0.5 * length); under = hold.copy()
    while solid_tree.query(under)[0] < G: under = under + palm * 0.25  # out through the palm's skin
    return {"wrist": wrist, "fingers": [knuckle, slab(knuckle_t + 0.45 * reach, fingers), slab(knuckle_t + 0.75 * reach, fingers), end],
            "thumb": [cmc, mcp, ip, thumb_end], "grip": under + palm * 0.09 * length, "palm": palm, "across": across, "along": f, "length": length}
HANDS = {}
if GEODESIC and os.environ.get("BONES", "humanoid") != "15" and os.environ.get("FINGERS", "1") != "0":
    for side, s in (("Left", "LEFT"), ("Right", "RIGHT")):
        found = hand(side, s)
        if found is None: print(f"{side} hand: no thumb apart from the fingers and no fist, so no finger bones and no grip", file=sys.stderr); continue
        if "fist" in found: print(f"{side} hand: a closed fist {found['length']:.1f} sprite pixels long and {2 * found['fist']:.1f} across, so a grip but no finger bones; wrist moved {np.linalg.norm(found['wrist'] - J[s + ' ARM']):.1f}", file=sys.stderr)
        else: print(f"{side} hand: {found['length']:.1f} sprite pixels long, wrist moved {np.linalg.norm(found['wrist'] - J[s + ' ARM']):.1f}", file=sys.stderr)
        HANDS[side] = found; J[s + " ARM"] = found["wrist"]

# name, parent, where the joint is, where its bone ends
# BONES=15 is the first skeleton of this note. The default adds the bones a standard humanoid has besides
# (chest, neck, shoulders, toes), under the names Unity's and Godot's humanoid profiles use, so that an engine
# can map the skeleton by name and put its stock animations on it.
FULL = os.environ.get("BONES", "humanoid") != "15"
along = lambda a, b, t: a + (b - a) * t
if FULL:
    floor_z = world[:, 2].min(); head_base = along(neck, head, 0.45)
    BONES = [("Hips", None, hips, along(hips, neck, 0.3)), ("Spine", "Hips", along(hips, neck, 0.3), along(hips, neck, 0.62)),
             ("Chest", "Spine", along(hips, neck, 0.62), neck), ("Neck", "Chest", neck, head_base), ("Head", "Neck", head_base, top)]
else:
    BONES = [("Hips", None, hips, mid(hips, neck)), ("Spine", "Hips", mid(hips, neck), neck), ("Head", "Spine", neck, top)]
for side, s in (("Left", "LEFT"), ("Right", "RIGHT")):
    sh, el, wr = J[s + " SHOULDER"], J[s + " ELBOW"], J[s + " ARM"]
    hp, kn, an = J[s + " HIP"], J[s + " KNEE"], J[s + " LEG"]
    arm_root = "Spine"
    if FULL:
        collar = along(neck, sh, 0.3) - np.array([0, 0, 0.08 * np.linalg.norm(neck - hips)])
        BONES.append((side + "Shoulder", "Chest", collar, sh)); arm_root = side + "Shoulder"
    BONES += [(side + "UpperArm", arm_root, sh, el), (side + "LowerArm", side + "UpperArm", el, wr), (side + "Hand", side + "LowerArm", wr, HANDS[side]["fingers"][0] if side in HANDS else past(el, wr, 3)),
              (side + "UpperLeg", "Hips", hp, kn), (side + "LowerLeg", side + "UpperLeg", kn, an)]
    if FULL:
        ball = np.array([an[0], an[1] - 0.55 * (an[2] - floor_z) - 1.0, floor_z + 0.25 * (an[2] - floor_z)])  # the ball of the foot, ahead of the ankle
        BONES += [(side + "Foot", side + "LowerLeg", an, ball), (side + "Toes", side + "Foot", ball, ball + np.array([0, -0.6 * np.linalg.norm(ball - an), 0]))]
    else:
        BONES.append((side + "Foot", side + "LowerLeg", an, an + down * 3 + np.array([0, -2.0, 0])))
# Finger bones come after the body's twenty-one, under the names the humanoid profiles give them. The fingers'
# one chain takes the middle finger's names. <Side>Grip carries no skin: it marks where a held thing's grip goes.
NO_SKIN = set()
for side, found in HANDS.items():
    for chain, parts in (("Thumb", ("Metacarpal", "Proximal", "Distal")), ("Middle", ("Proximal", "Intermediate", "Distal"))):
        if "fist" in found: continue
        joints = found["thumb" if chain == "Thumb" else "fingers"]
        for k, part in enumerate(parts): BONES.append((side + chain + part, side + (chain + parts[k - 1] if k else "Hand"), joints[k], joints[k + 1]))
    BONES.append((side + "Grip", side + "Hand", found["grip"], found["grip"] + found["across"])); NO_SKIN.add(side + "Grip")
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
        if names[b] in NO_SKIN: through[b] = np.inf; dist[:, b] = np.inf; continue
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
in_file = lambda v: [float(v[0]), float(v[2]), float(-v[1])]  # a direction in the sprites' frame, as the file has it
NODE_EXTRAS = {side + "Grip": {"across": in_file(found["across"]), "palm": in_file(found["palm"])} for side, found in HANDS.items()}  # what offhand.py needs to turn a hand onto a grip
EXTRA = []  # bones added for hanging items: (name, parent index, joint, end), in the sprites' frame
# CHAINS="Cape=3x4" gives the item called Cape three columns of four links to hang from.
CHAINS = {label: tuple(int(n) for n in shape.split("x")) for label, shape in (entry.split("=") for entry in filter(None, os.environ.get("CHAINS", "").split(";")))}
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
    label, rest = spec.split("=", 1); file, _, allowed = rest.partition(":"); allowed, _, fit_kind = allowed.partition(":")
    part = trimesh.load(file, force="mesh", process=False)
    pg = np.asarray(part.vertices, np.float64); pw = np.stack([pg[:, 0], -pg[:, 2], pg[:, 1]], 1)
    pf = np.asarray(part.faces); puv = np.asarray(part.visual.uv, np.float64)
    prelief = sized(getattr(part.visual.material, "normalTexture", None), "TEX_NORMAL")
    pnormals = np.asarray(part.vertex_normals, np.float32) if prelief is not None else None
    held = fit_kind in ("held", "two-handed")
    if held:
        # A held thing (a sword) is rigid and comes in a frame of its own. Its longest line is laid across the
        # palm, leaving on the thumb's side; its flat faces the way the fingers point; the grip, half way between
        # the end and the widest place nearest an end (the guard), goes to the hand's <Side>Grip. It follows the
        # hand alone, and the fingers close round it in any animation that makes a fist.
        side = allowed.replace("Hand", "")
        if side not in HANDS: sys.exit(f"{label}: held items need a hand with a grip (finger bones, or a closed fist), as LeftHand or RightHand; found {sorted(HANDS)}")
        grasp = HANDS[side]; centre = pw.mean(0); axes = np.linalg.svd(pw - centre, full_matrices=False)[2]
        run = (pw - centre) @ axes[0]; wide = np.abs((pw - centre) @ axes[1]); steps = np.linspace(run.min(), run.max(), 41)
        guard = steps[np.argmax([wide[(run >= lo) & (run <= hi)].max(initial=0) for lo, hi in zip(steps[:-1], steps[1:])])]
        if guard - run.min() > run.max() - guard: axes[0] = -axes[0]; run = -run; guard = -guard
        if fit_kind == "two-handed" and os.environ.get("GRIP_AT"): axes[0] = -axes[0]; run = -run; guard = -guard  # a shaft's widest place is its head, not a guard by the butt
        size = float(os.environ.get("HELD_LENGTH", "0.5")) * (world[:, 2].max() - world[:, 2].min()) / (run.max() - run.min())
        turn = np.stack([grasp["across"], grasp["along"], np.cross(grasp["across"], grasp["along"])], 1) @ np.stack([axes[0], axes[1], np.cross(axes[0], axes[1])], 1).T
        pw = (pw - centre - axes[0] * (run.min() + guard) / 2) * size @ turn.T + grasp["grip"]
        if "fist" in grasp:  # the grip runs through a fist, so the guard has to clear the fist's side
            pw = pw + grasp["across"] * max(0, grasp["fist"] + 0.5 - (guard - run.min()) / 2 * size)
        if fit_kind == "two-handed":
            # Two hands on one grip. The hand named leads and sits just under the guard; the other goes under it,
            # towards the pommel. Where the other hand goes is written into the file as a bone, <Side>Grip2, on the
            # leading hand: it has no skin, and offhand.py brings the other hand to it in every animation.
            other = "Left" if side == "Right" else "Right"
            if other not in HANDS: sys.exit(f"{label}: the {other.lower()} hand has no grip to put on it")
            breadth = lambda h: 2 * h["fist"] if "fist" in h else 0.7 * h["length"]  # how much of a handle a hand covers
            first, second = breadth(grasp), breadth(HANDS[other]); handle = (guard - run.min()) * size
            down = min(first / 2 + 0.5 + first / 2 + second / 2 + 0.3, max(first / 2 + 0.5, 0.9 * handle - second / 2))  # the second hand's middle, below the guard
            pw = pw + grasp["across"] * (first / 2 + 0.5 - ((pw - grasp["grip"]) @ grasp["across"]).max() + (run.max() - guard) * size)
            below = grasp["grip"] - grasp["across"] * (down - first / 2 - 0.5)
            if os.environ.get("GRIP_AT"):
                # A shaft (a spear, a staff) has no guard to sit under, and its hands go apart. GRIP_AT says where the
                # leading hand's middle is, as a share of the item's length from its butt; GRIP_APART how far the
                # other hand is below it, as a share of that length.
                reach = (pw - grasp["grip"]) @ grasp["across"]; whole = reach.max() - reach.min()
                pw = pw - grasp["across"] * (reach.min() + float(os.environ["GRIP_AT"]) * whole)
                apart = float(os.environ.get("GRIP_APART", "0.25")) * whole; below = grasp["grip"] - grasp["across"] * apart
                print(f"{label}: hands {apart:.1f} sprite pixels apart on a shaft {whole:.1f} long", file=sys.stderr)
            EXTRA.append((side + "Grip2", names.index(allowed), below, below + grasp["across"]))
            NODE_EXTRAS[side + "Grip2"] = {"hand": other + "Hand", "handle": in_file(grasp["across"])}
            if not os.environ.get("GRIP_AT"): print(f"{label}: a handle {handle:.1f} sprite pixels long for hands {first:.1f} and {second:.1f} across" + ("" if handle >= first + second + 1.5 else ", too short for both, so they overlap"), file=sys.stderr)
        prelief = pnormals = None
    strapped = fit_kind == "strapped"
    if strapped:
        # A flat thing carried on the forearm (a shield). Its file has it as it was drawn: upright, its face to the
        # viewer. Its thinnest direction is its face's normal, and that goes to the back of the forearm, which is
        # the side away from the palm (straight up on a body drawn arms out, where no palm was found). Its top goes
        # towards the elbow, so that it is upright when the arm hangs. Its back sits just off the arm's surface.
        if not allowed.endswith("LowerArm"): sys.exit(f"{label}: strapped items go on LeftLowerArm or RightLowerArm")
        b = names.index(allowed); side = allowed.replace("LowerArm", ""); elbow, wrist = head_pos[b], tail_pos[b]
        line = (wrist - elbow) / np.linalg.norm(wrist - elbow)
        out_way = -HANDS[side]["palm"] if side in HANDS else np.array([0, 0, 1.0]); out_way = out_way - line * (out_way @ line); out_way /= np.linalg.norm(out_way)
        centre = (pw.max(0) + pw.min(0)) / 2; axes = np.linalg.svd(pw - pw.mean(0), full_matrices=False)[2]
        face = axes[2] * (-1 if axes[2][1] > 0 else 1); up = np.array([0, 0, 1.0]) - face * face[2]; up /= np.linalg.norm(up)
        tall = (pw - centre) @ up; size = float(os.environ.get("STRAPPED_LENGTH", "0.36")) * (world[:, 2].max() - world[:, 2].min()) / (tall.max() - tall.min())
        spin = math.radians(float(os.environ.get("STRAPPED_TURN", "0"))); top = -line * math.cos(spin) + np.cross(out_way, -line) * math.sin(spin)
        turn = np.stack([np.cross(top, out_way), top, out_way], 1) @ np.stack([np.cross(up, face), up, face], 1).T
        NODE_EXTRAS[allowed] = {"strapped": label, "face": in_file(out_way), "top": in_file(top)}  # what shield.py needs to pose it
        pw = (pw - centre) * size @ turn.T; middle = np.linalg.norm(pw - np.outer(pw @ out_way, out_way), axis=1) < 0.3 * (tall.max() - tall.min()) * size
        at = elbow + (wrist - elbow) * 0.6; along_arm = (world - elbow) @ line
        arm = world[(along_arm > 0) & (along_arm < np.linalg.norm(wrist - elbow)) & (np.linalg.norm(world - elbow - np.outer(along_arm, line), axis=1) < 0.6 * np.linalg.norm(wrist - elbow))]
        pw = pw + at + out_way * (((arm - at) @ out_way).max() + 0.4 - (pw[middle] @ out_way).min())
        prelief = pnormals = None
    rigid = held or strapped
    if os.environ.get("ALIGN", "1") == "1" and fit_kind not in ("loose", "held", "strapped"):
        # The item came from a mesh fitted to the sprites on its own, and can sit a pixel or two off the body
        # along an arm, where the outline barely changes. Slide it until it is the same distance from the skin
        # all the way round: least squares on the distance of every vertex near the body.
        moved = np.zeros(3)
        for _ in range(8):
            d, n = body_distance(pw); near = np.abs(d) < 4
            if near.sum() < 50: break
            step = np.linalg.lstsq(np.hstack([n[near], -np.ones((near.sum(), 1))]), -d[near], rcond=None)[0][:3]
            step = np.clip(step, -1, 1); pw = pw + step; moved += step
        print(f"{label}: slid {np.round(moved, 2).tolist()} sprite pixels to sit on the body", file=sys.stderr)
    if FIT > 0 and not rigid:
        # An item is drawn a pixel outside the body and meshed on its own, so some of it lands inside the
        # body's mesh. Drop the triangles buried deep in the body that face inward, which nobody can see, and move what is
        # left out to just above the skin. FIT is how far above, in sprite pixels; 0 leaves the item alone.
        depth, outward = body_distance(pw)
        facing = np.einsum("ij,ij->i", trimesh.Trimesh(pw, pf, process=False).face_normals, outward[pf].mean(1))
        # A buried triangle that faces the way out of the body is the item's outside, drawn too small: keep it.
        pf = pf[~((depth[pf] < -BURIED).all(1) & (facing < 0.3))]
        used, index = np.unique(pf, return_inverse=True); pw, puv, pf = pw[used], puv[used], index.reshape(-1, 3)
        if pnormals is not None: pnormals = pnormals[used]
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
    if rigid: pj = np.zeros((len(pw), 4), np.uint8); pj[:, 0] = names.index(allowed); pwt = np.zeros((len(pw), 4), np.float32); pwt[:, 0] = 1
    if label in CHAINS:
        # A hanging item gets bones of its own: columns of links running down it, hung from the bone the item
        # may follow. The top of the item (a collar) stays on the body; below that each vertex follows the two
        # links it lies between, in the two columns it lies between, so the sheet bends smoothly both ways.
        columns, links = CHAINS[label]; hold = float(os.environ.get("CHAIN_TOP", "0.2"))
        root = names.index(allowed.split(",")[-1]) if allowed else names.index("Spine")
        top, bottom = pw[:, 2].max(), pw[:, 2].min(); start = top - (top - bottom) * hold
        left, right = np.quantile(pw[:, 0], 0.03), np.quantile(pw[:, 0], 0.97)
        levels = np.linspace(start, bottom, links + 1)
        centres = np.linspace(left, right, columns * 2 + 1)[1::2]
        first_new = len(names) + len(EXTRA)
        for c in range(columns):
            strip = np.abs(pw[:, 0] - centres[c]) < (right - left) / columns * 0.6
            for k in range(links):
                def joint(level):
                    band = strip & (np.abs(pw[:, 2] - level) < (top - bottom) / links * 0.35)
                    near = pw[band] if band.sum() >= 3 else pw[strip] if strip.any() else pw
                    return np.array([centres[c], np.median(near[:, 1]), level])
                EXTRA.append((f"{label.replace(' ', '')}{c + 1}_{k + 1}", root if k == 0 else first_new + c * links + k - 1, joint(levels[k]), joint(levels[k + 1])))
        # how far down each vertex is, in links, and how far across, in columns
        down = np.clip((start - pw[:, 2]) / max(start - bottom, 1e-6) * links, 0, links - 1e-6)
        across = np.clip((pw[:, 0] - centres[0]) / max(centres[-1] - centres[0], 1e-6) * (columns - 1), 0, columns - 1) if columns > 1 else np.zeros(len(pw))
        k0 = np.floor(down).astype(int); c0 = np.minimum(np.floor(across).astype(int), max(columns - 2, 0)); c1 = np.minimum(c0 + 1, columns - 1)
        fk = down - k0; fc = across - c0
        # a vertex part-way down link k turns with link k; the blend towards the next link starts in its lower half
        to_next = np.clip((fk - 0.5) * 2, 0, 1) * (k0 < links - 1); k1 = np.minimum(k0 + 1, links - 1)
        hanging = pw[:, 2] < start
        cj = np.stack([first_new + c0 * links + k0, first_new + c0 * links + k1, first_new + c1 * links + k0, first_new + c1 * links + k1], 1)
        cw = np.stack([(1 - fc) * (1 - to_next), (1 - fc) * to_next, fc * (1 - to_next), fc * to_next], 1)
        pj = np.where(hanging[:, None], cj, pj).astype(np.uint8); pwt = np.where(hanging[:, None], cw, pwt).astype(np.float32)
        pj = np.where(pwt > 0, pj, 0).astype(np.uint8)  # a bone with no weight is written as bone 0, as glTF asks
    ptex = sized(part.visual.material.baseColorTexture.convert("RGBA"), "TEX_ITEM" if os.environ.get("TEX_ITEM") else "TEX")
    # Which of the body's vertices this item covers: those with the item's surface within COVER sprite pixels.
    # A loose item (a cape) covers nothing, since it swings away from what is behind it.
    covers = np.zeros(len(world), bool)
    if fit_kind not in ("loose", "held", "strapped"):
        cloud = trimesh.sample.sample_surface(trimesh.Trimesh(pw, pf, process=False), 300000, seed=5)[0]
        covers = cKDTree(cloud).query(world)[0] < float(os.environ.get("COVER", "1.2"))
    ITEMS.append({"name": label, "covers": covers, "world": pw, "faces": pf, "uv": puv, "joints": pj, "weights": pwt, "texture": ptex, "relief": prelief, "given_normals": pnormals})

if EXTRA:  # the chain bones join the skeleton after the body's own, so no index already used moves
    for name, above, joint, end in EXTRA:
        BONES.append((name, names[above] if above < len(names) else EXTRA[above - len(names)][0], joint, end))
    names = [b[0] for b in BONES]; parent = [names.index(b[1]) if b[1] else -1 for b in BONES]
    head_pos = np.array([b[2] for b in BONES]); tail_pos = np.array([b[3] for b in BONES])

# ---- to metres, y up, facing +z
height = world[:, 2].max() - world[:, 2].min(); S = 1.8 / height; floor = world[:, 2].min()
def gl(p): p = np.atleast_2d(p); return np.stack([p[:, 0], p[:, 2] - floor, -p[:, 1]], 1) * S
pos = gl(world).astype(np.float32); jpos = gl(head_pos)
if os.environ.get("SKIN"):  # what cards.py needs: the body in the sprites' frame, and the bone that owns each vertex
    np.savez(os.environ["SKIN"], world=world, faces=faces, owner=joints_attr[np.arange(len(world)), weights_attr.argmax(1)],
             names=np.array(names), head=head_pos, tail=tail_pos, scale=S, floor=floor)
normals = given_normals if given_normals is not None else trimesh.Trimesh(pos, faces, process=False).vertex_normals.astype(np.float32)

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
# The body is written as one mesh per set of items that cover it, so a game can hide the skin under what is
# worn and nothing can show through. A triangle counts as covered by an item only when its three corners and
# all their neighbours are, which keeps a rim of skin under the item's edge. Each piece lists, in its node's
# extras, the items that hide it: hide the piece while any of them is worn.
signature = np.zeros(len(faces), int)
for bit, item in enumerate(ITEMS):
    inner = item["covers"].copy()
    open_edge = np.zeros(len(world), bool)
    for a, b in ((0, 1), (1, 2), (2, 0)):
        np.logical_or.at(open_edge, faces[:, a], ~item["covers"][faces[:, b]]); np.logical_or.at(open_edge, faces[:, b], ~item["covers"][faces[:, a]])
    inner &= ~open_edge
    signature |= inner[faces].all(1).astype(int) << bit
PARTS = []
for sig in np.unique(signature):
    piece = faces[signature == sig]; used, index = np.unique(piece, return_inverse=True)
    hidden_by = [item["name"] for bit, item in enumerate(ITEMS) if sig >> bit & 1]
    PARTS.append({"name": "Character" if sig == 0 else "Character under " + " and ".join(hidden_by), "extras": {"body": True, "hiddenBy": hidden_by},
                  "pos": pos[used], "normals": normals[used], "uv": uv[used], "faces": index.reshape(-1, 3), "joints": joints_attr[used], "weights": weights_attr[used], "texture": texture, "relief": relief, "image_of": 0, "of_body": used})
BODY_PARTS = len(PARTS)
for item in ITEMS:
    ipos = gl(item["world"]).astype(np.float32)
    PARTS.append({**item, "pos": ipos, "normals": item["given_normals"] if item["given_normals"] is not None else trimesh.Trimesh(ipos, item["faces"], process=False).vertex_normals.astype(np.float32)})
def tangents(position, normal, uv, faces):
    """A tangent for each vertex, along increasing u, with the sign glTF stores in w. thin.py has the same function."""
    p, t = position[faces].astype(np.float64), uv[faces]
    e1, e2 = p[:, 1] - p[:, 0], p[:, 2] - p[:, 0]; d1, d2 = t[:, 1] - t[:, 0], t[:, 2] - t[:, 0]
    det = d1[:, 0] * d2[:, 1] - d2[:, 0] * d1[:, 1]; det = np.where(np.abs(det) < 1e-12, 1e-12, det)
    along_u = (e1 * d2[:, 1:2] - e2 * d1[:, 1:2]) / det[:, None]; along_v = (e2 * d1[:, 0:1] - e1 * d2[:, 0:1]) / det[:, None]
    tan = np.zeros(position.shape); bit = np.zeros(position.shape)
    for corner in range(3): np.add.at(tan, faces[:, corner], along_u); np.add.at(bit, faces[:, corner], along_v)
    normal = normal.astype(np.float64)
    tan -= normal * np.einsum("ij,ij->i", normal, tan)[:, None]
    tan /= np.linalg.norm(tan, axis=1, keepdims=True) + 1e-12
    sign = np.where(np.einsum("ij,ij->i", np.cross(normal, tan), bit) < 0, -1.0, 1.0)
    return np.concatenate([tan, sign[:, None]], 1).astype(np.float32)

BODY_TANGENTS = None
for part in PARTS:
    part["attributes"] = {"POSITION": add(part["pos"], 34962, True, kind="VEC3"), "NORMAL": add(part["normals"], 34962, kind="VEC3"),
                          "TEXCOORD_0": add(np.stack([part["uv"][:, 0], 1 - part["uv"][:, 1]], 1).astype(np.float32), 34962, kind="VEC2"),
                          "JOINTS_0": add(part["joints"], 34962, ctype=5121, kind="VEC4"), "WEIGHTS_0": add(part["weights"], 34962, kind="VEC4")}
    if part.get("relief") is not None:
        if "of_body" in part:  # the body's tangents are worked out on the whole body, as thin.py baked them, then shared out
            if BODY_TANGENTS is None: BODY_TANGENTS = tangents(pos, normals, uv, faces)  # v up, as thin.py had it
            part["attributes"]["TANGENT"] = add(BODY_TANGENTS[part["of_body"]], 34962, kind="VEC4")
        else:
            part["attributes"]["TANGENT"] = add(tangents(part["pos"], part["normals"], part["uv"], part["faces"]), 34962, kind="VEC4")
    part["indices"] = add(part["faces"].astype(np.uint32).reshape(-1), 34963, ctype=5125)
ibm = np.tile(np.eye(4, dtype=np.float32), (len(BONES), 1, 1)); ibm[:, 3, :3] = -jpos  # column-major: translation in the last row
a_ibm = add(ibm.reshape(-1, 16), kind="MAT4")
a_time = add(times, minmax=True)
IMAGES = []  # each picture once: (buffer view, mime type)
JPEG = int(os.environ.get("JPEG", "0"))  # 0 writes PNG; otherwise JPEG at this quality, far smaller for painted textures
def picture(image):
    blob = io.BytesIO()
    if JPEG: image.convert("RGB").save(blob, "JPEG", quality=JPEG, subsampling=0)
    else: image.save(blob, "PNG")
    data = blob.getvalue(); off = sum(len(c) for c in chunks)
    chunks.append(data + b"\x00" * ((4 - len(data) % 4) % 4)); views.append({"buffer": 0, "byteOffset": off, "byteLength": len(data)})
    IMAGES.append({"bufferView": len(views) - 1, "mimeType": "image/jpeg" if JPEG else "image/png"}); return len(IMAGES) - 1
for part in PARTS:
    if part.get("image_of") is not None and "image" in PARTS[part["image_of"]]:
        part["image"] = PARTS[part["image_of"]]["image"]; part["relief_image"] = PARTS[part["image_of"]].get("relief_image"); continue
    part["image"] = picture(part["texture"])
    part["relief_image"] = picture(part["relief"]) if part.get("relief") is not None else None
nodes = [{"name": n, "translation": (jpos[i] - (jpos[parent[i]] if parent[i] >= 0 else 0)).tolist(), **({"extras": NODE_EXTRAS[n]} if n in NODE_EXTRAS else {})} for i, n in enumerate(names)]
for i, p in enumerate(parent):
    if p >= 0: nodes[p].setdefault("children", []).append(i)
for i, part in enumerate(PARTS): nodes.append({"name": part["name"], "mesh": i, "skin": 0, **({"extras": part["extras"]} if part.get("extras") else {})})
MATERIAL = [0 if i < BODY_PARTS else i - BODY_PARTS + 1 for i in range(len(PARTS))]  # the body's pieces share one material
SKINS = [PARTS[0]] + PARTS[BODY_PARTS:]
samplers, channels = [], []
for n, q in tracks.items():
    samplers.append({"input": a_time, "output": add(np.array(q, np.float32), kind="VEC4"), "interpolation": "LINEAR"})
    channels.append({"sampler": len(samplers) - 1, "target": {"node": names.index(n), "path": "rotation"}})
gltf = {"asset": {"version": "2.0", "generator": "pixelkiln research rig.py"}, "scene": 0, "scenes": [{"nodes": [0] + [len(BONES) + i for i in range(len(PARTS))]}], "nodes": nodes,
        "meshes": [{"name": p["name"], "primitives": [{"attributes": p["attributes"], "indices": p["indices"], "material": MATERIAL[i]}]} for i, p in enumerate(PARTS)],
        "skins": [{"joints": list(range(len(BONES))), "skeleton": 0, "inverseBindMatrices": a_ibm}],
        "materials": [{"name": "Sprite" if i == 0 else p["name"], **({"extras": {"palette": PALETTE}} if PALETTE else {}), "pbrMetallicRoughness": {"baseColorTexture": {"index": p["image"]}, "metallicFactor": 0, "roughnessFactor": 1}, **({"normalTexture": {"index": p["relief_image"]}} if p.get("relief_image") is not None else {})} for i, p in enumerate(SKINS)],
        "textures": [{"source": i, "sampler": 0} for i in range(len(IMAGES))], "images": IMAGES,
        "samplers": [{"magFilter": 9729 if relief is not None else 9728, "minFilter": 9987 if relief is not None else 9728, "wrapS": 33071, "wrapT": 33071}],
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
print(json.dumps({"out": out, "vertices": len(pos), "triangles": len(faces), "items": {i["name"]: len(i["faces"]) for i in ITEMS}, "bodyPieces": {p["name"]: len(p["faces"]) for p in PARTS[:BODY_PARTS]}, "bones": names, "heightMetres": 1.8, "animation": "Walk", "keys": KEYS,
                  "bytes": 12 + 8 + len(js) + 8 + len(binary), "maxInfluences": int((weights_attr > 0).sum(1).max())}))
