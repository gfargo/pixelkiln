"""Make hanging items swing: simulate their bone chains through every animation and write the result as keys.

  sway.py <character.glb> <out.glb>

rig.py's CHAINS gives a hanging item (a cape) columns of bones, named <Item><column>_<link>. They
do nothing until something turns them. Game engines can do that live with spring bones, each in
its own way. This does it once, here, and stores the answer in the file, so the cape swings the
same in any engine that plays the animation.

For each animation, each chain is a string of points. The top one is pinned to the body. The rest
fall under gravity, lag behind when the body moves, keep their distance from the point above, are
pulled a little towards where they hang at rest, and are pushed out of the legs and the trunk,
which are treated as capsules round the bones. The points are then turned back into a rotation for
each link. A looping animation is run round several times and the last pass kept, so its end meets
its start.

Environment:
  FPS       samples a second (default 30)
  GRAVITY   metres per second squared (default 9.8)
  DAMPING   the share of its speed a point keeps each step (default 0.92)
  STIFF     how strongly a point is pulled to where it hangs at rest, 0 to 1 a step (default 0.015)
  LEGS, TRUNK   capsule radii in metres (defaults 0.11 and 0.2)
  GAP       how far outside a capsule a point is kept (default 0.03)
  ROUNDS    how many times a loop is run before it is recorded (default 3)

Needs numpy.
"""
import json, os, re, struct, sys
import numpy as np

source, out = sys.argv[1:3]
env = os.environ.get
FPS = float(env('FPS', '30')); GRAVITY = float(env('GRAVITY', '9.8')); DAMPING = float(env('DAMPING', '0.92')); STIFF = float(env('STIFF', '0.015'))
LEGS, TRUNK, GAP, ROUNDS = float(env('LEGS', '0.11')), float(env('TRUNK', '0.2')), float(env('GAP', '0.03')), int(env('ROUNDS', '3'))
SUBSTEPS = 4
COMPONENTS = {'SCALAR': 1, 'VEC2': 2, 'VEC3': 3, 'VEC4': 4, 'MAT4': 16}


def matrix(q):
    q = q / np.linalg.norm(q, axis=-1, keepdims=True); x, y, z, w = np.moveaxis(q, -1, 0)
    return np.stack([np.stack([1 - 2 * (y * y + z * z), 2 * (x * y - z * w), 2 * (x * z + y * w)], -1),
                     np.stack([2 * (x * y + z * w), 1 - 2 * (x * x + z * z), 2 * (y * z - x * w)], -1),
                     np.stack([2 * (x * z - y * w), 2 * (y * z + x * w), 1 - 2 * (x * x + y * y)], -1)], -2)


def quaternion(r):
    t = r[0, 0] + r[1, 1] + r[2, 2]
    if t > 0: s = np.sqrt(t + 1) * 2; return [(r[2, 1] - r[1, 2]) / s, (r[0, 2] - r[2, 0]) / s, (r[1, 0] - r[0, 1]) / s, s / 4]
    if r[0, 0] > r[1, 1] and r[0, 0] > r[2, 2]: s = np.sqrt(1 + r[0, 0] - r[1, 1] - r[2, 2]) * 2; return [s / 4, (r[0, 1] + r[1, 0]) / s, (r[0, 2] + r[2, 0]) / s, (r[2, 1] - r[1, 2]) / s]
    if r[1, 1] > r[2, 2]: s = np.sqrt(1 + r[1, 1] - r[0, 0] - r[2, 2]) * 2; return [(r[0, 1] + r[1, 0]) / s, s / 4, (r[1, 2] + r[2, 1]) / s, (r[0, 2] - r[2, 0]) / s]
    s = np.sqrt(1 + r[2, 2] - r[0, 0] - r[1, 1]) * 2; return [(r[0, 2] + r[2, 0]) / s, (r[1, 2] + r[2, 1]) / s, s / 4, (r[1, 0] - r[0, 1]) / s]


def between(a, b):
    a, b = a / (np.linalg.norm(a) + 1e-12), b / (np.linalg.norm(b) + 1e-12); axis = np.cross(a, b); s = np.linalg.norm(axis); c = float(a @ b)
    if s < 1e-8: return np.eye(3)
    k = axis / s; K = np.array([[0, -k[2], k[1]], [k[2], 0, -k[0]], [-k[1], k[0], 0]])
    return np.eye(3) + s * K + (1 - c) * K @ K


