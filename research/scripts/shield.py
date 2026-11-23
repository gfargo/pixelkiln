"""Make shield animations for a character with a shield strapped to a forearm.

  shield.py <character.glb> <out.glb>

Stock libraries that are free to use have no shield motions, so a strapped shield does whatever the empty arm did.
Here the shield arm is written down, as wield.py writes the path of a two-handed grip.

Each new animation takes everything but the shield arm from an animation the file already has (BASE below). The
shield is fixed to the forearm, so three things say all there is to say about the arm: which way the elbow lies from
the shoulder, which way the shield's face points, and which way its top points. They are given at a few moments, in a
frame of across to the shield's side, up, and to the front. That frame leans with the spine. It faces the way the
character does while the chest is within SLACK degrees of that, so a stance or a stride that turns the chest leaves
the shield facing ahead; when the chest turns further, as in a sword cut, the frame turns with it and the shield
swings aside. Between those moments the directions follow a smooth curve. Being directions, they give the same pose on a body with
other proportions, and there is nothing to reach for, so nothing can fall short. The upper arm is then turned along
its length so that the elbow carries as little twist as it can.

The report gives, for each animation, how far the elbow bends (0 is a straight arm), and where the middle of the
shield ends up: how far before the shoulder and how far above it, at its nearest and furthest.

A motion may also carry footwork, as in wield.py: the hips are moved and turned, the foot on the shield's side steps,
and both legs are solved again from hip to ankle.

The animations:
  Shield_Idle        a guard: the shield upright before the chest on the shield's side, breathing
  Shield_Walk        the guard carried on the walk
  Shield_Jog         the same on the jog, the shield nearer the body and turned further to its side
  Shield_Attack      the sword attack, with the shield kept in the guard
  Shield_Block       the shield comes up and out to cover the head and chest, the knees give, and it goes back
  Shield_Hold        the block held, for as long as a game needs it (not named Shield_Block_Loop: Godot drops a
                     _Loop ending on import, and the name would then be Shield_Block's)
  Shield_Bash        the shield is drawn in, then driven out face first with a step of the foot on its side

The shield is found from what rig.py's "strapped" left on the forearm bone. In a file made before it left anything, it
is the mesh that follows one forearm alone, its face the side away from the arm and its top towards the elbow.

Environment:
  SKIP    a pattern of motion names to leave out
  FPS     samples a second (default 30)
  SLACK   how far the chest may turn before the shield starts to turn with it, in degrees (default 45)
  BASE    the animations the bodies come from, as Idle,Walk,Jog,Attack (default Sword_Idle,Walk_Loop,Jog_Fwd_Loop,Sword_Attack)
  ITEM    the name of the shield's mesh (default: the mesh that follows one forearm alone)

Needs numpy.
"""
import json, os, re, struct, sys
import numpy as np

source, out = sys.argv[1:3]
env = os.environ.get
FPS = float(env('FPS', '30')); SLACK = np.radians(float(env('SLACK', '45')))
BASE = env('BASE', 'Sword_Idle,Walk_Loop,Jog_Fwd_Loop,Sword_Attack').split(',')
COMPONENTS = {'SCALAR': 1, 'VEC2': 2, 'VEC3': 3, 'VEC4': 4, 'MAT4': 16}

