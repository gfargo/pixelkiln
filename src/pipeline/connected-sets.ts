/**
 * Connected terrain sets as one tileset.
 *
 * A `terrain` asset can share a terrain with another set in its style
 * (`connect`): a coast draws ocean against sand, and a meadow set draws that
 * same sand against grass. Each set still ships 16 or 25 tiles with two
 * terrains each, but across the group there are three terrains, and an engine
 * that paints with a terrain brush wants all three in one place.
 *
 * This works out the group, which terrain in one set is which terrain in
 * another, and each tile's four corners in group terms. The exporters then
 * write the group as a single tileset with N terrains.
 */
import { parseTerrainDescriptions, type LockEntry, type ResolvedSpec, type TerrainSide } from "../types.ts"
import { resolveSpecEntryOutputs, sourceIsStem, sourceOutputPath } from "../outputs.ts"

/** A terrain per corner, in NW, NE, SW, SE order, as an index into the group's terrains. */
export type CornerTerrains = [number, number, number, number]

export interface ConnectedMember {
  spec: ResolvedSpec
  entry: LockEntry
}

export interface MergedTile {
  /** `<asset>/<role>`: unique across the group. */
  id: string
  assetId: string
  path: string
  corners: CornerTerrains
}

export interface MergedTerrain {
  /** The group's assets in dependency order: a set follows every set it connects to. */
  assets: string[]
  /** Group terrain names, in the order the group numbers them. */
  terrains: string[]
  tiles: MergedTile[]
  tileType: string | undefined
  /** Each set's own terrain names and tiles, as PixelLab returned them. */
  providerRules: Record<string, unknown>
}

const key = (spec: Pick<ResolvedSpec, "styleId" | "assetId">) => `${spec.styleId}/${spec.assetId}`
const SIDES: TerrainSide[] = ["lower", "upper"]

/**
 * Every set linked to `start` through `connect`, in either direction, in
 * dependency order (a set after each set it connects to, ties by asset id).
 * A set with no links is a group of one.
 */
export function connectedGroup(start: ResolvedSpec, specs: ResolvedSpec[]): ResolvedSpec[] {
  const byKey = new Map(specs.map((spec) => [key(spec), spec] as const))
  const neighbours = new Map<string, Set<string>>()
  const link = (a: string, b: string) => {
    if (!neighbours.has(a)) neighbours.set(a, new Set())
    neighbours.get(a)!.add(b)
  }
  for (const spec of specs) {
    for (const side of SIDES) {
      const other = spec.terrainConnect?.[side]
      if (!other) continue
      link(key(spec), key(other.spec))
      link(key(other.spec), key(spec))
    }
  }
  const seen = new Set<string>()
  const queue = [key(start)]
  while (queue.length) {
    const next = queue.pop()!
    if (seen.has(next)) continue
    seen.add(next)
    for (const other of neighbours.get(next) ?? []) queue.push(other)
  }
  const members = [...seen]
    .map((id) => byKey.get(id))
    .filter((spec): spec is ResolvedSpec => spec !== undefined)
    .sort((a, b) => a.assetId.localeCompare(b.assetId))

  // A set goes after the sets it connects to.
  const ordered: ResolvedSpec[] = []
  const placed = new Set<string>()
  const place = (spec: ResolvedSpec) => {
    if (placed.has(key(spec))) return
    placed.add(key(spec))
    for (const side of SIDES) {
      const other = spec.terrainConnect?.[side]
      const parent = other ? byKey.get(key(other.spec)) : undefined
      if (parent) place(parent)
    }
    ordered.push(spec)
  }
  for (const spec of members) place(spec)
  return ordered
}

/** The first clause of a terrain's description, short enough to be a name in an editor. */
function describe(prompt: string | undefined, side: TerrainSide): string | undefined {
  const parsed = prompt ? parseTerrainDescriptions(prompt) : null
  const text = parsed?.[side]
  if (!text) return undefined
  const clause = text.split(/[,;.]/)[0]!.replace(/\s+/g, " ").trim().toLowerCase()
  return clause ? clause.slice(0, 32).trim() : undefined
}

/** Which of a set's two terrains a corner name is: its first terrain is the lower one. */
function sideOf(name: string, terrainTypes: string[]): TerrainSide {
  const index = terrainTypes.indexOf(name)
  if (index === 0) return "lower"
  if (index === 1) return "upper"
  // The ring PixelLab draws between two terrains folds into the second, as in a single set.
  if (name === "transition") return "upper"
  throw new Error(`a tile corner is "${name}", which is not one of the set's terrains (${terrainTypes.join(", ")})`)
}

/**
 * Work out one tileset from a connected group. `members` are the group's
 * sets with their lock entries, in dependency order (see `connectedGroup`).
 */
