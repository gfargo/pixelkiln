"""Reshape an item made on one body so that it can be worn by another.

  refit.py <item.glb> <from-skin.npz> <to-skin.npz> <out.glb>

An item is cut from the mesh of the body that wore it (cut_item.py) and sits in that body's
frame. A second body has other proportions: longer legs, a thicker chest, a higher shoulder.
The two skin files are what rig.py writes with SKIN=<file> for each body: where its bones are,
and its own mesh with the bone that owns each vertex.

Each point of the item is described against the first body's bones: how far along a bone it is,
and how far out from it. It is then put the same share of the way along the second body's bone,
and moved out or in by the difference in how thick the two bodies are there. Adding the
difference keeps an item's clearance from the skin: a fur collar that stood well off a slim
shoulder stands as far off a broad one. (Scaling by the ratio was tried first and blew the collar
up to twice its size.) A point near several bones takes a blend of what each says. The item keeps
its triangles, unwrap and textures.

The result is close, not fitted. rig.py's own ITEMS step then moves it to just above the second
body's skin and gives it that body's weights.

Environment:
  REACH   how sharply a point favours its nearest bones, as a power of distance (default 4)
  ONLY    the bones the item may be described against, comma separated. A helm given ONLY=Head keeps its
          shape, where the neck and shoulders would otherwise pull at its horns. Default: all of them.

Needs numpy, trimesh.
"""
import os, sys
import numpy as np
import trimesh

item_file, from_file, to_file, out = sys.argv[1:5]
power = float(os.environ.get('REACH', '4')); only = [n for n in os.environ.get('ONLY', '').split(',') if n]
first, second = np.load(from_file), np.load(to_file)
names = [str(n) for n in first['names']]
if names != [str(n) for n in second['names']]: sys.exit('the two bodies have different bones')


def girth(skin):
    """How thick the body is round each bone: the typical distance of that bone's own vertices from its line."""
    head, tail = skin['head'], skin['tail']; out = np.zeros(len(head))
    for b in range(len(head)):
        mine = skin['world'][skin['owner'] == b]
        if len(mine) < 12: continue
        axis = tail[b] - head[b]; axis /= np.linalg.norm(axis) + 1e-9
        rel = mine - head[b]; out[b] = np.median(np.linalg.norm(rel - np.outer(rel @ axis, axis), axis=1))
    return out


def between(a, b):
    """The smallest rotation that turns direction a to direction b."""
    axis = np.cross(a, b); s = np.linalg.norm(axis); c = float(a @ b)
    if s < 1e-8: return np.eye(3)
    k = axis / s; K = np.array([[0, -k[2], k[1]], [k[2], 0, -k[0]], [-k[1], k[0], 0]])
    return np.eye(3) + s * K + (1 - c) * K @ K


g1, g2 = girth(first), girth(second)
whole = np.median((g2 - g1)[(g1 > 0) & (g2 > 0)])  # for bones too small to measure
part = trimesh.load(item_file, force='mesh', process=False)
g = np.asarray(part.vertices, np.float64)
p = np.stack([g[:, 0], -g[:, 2], g[:, 1]], 1)  # the file's (x, up, -y) to the sprites' frame (x, y, up)
moved = np.zeros((len(p), len(names), 3)); near = np.zeros((len(p), len(names)))
for b in range(len(names)):
    h1, t1, h2, t2 = first['head'][b], first['tail'][b], second['head'][b], second['tail'][b]
    l1, l2 = np.linalg.norm(t1 - h1), np.linalg.norm(t2 - h2); a1, a2 = (t1 - h1) / (l1 + 1e-9), (t2 - h2) / (l2 + 1e-9)
    rel = p - h1; along = rel @ a1; out_from = rel - np.outer(along, a1)
    thicker = g2[b] - g1[b] if g1[b] > 0 and g2[b] > 0 else whole
    far = np.linalg.norm(out_from, axis=1, keepdims=True)
    wide = np.maximum(far + thicker, 0.3 * far) / (far + 1e-9)  # out by the difference in thickness, never through the bone
    moved[:, b] = h2 + np.outer(along * l2 / (l1 + 1e-9), a2) + (out_from @ between(a1, a2).T) * wide
    near[:, b] = np.linalg.norm(rel - np.outer(np.clip(along, 0, l1), a1), axis=1) if not only or names[b] in only else 1e9
weight = 1.0 / (near ** power + 1e-6)
keep = np.argsort(-weight, 1)[:, :4]; chosen = np.zeros_like(weight); np.put_along_axis(chosen, keep, np.take_along_axis(weight, keep, 1), 1)
chosen /= chosen.sum(1, keepdims=True)
q = np.einsum('vb,vbk->vk', chosen, moved)
result = part.copy(); result.vertices = np.stack([q[:, 0], q[:, 2], -q[:, 1]], 1)
result.export(out)
shift = np.linalg.norm(q - p, axis=1)
print(f'{out}: {len(p)} vertices moved {np.median(shift):.1f} sprite pixels typically, {shift.max():.1f} at most; the second body is {np.median((g2 - g1)[g1 > 0]):.1f} thicker at a typical bone')
