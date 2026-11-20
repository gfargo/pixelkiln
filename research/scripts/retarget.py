"""Put animations from a stock humanoid library onto a character rigged by rig.py.

  retarget.py <character.glb> <library.glb> <out.glb>

<character.glb> has rig.py's humanoid skeleton (Hips, Spine, Chest ... LeftToes), whose bones carry no
rotation at rest. <library.glb> is a rigged humanoid with animations, here Quaternius's Universal
Animation Library (CC0), whose bones are named as Unreal's mannequin names them (pelvis, spine_01,
upperarm_l ...). The two skeletons differ in bone count, proportions and rest pose, so keyframes
cannot be copied across.

For each bone and each moment, the library bone's turn away from its rest pose is taken in world
space and given to the matching bone of the character. The two rest poses need not agree: each of
the character's limbs is first turned to point the way the library's limb points at rest. Where the
character has finger bones (rig.py adds a thumb and one chain for the fingers when the mesh has a thumb),
they follow the library's thumb and middle finger, so a hand closes into a fist or round a grip. The hips
also move, by the library's hip travel scaled to the character's hip height. Everything is sampled
at a fixed rate and written as new animations in a copy of the character's file.

Environment:
  ANIMS   which animations to take, comma separated (default: a walk, a jog, an idle, a sword attack, a death and a few more)
  FPS     samples a second (default 30)
  MAP     extra or replacement bone pairs, "Chest=spine_03,Neck=neck_01"

Needs numpy.
"""
import json, os, struct, sys
import numpy as np

character_file, library_file, out = sys.argv[1:4]
env = os.environ.get
FPS = float(env('FPS', '30'))
WANT = env('ANIMS', 'Idle_Loop,Walk_Loop,Jog_Fwd_Loop,Sprint_Loop,Sword_Idle,Sword_Attack,Hit_Chest,Death01,Jump_Start,Roll,Dance_Loop').split(',')
PAIRS = {'Hips': 'pelvis', 'Spine': 'spine_01', 'Chest': 'spine_03', 'Neck': 'neck_01', 'Head': 'Head'}
for side, s in (('Left', 'l'), ('Right', 'r')):
    PAIRS.update({f'{side}Shoulder': f'clavicle_{s}', f'{side}UpperArm': f'upperarm_{s}', f'{side}LowerArm': f'lowerarm_{s}', f'{side}Hand': f'hand_{s}',
                  f'{side}UpperLeg': f'thigh_{s}', f'{side}LowerLeg': f'calf_{s}', f'{side}Foot': f'foot_{s}', f'{side}Toes': f'ball_{s}'})
for pair in filter(None, env('MAP', '').split(',')):
    ours, theirs = pair.split('='); PAIRS[ours] = theirs
COMPONENTS = {'SCALAR': 1, 'VEC2': 2, 'VEC3': 3, 'VEC4': 4, 'MAT4': 16}
KINDS = {5120: np.int8, 5121: np.uint8, 5122: np.int16, 5123: np.uint16, 5125: np.uint32, 5126: np.float32}


def load(path):
    with open(path, 'rb') as f:
        f.read(12); size, _ = struct.unpack('<I4s', f.read(8)); doc = json.loads(f.read(size))
        size, _ = struct.unpack('<I4s', f.read(8)); return doc, bytearray(f.read(size))


def accessor(doc, blob, index):
    a = doc['accessors'][index]; view = doc['bufferViews'][a['bufferView']]
    width = COMPONENTS[a['type']]; kind = np.dtype(KINDS[a['componentType']])
    start = view.get('byteOffset', 0) + a.get('byteOffset', 0); stride = view.get('byteStride', 0)
    if stride and stride != width * kind.itemsize:
        rows = np.frombuffer(bytes(blob[start:start + stride * a['count']]), np.uint8).reshape(a['count'], stride)[:, :width * kind.itemsize]
        return np.frombuffer(rows.tobytes(), kind).reshape(a['count'], width).astype(np.float64)
    return np.frombuffer(bytes(blob[start:start + a['count'] * width * kind.itemsize]), kind).reshape(a['count'], width).astype(np.float64)


