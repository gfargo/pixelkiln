/**
 * Write the tile lookups the /tiles terrain brush uses.
 *
 * The brush paints the corners (or, for a road, the cells) of a map and every
 * tile picks itself from the rules PixelLab returned with the images. This reads
 * those rules from the repo's own locks and writes one lookup per set into
 * website/app/lib/brush-tilesets.ts, so a set on the page and its brush cannot
 * drift apart. Run it after changing a lock or the list below:
 *
 *   npx tsx scripts/gen-brush-tilesets.ts
 */
import { mkdtemp, readFile, writeFile } from "node:fs/promises"
import { existsSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { parseArgs } from "../src/cli/args.ts"
import { runExport } from "../src/cli/commands/pack.ts"
import { decodePng } from "../src/png.ts"

const site = path.resolve("website")
type Corner = "lower" | "upper" | "transition"

interface SetSpec {
  id: string
  name: string
  blurb: string
  art: string
  /** The terrain assets that make the set, with the group terrain each of its corners becomes. */
  members: Array<{ key: string; map: Partial<Record<Corner, number>> }>
  terrains: string[]
  /** Isometric sets get their diamond from an export; roads paint cells, not corners. */
  iso?: { style: string; asset: string }
  mode?: "corner" | "edge"
}

const SETS: SetSpec[] = [
  {
    id: "coast", name: "Coast", art: "pixellab-0.4.130",
    blurb: "Ocean to sand, then sand to grass: two connected sets as one brush.",
    terrains: ["Ocean", "Sand", "Grass"],
    members: [
      { key: "coast/ocean-sand", map: { lower: 0, upper: 1 } },
      { key: "coast/sand-grass", map: { lower: 1, upper: 2 } },
    ],
  },
  {
    id: "lake", name: "Lake", art: "pixellab-0.4.130",
    blurb: "Calm water against short grass.",
    terrains: ["Water", "Grass"],
    members: [{ key: "paths/lake-grass", map: { lower: 0, upper: 1 } }],
  },
  {
    id: "marsh", name: "Marsh", art: "pixellab-0.4.130",
    blurb: "Murky swamp water against marsh grass.",
    terrains: ["Swamp water", "Marsh grass"],
    members: [{ key: "marsh/swamp-marsh", map: { lower: 0, upper: 1 } }],
  },
  {
    id: "path", name: "Dirt path", art: "pixellab-0.4.130",
    blurb: "A plain dirt path across grass.",
    terrains: ["Dirt", "Grass"],
    members: [{ key: "paths/path-grass", map: { lower: 0, upper: 1 } }],
  },
  {
    id: "lava", name: "Dungeon", art: "pixellab-0.4.130",
    blurb: "Stone floor raised above lava: where the floor ends on its south side, the 25-tile set draws a brick wall.",
    terrains: ["Lava", "Stone floor"],
    // The brick wall is drawn where lava would be, so its corners count as lava.
    members: [{ key: "dungeon/lava-floor", map: { lower: 0, transition: 0, upper: 1 } }],
  },
  {
    id: "iso-ground", name: "Isometric ground", art: "pixellab-isometric",
    blurb: "Grass and cobblestone slabs on a diamond grid.",
    terrains: ["Grass", "Cobblestone"],
    members: [{ key: "ground/grass-cobble", map: {} }],
    iso: { style: "ground", asset: "grass-cobble" },
  },
  {
    id: "iso-road", name: "Isometric road", art: "pixellab-isometric", mode: "edge",
    blurb: "A dirt road over grass. Click cells: each tile reads which of its four sides the road crosses.",
    terrains: ["Road", "Grass"],
    members: [{ key: "paths/dirt-road", map: {} }],
    iso: { style: "paths", asset: "dirt-road" },
  },
]

const TINT_FALLBACK = ["#2f86d6", "#f0cf7a", "#7fc04a"]

function publicUrl(file: string): string {
  const at = file.split(path.sep).join("/").indexOf("/public/")
  return file.split(path.sep).join("/").slice(at + "/public".length)
}

/** The mean colour of the middle of a tile image: what the terrain looks like in the dots and swatches. */
async function meanColor(file: string, box?: { x: number; y: number; width: number; height: number }): Promise<string> {
  const png = decodePng(await readFile(file))
  const region = box ?? { x: 0, y: 0, width: png.width, height: png.height }
  const x0 = Math.round(region.x + region.width * 0.3)
  const x1 = Math.round(region.x + region.width * 0.7)
  const y0 = Math.round(region.y + region.height * 0.3)
  const y1 = Math.round(region.y + region.height * 0.7)
  let r = 0, g = 0, b = 0, n = 0
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const at = (y * png.width + x) * 4
      if (png.pixels[at + 3]! < 200) continue
      r += png.pixels[at]!; g += png.pixels[at + 1]!; b += png.pixels[at + 2]!; n++
    }
  }
  const hex = (v: number) => Math.round(n ? v / n : 128).toString(16).padStart(2, "0")
  return `#${hex(r)}${hex(g)}${hex(b)}`
}

const tmp = await mkdtemp(path.join(tmpdir(), "brush-sets-"))
const out: unknown[] = []

