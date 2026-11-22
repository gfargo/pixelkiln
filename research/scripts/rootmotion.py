"""Give a character's travelling animations root motion.

  rootmotion.py <character.glb> <out.glb>

The stock walks and runs, and the ones wield.py writes, are made in place: the feet slide back under a body
that stays where it is, and the game moves the character at a speed somebody has to guess. This measures that
speed from the feet and writes it into the file.

The skeleton gets a bone named Root on the ground under the hips, as their parent, if it has none. For each
travelling animation the ankles and the balls of the feet are followed. Whichever is lowest, while it is as low as
it gets, is on the ground, and how fast it goes back under the body is how fast the ground goes by. A foot just
landing or about to leave is slower than the ground, so the pace taken is the middle one of the faster half of those
moments. Root is then keyed to move forward at it for the animation's length.
An engine that reads root motion (Godot's root_motion_track, Unity's root node) takes the movement off that
bone and moves the character by it. A player that does not will show the character walk forward and jump back
at each loop, so keep the file without root motion for those.

The animation's own bones are not changed, so taking the Root track away gives the in-place animation back.

Environment:
  CLIPS   which animations travel, as a pattern on their names (default ^(?!First).*(Walk|Jog|Sprint|Run|Advance|_Fwd$))
  ONCE    which of those play once and carry the character somewhere, such as an attack with a step that is not taken
          back (default _Fwd$). Root follows the planted foot through these, and stays put while no foot is down
  PLANT   1 to move Root at the planted foot's own pace at each moment, so that foot does not slide; the pace is
          then uneven. The default is a steady pace, which leaves the slide the report gives
  FPS     samples a second (default 30)
  ROOT    the bone's name (default Root)
  NEAR    how far above its lowest a point of a foot may be and still count as on the ground, in metres (default 0.02)
  LEAST   an animation whose ground goes by slower than this, in metres a second, gets no track (default 0.05)

Needs numpy.
"""
import json, os, re, struct, sys
import numpy as np

source, out = sys.argv[1:3]
env = os.environ.get
CLIPS = re.compile(env('CLIPS', '^(?!First).*(Walk|Jog|Sprint|Run|Advance|_Fwd$)')); ONCE = re.compile(env('ONCE', '_Fwd$')); PLANT = env('PLANT') == '1'; FPS = float(env('FPS', '30'))
ROOT = env('ROOT', 'Root'); LEAST = float(env('LEAST', '0.05')); NEAR = float(env('NEAR', '0.02'))
COMPONENTS = {'SCALAR': 1, 'VEC2': 2, 'VEC3': 3, 'VEC4': 4, 'MAT4': 16}

with open(source, 'rb') as f:
    f.read(12); size, _ = struct.unpack('<I4s', f.read(8)); doc = json.loads(f.read(size))
    size, _ = struct.unpack('<I4s', f.read(8)); blob = bytearray(f.read(size))


def read(index):
    a = doc['accessors'][index]; view = doc['bufferViews'][a['bufferView']]; width = COMPONENTS[a['type']]
    start = view.get('byteOffset', 0) + a.get('byteOffset', 0); step = 4 * width; stride = view.get('byteStride', step)
    rows = [np.frombuffer(bytes(blob[start + n * stride:start + n * stride + step]), np.float32) for n in range(a['count'])]
    return np.stack(rows).astype(np.float64)


def add(array, kind='SCALAR', limits=False):
    data = np.ascontiguousarray(array, np.float32).tobytes(); offset = len(blob)
    blob.extend(data + b'\x00' * ((4 - len(data) % 4) % 4))
    doc['bufferViews'].append({'buffer': 0, 'byteOffset': offset, 'byteLength': len(data)})
    entry = {'bufferView': len(doc['bufferViews']) - 1, 'componentType': 5126, 'count': len(array), 'type': kind}
    if limits: entry['min'] = [float(np.min(array))]; entry['max'] = [float(np.max(array))]
    doc['accessors'].append(entry); return len(doc['accessors']) - 1


