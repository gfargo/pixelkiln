"""Stack the stone-hall building kit into a terraced hall with stairs.

The kit's rules are not a per-tile map, so no engine terrain tool lays it: pieces are
placed by cell and height. A piece's floor diamond sits at (10, 37) of its 52x58 cell, and
one level is 16px (a solid block is two levels). Stairs come in pairs that climb 16px,
pieces 40 and 41 climbing north, so a 32px rise is two pairs, the upper pair over blocks
sunk one level so the stairs have something under them.

Two pieces are touched up after placing: the ramp's slope is repainted in the stairs'
stone (the kit draws it far paler), and each doorway, a hole the background shows
through, is filled with a dim passage.

  pixelkiln export --style buildings --format generic --out /tmp/hall/hall
  python3 compose-hall.py /tmp/hall/hall.json /tmp/hall/hall.png out.png
"""
import json, sys
from PIL import Image
d=json.load(open(sys.argv[1]))
atlas=Image.open(sys.argv[2]).convert('RGBA')
def crop(i):
    t=d['tiles'][i]; return atlas.crop((t['x'],t['y'],t['x']+52,t['y']+58))
def piece(i):
    if i==HALF: return half_block()
    if i in (RAMP_LO,RAMP_HI): return stone_ramp(i)
    return crop(i)

def lum(p): return (299*p[0]+587*p[1]+114*p[2])//1000
def stone_ramp(i):
    """The kit draws a ramp's slope in pale lit stone (luminance 165 to 250), brighter
    than anything else in the kit, so it read as a white wedge. Bring the slope down
    to the stairs' stone (whose treads top out at 165), keeping its shading: each
    slope pixel takes the stair colour at the same place in the stairs' upper range."""
    out=crop(i)
    stair=sorted({p[:3] for p in crop(STAIR_LO).getdata() if p[3] and lum(p)>=118},key=lum)
    px=out.load()
    for y in range(out.height):
        for x in range(out.width):
            r,g,b,a=px[x,y]
            if not a or lum((r,g,b))<150: continue
            t=min(1,(lum((r,g,b))-150)/60)
            px[x,y]=stair[round(t*(len(stair)-1))]+(a,)
    return out

def light_doorways(img,bg):
    """A doorway in the back wall is a hole the background shows through, which reads
    as a black panel. Fill each hole (background not reachable from the image's edge)
    with a passage: dark above, the floor's darkest brown at the threshold."""
    w,h=img.size; px=img.load(); seen=set(); stack=[(0,0)]
    while stack:
        x,y=stack.pop()
        if (x,y) in seen or not (0<=x<w and 0<=y<h) or px[x,y][:3]!=bg: continue
        seen.add((x,y)); stack+= [(x+1,y),(x-1,y),(x,y+1),(x,y-1)]
    holes={(x,y) for y in range(h) for x in range(w) if px[x,y][:3]==bg and (x,y) not in seen}
    while holes:
        part=[holes.pop()]; k=0
        while k<len(part):
            x,y=part[k]; k+=1
            for n in ((x+1,y),(x-1,y),(x,y+1),(x,y-1)):
                if n in holes: holes.remove(n); part.append(n)
        y0=min(y for _,y in part); y1=max(y for _,y in part)
        dark,warm=(26,22,20),(60,45,45)
        for x,y in part:
            t=((y-y0)/max(1,y1-y0))**2
            px[x,y]=tuple(round(dark[c]+(warm[c]-dark[c])*t) for c in range(3))+(255,)

HALF=100   # not in the kit: a solid block one level (16px) high
def half_block():
    """The kit has solid blocks two levels high only. Drop 16 rows from the middle of
    one and a half-height block is left: its top and bottom edges are untouched."""
    t=d['tiles'][53]; full=atlas.crop((t['x'],t['y'],t['x']+52,t['y']+58))
    out=Image.new('RGBA',(52,58),(0,0,0,0))
    out.paste(full.crop((0,0,52,24)),(0,16))
    out.paste(full.crop((0,40,52,58)),(0,40))
    return out
