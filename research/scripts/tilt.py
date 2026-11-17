"""How far each view's long axis leans from vertical, for an object meant to stand upright.
Only meaningful for elongated silhouettes; a round or squat one is reported as n/a."""
import sys, math
from PIL import Image
D=["south","south-east","east","north-east","north","north-west","west","south-west"]
d,name=sys.argv[1],sys.argv[2]
out=[]
for v in D:
    im=Image.open(f'{d}/{name}-{v}.png').convert('RGBA'); px=im.load()
    pts=[(x,y) for y in range(im.height) for x in range(im.width) if px[x,y][3]>127]
    n=len(pts); mx=sum(p[0] for p in pts)/n; my=sum(p[1] for p in pts)/n
    sxx=sum((p[0]-mx)**2 for p in pts)/n; syy=sum((p[1]-my)**2 for p in pts)/n; sxy=sum((p[0]-mx)*(p[1]-my) for p in pts)/n
    ang=0.5*math.atan2(2*sxy,sxx-syy)  # angle of the long axis from the x axis
    l1=(sxx+syy)/2+math.hypot((sxx-syy)/2,sxy); l2=(sxx+syy)/2-math.hypot((sxx-syy)/2,sxy)
    lean=abs(90-abs(math.degrees(ang)))
    out.append((v, round(lean), round(math.sqrt(l1/max(l2,1e-6)),1)))
long=[o for o in out if o[2]>=2]
print(name, 'max lean', max(o[1] for o in long) if long else 'n/a', '|', ' '.join(f'{v}:{l}' for v,l,_ in out))
