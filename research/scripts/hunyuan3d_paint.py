"""Texture a mesh with Hunyuan3D-2's paint stage through a ComfyUI that has
kijai's ComfyUI-Hunyuan3DWrapper installed.

  hunyuan3d_paint.py <mesh.glb> <reference.png> <out-dir> [name]

The mesh and the reference image must already be in that ComfyUI's input
folder under the same file names. The reference is one front view on a light
grey ground. Writes <name>.painted.glb, <name>.views.png (the views the model
painted), <name>.normals.png and <name>.texture.png.

Environment:
  API      ComfyUI address (default http://127.0.0.1:18189)
  MODEL    hunyuan3d-paint-v2-0 (default) or hunyuan3d-paint-v2-0-turbo
  AZIMS    camera azimuths, degrees (default "0, 90, 180, 270, 0, 180")
  ELEVS    camera elevations (default "0, 0, 0, 0, 90, -90")
  WEIGHTS  how much each view counts in the bake (default "1, 0.1, 0.5, 0.1, 0.05, 0.05")
  VIEW     size of each painted view (default 512)
  STEPS    sampling steps (default 25)
  SEED     (default 1024)
  PROMPT   the id of a run already queued, to wait for and fetch
  TEXTURE  texture size (default 1024)
"""
import json, os, sys, time, urllib.parse, urllib.request, uuid

API = os.environ.get('API', 'http://127.0.0.1:18189')
mesh, ref, out = sys.argv[1:4]
name = sys.argv[4] if len(sys.argv) > 4 else os.path.basename(mesh).split('.')[0]
env = os.environ.get
view = int(env('VIEW', '512'))

graph = {
    'mesh': {'class_type': 'Hy3DLoadMesh', 'inputs': {'glb_path': os.path.basename(mesh)}},
    'uv': {'class_type': 'Hy3DMeshUVWrap', 'inputs': {'trimesh': ['mesh', 0]}},
    'cam': {'class_type': 'Hy3DCameraConfig', 'inputs': {
        'camera_azimuths': env('AZIMS', '0, 90, 180, 270, 0, 180'),
        'camera_elevations': env('ELEVS', '0, 0, 0, 0, 90, -90'),
        'view_weights': env('WEIGHTS', '1, 0.1, 0.5, 0.1, 0.05, 0.05'),
        'camera_distance': 1.45, 'ortho_scale': 1.2}},
    'render': {'class_type': 'Hy3DRenderMultiView', 'inputs': {
        'trimesh': ['uv', 0], 'render_size': 1024, 'texture_size': int(env('TEXTURE', '1024')),
        'camera_config': ['cam', 0], 'normal_space': 'world'}},
    'ref': {'class_type': 'LoadImage', 'inputs': {'image': os.path.basename(ref)}},
    'model': {'class_type': 'DownloadAndLoadHy3DPaintModel', 'inputs': {'model': env('MODEL', 'hunyuan3d-paint-v2-0')}},
    'paint': {'class_type': 'Hy3DSampleMultiView', 'inputs': {
        'pipeline': ['model', 0], 'ref_image': ['ref', 0], 'normal_maps': ['render', 0], 'position_maps': ['render', 1],
        'view_size': view, 'steps': int(env('STEPS', '25')), 'seed': int(env('SEED', '1024')),
        'camera_config': ['cam', 0], 'denoise_strength': 1.0}},
    'bake': {'class_type': 'Hy3DBakeFromMultiview', 'inputs': {
        'images': ['paint', 0], 'renderer': ['render', 2], 'camera_config': ['cam', 0]}},
    'fill': {'class_type': 'Hy3DMeshVerticeInpaintTexture', 'inputs': {
        'texture': ['bake', 0], 'mask': ['bake', 1], 'renderer': ['bake', 2]}},
    'inpaint': {'class_type': 'CV2InpaintTexture', 'inputs': {
        'texture': ['fill', 0], 'mask': ['fill', 1], 'inpaint_radius': 3, 'inpaint_method': 'ns'}},
    'apply': {'class_type': 'Hy3DApplyTexture', 'inputs': {'texture': ['inpaint', 0], 'renderer': ['fill', 2]}},
    'export': {'class_type': 'Hy3DExportMesh', 'inputs': {
        'trimesh': ['apply', 0], 'filename_prefix': f'paint/{name}', 'file_format': 'glb', 'save_file': True}},
    'views': {'class_type': 'SaveImage', 'inputs': {'images': ['paint', 0], 'filename_prefix': f'paint/{name}_view'}},
    'normals': {'class_type': 'SaveImage', 'inputs': {'images': ['render', 0], 'filename_prefix': f'paint/{name}_normal'}},
    'texture': {'class_type': 'SaveImage', 'inputs': {'images': ['inpaint', 0], 'filename_prefix': f'paint/{name}_texture'}},
}


def get(path, timeout=60):
    return urllib.request.urlopen(API + path, timeout=timeout)


prompt = env('PROMPT')  # pick up a run that is already queued, by its id
if not prompt:
    request = urllib.request.Request(API + '/prompt', json.dumps({'prompt': graph, 'client_id': uuid.uuid4().hex}).encode(), {'Content-Type': 'application/json'})
    try:
        prompt = json.load(urllib.request.urlopen(request, timeout=120))['prompt_id']
    except urllib.error.HTTPError as error:
        sys.exit(error.read().decode()[:3000])
    print('prompt', prompt, flush=True)
started = time.time()
while True:
    try:
        history = json.load(get(f'/history/{prompt}'))
    except OSError:  # the server does not answer while it loads a model
        time.sleep(10)
        continue
    if prompt in history and history[prompt]['status'].get('completed') is not None:
        entry = history[prompt]
        if entry['status']['status_str'] != 'success':
            sys.exit(json.dumps(entry['status'], indent=1)[:4000])
        break
    time.sleep(5)
print(f'done in {time.time() - started:.0f}s')


def fetch(item, kind='output'):
    query = urllib.parse.urlencode({'filename': item['filename'], 'subfolder': item.get('subfolder', ''), 'type': kind})
    return get('/view?' + query, timeout=300).read()


os.makedirs(out, exist_ok=True)
from PIL import Image
import io
for key in ('views', 'normals', 'texture'):
    frames = [Image.open(io.BytesIO(fetch(item))).convert('RGB') for item in entry['outputs'][key]['images']]
    if key == 'texture':
        frames[0].save(f'{out}/{name}.texture.png')
        continue
    frames = [frame.resize((256, 256), Image.LANCZOS) for frame in frames]
    strip = Image.new('RGB', (256 * len(frames), 256))
    for index, frame in enumerate(frames):
        strip.paste(frame, (256 * index, 0))
    strip.save(f'{out}/{name}.{key}.png')
# The export node reports no file entry, so ask for each numbered file in turn and keep the last that exists.
mesh_bytes = None
for counter in range(1, 1000):
    try:
        mesh_bytes = fetch({'filename': f'{name}_{counter:05}_.glb', 'subfolder': 'paint'})
    except urllib.error.HTTPError:
        break
if mesh_bytes is None:
    sys.exit('the painted mesh was not found in the output folder')
open(f'{out}/{name}.painted.glb', 'wb').write(mesh_bytes)
print(f'{out}/{name}.painted.glb')