FW,FH=32,16        # floor diamond
AX,AY=10,37        # where the diamond's top-left sits in a piece
STRIDE=16
class Scene:
    def __init__(s): s.items=[]
    def put(s,i,gx,gy,z=0): s.items.append((i,gx,gy,z))
    def render(s,scale=2,margin=20,bg=(18,16,13)):
        pts=[]
        for i,gx,gy,z in s.items:
            sx=(gx-gy)*FW//2; sy=(gx+gy)*FH//2-z*STRIDE
            pts.append((i,sx-AX,sy-AY))
        x0=min(p[1] for p in pts)-margin; y0=min(p[2] for p in pts)-margin
        x1=max(p[1] for p in pts)+52+margin; y1=max(p[2] for p in pts)+58+margin
        img=Image.new('RGBA',(x1-x0,y1-y0),bg+(255,))
        order=sorted(range(len(s.items)),key=lambda k:(s.items[k][1]+s.items[k][2], s.items[k][3], k))
        for k in order:
            i,px,py=pts[k]; img.alpha_composite(piece(i),(px-x0,py-y0))
        light_doorways(img,bg)
        return img.resize((img.width*scale,img.height*scale),Image.NEAREST)

s=Scene()
FLOOR,WN,WE,WS,WW,PIL,STAIR_LO,STAIR_HI,BLOCK,SLATE=0,1,2,3,4,31,40,41,53,44
RAMP_LO,RAMP_HI=42,43          # climb east, 8px a piece
# tier A: floor z0, gy 5..9, running on east to the side room
for gx in range(12):
    for gy in range(5,10): s.put(FLOOR,gx,gy,0)
# stair 1 at gx=3, ascending north from gy=8 to gy=5: two pairs, the upper over half blocks
s.put(STAIR_LO,3,8,0); s.put(STAIR_HI,3,7,0)
s.put(HALF,3,6,0); s.put(STAIR_LO,3,6,1)
s.put(HALF,3,5,0); s.put(STAIR_HI,3,5,1)
# tier B: blocks z0 gy 1..4 (top at z2); stair 2 at gx=6 ascending north from gy=4 to gy=1
for gx in range(10):
    for gy in range(1,5):
        s.put(BLOCK,gx,gy,0)
s.put(STAIR_LO,6,4,2); s.put(STAIR_HI,6,3,2)
s.put(HALF,6,2,2); s.put(STAIR_LO,6,2,3)
s.put(HALF,6,1,2); s.put(STAIR_HI,6,1,3)
# tier C: two blocks high at gy -2..0 (top at z4)
for gx in range(10):
    for gy in range(-2,1):
        s.put(BLOCK,gx,gy,0); s.put(BLOCK,gx,gy,2)
# flagstones on the upper tiers, except where the stairs land
for gx in range(10):
    for gy in range(1,5):
        if gx==6: continue
        s.put(FLOOR,gx,gy,2)
    for gy in range(-2,1): s.put(FLOOR,gx,gy,4)
s.put(FLOOR,6,0,4)
# back wall and left wall, stepping up with the tiers
for gx in range(10):
    if gx in (5,6): continue
    s.put(WN,gx,-2,4)
s.put(32,5,-2,4); s.put(33,6,-2,4)
for gy in range(-2,1): s.put(WW,0,gy,4)
for gy in range(1,5): s.put(WW,0,gy,2)
for gy in range(5,10): s.put(WW,0,gy,0)
# pillars
for gy in (6,9): s.put(PIL,8,gy,0)
s.put(PIL,8,-1,4); s.put(PIL,2,-1,4)
# side room to the east, one level up. A ramp is cut into its west side and climbs east into it
RAMP_ROW=9
for gx in range(12,17):
    for gy in range(5,10):
        if gy==RAMP_ROW and gx in (12,13):
            s.put(FLOOR,gx,gy,0)
            continue
        s.put(HALF,gx,gy,0); s.put(FLOOR,gx,gy,1)
s.put(RAMP_LO,12,RAMP_ROW,0); s.put(RAMP_HI,13,RAMP_ROW,0)
for gx in (13,14): s.put(WN,gx,5,1)
s.put(32,15,5,1); s.put(33,16,5,1)
for gy in (5,6,7): s.put(WW,12,gy,1)
s.put(PIL,15,8,1); s.put(PIL,14,6,1)
for gx in (14,15):
    for gy in (7,8): s.put(SLATE,gx,gy,1)
img=s.render(scale=2)
img.save(sys.argv[3]); print(img.size)