export function mergeConnectedTerrain(members: ConnectedMember[], manifestDir: string): MergedTerrain {
  const ids = members.map((member) => member.spec.assetId)
  if (members.length < 2) throw new Error("a connected tileset needs at least two sets")
  for (const { spec } of members) {
    if (spec.terrainOrientation === "sidescroller") {
      throw new Error(
        `${key(spec)} is a sidescroller set, which connects only its platform; ` +
          "export it on its own, without --merge-connected",
      )
    }
  }
  const tileTypes = new Set(members.map((member) => member.spec.tileType ?? ""))
  if (tileTypes.size > 1) {
    throw new Error(`connected sets ${ids.join(", ")} use different tile shapes; export them one at a time`)
  }

  // Terrains that connect are one terrain: union the two sides each link joins.
  const parent = new Map<string, string>()
  const find = (node: string): string => {
    if (!parent.has(node)) parent.set(node, node)
    const above = parent.get(node)!
    if (above === node) return node
    const root = find(above)
    parent.set(node, root)
    return root
  }
  const nodeOf = (assetId: string, side: TerrainSide) => `${assetId}:${side}`
  for (const { spec } of members) {
    for (const side of SIDES) {
      const other = spec.terrainConnect?.[side]
      if (other) parent.set(find(nodeOf(spec.assetId, side)), find(nodeOf(other.assetId, other.terrain)))
    }
  }

  // Number terrains in the order the group meets them; name each from the set that defines it.
  const indexOfClass = new Map<string, number>()
  const names: string[] = []
  const taken = new Set<string>()
  const defining = new Map<string, string>()
  for (const { spec } of members) {
    for (const side of SIDES) {
      const root = find(nodeOf(spec.assetId, side))
      if (!indexOfClass.has(root)) {
        indexOfClass.set(root, names.length)
        names.push("")
      }
      // The set that does not borrow this terrain is the one that describes it.
      if (!spec.terrainConnect?.[side] && !defining.has(root)) defining.set(root, nodeOf(spec.assetId, side))
    }
  }
  for (const [root, index] of indexOfClass) {
    const node = defining.get(root) ?? root
    const [assetId, side] = node.split(":") as [string, TerrainSide]
    const member = members.find((candidate) => candidate.spec.assetId === assetId)!
    const base = describe(member.spec.prompt, side) ?? `${assetId}_${side}`
    let name = base
    for (let n = 2; taken.has(name); n++) name = `${base} ${n}`
    taken.add(name)
    names[index] = name
  }

  const tiles: MergedTile[] = []
  const providerRules: Record<string, unknown> = {}
  for (const { spec, entry } of members) {
    const metadata = entry.providerMetadata?.[entry.provider] as Record<string, unknown> | undefined
    const terrainTypes = Array.isArray(metadata?.terrainTypes)
      ? (metadata!.terrainTypes as unknown[]).filter((item): item is string => typeof item === "string")
      : []
    const terrainTiles = Array.isArray(metadata?.terrainTiles) ? (metadata!.terrainTiles as unknown[]) : []
    if (terrainTypes.length < 2 || !terrainTiles.length) {
      throw new Error(`${key(spec)} has no terrain tile data; regenerate it before merging`)
    }
    providerRules[spec.assetId] = metadata
    let outputs = resolveSpecEntryOutputs(entry, spec)
    if (!outputs.length) throw new Error(`${key(spec)} has no downloaded outputs`)
    if (spec.source && sourceIsStem(spec.source, entry, manifestDir)) {
      outputs = outputs.map((output) => ({ ...output, absolutePath: sourceOutputPath(spec.source!, entry, output.index, manifestDir) }))
    }
    for (const output of outputs) {
      const tile = (output.role ? terrainTiles.find((item) => isRecord(item) && item.role === output.role) : undefined) ??
        terrainTiles[output.index]
      if (!isRecord(tile) || !isRecord(tile.corners)) continue
      const corner = (position: string): number => {
        const name = tile.corners && (tile.corners as Record<string, unknown>)[position]
        if (typeof name !== "string") throw new Error(`${key(spec)}: ${output.role ?? output.index} has no ${position} corner`)
        return indexOfClass.get(find(nodeOf(spec.assetId, sideOf(name, terrainTypes))))!
      }
      tiles.push({
        id: `${spec.assetId}/${output.role ?? `tile-${String(output.index).padStart(2, "0")}`}`,
        assetId: spec.assetId,
        path: output.absolutePath,
        corners: [corner("NW"), corner("NE"), corner("SW"), corner("SE")],
      })
    }
  }
  if (!tiles.length) throw new Error(`connected sets ${ids.join(", ")} have no tiles with corner data`)
  return { assets: ids, terrains: names, tiles, tileType: members[0]!.spec.tileType, providerRules }
}

/**
 * A tile's four corners as terrain indexes (NW, NE, SW, SE). A two-terrain
 * mask reads the way the docs say: a set bit is the first terrain. Edge rules have none.
 */
export function tileCorners(
  rules: { ruleType: string },
  tile: { bitmask?: number; corners?: CornerTerrains },
): CornerTerrains | null {
  if (tile.corners) return tile.corners
  if (rules.ruleType !== "corner" || tile.bitmask === undefined) return null
  const mask = tile.bitmask
  const corner = (bit: number) => ((mask & (1 << bit)) !== 0 ? 0 : 1)
  return [corner(3), corner(2), corner(1), corner(0)]
}

/** Editor colors for terrains, in order; the first two are the ones every two-terrain set has used. */
const TERRAIN_PALETTE = ["#5ab552", "#4c78a8", "#e0a458", "#a0522d", "#9b6bd1", "#d9534f", "#4fb8b8", "#8c8c8c"]
export const terrainColor = (index: number): string => TERRAIN_PALETTE[index % TERRAIN_PALETTE.length]!

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
