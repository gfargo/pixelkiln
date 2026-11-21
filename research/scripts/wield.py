"""Make two-handed animations for a character that holds a two-handed item.

  wield.py <character.glb> <out.glb>

Stock libraries that are free to use carry one-handed sword motions and no two-handed ones. offhand.py
bends such a motion until the other hand reaches the grip, and the wrists pay for it. This goes the other
way round: the path of the item is written down, and both arms are solved to it.

Each new animation takes its legs, hips, spine and head from an animation the file already has (BASE
below), and replaces both arms. A motion may also carry footwork: the hips are moved and turned, a foot
steps, and both legs are solved again from hip to ankle. Where the grip is and which way the handle points are given at a few
moments, in a frame that rides on the chest: across to the leading hand's side, up the spine, and to the
front, in arm lengths from the middle of the shoulders. Between those moments the grip and the handle
follow a smooth curve through them.

At every moment the leading hand is put on the grip and the other on the <Side>Grip2 bone rig.py left.
Each hand may still roll round the handle. The leading hand's roll is chosen for a straight wrist and a
blade whose edge, not its flat, faces the way it is swung; the other's for a straight wrist. Both arms
are then triangles from shoulder to wrist, elbows down, out and a little back. If an arm cannot reach, the
grip is pulled in by what it fell short; the report says how far.

The animations, each named after what it is for (SET=great, the default):
  Great_Idle     a guard, the blade upright before the body, breathing
  Great_Walk     the same guard carried on the walk
  Great_Jog      the same, the hands a little lower and nearer
  Great_Attack   a cut from over the leading shoulder down to the front, with a step: the hips wind up, the other
                 foot steps out as the cut lands, and the trunk leans into it

With SET=spear, for a shaft held with the hands apart (rig.py's GRIP_AT): Spear_Idle is a side-on stance, the hips
turned 45 degrees, the leading foot ahead, the other behind and turned out, the head looking along the shaft.
Spear_Walk and Spear_Jog carry the spear level with the hips turned less (28 and 14 degrees), and Spear_Thrust draws
it back and drives it out with a step of the leading foot, the hips squaring up behind it.

A motion's footwork may also put the other foot back (a seventh number in each row of its feet), turn that foot out
(rear_foot, degrees) and keep the head looking where the base had it while the hips turn (look).

Environment:
  SET     which motions to make: great or spear (default great)
  FPS     samples a second (default 30)
  ROLLS   how many rolls round the handle are tried at each moment (default 72)
  SMOOTH  how much a change of roll from the moment before costs (default 1)
  EDGE    how much a blade turned flat to its swing costs, against a radian of wrist bend (default 2)
  REACH   the share of an arm's length it may be asked to reach (default 0.97)
  BASE    the animations the bodies come from, as Idle,Walk,Jog (default Idle_Loop,Walk_Loop,Jog_Fwd_Loop)
  ITEM    the name of the item's mesh, for finding its edge (default: the mesh weighted to the grip's hand
          with the longest reach)

Needs numpy.
"""
import json, os, struct, sys
import numpy as np

source, out = sys.argv[1:3]
env = os.environ.get
FPS = float(env('FPS', '30')); ROLLS = int(env('ROLLS', '72')); SMOOTH = float(env('SMOOTH', '1')); EDGE = float(env('EDGE', '2'))
REACH = float(env('REACH', '0.97'))
BASE = env('BASE', 'Idle_Loop,Walk_Loop,Jog_Fwd_Loop').split(',')
COMPONENTS = {'SCALAR': 1, 'VEC2': 2, 'VEC3': 3, 'VEC4': 4, 'MAT4': 16}

