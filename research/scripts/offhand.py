"""Bring the other hand to a two-handed grip, in every animation.

  offhand.py <character.glb> <out.glb>

rig.py's "two-handed" kind of item puts a thing in one hand and leaves a bone, <Side>Grip2, on that hand
where the other hand belongs. Stock animations know nothing of it: the other arm swings free. This reads
each animation, and at every moment turns the other arm so that its hand lands on that bone.

At each moment the leading hand is turned as the animation turned it, and the handle with it. The other
hand is turned so that its grip lies along the handle, thumb towards the guard. That leaves one freedom,
the roll round the handle, and it is chosen so that the wrist bends least, without jumping from one moment
to the next.

A stock one-handed animation holds its sword out at one side, further than the other arm can reach. So the
whole grip is pulled, by the least distance that lets both arms reach it with both hands in front of the
body. Both arms are then solved as triangles of two fixed sides from shoulder to wrist, each elbow pointing
down, outwards and a little back. The report says how far the grip was pulled and whether the hand ever fell short.

If both hands have finger bones, the other hand's fingers copy the leading hand's, mirrored, so that it
closes when the leading hand does.

The result is stored as keys on both arms and hands, so it plays in any engine. An engine with
its own arm solver can use the <Side>Grip2 bone directly and skip this.

Environment:
  FPS     samples a second (default 30)
  ROLLS   how many rolls round the handle are tried at each moment (default 48)
  SMOOTH  how much a change of roll from the moment before costs (default 0.5)
  REACH   the share of an arm's length it may be asked to reach (default 0.95)
  PULL    how much pulling the grip costs, a metre, against a radian of wrist bend (default 3)
  FRONT   how far in front of the spine both hands are kept, in metres (default 0.22)

Needs numpy.
"""
import json, os, struct, sys
import numpy as np

source, out = sys.argv[1:3]
env = os.environ.get
FPS = float(env('FPS', '30')); ROLLS = int(env('ROLLS', '48')); SMOOTH = float(env('SMOOTH', '0.5'))
REACH, PULL, FRONT = float(env('REACH', '0.95')), float(env('PULL', '3')), float(env('FRONT', '0.22'))
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


# ---- the grip: the bone rig.py left on the leading hand, and the hand that goes to it
target = next((i for i, node in enumerate(nodes) if 'handle' in (node.get('extras') or {})), None)
if target is None: sys.exit('no <Side>Grip2 bone found: rig the character with a "two-handed" item first')
hand_name = nodes[target]['extras']['hand']; side = hand_name.replace('Hand', ''); lead = 'Left' if side == 'Right' else 'Right'
upper, fore, hand, grip = (named[side + part] for part in ('UpperArm', 'LowerArm', 'Hand', 'Grip'))
rest_turn, rest_place = world(1, {})
unit = lambda v: v / (np.linalg.norm(v) + 1e-12)
frame = lambda a, p: np.stack([unit(a), unit(p - unit(a) * (p @ unit(a))), np.cross(unit(a), unit(p - unit(a) * (p @ unit(a))))], 1)
# The hand at rest: its grip's line and its palm, as rig.py measured them, and where its grip is from its wrist.
hand_rest = frame(np.array(nodes[grip]['extras']['across'], float), np.array(nodes[grip]['extras']['palm'], float))
reach_rest = rest_place[grip][0] - rest_place[hand][0]
handle_rest = rest_turn[target][0].T @ np.array(nodes[target]['extras']['handle'], float)  # the handle's line, as the grip bone sees it
palm_rest = np.array(nodes[named[lead + 'Grip']]['extras']['palm'], float)  # the leading hand's palm: a first guess for the other's
first, second = rest(fore, 'translation', [0, 0, 0]), rest(hand, 'translation', [0, 0, 0])  # the upper arm and the forearm, each as its parent sees it
L1, L2 = np.linalg.norm(first), np.linalg.norm(second)
FINGERS = [(named[side + bone], named[lead + bone]) for bone in ('ThumbMetacarpal', 'ThumbProximal', 'ThumbDistal', 'MiddleProximal', 'MiddleIntermediate', 'MiddleDistal')
           if side + bone in named and lead + bone in named]