def sample(times, values, at, turning):
    if len(times) == 1: return np.repeat(values[:1], len(at), 0)
    i = np.clip(np.searchsorted(times, at, side='right') - 1, 0, len(times) - 2)
    w = np.clip((at - times[i]) / np.maximum(times[i + 1] - times[i], 1e-9), 0, 1)[:, None]
    a, b = values[i], values[i + 1]
    if turning:
        b = np.where((a * b).sum(1, keepdims=True) < 0, -b, b); v = a * (1 - w) + b * w
        return v / np.linalg.norm(v, axis=1, keepdims=True)
    return a * (1 - w) + b * w


with open(source, 'rb') as f:
    f.read(12); size, _ = struct.unpack('<I4s', f.read(8)); doc = json.loads(f.read(size))
    size, _ = struct.unpack('<I4s', f.read(8)); blob = bytearray(f.read(size))


def read(index):
    a = doc['accessors'][index]; view = doc['bufferViews'][a['bufferView']]; width = COMPONENTS[a['type']]
    start = view.get('byteOffset', 0) + a.get('byteOffset', 0)
    return np.frombuffer(bytes(blob[start:start + a['count'] * width * 4]), np.float32).reshape(a['count'], width).astype(np.float64)


def add(array, kind='SCALAR', limits=False):
    data = np.ascontiguousarray(array, np.float32).tobytes(); offset = len(blob)
    blob.extend(data + b'\x00' * ((4 - len(data) % 4) % 4))
    doc['bufferViews'].append({'buffer': 0, 'byteOffset': offset, 'byteLength': len(data)})
    entry = {'bufferView': len(doc['bufferViews']) - 1, 'componentType': 5126, 'count': len(array), 'type': kind}
    if limits: entry['min'] = [float(np.min(array))]; entry['max'] = [float(np.max(array))]
    doc['accessors'].append(entry); return len(doc['accessors']) - 1


nodes = doc['nodes']; parent = {}
for i, node in enumerate(nodes):
    for child in node.get('children', []): parent[child] = i
named = {node.get('name'): i for i, node in enumerate(nodes)}
order = []
def visit(i):
    order.append(i)
    for child in nodes[i].get('children', []): visit(child)
for i in range(len(nodes)):
    if i not in parent: visit(i)
rest = lambda i, key, default: np.array(nodes[i].get(key, default), float)


def world(moments, moved):
    turn, place = {}, {}
    for i in order:
        t = moved.get((i, 'translation'), np.repeat(rest(i, 'translation', [0, 0, 0])[None], moments, 0))
        r = matrix(moved.get((i, 'rotation'), np.repeat(rest(i, 'rotation', [0, 0, 0, 1])[None], moments, 0)))
        if i in parent: p = parent[i]; turn[i] = turn[p] @ r; place[i] = place[p] + np.einsum('kij,kj->ki', turn[p], t)
        else: turn[i], place[i] = r, t
    return turn, place


# ---- the chains: bones named <Item><column>_<link>
found = {}
for name, index in named.items():
    match = re.fullmatch(r'(.+?)(\d+)_(\d+)', name or '')
    if match: found.setdefault((match.group(1), int(match.group(2))), []).append((int(match.group(3)), index))
chains = [[index for _, index in sorted(links)] for _, links in sorted(found.items())]
if not chains: sys.exit('no chain bones found: rig the character with CHAINS first')
chain_nodes = {index for chain in chains for index in chain}
rest_turn, rest_place = world(1, {})
setup = []
for chain in chains:
    joints = [rest_place[i][0] for i in chain]
    joints.append(joints[-1] + (joints[-1] - joints[-2] if len(joints) > 1 else np.array([0, -0.2, 0])))  # the free end of the last link
    anchor = parent[chain[0]]
    local = [rest_turn[anchor][0].T @ (j - rest_place[anchor][0]) for j in joints]  # where each point hangs, as the anchor bone sees it
    setup.append({'nodes': chain, 'anchor': anchor, 'local': np.array(local), 'length': [np.linalg.norm(joints[k + 1] - joints[k]) for k in range(len(chain))],
                  'rest_dir': [(joints[k + 1] - joints[k]) / (np.linalg.norm(joints[k + 1] - joints[k]) + 1e-12) for k in range(len(chain))]})
CAPSULES = [(a, b, LEGS) for side in ('Left', 'Right') for a, b in ((f'{side}UpperLeg', f'{side}LowerLeg'), (f'{side}LowerLeg', f'{side}Foot'))] + [('Hips', 'Chest', TRUNK), ('Hips', 'Spine', TRUNK)]
CAPSULES = [(named[a], named[b], r) for a, b, r in CAPSULES if a in named and b in named]


