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

### Terrain reference images

A `terrain` asset can hand PixelLab a PNG for each terrain instead of leaving
its look to the description alone:

```json
"cave": {
  "prompt": "1). teal slime pool 2). purple crystal floor",
  "terrainReferences": { "lower": "refs/slime.png", "upper": "refs/crystal.png" }
}
```

Paths are relative to the manifest. Each file is hashed into the asset's
identity, so replacing a reference marks the set stale and renaming it does
not. A missing file is a manifest error, and a file changed between `plan` and
`gen` is refused at submit so the request always matches what was priced.

**A reference is used almost as the texture itself.** Two hand-made 16x16
striped swatches came back as the fill of both terrains, stripes intact, with
PixelLab drawing only the border between them (November 2026, a standard 16px
set, billed 1). Give it a tile you would be happy to see repeated, not a mood
board.

A top-down set takes `lower`, `upper` and `transition`. A sidescroller set
takes one, and which one depends on its mode: `transition` (the surface
layer's texture) on standard, `lower` (the platform body to keep) on pro. Each
must be a square PNG of the tile size, and `upper` is refused, since a
sidescroller's upper terrain is empty air.

### The `terrain` generator's shape

`terrain` (`/create-tileset`, or `/create-tileset-sidescroller` for a
sidescroller set; [`docs/GENERATORS.md`](GENERATORS.md)) is a different
PixelLab endpoint from `tiles`' `tileFeature: "tileset"` above, and its
response carries no `tile_rules` bitmask at all. Instead each tile names
which terrain occupies its four corners directly:

```jsonc
{
  "providerMetadata": {
    "pixellab": {
      "terrainTypes": ["lower", "upper"],
      "terrainTiles": [
        { "role": "tile-00-none", "corners": { "NW": "upper", "NE": "upper", "SW": "upper", "SE": "upper" } },
        { "role": "tile-01-nw-ne-sw-se", "corners": { "NW": "lower", "NE": "lower", "SW": "lower", "SE": "lower" } }
      ],
      // Each terrain's base tile id; a connected set sends one of these.
      "terrainIds": { "lower": "<uuid>", "upper": "<uuid>" }
    }
  }
}
```

A sidescroller set names its terrains `["central", "background"]` while its
corners still say `lower` (the platform) and `upper` (empty air; the
all-`upper` tile is blank). PixelKiln records the corner vocabulary,
`["lower", "upper"]`, as `terrainTypes` so masks match, and keeps
PixelLab's names as `providerTerrainTypes` beside `view: "side"`. In Tiled
and Godot the platform is terrain 0.

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
`terrainTransitionSize: 1`, or 0.5 on Pro) has no bit of its own in a two-terrain corner
mask; it is folded into whichever of `terrains[0]`/`terrains[1]` it isn't.

That 25-tile layout covers 21 distinct corner combinations. Four
wall-continuation tiles share their corners with a twin and differ only in
`pattern_4x4`, which PixelLab says is the field to match on. PixelKiln
stores each tile's `pattern4x4` but builds masks from `corners`, so each
twin pair gets the same mask.

## Command

