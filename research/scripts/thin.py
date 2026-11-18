"""Make a light copy of a painted mesh: fewer triangles, a new unwrap, and the paint and relief baked onto it.

  thin.py <painted.glb> <out.glb> [triangles=6000]

The generated meshes carry about 30,000 triangles a part, spread evenly, in an unwrap of hundreds of
pieces. A game wants a fraction of that. This thins the mesh to the count given, unwraps it again
with fewer and larger pieces, and bakes two pictures from the dense mesh onto it: its colours, and
a normal map holding the relief the thinning removed, so light still falls as on the dense one.

Each texel of the light mesh takes the nearest point of the dense mesh that faces the same way,
which keeps the two sides of a thin sheet such as a cape from swapping.

The output has smooth normals, the colour texture, a normal map (OpenGL convention, as glTF wants)
and one material. rig.py writes the matching tangents.

Environment:
  TEX      size of the colour texture (default 1024)
  NORMAL   size of the normal map (default: the same as TEX; 0 leaves it out)
  CHARTS   how readily the unwrap grows a piece, xatlas's max_cost; larger gives fewer, larger pieces
           with more stretch (default 8, xatlas's own default is 2)
  PAD      pixels each piece is spread past its edge, so neighbours do not bleed when the texture is drawn small (default 6)
  SMOOTH   rounds of smoothing on the dense mesh before thinning, to keep generator noise out of the shape (default 0)

Needs numpy, scipy, pillow, trimesh, xatlas, fast-simplification.
"""
import math, os, sys
import numpy as np
import trimesh, xatlas, fast_simplification
from PIL import Image
from scipy.ndimage import distance_transform_edt
from scipy.spatial import cKDTree

source, out = sys.argv[1:3]
target = int(sys.argv[3]) if len(sys.argv) > 3 else 6000
env = os.environ.get
TEX = int(env('TEX', '1024')); NORMAL = int(env('NORMAL', str(TEX))); PAD = int(env('PAD', '6'))


def welded(vertices, faces):
    """The same triangles with vertices in the same place joined, and smooth normals for the joined mesh."""
    unique, index = np.unique(np.round(vertices, 5), axis=0, return_inverse=True)
    joined = index.reshape(-1)[faces]
    joined = joined[(joined[:, 0] != joined[:, 1]) & (joined[:, 1] != joined[:, 2]) & (joined[:, 0] != joined[:, 2])]
    return unique, joined, np.asarray(trimesh.Trimesh(unique, joined, process=False).vertex_normals)


def tangents(position, normal, uv, faces):
    """A tangent for each vertex, along increasing u, with the sign glTF stores in w. rig.py has the same function."""
    p, t = position[faces], uv[faces]
    e1, e2 = p[:, 1] - p[:, 0], p[:, 2] - p[:, 0]; d1, d2 = t[:, 1] - t[:, 0], t[:, 2] - t[:, 0]
    det = d1[:, 0] * d2[:, 1] - d2[:, 0] * d1[:, 1]; det = np.where(np.abs(det) < 1e-12, 1e-12, det)
    along_u = (e1 * d2[:, 1:2] - e2 * d1[:, 1:2]) / det[:, None]; along_v = (e2 * d1[:, 0:1] - e1 * d2[:, 0:1]) / det[:, None]
    tan = np.zeros_like(position); bit = np.zeros_like(position)
    for corner in range(3): np.add.at(tan, faces[:, corner], along_u); np.add.at(bit, faces[:, corner], along_v)
    tan -= normal * np.einsum('ij,ij->i', normal, tan)[:, None]
    tan /= np.linalg.norm(tan, axis=1, keepdims=True) + 1e-12
    sign = np.where(np.einsum('ij,ij->i', np.cross(normal, tan), bit) < 0, -1.0, 1.0)
    return tan, sign


# ---- the dense mesh, sampled: where its surface is, which way it faces, and its colour there
dense = trimesh.load(source, force='mesh', process=False)
dv, df = np.asarray(dense.vertices, np.float64), np.asarray(dense.faces)
duv = np.asarray(dense.visual.uv, np.float64)
paint = np.array(dense.visual.material.baseColorTexture.convert('RGB')); ph, pw = paint.shape[:2]
wv, wf, wn = welded(dv, df)
smooth = trimesh.Trimesh(wv, wf, process=False)
if int(env('SMOOTH', '0')) > 0: trimesh.smoothing.filter_taubin(smooth, iterations=int(env('SMOOTH')))
join = cKDTree(wv).query(dv)[1]  # each painted vertex's joined vertex, for smooth normals
rng = np.random.default_rng(9)
area = dense.area_faces; pick = rng.choice(len(df), 3000000, p=area / area.sum()); bary = rng.dirichlet((1, 1, 1), len(pick))
point = np.einsum('ij,ijk->ik', bary, dv[df[pick]])
facing = np.einsum('ij,ijk->ik', bary, wn[join[df[pick]]]); facing /= np.linalg.norm(facing, axis=1, keepdims=True) + 1e-12
at = np.einsum('ij,ijk->ik', bary, duv[df[pick]])
colour = paint[np.clip(((1 - at[:, 1]) * ph).astype(int), 0, ph - 1), np.clip((at[:, 0] * pw).astype(int), 0, pw - 1)]
tree = cKDTree(point)

