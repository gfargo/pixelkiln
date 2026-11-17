"""Texture a mesh with Hunyuan3D-2's paint stage, one sprite direction at a time.

The paint stage takes one reference picture, the front, and invents every other side. Given a front
view of a caped knight it paints a second face on the back. Here the mesh is turned to face the
camera once for each sprite, that sprite is the reference, and the model paints only the view it
was shown. Each painted view is the sprite redrawn to fit the mesh. The views are then baked onto
the mesh together.

  hunyuan3d_paint_turn.py <mesh.glb> <sprite-dir> <name> <out-dir>

<sprite-dir> holds <name>-<direction>.png. The mesh is y-up with its front towards +z, as
texture.py writes it. Needs numpy, pillow, trimesh, and ssh access to the machine running ComfyUI
to copy meshes into its input folder.

Environment:
  API      ComfyUI address (default http://127.0.0.1:18189)
  REMOTE   scp target of ComfyUI's input folder (default forge:F:/ComfyUI-Paint/ComfyUI/input/)
  DIRS     which directions to paint (default all eight)
  SIGN     which way the mesh turns for the next direction, 1 or -1 (default -1)
  VIEW     size of each painted view (default 512)
  STEPS    sampling steps (default 25)
  SEED     (default 1024)
  TEXTURE  texture size (default 1024)
  POWER    how sharply a view's weight falls as the surface turns away from it (the node's own value is 4)
  STAGE    paint, bake or both (default both)
"""
import io, json, math, os, subprocess, sys, time, urllib.error, urllib.parse, urllib.request, uuid
import numpy as np
import trimesh
from PIL import Image

D = ['south', 'south-east', 'east', 'north-east', 'north', 'north-west', 'west', 'south-west']
env = os.environ.get
API = env('API', 'http://127.0.0.1:18189')
REMOTE = env('REMOTE', 'forge:F:/ComfyUI-Paint/ComfyUI/input/')
mesh_path, sprite_dir, name, out = sys.argv[1:5]
dirs = [D.index(d) for d in env('DIRS', ','.join(D)).split(',')]
SIGN = int(env('SIGN', '-1'))
VIEW = int(env('VIEW', '512'))
STAGE = env('STAGE', 'both')
os.makedirs(out, exist_ok=True)


def get(path, timeout=60):
    return urllib.request.urlopen(API + path, timeout=timeout)


def upload(path):
    boundary = uuid.uuid4().hex
    body = (f'--{boundary}\r\nContent-Disposition: form-data; name="image"; filename="{os.path.basename(path)}"\r\nContent-Type: image/png\r\n\r\n').encode() \
        + open(path, 'rb').read() + (f'\r\n--{boundary}\r\nContent-Disposition: form-data; name="overwrite"\r\n\r\ntrue\r\n--{boundary}--\r\n').encode()
    request = urllib.request.Request(API + '/upload/image', body, {'Content-Type': f'multipart/form-data; boundary={boundary}'})
    return json.load(urllib.request.urlopen(request, timeout=120))['name']


def run(graph):
    request = urllib.request.Request(API + '/prompt', json.dumps({'prompt': graph, 'client_id': uuid.uuid4().hex}).encode(), {'Content-Type': 'application/json'})
    try:
        prompt = json.load(urllib.request.urlopen(request, timeout=120))['prompt_id']
    except urllib.error.HTTPError as error:
        sys.exit(error.read().decode()[:3000])
    while True:
        try:
            history = json.load(get(f'/history/{prompt}'))
        except OSError:  # the server does not answer while it loads a model
            time.sleep(10)
            continue
        if prompt in history and history[prompt]['status'].get('completed') is not None:
            entry = history[prompt]
            if entry['status']['status_str'] != 'success':
                sys.exit(json.dumps(entry['status'], indent=1)[-3000:])
            return entry['outputs']
        time.sleep(3)


def fetch(item):
    query = urllib.parse.urlencode({'filename': item['filename'], 'subfolder': item.get('subfolder', ''), 'type': 'output'})
    return get('/view?' + query, timeout=300).read()


def camera(azims, weights):
    return {'class_type': 'Hy3DCameraConfig', 'inputs': {
        'camera_azimuths': ', '.join(str(a) for a in azims), 'camera_elevations': ', '.join('0' for _ in azims),
        'view_weights': ', '.join(str(w) for w in weights), 'camera_distance': 1.45, 'ortho_scale': 1.2}}


