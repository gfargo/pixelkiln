import type { LockEntry, ResolvedSpec } from "../types.ts"
import { fallbackOutputRole, resolveSpecEntryOutputs, sourceIsStem, sourceOutputPath } from "../outputs.ts"
import { packSprites, type PackedFrame, type PackedSource } from "./pack.ts"

export type TilesetFormat = "generic" | "tiled" | "godot"

export interface NormalizedTileRules {
  ruleType: "edge" | "corner" | "outline"
  arity: 4 | 6
  connectivity?: "same" | "other"
  terrains: string[]
  /** Provider tile index to adjacency mask. Tiles absent here are stamp-only. */
  masks: Record<number, number>
  raw: Record<string, unknown>
}

export interface GenericTileset {
  format: "pixelkiln-tileset"
  version: 1
  name: string
  style: string
  asset: string
  image: string
  tile: { width: number; height: number }
  sheet: { width: number; height: number; columns: number }
  tiles: Array<{
    id: number
    /** Original provider index; can differ from id when stamp-only keys leave gaps. */
    sourceIndex: number
    role: string
    x: number
    y: number
    width: number
    height: number
    bitmask?: number
    stampOnly: boolean
  }>
  /** Complete provider object, even when its rule family is not normalized yet. */
  providerRules: Record<string, unknown> | null
  rules: NormalizedTileRules | null
}

export interface TilesetExport {
  png: Buffer
  extension: ".json" | ".tsj" | ".tres"
  document: string
  generic: GenericTileset
  sources: PackedSource[]
}

export interface TilesetExportOptions {
  format: TilesetFormat
  manifestDir: string
  imageName: string
  columns?: number
}

/** Parse the deliberately open provider schema into the stable export subset. */
export function normalizeTileRules(raw: unknown): NormalizedTileRules | null {
  if (!isRecord(raw)) return null
  const ruleType = raw.rule_type
  const arity = raw.arity
  if (ruleType !== "edge" && ruleType !== "corner" && ruleType !== "outline") return null
  if (arity !== 4 && arity !== 6) return null

  const masks: Record<number, number> = {}
  if (isRecord(raw.tiles)) {
    for (const [key, value] of Object.entries(raw.tiles)) {
      const index = tileIndex(key)
      const mask = typeof value === "number"
        ? value
        : isRecord(value) && typeof value.bitmask === "number"
          ? value.bitmask
          : isRecord(value) && typeof value.mask === "number"
            ? value.mask
            : null
      if (index !== null && mask !== null && Number.isInteger(mask) && mask >= 0) masks[index] = mask
    }
  }

  const connectivity = raw.connectivity === "same" || raw.connectivity === "other"
    ? raw.connectivity
    : undefined
  const terrains = Array.isArray(raw.terrains)
    ? raw.terrains.filter((item): item is string => typeof item === "string")
    : []
  return {
    ruleType,
    arity,
    ...(connectivity ? { connectivity } : {}),
    terrains,
    masks,
    raw,
  }
}

/**
 * The `terrain` generator's `/create-tileset` response has no `tileRules`
 * object at all: each tile instead carries a `corners` map naming which of
 * the two terrains occupies its NW/NE/SW/SE corner (`pollTerrain` in
 * src/providers/pixellab.ts). This derives the same corner bitmask
 * `normalizeTileRules` would have gotten directly from the provider, using
 * docs/TILES.md's bit order (NW/NE/SW/SE = 3/2/1/0) with a set bit meaning
 * "first terrain".
 */
export function normalizeTerrainTiles(metadata: unknown): NormalizedTileRules | null {
  if (!isRecord(metadata) || !Array.isArray(metadata.terrainTiles)) return null
  const terrains = Array.isArray(metadata.terrainTypes)
    ? metadata.terrainTypes.filter((item): item is string => typeof item === "string")
    : []
  if (terrains.length < 2) return null

  const masks: Record<number, number> = {}
  metadata.terrainTiles.forEach((tile, index) => {
    if (!isRecord(tile) || !isRecord(tile.corners)) return
    const corners = tile.corners
    const bit = (corner: string) => (corners[corner] === terrains[0] ? 1 : 0)
    masks[index] = (bit("NW") << 3) | (bit("NE") << 2) | (bit("SW") << 1) | bit("SE")
  })

  return {
    ruleType: "corner",
    arity: 4,
    terrains,
    masks,
    raw: metadata,
  }
}

