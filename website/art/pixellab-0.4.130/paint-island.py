"""Paint a small island from the two connected terrain sets, picking each
cell's tile by the corners this project's lockfile recorded.

Usage: python3 paint-island.py <this project dir> <out.png>
"""
import json, sys
from PIL import Image
proj, out = sys.argv[1], sys.argv[2]
lock = json.load(open(f"{proj}/pixelkiln.lock.json"))
def load(key):
    e = lock["entries"][key]; meta = e["providerMetadata"]["pixellab"]
    roles = {t["role"]: t["corners"] for t in meta["terrainTiles"]}
    tiles = {}
    for o in e["outputs"]:
        c = roles[o["role"]]
        tiles[(c["NW"], c["NE"], c["SW"], c["SE"])] = Image.open(f"{proj}/{o['path']}").convert("RGBA")
    return tiles
A, B = load("coast/ocean-sand"), load("coast/sand-grass")
# vertex grid: 0 ocean, 1 sand, 2 grass
W, H = 15, 10
rows = [
"000000000000000",
"000111111000000",
"001111111110000",
"011122211111000",
"011222221111100",
"011222222211100",
"001122222111000",
"000111211110000",
"000011111000000",
"000000000000000",
"000000000000000",
]
V = [[int(ch) for ch in r] for r in rows]
T = 32
img = Image.new("RGBA", (W * T - T, (len(V) - 1) * T))
for y in range(len(V) - 1):
    for x in range(W - 1):
        c = (V[y][x], V[y][x+1], V[y+1][x], V[y+1][x+1])
        if max(c) <= 1:
            key = tuple("lower" if v == 0 else "upper" for v in c); tile = A[key]
        elif min(c) >= 1:
            key = tuple("lower" if v == 1 else "upper" for v in c); tile = B[key]
        else:
            raise SystemExit(f"ocean meets grass at {x},{y}")
        img.alpha_composite(tile, (x * T, y * T))
img.save(out)
print(img.size)
