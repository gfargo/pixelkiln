/**
 * A tileset as an LDtk project (https://ldtk.io, MIT).
 *
 * LDtk has no terrain or Wang-set concept. Its way to draw a border from
 * painted values is an IntGrid layer plus an auto-layer whose rules each name
 * a pattern of IntGrid values and the tile to draw when it matches. So the
 * export writes rules: one per distinct adjacency mask, with tiles that share
 * a mask listed in one rule (LDtk picks among them at random), plus a small
 * level already painted with the result.
 *
 * A corner set is a dual grid. A tile has a terrain on each of its four
 * corners, so the painted values live on the vertices between tiles: IntGrid
 * cell (i, j) is the vertex at the top-left corner of tile (i, j), and the
 * tile's rule reads that cell and the ones to its right and below. The IntGrid
 * layer is shifted half a tile so a painted square sits over the vertex it
 * sets. An edge set is read the way the Godot export reads it: the tile's own
 * cell and its four neighbours, with no shift.
 *
 * Rule matching follows LDtk's own `AutoLayerRuleDef.matches`
 * (src/electron.renderer/data/def/AutoLayerRuleDef.hx, MIT): a pattern cell
 * of 0 is ignored, a positive value must equal the grid's, a negative must
 * not. The field names and defaults follow `JSON_DOC.md` and the project
 * files in LDtk's `app/extraFiles/samples`, written for `jsonVersion` 1.5.3.
 * The rule fields are marked "only used by the editor" in LDtk's own docs.
 */
import { createHash } from "node:crypto"
import { terrainColor, tileCorners, type CornerTerrains } from "./connected-sets.ts"
import type { GenericTileset, NormalizedTileRules } from "./tileset-export.ts"

export const LDTK_JSON_VERSION = "1.5.3"

/** The IntGrid value painted for each terrain: the first terrain is 1, the second 2. */
const FIRST = 1
const SECOND = 2
/** The preview level, in tiles: bigger when a merged group has more borders to show. */
const DEMO_SIZE = { small: [12, 9], large: [16, 12] } as const

export interface LdtkRule {
  uid: number
  size: 3
  pattern: number[]
  tileRectsIds: number[][]
  outOfBoundsValue: number
  [field: string]: unknown
}

/** A pattern as LDtk's matcher reads it: 0 ignored, positive must equal, negative must not. */
export function ldtkRuleMatches(
  rule: Pick<LdtkRule, "size" | "pattern" | "outOfBoundsValue">,
  grid: { width: number; height: number; cells: number[] },
  cx: number,
  cy: number,
): boolean {
  const radius = Math.floor(rule.size / 2)
  for (let py = 0; py < rule.size; py++) {
    for (let px = 0; px < rule.size; px++) {
      const wanted = rule.pattern[px + py * rule.size]!
      if (wanted === 0) continue
      const x = cx + px - radius
      const y = cy + py - radius
      const inside = x >= 0 && y >= 0 && x < grid.width && y < grid.height
      const value = inside ? grid.cells[y * grid.width + x]! : rule.outOfBoundsValue
      if (wanted > 0 && value !== wanted) return false
      if (wanted < 0 && value === -wanted) return false
    }
  }
  return true
}