def reference(v):
    """The sprite, enlarged with hard edges, on the light grey the model was trained to expect."""
    sprite = Image.open(f'{sprite_dir}/{name}-{D[v]}.png').convert('RGBA')
    sprite = sprite.crop(sprite.getbbox())
    scale = min(440 // sprite.width, 440 // sprite.height)
    sprite = sprite.resize((sprite.width * scale, sprite.height * scale), Image.NEAREST)
    ground = Image.new('RGBA', (512, 512), (204, 204, 204, 255))
    ground.alpha_composite(sprite, ((512 - sprite.width) // 2, (512 - sprite.height) // 2))
    path = f'{out}/{name}-ref-{v}.png'
    ground.convert('RGB').save(path)
    return upload(path)


base = trimesh.load(mesh_path, force='mesh')
if STAGE in ('paint', 'both'):
    files = []
    for v in dirs:
        turned = base.copy()
        turned.apply_transform(trimesh.transformations.rotation_matrix(SIGN * v * math.pi / 4, [0, 1, 0]))
        turned.visual = trimesh.visual.ColorVisuals(turned)
        path = f'{out}/{name}-turn-{v}.glb'
        turned.export(path)
        files.append(path)
    subprocess.run(['scp', '-q', *files, REMOTE], check=True, stderr=subprocess.DEVNULL)
    for v in dirs:
        started = time.time()
        outputs = run({
            'mesh': {'class_type': 'Hy3DLoadMesh', 'inputs': {'glb_path': f'{name}-turn-{v}.glb'}},
            'uv': {'class_type': 'Hy3DMeshUVWrap', 'inputs': {'trimesh': ['mesh', 0]}},
            # The model was trained to paint six views together; asked for one alone it returns grey noise. Only the first is kept.
            'cam': {'class_type': 'Hy3DCameraConfig', 'inputs': {
                'camera_azimuths': '0, 90, 180, 270, 0, 180', 'camera_elevations': '0, 0, 0, 0, 90, -90',
                'view_weights': '1, 0.1, 0.5, 0.1, 0.05, 0.05', 'camera_distance': 1.45, 'ortho_scale': 1.2}},
            'render': {'class_type': 'Hy3DRenderMultiView', 'inputs': {
                'trimesh': ['uv', 0], 'render_size': 1024, 'texture_size': 1024, 'camera_config': ['cam', 0], 'normal_space': 'world'}},
            'ref': {'class_type': 'LoadImage', 'inputs': {'image': reference(v)}},
            'model': {'class_type': 'DownloadAndLoadHy3DPaintModel', 'inputs': {'model': 'hunyuan3d-paint-v2-0'}},
            'paint': {'class_type': 'Hy3DSampleMultiView', 'inputs': {
                'pipeline': ['model', 0], 'ref_image': ['ref', 0], 'normal_maps': ['render', 0], 'position_maps': ['render', 1],
                'view_size': VIEW, 'steps': int(env('STEPS', '25')), 'seed': int(env('SEED', '1024')),
                'camera_config': ['cam', 0], 'denoise_strength': 1.0}},
            'view': {'class_type': 'SaveImage', 'inputs': {'images': ['paint', 0], 'filename_prefix': f'paint/{name}_turn{v}'}},
            'normal': {'class_type': 'SaveImage', 'inputs': {'images': ['render', 0], 'filename_prefix': f'paint/{name}_turnnormal{v}'}},
        })
        open(f'{out}/{name}-view-{v}.png', 'wb').write(fetch(outputs['view']['images'][0]))
        open(f'{out}/{name}-normal-{v}.png', 'wb').write(fetch(outputs['normal']['images'][0]))
        print(D[v], f'{time.time() - started:.0f}s', flush=True)
    strip = Image.new('RGB', (256 * len(dirs), 768), (204, 204, 204))
    for index, v in enumerate(dirs):
        for row, kind in enumerate(('ref', 'normal', 'view')):
            strip.paste(Image.open(f'{out}/{name}-{kind}-{v}.png').convert('RGB').resize((256, 256), Image.LANCZOS), (256 * index, 256 * row))
    strip.save(f'{out}/{name}.turn.png')

if STAGE in ('bake', 'both'):
    plain = base.copy()
    plain.visual = trimesh.visual.ColorVisuals(plain)
    plain.export(f'{out}/{name}-turn-base.glb')
    subprocess.run(['scp', '-q', f'{out}/{name}-turn-base.glb', REMOTE], check=True, stderr=subprocess.DEVNULL)
    # Turning the mesh by SIGN * v * 45 degrees and looking from the front is the same as leaving it and moving the camera the other way.
    azims = [int(round((-SIGN * v * 45) % 360)) for v in dirs]
    graph = {
        'mesh': {'class_type': 'Hy3DLoadMesh', 'inputs': {'glb_path': f'{name}-turn-base.glb'}},
        'uv': {'class_type': 'Hy3DMeshUVWrap', 'inputs': {'trimesh': ['mesh', 0]}},
        'cam': camera(azims, [1] * len(dirs)),
        'render': {'class_type': 'Hy3DRenderMultiView', 'inputs': {
            'trimesh': ['uv', 0], 'render_size': 1024, 'texture_size': int(env('TEXTURE', '1024')), 'camera_config': ['cam', 0], 'normal_space': 'world'}},
    }
    last = None
    for index, v in enumerate(dirs):
        graph[f'img{index}'] = {'class_type': 'LoadImage', 'inputs': {'image': upload(f'{out}/{name}-view-{v}.png')}}
        if last is None:
            last = [f'img{index}', 0]
        else:
            graph[f'batch{index}'] = {'class_type': 'ImageBatch', 'inputs': {'image1': last, 'image2': [f'img{index}', 0]}}
            last = [f'batch{index}', 0]
    graph.update({
        'big': {'class_type': 'ImageScale', 'inputs': {'image': last, 'upscale_method': 'nearest-exact', 'width': 1024, 'height': 1024, 'crop': 'disabled'}},
        'bake': {'class_type': 'Hy3DBakeFromMultiview', 'inputs': {'images': ['big', 0], 'renderer': ['render', 2], 'camera_config': ['cam', 0]}},
        'fill': {'class_type': 'Hy3DMeshVerticeInpaintTexture', 'inputs': {'texture': ['bake', 0], 'mask': ['bake', 1], 'renderer': ['bake', 2]}},
        'inpaint': {'class_type': 'CV2InpaintTexture', 'inputs': {'texture': ['fill', 0], 'mask': ['fill', 1], 'inpaint_radius': 3, 'inpaint_method': 'ns'}},
        'apply': {'class_type': 'Hy3DApplyTexture', 'inputs': {'texture': ['inpaint', 0], 'renderer': ['fill', 2]}},
        'export': {'class_type': 'Hy3DExportMesh', 'inputs': {'trimesh': ['apply', 0], 'filename_prefix': f'paint/{name}_turned', 'file_format': 'glb', 'save_file': True}},
        'texture': {'class_type': 'SaveImage', 'inputs': {'images': ['inpaint', 0], 'filename_prefix': f'paint/{name}_turntexture'}},
        'check': {'class_type': 'SaveImage', 'inputs': {'images': ['render', 0], 'filename_prefix': f'paint/{name}_turncheck'}},
    })
    outputs = run(graph)
    open(f'{out}/{name}.turn.texture.png', 'wb').write(fetch(outputs['texture']['images'][0]))
    frames = [Image.open(io.BytesIO(fetch(item))).convert('RGB').resize((256, 256), Image.LANCZOS) for item in outputs['check']['images']]
    strip = Image.new('RGB', (256 * len(frames), 256))
    for index, frame in enumerate(frames):
        strip.paste(frame, (256 * index, 0))
    strip.save(f'{out}/{name}.turn.check.png')
    # The export node reports no file entry, so ask for each numbered file in turn and keep the last that exists.
    mesh_bytes = None
    for counter in range(1, 1000):
        try:
            mesh_bytes = fetch({'filename': f'{name}_turned_{counter:05}_.glb', 'subfolder': 'paint'})
        except urllib.error.HTTPError:
            break
    if mesh_bytes is None:
        sys.exit('the painted mesh was not found in the output folder')
    open(f'{out}/{name}.turn.painted.glb', 'wb').write(mesh_bytes)
    print(f'{out}/{name}.turn.painted.glb')
