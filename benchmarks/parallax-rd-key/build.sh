#!/bin/sh
# Step 21: Retro Diffusion layers made with tile_x and no background removal, keyed by script.
# Free: no generation. Run from the repository root with numpy, pillow and scipy:
#
#   sh benchmarks/parallax-rd-key/build.sh
set -e
P() { python3 research/scripts/parallax.py "$@"; }
B=benchmarks/parallax-rd-key
R=website/public/research/parallax/rd-key
out=$R/keyed
mkdir -p "$out"

# Seam ratios as generated, before keying.
P seam $R/environment/volcanic-far.png $R/environment/volcanic-near.png \
  $R/default/volcanic-far.png $R/default/volcanic-mid.png $R/default/volcanic-near.png
# Key out the most common top-row colour, flooding from the top row with the picture wrapped
# sideways. Each line prints the seam ratio before and after.
for f in environment/volcanic-far environment/volcanic-near default/volcanic-far default/volcanic-mid default/volcanic-near; do
  P key $R/$f.png $out/$(dirname $f)-$(basename $f).png 24
done

# Each layer twice side by side, the seam in the middle: step 15's near layer with Retro
# Diffusion's own background removal, then this step's two near layers keyed by script.
P twice website/public/research/parallax/generated/retrodiffusion/volcanic-near.png $out/step15-near.twice.png
P twice $out/environment-volcanic-near.png $out/environment-volcanic-near.twice.png
P twice $out/default-volcanic-near.png $out/default-volcanic-near.twice.png
P sheet $R/seams.png 1 "#5aa0aa" $out/step15-near.twice.png $out/environment-volcanic-near.twice.png $out/default-volcanic-near.twice.png
rm -f $out/*.twice.png

# The five pictures as generated, and keyed.
P sheet $R/candidates.png 2 "#ffffff" \
  $R/environment/volcanic-far.png $out/environment-volcanic-far.png \
  $R/environment/volcanic-near.png $out/environment-volcanic-near.png \
  $R/default/volcanic-far.png $out/default-volcanic-far.png \
  $R/default/volcanic-mid.png $out/default-volcanic-mid.png \
  $R/default/volcanic-near.png $out/default-volcanic-near.png

# A set from the keyed layers over step 18's scripted volcanic sky. Every layer wraps at its own
# width as generated; nothing is cut or crossfaded. Only the first frame is kept.
STILL=$R/set.png SCALE=2 P skyline $out/set.gif $B/set.json
rm -f $out/set.gif
