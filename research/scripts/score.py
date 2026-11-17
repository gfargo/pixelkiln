"""Score row 2 of a sheet (model from the eight sprite directions) against row 1 (the sprites).
Each model cell is first slid to where it overlaps its sprite best, so a render drawn off-centre is not penalised."""
import sys, numpy as np
from PIL import Image
im=np.array(Image.open(sys.argv[1]).convert('RGBA')); size=im.shape[0]//3; skip={int(x) for x in sys.argv[2].split(',')} if len(sys.argv)>2 and sys.argv[2] else set()
r=[]
for v in range(8):
    if v in skip: continue
    a=im[:size,v*size:(v+1)*size]; b0=im[size:2*size,v*size:(v+1)*size]; ma=a[:,:,3]>127
    best=None
    for dy in range(-8,9):
        for dx in range(-8,9):
            b=np.roll(np.roll(b0,dy,0),dx,1); mb=b[:,:,3]>127; i=(ma&mb).sum()/max(1,(ma|mb).sum())
            if best is None or i>best[0]: best=(i,b,mb)
    i,b,mb=best; both=ma&mb
    d=np.abs(a[:,:,:3].astype(int)-b[:,:,:3].astype(int))[both]
    r.append((i, d.mean(), (d.max(1)<=24).mean()))
r=np.array(r); print('%-26s silhouette %.1f  colourError %.1f  pixelsClose %.1f'%(sys.argv[1].split('/')[-1], r[:,0].mean()*100, r[:,1].mean(), r[:,2].mean()*100))
