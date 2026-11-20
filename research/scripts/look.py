"""Draw a textured mesh large, unlit, from a few angles, to judge its texture by eye.

  look.py <out.png> <textured.glb> [more.glb ...]

One row per mesh. Each mesh is y-up with its front towards +z.

Environment:
  ANGLES  degrees to turn the mesh for each picture (default "0,22.5,45,90,157.5,180")
  CELL    size of each picture (default 320)
  TILT    how far above level the camera is, degrees (default 10)

Needs numpy, pillow, trimesh.
"""
import math, os, sys
import numpy as np
import trimesh
from PIL import Image

out, files = sys.argv[1], sys.argv[2:]
angles = [float(a) for a in os.environ.get('ANGLES', '0,22.5,45,90,157.5,180').split(',')]
cell = int(os.environ.get('CELL', '320')); tilt = math.radians(float(os.environ.get('TILT', '10')))
sheet = np.full((cell * len(files), cell * len(angles), 3), 204, np.uint8)
for row, file in enumerate(files):
    mesh = trimesh.load(file, force='mesh', process=False)
    points, faces = trimesh.sample.sample_surface(mesh, 2500000, seed=2)
    bary = trimesh.triangles.points_to_barycentric(mesh.triangles[faces], points)
    uv = (np.asarray(mesh.visual.uv)[mesh.faces[faces]] * bary[:, :, None]).sum(1)
    texture = np.array(mesh.visual.material.baseColorTexture.convert('RGB'))
    th, tw = texture.shape[:2]
    colour = texture[np.clip(((1 - uv[:, 1]) * th).astype(int), 0, th - 1), np.clip((uv[:, 0] * tw).astype(int), 0, tw - 1)]
    centre = (mesh.bounds[0] + mesh.bounds[1]) / 2; scale = cell * 0.92 / (mesh.bounds[1] - mesh.bounds[0]).max()
    p = (points - centre) * scale
    for column, angle in enumerate(angles):
        t = math.radians(angle)
        x = p[:, 0] * math.cos(t) + p[:, 2] * math.sin(t); z = -p[:, 0] * math.sin(t) + p[:, 2] * math.cos(t)
        y = p[:, 1] * math.cos(tilt) - z * math.sin(tilt); depth = z * math.cos(tilt) + p[:, 1] * math.sin(tilt)
        px = np.clip((x + cell / 2).astype(int), 0, cell - 1); py = np.clip((cell / 2 - y).astype(int), 0, cell - 1)
        order = np.argsort(depth)
        sheet[row * cell:(row + 1) * cell, column * cell:(column + 1) * cell][py[order], px[order]] = colour[order]
Image.fromarray(sheet).save(out)