# Each: the animation the body comes from, how long it lasts (None: as long as that one), and the moments.
# A moment is (share of the length, elbow, face, top, lean): the way the elbow lies from the shoulder (to the shield's
# side, up, front), the way the shield's face points, the way its top points, and how far the spine leans forward, in
# degrees. sway adds a slow breath: the elbow rises and falls by that much.
GUARD = ((0.20, -0.75, 0.55), (0.35, 0.00, 1.00), (0.00, 1.00, 0.00))    # the elbow down and forward, the forearm across the body
CARRY = ((0.20, -0.65, 0.70), (0.35, 0.10, 1.00), (0.10, 1.00, -0.10))   # the same further out, its foot kicked forward clear of the thighs
ASIDE = ((0.55, -0.60, 0.55), (0.80, 0.00, 0.60), (0.20, 1.00, 0.00))    # the elbow out from the side, the shield turned out: clear of a lifted knee and of the sword's path
RAISED = ((0.25, -0.25, 0.95), (0.05, 0.20, 1.00), (0.00, 1.00, -0.20))  # the elbow up before the shoulder, the shield tipped back
# Footwork rows: (share, hips forward, hips down, hips turned towards the shield's side in degrees, the step forward of
# the foot on the shield's side, its lift, the other foot back, its lift), lengths in leg lengths.
BRACED = (-0.03, 0.09, -8, 0.10, 0.00, 0.08, 0.00)
MOTIONS = [
    {'name': 'Shield_Idle', 'base': 0, 'length': None, 'sway': 0.012, 'moments': [(0, *GUARD, 0), (1, *GUARD, 0)]},
    {'name': 'Shield_Walk', 'base': 1, 'length': None, 'sway': 0.0, 'held': True, 'moments': [(0, *CARRY, 0), (1, *CARRY, 0)]},
    {'name': 'Shield_Jog', 'base': 2, 'length': None, 'sway': 0.0, 'held': True, 'slack': 10, 'moments': [(0, *ASIDE, 0), (1, *ASIDE, 0)]},
    {'name': 'Shield_Attack', 'base': 3, 'length': None, 'sway': 0.0, 'slack': 20, 'moments': [(0, *GUARD, 0), (0.15, *ASIDE, 0), (0.80, *ASIDE, 0), (1, *GUARD, 0)]},
    {'name': 'Shield_Block', 'base': 0, 'length': 1.0, 'sway': 0.0, 'look': True,
     'moments': [(0.00, *GUARD, 0), (0.22, *RAISED, 6), (0.70, *RAISED, 7), (1.00, *GUARD, 0)],
     'feet': [(0.00, 0, 0, 0, 0, 0, 0, 0), (0.12, -0.01, 0.03, -3, 0.04, 0.04, 0.00, 0.00), (0.22, *BRACED), (0.70, *BRACED),
              (0.86, -0.01, 0.03, -3, 0.04, 0.04, 0.03, 0.00), (1.00, 0, 0, 0, 0, 0, 0, 0)]},
    {'name': 'Shield_Hold', 'base': 0, 'length': None, 'sway': 0.008, 'look': True,
     'moments': [(0, *RAISED, 6), (1, *RAISED, 6)], 'feet': [(0, *BRACED), (1, *BRACED)]},
    {'name': 'Shield_Bash', 'base': 0, 'length': 1.0, 'sway': 0.0, 'look': True,
     'moments': [(0.00, *GUARD, 0),
                 (0.28, (0.30, -0.90, -0.10), (0.70, 0.00, 0.70), (0.00, 1.00, 0.00), -4),   # drawn in to the shoulder
                 (0.44, (0.45, -0.35, 0.85), (0.45, 0.05, 1.00), (0.00, 1.00, 0.00), 12),   # driven out, face first: turned out by what the hips turn in, so it lands square
                 (0.56, (0.45, -0.35, 0.85), (0.45, 0.05, 1.00), (0.00, 1.00, 0.00), 13),
                 (1.00, *GUARD, 0)],
     'feet': [(0.00, 0, 0, 0, 0, 0, 0, 0),
              (0.28, -0.05, 0.03, 14, 0.00, 0.00, 0, 0),    # wound up: the hips turned towards the shield, weight back
              (0.36, 0.03, 0.03, 0, 0.12, 0.06, 0, 0),      # the foot leaves the ground
              (0.44, 0.20, 0.11, -22, 0.38, 0.00, 0, 0),    # it lands as the shield does, the shield's shoulder leading
              (0.56, 0.20, 0.12, -23, 0.38, 0.00, 0, 0),
              (0.80, 0.07, 0.04, -6, 0.12, 0.06, 0, 0),     # and comes back
              (1.00, 0, 0, 0, 0, 0, 0, 0)]},
]
MOTIONS = [m for m in MOTIONS if not (env('SKIP') and re.search(env('SKIP'), m['name']))]


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


def read(index, kind=np.float32):
    a = doc['accessors'][index]; view = doc['bufferViews'][a['bufferView']]; width = COMPONENTS[a['type']]
    start = view.get('byteOffset', 0) + a.get('byteOffset', 0); step = np.dtype(kind).itemsize * width; stride = view.get('byteStride', step)
    rows = [np.frombuffer(bytes(blob[start + n * stride:start + n * stride + step]), kind) for n in range(a['count'])] if stride != step else None
    data = np.stack(rows) if rows else np.frombuffer(bytes(blob[start:start + a['count'] * step]), kind).reshape(a['count'], width)
    return data.astype(np.float64)


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