/** Build an atlas plus generic, Tiled TSJ, or Godot 4 TileSet metadata. */
export function exportTileset(
  entry: LockEntry,
  spec: ResolvedSpec,
  options: TilesetExportOptions,
): TilesetExport {
  let outputs = resolveSpecEntryOutputs(entry, spec)
  if (!outputs.length) throw new Error(`${spec.styleId}/${spec.assetId} has no downloaded outputs`)
  // A hand edit of the set stands in for it tile by tile, as pack and mount do.
  if (spec.source && sourceIsStem(spec.source, entry, options.manifestDir)) {
    outputs = outputs.map((output) => ({ ...output, absolutePath: sourceOutputPath(spec.source!, entry, output.index, options.manifestDir) }))
  }

  const packed = packSprites(
    outputs.map((output) => ({
      id: output.role ?? fallbackOutputRole(output.index),
      path: output.absolutePath,
    })),
    { columns: options.columns, order: "input" },
  )
  if (packed.skipped.length) {
    throw new Error(
      `Cannot export ${spec.styleId}/${spec.assetId}: ` +
        packed.skipped.map((item) => `${item.id}: ${item.reason}`).join("; "),
    )
  }

  const metadata = entry.providerMetadata?.[entry.provider]
  const rawRules = isRecord(metadata) ? metadata.tileRules : undefined
  const terrainRules = normalizeTerrainTiles(metadata)
  const rules = normalizeTileRules(rawRules) ?? terrainRules
  const providerRules = isRecord(rawRules) ? rawRules : terrainRules ? metadata as Record<string, unknown> : null
  const frames = packed.atlas.frames
  const generic = buildGeneric(
    spec,
    options.imageName,
    packed.atlas,
    frames,
    providerRules,
    rules,
  )

  if (options.format === "generic") {
    return {
      png: packed.png,
      extension: ".json",
      document: JSON.stringify(generic, null, 2) + "\n",
      generic,
      sources: packed.sources,
    }
  }

  assertUniformTiles(generic)
  if ((rawRules !== undefined || entry.tileFeature || entry.generator === "terrain") && !rules) {
    throw new Error(
      `${options.format} export needs recognized adjacency rules; use --format generic ` +
        `to retain this provider rule object without guessing`,
    )
  }
  if (rules?.arity === 6) {
    throw new Error(
      `${options.format} export does not yet map six-edge hex masks safely; use --format generic`,
    )
  }
  if (rules?.ruleType === "outline") {
    throw new Error(
      `${options.format} export cannot infer adjacency from outline/stamp-only rules; use --format generic`,
    )
  }
  if (
    options.format === "godot" && rules?.ruleType === "edge" &&
    godotTileShape(spec.tileType ?? "isometric") !== 0
  ) {
    throw new Error(
      "godot export does not yet map edge/side adjacency onto an isometric or oblique tile's " +
        "diagonal peering bits safely; use --format generic or --format tiled",
    )
  }

  if (options.format === "tiled") {
    return {
      png: packed.png,
      extension: ".tsj",
      document: JSON.stringify(buildTiled(generic), null, 2) + "\n",
      generic,
      sources: packed.sources,
    }
  }
  return {
    png: packed.png,
    extension: ".tres",
    document: buildGodot(generic, spec),
    generic,
    sources: packed.sources,
  }
}

