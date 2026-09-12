#!/usr/bin/env bash
# Materialise the PixelKiln editor build: upstream Pixelorama at the pinned
# tag, plus our bridge extension and the one-line hook that loads it, exported
# for the web with the PWA service worker disabled. Needs `godot` (4.x, same
# version as pin.json) with web export templates installed — the CI job uses
# the barichello/godot-ci image; locally, any Godot 4.7.2 install works.
set -euo pipefail
HERE="$(cd "$(dirname "$0")/.." && pwd)"
TAG="$(sed -n 's/.*"pixelorama": *"\([^"]*\)".*/\1/p' "$HERE/pin.json")"
WORK="${WORK:-$HERE/.work}"
UPSTREAM="$WORK/pixelorama"
OUT="${OUT:-$WORK/build}"
GODOT="${GODOT:-godot}"

[ -n "$TAG" ] || { echo "pin.json has no pixelorama tag" >&2; exit 1; }
rm -rf "$UPSTREAM" "$OUT"
mkdir -p "$WORK" "$OUT"
echo "cloning Pixelorama $TAG"
git clone --quiet --depth 1 --branch "$TAG" --recurse-submodules https://github.com/Orama-Interactive/Pixelorama "$UPSTREAM"

echo "applying overlay"
cp -R "$HERE/overlay/src/Extensions/PixelKilnBridge" "$UPSTREAM/src/Extensions/"
perl -0pi -e 's/func _add_internal_extensions\(\) -> void:\n\tpass\b/func _add_internal_extensions() -> void:\n\t_load_extension("PixelKilnBridge", true)/' "$UPSTREAM/src/HandleExtensions.gd"
grep -q '_load_extension("PixelKilnBridge", true)' "$UPSTREAM/src/HandleExtensions.gd" || { echo "hook did not apply; upstream changed _add_internal_extensions" >&2; exit 1; }
# No PWA: a service worker would register under the gallery's origin.
sed -i.bak 's|^progressive_web_app/enabled=true|progressive_web_app/enabled=false|' "$UPSTREAM/export_presets.cfg" && rm -f "$UPSTREAM/export_presets.cfg.bak"
grep -q '^progressive_web_app/enabled=false' "$UPSTREAM/export_presets.cfg" || { echo "could not disable the PWA export option" >&2; exit 1; }
grep -q '^variant/thread_support=false' "$UPSTREAM/export_presets.cfg" || { echo "upstream enabled thread support; the gallery would need COOP/COEP" >&2; exit 1; }

echo "exporting web build with $("$GODOT" --version 2>/dev/null | head -1)"
( cd "$UPSTREAM" && "$GODOT" --headless --import >/dev/null 2>&1 || true )
( cd "$UPSTREAM" && "$GODOT" --headless --export-release "Web" "$OUT/index.html" )
ls -la "$OUT"
echo "build at $OUT"
