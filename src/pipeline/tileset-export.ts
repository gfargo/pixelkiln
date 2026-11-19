import type { LockEntry, ResolvedSpec } from "../types.ts"
import { fallbackOutputRole, resolveSpecEntryOutputs, sourceIsStem, sourceOutputPath } from "../outputs.ts"
import { mergeConnectedTerrain, terrainColor, tileCorners, type ConnectedMember, type CornerTerrains } from "./connected-sets.ts"
import { buildLdtk } from "./ldtk-export.ts"
import { packSprites, type PackedFrame, type PackedSource } from "./pack.ts"

export { terrainColor, tileCorners, type CornerTerrains } from "./connected-sets.ts"

export type TilesetFormat = "generic" | "tiled" | "godot" | "ldtk"

export interface NormalizedTileRules {
  ruleType: "edge" | "corner" | "outline"
  arity: 4 | 6
  connectivity?: "same" | "other"
  terrains: string[]
  /** Provider tile index to adjacency mask. Tiles absent here are stamp-only. */
  masks: Record<number, number>
  /**
   * Corner rules over more than two terrains (a merged connected group) name
   * each tile's four corners directly, as an index into `terrains`, in place of a mask.
   */
  corners?: Record<number, CornerTerrains>
  raw: Record<string, unknown>
}

export interface GenericTileset {
  format: "pixelkiln-tileset"
  version: 1
  name: string
  style: string
  asset: string
  /** A merged group of connected sets: the assets it joins, in order. */
  sets?: string[]
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
    /** NW, NE, SW, SE as indexes into `rules.terrains`; set instead of `bitmask` on a merged group. */
    corners?: CornerTerrains
    stampOnly: boolean
  }>
  /** Complete provider object, even when its rule family is not normalized yet. */
  providerRules: Record<string, unknown> | null
  rules: NormalizedTileRules | null
}

export interface TilesetExport {
  png: Buffer
  extension: ".json" | ".tsj" | ".tres" | ".ldtk"
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

/** Build an atlas plus generic, Tiled TSJ, Godot 4 TileSet, or LDtk project metadata. */
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
    { name: `${spec.styleId}/${spec.assetId}`, style: spec.styleId, asset: spec.assetId },
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

  return renderTileset(generic, packed, spec.tileType, options)
}

/** Write the document for an engine format from a built generic tileset. */
function renderTileset(
  generic: GenericTileset,
  packed: { png: Buffer; sources: PackedSource[] },
  tileType: string | undefined,
  options: TilesetExportOptions,
): TilesetExport {
  if (options.format === "tiled") {
    return {
      png: packed.png,
      extension: ".tsj",
      document: JSON.stringify(buildTiled(generic), null, 2) + "\n",
      generic,
      sources: packed.sources,
    }
  }
  if (options.format === "ldtk") {
    return {
      png: packed.png,
      extension: ".ldtk",
      document: buildLdtk(generic, tileType),
      generic,
      sources: packed.sources,
    }
  }
  return {
    png: packed.png,
    extension: ".tres",
    document: buildGodot(generic, tileType),
    generic,
    sources: packed.sources,
  }
}

/**
 * Build one tileset from a connected group of terrain sets (`members` in the
 * order `connectedGroup` returns). Each terrain the sets share is one terrain
 * in the result, and every tile's corners are named in those terms, so an
 * engine paints with all of the group's terrains from one tileset.
 */
export function exportMergedTilesets(members: ConnectedMember[], options: TilesetExportOptions): TilesetExport {
  const merged = mergeConnectedTerrain(members, options.manifestDir)
  const packed = packSprites(
    merged.tiles.map((tile) => ({ id: tile.id, path: tile.path })),
    { columns: options.columns, order: "input" },
  )
  if (packed.skipped.length) {
    throw new Error(
      `Cannot export ${merged.assets.join(" + ")}: ` + packed.skipped.map((item) => `${item.id}: ${item.reason}`).join("; "),
    )
  }
  const rules: NormalizedTileRules = {
    ruleType: "corner",
    arity: 4,
    terrains: merged.terrains,
    masks: {},
    corners: Object.fromEntries(merged.tiles.map((tile, index) => [index, tile.corners])),
    raw: merged.providerRules,
  }
  const styleId = members[0]!.spec.styleId
  const asset = merged.assets.join("+")
  const generic = buildGeneric(
    { name: `${styleId}/${asset}`, style: styleId, asset, sets: merged.assets },
    options.imageName,
    packed.atlas,
    packed.atlas.frames,
    merged.providerRules,
    rules,
    new Map(merged.tiles.map((tile, index) => [tile.id, index] as const)),
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
  return renderTileset(generic, packed, merged.tileType, options)
}

function buildGeneric(
  identity: { name: string; style: string; asset: string; sets?: string[] },
  imageName: string,
  atlas: { sheet: { width: number; height: number }; cell: { width: number; height: number }; columns: number },
  frames: PackedFrame[],
  providerRules: Record<string, unknown> | null,
  rules: NormalizedTileRules | null,
  indexOf?: Map<string, number>,
): GenericTileset {
  return {
    format: "pixelkiln-tileset",
    version: 1,
    name: identity.name,
    style: identity.style,
    asset: identity.asset,
    ...(identity.sets ? { sets: identity.sets } : {}),
    image: imageName,
    tile: { ...atlas.cell },
    sheet: { ...atlas.sheet, columns: atlas.columns },
    tiles: frames.map((frame, index) => {
      const sourceIndex = indexOf?.get(frame.id) ?? tileIndex(frame.id) ?? index
      const corners = rules?.corners?.[sourceIndex]
      return {
        id: index,
        sourceIndex,
        role: frame.id,
        x: frame.x,
        y: frame.y,
        width: frame.width,
        height: frame.height,
        ...(rules?.masks[sourceIndex] !== undefined ? { bitmask: rules.masks[sourceIndex] } : {}),
        ...(corners ? { corners } : {}),
        stampOnly: rules ? rules.masks[sourceIndex] === undefined && !corners : true,
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
      color: terrainColor(index),
      tile: representativeTile(generic, index),
      probability: 1,
    })),
    properties: rules.connectivity
      ? [{ name: "pixelkiln:connectivity", type: "string", value: rules.connectivity }]
      : [],
    wangtiles: generic.tiles
      .filter((tile) => tile.bitmask !== undefined || tile.corners !== undefined)
      .map((tile) => ({ tileid: tile.id, wangid: tiledWangId(rules, tile) })),
  }]
  return tiled
}

