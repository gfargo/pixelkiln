"""Give each worn item a lining, so no skin shows through its gaps, its visor or at its edges.

  liner.py <character.glb> <out.glb>

rig.py hides the skin an item covers, but only where the item's surface is very near it and never at the
item's edge, so skin shows through a visor's slits, through holes in a ragged sleeve and where the body
pokes out past a plate. This reads a file rig.py wrote and decides again what each worn item covers:

  - a place on the body is under an item when the item's surface is within NEAR of it, or when a line out
    of the skin meets the inside of the item within UNDER;
  - holes in that are closed over (CLOSE rings of neighbours out, then as many back in), so the skin seen
    through a slit or a tear counts as covered while the item's outer edge stays where it was.

The body's pieces are cut again to match, each still listing in its node's extras the items that hide it.
What an item covers is then copied into the item's own mesh as a lining: the same triangles, on the body's
bones, pulled in until they are TUCK under the item, and all one dark colour taken from the item's own
texture. The lining is part of the item, so it is shown and hidden with it and a game needs to do nothing
new. The item's mesh extras say where the lining starts (liner.firstIndex), and running this again on its
own output replaces the lining and does not add a second.

Things held, strapped on or hanging (most of their weight on a hand, a grip or a chain bone, or hiding no
skin in the file as rig.py wrote it) get no lining.

Environment:
  ITEMS   the items to line, by name, with commas (default: every item not held or hanging)
  NEAR    metres (default 0.02)
  UNDER   metres (default 0.12)
  CLOSE   rings of neighbours (default 3)
  TUCK    metres the lining sits under the item (default 0.006); it is never moved more than 0.03
  SHADE   how dark the lining is, as a share of the item's usual colour (default 0.4)

Needs numpy, pillow, scipy.
"""
import io, json, os, struct, sys
import numpy as np
from PIL import Image
from scipy.spatial import cKDTree

source, out = sys.argv[1:3]
env = os.environ.get
NEAR = float(env('NEAR', '0.02')); UNDER = float(env('UNDER', '0.12')); CLOSE = int(env('CLOSE', '3')); TUCK = float(env('TUCK', '0.006')); SHADE = float(env('SHADE', '0.4'))
TYPES = {5120: np.int8, 5121: np.uint8, 5122: np.int16, 5123: np.uint16, 5125: np.uint32, 5126: np.float32}
CODES = {np.dtype(v): k for k, v in TYPES.items()}
WIDTH = {'SCALAR': 1, 'VEC2': 2, 'VEC3': 3, 'VEC4': 4, 'MAT4': 16}

with open(source, 'rb') as f:
    f.read(12); n, _ = struct.unpack('<I4s', f.read(8)); doc = json.loads(f.read(n)); n, _ = struct.unpack('<I4s', f.read(8)); blob = bytearray(f.read(n))
nodes = doc['nodes']

def read(index):
    a = doc['accessors'][index]; v = doc['bufferViews'][a['bufferView']]; kind = np.dtype(TYPES[a['componentType']]); w = WIDTH[a['type']]
    start = v.get('byteOffset', 0) + a.get('byteOffset', 0); stride = v.get('byteStride', kind.itemsize * w)
    if stride == kind.itemsize * w: return np.frombuffer(blob, kind, a['count'] * w, start).reshape(a['count'], w).copy()
    return np.stack([np.frombuffer(blob, kind, w, start + k * stride) for k in range(a['count'])])

def add(array, kind, limits=False, target=None):
    array = np.ascontiguousarray(array); blob.extend(b'\x00' * ((4 - len(blob) % 4) % 4))
    view = {'buffer': 0, 'byteOffset': len(blob), 'byteLength': array.nbytes}
    if target: view['target'] = target
    doc['bufferViews'].append(view); blob.extend(array.tobytes())
    a = {'bufferView': len(doc['bufferViews']) - 1, 'componentType': CODES[array.dtype], 'count': len(array), 'type': kind}
    if limits: a['min'] = array.min(0).tolist(); a['max'] = array.max(0).tolist()
    doc['accessors'].append(a); return len(doc['accessors']) - 1

def write(attributes, faces):  # a primitive's accessors, from arrays that keep the kinds they were read with
    kinds = {'POSITION': 'VEC3', 'NORMAL': 'VEC3', 'TEXCOORD_0': 'VEC2', 'JOINTS_0': 'VEC4', 'WEIGHTS_0': 'VEC4', 'TANGENT': 'VEC4'}
    made = {name: add(values, kinds[name], name == 'POSITION', 34962) for name, values in attributes.items()}
    count = len(attributes['POSITION']); index = faces.reshape(-1).astype(np.uint16 if count < 65535 else np.uint32)
    return made, add(index, 'SCALAR', target=34963)