def matrix(q):
    q = q / np.linalg.norm(q, axis=-1, keepdims=True); x, y, z, w = np.moveaxis(q, -1, 0)
    return np.stack([np.stack([1 - 2 * (y * y + z * z), 2 * (x * y - z * w), 2 * (x * z + y * w)], -1),
                     np.stack([2 * (x * y + z * w), 1 - 2 * (x * x + z * z), 2 * (y * z - x * w)], -1),
                     np.stack([2 * (x * z - y * w), 2 * (y * z + x * w), 1 - 2 * (x * x + y * y)], -1)], -2)


def sample(times, values, at, turning):
    if len(times) == 1: return np.repeat(values[:1], len(at), 0)
    i = np.clip(np.searchsorted(times, at, side='right') - 1, 0, len(times) - 2)
    w = np.clip((at - times[i]) / np.maximum(times[i + 1] - times[i], 1e-9), 0, 1)[:, None]
    a, b = values[i], values[i + 1]
    if turning:
        b = np.where((a * b).sum(1, keepdims=True) < 0, -b, b); v = a * (1 - w) + b * w
        return v / np.linalg.norm(v, axis=1, keepdims=True)
    return a * (1 - w) + b * w


nodes = doc['nodes']; parent = {child: i for i, node in enumerate(nodes) for child in node.get('children', [])}
named = {node.get('name'): i for i, node in enumerate(nodes)}
for bone in ('Hips', 'LeftFoot', 'RightFoot'):
    if bone not in named: sys.exit(f'no bone named {bone}: rig the character first')
hips = named['Hips']; added = False
if hips in parent and nodes[parent[hips]].get('name') == ROOT: root = parent[hips]
else:
    if hips in parent: sys.exit(f"the hips hang under {nodes[parent[hips]].get('name')}, not {ROOT}: name that bone with ROOT")
    nodes.append({'name': ROOT, 'children': [hips]}); root = len(nodes) - 1; parent[hips] = root; added = True
    for scene in doc.get('scenes', []): scene['nodes'] = [root if n == hips else n for n in scene['nodes']]
    for skin in doc.get('skins', []):
        if hips not in skin['joints']: continue
        skin['joints'].append(root); skin['skeleton'] = root  # last, so the meshes' joint numbers still mean what they did
        if 'inverseBindMatrices' in skin: skin['inverseBindMatrices'] = add(np.concatenate([read(skin['inverseBindMatrices']), np.eye(4).reshape(1, 16)]), 'MAT4')
rest = lambda i, key, default: np.array(nodes[i].get(key, default), float)


POINTS = [named[n] for n in ('LeftFoot', 'RightFoot', 'LeftToes', 'RightToes') if n in named]


def feet(moved, count):
    """Where the ankles and the balls of the feet are at every moment, with Root left where it is."""
    places = []
    for point in POINTS:
        chain = [point]
        while chain[-1] in parent and chain[-1] != root: chain.append(parent[chain[-1]])
        turn = np.repeat(np.eye(3)[None], count, 0); place = np.zeros((count, 3))
        for i in reversed(chain):
            if i == root: continue
            t = moved.get((i, 'translation'), np.repeat(rest(i, 'translation', [0, 0, 0])[None], count, 0))
            r = matrix(moved.get((i, 'rotation'), np.repeat(rest(i, 'rotation', [0, 0, 0, 1])[None], count, 0)))
            place = place + np.einsum('kij,kj->ki', turn, t); turn = turn @ r
        places.append(place)
    return np.stack(places)