def matrix(q):
    """Rotation matrices from quaternions (x, y, z, w), for any leading shape."""
    q = q / np.linalg.norm(q, axis=-1, keepdims=True); x, y, z, w = np.moveaxis(q, -1, 0)
    return np.stack([np.stack([1 - 2 * (y * y + z * z), 2 * (x * y - z * w), 2 * (x * z + y * w)], -1),
                     np.stack([2 * (x * y + z * w), 1 - 2 * (x * x + z * z), 2 * (y * z - x * w)], -1),
                     np.stack([2 * (x * z - y * w), 2 * (y * z + x * w), 1 - 2 * (x * x + y * y)], -1)], -2)


def quaternion(m):
    """Quaternions (x, y, z, w) from rotation matrices."""
    out = np.zeros(m.shape[:-2] + (4,))
    trace = m[..., 0, 0] + m[..., 1, 1] + m[..., 2, 2]
    for index in np.ndindex(m.shape[:-2]):
        r = m[index]; t = trace[index]
        if t > 0: s = np.sqrt(t + 1) * 2; q = [(r[2, 1] - r[1, 2]) / s, (r[0, 2] - r[2, 0]) / s, (r[1, 0] - r[0, 1]) / s, s / 4]
        elif r[0, 0] > r[1, 1] and r[0, 0] > r[2, 2]: s = np.sqrt(1 + r[0, 0] - r[1, 1] - r[2, 2]) * 2; q = [s / 4, (r[0, 1] + r[1, 0]) / s, (r[0, 2] + r[2, 0]) / s, (r[2, 1] - r[1, 2]) / s]
        elif r[1, 1] > r[2, 2]: s = np.sqrt(1 + r[1, 1] - r[0, 0] - r[2, 2]) * 2; q = [(r[0, 1] + r[1, 0]) / s, s / 4, (r[1, 2] + r[2, 1]) / s, (r[0, 2] - r[2, 0]) / s]
        else: s = np.sqrt(1 + r[2, 2] - r[0, 0] - r[1, 1]) * 2; q = [(r[0, 2] + r[2, 0]) / s, (r[1, 2] + r[2, 1]) / s, s / 4, (r[1, 0] - r[0, 1]) / s]
        out[index] = q
    return out


def between(a, b):
    """The smallest rotation that turns direction a to direction b."""
    a, b = a / np.linalg.norm(a), b / np.linalg.norm(b); axis = np.cross(a, b); s = np.linalg.norm(axis); c = float(a @ b)
    if s < 1e-8: return np.eye(3)
    k = axis / s; K = np.array([[0, -k[2], k[1]], [k[2], 0, -k[0]], [-k[1], k[0], 0]])
    return np.eye(3) + s * K + (1 - c) * K @ K


def sample(times, values, at, turning):
    """A channel's value at each moment: straight between keys, renormalised for rotations."""
    if len(times) == 1: return np.repeat(values[:1], len(at), 0)
    i = np.clip(np.searchsorted(times, at, side='right') - 1, 0, len(times) - 2)
    w = np.clip((at - times[i]) / np.maximum(times[i + 1] - times[i], 1e-9), 0, 1)[:, None]
    a, b = values[i], values[i + 1]
    if turning:
        b = np.where((a * b).sum(1, keepdims=True) < 0, -b, b); v = a * (1 - w) + b * w
        return v / np.linalg.norm(v, axis=1, keepdims=True)
    return a * (1 - w) + b * w


class Skeleton:
    def __init__(self, doc):
        self.nodes = doc['nodes']; self.parent = {}
        for i, node in enumerate(self.nodes):
            for child in node.get('children', []): self.parent[child] = i
        self.named = {node.get('name'): i for i, node in enumerate(self.nodes)}
        self.order = []
        def visit(i):
            self.order.append(i)
            for child in self.nodes[i].get('children', []): visit(child)
        for i in range(len(self.nodes)):
            if i not in self.parent: visit(i)

    def rest(self, i, key, default):
        return np.array(self.nodes[i].get(key, default), float)

    def world(self, moments, moved):
        """World rotation and position of every node at each moment. `moved` holds sampled channels by (node, path)."""
        turn, place = {}, {}
        for i in self.order:
            t = moved.get((i, 'translation'), np.repeat(self.rest(i, 'translation', [0, 0, 0])[None], moments, 0))
            r = matrix(moved.get((i, 'rotation'), np.repeat(self.rest(i, 'rotation', [0, 0, 0, 1])[None], moments, 0)))
            if i in self.parent:
                p = self.parent[i]; turn[i] = turn[p] @ r; place[i] = place[p] + np.einsum('kij,kj->ki', turn[p], t)
            else: turn[i], place[i] = r, t
        return turn, place