# ---- the body, as one soup of triangles that remembers which items hide each
body_nodes = [i for i, x in enumerate(nodes) if 'mesh' in x and (x.get('extras') or {}).get('body')]
item_nodes = [i for i, x in enumerate(nodes) if 'mesh' in x and not (x.get('extras') or {}).get('body')]
if not body_nodes: sys.exit('no mesh in this file is marked as the body (extras.body)')
NAMES = ['POSITION', 'NORMAL', 'TEXCOORD_0', 'JOINTS_0', 'WEIGHTS_0', 'TANGENT']
body = {name: [] for name in NAMES}; body_faces = []; hidden = []; count = 0
first = doc['meshes'][nodes[body_nodes[0]]['mesh']]['primitives'][0]
for i in body_nodes:
    for p in doc['meshes'][nodes[i]['mesh']]['primitives']:
        for name in NAMES:
            if name in first['attributes']: body[name].append(read(p['attributes'][name]))
        faces = read(p['indices']).reshape(-1, 3).astype(np.int64); body_faces.append(faces + count); count += len(body['POSITION'][-1])
        hidden += [frozenset(nodes[i]['extras'].get('hiddenBy', []))] * len(faces)
body = {name: np.concatenate(parts) for name, parts in body.items() if parts}; body_faces = np.concatenate(body_faces)
position = body['POSITION'].astype(float)
# vertices at one place are one for finding neighbours, however the texture's seams split them
_, same = np.unique(np.round(position, 5), axis=0, return_inverse=True); same = same.reshape(-1); places = same.max() + 1
at = np.zeros((places, 3)); at[same] = position
normal = np.zeros((places, 3)); np.add.at(normal, same, body['NORMAL'].astype(float)); normal /= np.linalg.norm(normal, axis=1, keepdims=True) + 1e-12
joined = same[body_faces]
edges = np.unique(np.sort(np.concatenate([joined[:, [0, 1]], joined[:, [1, 2]], joined[:, [2, 0]]]), axis=1), axis=0)

def spread(flags):  # every place next to a flagged one
    grown = flags.copy(); grown[edges[flags[edges[:, 1]], 0]] = True; grown[edges[flags[edges[:, 0]], 1]] = True; return grown

def cast(origins, directions, triangles, reach):
    """The nearest crossing of each ray with the triangles within reach: how far, and whether the ray came at the
    triangle from behind (out through the inside of a shell whose faces point outwards)."""
    a = triangles[:, 0]; e1 = triangles[:, 1] - a; e2 = triangles[:, 2] - a; face = np.cross(e1, e2)
    far = np.full(len(origins), np.inf); behind = np.zeros(len(origins), bool)
    for start in range(0, len(origins), 256):
        o = origins[start:start + 256, None]; d = directions[start:start + 256, None]
        h = np.cross(d, e2[None]); det = (e1[None] * h).sum(-1); ok = np.abs(det) > 1e-12; inv = 1 / np.where(ok, det, 1)
        s = o - a[None]; u = (s * h).sum(-1) * inv; q = np.cross(s, e1[None]); v = (d * q).sum(-1) * inv; t = (e2[None] * q).sum(-1) * inv
        t = np.where(ok & (u >= 0) & (v >= 0) & (u + v <= 1) & (t > 1e-6) & (t < reach), t, np.inf)
        k = t.argmin(1); rows = np.arange(len(k)); far[start:start + 256] = t[rows, k]; behind[start:start + 256] = (d[:, 0] * face[k]).sum(-1) > 0
    return far, behind

def bone_names(skin): return [nodes[j].get('name', '') for j in doc['skins'][skin]['joints']]

def worn(i):  # something rig.py fitted over the skin: not held, strapped on or hanging
    if not any(nodes[i].get('name') in h for h in hidden): return False
    p = doc['meshes'][nodes[i]['mesh']]['primitives'][0]; names = bone_names(nodes[i]['skin'])
    j = read(p['attributes']['JOINTS_0']); w = read(p['attributes']['WEIGHTS_0']).astype(float); w /= max(w.max(), 1e-9) if w.dtype.kind == 'f' else 1
    loose = np.array([('Hand' in name) or ('Grip' in name) or name not in BODY_BONES for name in names])
    return (w * loose[j]).sum() < 0.5 * w.sum()

