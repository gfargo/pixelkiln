# Tiles and engine exports

PixelLab connectable output is not merely a directory of images. The response
contains ordered `storage_urls` plus `tile_rules` describing which adjacency
mask belongs to which image. PixelKiln preserves both pieces so downstream
tools never have to reconstruct semantics from filenames.

## Stored state

A completed lock entry has role-qualified outputs in provider order and raw
metadata under the provider id:

```jsonc
{
  "outputs": [
    { "path": "terrain-tile-00.png", "sha256": "…", "role": "tile-00" },
    { "path": "terrain-tile-01.png", "sha256": "…", "role": "tile-01" }
  ],
  "providerMetadata": {
    "pixellab": {
      "tileKind": "tileset",
      "tileRules": {
        "rule_type": "corner",
        "arity": 4,
        "connectivity": "other",
        "terrains": ["feature", "background"],
        "tiles": { "tile_0": 0, "tile_1": 1 }
      }
    }
  }
}
```

Provider keys can contain gaps when a set includes stamp-only images. Output
roles therefore retain the original numeric key (`tile-07`) rather than being
renumbered by array position.

## Command

```bash
pixelkiln export --style ground --only terrain --format generic
pixelkiln export --style ground --only terrain --format tiled
pixelkiln export --style ground --only terrain --format godot
```

`--format` defaults to `generic`. `--out dist/terrain` overrides the output
base when exactly one entry is selected. `--columns` controls atlas columns.
Without `--out`, files land in the style's `outDir` as
`<asset>-tileset.<extension>`, `<asset>-tileset.png`, and
`<asset>-tileset.pixelkiln.json`.

The companion record is engine-neutral: it stores portable source paths and
SHA-256s, export options (including raw provider rules), output hashes, and a
canonical fingerprint. `verifyArtifactBundle()` can detect changed inputs,
edited/missing outputs, or altered provenance offline without rebuilding the
atlas. The project manifest and lockfile are conservative inputs, ensuring that
newly declared or recorded tiles also make an older export stale. The TSJ/TRES
contracts therefore remain free of PixelKiln-only fields.

An existing export without a companion is adopted only when its bytes already
match. Once tracked, a changing output must still match its recorded hash;
manual edits stop the whole export rather than being silently replaced. Use
`--force` only after reviewing the difference to take ownership and re-baseline
the complete bundle.

## Generic JSON

The generic format is the lossless interchange contract:

- `format: "pixelkiln-tileset"` and `version: 1`
- atlas image, cell size, sheet size, and columns
- one ordered tile record with atlas id, original provider `sourceIndex`, role,
  rectangle, optional bitmask, and `stampOnly`
- normalized rule type, arity, connectivity, terrain names, and masks
- the complete raw provider rule object in `providerRules`, including rule
  families a current exporter does not yet normalize

Use it for custom engines, unsupported rule families, or as the input to a
project-specific importer.

## Tiled

The `.tsj` export creates an image tileset and a Wang set. Tiled Wang ids are
written in its documented order: top edge, northeast corner, right edge,
southeast corner, bottom edge, southwest corner, left edge, northwest corner.

For PixelLab corner masks, bits NW/NE/SW/SE = 3/2/1/0 are placed into the four
corner positions. For edge masks, bits N/E/S/W = 0/1/2/3 are placed into the
four edge positions. Terrain names come from the provider metadata; editor
colors are deterministic display colors and do not alter the artwork.

## Godot 4

The `.tres` export creates a `TileSet` containing one `TileSetAtlasSource`.
Four-corner masks use `TERRAIN_MODE_MATCH_CORNERS`; four-edge masks use
`TERRAIN_MODE_MATCH_SIDES`. Each mask becomes the corresponding terrain peering
bits on its atlas tile. Isometric and hex tile shapes are carried from the
resolved manifest spec.

The texture path is relative to the `.tres`, so the generated PNG and resource
can move together inside a Godot project.

## Deliberate limits

- Tiled and Godot exports require every image to match the atlas cell size.
- Six-edge hex masks remain generic-only. Their engine layouts depend on hex
  orientation and offset conventions that the current manifest does not yet
  declare.
- `outline` and building-kit images absent from the rule map are stamp-only.
  Generic export retains them; engine exporters reject a rule family whose
  placement semantics would have to be invented.
- Export never changes source PNGs or the lockfile.