character, character_blob = load(character_file); library, library_blob = load(library_file)
ours, theirs = Skeleton(character), Skeleton(library)
# Finger bones, where rig.py found a thumb: its one chain for the fingers follows the library's middle finger.
FINGERS = {}
for side, s in (('Left', 'l'), ('Right', 'r')):
    chain = {f'{side}ThumbMetacarpal': f'thumb_01_{s}', f'{side}ThumbProximal': f'thumb_02_{s}', f'{side}ThumbDistal': f'thumb_03_{s}',
             f'{side}MiddleProximal': f'middle_01_{s}', f'{side}MiddleIntermediate': f'middle_02_{s}', f'{side}MiddleDistal': f'middle_03_{s}'}
    chain = {a: PAIRS.get(a, b) for a, b in chain.items()}
    if all(a in ours.named for a in chain) and all(b in theirs.named for b in chain.values()): PAIRS.update(chain); FINGERS[side] = list(chain)
missing = [(a, b) for a, b in PAIRS.items() if a not in ours.named or b not in theirs.named]
if missing: sys.exit(f'bones not found: {missing}')
bones = [name for name in (character['nodes'][j]['name'] for j in character['skins'][0]['joints']) if name in PAIRS]
our_turn, our_place = ours.world(1, {}); their_turn, their_place = theirs.world(1, {})
at = lambda skeleton, places, name: places[skeleton.named[name]][0]
# Both must face the same way: the toes are ahead of the ankles.
ahead = lambda skeleton, places, foot, toes: np.sign((at(skeleton, places, toes) - at(skeleton, places, foot))[2])
if ahead(ours, our_place, 'LeftFoot', 'LeftToes') != ahead(theirs, their_place, 'foot_l', 'ball_l'): sys.exit('the two characters face opposite ways')
if np.sign(at(ours, our_place, 'LeftUpperArm')[0]) != np.sign(at(theirs, their_place, 'upperarm_l')[0]): sys.exit('left and right are swapped between the two skeletons: pass MAP to cross them')

# Turn each of the character's limbs to point the way the library's does at rest.
CHILD = {'Hips': 'Spine', 'Spine': 'Chest', 'Chest': 'Neck', 'Neck': 'Head'}
for side in ('Left', 'Right'):
    CHILD.update({f'{side}Shoulder': f'{side}UpperArm', f'{side}UpperArm': f'{side}LowerArm', f'{side}LowerArm': f'{side}Hand',
                  f'{side}UpperLeg': f'{side}LowerLeg', f'{side}LowerLeg': f'{side}Foot', f'{side}Foot': f'{side}Toes'})
align = {}
for name in bones:
    if name in CHILD:
        mine = at(ours, our_place, CHILD[name]) - at(ours, our_place, name)
        yours = at(theirs, their_place, PAIRS[CHILD[name]]) - at(theirs, their_place, PAIRS[name])
        align[name] = between(mine, yours)
    else: align[name] = np.eye(3)
# A hand with fingers is turned as a whole, so that its palm faces the way the library's does: a finger curls
# about the line of the knuckles, and that line has to agree. Each finger bone then starts from the turn of the
# bone above it and adds the least turn that points it along the library's.
def palm(skeleton, places, wrist, finger, thumb):
    x = at(skeleton, places, finger) - at(skeleton, places, wrist); x /= np.linalg.norm(x)
    z = np.cross(x, at(skeleton, places, thumb) - at(skeleton, places, wrist)); z /= np.linalg.norm(z)
    return np.stack([x, np.cross(z, x), z], 1)
for side, chain in FINGERS.items():
    hand = f'{side}Hand'
    align[hand] = palm(theirs, their_place, PAIRS[hand], PAIRS[f'{side}MiddleProximal'], PAIRS[f'{side}ThumbProximal']) @ palm(ours, our_place, hand, f'{side}MiddleProximal', f'{side}ThumbProximal').T
    for k, name in enumerate(chain):
        above = hand if k % 3 == 0 else chain[k - 1]
        if k % 3 == 2: align[name] = align[above]; continue
        mine = align[above] @ (at(ours, our_place, chain[k + 1]) - at(ours, our_place, name))
        align[name] = between(mine, at(theirs, their_place, PAIRS[chain[k + 1]]) - at(theirs, their_place, PAIRS[name])) @ align[above]