/** A deterministic identifier-shaped uuid, so the same tileset writes the same file. */
function iid(...parts: Array<string | number>): string {
  const hex = createHash("sha256").update(parts.join("\u0000")).digest("hex")
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`
}

/** An LDtk identifier: letters, digits and underscores, starting with a letter. */
function identifier(text: string, fallback: string): string {
  const slug = text.replace(/[^A-Za-z0-9]+/g, "_").replace(/^_+|_+$/g, "")
  return /^[A-Za-z]/.test(slug) ? slug : slug ? `${fallback}_${slug}` : fallback
}

function dominantValue(mask: number): number {
  const first = [0, 1, 2, 3].filter((bit) => (mask & (1 << bit)) !== 0).length
  return first * 2 >= 4 ? FIRST : SECOND
}

/** The 3x3 pattern for one adjacency mask (see the file comment for the geometry). */
export function ldtkPattern(rules: Pick<NormalizedTileRules, "ruleType">, mask: number): number[] {
  const value = (bit: number) => ((mask & (1 << bit)) !== 0 ? FIRST : SECOND)
  const pattern = new Array<number>(9).fill(0)
  if (rules.ruleType === "corner") {
    // NW, NE, SW, SE = bits 3, 2, 1, 0 sit on the cell, the cell to its right, below, and below-right.
    pattern[4] = value(3)
    pattern[5] = value(2)
    pattern[7] = value(1)
    pattern[8] = value(0)
    return pattern
  }
  // Edge masks: N, E, S, W = bits 0, 1, 2, 3, around the tile's own cell.
  pattern[4] = dominantValue(mask)
  pattern[1] = value(0)
  pattern[5] = value(1)
  pattern[7] = value(2)
  pattern[3] = value(3)
  return pattern
}

/** The pattern for a tile whose four corners are the given terrains (NW, NE, SW, SE). */
export function ldtkCornerPattern(corners: CornerTerrains): number[] {
  const pattern = new Array<number>(9).fill(0)
  pattern[4] = corners[0] + 1
  pattern[5] = corners[1] + 1
  pattern[7] = corners[2] + 1
  pattern[8] = corners[3] + 1
  return pattern
}

export interface LdtkLevelGrid {
  width: number
  height: number
  cells: number[]
}

/** The first rule that matches each cell, in rule order, as LDtk resolves an auto-layer. */
export function resolveLdtkTiles(
  rules: LdtkRule[],
  grid: LdtkLevelGrid,
): Array<{ cx: number; cy: number; rule: LdtkRule; tile: number }> {
  const out: Array<{ cx: number; cy: number; rule: LdtkRule; tile: number }> = []
  for (let cy = 0; cy < grid.height; cy++) {
    for (let cx = 0; cx < grid.width; cx++) {
      const rule = rules.find((candidate) => ldtkRuleMatches(candidate, grid, cx, cy))
      if (rule) out.push({ cx, cy, rule, tile: rule.tileRectsIds[(cx * 7 + cy * 13) % rule.tileRectsIds.length]![0]! })
    }
  }
  return out
}

/** A fixed pseudo-random painting, searched until it uses every mask the set has (or as many as it can). */
function demoGrid(rules: LdtkRule[], wanted: number, width: number, height: number): LdtkLevelGrid {
  let best: LdtkLevelGrid | null = null
  let bestCovered = -1
  for (let seed = 1; seed <= 400; seed++) {
    let state = seed * 2654435761 >>> 0
    const cells = Array.from({ length: width * height }, () => {
      state = (Math.imul(state, 1664525) + 1013904223) >>> 0
      return (state >>> 16) % 100 < 52 ? FIRST : SECOND
    })
    const grid = { width, height, cells }
    const covered = new Set(resolveLdtkTiles(rules, grid).map((hit) => hit.rule.uid)).size
    if (covered > bestCovered) {
      best = grid
      bestCovered = covered
    }
    if (covered >= wanted) break
  }
  return best!
}

/**
 * A painting for three or more terrains. Random values would put terrains
 * side by side that no tile joins (ocean against grass), so each vertex takes
 * only a value that leaves every tile around it one the set has, with the
 * level's outside counted as `outside`. Searched like `demoGrid`, for the
 * painting that uses the most rules.
 */
function constrainedDemoGrid(
  rules: LdtkRule[],
  combos: Set<string>,
  count: number,
  outside: number,
  width: number,
  height: number,
): LdtkLevelGrid {
  const stride = width + 1
  const comboList = [...combos].map((combo) => combo.split(",").map(Number))
  let best: LdtkLevelGrid | null = null
  let bestCovered = -1
  for (let seed = 1; seed <= 600; seed++) {
    let state = seed * 2654435761 >>> 0
    const random = () => {
      state = (Math.imul(state, 1664525) + 1013904223) >>> 0
      return (state >>> 8) / 0x1000000
    }
    // One vertex past the level on each side is the outside, fixed.
    const vertices = new Array<number>(stride * (height + 1)).fill(0)
    for (let x = 0; x <= width; x++) vertices[height * stride + x] = outside
    for (let y = 0; y <= height; y++) vertices[y * stride + width] = outside
    const at = (x: number, y: number) => vertices[y * stride + x]!
    /**
     * The tile at (x, y): its combination once its four vertices are painted,
     * null when no tile has the vertices painted so far, undefined while it is open.
     */
    const comboAt = (x: number, y: number): string | null | undefined => {
      if (x < 0 || y < 0 || x >= width || y >= height) return undefined
      const painted = [at(x, y), at(x + 1, y), at(x, y + 1), at(x + 1, y + 1)]
      if (!comboList.some((combo) => combo.every((terrain, corner) => !painted[corner] || painted[corner] === terrain + 1))) return null
      return painted.every(Boolean) ? painted.map((value) => value - 1).join(",") : undefined
    }
    const around = (x: number, y: number) => [comboAt(x - 1, y - 1), comboAt(x, y - 1), comboAt(x - 1, y), comboAt(x, y)]
    const seen = new Set<string>()
    let ok = true
    for (let y = 0; y < height && ok; y++) {
      for (let x = 0; x < width && ok; x++) {
        // Each value the tiles around this vertex allow, and how many tiles it would show for the first time.
        const options: Array<{ value: number; fresh: number }> = []
        for (let value = 1; value <= count; value++) {
          vertices[y * stride + x] = value
          const made = around(x, y)
          if (made.includes(null)) continue
          options.push({ value, fresh: made.filter((combo) => combo !== undefined && !seen.has(combo!)).length })
        }
        if (!options.length) {
          ok = false
          break
        }
        const best = Math.max(...options.map((option) => option.fresh))
        const pool = best > 0 && random() < 0.85 ? options.filter((option) => option.fresh === best) : options
        vertices[y * stride + x] = pool[Math.floor(random() * pool.length)]!.value
        for (const combo of around(x, y)) if (combo) seen.add(combo)
      }
    }
    if (!ok) continue
    const cells: number[] = []
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) cells.push(at(x, y))
    const grid = { width, height, cells }
    const covered = new Set(resolveLdtkTiles(rules, grid).map((hit) => hit.rule.uid)).size
    if (covered > bestCovered) {
      best = grid
      bestCovered = covered
    }
    if (covered >= rules.length) break
  }
  if (!best) throw new Error("ldtk export could not paint a preview level for these connected sets")
  return best
}

/** The tileset as an LDtk project: tileset, an IntGrid source layer, an auto-layer with the rules, and a painted preview level. */
export function buildLdtk(generic: GenericTileset, tileType: string | undefined): string {
  const rules = generic.rules
  if (!rules || rules.ruleType === "outline") {
    throw new Error("ldtk export needs recognized corner or edge adjacency rules; use --format generic")
  }
  if (tileType === undefined || tileType === "isometric" || tileType === "oblique" || tileType === "hex" || tileType === "hex_pointy") {
    throw new Error(
      `ldtk export needs square tiles on an orthogonal grid, and this set is ${tileType ?? "isometric"}; ` +
        "use --format generic or --format tiled",
    )
  }
  const grid = generic.tile.width
  if (generic.tile.width !== generic.tile.height) {
    throw new Error(`ldtk grids are square; these tiles are ${generic.tile.width}x${generic.tile.height}`)
  }
  const corner = rules.ruleType === "corner"
  // The project asks for the "Capitalize" identifier style, and LDtk rewrites
  // a layer or tileset name to match on load, which marks a fresh project unsaved.
  const base = identifier(generic.name.replace("/", "_"), "Tileset")
  const name = base.charAt(0).toUpperCase() + base.slice(1)
  const merged = rules.terrains.length > 2
  const terrainNames = merged ? rules.terrains : [rules.terrains[0] ?? "feature", rules.terrains[1] ?? "background"]
  const [demoWidth, demoHeight] = merged ? DEMO_SIZE.large : DEMO_SIZE.small
  const columns = generic.sheet.columns
  const rows = Math.ceil(generic.tiles.length / columns)

  // One rule per distinct adjacency; tiles that share one are alternatives in the same rule.
  const byAdjacency = new Map<string, { pattern: number[]; ids: number[] }>()
  for (const tile of generic.tiles) {
    const corners = corner ? tileCorners(rules, tile) : null
    if (corner ? !corners : tile.bitmask === undefined) continue
    const adjacency = corners ? corners.join(",") : String(tile.bitmask)
    const known = byAdjacency.get(adjacency)
    if (known) known.ids.push(tile.id)
    else byAdjacency.set(adjacency, { pattern: corners ? ldtkCornerPattern(corners) : ldtkPattern(rules, tile.bitmask!), ids: [tile.id] })
  }
  if (!byAdjacency.size) throw new Error("ldtk export found no tiles with adjacency rules; use --format generic")
  // Outside the level, a two-terrain set reads its second terrain and a merged group its first.
  const outside = merged ? FIRST : SECOND

  const tilesetUid = 1
  const sourceUid = 2
  const autoUid = 3
  const groupUid = 4
  const ruleList: LdtkRule[] = [...byAdjacency.values()].map(({ pattern, ids }, index) => ({
    uid: 5 + index,
    active: true,
    size: 3,
    tileRectsIds: ids.map((id) => [id]),
    alpha: 1,
    chance: 1,
    breakOnMatch: true,
    pattern,
    flipX: false,
    flipY: false,
    xModulo: 1,
    yModulo: 1,
    xOffset: 0,
    yOffset: 0,
    tileXOffset: 0,
    tileYOffset: 0,
    tileRandomXMin: 0,
    tileRandomXMax: 0,
    tileRandomYMin: 0,
    tileRandomYMax: 0,
    checker: "None",
    tileMode: "Single",
    pivotX: 0,
    pivotY: 0,
    outOfBoundsValue: outside,
    invalidated: false,
    perlinActive: false,
    perlinSeed: 1,
    perlinScale: 0.2,
    perlinOctaves: 2,
  }))
  const levelUid = 5 + ruleList.length
  const nextUid = levelUid + 1

  const tileRect = (id: number | undefined) => {
    const tile = generic.tiles.find((candidate) => candidate.id === id)
    return tile ? { tilesetUid, x: tile.x, y: tile.y, w: tile.width, h: tile.height } : null
  }
  const full = (1 << rules.arity) - 1
  const representative = (terrain: number) =>
    corner
      ? generic.tiles.find((tile) => tileCorners(rules, tile)?.every((value) => value === terrain))?.id
      : generic.tiles.find((tile) => tile.bitmask === (terrain === 0 ? full : 0))?.id
  const shift = corner ? -Math.floor(grid / 2) : 0
  const sourceName = `${name}_${corner ? "corners" : "cells"}`
  const paintList = terrainNames.map((terrainName, index) => `${terrainName} (${index + 1})`).join(", ")
  const autoName = name

  const layerBase = {
    guideGridWid: 0,
    guideGridHei: 0,
    displayOpacity: 1,
    inactiveOpacity: 1,
    hideInList: false,
    hideFieldsWhenInactive: false,
    canSelectWhenInactive: true,
    parallaxFactorX: 0,
    parallaxFactorY: 0,
    parallaxScaling: true,
    requiredTags: [],
    excludedTags: [],
    autoTilesKilledByOtherLayerUid: null,
    uiFilterTags: [],
    useAsyncRender: false,
    tilePivotX: 0,
    tilePivotY: 0,
    biomeFieldUid: null,
    gridSize: grid,
    tilesetDefUid: tilesetUid,
  }
  const sourceLayer = {
    __type: "IntGrid",
    identifier: sourceName,
    type: "IntGrid",
    uid: sourceUid,
    doc: `Paint ${paintList}. ` + (corner
      ? "Each cell is a corner where four tiles meet, so it is drawn half a tile up and left of the tiles it controls."
      : "Each tile looks at its own cell and the four around it."),
    uiColor: terrainColor(0).toUpperCase(),
    ...layerBase,
    renderInWorldView: true,
    pxOffsetX: shift,
    pxOffsetY: shift,
    intGridValues: terrainNames.map((terrainName, index) => ({
      value: index + 1,
      identifier: identifier(terrainName, `terrain${index + 1}`),
      color: terrainColor(index).toUpperCase(),
      tile: tileRect(representative(index)),
      groupUid: 0,
    })),
    intGridValuesGroups: [],
    autoRuleGroups: [],
    autoSourceLayerDefUid: null,
  }
  const autoLayer = {
    __type: "AutoLayer",
    identifier: autoName,
    type: "AutoLayer",
    uid: autoUid,
    doc: `Drawn by rules from ${sourceName}: one rule for each way the ${merged ? "terrains" : "two terrains"} can meet.`,
    uiColor: terrainColor(1).toUpperCase(),
    ...layerBase,
    renderInWorldView: true,
    pxOffsetX: 0,
    pxOffsetY: 0,
    intGridValues: [],
    intGridValuesGroups: [],
    autoRuleGroups: [{
      uid: groupUid,
      name: "Borders",
      color: null,
      icon: null,
      active: true,
      isOptional: false,
      rules: ruleList,
      usesWizard: false,
      requiredBiomeValues: [],
      biomeRequirementMode: 0,
    }],
    autoSourceLayerDefUid: sourceUid,
  }

  const level = merged
    ? constrainedDemoGrid(
        ruleList,
        new Set(generic.tiles.flatMap((tile) => (tile.corners ? [tile.corners.join(",")] : []))),
        terrainNames.length,
        outside,
        demoWidth,
        demoHeight,
      )
    : demoGrid(ruleList, ruleList.length, demoWidth, demoHeight)
  const hits = resolveLdtkTiles(ruleList, level)
  const tileAt = (id: number) => ({ x: (id % columns) * grid, y: Math.floor(id / columns) * grid })
  const instanceBase = (layerDef: { identifier: string; uid: number; __type: string }, offset: number) => ({
    __identifier: layerDef.identifier,
    __type: layerDef.__type,
    __cWid: demoWidth,
    __cHei: demoHeight,
    __gridSize: grid,
    __opacity: 1,
    __pxTotalOffsetX: offset,
    __pxTotalOffsetY: offset,
    __tilesetDefUid: tilesetUid,
    __tilesetRelPath: generic.image,
    iid: iid(generic.name, "layer", layerDef.uid),
    levelId: levelUid,
    layerDefUid: layerDef.uid,
    pxOffsetX: 0,
    pxOffsetY: 0,
    visible: true,
    optionalRules: [],
    seed: 1000 + layerDef.uid,
    overrideTilesetUid: null,
    gridTiles: [],
    entityInstances: [],
  })

  const project = {
    __header__: {
      fileType: "LDtk Project JSON",
      app: "LDtk",
      doc: "https://ldtk.io/json",
      schema: "https://ldtk.io/files/JSON_SCHEMA.json",
      appAuthor: "Sebastien 'deepnight' Benard",
      appVersion: LDTK_JSON_VERSION,
      url: "https://ldtk.io",
    },
    iid: iid(generic.name, "project"),
    jsonVersion: LDTK_JSON_VERSION,
    appBuildId: 473702,
    nextUid,
    identifierStyle: "Capitalize",
    toc: [],
    worldLayout: "LinearHorizontal",
    worldGridWidth: 256,
    worldGridHeight: 256,
    defaultLevelWidth: demoWidth * grid,
    defaultLevelHeight: demoHeight * grid,
    defaultPivotX: 0,
    defaultPivotY: 0,
    defaultGridSize: grid,
    defaultEntityWidth: grid,
    defaultEntityHeight: grid,
    bgColor: "#4A5066",
    defaultLevelBgColor: "#474B67",
    minifyJson: false,
    externalLevels: false,
    exportTiled: false,
    simplifiedExport: false,
    imageExportMode: "None",
    exportLevelBg: true,
    pngFilePattern: null,
    backupOnSave: false,
    backupLimit: 10,
    backupRelPath: null,
    levelNamePattern: "%world_Level_%idx",
    tutorialDesc: null,
    customCommands: [],
    flags: ["ExportOldTableOfContentData", "UseMultilinesType"],
    defs: {
      layers: [autoLayer, sourceLayer],
      entities: [],
      tilesets: [{
        __cWid: columns,
        __cHei: rows,
        identifier: `${name}_tiles`,
        uid: tilesetUid,
        relPath: generic.image,
        embedAtlas: null,
        pxWid: generic.sheet.width,
        pxHei: generic.sheet.height,
        tileGridSize: grid,
        spacing: 0,
        padding: 0,
        tags: [],
        tagsSourceEnumUid: null,
        enumTags: [],
        customData: generic.tiles
          .filter((tile) => tile.bitmask !== undefined || tile.corners !== undefined)
          .map((tile) => ({ tileId: tile.id, data: tile.corners ? `corners=${tile.corners.join(",")}` : `mask=${tile.bitmask}` })),
        savedSelections: [],
        cachedPixelData: null,
      }],
      enums: [],
      externalEnums: [],
      levelFields: [],
    },
    levels: [{
      identifier: "Preview",
      iid: iid(generic.name, "level"),
      uid: levelUid,
      // A linear world ignores the position; LDtk itself writes -1 for it.
      worldX: -1,
      worldY: -1,
      worldDepth: 0,
      pxWid: demoWidth * grid,
      pxHei: demoHeight * grid,
      __bgColor: "#474B67",
      bgColor: null,
      useAutoIdentifier: false,
      bgRelPath: null,
      bgPos: null,
      bgPivotX: 0.5,
      bgPivotY: 0.5,
      __smartColor: "#9A9CAB",
      __bgPos: null,
      externalRelPath: null,
      fieldInstances: [],
      layerInstances: [
        {
          ...instanceBase(autoLayer, 0),
          intGridCsv: [],
          autoLayerTiles: hits.map((hit) => ({
            px: [hit.cx * grid, hit.cy * grid],
            src: [tileAt(hit.tile).x, tileAt(hit.tile).y],
            f: 0,
            t: hit.tile,
            d: [hit.rule.uid, hit.cy * demoWidth + hit.cx],
            a: 1,
          })),
        },
        {
          ...instanceBase(sourceLayer, shift),
          intGridCsv: level.cells,
          autoLayerTiles: [],
        },
      ],
      __neighbours: [],
    }],
    worlds: [],
    dummyWorldIid: iid(generic.name, "world"),
  }
  return JSON.stringify(project, null, 2) + "\n"
}
