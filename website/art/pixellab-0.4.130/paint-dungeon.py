"""Paint a dungeon from the 25-tile Pro lava set, matching each cell's 4x4
neighbourhood against the pattern_4x4 this project's lockfile recorded.

A tall-wall set adds a third vertex value: a lava vertex directly below a
floor vertex is "transition", the wall face. Each tile's pattern covers the
vertex columns x-1..x+2 and rows y-1..y+2 (255 is a wildcard), which is how
the four wall-continuation twins are told apart.

Usage: python3 paint-dungeon.py <this project dir> <out.png>
"""
import json
import sys

from PIL import Image

proj, out = sys.argv[1], sys.argv[2]
entry = json.load(open(f"{proj}/pixelkiln.lock.json"))["entries"]["dungeon/lava-floor"]
meta = entry["providerMetadata"]["pixellab"]
patterns = {t["role"]: t["pattern4x4"] for t in meta["terrainTiles"]}
tiles = []
for o in entry["outputs"]:
    p = patterns[o["role"]]
    tiles.append(([p["row_0"], p["row_1"], p["row_2"], p["row_3"]], Image.open(f"{proj}/{o['path']}").convert("RGBA")))

# 0 lava, 1 raised floor. Walls face south and only vertical bridges join
# platforms, because the set has no tile for an inside wall corner.
rows = [
    "00000000000000000",
    "01111110001111110",
    "01100110001100110",
    "01100110001100110",
    "01111111111111110",
    "00000001100000000",
    "00000001100000000",
    "00000001100000000",
    "00000001100000000",
    "00001111111100000",
    "00001111111100000",
    "00001100001100000",
    "00001100001100000",
    "00001111111100000",
    "00000000000000000",
    "00000000000000000",
]
V = [[int(c) for c in r] for r in rows]
H, W = len(V), len(V[0])
# Lava directly below floor is the wall face.
A = [[2 if V[y][x] == 0 and y > 0 and V[y - 1][x] == 1 else V[y][x] for x in range(W)] for y in range(H)]

def at(x, y):
    return A[y][x] if 0 <= x < W and 0 <= y < H else 0

T = tiles[0][1].width
img = Image.new("RGBA", ((W - 1) * T, (H - 1) * T))
missing = []
for y in range(H - 1):
    for x in range(W - 1):
        best = None
        for pattern, tile in tiles:
            score = 0
            for py in range(4):
                for px in range(4):
                    want = pattern[py][px]
                    if want == 255:
                        continue
                    if at(x - 1 + px, y - 1 + py) != want:
                        score = -1
                        break
                    score += 1
                if score < 0:
                    break
            if score >= 0 and (best is None or score > best[0]):
                best = (score, tile)
        if best is None:
            missing.append((x, y))
        else:
            img.alpha_composite(best[1], (x * T, y * T))
if missing:
    raise SystemExit(f"no tile matches cells {missing}")
img.save(out)
print(img.size)