unit = lambda v: v / (np.linalg.norm(v) + 1e-12)
frame = lambda a, p: np.stack([unit(a), unit(p - unit(a) * (p @ unit(a))), np.cross(unit(a), unit(p - unit(a) * (p @ unit(a))))], 1)
rest_turn, rest_place = world(1, {})

# The shield: the mesh whose every corner follows one forearm and nothing else.
found = None
for node in nodes:
    if 'mesh' not in node or 'skin' not in node: continue
    if env('ITEM') and node.get('name') != env('ITEM'): continue
    joints = doc['skins'][node['skin']]['joints']; points = []; used = set()
    for prim in doc['meshes'][node['mesh']]['primitives']:
        a = doc['accessors'][prim['attributes']['JOINTS_0']]; kind = {5121: np.uint8, 5123: np.uint16}[a['componentType']]
        j = read(prim['attributes']['JOINTS_0'], kind); w = read(prim['attributes']['WEIGHTS_0'])
        used |= {joints[int(n)] for n in np.unique(j[w > 0])}; points.append(read(prim['attributes']['POSITION']))
    if len(used) == 1 and (nodes[next(iter(used))].get('name') or '').endswith('LowerArm'): found = (node.get('name'), next(iter(used)), np.concatenate(points)); break
if found is None: sys.exit('no shield found: rig the character with a "strapped" item first')
item_name, fore, points = found; side = nodes[fore]['name'].replace('LowerArm', ''); other = 'Left' if side == 'Right' else 'Right'; sign = 1.0 if side == 'Left' else -1.0
upper, hand = named[side + 'UpperArm'], named[side + 'Hand']
one, two = rest(fore, 'translation', [0, 0, 0]), rest(hand, 'translation', [0, 0, 0]); A, B = np.linalg.norm(one), np.linalg.norm(two); ARM = A + B
elbow0, wrist0 = rest_place[fore][0], rest_place[hand][0]; line0 = unit(wrist0 - elbow0)
left = (nodes[fore].get('extras') or {})
if 'face' in left: face0, top0 = unit(np.array(left['face'], float)), unit(np.array(left['top'], float))
else:
    face0 = np.linalg.eigh(np.cov((points - points.mean(0)).T))[1][:, 0]; away = points.mean(0) - elbow0; away = away - line0 * (away @ line0)
    face0 = face0 * (1 if face0 @ away > 0 else -1); top0 = -line0
SHIELD0 = frame(face0, top0)  # the shield at rest: its face, its top and the way across it
spans = (points - points.mean(0)) @ SHIELD0; centre0 = points.mean(0) + SHIELD0 @ ((spans.max(0) + spans.min(0)) / 2)
IN_ARM = rest_turn[fore][0].T @ SHIELD0; MIDDLE = rest_turn[fore][0].T @ (centre0 - elbow0)  # the same, as the forearm carries them
BENT0 = matrix(rest(fore, 'rotation', [0, 0, 0, 1]))
LEGS = {}
for s in (side, other):
    u, f, h = (named[s + part] for part in ('UpperLeg', 'LowerLeg', 'Foot'))
    a, b = rest(f, 'translation', [0, 0, 0]), rest(h, 'translation', [0, 0, 0])
    LEGS[s] = {'upper': u, 'fore': f, 'foot': h, 'one': a, 'two': b, 'a': np.linalg.norm(a), 'b': np.linalg.norm(b)}
LEG = LEGS[side]['a'] + LEGS[side]['b']
trunk = [named['Hips'], named['Chest'] if 'Chest' in named else named['Spine']]


def bend(root, ankle, was, a, b):
    """A leg of two fixed lengths from hip to ankle: where its knee goes, and where its ankle ends if it cannot reach."""
    far = np.linalg.norm(ankle - root); span = float(np.clip(far, abs(a - b) + 1e-4, 0.999 * (a + b))); way = (ankle - root) / (far + 1e-12)
    near = (a * a - b * b + span * span) / (2 * span); rise = np.sqrt(max(a * a - near * near, 0))
    pole = was - way * (was @ way); pole = unit(pole) if np.linalg.norm(pole) > 1e-4 else unit(np.cross(way, [1, 0, 0]))
    return root + way * near + pole * rise, root + way * span, abs(far - span)