function buildGeneric(
  spec: ResolvedSpec,
  imageName: string,
  atlas: { sheet: { width: number; height: number }; cell: { width: number; height: number }; columns: number },
  frames: PackedFrame[],
  providerRules: Record<string, unknown> | null,
  rules: NormalizedTileRules | null,
): GenericTileset {
  return {
    format: "pixelkiln-tileset",
    version: 1,
    name: `${spec.styleId}/${spec.assetId}`,
    style: spec.styleId,
    asset: spec.assetId,
    image: imageName,
    tile: { ...atlas.cell },
    sheet: { ...atlas.sheet, columns: atlas.columns },
    tiles: frames.map((frame, index) => {
      const sourceIndex = tileIndex(frame.id) ?? index
      return {
        id: index,
        sourceIndex,
        role: frame.id,
        x: frame.x,
        y: frame.y,
        width: frame.width,
        height: frame.height,
        ...(rules?.masks[sourceIndex] !== undefined ? { bitmask: rules.masks[sourceIndex] } : {}),
        stampOnly: rules ? rules.masks[sourceIndex] === undefined : true,
      }
    }),
    providerRules,
    rules,
  }
}

function buildTiled(generic: GenericTileset): Record<string, unknown> {
  const rules = generic.rules
  const tiled: Record<string, unknown> = {
    type: "tileset",
    version: "1.10",
    tiledversion: "1.12.2",
    name: generic.name.replace("/", "-"),
    tilewidth: generic.tile.width,
    tileheight: generic.tile.height,
    tilecount: generic.tiles.length,
    columns: generic.sheet.columns,
    image: generic.image,
    imagewidth: generic.sheet.width,
    imageheight: generic.sheet.height,
    margin: 0,
    spacing: 0,
  }
  if (!rules || rules.ruleType === "outline") return tiled

  const terrainNames = terrainNamesFor(rules)
  tiled.wangsets = [{
    name: generic.name,
    type: rules.ruleType,
    tile: representativeTile(generic, 0),
    colors: terrainNames.map((name, index) => ({
      name,
      color: index === 0 ? "#5ab552" : "#4c78a8",
      tile: representativeTile(generic, index),
      probability: 1,
    })),
    properties: rules.connectivity
      ? [{ name: "pixelkiln:connectivity", type: "string", value: rules.connectivity }]
      : [],
    wangtiles: generic.tiles
      .filter((tile) => tile.bitmask !== undefined)
      .map((tile) => ({ tileid: tile.id, wangid: tiledWangId(rules, tile.bitmask!) })),
  }]
  return tiled
}

function tiledWangId(rules: NormalizedTileRules, mask: number): number[] {
  const bitColor = (bit: number) => ((mask & (1 << bit)) !== 0 ? 1 : 2)
  if (rules.ruleType === "corner") {
    // Tiled order: top edge, NE, right edge, SE, bottom edge, SW, left edge, NW.
    return [0, bitColor(2), 0, bitColor(0), 0, bitColor(1), 0, bitColor(3)]
  }
  // PixelLab edge mask: bit0=N bit1=E bit2=S bit3=W.
  return [bitColor(0), 0, bitColor(1), 0, bitColor(2), 0, bitColor(3), 0]
}

function buildGodot(generic: GenericTileset, spec: ResolvedSpec): string {
  const rules = generic.rules
  const shape = godotTileShape(spec.tileType ?? "isometric")
  const lines = [
    `[gd_resource type="TileSet" load_steps=3 format=3]`,
    "",
    `[ext_resource type="Texture2D" path=${JSON.stringify(`./${generic.image}`)} id="1_texture"]`,
    "",
    `[sub_resource type="TileSetAtlasSource" id="TileSetAtlasSource_pixelkiln"]`,
    `texture = ExtResource("1_texture")`,
    `texture_region_size = Vector2i(${generic.tile.width}, ${generic.tile.height})`,
  ]

  for (const tile of generic.tiles) {
    const x = tile.id % generic.sheet.columns
    const y = Math.floor(tile.id / generic.sheet.columns)
    lines.push(`${x}:${y}/0 = 0`)
    if (!rules || tile.bitmask === undefined || rules.ruleType === "outline") continue
    const values = godotTerrainBits(rules, tile.bitmask, shape)
    lines.push(`${x}:${y}/0/terrain_set = 0`)
    lines.push(`${x}:${y}/0/terrain = ${dominantTerrain(values)}`)
    for (const [side, value] of Object.entries(values)) {
      lines.push(`${x}:${y}/0/terrains_peering_bit/${side} = ${value}`)
    }
  }

  lines.push("", "[resource]")
  lines.push(`tile_size = Vector2i(${generic.tile.width}, ${generic.tile.height})`)
  if (shape !== 0) lines.push(`tile_shape = ${shape}`)
  if (rules && rules.ruleType !== "outline") {
    lines.push(`terrain_set_0/mode = ${rules.ruleType === "corner" ? 1 : 2}`)
    for (const [index, name] of terrainNamesFor(rules).entries()) {
      lines.push(`terrain_set_0/terrain_${index}/name = ${JSON.stringify(name)}`)
      lines.push(
        `terrain_set_0/terrain_${index}/color = ` +
          (index === 0 ? "Color(0.3529, 0.7098, 0.3216, 1)" : "Color(0.298, 0.4706, 0.6588, 1)"),
      )
    }
  }
  lines.push(`sources/0 = SubResource("TileSetAtlasSource_pixelkiln")`, "")
  return lines.join("\n")
}