for (const spec of SETS) {
  const artDir = path.join(site, "art", spec.art)
  const lock = JSON.parse(await readFile(path.join(artDir, "pixelkiln.lock.json"), "utf8"))
  const entries = lock.entries ?? lock
  const tiles: Record<string, string> = {}
  const files: Record<string, string> = {}   // key -> absolute file, for colours
  let tile = { w: 0, h: 0 }

  for (const member of spec.members) {
    const entry = entries[member.key]
    if (!entry) throw new Error(`${spec.id}: no lock entry ${member.key}`)
    const meta = entry.providerMetadata?.pixellab ?? {}
    const outputs: Array<{ path: string; role?: string }> = entry.outputs
    const absolute = (output: { path: string }) => path.resolve(artDir, output.path)

    if (Array.isArray(meta.terrainTiles)) {
      for (const t of meta.terrainTiles as Array<{ role: string; corners: Record<string, Corner> }>) {
        const output = outputs.find((candidate) => candidate.role === t.role)
        if (!output) throw new Error(`${spec.id}: no output for ${t.role}`)
        const corner = (name: string) => member.map[t.corners[name] as Corner]
        const parts = ["NW", "NE", "SW", "SE"].map(corner)
        if (parts.some((p) => p === undefined)) throw new Error(`${spec.id}: ${t.role} has a corner with no terrain`)
        const key = parts.join(",")
        if (!tiles[key]) { tiles[key] = publicUrl(absolute(output)); files[key] = absolute(output) }
      }
    } else if (meta.tileRules?.tiles) {
      const rules = meta.tileRules as { rule_type: string; tiles: Record<string, number | { mask?: number; bitmask?: number }> }
      for (const [name, value] of Object.entries(rules.tiles)) {
        const index = Number(name.match(/(\d+)$/)![1])
        const mask = typeof value === "number" ? value : value.mask ?? value.bitmask
        if (mask === undefined) continue
        const output = outputs[index]
        if (!output) continue
        let key: string
        if (rules.rule_type === "corner") {
          const c = (bit: number) => ((mask & (1 << bit)) !== 0 ? 0 : 1)
          key = [c(3), c(2), c(1), c(0)].join(",")
        } else {
          key = String(mask)   // N, E, S, W are bits 0, 1, 2, 3; a set bit is the road
        }
        if (!tiles[key]) { tiles[key] = publicUrl(absolute(output)); files[key] = absolute(output) }
      }
      // A road set also draws a solid slab of road that no mask names: a lone cell of road uses it.
      if (rules.rule_type === "edge") {
        const named = new Set(Object.keys(rules.tiles).map((name) => Number(name.match(/(\d+)$/)![1])))
        const solid = outputs.findIndex((_, index) => !named.has(index))
        if (solid >= 0) { tiles.solid = publicUrl(absolute(outputs[solid]!)); files.solid = absolute(outputs[solid]!) }
      }
    }
    if (!tile.w) {
      const first = decodePng(await readFile(absolute(outputs[0]!)))
      tile = { w: first.width, h: first.height }
    }
  }

  let iso: { fw: number; fh: number; fx: number; fy: number } | null = null
  if (spec.iso) {
    const base = path.join(tmp, spec.id)
    await runExport(parseArgs([
      "export", "--manifest", path.join(artDir, "pixelkiln.manifest.json"), "--lock", path.join(artDir, "pixelkiln.lock.json"),
      "--style", spec.iso.style, "--only", spec.iso.asset, "--format", "generic", "--out", base,
    ]))
    const generic = JSON.parse(await readFile(`${base}.json`, "utf8"))
    if (!generic.footprint) throw new Error(`${spec.id}: no diamond found`)
    iso = { fw: generic.footprint.width, fh: generic.footprint.height, fx: generic.footprint.x, fy: generic.footprint.y }
  }

  const colors: string[] = []
  const diamond = iso ? { x: iso.fx, y: iso.fy, width: iso.fw, height: iso.fh } : undefined
  for (const [index] of spec.terrains.entries()) {
    const pure = spec.mode === "edge"
      ? (index === 0 ? tiles.solid : tiles["0"])
      : tiles[[index, index, index, index].join(",")]
    const file = pure ? files[Object.keys(tiles).find((k) => tiles[k] === pure)!] : undefined
    colors.push(file ? await meanColor(file, diamond) : TINT_FALLBACK[index % 3]!)
  }
  for (const url of Object.values(tiles)) {
    if (!existsSync(path.join(site, "public", url))) throw new Error(`${spec.id}: ${url} is not in website/public`)
  }

  out.push({
    id: spec.id, name: spec.name, blurb: spec.blurb, mode: spec.mode ?? "corner", iso, tile,
    terrains: spec.terrains.map((label, index) => ({ label, color: colors[index] })),
    tiles,
  })
}

const header = `/**
 * The tiles of each set the /tiles terrain brush paints with, by the terrain on
 * each corner ("NW,NE,SW,SE", as an index into the set's terrains) or, for a road,
 * by the sides it crosses (a number: N, E, S, W are bits 0, 1, 2, 3).
 *
 * Generated by scripts/gen-brush-tilesets.ts from the repo's own locks. Do not edit.
 */
export interface BrushTerrain {
  label: string;
  color: string;
}

export interface BrushSet {
  id: string;
  name: string;
  blurb: string;
  /** A corner set paints corners; an edge set (a road) paints cells. */
  mode: "corner" | "edge";
  /** The ground diamond in an isometric tile image, or null for a square tile. */
  iso: { fw: number; fh: number; fx: number; fy: number } | null;
  tile: { w: number; h: number };
  terrains: BrushTerrain[];
  tiles: Record<string, string>;
}

export const BRUSH_SETS: BrushSet[] = `
await writeFile(path.join(site, "app/lib/brush-tilesets.ts"), `${header}${JSON.stringify(out, null, 2)};\n`)
for (const set of out as Array<{ id: string; tiles: Record<string, string>; terrains: unknown[]; tile: unknown }>) {
  console.log(`${set.id}: ${Object.keys(set.tiles).length} tiles, ${set.terrains.length} terrains, tile ${JSON.stringify(set.tile)}`)
}
