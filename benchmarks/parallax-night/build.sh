#!/bin/sh
# Step 20: alpine at night, two ways. Regenerated on a forced night palette, and step 18's dusk
# set recoloured to that palette by script. Free: no generation. Run from the repository root
# with numpy, pillow and scipy:
#
#   sh benchmarks/parallax-night/build.sh
set -e
P() { python3 research/scripts/parallax.py "$@"; }
B=benchmarks/parallax-night
N=website/public/research/parallax/night
D=website/public/research/parallax/refined/alpine
DUSK=benchmarks/parallax-refined/alpine/pixelkiln.manifest.json
NIGHT=$B/alpine/pixelkiln.manifest.json
out=$N/picked
mkdir -p "$out"

# Regenerated. Every pick is seed 202. The prompt's "at night" brought a moon or stars into 7 of
# the 9 pictures, so each pick keeps only its largest shape and what touches its bottom row.
for l in far mid near; do
  P isolate $N/alpine/b/layer-$l.png $out/$l.png
  P loop $out/$l.png $out/$l.png cut
done
# The twin and the ridge came with a pale two-row ground line under them; cut it before the foot.
for f in peak:0 twin:2 ridge:2; do
  drop=${f#*:} f=${f%:*}
  P isolate $N/alpine/b/landform-$f.png $out/$f.png
  P foot $out/$f.png $out/$f.png 0.3 $drop
  P tint $out/$f.png $out/$f.far.png "#375da1" 0.4 $NIGHT
  P tint $out/$f.png $out/$f.near.png "#0e1b4d" 0.3 $NIGHT
done
rm -f "$out"/*.twice.png

# Recoloured. Step 18's finished dusk pieces, each through the same palette swap: the dusk
# palette ranked dark to light onto the night palette's cool colours.
rc=$out/recoloured
mkdir -p "$rc"
for f in far mid near b-landform-peak b-landform-twin b-landform-ridge a-landform-peak a-landform-ridge; do
  P recolour $D/picked/$f.png $rc/$f.png $DUSK $NIGHT cool
done
for f in b-landform-peak b-landform-twin b-landform-ridge a-landform-peak a-landform-ridge; do
  P recolour $D/picked/$f.far.png $rc/$f.far.png $DUSK $NIGHT cool
  P recolour $D/picked/$f.near.png $rc/$f.near.png $DUSK $NIGHT cool
done

# The fault the cool-only swap avoids: onto the whole night palette, pink-lit snow takes the
# lamp colours. Step 18's dusk middle layer, the swap onto all 42 colours, and onto the 34 cool.
P recolour $D/picked/mid.png $rc/mid.all.png $DUSK $NIGHT all
P sheet $N/swap.png 1 "#5aa0aa" $D/picked/mid.png $rc/mid.all.png $rc/mid.png

for spec in regenerated recoloured; do
  STILL=$N/$spec.png SCALE=2 P skyline $N/$spec.webp $B/$spec.json
  STILL=$N/$spec-silhouettes.png SCALE=2 P skyline $N/$spec-silhouettes.webp $B/$spec-silhouettes.json
done
# Only the layer previews are kept animated; the silhouette ones are stills.
rm -f $N/regenerated-silhouettes.webp $N/recoloured-silhouettes.webp

# Where each palette came from: PixelLab's alpine valley A at dusk, and the same prompt and
# seed at night.
P sheet $N/reference.png 2 "#5aa0aa" \
  website/public/benchmarks/provider-environments/pixellab/background/a/alpine-valley.png \
  $N/reference/alpine-valley-night.png
# The nine regenerated candidates as generated: layers at seeds 101 and 202, landforms at 202.
P sheet $N/candidates.png 3 "#5aa0aa" \
  $N/alpine/a/layer-far.png $N/alpine/a/layer-mid.png $N/alpine/a/layer-near.png \
  $N/alpine/b/layer-far.png $N/alpine/b/layer-mid.png $N/alpine/b/layer-near.png \
  $N/alpine/b/landform-peak.png $N/alpine/b/landform-twin.png $N/alpine/b/landform-ridge.png