# Each: the animation the body comes from, how long it lasts (None: as long as that one), and the moments.
# A moment is (share of the length, grip, handle, lean): the grip in arm lengths (to the leading side, up,
# front) from the middle of the shoulders, the way the handle points from pommel to blade, and how far
# the spine leans forward, in degrees. sway adds a slow breath to the grip, in arm lengths.
GUARD = ((0.20, -0.50, 0.50), (0.00, 0.90, 0.30))
CARRY = ((0.20, -0.58, 0.42), (0.00, 0.95, 0.30))
GREAT = [
    {'name': 'Great_Idle', 'base': 0, 'length': None, 'sway': 0.012, 'moments': [(0, *GUARD, 0), (1, *GUARD, 0)]},
    {'name': 'Great_Walk', 'base': 1, 'length': None, 'sway': 0.0, 'moments': [(0, *GUARD, 0), (1, *GUARD, 0)]},
    {'name': 'Great_Jog', 'base': 2, 'length': None, 'sway': 0.0, 'moments': [(0, *CARRY, 0), (1, *CARRY, 0)]},
    # A closed hand cannot lay a handle along its forearm, so the blade is never in line with the arms: it lies back
    # over the shoulder when raised, and lands pointing up from the hands, not level. These poses were picked by trying
    # their neighbours and keeping the ones with the straightest wrists.
    {'name': 'Great_Attack', 'base': 0, 'length': 1.4, 'sway': 0.0,
     'moments': [(0.00, *GUARD, 0),
                 (0.18, (0.38, -0.20, 0.47), (0.15, 0.85, -0.20), -3),  # on the way up: the hands rise at the leading side
                 (0.30, (0.55, 0.04, 0.40), (0.30, 0.66, -0.74), -5),   # raised: hands before the leading shoulder, the blade back over it
                 (0.40, (0.55, 0.06, 0.40), (0.30, 0.62, -0.78), -6),
                 (0.47, (0.30, -0.15, 0.58), (0.10, 0.94, -0.30), 8),   # half way down: hands before the chest, the blade still behind them
                 (0.54, (0.12, -0.55, 0.72), (-0.05, 0.75, 1.00), 22),  # the cut lands: arms out and down, the blade ahead and rising
                 (0.66, (0.12, -0.57, 0.70), (-0.05, 0.65, 1.00), 24),
                 (1.00, *GUARD, 0)],
     # (share, hips forward, hips down, hips turned towards the leading side in degrees, the step forward, its lift), lengths in leg lengths
     'feet': [(0.00, 0.00, 0.00, 0, 0.00, 0.00),
              (0.32, -0.04, 0.02, 18, 0.00, 0.00),   # wound up: the hips turned towards the raised sword, weight back
              (0.42, 0.02, 0.02, 14, 0.12, 0.07),    # the foot leaves the ground
              (0.54, 0.22, 0.14, -14, 0.45, 0.00),   # it lands with the cut: the hips forward, down and turned through
              (0.68, 0.22, 0.15, -16, 0.45, 0.00),
              (0.84, 0.08, 0.04, -4, 0.14, 0.06),    # and comes back
              (1.00, 0.00, 0.00, 0, 0.00, 0.00)]},
]
# A spear or staff: the leading hand is the one nearer the point, the other a way behind it on the shaft. The stance is
# side-on: the hips turned 45 degrees so the leading shoulder is forward, the leading foot ahead and the other behind and
# turned out, the head looking over the leading shoulder along the shaft. The grip is written from the chest, so each
# pose's handle is turned towards the leading side by as much as the hips are turned away, and the point stays ahead.
# A walk is turned less and a jog less again. The thrust draws back, then squares the hips and drives the point out
# with a step of the leading foot.
STANCE = ((0.50, -0.42, 0.50), (0.77, 0.05, 0.64))
STRIDE = ((0.25, -0.48, 0.62), (0.57, 0.10, 0.82))
LEVEL = ((0.05, -0.50, 0.68), (0.42, 0.15, 0.90))
REAR = (0.6, 0.4, 0.3)  # the rear arm's elbow goes out to its side, a little up and forward, so its forearm comes down to the shaft
STOOD = (0.00, 0.06, -45, 0.22, 0.00, 0.18)  # hips forward, down, turned; the leading foot ahead, its lift; the other foot back
SPEAR = [
    {'name': 'Spear_Idle', 'base': 0, 'length': None, 'sway': 0.012, 'elbow': REAR, 'look': True, 'step': 'lead', 'rear_foot': 40,
     'moments': [(0, *STANCE, 0), (1, *STANCE, 0)], 'feet': [(0, *STOOD), (1, *STOOD)]},
    {'name': 'Spear_Walk', 'base': 1, 'length': None, 'sway': 0.0, 'elbow': REAR, 'look': True,
     'moments': [(0, *STRIDE, 0), (1, *STRIDE, 0)], 'feet': [(0, 0, 0.05, -28, 0, 0), (1, 0, 0.05, -28, 0, 0)]},
    {'name': 'Spear_Jog', 'base': 2, 'length': None, 'sway': 0.0, 'elbow': REAR, 'look': True,
     'moments': [(0, *LEVEL, 0), (1, *LEVEL, 0)], 'feet': [(0, 0, 0.05, -14, 0, 0), (1, 0, 0.05, -14, 0, 0)]},
    {'name': 'Spear_Thrust', 'base': 0, 'length': 1.2, 'sway': 0.0, 'step': 'lead', 'elbow': REAR, 'look': True, 'rear_foot': 40,
     'moments': [(0.00, *STANCE, 0),
                 (0.30, (0.44, -0.45, 0.36), (0.80, 0.04, 0.60), -3),   # drawn back
                 (0.46, (0.20, -0.36, 0.90), (0.56, 0.02, 0.83), 14),   # driven out
                 (0.58, (0.20, -0.36, 0.90), (0.56, 0.01, 0.83), 15),
                 (1.00, *STANCE, 0)],
     'feet': [(0.00, *STOOD),
              (0.30, -0.05, 0.08, -52, 0.22, 0.00, 0.18),
              (0.38, 0.04, 0.08, -40, 0.34, 0.06, 0.18),
              (0.46, 0.22, 0.16, -30, 0.60, 0.00, 0.18),
              (0.58, 0.22, 0.17, -29, 0.60, 0.00, 0.18),
              (0.80, 0.08, 0.09, -38, 0.34, 0.06, 0.18),
              (1.00, *STOOD)]},
]
SETS = {'great': GREAT, 'spear': SPEAR}
if env('SET', 'great') not in SETS: sys.exit(f"SET is one of {sorted(SETS)}")
MOTIONS = SETS[env('SET', 'great')]
if env('SET') == 'spear' and not env('EDGE'): EDGE = 0.0  # a shaft has no edge to keep


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
target = next((i for i, node in enumerate(nodes) if 'handle' in (node.get('extras') or {})), None)
if target is None: sys.exit('no <Side>Grip2 bone found: rig the character with a "two-handed" item first')
other = nodes[target]['extras']['hand'].replace('Hand', ''); lead = 'Left' if other == 'Right' else 'Right'
rest_turn, rest_place = world(1, {})
ARMS = {}
for side in (lead, other):
    u, f, h, g = (named[side + part] for part in ('UpperArm', 'LowerArm', 'Hand', 'Grip'))
    one, two = rest(f, 'translation', [0, 0, 0]), rest(h, 'translation', [0, 0, 0])
    ARMS[side] = {'upper': u, 'fore': f, 'hand': h, 'one': one, 'two': two, 'a': np.linalg.norm(one), 'b': np.linalg.norm(two),
                  'reach': rest_place[g][0] - rest_place[h][0],  # from the wrist to the grip, at rest
                  'hand_rest': frame(np.array(nodes[g]['extras']['across'], float), np.array(nodes[g]['extras']['palm'], float))}
