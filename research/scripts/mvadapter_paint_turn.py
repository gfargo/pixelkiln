"""Paint a mesh with MV-Adapter, one sprite direction at a time, for bake.py to bake.

  mvadapter_paint_turn.py <mesh.glb> <picture-dir> <name> <out-dir>

The same idea as hunyuan3d_paint_turn.py with a different painter. MV-Adapter paints six views of
a mesh from one reference picture, and invents the sides the reference does not show. Here the
mesh is turned to face the front camera once for each direction, that direction's picture
(<picture-dir>/<name>-<direction>.png, a sprite or a redraw from redraw.py) is the reference, and
only the view the reference shows is kept.

MV-Adapter is guided by pictures of where the surface is and which way it faces. Its own code draws
them with nvdiffrast and bakes with CV-CUDA, neither of which is on the Windows machine used here,
so this script draws them itself and leaves the bake to bake.py. The model runs through
mvadapter_remote.py on the machine named by HOST.

The mesh is y-up with its front towards +z, as texture.py writes it. Needs numpy, pillow, trimesh,
and ssh and scp to HOST.

Environment:
  HOST     ssh name of the GPU machine (default forge)
  REMOTE   folder there holding mvadapter_remote.py, MV-Adapter and a venv (default F:/MVAdapter)
  SIZE     size of each view (default 768)
  DIRS     which directions to paint (default all eight)
  SIGN     which way the mesh turns for the next direction, 1 or -1 (default -1)
  KEEP     which of the six views to keep from each pass: 0 is the front, 1 to 3 go round in quarter
           turns, 4 and 5 are top and bottom (default 0)
  TEXT     words for the model (default "high quality")
  STEPS, SCALE, SEED, OFFLOAD   passed on to mvadapter_remote.py
"""
import json, math, os, subprocess, sys
import numpy as np
import trimesh
from PIL import Image

mesh_file, picture_dir, name, out = sys.argv[1:5]
env = os.environ.get
HOST, REMOTE, SIZE, SIGN = env('HOST', 'forge'), env('REMOTE', 'F:/MVAdapter'), int(env('SIZE', '768')), int(env('SIGN', '-1'))
D = ['south', 'south-east', 'east', 'north-east', 'north', 'north-west', 'west', 'south-west']
dirs = [D.index(d) for d in env('DIRS', ','.join(D)).split(',') if d]
KEEP = [int(k) for k in env('KEEP', '0').split(',')]
# The six cameras MV-Adapter was trained with: four round the middle, then top and bottom.
AZIMUTH = [0, 90, 180, 270, 180, 180]; ELEVATION = [0, 0, 0, 0, 89.99, -89.99]; HALF = 0.55
os.makedirs(out, exist_ok=True)
base = trimesh.load(mesh_file, force='mesh', process=False)


def control(mesh):
    """Six pictures of the mesh as MV-Adapter expects them: position and facing of the surface at each pixel."""
    v = np.asarray(mesh.vertices); n = np.asarray(mesh.vertex_normals)
    std = lambda a: np.stack([a[:, 0], -a[:, 2], a[:, 1]], 1)  # y-up with the front at +z, to z-up with the front at -y
    v, n = std(v), std(n); v = v / np.abs(v).max() * 0.5
    faces = np.asarray(mesh.faces)
    area = np.linalg.norm(np.cross(v[faces[:, 1]] - v[faces[:, 0]], v[faces[:, 2]] - v[faces[:, 0]]), axis=1)
    rng = np.random.default_rng(3); pick = rng.choice(len(faces), 4000000, p=area / area.sum()); bary = rng.dirichlet((1, 1, 1), len(pick))
    point = np.einsum('ij,ijk->ik', bary, v[faces[pick]]); facing = np.einsum('ij,ijk->ik', bary, n[faces[pick]])
    facing /= np.linalg.norm(facing, axis=1, keepdims=True) + 1e-9
    maps = np.full((6, SIZE, SIZE, 6), 0.5, np.float32)
    for k in range(6):
        a, e = math.radians(AZIMUTH[k] - 90), math.radians(ELEVATION[k])
        eye = np.array([math.cos(e) * math.cos(a), math.cos(e) * math.sin(a), math.sin(e)])
        right = np.cross(-eye, [0, 0, 1.0]); right /= np.linalg.norm(right); up = np.cross(right, -eye)
        px = np.floor((point @ right / HALF * 0.5 + 0.5) * SIZE).astype(int); py = np.floor((0.5 - point @ up / HALF * 0.5) * SIZE).astype(int)
        ok = (px >= 0) & (py >= 0) & (px < SIZE) & (py < SIZE); order = np.argsort((point @ eye)[ok])  # nearest last
        maps[k][py[ok][order], px[ok][order]] = np.concatenate([point + 0.5, facing / 2 + 0.5], 1)[ok][order].clip(0, 1)
    return maps


