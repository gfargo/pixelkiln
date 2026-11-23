"""Depth map for a picture with Depth Anything V2 Small, on the CPU.

Research script for docs/RESEARCH_PARALLAX.md.

    python3 depth.py <in.png> <out.png> [scale]

The picture is enlarged `scale` times (nearest neighbour, default 2) before the model sees it,
and the depth map is brought back to the picture's size. Brighter is nearer. Needs torch,
transformers and pillow; the model downloads from Hugging Face on first run.
"""

import sys
import time

from PIL import Image
from transformers import pipeline

src, out = sys.argv[1], sys.argv[2]
scale = int(sys.argv[3]) if len(sys.argv) > 3 else 2
img = Image.open(src).convert("RGB")
big = img.resize((img.width * scale, img.height * scale), Image.NEAREST)
pipe = pipeline("depth-estimation", model="depth-anything/Depth-Anything-V2-Small-hf", device="cpu")
t = time.time()
depth = pipe(big)["depth"]
print(f"{src}: {time.time() - t:.1f} s")
depth.resize(img.size, Image.BILINEAR).save(out)