/**
 * Godot validates peering-bit property names against the TileSet's own
 * `tile_shape` (`is_valid_terrain_peering_bit()`) and silently drops any
 * that don't match: a square tile's `top_left_corner` etc. are rejected
 * outright on an isometric/oblique (diamond) tile, which instead wants the
 * diamond-point names `top_corner`/`right_corner`/`bottom_corner`/`left_corner`.
 * Confirmed both experimentally (headless Godot 4.7.2 `is_valid_terrain_peering_bit`)
 * and against a shipped, hand-verified isometric Wang set (disc-golf-game's
 * docs/terrain-tiles.md §5: "Each of the 16 tiles was rendered, its four
 * diamond corners sampled for light-vs-dark, and checked against its mask").
 */
function godotTerrainBits(rules: NormalizedTileRules, mask: number, shape: number): Record<string, number> {
  const terrain = (bit: number) => ((mask & (1 << bit)) !== 0 ? 0 : 1)
  if (rules.ruleType === "corner") {
    if (shape === 1) {
      return {
        top_corner: terrain(3),
        right_corner: terrain(2),
        left_corner: terrain(1),
        bottom_corner: terrain(0),
      }
    }
    return {
      top_left_corner: terrain(3),
      top_right_corner: terrain(2),
      bottom_left_corner: terrain(1),
      bottom_right_corner: terrain(0),
    }
  }
  // Isometric/oblique edge masks are refused before reaching here (see the
  // "edge/side adjacency" guard in exportTileset()) since the diagonal
  // peering-bit direction hasn't been verified the way the corner case has.
  return {
    top_side: terrain(0),
    right_side: terrain(1),
    bottom_side: terrain(2),
    left_side: terrain(3),
  }
}

function dominantTerrain(values: Record<string, number>): number {
  const terrainZero = Object.values(values).filter((value) => value === 0).length
  return terrainZero * 2 >= Object.keys(values).length ? 0 : 1
}

function godotTileShape(tileType: string | undefined): number {
  if (tileType === "isometric" || tileType === "oblique") return 1
  if (tileType === "hex" || tileType === "hex_pointy") return 3
  return 0
}

function representativeTile(generic: GenericTileset, terrainIndex: number): number {
  const rules = generic.rules!
  const full = (1 << rules.arity) - 1
  const wanted = terrainIndex === 0 ? full : 0
  return generic.tiles.find((tile) => tile.bitmask === wanted)?.id ?? -1
}

function terrainNamesFor(rules: NormalizedTileRules): string[] {
  return [rules.terrains[0] ?? "feature", rules.terrains[1] ?? "background"]
}

function assertUniformTiles(generic: GenericTileset): void {
  const mismatched = generic.tiles.filter(
    (tile) => tile.width !== generic.tile.width || tile.height !== generic.tile.height,
  )
  if (mismatched.length) {
    throw new Error(
      `Engine tilesets require uniform ${generic.tile.width}x${generic.tile.height} cells; ` +
        `mismatched: ${mismatched.map((tile) => tile.role).join(", ")}. Use --format generic.`,
    )
  }
}

function tileIndex(key: string): number | null {
  const match = key.match(/(?:^|[_-])(\d+)$/)
  return match ? Number(match[1]) : null
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
