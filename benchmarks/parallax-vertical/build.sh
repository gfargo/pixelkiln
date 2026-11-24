#!/bin/sh
# Post-process the picked climb candidates and render the vertical previews. Free: no
# generation. Run from the repository root with numpy, pillow and scipy:
#
#   sh benchmarks/parallax-vertical/build.sh
set -e
P="python3 research/scripts/parallax.py"
V=website/public/research/parallax/vertical
B=benchmarks/parallax-vertical
MAN=$B/climb/pixelkiln.manifest.json
out=$V/picked
mkdir -p "$out"
# The wall: cliff b's summit on top, its body looped down to 700 rows.
$P wall $V/b/cliff.png $out/wall.png 700 100
# The landmark you climb past, pulled toward the far tier's colour so it sits behind the clouds.
$P tint $V/c/massif.png $out/massif.png "#9d97b9" 0.35 $MAN
# Clouds: a far copy pulled toward the haze, and the near copy as generated.
for pick in a/cloud-puff b/cloud-puff c/cloud-puff a/cloud-bank; do
  name=$(dirname $pick)-$(basename $pick)
  cp $V/$pick.png $out/$name.png
  $P tint $V/$pick.png $out/$name.far.png "#9d97b9" 0.4 $MAN
done
# Retro Diffusion's tile_y sky, as generated: snapped to the alpine palette it kept 5 colours.
cp $V/retrodiffusion/sky-tile.png $out/sky-tile.png
# Its clouds come from PixelLab on the alpine palette, so snap copies to the sky's own colours.
for k in a b c; do $P tint $V/$k/cloud-puff.png $out/$k-cloud-puff.sky.png "#f0a8f0" 0.15 $out/sky-tile.png; done
STILL=$V/climb.png SCALE=2 $P climb $V/climb.webp $B/climb.json
STILL=$V/loop.png SCALE=2 $P climb $V/loop.webp $B/loop.json
# Candidate sheets for the note.
$P sheet $V/candidates.png 4 "#5aa0aa" \
  $V/a/massif.png $V/b/massif.png $V/c/massif.png $V/a/cloud-bank.png \
  $V/a/cloud-puff.png $V/b/cloud-puff.png $V/c/cloud-puff.png $V/a/cloud-streak.png
$P sheet $V/walls.png 3 "#5aa0aa" $V/a/cliff.png $V/b/cliff.png $V/c/cliff.png $out/wall.png
