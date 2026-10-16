"""Light the chest with its normal map: a light circling the sprite, written as a GIF.

Usage: python3 relight.py <sprite.png> <normals.png> <out.gif> <out-still.png>
"""
import sys, math
from PIL import Image
albedo = Image.open(sys.argv[1]).convert("RGBA"); normal = Image.open(sys.argv[2]).convert("RGBA")
out_gif, out_still, scale = sys.argv[3], sys.argv[4], 1
W, H = albedo.size
A = albedo.load(); N = normal.load()
frames = []
for i in range(24):
    t = 2 * math.pi * i / 24
    lx, ly, lz = math.cos(t) * 0.8, math.sin(t) * 0.8, 0.6
    n = math.sqrt(lx*lx+ly*ly+lz*lz); lx, ly, lz = lx/n, ly/n, lz/n
    f = Image.new("RGBA", (W, H), (18, 16, 13, 255)); F = f.load()
    for y in range(H):
        for x in range(W):
            r, g, b, a = A[x, y]
            if a == 0: continue
            nr, ng, nb, _ = N[x, y]
            nx, ny, nz = nr/127.5-1, ng/127.5-1, nb/127.5-1   # opengl: green up
            d = max(0.0, nx*lx + ny*ly + nz*lz)
            k = 0.25 + 1.05 * d
            F[x, y] = (min(255, int(r*k)), min(255, int(g*k)), min(255, int(b*k)), 255)
    frames.append(f.resize((W*scale, H*scale), Image.NEAREST).convert("P", palette=Image.ADAPTIVE))
frames[0].save(out_gif, save_all=True, append_images=frames[1:], duration=70, loop=0, disposal=2)
frames[3].convert("RGBA").save(out_still)
print(len(frames))