def keep_out(p, place, k):
    for a, b, radius in CAPSULES:
        pa, pb = place[a][k], place[b][k]; ab = pb - pa
        t = np.clip((p - pa) @ ab / (ab @ ab + 1e-12), 0, 1); away = p - (pa + t * ab); d = np.linalg.norm(away)
        if d < radius + GAP: p = pa + t * ab + away / (d + 1e-9) * (radius + GAP)
    return p


report = []
for clip in doc['animations']:
    clip['channels'] = [c for c in clip['channels'] if c['target'].get('node') not in chain_nodes]
    channels = {(c['target']['node'], c['target']['path']): (read(clip['samplers'][c['sampler']]['input'])[:, 0], read(clip['samplers'][c['sampler']]['output'])) for c in clip['channels']}
    length = max(times[-1] for times, _ in channels.values())
    moments = np.linspace(0, length, max(2, int(round(length * FPS)) + 1))
    moved = {key: sample(times, values, moments, key[1] == 'rotation') for key, (times, values) in channels.items() if key[1] != 'scale'}
    turn, place = world(len(moments), moved)
    first, last = np.concatenate([turn[i][0].ravel() for i in order]), np.concatenate([turn[i][-1].ravel() for i in order])
    loops = clip['name'].endswith('_Loop') or np.abs(first - last).max() < 0.05
    clock = add(moments, limits=True); dt = (moments[1] - moments[0]) / SUBSTEPS; swing = 0.0
    for chain in setup:
        anchor = chain['anchor']; count = len(chain['nodes'])
        target = lambda k: place[anchor][k] + chain['local'] @ turn[anchor][k].T  # where the whole chain hangs at rest, at moment k
        points = target(0).copy(); before = points.copy(); kept = np.zeros((len(moments), count + 1, 3))
        frames = list(range(len(moments))) * (ROUNDS if loops else 1) if loops else [0] * 30 + list(range(len(moments)))
        for step, k in enumerate(frames):
            goal = target(k)
            for _ in range(SUBSTEPS):
                speed = (points - before) * DAMPING; before = points.copy()
                points = points + speed + np.array([0, -GRAVITY, 0]) * dt * dt
                points += (goal - points) * STIFF
                points[0] = goal[0]
                for j in range(1, count + 1):
                    points[j] = keep_out(points[j], place, k)
                    link = points[j] - points[j - 1]; points[j] = points[j - 1] + link / (np.linalg.norm(link) + 1e-12) * chain['length'][j - 1]
            if step >= len(frames) - len(moments): kept[k] = points
        # back to a rotation for each link: turn it from where its parent would leave it to where the points say it is
        turns = np.zeros((len(moments), count, 4))
        for k in range(len(moments)):
            above = turn[anchor][k]
            for j in range(count):
                mine = between(above @ chain['rest_dir'][j], kept[k, j + 1] - kept[k, j]) @ above
                turns[k, j] = quaternion(above.T @ mine); above = mine
                if k and turns[k, j] @ turns[k - 1, j] < 0: turns[k, j] = -turns[k, j]
        swing = max(swing, float(np.linalg.norm(kept[:, -1] - np.array([target(k)[-1] for k in range(len(moments))]), axis=1).max()))
        for j, node in enumerate(chain['nodes']):
            clip['samplers'].append({'input': clock, 'output': add(turns[:, j], 'VEC4'), 'interpolation': 'LINEAR'})
            clip['channels'].append({'sampler': len(clip['samplers']) - 1, 'target': {'node': node, 'path': 'rotation'}})
    report.append((clip['name'], 'loop' if loops else 'once', round(swing, 2)))

doc['buffers'][0]['byteLength'] = len(blob)
text = json.dumps(doc, separators=(',', ':')).encode(); text += b' ' * ((4 - len(text) % 4) % 4)
with open(out, 'wb') as f:
    f.write(struct.pack('<4sII', b'glTF', 2, 12 + 8 + len(text) + 8 + len(blob)))
    f.write(struct.pack('<I4s', len(text), b'JSON') + text + struct.pack('<I4s', len(blob), b'BIN\x00') + bytes(blob))
print(json.dumps({'out': out, 'chains': len(setup), 'links': sum(len(c['nodes']) for c in setup), 'animations': report, 'bytes': os.path.getsize(out)}))