ARM = ARMS[lead]['a'] + ARMS[lead]['b']
handle0 = unit(np.array(nodes[target]['extras']['handle'], float))  # the handle's line at rest, pommel to blade as the other hand grips it
palm0 = np.array(nodes[named[lead + 'Grip']]['extras']['palm'], float)
lead_rest = frame(handle0, palm0)  # the leading hand at rest, described by the handle it holds
along = float((rest_place[target][0] - rest_place[named[lead + 'Grip']][0]) @ handle0)  # from the leading grip to the other, along the handle
FINGERS = [(named[other + bone], named[lead + bone]) for bone in ('ThumbMetacarpal', 'ThumbProximal', 'ThumbDistal', 'MiddleProximal', 'MiddleIntermediate', 'MiddleDistal')
           if other + bone in named and lead + bone in named]
ours = {ARMS[s][part] for s in ARMS for part in ('upper', 'fore', 'hand')} | {mine for mine, _ in FINGERS}
LEGS = {}
for side in (lead, other):
    u, f, h = (named[side + part] for part in ('UpperLeg', 'LowerLeg', 'Foot'))
    one, two = rest(f, 'translation', [0, 0, 0]), rest(h, 'translation', [0, 0, 0])
    LEGS[side] = {'upper': u, 'fore': f, 'foot': h, 'one': one, 'two': two, 'a': np.linalg.norm(one), 'b': np.linalg.norm(two)}
