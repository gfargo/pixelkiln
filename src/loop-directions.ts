/**
 * `animation.directions`: one loop declared for several directions.
 *
 * A loop is one asset per direction, and half of a full set is usually the
 * other half mirrored. The shorthand
 *
 *   "hero.walk": { "prompt": "walking", "animation": { "of": "hero", "directions": ["south", "west", "north"] } }
 *
 * expands, before the manifest is validated, into exactly what would
 * otherwise be written by hand: one loop per named direction
 * (`hero.walk.south`, `hero.walk.west`, `hero.walk.north`) and a mirror for
 * every direction whose flip is not named (`hero.walk.east`, mirroring
 * `hero.walk.west`). The expansion is pure JSON to JSON, so rewriting the
 * shorthand into explicit assets by hand leaves every identity unchanged.
 */
import { CharacterDirectionSchema, MIRRORED_DIRECTION, type CharacterDirection } from "./types.ts"

type RawAsset = Record<string, unknown>

export interface LoopExpansion {
  /** The manifest with every shorthand replaced by its expanded assets, in place. */
  raw: unknown
  /** Shorthand id → the asset ids it expanded into, loops first, then mirrors. */
  families: Record<string, string[]>
  /** Problems found, as `assets.<id>...: message` lines. Empty when the expansion is valid. */
  issues: string[]
}

/**
 * Fields that name exactly one output or one upstream object. Copying them
 * onto every expanded direction would point several assets at the same
 * file, cell, or remote object, so the shorthand refuses them.
 */
const SINGLE_OUTPUT_FIELDS = ["file", "cell", "remoteId", "source", "sourceByStyle", "outputRole"] as const

/** Fields a generated mirror inherits from its shorthand, so it lands beside its loops. */
const MIRROR_FIELDS = ["category", "tags", "styles"] as const

/** The id an expanded direction gets. */
export function loopDirectionId(shorthandId: string, direction: CharacterDirection): string {
  return `${shorthandId}.${direction}`
}

export function expandLoopDirections(raw: unknown): LoopExpansion {
  const families: Record<string, string[]> = {}
  const issues: string[] = []
  if (!isObject(raw) || !isObject(raw.assets)) return { raw, families, issues }
  const assets = raw.assets as Record<string, unknown>
  if (!Object.values(assets).some((asset) => isObject(asset) && isObject(asset.animation) && "directions" in asset.animation)) {
    return { raw, families, issues }
  }

  const expanded: Record<string, unknown> = {}
  const claimed = new Set(Object.keys(assets))
  for (const [id, asset] of Object.entries(assets)) {
    if (!isObject(asset) || !isObject(asset.animation) || !("directions" in asset.animation)) {
      expanded[id] = asset
      continue
    }
    const where = `assets.${id}.animation.directions`
    const { directions: rawDirections, ...animation } = asset.animation as RawAsset
    const parsed = CharacterDirectionSchema.array().min(1).safeParse(rawDirections)
    if (!parsed.success) {
      issues.push(`${where}: expected a non-empty list of directions (${CharacterDirectionSchema.options.join(", ")})`)
      continue
    }
    const directions = parsed.data
    const duplicate = directions.find((direction, index) => directions.indexOf(direction) !== index)
    if (duplicate) {
      issues.push(`${where}: "${duplicate}" is listed twice`)
      continue
    }
    if ("direction" in animation) {
      issues.push(`assets.${id}.animation: direction and directions are mutually exclusive; directions names every loop to make`)
      continue
    }
    const single = SINGLE_OUTPUT_FIELDS.filter((field) => field in asset)
    if (single.length) {
      issues.push(
        `assets.${id}: ${single.join(", ")} name${single.length === 1 ? "s" : ""} one output, but directions makes ` +
          `${directions.length} loops; declare the loops explicitly to set ${single.length === 1 ? "it" : "them"} per direction`,
      )
      continue
    }

    const loops = directions.map((direction) => ({ id: loopDirectionId(id, direction), direction }))
    const named = new Set<CharacterDirection>(directions)
    const mirrors: { id: string; of: string }[] = []
    for (const { id: loopId, direction } of loops) {
      const flipped = MIRRORED_DIRECTION[direction]
      if (flipped === direction || named.has(flipped)) continue
      named.add(flipped)
      mirrors.push({ id: loopDirectionId(id, flipped), of: loopId })
    }
    const ids = [...loops.map((loop) => loop.id), ...mirrors.map((mirror) => mirror.id)]
    const collision = ids.find((expandedId) => claimed.has(expandedId))
    if (collision) {
      issues.push(`${where}: expands to "${collision}", which is already declared`)
      continue
    }
    for (const expandedId of ids) claimed.add(expandedId)

    for (const loop of loops) {
      expanded[loop.id] = { ...asset, animation: { ...animation, direction: loop.direction } }
    }
    for (const mirror of mirrors) {
      const inherited: RawAsset = {}
      for (const field of MIRROR_FIELDS) if (field in asset) inherited[field] = asset[field]
      expanded[mirror.id] = { mirror: mirror.of, ...inherited }
    }
    families[id] = ids
  }
  return { raw: { ...raw, assets: expanded }, families, issues }
}

/**
 * `--only` accepts a shorthand id and means its whole family, since the
 * shorthand itself is not an asset; any other id passes through unchanged.
 */
export function expandAssetFilter(ids: readonly string[], families: Readonly<Record<string, string[]>> | undefined): string[] {
  if (!families) return [...ids]
  return [...new Set(ids.flatMap((id) => families[id] ?? [id]))]
}

/** The shorthand an expanded asset came from, or undefined for an asset the manifest declares itself. */
export function loopShorthandOf(assetId: string, families: Readonly<Record<string, string[]>> | undefined): string | undefined {
  if (!families) return undefined
  return Object.keys(families).find((id) => families[id]!.includes(assetId))
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