def curve(at, values, share, hold=False):
    """A smooth curve through values given at shares of the length: at rest at both ends, passing each one in between
    at the pace of its neighbours. With hold, a value that stops or turns back at a moment is at rest there, so one
    that is given twice running stays put between the two and does not swing past them."""
    at, values = np.array(at, float), np.array(values, float); slope = np.zeros_like(values)
    for i in range(1, len(at) - 1):
        slope[i] = (values[i + 1] - values[i - 1]) / (at[i + 1] - at[i - 1])
        if hold: slope[i] = np.where((values[i + 1] - values[i]) * (values[i] - values[i - 1]) <= 0, 0.0, slope[i])
    i = int(np.clip(np.searchsorted(at, share, side='right') - 1, 0, len(at) - 2)); h = at[i + 1] - at[i]; x = float(np.clip((share - at[i]) / h, 0, 1))
    return ((2 * x ** 3 - 3 * x ** 2 + 1) * values[i] + (x ** 3 - 2 * x ** 2 + x) * h * slope[i] + (-2 * x ** 3 + 3 * x ** 2) * values[i + 1] + (x ** 3 - x ** 2) * h * slope[i + 1])


def at_share(moments, share):
    """The way to the elbow, the shield's face, its top and the lean at a share of the animation's length."""
    v = curve([m[0] for m in moments], [[*unit(np.array(m[1], float)), *unit(np.array(m[2], float)), *unit(np.array(m[3], float)), m[4]] for m in moments], share, True)
    return unit(v[:3]), unit(v[3:6]), unit(v[6:9]), v[9]


clips = {clip['name']: clip for clip in doc['animations']}
if BASE[0] not in clips: sys.exit(f'the file has no animation named {BASE[0]}')
other_arm = set(); grow = [parent[named[other + 'UpperArm']] if 'Shoulder' in (nodes[parent[named[other + 'UpperArm']]].get('name') or '') else named[other + 'UpperArm']]
while grow: i = grow.pop(); other_arm.add(i); grow += nodes[i].get('children', [])
HELD = {(c['target']['node'], 'rotation'): (read(clips[BASE[0]]['samplers'][c['sampler']]['input'])[:, 0], read(clips[BASE[0]]['samplers'][c['sampler']]['output']))
        for c in clips[BASE[0]]['channels'] if c['target']['node'] in other_arm and c['target']['path'] == 'rotation'}