report = []
for clip in doc['animations']:
    if not CLIPS.search(clip['name']): continue
    kept = [c for c in clip['channels'] if not (c['target']['node'] == root and c['target']['path'] == 'translation')]
    channels = {(c['target']['node'], c['target']['path']): (read(clip['samplers'][c['sampler']]['input'])[:, 0], read(clip['samplers'][c['sampler']]['output'])) for c in kept}
    length = max(times[-1] for times, _ in channels.values()); count = max(2, int(round(length * FPS)) + 1); moments = np.linspace(0, length, count); gap = length / (count - 1)
    moved = {key: sample(times, values, moments, key[1] == 'rotation') for key, (times, values) in channels.items() if key[1] != 'scale'}
    places = feet(moved, count); pick = np.arange(count - 1)
    # A point is on the ground when it is as low as it ever gets. Between each moment and the next, the lowest point is
    # the one looked at; while it is on the ground, how fast it goes back under the body is how fast the ground goes by.
    high = places[:, :, 1] - places[:, :, 1].min(1, keepdims=True); high = (high[:, :-1] + high[:, 1:]) / 2
    down = np.argmin(high, 0); planted = high[down, pick] < NEAR
    pace = -(places[down, pick + 1, 2] - places[down, pick, 2]) / gap; side = -(places[down, pick + 1, 0] - places[down, pick, 0]) / gap
    if not planted.any(): report.append({'name': clip['name'], 'rootMotion': False, 'why': 'no foot comes near the ground'}); continue
    once = bool(ONCE.search(clip['name']))
    speed = float(np.percentile(pace[planted], 75)); ground = float(pace[planted].sum() * gap) if once else speed * length
    if once: speed = ground / length
    entry = {'name': clip['name'], 'seconds': round(float(length), 2), 'groundMetres': round(ground, 3), 'metresASecond': round(speed, 2),
             'sidewaysMetresASecond': round(float(np.median(side[planted & (pace >= np.median(pace[planted]))])), 2), 'shareOnTheGround': round(float(planted.mean()), 2)}
    if abs(speed) < LEAST and not once: report.append({**entry, 'rootMotion': False}); continue
    steps = np.where(planted, pace, 0.0) * gap if once else np.where(planted, pace, speed) * gap if PLANT else np.full(count - 1, speed * gap)
    travel = np.concatenate([[0], np.cumsum(steps)])
    # How far a foot slides over the ground while it is down: the spread of where its point is, each time it is down.
    slide = 0.0; k = 0
    while k < count - 1:
        if not planted[k]: k += 1; continue
        end = k
        while end + 1 < count - 1 and planted[end + 1] and down[end + 1] == down[k]: end += 1
        stretch = places[down[k], k:end + 2, 2] + travel[k:end + 2]; slide = max(slide, float(stretch.max() - stretch.min())); k = end + 1
    clock = add(moments, limits=True); keys = np.zeros((count, 3)); keys[:, 2] = travel; keys += rest(root, 'translation', [0, 0, 0])
    clip['channels'] = kept
    clip['samplers'].append({'input': clock, 'output': add(keys, 'VEC3'), 'interpolation': 'LINEAR'})
    clip['channels'].append({'sampler': len(clip['samplers']) - 1, 'target': {'node': root, 'path': 'translation'}})
    report.append({**entry, 'rootMotion': True, 'pace': 'planted' if once or PLANT else 'steady', 'footSlideMetres': round(slide, 3), 'paceLeastMost': [round(float(pace[planted].min()), 2), round(float(pace[planted].max()), 2)]})

doc['buffers'][0]['byteLength'] = len(blob)
text = json.dumps(doc, separators=(',', ':')).encode(); text += b' ' * ((4 - len(text) % 4) % 4)
with open(out, 'wb') as f:
    f.write(struct.pack('<4sII', b'glTF', 2, 12 + 8 + len(text) + 8 + len(blob)))
    f.write(struct.pack('<I4s', len(text), b'JSON') + text + struct.pack('<I4s', len(blob), b'BIN\x00') + bytes(blob))
print(json.dumps({'out': out, 'rootBone': ROOT, 'rootAdded': added, 'pace': 'planted' if PLANT else 'steady', 'animations': report, 'bytes': os.path.getsize(out)}))