```bash
pixelkiln export --style ground --only terrain --format generic
pixelkiln export --style ground --only terrain --format tiled
pixelkiln export --style ground --only terrain --format godot
pixelkiln export --style ground --only terrain --format ldtk
pixelkiln export --style ground --format tiled --merge-connected
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
- for an isometric set, `footprint`: the ground diamond inside each tile image
  (see [Isometric tiles](#isometric-tiles))

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

(Where the tile's cell and origin go is under [Isometric tiles](#isometric-tiles).)

**`terrain`-generator tiles are always square, never isometric.**
`/create-tileset` places tiles on a rectangular vertex grid (its own docs: "a
map of W×H cells has (W+1)×(H+1) vertices" — standard square Wang-tiling
math, with no shape parameter at all, unlike `create-tiles-pro`'s `tile_type`
enum), and its raw output is fully opaque with no diamond alpha mask,
confirmed against a downstream consumer's real generated tiles. `terrain`'s
resolved spec always carries `tileType: "square_topdown"` for exactly this
reason, so the exporter never falls back to `tiles`' own "isometric" default
(the real API default for that generator, not terrain's) for a terrain
asset. The isometric corner-name mapping above is real and does apply — to
an isometric `tiles`-generator tileset (`tileFeature: "tileset"` with
`tileType: "isometric"`), not to `terrain`.

Both this `TileSet` and the `SpriteFrames` that `pack --format godot` writes
are loaded by a headless Godot 4.7.2 in CI (`npm run test:godot`), which
reports the atlas tiles, terrain sets and names, animation names, frame
counts, speeds, and loop flags it sees, and — for both a square terrain
tileset and an isometric `tiles` tileset — round-trips an actual peering bit
through Godot's own `get_terrain_peering_bit()` rather than only checking
tile/terrain-set counts. That last check is what would have caught the
isometric-corner-names bug; the counts alone did not.

## Isometric tiles

An isometric tile is a 2:1 diamond, but its image is rarely just the diamond:
a block's sides hang below it. PixelLab measured a 32x24 tile with the
diamond's midline on row 7, so the diamond is 32 wide and 16 tall, at the top
of the image, with 8 rows of side below it. An engine's grid is the diamond, not
the image, and it has to know where on the image the diamond is to put each
tile on its cell.

`export` finds the diamond from the tile art's alpha: its apex is the first
opaque row, its width is the widest row, and its height is twice the distance
from the apex to that row (it uses half the width when that comes out within a
couple of pixels, since a true diamond is 2:1). The result is written as
`footprint` in the generic file and used by:

- **Godot.** `tile_size` is the diamond (32x16), `texture_region_size` still
  cuts the whole image (32x24), every tile gets a `texture_origin` that moves
  the image so its diamond sits on the cell (here `Vector2i(0, -4)`), and the
  layout is `tile_layout = 5` (diamond down), which is what makes an isometric
  map a diamond lattice. Godot's own default, stacked, staggers the rows.
- **Tiled.** The tileset gets `grid` (`isometric`, 32 by 16) and a
  `tileoffset` that lowers the image onto its cell: Tiled lines an image up by
  its bottom edge, so a diamond at the top of a taller image sits too high by
  the difference (here `y: 8`).

Tiles drawn as filled squares have no diamond to find, so they get no
footprint and no offsets; Godot is still laid out as a diamond. `oblique` sets
get none. If a set's diamond is not on the first opaque row because the art is
raised on purpose (`tileElevation`), the raised art is read as the ground.

How it was checked: a 2x2 block of cells drawn by a `TileMapLayer` in Godot
4.7.2 filled exactly the lattice the cell centres predict, with the stacked
layout and with no origin both visibly wrong. CI's headless Godot reads
`tile_size`, `tile_layout` and `texture_origin` back from the exported TileSet.
The Tiled offset follows Tiled's documented drawing rule and has not been
loaded in Tiled.

## LDtk

The `.ldtk` export is a whole project file: open it in LDtk 1.5 and the set is
already a tileset, a pair of layers with auto-tiling rules, and a small
"Preview" level painted to show every tile.

LDtk has no terrain concept. It paints a cell value on an IntGrid layer, and an
AutoLayer picks tiles by matching rules against the values around each cell.
The export turns each mask into one rule, so painting two values gives the same
borders the other formats give.

- **Corner sets (`terrain`, corner-ruled `tiles`).** Corners belong to the
  vertices between cells, so the export uses a dual grid. The IntGrid layer
  (`<asset>_corners`) holds one value per vertex and is shifted half a tile up
  and left; the AutoLayer (`<asset>`) reads each tile's own cell plus the cell to
  the right, below and below-right, which are its NW, NE, SW and SE corners
  (mask bits 3/2/1/0). The first terrain is value 1, the second value 2.
- **Edge sets.** The IntGrid layer (`<asset>_cells`) is not shifted. A rule
  reads the cell and its four neighbours; the cell takes the terrain most of its
  edges have (the first terrain on a tie).
- **Tiles that share a mask** (the 25-tile cliff set's wall twins) sit in one
  rule as alternatives, so LDtk picks among them at random.
- The tileset carries each tile's mask as custom data (`mask=<n>`).
- Outside the level the rules read the second terrain.
- The file has no timestamp and fixed ids, so an unchanged set exports the same
  bytes.

Only square tiles on an orthogonal grid export. Hex, isometric and oblique
tiles, `outline` rules, non-square tiles and sets with no mask map are refused
with the format to use instead (`generic` or `tiled`).

**What was checked in LDtk.** LDtk has no headless mode, so CI cannot load the
file; the tests instead compare the key sets with the sample projects shipped
with LDtk 1.5 and run the written rules through a port of LDtk's own matcher.
Once, by hand, a 16-tile lake and grass set was opened in LDtk 1.5.3: the
Preview level drew continuous shorelines, LDtk re-evaluated the rules and
produced exactly the 108 tiles stored in the file, and painting a grass cell on
the corners layer redrew the right tiles around it. LDtk changed only things it
owns: layer and tileset names get a capital first letter (the project asks for
that style), `cachedPixelData` is filled in, and the build id. Only corner sets
were opened; edge sets are covered by the matcher tests alone.

A merged group was opened the same way: two connected sets built from that real
art, grass shared, with the lake's blue recolored to dirt (32 tiles, three
terrains, 31 rules). The 16 by 12 Preview drew grass, lake and dirt with the
right border at every join, LDtk's own rule evaluation reproduced all 192
stored tiles, and painting dirt beside grass redrew the right tiles. Painting a
terrain next to one it has no set with (dirt against lake) left those cells
empty: no tile has a lake corner and a dirt corner, so no rule matches. That is
the same hard edge the Connected sets section describes; paint a band of the
shared terrain between them.

## Connected sets

A coast is built from sets that share a terrain: one draws ocean against sand,
the next draws that same sand against grass, a third grass against forest
floor. Each set is 16 or 25 tiles with two terrains, but the map has four.
`--merge-connected` writes the whole group as one tileset with all four.

```bash
pixelkiln export --style ground --format tiled --merge-connected
pixelkiln export --style ground --only meadow --format godot --merge-connected
```

Naming any set in the group exports the group, so `--only meadow` also pulls
in the coast and forest sets it connects to. Every set in the group has to be
generated; a missing one stops the export and is named in the error.

- **Which terrain is which.** The manifest's `connect` says it: the meadow's
  lower terrain *is* the coast's upper one, so they are one terrain in the
  result. Terrains are numbered in the order the group meets them, starting
  from the set that connects to nothing: ocean 0, sand 1, grass 2, forest floor 3.
- **Names.** Each terrain is named from the first clause of the description
  in the set that defines it (`1). deep ocean water, small waves` becomes
  `deep ocean water`), lowercased and cut to 32 characters. A set with no
  description text falls back to `<asset>_lower` or `<asset>_upper`, and a
  repeated name gets a number.
- **Tiles.** Every set's tiles go into one atlas, role-prefixed with their set
  (`coast/tile-03-...`), in the group's order. A tile's four corners are
  recorded as terrain numbers, in place of the two-terrain bitmask. Two sets
  that draw the same pair of corners (sand all round, from the coast and from
  the meadow) both stay in the atlas.
- **Generic JSON.** `sets` lists the group, `rules.terrains` the names, and
  each tile has `corners: [NW, NE, SW, SE]` where a single set has `bitmask`.
- **Tiled.** One Wang set with a color per terrain; each tile's id carries its
  four corner colors.
- **Godot.** One terrain set with a terrain per name and a peering bit on every
  corner of every tile.
- **LDtk.** One IntGrid layer with a value per terrain and one rule per
  distinct set of four corners; tiles that share one are alternatives in that
  rule. The Preview level is larger (16 by 12) and painted so that only
  terrains a set joins ever meet, and the level's outside counts as the first
  terrain. The preview uses every rule. Cells whose corners no set joins are
  left empty, so paint the shared terrain between two that have no set.
- **Files.** The default name joins the sets: `coast-meadow-forest-tileset`.
  `--out` names the one result. The record beside it lists the sets.

Sets in a group must share a tile size and shape. A group containing a
sidescroller set is refused.

## Deliberate limits

- Tiled, Godot and LDtk exports require every image to match the atlas cell size.
- Six-edge hex masks remain generic-only. Their engine layouts depend on hex
  orientation and offset conventions that the current manifest does not yet
  declare, and we have no real hex set to check a mapping against. LDtk has no
  hex or isometric tiles at all, so those never export to it.
- `outline` and building-kit images absent from the rule map are stamp-only.
  Generic export retains them; engine exporters reject a rule family whose
  placement semantics would have to be invented.
- A `terrain` asset's `"transition"` corners collapse into a two-color mask
  (see above); the cliff-tier 25-tile set exports, but its middle transition
  ring is not distinguished from the two named terrains in Tiled/Godot, and
  its four wall-continuation twins export with duplicate masks.
- A `terrain` set exports alone unless you ask for `--merge-connected`; see
  [Connected sets](#connected-sets). A connected set (`connect` in the
  manifest, `lower_base_tile_id`/`upper_base_tile_id` in the API) shares a
  terrain with another set, the way PixelLab's
  [Pro tilesets guide](https://www.youtube.com/watch?v=MbkqpDUFkEg) paints
  ocean, sand, grass, path, and cliffs on one map. Without the flag each set
  exports as its own two-terrain Tiled Wang set, Godot terrain set or LDtk
  layer pair.
- Merging works on `terrain` sets only. A sidescroller set connects just its
  platform, and `tiles` sets have no `connect`, so neither merges.
- Godot edge/side masks on an isometric or oblique tile remain generic- or
  Tiled-only: which diagonal each edge bit means has not been checked against
  a real edge-ruled isometric set, the way the corner mapping was.
- `terrain` sets are square, top-down or side-on because PixelLab's tileset
  endpoint has no shape option. Isometric corner sets come from `tiles` with
  `tileFeature: "tileset"`, and export as above.
- Export never changes source PNGs or the lockfile.