BODY_BONES = set(np.array(bone_names(nodes[body_nodes[0]]['skin']))[np.unique(body['JOINTS_0'][body['WEIGHTS_0'] > 0])])
wanted = env('ITEMS').split(',') if env('ITEMS') else None
report = {}
linings = {}
for i in item_nodes:
    name = nodes[i].get('name'); mesh = doc['meshes'][nodes[i]['mesh']]; p = mesh['primitives'][0]
    mine = {key: read(index) for key, index in p['attributes'].items()}; faces = read(p['indices']).reshape(-1, 3).astype(np.int64)
    was = (mesh.get('extras') or {}).get('liner')
    if was:  # a lining from an earlier run: take it off again
        faces = faces[:was['firstIndex'] // 3]; keep = was['firstVertex']; mine = {key: values[:keep] for key, values in mine.items()}
    linings[i] = (mine, faces, None)
    if (wanted is not None and name not in wanted) or (wanted is None and not worn(i)): continue
    points = mine['POSITION'].astype(float); corners = points[faces]
    # near: the item's surface within NEAR
    area = np.linalg.norm(np.cross(corners[:, 1] - corners[:, 0], corners[:, 2] - corners[:, 0]), axis=1); rng = np.random.default_rng(5)
    pick = rng.choice(len(faces), 200000, p=area / area.sum()); u = rng.random((200000, 2)); flip = u.sum(1) > 1; u[flip] = 1 - u[flip]
    cloud = corners[pick, 0] * (1 - u.sum(1))[:, None] + corners[pick, 1] * u[:, :1] + corners[pick, 2] * u[:, 1:]
    near = cKDTree(cloud).query(at)[0] < NEAR
    # under: a line out of the skin meets the inside of the item
    reach, behind = cast(at, normal, corners, UNDER); under = np.isfinite(reach) & behind
    covered = near | under
    for _ in range(CLOSE): covered = spread(covered)
    for _ in range(CLOSE): covered = ~spread(~covered)
    covered |= near | under
    for k, was_hidden in enumerate(hidden):  # what rig.py hid stays hidden
        if name in was_hidden: covered[joined[k]] = True
    under_item = covered[joined].all(1)
    hidden = [h | {name} if yes else h - {name} for h, yes in zip(hidden, under_item)]
    # the lining: those triangles, pulled in to TUCK under the item
    # one lining vertex for body vertices that are the same but for where the texture puts them: the lining is one colour
    key = np.concatenate([np.round(position, 5), np.round(body['NORMAL'].astype(float), 3), body['JOINTS_0'].astype(float), np.round(body['WEIGHTS_0'].astype(float), 4)], 1)
    _, first_like, like = np.unique(key, axis=0, return_index=True, return_inverse=True); merged = first_like[like.reshape(-1)]
    used = np.unique(merged[body_faces[under_item]]); spot = same[used]
    back, _ = cast(at[spot], -normal[spot], corners, 0.03)
    depth = np.where(np.isfinite(reach[spot]) & (reach[spot] < TUCK), TUCK - reach[spot], 0.0)   # just under it: a little further in
    depth = np.where(np.isfinite(back) & ~(np.isfinite(reach[spot]) & (reach[spot] < back)), back + TUCK, depth)  # outside it: back through, and under
    field = np.zeros(places); field[spot] = np.minimum(depth, 0.03)
    total = np.zeros(places); number = np.zeros(places)
    for a, b in ((0, 1), (1, 0)): np.add.at(total, edges[:, a], field[edges[:, b]]); np.add.at(number, edges[:, a], 1)
    field = np.maximum(field, total / np.maximum(number, 1))  # no step between a place that moved and its neighbours
    tucked = position[used] - normal[spot] * field[spot][:, None]
    # one dark colour of the item's own: the place in its texture nearest SHADE of its usual colour, and evenly coloured
    material = doc['materials'][p['material']]; picture = doc['images'][doc['textures'][material['pbrMetallicRoughness']['baseColorTexture']['index']]['source']]
    view = doc['bufferViews'][picture['bufferView']]; start = view.get('byteOffset', 0)
    texture = np.array(Image.open(io.BytesIO(bytes(blob[start:start + view['byteLength']]))).convert('RGB')).astype(float); high, wide = texture.shape[:2]
    uv = mine['TEXCOORD_0'].astype(float)[faces[pick]]; uv = uv[:, 0] * (1 - u.sum(1))[:, None] + uv[:, 1] * u[:, :1] + uv[:, 2] * u[:, 1:]
    px = np.unique(np.stack([np.clip((uv[:, 0] * wide).astype(int), 4, wide - 5), np.clip((uv[:, 1] * high).astype(int), 4, high - 5)], 1), axis=0)
    usual = np.median(texture[px[:, 1], px[:, 0]], axis=0); want = usual * SHADE
    block = np.stack([texture[px[:, 1] + dy, px[:, 0] + dx] for dy in (-3, 0, 3) for dx in (-3, 0, 3)], 1)
    score = np.linalg.norm(block.mean(1) - want, axis=1) + 2 * block.std(1).sum(1); best = px[score.argmin()]
    spot_uv = np.array([(best[0] + 0.5) / wide, (best[1] + 0.5) / high])
    lining = {'POSITION': tucked.astype(np.float32), 'NORMAL': body['NORMAL'][used], 'TEXCOORD_0': np.repeat(spot_uv[None], len(used), 0).astype(mine['TEXCOORD_0'].dtype),
              'JOINTS_0': body['JOINTS_0'][used].astype(mine['JOINTS_0'].dtype), 'WEIGHTS_0': body['WEIGHTS_0'][used].astype(mine['WEIGHTS_0'].dtype)}
    if nodes[i]['skin'] != nodes[body_nodes[0]]['skin']: sys.exit(f'{name} is not on the body\'s skeleton')
    if 'TANGENT' in mine:  # any direction across the surface will do: the lining is one colour
        n3 = lining['NORMAL'].astype(float); side = np.cross(n3, [0, 1, 0]); thin = np.linalg.norm(side, axis=1) < 1e-3; side[thin] = np.cross(n3[thin], [1, 0, 0])
        side /= np.linalg.norm(side, axis=1, keepdims=True); lining['TANGENT'] = np.concatenate([side, np.ones((len(side), 1))], 1).astype(np.float32)
    renumber = np.zeros(len(position), np.int64); renumber[used] = np.arange(len(used))
    linings[i] = (mine, faces, (lining, renumber[merged[body_faces[under_item]]]))
    report[name] = {'bodyTrianglesHidden': int(under_item.sum()), 'liningMovedInMetres': round(float(field[spot].max()), 4),
                    'liningColour': [int(c) for c in texture[best[1], best[0]]], 'usualColour': [int(c) for c in usual]}

# ---- the body's pieces, cut again
order = []
for h in hidden:
    if h not in order: order.append(h)
item_order = [nodes[i].get('name') for i in item_nodes]
order.sort(key=lambda h: (len(h) > 0, [item_order.index(n) for n in sorted(h, key=item_order.index)]) if h else (False, []))
if frozenset() not in order: order.insert(0, frozenset())
template = nodes[body_nodes[0]]; body_material = first.get('material'); new_nodes = []
hidden_index = np.array([order.index(h) for h in hidden])
old_meshes = sorted({nodes[i]['mesh'] for i in body_nodes})
for k, h in enumerate(order):
    faces = body_faces[hidden_index == k]
    if not len(faces) and h: continue
    used, index = np.unique(faces, return_inverse=True); names = sorted(h, key=item_order.index)
    title = 'Character' if not h else 'Character under ' + ' and '.join(names)
    attributes, indices = write({name: values[used] for name, values in body.items()}, index.reshape(-1, 3))
    doc['meshes'].append({'name': title, 'primitives': [{'attributes': attributes, 'indices': indices, 'material': body_material}]})
    new_nodes.append({**{key: value for key, value in template.items() if key not in ('name', 'mesh', 'extras')}, 'name': title, 'mesh': len(doc['meshes']) - 1, 'extras': {'body': True, 'hiddenBy': names}})
# the body's nodes are replaced where they stood; any extra go on the end of the scene, any left over are emptied
for slot, node in zip(body_nodes, new_nodes): nodes[slot] = node
for node in new_nodes[len(body_nodes):]:
    nodes.append(node)
    for scene in doc['scenes']:
        if body_nodes[0] in scene['nodes']: scene['nodes'].append(len(nodes) - 1)
spare = body_nodes[len(new_nodes):]
if spare:  # fewer pieces than before: take the spare nodes out and renumber
    keep = [i for i in range(len(nodes)) if i not in spare]; number = {old: new for new, old in enumerate(keep)}
    doc['nodes'] = nodes = [nodes[i] for i in keep]
    for node in nodes:
        if 'children' in node: node['children'] = [number[c] for c in node['children']]
    for scene in doc['scenes']: scene['nodes'] = [number[c] for c in scene['nodes'] if c in number]
    for skin in doc['skins']:
        skin['joints'] = [number[j] for j in skin['joints']]
        if 'skeleton' in skin: skin['skeleton'] = number[skin['skeleton']]
    for clip in doc.get('animations', []):
        for channel in clip['channels']: channel['target']['node'] = number[channel['target']['node']]

# ---- the items, each with its lining after its own triangles
for i, (mine, faces, lining) in linings.items():
    mesh = doc['meshes'][[x for x in nodes if x.get('name') == item_order[item_nodes.index(i)] and 'mesh' in x][0]['mesh']]; p = mesh['primitives'][0]
    extras = dict(mesh.get('extras') or {}); had = extras.pop('liner', None)
    if lining is None and not had: continue
    if lining is not None:
        more, more_faces = lining; own = len(mine['POSITION'])
        extras['liner'] = {'firstIndex': int(len(faces) * 3), 'triangles': int(len(more_faces)), 'firstVertex': int(own)}
        mine = {key: np.concatenate([values, more[key]]) for key, values in mine.items()}; faces = np.concatenate([faces, more_faces + own])
    p['attributes'], p['indices'] = write(mine, faces)
    if extras: mesh['extras'] = extras
    else: mesh.pop('extras', None)

# ---- drop the meshes, accessors and buffer views nothing uses any more
used_meshes = sorted({x['mesh'] for x in nodes if 'mesh' in x}); number = {old: new for new, old in enumerate(used_meshes)}
doc['meshes'] = [doc['meshes'][m] for m in used_meshes]
for x in nodes:
    if 'mesh' in x: x['mesh'] = number[x['mesh']]
used = set()
for mesh in doc['meshes']:
    for p in mesh['primitives']: used |= set(p['attributes'].values()) | {p['indices']}
for skin in doc['skins']:
    if 'inverseBindMatrices' in skin: used.add(skin['inverseBindMatrices'])
for clip in doc.get('animations', []):
    for s in clip['samplers']: used |= {s['input'], s['output']}
keep = sorted(used); renamed = {old: new for new, old in enumerate(keep)}
views = sorted({doc['accessors'][a]['bufferView'] for a in keep} | {im['bufferView'] for im in doc.get('images', []) if 'bufferView' in im})
packed = bytearray(); new_views = []; view_number = {}
for old in views:
    v = dict(doc['bufferViews'][old]); start = v.get('byteOffset', 0); packed.extend(b'\x00' * ((4 - len(packed) % 4) % 4))
    v['byteOffset'] = len(packed); packed.extend(blob[start:start + v['byteLength']]); view_number[old] = len(new_views); new_views.append(v)
doc['accessors'] = [{**doc['accessors'][a], 'bufferView': view_number[doc['accessors'][a]['bufferView']]} for a in keep]; doc['bufferViews'] = new_views
for mesh in doc['meshes']:
    for p in mesh['primitives']: p['attributes'] = {key: renamed[a] for key, a in p['attributes'].items()}; p['indices'] = renamed[p['indices']]
for skin in doc['skins']:
    if 'inverseBindMatrices' in skin: skin['inverseBindMatrices'] = renamed[skin['inverseBindMatrices']]
for clip in doc.get('animations', []):
    for s in clip['samplers']: s['input'] = renamed[s['input']]; s['output'] = renamed[s['output']]
for im in doc.get('images', []):
    if 'bufferView' in im: im['bufferView'] = view_number[im['bufferView']]
packed.extend(b'\x00' * ((4 - len(packed) % 4) % 4)); doc['buffers'][0]['byteLength'] = len(packed)
text = json.dumps(doc, separators=(',', ':')).encode(); text += b' ' * ((4 - len(text) % 4) % 4)
with open(out, 'wb') as f:
    f.write(struct.pack('<4sII', b'glTF', 2, 12 + 8 + len(text) + 8 + len(packed)))
    f.write(struct.pack('<I4s', len(text), b'JSON') + text + struct.pack('<I4s', len(packed), b'BIN\x00') + bytes(packed))
print(json.dumps({'lined': report, 'bodyPieces': [x['name'] for x in nodes if (x.get('extras') or {}).get('body')]}, indent=1))