function tiledWangId(rules: NormalizedTileRules, tile: GenericTileset["tiles"][number]): number[] {
  const corners = tileCorners(rules, tile)
  if (corners) {
    // Tiled colors count from 1. Its order: top edge, NE, right edge, SE, bottom edge, SW, left edge, NW.
    const [nw, ne, sw, se] = corners
    return [0, ne + 1, 0, se + 1, 0, sw + 1, 0, nw + 1]
  }
  const mask = tile.bitmask!
  const bitColor = (bit: number) => ((mask & (1 << bit)) !== 0 ? 1 : 2)
  // PixelLab edge mask: bit0=N bit1=E bit2=S bit3=W.
  return [bitColor(0), 0, bitColor(1), 0, bitColor(2), 0, bitColor(3), 0]
}

function buildGodot(generic: GenericTileset, tileType: string | undefined): string {
  const rules = generic.rules
  const shape = godotTileShape(tileType ?? "isometric")
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
    if (!rules || (tile.bitmask === undefined && tile.corners === undefined) || rules.ruleType === "outline") continue
    const values = godotTerrainBits(rules, tile, shape)
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
      lines.push(`terrain_set_0/terrain_${index}/color = ${godotColor(terrainColor(index))}`)
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
 * and against a shipped, hand-verified isometric Wang set (a downstream game's
 * terrain-tiles notes, §5: "Each of the 16 tiles was rendered, its four
 * diamond corners sampled for light-vs-dark, and checked against its mask").
 */
function godotTerrainBits(rules: NormalizedTileRules, tile: GenericTileset["tiles"][number], shape: number): Record<string, number> {
  const corners = tileCorners(rules, tile)
  if (corners) {
    const [nw, ne, sw, se] = corners
    if (shape === 1) {
      return { top_corner: nw, right_corner: ne, left_corner: sw, bottom_corner: se }
    }
    return { top_left_corner: nw, top_right_corner: ne, bottom_left_corner: sw, bottom_right_corner: se }
  }
  const mask = tile.bitmask!
  const terrain = (bit: number) => ((mask & (1 << bit)) !== 0 ? 0 : 1)
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

/** The terrain most of a tile's corners or sides carry; a tie goes to the lower-numbered one. */
function dominantTerrain(values: Record<string, number>): number {
  const counts = new Map<number, number>()
  for (const value of Object.values(values)) counts.set(value, (counts.get(value) ?? 0) + 1)
  let best = 0
  let bestCount = -1
  for (const [terrain, count] of [...counts].sort(([a], [b]) => a - b)) {
    if (count > bestCount) {
      best = terrain
      bestCount = count
    }
  }
  return best
}

function godotTileShape(tileType: string | undefined): number {
  if (tileType === "isometric" || tileType === "oblique") return 1
  if (tileType === "hex" || tileType === "hex_pointy") return 3
  return 0
}

function representativeTile(generic: GenericTileset, terrainIndex: number): number {
  const rules = generic.rules!
  if (rules.ruleType === "corner") {
    // The tile that is wholly this terrain.
    return generic.tiles.find((tile) => tileCorners(rules, tile)?.every((corner) => corner === terrainIndex))?.id ?? -1
  }
  const full = (1 << rules.arity) - 1
  const wanted = terrainIndex === 0 ? full : 0
  return generic.tiles.find((tile) => tile.bitmask === wanted)?.id ?? -1
}

function terrainNamesFor(rules: NormalizedTileRules): string[] {
  if (rules.terrains.length > 2) return rules.terrains
  return [rules.terrains[0] ?? "feature", rules.terrains[1] ?? "background"]
}

function godotColor(hex: string): string {
  const channel = (at: number) => Number((parseInt(hex.slice(at, at + 2), 16) / 255).toFixed(4))
  return `Color(${channel(1)}, ${channel(3)}, ${channel(5)}, 1)`
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
