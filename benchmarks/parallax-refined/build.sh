#!/bin/sh
# Post-process the picked candidates for the parallax how-to and research note, then render
# the previews. Free: no generation. Run from the repository root with numpy, pillow and scipy:
#
#   sh benchmarks/parallax-refined/build.sh
set -e
P="python3 research/scripts/parallax.py"
R=website/public/research/parallax/refined

build() {
  biome=$1
  out=$R/$biome/picked
  mkdir -p "$out"
  man=benchmarks/parallax-refined/$biome/pixelkiln.manifest.json
  # Silhouettes: trim, dither the bottom 30% out, then one copy per tier, each pulled toward its own colour: the far tier lighter, the near tier darker.
  for pick in $SILS; do
    name=$(dirname "$pick")-$(basename "$pick" .png)
    $P foot "$R/$biome/$pick" "$out/$name.png" 0.3
    $P tint "$out/$name.png" "$out/$name.far.png" "$TIER_FAR" "$TIER_FAR_T" "$man"
    $P tint "$out/$name.png" "$out/$name.near.png" "$TIER_NEAR" "$TIER_NEAR_T" "$man"
  done
  # Whole layers: loop each at its best matching columns. The far range comes back as one
  # flat colour, so it is recoloured to a palette colour that sits behind the sky's bands.
  $P loop "$R/$biome/$FAR" "$out/far.png" cut
  $P tint "$out/far.png" "$out/far.png" "$FAR_COLOUR" 1 "$man"
  if [ "$MID_LANDMARK" = 1 ]; then
    cp "$R/$biome/$MID" "$out/mid.png" # drawn once, not looped
  else
    $P loop "$R/$biome/$MID" "$out/mid.png" cut
  fi
  $P loop "$R/$biome/$NEAR" "$out/near.png" cut
  rm -f "$out"/*.twice.png
  for spec in silhouettes layers; do
    STILL="$R/$biome/$spec.png" SCALE=2 $P skyline "$R/$biome/$spec.webp" "benchmarks/parallax-refined/$biome/$spec.json"
  done
}

SILS="b/landform-cone.png b/landform-rim.png b/landform-mesa.png c/landform-cone.png"
FAR=b/layer-far.png MID=c/layer-mid.png NEAR=a/layer-near.png MID_LANDMARK=1
TIER_FAR="#7f4776" TIER_FAR_T=0.55 TIER_NEAR="#403a61" TIER_NEAR_T=0.4 FAR_COLOUR="#936090"
build volcanic

SILS="b/landform-peak.png b/landform-twin.png b/landform-ridge.png a/landform-peak.png a/landform-ridge.png"
FAR=a/layer-far.png MID=a/layer-mid.png NEAR=a/layer-near.png MID_LANDMARK=0
TIER_FAR="#9d97b9" TIER_FAR_T=0.4 TIER_NEAR="#56609d" TIER_NEAR_T=0.2 FAR_COLOUR="#9499b9"
build alpine

# The prompt comparison: the scene-style prompt (top row) against the sprite prompt (bottom
# row), the same three landforms and seed, before any post-processing.
V=$R/volcanic
$P sheet $R/prompt-compare.png 3 "#5aa0aa" \
  $V/b/silhouette-cone.png $V/b/silhouette-rim.png $V/b/silhouette-mesa.png \
  $V/b/landform-cone.png $V/b/landform-rim.png $V/b/landform-mesa.png
# One picked landform: as generated, after the dithered foot, then the far and near tier copies.
$P sheet $R/foot-and-tiers.png 2 "#5aa0aa" \
  $V/b/landform-cone.png $V/picked/b-landform-cone.png $V/picked/b-landform-cone.far.png $V/picked/b-landform-cone.near.png