report = []
for motion in MOTIONS:
    base_name = BASE[motion['base']]
    if base_name not in clips: sys.exit(f'the file has no animation named {base_name}')
    if motion['name'] in clips: doc['animations'].remove(clips[motion['name']])
    base = clips[base_name]
    channels = {(c['target']['node'], c['target']['path']): (read(base['samplers'][c['sampler']]['input'])[:, 0], read(base['samplers'][c['sampler']]['output'])) for c in base['channels']}
    base_length = max(times[-1] for times, _ in channels.values()); length = motion['length'] or base_length
    moments = np.linspace(0, length, max(2, int(round(length * FPS)) + 1)); shares = moments / length; count = len(moments)
    moved = {key: sample(times, values, moments % base_length if motion['length'] else moments, key[1] == 'rotation') for key, (times, values) in channels.items() if key[1] != 'scale'}
    if motion.get('held'):  # the other arm is held as the idle has it at its start, so a sword in it is not swung about
        for (node, path), (times, values) in HELD.items(): moved[(node, path)] = np.repeat(values[:1], count, 0)
    posed = [at_share(motion['moments'], s) for s in shares]
    spine = named['Spine']; leans = np.radians([p[3] for p in posed])
    if np.abs(leans).max() > 0:  # lean the spine forward: a turn about its own across axis, after what the base does
        was = moved.get((spine, 'rotation'), np.repeat(rest(spine, 'rotation', [0, 0, 0, 1])[None], count, 0))
        x, y, z, w = was.T; s, c = np.sin(leans / 2), np.cos(leans / 2)  # was * (s, 0, 0, c)
        moved[(spine, 'rotation')] = np.stack([w * s + x * c, y * c + z * s, z * c - y * s, w * c - x * s], 1)
    foot_short = 0.0
    if motion.get('feet'):
        # Footwork: the hips move and turn, the foot on the shield's side steps out and back, and both legs are solved
        # again from hip to ankle. The feet keep the ground and the facing the base gave them.
        hips = named['Hips']; turn0, place0 = world(count, moved); ahead = np.array([0, 0, 1.0])
        track = np.array([curve([m[0] for m in motion['feet']], [m[1:] for m in motion['feet']], s, True) for s in shares])
        above = turn0[parent[hips]] if hips in parent else np.repeat(np.eye(3)[None], count, 0)
        shift = ahead[None] * (track[:, 0:1] * LEG) - np.array([0, 1.0, 0])[None] * (track[:, 1:2] * LEG)
        moved[(hips, 'translation')] = moved.get((hips, 'translation'), np.repeat(rest(hips, 'translation', [0, 0, 0])[None], count, 0)) + np.einsum('kji,kj->ki', above, shift)
        half = np.radians(track[:, 2]) * sign / 2; was = moved.get((hips, 'rotation'), np.repeat(rest(hips, 'rotation', [0, 0, 0, 1])[None], count, 0))
        x, y, z, w = was.T; s_, c_ = np.sin(half), np.cos(half)  # (0, s, 0, c) * was: a turn about the upright, before what the base does
        moved[(hips, 'rotation')] = np.stack([c_ * x + s_ * z, c_ * y + s_ * w, c_ * z - s_ * x, c_ * w - s_ * y], 1)
        turn, place = world(count, moved)
        for s in (side, other):
            leg = LEGS[s]; u, f, h = leg['upper'], leg['fore'], leg['foot']; keys = {u: [], f: [], h: []}
            for k in range(count):
                ankle = place0[h][k] + (ahead * track[k, 3] * LEG + np.array([0, track[k, 4] * LEG, 0]) if s == side else -ahead * track[k, 5] * LEG + np.array([0, track[k, 6] * LEG, 0]))
                root = place[u][k]; knee_was = place0[f][k] - place0[u][k] + ahead * 0.3 * LEG
                knee, reached, miss = bend(root, ankle, knee_was, leg['a'], leg['b']); foot_short = max(foot_short, miss)
                as_was = turn[u][k]; new_upper = between(as_was @ leg['one'], knee - root) @ as_was
                new_fore = new_upper @ (as_was.T @ turn[f][k]); new_fore = between(new_fore @ leg['two'], reached - knee) @ new_fore
                for node, local in ((u, turn[parent[u]][k].T @ new_upper), (f, new_upper.T @ new_fore), (h, new_fore.T @ turn0[h][k])):
                    q = np.array(quaternion(local)); keys[node].append(-q if keys[node] and q @ keys[node][-1] < 0 else q)
            for node, values in keys.items(): moved[(node, 'rotation')] = np.array(values)
        if motion.get('look') and 'Head' in named:
            # The head keeps looking where the base had it: the neck takes half of the hips' turn back and the head the rest.
            head = named['Head']; neck = parent[head]; turn, place = world(count, moved); back = -np.radians(track[:, 2]) * sign
            yaw = lambda a: np.stack([np.stack([np.cos(a), 0 * a, np.sin(a)], -1), np.stack([0 * a, 1 + 0 * a, 0 * a], -1), np.stack([-np.sin(a), 0 * a, np.cos(a)], -1)], -2)
            new_neck = yaw(back / 2) @ turn[neck]; new_head = yaw(back) @ turn[head]
            for node, local in ((neck, np.swapaxes(turn[parent[neck]], 1, 2) @ new_neck), (head, np.swapaxes(new_neck, 1, 2) @ new_head)):
                values = []
                for m in local: q = np.array(quaternion(m)); values.append(-q if values and q @ values[-1] < 0 else q)
                moved[(node, 'rotation')] = np.array(values)
    turn, place = world(count, moved)
    keys = {upper: [], fore: []}; elbows = []; middles = []
    # The frame the directions are in. It leans with the spine. It faces the way the character does (+z) while the chest
    # is near that, and turns with the chest once the chest has turned far: by what the chest turns beyond SLACK.
    chest = turn[trunk[1]] @ np.array([0, 0, 1.0]); yaws = np.unwrap(np.arctan2(chest[:, 0], chest[:, 2])); slack = np.radians(motion['slack']) if 'slack' in motion else SLACK; yaws = yaws - slack * np.tanh(yaws / slack)
    for k in range(count):
        shoulder = place[upper][k]; way, face, top, _ = posed[k]
        up = unit(place[trunk[1]][k] - place[trunk[0]][k]); front = np.array([np.sin(yaws[k]), 0, np.cos(yaws[k])]); front = unit(front - up * (front @ up)); to_side = np.cross(up, front) * sign
        way = unit(to_side * way[0] + up * (way[1] + motion['sway'] * np.sin(2 * np.pi * shares[k])) + front * way[2])
        face = unit(to_side * face[0] + up * face[1] + front * face[2]); top = to_side * top[0] + up * top[1] + front * top[2]
        R = frame(face, top) @ IN_ARM.T  # the forearm, turned so that the shield it carries faces and stands as asked
        elbows.append(np.degrees(np.arccos(np.clip(way @ unit(R @ two), -1, 1)))); middles.append(np.stack([to_side, up, front]) @ (way * A + R @ MIDDLE))
        # The upper arm points at the elbow. It may still turn about its own length; the turn kept leaves the forearm as
        # near as it can be to how it sits on the upper arm at rest, so the elbow bends and does not wring.
        above = turn[parent[upper]][k]; as_was = turn[upper][k]; new_upper = between(as_was @ one, way) @ as_was
        K = np.array([[0, -way[2], way[1]], [way[2], 0, -way[0]], [-way[1], way[0], 0]]); wrung = R @ BENT0.T @ new_upper.T
        angle = -np.arctan2(np.trace(K @ wrung), -np.trace(K @ K @ wrung))
        new_upper = (np.eye(3) + np.sin(angle) * K + (1 - np.cos(angle)) * K @ K) @ new_upper
        for node, local in ((upper, above.T @ new_upper), (fore, new_upper.T @ R)):
            q = np.array(quaternion(local)); keys[node].append(-q if keys[node] and q @ keys[node][-1] < 0 else q)
    clock = add(moments, limits=True); clip = {'name': motion['name'], 'samplers': [], 'channels': []}
    def key(node, path, values):
        clip['samplers'].append({'input': clock, 'output': add(np.array(values), 'VEC4' if path == 'rotation' else 'VEC3'), 'interpolation': 'LINEAR'})
        clip['channels'].append({'sampler': len(clip['samplers']) - 1, 'target': {'node': node, 'path': path}})
    for (node, path), values in moved.items():
        if not (node in keys and path == 'rotation'): key(node, path, values)
    for node, values in keys.items(): key(node, 'rotation', values)
    doc['animations'].append(clip)
    seam = max(float(np.degrees(2 * np.arccos(min(1, abs(np.array(v[0]) @ np.array(v[-1])))))) for v in keys.values())
    middles = np.array(middles)
    report.append({'name': motion['name'], 'from': base_name, 'seconds': round(float(length), 2), 'elbowBendDegrees': [round(float(min(elbows))), round(float(max(elbows)))],
                   'shieldBeforeShoulderMetres': [round(float(middles[:, 2].min()), 2), round(float(middles[:, 2].max()), 2)], 'shieldAboveShoulderMetres': [round(float(middles[:, 1].min()), 2), round(float(middles[:, 1].max()), 2)],
                   'footShortMetres': round(float(foot_short), 3), 'firstToLastDegrees': round(seam)})

doc['buffers'][0]['byteLength'] = len(blob)
text = json.dumps(doc, separators=(',', ':')).encode(); text += b' ' * ((4 - len(text) % 4) % 4)
with open(out, 'wb') as f:
    f.write(struct.pack('<4sII', b'glTF', 2, 12 + 8 + len(text) + 8 + len(blob)))
    f.write(struct.pack('<I4s', len(text), b'JSON') + text + struct.pack('<I4s', len(blob), b'BIN\x00') + bytes(blob))
print(json.dumps({'out': out, 'shield': item_name, 'arm': side, 'armMetres': round(float(ARM), 3), 'animations': report, 'bytes': os.path.getsize(out)}))