ours = {upper, fore, hand} | {mine for mine, _ in FINGERS}
angles = np.linspace(0, 2 * np.pi, ROLLS, endpoint=False)

lead_upper, lead_fore, lead_hand = (named[lead + part] for part in ('UpperArm', 'LowerArm', 'Hand'))
lead_first, lead_second = rest(lead_fore, 'translation', [0, 0, 0]), rest(lead_hand, 'translation', [0, 0, 0])
M1, M2 = np.linalg.norm(lead_first), np.linalg.norm(lead_second)
ours |= {lead_upper, lead_fore, lead_hand}
trunk = [named['Hips'], named['Chest'] if 'Chest' in named else named['Spine']]


def bend(shoulder, wrist, was, a, b):
    """An arm of two fixed lengths from shoulder to wrist: where its elbow goes, and where its wrist ends if it cannot reach."""
    far = np.linalg.norm(wrist - shoulder); span = float(np.clip(far, abs(a - b) + 1e-4, a + b - 1e-4)); way = (wrist - shoulder) / (far + 1e-12)
    near = (a * a - b * b + span * span) / (2 * span); rise = np.sqrt(max(a * a - near * near, 0))
    pole = was - way * (was @ way); pole = unit(pole) if np.linalg.norm(pole) > 1e-4 else unit(np.cross(way, [1, 0, 0]))
    return shoulder + way * near + pole * rise, shoulder + way * span, abs(far - span)


def into(point, centre, radius):  # the nearest place to a point that is within a radius of a centre
    away = point - centre; far = np.linalg.norm(away)
    return point if far <= radius else centre + away / far * radius