LEG = LEGS[lead]['a'] + LEGS[lead]['b']
trunk = [named['Hips'], named['Chest'] if 'Chest' in named else named['Spine']]
angles = np.linspace(0, 2 * np.pi, ROLLS, endpoint=False)

# The blade's flat: the thinnest way across the item, at rest. The item is the mesh that hangs on the leading hand's grip.
grip_joint = {}
flat0 = None; best_long = 0
for node in nodes:
    if 'mesh' not in node or 'skin' not in node: continue
    if env('ITEM') and node.get('name') != env('ITEM'): continue
    joints = doc['skins'][node['skin']]['joints']
    for prim in doc['meshes'][node['mesh']]['primitives']:
        a = doc['accessors'][prim['attributes']['JOINTS_0']]; kind = {5121: np.uint8, 5123: np.uint16}[a['componentType']]
        used = {joints[int(j)] for j in np.unique(read(prim['attributes']['JOINTS_0'], kind)[:, 0])}
        if used - {named[lead + 'Grip'], named[lead + 'Hand'], target}: continue  # an item held in the hand hangs on nothing else
        points = read(prim['attributes']['POSITION']); spread, ways = np.linalg.eigh(np.cov((points - points.mean(0)).T))
        if spread[2] > best_long: best_long = spread[2]; flat0 = ways[:, 0]; item_name = node.get('name')
if flat0 is None: flat0 = np.cross(handle0, palm0); item_name = None


def bend(shoulder, wrist, was, a, b, reach=None):
    """An arm of two fixed lengths from shoulder to wrist: where its elbow goes, and where its wrist ends if it cannot reach."""
    far = np.linalg.norm(wrist - shoulder); span = float(np.clip(far, abs(a - b) + 1e-4, (reach or REACH) * (a + b))); way = (wrist - shoulder) / (far + 1e-12)
    near = (a * a - b * b + span * span) / (2 * span); rise = np.sqrt(max(a * a - near * near, 0))
    pole = was - way * (was @ way); pole = unit(pole) if np.linalg.norm(pole) > 1e-4 else unit(np.cross(way, [1, 0, 0]))
    return shoulder + way * near + pole * rise, shoulder + way * span, abs(far - span)


def curve(at, values, share):
    """A smooth curve through values given at shares of the length: at rest at both ends, passing each one in between
    at the pace of its neighbours."""
    at, values = np.array(at, float), np.array(values, float); slope = np.zeros_like(values)
    for i in range(1, len(at) - 1): slope[i] = (values[i + 1] - values[i - 1]) / (at[i + 1] - at[i - 1])
    i = int(np.clip(np.searchsorted(at, share, side='right') - 1, 0, len(at) - 2)); h = at[i + 1] - at[i]; x = float(np.clip((share - at[i]) / h, 0, 1))
    return ((2 * x ** 3 - 3 * x ** 2 + 1) * values[i] + (x ** 3 - 2 * x ** 2 + x) * h * slope[i] + (-2 * x ** 3 + 3 * x ** 2) * values[i + 1] + (x ** 3 - x ** 2) * h * slope[i + 1])


def at_share(moments, share):
    """The grip, the handle's way and the lean at a share of the animation's length."""
    v = curve([m[0] for m in moments], [[*m[1], *unit(np.array(m[2], float)), m[3]] for m in moments], share)
    return v[:3], unit(v[3:6]), v[6]