# ---- thin it, and unwrap the light mesh afresh
lv, lf = fast_simplification.simplify(np.asarray(smooth.vertices, np.float32), wf, target_count=target)
light = trimesh.Trimesh(lv.astype(np.float64), lf, process=True)
atlas = xatlas.Atlas(); atlas.add_mesh(np.asarray(light.vertices, np.float32), np.asarray(light.faces, np.uint32))
charts = xatlas.ChartOptions(); charts.max_cost = float(env('CHARTS', '8'))
pack = xatlas.PackOptions(); pack.padding = PAD; pack.resolution = TEX; pack.bilinear = True
atlas.generate(chart_options=charts, pack_options=pack)
vmap, faces, uv = atlas[0]
position = np.asarray(light.vertices)[vmap]; normal = np.asarray(light.vertex_normals)[vmap]; faces = faces.astype(np.int64)
uv = uv.astype(np.float64)
# With v running up the picture, the bitangent points up the picture too, which is the OpenGL convention glTF asks for.
tangent, sign = tangents(position, normal, uv, faces)


def bake(size):
    """For every texel of the light mesh: where it is on the surface, and the smooth normal and tangent there."""
    where = np.zeros((size, size, 3)); n = np.zeros((size, size, 3)); t = np.zeros((size, size, 3)); s = np.ones((size, size)); used = np.zeros((size, size), bool)
    tri = uv[faces] * size
    for f in range(len(faces)):
        a, b, c = tri[f]
        x0, x1 = max(0, int(math.floor(min(a[0], b[0], c[0])))), min(size - 1, int(math.ceil(max(a[0], b[0], c[0]))))
        y0, y1 = max(0, int(math.floor(min(a[1], b[1], c[1])))), min(size - 1, int(math.ceil(max(a[1], b[1], c[1]))))
        den = (b[1] - c[1]) * (a[0] - c[0]) + (c[0] - b[0]) * (a[1] - c[1])
        if abs(den) < 1e-12 or x1 < x0 or y1 < y0: continue
        xs, ys = np.meshgrid(np.arange(x0, x1 + 1) + 0.5, np.arange(y0, y1 + 1) + 0.5)
        l1 = ((b[1] - c[1]) * (xs - c[0]) + (c[0] - b[0]) * (ys - c[1])) / den
        l2 = ((c[1] - a[1]) * (xs - c[0]) + (a[0] - c[0]) * (ys - c[1])) / den
        l3 = 1 - l1 - l2
        inside = (l1 >= -0.01) & (l2 >= -0.01) & (l3 >= -0.01)
        if not inside.any(): continue
        yy, xx = np.nonzero(inside); w = np.stack([l1[yy, xx], l2[yy, xx], l3[yy, xx]], 1); corner = faces[f]
        where[y0 + yy, x0 + xx] = w @ position[corner]; n[y0 + yy, x0 + xx] = w @ normal[corner]; t[y0 + yy, x0 + xx] = w @ tangent[corner]
        s[y0 + yy, x0 + xx] = sign[corner[0]]; used[y0 + yy, x0 + xx] = True
    return where, n, t, s, used


def nearest(where, n):
    """The dense sample nearest each point that faces the same way."""
    _, found = tree.query(where, k=6)
    agree = np.einsum('ikj,ij->ik', facing[found], n) > 0.2
    first = np.where(agree.any(1), agree.argmax(1), 0)
    return found[np.arange(len(where)), first]


def spread(image, used):
    """Carry each piece's edge colours outwards, so nothing bleeds in from the empty parts of the texture."""
    index = distance_transform_edt(~used, return_indices=True)[1]
    return image[index[0], index[1]]


where, n, t, s, used = bake(TEX)
flat = np.zeros((TEX, TEX, 3), np.uint8)
flat[used] = colour[nearest(where[used], n[used] / (np.linalg.norm(n[used], axis=1, keepdims=True) + 1e-12))]
texture = Image.fromarray(spread(flat, used)[::-1])  # rows were filled with v up; pictures run top down
relief = None
if NORMAL > 0:
    if NORMAL != TEX: where, n, t, s, used = bake(NORMAL)
    nn = n[used] / (np.linalg.norm(n[used], axis=1, keepdims=True) + 1e-12)
    tt = t[used] - nn * np.einsum('ij,ij->i', nn, t[used])[:, None]; tt /= np.linalg.norm(tt, axis=1, keepdims=True) + 1e-12
    bb = np.cross(nn, tt) * s[used][:, None]
    high = facing[nearest(where[used], nn)]
    local = np.stack([np.einsum('ij,ij->i', high, tt), np.einsum('ij,ij->i', high, bb), np.einsum('ij,ij->i', high, nn)], 1)
    local[:, 2] = np.maximum(local[:, 2], 0.05); local /= np.linalg.norm(local, axis=1, keepdims=True)
    picture = np.zeros((NORMAL, NORMAL, 3), np.uint8); picture[...] = (128, 128, 255)
    picture[used] = np.clip(local * 127.5 + 127.5, 0, 255).astype(np.uint8)
    relief = Image.fromarray(spread(picture, used)[::-1])

material = trimesh.visual.material.PBRMaterial(baseColorTexture=texture, normalTexture=relief, metallicFactor=0.0, roughnessFactor=1.0)
result = trimesh.Trimesh(position, faces, vertex_normals=normal, visual=trimesh.visual.TextureVisuals(uv=uv, material=material), process=False)
result.export(out)
print(f'{out}: {len(df)} to {len(faces)} triangles, {len(position)} vertices, {atlas.chart_count} unwrap pieces, colour {TEX}, normal map {NORMAL or "none"}')