report = []
for clip in doc['animations']:
    channels = {(c['target']['node'], c['target']['path']): (read(clip['samplers'][c['sampler']]['input'])[:, 0], read(clip['samplers'][c['sampler']]['output'])) for c in clip['channels']}
    length = max(times[-1] for times, _ in channels.values())
    moments = np.linspace(0, length, max(2, int(round(length * FPS)) + 1))
    moved = {key: sample(times, values, moments, key[1] == 'rotation') for key, (times, values) in channels.items() if key[1] != 'scale'}
    turn, place = world(len(moments), moved)
    turns = {node: [] for node in (upper, fore, hand, lead_upper, lead_fore, lead_hand)}; short = []; bends = []; pulls = []; last = None
    for k in range(len(moments)):
        at = place[target][k]; handle = unit(turn[target][k] @ handle_rest); shoulder = place[upper][k]; lead_shoulder = place[lead_upper][k]
        guess = turn[parent[target]][k] @ palm_rest; guess = unit(guess - handle * (guess @ handle)); side_way = np.cross(handle, guess)
        low = place[trunk[0]][k]; spine = unit(place[trunk[1]][k] - low); front = turn[trunk[1]][k] @ np.array([0, 0, 1.0]); front = unit(front - spine * (front @ spine))  # the way the chest faces
        out_way = turn[trunk[1]][k] @ np.array([1.0 if side == 'Left' else -1.0, 0, 0])
        hang = {side: np.array([0, -1.0, 0]) + 0.5 * out_way - 0.3 * front, lead: np.array([0, -1.0, 0]) - 0.5 * out_way - 0.3 * front}  # where an elbow wants to be: down, out and a little back
        best = None
        for n, angle in enumerate(angles):
            R = frame(handle, guess * np.cos(angle) + side_way * np.sin(angle)) @ hand_rest.T  # the other hand's turn, in the world
            wrist = at - R @ reach_rest; other = place[lead_hand][k] - wrist  # from this wrist to the leading one: fixed, since both are on the handle
            # Neither arm may be asked to reach further than it is long. The whole grip is pulled the least distance
            # that lets both reach, and kept out of the trunk.
            moved_to = wrist.copy()
            for _ in range(12):
                moved_to = into(moved_to, shoulder, REACH * (L1 + L2)); moved_to = into(moved_to + other, lead_shoulder, REACH * (M1 + M2)) - other
                for offset in (np.zeros(3), other):
                    ahead = (moved_to + offset - low) @ front
                    if ahead < FRONT: moved_to = moved_to + front * (FRONT - ahead)
            pull = moved_to - wrist
            elbow, reached, miss = bend(shoulder, wrist + pull, hang[side], L1, L2)
            bent = float(np.arccos(np.clip(unit(R @ unit(second)) @ unit(reached - elbow), -1, 1)))  # how far the wrist bends from the forearm's line
            step = 0 if last is None else min(abs(n - last), ROLLS - abs(n - last)) * 2 * np.pi / ROLLS
            cost = miss * 50 + np.linalg.norm(pull) * PULL + bent + SMOOTH * step
            if best is None or cost < best[0]: best = (cost, n, R, elbow, reached, miss, bent, pull)
        _, last, R, elbow, reached, miss, bent, pull = best; short.append(miss); bends.append(bent); pulls.append(np.linalg.norm(pull))
        for (u, f, h, a_, b_, one, two, hand_turn, wrist_at) in ((upper, fore, hand, L1, L2, first, second, R, None), (lead_upper, lead_fore, lead_hand, M1, M2, lead_first, lead_second, turn[lead_hand][k], place[lead_hand][k] + pull)):
            root = place[u][k]
            if wrist_at is not None: elbow, reached, _ = bend(root, wrist_at, hang[lead], a_, b_)
            above = turn[parent[u]][k]; as_was = turn[u][k]
            new_upper = between(as_was @ one, elbow - root) @ as_was
            new_fore = new_upper @ (as_was.T @ turn[f][k]); new_fore = between(new_fore @ two, reached - elbow) @ new_fore
            for node, local in ((u, above.T @ new_upper), (f, new_upper.T @ new_fore), (h, new_fore.T @ hand_turn)):
                q = np.array(quaternion(local)); turns[node].append(-q if turns[node] and q @ turns[node][-1] < 0 else q)
    clock = add(moments, limits=True)
    clip['channels'] = [c for c in clip['channels'] if not (c['target'].get('node') in ours and c['target']['path'] == 'rotation')]
    for mine, theirs in FINGERS:  # the other hand's fingers do what the leading hand's do, mirrored left to right
        if (theirs, 'rotation') in moved: turns[mine] = moved[(theirs, 'rotation')] * np.array([1, -1, -1, 1])
    for node, values in turns.items():
        clip['samplers'].append({'input': clock, 'output': add(np.array(values), 'VEC4'), 'interpolation': 'LINEAR'})
        clip['channels'].append({'sampler': len(clip['samplers']) - 1, 'target': {'node': node, 'path': 'rotation'}})
    used = {c['sampler'] for c in clip['channels']}; renumber = {old: new for new, old in enumerate(sorted(used))}  # drop the samplers nothing plays any more
    clip['samplers'] = [clip['samplers'][old] for old in sorted(used)]
    for c in clip['channels']: c['sampler'] = renumber[c['sampler']]
    short = np.array(short)
    report.append({'name': clip['name'], 'onGrip': round(float((short < 0.01).mean()), 2), 'furthestShortMetres': round(float(short.max()), 3), 'gripPulledMetres': round(float(max(pulls)), 2), 'wristBendDegrees': round(float(np.degrees(max(bends))))})

doc['buffers'][0]['byteLength'] = len(blob)
text = json.dumps(doc, separators=(',', ':')).encode(); text += b' ' * ((4 - len(text) % 4) % 4)
with open(out, 'wb') as f:
    f.write(struct.pack('<4sII', b'glTF', 2, 12 + 8 + len(text) + 8 + len(blob)))
    f.write(struct.pack('<I4s', len(text), b'JSON') + text + struct.pack('<I4s', len(blob), b'BIN\x00') + bytes(blob))
print(json.dumps({'out': out, 'hand': hand_name, 'fingersCopied': len(FINGERS), 'animations': report, 'bytes': os.path.getsize(out)}))