hip_scale = at(ours, our_place, 'Hips')[1] / at(theirs, their_place, 'pelvis')[1]
hips_rest = np.array(character['nodes'][ours.named['Hips']].get('translation', [0, 0, 0]), float)


def add(array, kind='SCALAR', limits=False):
    data = np.ascontiguousarray(array, np.float32).tobytes(); offset = len(character_blob)
    character_blob.extend(data + b'\x00' * ((4 - len(data) % 4) % 4))
    character['bufferViews'].append({'buffer': 0, 'byteOffset': offset, 'byteLength': len(data)})
    entry = {'bufferView': len(character['bufferViews']) - 1, 'componentType': 5126, 'count': len(array), 'type': kind}
    if limits: entry['min'] = [float(np.min(array))]; entry['max'] = [float(np.max(array))]
    character['accessors'].append(entry); return len(character['accessors']) - 1


added = []
for clip in library['animations']:
    if clip['name'] not in WANT: continue
    # Godot drops a trailing _Loop on import, so the library's Walk_Loop would collide with a Walk already here.
    for mine in character['animations']:
        if mine['name'] == clip['name'].removesuffix('_Loop'): mine['name'] = 'First_' + mine['name']
    channels = {}
    for channel in clip['channels']:
        sampler = clip['samplers'][channel['sampler']]
        channels[(channel['target']['node'], channel['target']['path'])] = (accessor(library, library_blob, sampler['input'])[:, 0], accessor(library, library_blob, sampler['output']))
    length = max(times[-1] for times, _ in channels.values())
    moments = np.linspace(0, length, max(2, int(round(length * FPS)) + 1))
    moved = {key: sample(times, values, moments, key[1] == 'rotation') for key, (times, values) in channels.items() if key[1] != 'scale'}
    turn, place = theirs.world(len(moments), moved)
    world = {}
    for name in bones:
        source = theirs.named[PAIRS[name]]
        world[name] = turn[source] @ their_turn[source][0].T @ align[name]  # the library bone's turn from rest, on the realigned bone
    samplers, targets = [], []
    clock = add(moments, limits=True)
    for name in bones:
        node = ours.named[name]; above = character['nodes'][ours.parent[node]].get('name') if node in ours.parent else None
        local = np.swapaxes(world[above], 1, 2) @ world[name] if above in world else world[name]
        q = quaternion(local)
        for k in range(1, len(q)):  # keep neighbouring keys on the same side, so the blend between them takes the short way
            if q[k] @ q[k - 1] < 0: q[k] = -q[k]
        samplers.append({'input': clock, 'output': add(q, 'VEC4'), 'interpolation': 'LINEAR'}); targets.append({'node': node, 'path': 'rotation'})
    pelvis = theirs.named['pelvis']
    travel = hips_rest + (place[pelvis] - their_place[pelvis][0]) * hip_scale
    samplers.append({'input': clock, 'output': add(travel, 'VEC3'), 'interpolation': 'LINEAR'}); targets.append({'node': ours.named['Hips'], 'path': 'translation'})
    character['animations'].append({'name': clip['name'], 'samplers': samplers, 'channels': [{'sampler': i, 'target': t} for i, t in enumerate(targets)]})
    added.append((clip['name'], round(float(length), 2)))

character['buffers'][0]['byteLength'] = len(character_blob)
text = json.dumps(character, separators=(',', ':')).encode(); text += b' ' * ((4 - len(text) % 4) % 4)
with open(out, 'wb') as f:
    f.write(struct.pack('<4sII', b'glTF', 2, 12 + 8 + len(text) + 8 + len(character_blob)))
    f.write(struct.pack('<I4s', len(text), b'JSON') + text + struct.pack('<I4s', len(character_blob), b'BIN\x00') + bytes(character_blob))
print(json.dumps({'out': out, 'bones': len(bones), 'hipScale': round(float(hip_scale), 3), 'animations': added, 'bytes': os.path.getsize(out)}))