def reference(v):
    """The picture for this direction on mid grey, filling nine tenths of the frame, as MV-Adapter's own script prepares it."""
    picture = Image.open(f'{picture_dir}/{name}-{D[v]}.png').convert('RGBA')
    picture = picture.crop(picture.getbbox()); k = SIZE * 0.9 / max(picture.size)
    picture = picture.resize((max(1, round(picture.width * k)), max(1, round(picture.height * k))), Image.LANCZOS if k < 1 else Image.NEAREST)
    ground = Image.new('RGBA', (SIZE, SIZE), (128, 128, 128, 255))
    ground.alpha_composite(picture, ((SIZE - picture.width) // 2, (SIZE - picture.height) // 2))
    return ground.convert('RGB')


jobs, listing = [], []
for v in dirs:
    turned = base.copy()
    turned.apply_transform(trimesh.transformations.rotation_matrix(SIGN * v * math.pi / 4, [0, 1, 0]))
    maps = control(turned)
    np.save(f'{out}/{name}-control-{v}.npy', maps.astype(np.float16))
    reference(v).save(f'{out}/{name}-ref-{v}.png')
    for k in KEEP:
        Image.fromarray((maps[k][..., 3:] * 255).astype(np.uint8)).save(f'{out}/{name}-normal-{v}-{k}.png')
        # A camera a quarter turn round sees what the front camera sees of a mesh turned a quarter turn back.
        listing.append({'view': f'{name}-view-{v}-{k}.png', 'normal': f'{name}-normal-{v}-{k}.png', 'ref': f'{name}-ref-{v}.png', 'turn': SIGN * v * 45 - AZIMUTH[k]})
    jobs.append({'control': f'{REMOTE}/jobs/{name}-control-{v}.npy', 'reference': f'{REMOTE}/jobs/{name}-ref-{v}.png', 'out': f'{REMOTE}/jobs/{name}-out-{v}', 'text': env('TEXT', 'high quality')})
json.dump(jobs, open(f'{out}/{name}.jobs.json', 'w'))
quiet = dict(check=True, stderr=subprocess.DEVNULL)
subprocess.run(['ssh', HOST, 'mkdir ' + REMOTE.replace('/', '\\') + '\\jobs'], stderr=subprocess.DEVNULL, stdout=subprocess.DEVNULL)
subprocess.run(['scp', '-q', os.path.join(os.path.dirname(os.path.abspath(__file__)), 'mvadapter_remote.py'), f'{HOST}:{REMOTE}/'], **quiet)
subprocess.run(['scp', '-q', f'{out}/{name}.jobs.json'] + [f'{out}/{name}-control-{v}.npy' for v in dirs] + [f'{out}/{name}-ref-{v}.png' for v in dirs] + [f'{HOST}:{REMOTE}/jobs/'], **quiet)
win = REMOTE.replace('/', '\\')
passed = ''.join(f'set "{key}={env(key)}"&& ' for key in ('STEPS', 'SCALE', 'SEED', 'OFFLOAD') if env(key))  # quoted, or cmd keeps the space before &&
command = passed + f'set "HF_HOME={win}\\hf"&& {win}\\venv\\Scripts\\python.exe {win}\\mvadapter_remote.py {win}\\jobs\\{name}.jobs.json'
run = subprocess.run(['ssh', HOST, command], capture_output=True, text=True)
print(''.join(line + '\n' for line in run.stdout.splitlines() if ' s peak ' in line), end='')
if run.returncode != 0: sys.exit('the model failed on ' + HOST + ':\n' + (run.stdout + run.stderr)[-3000:])
for v in dirs:
    for k in KEEP:
        subprocess.run(['scp', '-q', f'{HOST}:{REMOTE}/jobs/{name}-out-{v}-{k}.png', f'{out}/{name}-view-{v}-{k}.png'], **quiet)
json.dump(listing, open(f'{out}/{name}.views.json', 'w'), indent=1)
print(f'{out}/{name}.views.json: {len(listing)} views')
