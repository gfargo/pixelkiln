"""Cut one worn item out of a mesh of the character wearing it.

  cut_item.py <worn.textured.glb> <mask.textured.glb> <out.glb>

Both inputs are texture.py's output for the same mesh. The first was textured from the sprites of
the character wearing the item. The second was textured from mask sprites with the same outline,
green (0, 255, 0) where the item's layer has a pixel and magenta (255, 0, 255) elsewhere, so its
texture says which part of the surface is the item. The outline is the same, so the fit, the
triangles and the unwrap are the same in both files.

Keeps the triangles that are mostly green, drops loose crumbs, and writes them with the first
file's texture. The result is an open shell with no inside, sitting where the item sat.

Environment:
  SHARE   how much of a triangle must be item to keep it (default 0.5)
  CRUMB   drop pieces with fewer triangles than this (default 40)

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

faces = np.asarray(worn.faces)[is_item]
# The unwrap splits vertices along its seams, so join the ones in the same place before asking what is connected.
_, joined = np.unique(np.round(np.asarray(worn.vertices), 4), axis=0, return_inverse=True)
kept = trimesh.Trimesh(worn.vertices, joined.reshape(-1)[faces], process=False)
labels = trimesh.graph.connected_component_labels(kept.face_adjacency, node_count=len(faces))
sizes = np.bincount(labels)
faces = faces[sizes[labels] >= crumb]
used, index = np.unique(faces, return_inverse=True)
visual = trimesh.visual.TextureVisuals(uv=np.asarray(worn.visual.uv)[used], material=worn.visual.material)
trimesh.Trimesh(np.asarray(worn.vertices)[used], index.reshape(-1, 3), visual=visual, process=False).export(out)
print(f'{out}: kept {len(faces)} of {len(worn.faces)} triangles in {int((sizes >= crumb).sum())} piece(s)')
