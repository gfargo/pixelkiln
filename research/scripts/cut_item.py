"""Cut one worn item out of a mesh of the character wearing it.

  cut_item.py <worn.textured.glb> <mask.textured.glb> <out.glb>

Both inputs are texture.py's output for the same mesh. The first was textured from the sprites of
the character wearing the item. The second was textured from mask sprites with the same outline,
green (0, 255, 0) where the item's layer has a pixel and magenta (255, 0, 255) elsewhere, so its
texture says which part of the surface is the item. The outline is the same, so the fit, the
triangles and the unwrap are the same in both files.

Keeps the triangles that are mostly green, drops loose crumbs, and writes them with the first
file's texture. The result is an open shell with no inside, sitting where the item sat.

The mask comes from the sprites and the mesh may not be exactly where the sprites were, so the edge
of the item can land a pixel or two off: a sleeve stops short, or a strip of hand comes along. Given
the bare body's painted mesh as BODY, the edge is moved to where the paint says it is. Skin is
learned from the body's texture. Within REACH of the mask's edge, a triangle painted as skin is
left out, and a triangle is taken in when it is not skin and is painted unlike the bare body at
the same place, so a sleeve grows down a forearm but not over the underwear both meshes share.

Environment:
  SHARE   how much of a triangle must be item to keep it (default 0.5)
  CRUMB   drop pieces with fewer triangles than this (default 40)
  BODY    the bare body's painted .glb, to learn skin from; without it the mask is used as it is
  REACH   how far the edge may move, in mesh units, which are sprite pixels (default 3)
  SKIN    how close to the body's skin colours counts as skin; larger takes more (default 3)
  UNLIKE  how different from the body's paint at the same place a triangle must be to be taken in,
          as a sum over red, green and blue (default 90)

Needs numpy, pillow, trimesh.
"""
import os, sys
import numpy as np
import trimesh

worn_file, mask_file, out = sys.argv[1:4]
share = float(os.environ.get('SHARE', '0.5')); crumb = int(os.environ.get('CRUMB', '40'))
worn = trimesh.load(worn_file, force='mesh', process=False)
mask = trimesh.load(mask_file, force='mesh', process=False)
if worn.vertices.shape != mask.vertices.shape or not np.allclose(worn.vertices, mask.vertices, atol=1e-4):
    sys.exit('the two files are not the same mesh: texture them from sprites with the same outline')

texture = np.array(mask.visual.material.baseColorTexture.convert('RGB')).astype(int)
height, width = texture.shape[:2]
uv = np.asarray(mask.visual.uv)[mask.faces]  # [face, corner, 2]
# Seven points in each triangle: the middle, and one towards each corner and each edge.
weights = np.array([[1, 1, 1], [4, 1, 1], [1, 4, 1], [1, 1, 4], [2, 2, 1], [2, 1, 2], [1, 2, 2]], float)
weights /= weights.sum(1, keepdims=True)
points = np.einsum('sc,fcu->fsu', weights, uv)
colour = texture[np.clip(((1 - points[..., 1]) * height).astype(int), 0, height - 1), np.clip((points[..., 0] * width).astype(int), 0, width - 1)]
is_item = (colour[..., 1] > colour[..., 0]).mean(1) >= share

def pieces_of(chosen):
    """Which connected piece each chosen triangle is in, and the size of each piece. The unwrap splits
    vertices along its seams, so vertices in the same place are joined first."""
    picked = np.asarray(worn.faces)[chosen]
    _, joined = np.unique(np.round(np.asarray(worn.vertices), 4), axis=0, return_inverse=True)
    shape = trimesh.Trimesh(worn.vertices, joined.reshape(-1)[picked], process=False)
    labels = trimesh.graph.connected_component_labels(shape.face_adjacency, node_count=len(picked))
    return labels, np.bincount(labels)

if os.environ.get('BODY'):
    labels, sizes = pieces_of(is_item)  # crumbs of mask must not grow
    is_item[np.nonzero(is_item)[0][sizes[labels] < crumb]] = False
    from scipy.spatial import cKDTree
    reach = float(os.environ.get('REACH', '3')); tolerance = float(os.environ.get('SKIN', '3'))
    def chroma(rgb):  # colour without brightness
        rgb = rgb.astype(float); return rgb[..., :2] / (rgb.sum(-1, keepdims=True) + 1e-6)
    body = trimesh.load(os.environ['BODY'], force='mesh', process=False)
    skin = np.array(body.visual.material.baseColorTexture.convert('RGB')).reshape(-1, 3).astype(int)
    skin = skin[(skin.sum(1) > 180) & (skin[:, 0] > skin[:, 2] + 25) & (skin[:, 0] > skin[:, 1])]  # the warm, lit part of the body
    centre = chroma(skin).mean(0); spread = np.linalg.inv(np.cov(chroma(skin).T) + 1e-8 * np.eye(2))
    paint = np.array(worn.visual.material.baseColorTexture.convert('RGB')).astype(int)
    ph, pw = paint.shape[:2]; wuv = np.einsum('sc,fcu->fsu', weights, np.asarray(worn.visual.uv)[worn.faces])
    seen = paint[np.clip(((1 - wuv[..., 1]) * ph).astype(int), 0, ph - 1), np.clip((wuv[..., 0] * pw).astype(int), 0, pw - 1)].mean(1)
    off = chroma(seen) - centre
    is_skin = (np.einsum('fi,ij,fj->f', off, spread, off) < tolerance ** 2) & (seen.sum(1) > 150) & (seen[:, 0] > seen[:, 2] + 15)
    middle = worn.triangles_center
    to_item = cKDTree(middle[is_item]).query(middle)[0]; to_rest = cKDTree(middle[~is_item]).query(middle)[0]
    before = is_item.copy()
    buv = np.einsum('sc,fcu->fsu', weights, np.asarray(body.visual.uv)[body.faces])
    body_paint = np.array(body.visual.material.baseColorTexture.convert('RGB')).astype(int); bh, bw = body_paint.shape[:2]
    body_seen = body_paint[np.clip(((1 - buv[..., 1]) * bh).astype(int), 0, bh - 1), np.clip((buv[..., 0] * bw).astype(int), 0, bw - 1)].mean(1)
    there = body_seen[cKDTree(body.triangles_center).query(middle)[1]]
    unlike = np.abs(seen - there).sum(1) > float(os.environ.get('UNLIKE', '90'))
    is_item = (before & ~(is_skin & (to_rest < reach))) | (~before & ~is_skin & unlike & (to_item < reach))
    print(f'edge moved: {int((before & ~is_item).sum())} skin triangles left out, {int((~before & is_item).sum())} taken in')

faces = np.asarray(worn.faces)[is_item]
labels, sizes = pieces_of(is_item)
faces = faces[sizes[labels] >= crumb]
used, index = np.unique(faces, return_inverse=True)
visual = trimesh.visual.TextureVisuals(uv=np.asarray(worn.visual.uv)[used], material=worn.visual.material)
trimesh.Trimesh(np.asarray(worn.vertices)[used], index.reshape(-1, 3), visual=visual, process=False).export(out)
print(f'{out}: kept {len(faces)} of {len(worn.faces)} triangles in {int((sizes >= crumb).sum())} piece(s)')