clips = {clip['name']: clip for clip in doc['animations']}
report = []
for motion in MOTIONS:
    base_name = BASE[motion['base']]
    if base_name not in clips: sys.exit(f'the file has no animation named {base_name}')
    if motion['name'] in clips: doc['animations'].remove(clips[motion['name']])
    base = clips[base_name]
    channels = {(c['target']['node'], c['target']['path']): (read(base['samplers'][c['sampler']]['input'])[:, 0], read(base['samplers'][c['sampler']]['output'])) for c in base['channels']}
    base_length = max(times[-1] for times, _ in channels.values()); length = motion['length'] or base_length
    moments = np.linspace(0, length, max(2, int(round(length * FPS)) + 1)); shares = moments / length
    moved = {key: sample(times, values, moments % base_length if motion['length'] else moments, key[1] == 'rotation') for key, (times, values) in channels.items() if key[1] != 'scale'}
    posed = [at_share(motion['moments'], s) for s in shares]
    spine = named['Spine']; leans = np.radians([p[2] for p in posed])
    if np.abs(leans).max() > 0:  # lean the spine forward: a turn about its own across axis, after what the base does
        was = moved.get((spine, 'rotation'), np.repeat(rest(spine, 'rotation', [0, 0, 0, 1])[None], len(moments), 0))
        x, y, z, w = was.T; s, c = np.sin(leans / 2), np.cos(leans / 2)  # was * (s, 0, 0, c)
        moved[(spine, 'rotation')] = np.stack([w * s + x * c, y * c + z * s, z * c - y * s, w * c - x * s], 1)
    turns = {ARMS[s][part]: [] for s in ARMS for part in ('upper', 'fore', 'hand')}; foot_short = 0.0
    if motion.get('feet'):
        # Footwork: the hips move and turn, the foot on the other hand's side steps out and back, and both legs are
        # solved again from hip to ankle. The feet keep the ground and the facing the base gave them.
        hips = named['Hips']; turn0, place0 = world(len(moments), moved)
        ahead = turn0[hips][0] @ np.array([0, 0, 1.0]); ahead[1] = 0; ahead = unit(ahead); sign = 1.0 if lead == 'Left' else -1.0
        rows = [tuple(m) + (0.0,) * (7 - len(m)) for m in motion['feet']]
        track = np.array([curve([m[0] for m in rows], [m[1:] for m in rows], s) for s in shares])  # forward, down, turn, step, lift, the other foot back
        above = turn0[parent[hips]] if hips in parent else np.repeat(np.eye(3)[None], len(moments), 0)
        shift = ahead[None] * (track[:, 0:1] * LEG) - np.array([0, 1.0, 0])[None] * (track[:, 1:2] * LEG)
        moved[(hips, 'translation')] = moved.get((hips, 'translation'), np.repeat(rest(hips, 'translation', [0, 0, 0])[None], len(moments), 0)) + np.einsum('kji,kj->ki', above, shift)
        half = np.radians(track[:, 2]) * sign / 2; was = moved.get((hips, 'rotation'), np.repeat(rest(hips, 'rotation', [0, 0, 0, 1])[None], len(moments), 0))
        x, y, z, w = was.T; s_, c_ = np.sin(half), np.cos(half)  # (0, s, 0, c) * was: a turn about the upright, before what the base does
        moved[(hips, 'rotation')] = np.stack([c_ * x + s_ * z, c_ * y + s_ * w, c_ * z - s_ * x, c_ * w - s_ * y], 1)
        turn, place = world(len(moments), moved)
        toe = np.radians(motion.get('rear_foot', 0)) * -sign; splay = np.array([[np.cos(toe), 0, np.sin(toe)], [0, 1, 0], [-np.sin(toe), 0, np.cos(toe)]])
        for side in (lead, other):
            leg = LEGS[side]; u, f, h = leg['upper'], leg['fore'], leg['foot']; keys = {u: [], f: [], h: []}
            for k in range(len(moments)):
                stepping = side == (lead if motion.get('step') == 'lead' else other)
                ankle = place0[h][k] + (ahead * track[k, 3] * LEG + np.array([0, track[k, 4] * LEG, 0]) if stepping else -ahead * track[k, 5] * LEG)
                facing = turn0[h][k] if stepping or not motion.get('rear_foot') else splay @ turn0[h][k]
                root = place[u][k]; knee_was = place0[f][k] - place0[u][k] + ahead * 0.3 * LEG
                knee, reached, miss = bend(root, ankle, knee_was, leg['a'], leg['b'], 0.999); foot_short = max(foot_short, miss)
                as_was = turn[u][k]; new_upper = between(as_was @ leg['one'], knee - root) @ as_was
                new_fore = new_upper @ (as_was.T @ turn[f][k]); new_fore = between(new_fore @ leg['two'], reached - knee) @ new_fore
                for node, local in ((u, turn[parent[u]][k].T @ new_upper), (f, new_upper.T @ new_fore), (h, new_fore.T @ facing)):
                    q = np.array(quaternion(local)); keys[node].append(-q if keys[node] and q @ keys[node][-1] < 0 else q)
            for node, values in keys.items(): moved[(node, 'rotation')] = np.array(values)
        if motion.get('look') and 'Head' in named:
            # The head keeps looking where the base had it, over the leading shoulder: the neck takes half of the hips' turn back and the head the rest.
            head = named['Head']; neck = parent[head]; turn, place = world(len(moments), moved); back = -np.radians(track[:, 2]) * sign
            yaw = lambda a: np.stack([np.stack([np.cos(a), 0 * a, np.sin(a)], -1), np.stack([0 * a, 1 + 0 * a, 0 * a], -1), np.stack([-np.sin(a), 0 * a, np.cos(a)], -1)], -2)
            new_neck = yaw(back / 2) @ turn[neck]; new_head = yaw(back) @ turn[head]
            for node, local in ((neck, np.swapaxes(turn[parent[neck]], 1, 2) @ new_neck), (head, np.swapaxes(new_neck, 1, 2) @ new_head)):
                values = []
                for m in local: q = np.array(quaternion(m)); values.append(-q if values and q @ values[-1] < 0 else q)
                moved[(node, 'rotation')] = np.array(values)
    turn, place = world(len(moments), moved)
    short = {lead: [], other: []}; bends = {lead: [], other: []}; flats = []; pulls = []; last = {lead: None, other: None}; before = None
    for k in list(range(len(moments))) * 2:  # twice round, keeping the second: a loop then starts with the roll it ends on
        if k == 0: turns = {node: [] for node in turns}; short = {lead: [], other: []}; bends = {lead: [], other: []}; flats = []; pulls = []; before = None
        low = place[trunk[0]][k]; up = unit(place[trunk[1]][k] - low); front = turn[trunk[1]][k] @ np.array([0, 0, 1.0]); front = unit(front - up * (front @ up))
        to_lead = np.cross(up, front) * (1.0 if lead == 'Left' else -1.0)
        middle = (place[ARMS[lead]['upper']][k] + place[ARMS[other]['upper']][k]) / 2
        grip, way, _ = posed[k]; grip = grip + np.array([0, motion['sway'] * np.sin(2 * np.pi * shares[k]), 0])
        at = middle + ARM * (to_lead * grip[0] + up * grip[1] + front * grip[2]); handle = unit(to_lead * way[0] + up * way[1] + front * way[2])
        # The blade's edge leads a cut when its flat faces across the path its point takes; when it is not being swung, across the body.
        point = at + handle * 0.5; speed = 0 if before is None else np.linalg.norm(point - before) * FPS
        across_swing = unit(np.cross(handle, point - before)) if speed > 1.5 else to_lead
        before = point
        hang = {lead: np.array([0, -1.0, 0]) + 0.5 * to_lead - 0.3 * front, other: np.array([0, -1.0, 0]) - 0.5 * to_lead - 0.3 * front}
        if motion.get('elbow'):  # where the other arm's elbow wants to be, when down and out is wrong for it: (out, up, front)
            e = motion['elbow']; hang[other] = -to_lead * e[0] + up * e[1] + front * e[2]
        guess = unit(np.cross(handle, up) if abs(handle @ up) < 0.95 else np.cross(handle, front)); side_way = np.cross(handle, guess)
        # A body with a broad chest or short arms may not reach a grip written for another. The grip is then pulled, a few
        # times over, by what the arms fell short.
        pulled = np.zeros(3)
        for attempt in range(6):
            found = {}
            for side, where in ((lead, at + pulled), (other, at + pulled + handle * along)):
                arm = ARMS[side]; shoulder = place[arm['upper']][k]; best = None
                for n, angle in enumerate(angles):
                    pointer = guess * np.cos(angle) + side_way * np.sin(angle)
                    # The leading hand carries the item, so its turn is the item's: rest handle to handle, rolled. The other lays its own grip along the handle.
                    R = frame(handle, pointer) @ (lead_rest.T if side == lead else arm['hand_rest'].T)
                    wrist = where - R @ arm['reach']
                    elbow, reached, miss = bend(shoulder, wrist, hang[side], arm['a'], arm['b'])
                    bent = float(np.arccos(np.clip(unit(R @ unit(arm['two'])) @ unit(reached - elbow), -1, 1)))
                    flat = 1 - abs(float((R @ flat0) @ across_swing)) if side == lead else 0.0
                    step = 0 if last[side] is None else min(abs(n - last[side]), ROLLS - abs(n - last[side])) * 2 * np.pi / ROLLS
                    cost = miss * 50 + bent * bent + EDGE * flat + SMOOTH * step
                    if best is None or cost < best[0]: best = (cost, n, R, elbow, reached, miss, bent, flat, reached - wrist)
                found[side] = best
            if max(found[side][5] for side in found) < 0.002: break
            pulled = pulled + sum(found[side][8] for side in found)
        pulls.append(np.linalg.norm(pulled))
        for side in (lead, other):
            arm = ARMS[side]; _, last[side], R, elbow, reached, miss, bent, flat, _ = found[side]; short[side].append(miss); bends[side].append(bent)
            if side == lead: flats.append(np.degrees(np.arccos(np.clip(1 - flat, -1, 1))))
            u, f, h = arm['upper'], arm['fore'], arm['hand']; root = place[u][k]; above = turn[parent[u]][k]; as_was = turn[u][k]
            new_upper = between(as_was @ arm['one'], elbow - root) @ as_was
            new_fore = new_upper @ (as_was.T @ turn[f][k]); new_fore = between(new_fore @ arm['two'], reached - elbow) @ new_fore
            for node, local in ((u, above.T @ new_upper), (f, new_upper.T @ new_fore), (h, new_fore.T @ R)):
                q = np.array(quaternion(local)); turns[node].append(-q if turns[node] and q @ turns[node][-1] < 0 else q)
    clock = add(moments, limits=True); clip = {'name': motion['name'], 'samplers': [], 'channels': []}
    def key(node, path, values):
        clip['samplers'].append({'input': clock, 'output': add(np.array(values), 'VEC4' if path == 'rotation' else 'VEC3'), 'interpolation': 'LINEAR'})
        clip['channels'].append({'sampler': len(clip['samplers']) - 1, 'target': {'node': node, 'path': path}})
    for (node, path), values in moved.items():
        if not (node in ours and path == 'rotation'): key(node, path, values)
    for mine, theirs in FINGERS:  # the other hand's fingers do what the leading hand's do, mirrored left to right
        if (theirs, 'rotation') in moved: key(mine, 'rotation', moved[(theirs, 'rotation')] * np.array([1, -1, -1, 1]))
    for node, values in turns.items(): key(node, 'rotation', values)
    doc['animations'].append(clip)
    seam = max(float(np.degrees(2 * np.arccos(min(1, abs(np.array(v[0]) @ np.array(v[-1])))))) for v in turns.values())
    report.append({'name': motion['name'], 'from': base_name, 'seconds': round(float(length), 2),
                   'furthestShortMetres': round(float(max(max(short[lead]), max(short[other]))), 3),
                   'gripPulledMetres': round(float(max(pulls)), 3), 'footShortMetres': round(float(foot_short), 3), 'wristBendDegrees': {lead: round(float(np.degrees(max(bends[lead])))), other: round(float(np.degrees(max(bends[other]))))},
                   'wristWorstAtShare': round(float(shares[int(np.argmax(np.maximum(bends[lead], bends[other])))]), 2), 'bladeOffItsEdgeDegrees': {'typical': round(float(np.median(flats))), 'most': round(float(max(flats)))}, 'firstToLastDegrees': round(seam)})

doc['buffers'][0]['byteLength'] = len(blob)
text = json.dumps(doc, separators=(',', ':')).encode(); text += b' ' * ((4 - len(text) % 4) % 4)
with open(out, 'wb') as f:
    f.write(struct.pack('<4sII', b'glTF', 2, 12 + 8 + len(text) + 8 + len(blob)))
    f.write(struct.pack('<I4s', len(text), b'JSON') + text + struct.pack('<I4s', len(blob), b'BIN\x00') + bytes(blob))
print(json.dumps({'out': out, 'leadingHand': lead + 'Hand', 'item': item_name, 'armMetres': round(float(ARM), 3), 'animations': report, 'bytes': os.path.getsize(out)}))
