"""Run ComfyUI's Hunyuan3D-2mv graph on four views of one subject and fetch the mesh.
usage: hy3d_run.py <in-dir> <name> <out-dir> [seed] [steps] [views=front,left,back,right]"""
import sys, json, time, uuid, urllib.request, urllib.parse, os
API='http://127.0.0.1:18188'
d,name,out=sys.argv[1:4]; seed=int(sys.argv[4]) if len(sys.argv)>4 else 7; steps=int(sys.argv[5]) if len(sys.argv)>5 else 30
views=(sys.argv[6] if len(sys.argv)>6 else 'front,left,back,right').split(',')
def post(path,data,headers): return json.load(urllib.request.urlopen(urllib.request.Request(API+path,data=data,headers=headers),timeout=120))
def upload(file):
    b=uuid.uuid4().hex; body=open(file,'rb').read(); fn=os.path.basename(file)
    data=(f'--{b}\r\nContent-Disposition: form-data; name="image"; filename="{fn}"\r\nContent-Type: image/png\r\n\r\n').encode()+body+(f'\r\n--{b}\r\nContent-Disposition: form-data; name="overwrite"\r\n\r\ntrue\r\n--{b}--\r\n').encode()
    return post('/upload/image',data,{'Content-Type':f'multipart/form-data; boundary={b}'})['name']
info=json.load(urllib.request.urlopen(API+'/object_info/VoxelToMesh',timeout=30))['VoxelToMesh']['input']['required']
algo=info['algorithm'][0] if isinstance(info['algorithm'][0],list) else info['algorithm'][1]['options']
algo=[a for a in algo if 'surface' in a] or algo
g={'1':{'class_type':'ImageOnlyCheckpointLoader','inputs':{'ckpt_name':'hunyuan3d-dit-v2-mv.safetensors'}},
   '2':{'class_type':'ModelSamplingAuraFlow','inputs':{'model':['1',0],'shift':1.0}},
   '3':{'class_type':'EmptyLatentHunyuan3Dv2','inputs':{'resolution':3072,'batch_size':1}},
   '5':{'class_type':'Hunyuan3Dv2ConditioningMultiView','inputs':{}},
   '6':{'class_type':'KSampler','inputs':{'model':['2',0],'positive':['5',0],'negative':['5',1],'latent_image':['3',0],'seed':seed,'steps':steps,'cfg':5.0,'sampler_name':'euler','scheduler':'normal','denoise':1.0}},
   '7':{'class_type':'VAEDecodeHunyuan3D','inputs':{'samples':['6',0],'vae':['1',2],'num_chunks':8000,'octree_resolution':256}},
   '8':{'class_type':'VoxelToMesh','inputs':{'voxel':['7',0],'algorithm':algo[0],'threshold':0.6}},
   '9':{'class_type':'SaveGLB','inputs':{'mesh':['8',0],'filename_prefix':f'pk3d/{name}'}}}
for i,v in enumerate(views):
    fn=upload(f'{d}/pk3d_{name}_{v}.png')
    g[f'l{i}']={'class_type':'LoadImage','inputs':{'image':fn}}
    g[f'c{i}']={'class_type':'CLIPVisionEncode','inputs':{'clip_vision':['1',1],'image':[f'l{i}',0],'crop':'none'}}
    g['5']['inputs'][v]=[f'c{i}',0]
t=time.time()
pid=post('/prompt',json.dumps({'prompt':g,'client_id':uuid.uuid4().hex}).encode(),{'Content-Type':'application/json'})['prompt_id']
while True:
    h=json.load(urllib.request.urlopen(f'{API}/history/{pid}',timeout=30))
    if pid in h:
        e=h[pid]; st=e.get('status',{})
        if st.get('status_str')=='error': print('ERROR', json.dumps(st)[:1500]); sys.exit(1)
        if e.get('outputs'): break
    if time.time()-t>1500: print('timeout'); sys.exit(1)
    time.sleep(4)
files=[f for o in e['outputs'].values() for v in o.values() if isinstance(v,list) for f in v if isinstance(f,dict) and 'filename' in f]
os.makedirs(out,exist_ok=True)
for f in files:
    q=urllib.parse.urlencode({'filename':f['filename'],'subfolder':f.get('subfolder',''),'type':f.get('type','output')})
    data=urllib.request.urlopen(f'{API}/view?{q}',timeout=300).read()
    ext=os.path.splitext(f['filename'])[1]; tag='-'.join(views) if len(views)!=4 else 'mv'
    open(f'{out}/{name}-{tag}{ext}','wb').write(data); print(name, tag, f['filename'], len(data), 'bytes', round(time.time()-t), 's', 'algo', algo[0])
