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

### The `terrain` generator's shape

`terrain` (`/create-tileset`, [`docs/GENERATORS.md`](GENERATORS.md)) is a
different PixelLab endpoint from `tiles`' `tileFeature: "tileset"` above, and
its response carries no `tile_rules` bitmask at all. Instead each tile names
which terrain occupies its four corners directly:

```jsonc
{
  "providerMetadata": {
    "pixellab": {
      "terrainTypes": ["lower", "upper"],
      "terrainTiles": [
        { "role": "tile-00-none", "corners": { "NW": "upper", "NE": "upper", "SW": "upper", "SE": "upper" } },
        { "role": "tile-01-nw-ne-sw-se", "corners": { "NW": "lower", "NE": "lower", "SW": "lower", "SE": "lower" } }
      ]
    }
  }
}
```

`normalizeTerrainTiles()` (`src/pipeline/tileset-export.ts`) turns this into
the same `NormalizedTileRules` shape `tileRules` would have produced directly:
`ruleType: "corner"`, `arity: 4`, `terrains` from `terrainTypes`, and a mask
per tile built from its corners with the same NW/NE/SW/SE = 3/2/1/0 bit order
described under Tiled below (a corner matching `terrains[0]` sets its bit).
`exportTileset()` tries `tileRules` first and falls back to this shape, so
Tiled and Godot export a terrain asset's real Wang placement data rather than
a plain, rule-less atlas. A tile's role carries a name slug rather than a
parseable numeric suffix (`tile-01-nw-ne-sw-se`, not `tile-01`), so its
`sourceIndex` falls back to array position instead of being parsed from the
role — correct here because `terrainTiles` and the output list are pushed in
the same loop, but worth knowing if either is ever reordered independently.

A tile whose corner is `"transition"` (the extra ring PixelLab adds at
`terrainTransitionSize: 1`) has no bit of its own in a two-terrain corner
mask; it is folded into whichever of `terrains[0]`/`terrains[1]` it isn't.

## Command

```bash
pixelkiln export --style ground --only terrain --format generic
pixelkiln export --style ground --only terrain --format tiled
pixelkiln export --style ground --only terrain --format godot
```

`export` selects downloaded `tiles` and `terrain` generator entries; anything
else is not a tileset and does not match `--style`/`--only`. (Selecting only
`tiles` was itself a bug once `terrain` shipped: `runExport()`'s own generator
filter rejected every `terrain` asset before it ever reached `exportTileset()`,
so the normalization above ran and was tested but nothing in the CLI could
invoke it. Fixed in `src/cli/commands/pack.ts`; `test/export-cli.test.ts`
exercises `runExport()` itself so this can't regress silently again.)

`--format` defaults to `generic`. `--out dist/terrain` overrides the output
base when exactly one entry is selected. `--columns` controls atlas columns.
Without `--out`, files land in the style's `outDir` as
`<asset>-tileset.<extension>`, `<asset>-tileset.png`, and
`<asset>-tileset.pixelkiln.json`. A hand-edited set ([`pixelkiln edit`](CLI.md#edit)
or the gallery's editor) is exported tile by tile from its edit files, and the
companion records those paths as the sources.

The companion record is engine-neutral: it stores portable source paths and
SHA-256s, export options (including raw provider rules), output hashes, and a
canonical fingerprint. `verifyArtifactBundle()` can detect changed inputs,
edited/missing outputs, or altered provenance offline without rebuilding the
atlas. The project manifest and lockfile are conservative inputs, so
newly declared or recorded tiles also make an older export stale. The TSJ/TRES
contracts therefore remain free of PixelKiln-only fields.

An existing export without a companion is adopted only when its bytes already
match. Once tracked, a changing output must still match its recorded hash;
manual edits stop the whole export rather than being silently replaced. Use
`--force` only after reviewing the difference to take ownership and re-baseline
the complete bundle.

An immutable transaction journal exists only while the three files are being
replaced. Following abrupt termination, the next export restores the old set if
commit was incomplete, or retains the fully committed new set and removes its
backups. Recovery will not follow journal paths outside the current bundle or
interrupt a live writer.

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

**The peering-bit property names depend on tile shape, and Godot enforces
it.** A square tile's corners are `top_left_corner`/`top_right_corner`/
`bottom_left_corner`/`bottom_right_corner`; an isometric or oblique
(diamond) tile's are the diamond-point names `top_corner`/`right_corner`/
`bottom_corner`/`left_corner` — the square names are invalid on a diamond
tile and Godot's own `is_valid_terrain_peering_bit()` rejects them outright,
so writing the wrong set produces a `.tres` that looks plausible but carries
no usable terrain data at all once loaded. The corner-mask → isometric-name
mapping (mask bit 3/2/1/0 = NW/NE/SW/SE → `top_corner`/`right_corner`/
`left_corner`/`bottom_corner`) is confirmed against a production, hand-verified
isometric Wang set (a downstream consumer's `docs/terrain-tiles.md` §5: every
tile rendered, its corners sampled, checked against its mask). Edge/side
masks on an isometric or oblique tile are refused rather than guessed — the
diagonal peering-bit direction for that case hasn't been verified the same
way — so `--format godot` on an edge-ruled isometric tileset asks for
`--format generic` or `--format tiled` instead, neither of which has this
shape dependency.

The texture path is relative to the `.tres`, so the generated PNG and resource
can move together inside a Godot project.

Both this `TileSet` and the `SpriteFrames` that `pack --format godot` writes
are loaded by a headless Godot 4.7.2 in CI (`npm run test:godot`), which
reports the atlas tiles, terrain sets and names, animation names, frame
counts, speeds, and loop flags it sees, and — for both a square and an
isometric terrain set — round-trips an actual peering bit through Godot's
own `get_terrain_peering_bit()` rather than only checking tile/terrain-set
counts. That last check is what would have caught this bug; the counts alone
did not.

## Deliberate limits

- Tiled and Godot exports require every image to match the atlas cell size.
- Six-edge hex masks remain generic-only. Their engine layouts depend on hex
  orientation and offset conventions that the current manifest does not yet
  declare.
- `outline` and building-kit images absent from the rule map are stamp-only.
  Generic export retains them; engine exporters reject a rule family whose
  placement semantics would have to be invented.
- A `terrain` asset's `"transition"` corners collapse into a two-color mask
  (see above); the cliff-tier 25-tile set exports, but its middle transition
  ring is not distinguished from the two named terrains in Tiled/Godot.
- Godot edge/side masks on an isometric or oblique tile remain generic- or
  Tiled-only; see Godot 4 above.
- Export never changes source PNGs or the lockfile.
