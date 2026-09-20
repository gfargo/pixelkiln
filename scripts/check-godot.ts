/**
 * Open PixelKiln's Godot output in Godot.
 *
 * `pack --format godot` writes a SpriteFrames resource and `export --format
 * godot` a TileSet, and the unit tests check the text of both against what
 * Godot's own editor writes. This puts them in a Godot project and asks a
 * headless Godot to load them and say what it sees: animation names, frame
 * counts, speeds, loops, texture sizes, atlas tiles, terrain sets. The
 * result is what a game would get, not what the writer meant.
 *
 * Needs a Godot 4 binary: set GODOT, or the macOS app bundle is used.
 * Without one it skips, unless CI is set, in which case it fails.
 */
import { execFile } from "node:child_process"
import { existsSync } from "node:fs"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { promisify } from "node:util"
import { packStyle } from "../src/pipeline/pack.ts"
import { renderGodotSpriteFrames } from "../src/pipeline/sheet-formats.ts"
import { exportTileset } from "../src/pipeline/tileset-export.ts"
import { encodeRgbaPng } from "../src/png.ts"
import type { Lock, LockEntry, ResolvedSpec } from "../src/types.ts"

const execFileAsync = promisify(execFile)

const godot = [process.env.GODOT, "/Applications/Godot.app/Contents/MacOS/Godot", "/usr/local/bin/godot", "/usr/bin/godot"]
  .filter((candidate): candidate is string => Boolean(candidate))
  .find((candidate) => existsSync(candidate))
if (!godot) {
  const message = "godot check: no Godot found; set GODOT to a Godot 4 binary"
  if (process.env.CI) {
    console.error(message)
    process.exit(1)
  }
  console.log(`${message} (skipped)`)
  process.exit(0)
}

const dir = await mkdtemp(path.join(tmpdir(), "pixelkiln-godot-"))
const art = path.join(dir, "art")
await mkdir(art, { recursive: true })
const px = (n: number, shade: number) => {
  const rgba = Buffer.alloc(n * n * 4, shade)
  for (let i = 3; i < rgba.length; i += 4) rgba[i] = 255
  return encodeRgbaPng(n, n, rgba)
}

// A cast: a 4-direction base and a 6-frame loop, as pack would find them.
const outputs: Record<string, LockEntry["outputs"]> = { hero: [], "hero.walk": [] }
for (const direction of ["south", "west", "east", "north"]) {
  await writeFile(path.join(art, `hero-${direction}.png`), px(16, 40))
  outputs.hero!.push({ path: `art/hero-${direction}.png`, sha256: "x", role: direction })
}
for (let i = 0; i < 6; i++) {
  await writeFile(path.join(art, `hero.walk-frame-0${i}.png`), px(16, 80 + i * 10))
  outputs["hero.walk"]!.push({ path: `art/hero.walk-frame-0${i}.png`, sha256: "x", role: `frame-0${i}` })
}
const lock = { version: 2, entries: {
  "cast/hero": { status: "downloaded", generator: "character", provider: "pixellab", outputs: outputs.hero },
  "cast/hero.walk": { status: "downloaded", generator: "character", provider: "pixellab", outputs: outputs["hero.walk"], providerMetadata: { pixellab: { frameSet: { fps: 12, count: 6 } } } },
} } as unknown as Lock
const sheet = packStyle(lock, "cast", dir)
await writeFile(path.join(dir, "cast-sheet.png"), sheet.png)
await writeFile(path.join(dir, "cast-sheet.tres"), renderGodotSpriteFrames(sheet.atlas, { imageName: "cast-sheet.png" }))

// A connectable tile set with the fixture's corner rules.
const rules = JSON.parse(await readFile(path.resolve("test/fixtures/tileset/tile-rules.json"), "utf8"))
const tiles: LockEntry["outputs"] = []
for (let index = 0; index < 4; index++) {
  const file = path.join(dir, `terrain-tile-0${index}.png`)
  await writeFile(file, px(8, 60 + index * 30))
  tiles.push({ path: file, sha256: String(index), role: `tile-0${index}` })
}
const tileset = exportTileset(
  { outputs: tiles, provider: "pixellab", providerMetadata: { pixellab: { tileKind: "tileset", tileRules: rules } } } as LockEntry,
  { root: dir, styleId: "ground", assetId: "terrain", generator: "tiles", outFile: path.join(dir, "terrain.png"), tileType: "square_topdown" } as ResolvedSpec,
  { format: "godot", manifestDir: dir, imageName: "terrain-tileset.png", columns: 2 },
)
await writeFile(path.join(dir, "terrain-tileset.png"), tileset.png)
await writeFile(path.join(dir, "terrain-tileset.tres"), tileset.document)

// The `terrain` generator's own tileset shape: per-tile `corners` rather than
// a `tileRules` bitmask map. Corners chosen to reproduce the same 0/1/8/15
// masks as the fixture above, so it should load with the same terrain shape.
const terrainCorners = [
  { role: "tile-00-water", corners: { NW: "water", NE: "water", SW: "water", SE: "water" } },
  { role: "tile-01-se", corners: { NW: "water", NE: "water", SW: "water", SE: "grass" } },
  { role: "tile-02-nw", corners: { NW: "grass", NE: "water", SW: "water", SE: "water" } },
  { role: "tile-03-grass", corners: { NW: "grass", NE: "grass", SW: "grass", SE: "grass" } },
]
const terrainTiles: LockEntry["outputs"] = []
for (const [index, tile] of terrainCorners.entries()) {
  const file = path.join(dir, `terrain2-${tile.role}.png`)
  await writeFile(file, px(8, 60 + index * 30))
  terrainTiles.push({ path: file, sha256: String(index), role: tile.role })
}
const terrainTileset = exportTileset(
  {
    outputs: terrainTiles,
    provider: "pixellab",
    generator: "terrain",
    providerMetadata: { pixellab: { terrainTypes: ["grass", "water"], terrainTiles: terrainCorners } },
  } as LockEntry,
  { root: dir, styleId: "ground", assetId: "terrain2", generator: "terrain", outFile: path.join(dir, "terrain2.png"), tileType: "square_topdown" } as ResolvedSpec,
  { format: "godot", manifestDir: dir, imageName: "terrain2-tileset.png", columns: 2 },
)
await writeFile(path.join(dir, "terrain2-tileset.png"), terrainTileset.png)
await writeFile(path.join(dir, "terrain2-tileset.tres"), terrainTileset.document)

// The same corner set again, but isometric (the terrain generator's actual
// default tile shape). Godot's terrain peering-bit property names for a
// diamond tile are NOT the square names above — see godotTerrainBits() in
// tileset-export.ts — so this exercises that branch and, below, actually
// round-trips a peering bit through Godot's own get_terrain_peering_bit()
// rather than only checking tile/terrain-set counts.
const isoTiles: LockEntry["outputs"] = []
for (const [index, tile] of terrainCorners.entries()) {
  const file = path.join(dir, `terrain3-${tile.role}.png`)
  await writeFile(file, px(8, 60 + index * 30))
  isoTiles.push({ path: file, sha256: String(index), role: tile.role })
}
const isoTileset = exportTileset(
  {
    outputs: isoTiles,
    provider: "pixellab",
    generator: "terrain",
    providerMetadata: { pixellab: { terrainTypes: ["grass", "water"], terrainTiles: terrainCorners } },
  } as LockEntry,
  { root: dir, styleId: "ground", assetId: "terrain3", generator: "terrain", outFile: path.join(dir, "terrain3.png"), tileType: "isometric" } as ResolvedSpec,
  { format: "godot", manifestDir: dir, imageName: "terrain3-tileset.png", columns: 2 },
)
await writeFile(path.join(dir, "terrain3-tileset.png"), isoTileset.png)
await writeFile(path.join(dir, "terrain3-tileset.tres"), isoTileset.document)

await writeFile(path.join(dir, "project.godot"), `; Engine configuration file.
config_version=5

[application]
config/name="pixelkiln-check"
config/features=PackedStringArray("4.4")
`)
await writeFile(path.join(dir, "verify.gd"), `extends SceneTree

func _init() -> void:
	var report := {}
	var frames := load("res://cast-sheet.tres") as SpriteFrames
	if frames == null:
		report["spriteframes"] = "failed to load"
	else:
		var names: Array = []
		for name in frames.get_animation_names():
			names.append(String(name))
		names.sort()
		report["animations"] = names
		report["walk"] = {
			"frames": frames.get_frame_count("hero.walk"),
			"speed": frames.get_animation_speed("hero.walk"),
			"loop": frames.get_animation_loop("hero.walk"),
			"size": [frames.get_frame_texture("hero.walk", 0).get_width(), frames.get_frame_texture("hero.walk", 0).get_height()],
		}
		report["south"] = {
			"frames": frames.get_frame_count("hero/south"),
			"loop": frames.get_animation_loop("hero/south"),
		}
	var tileset := load("res://terrain-tileset.tres") as TileSet
	if tileset == null:
		report["tileset"] = "failed to load"
	else:
		var source := tileset.get_source(tileset.get_source_id(0)) as TileSetAtlasSource
		var terrain_names: Array = []
		var terrains := 0
		if tileset.get_terrain_sets_count() > 0:
			terrains = tileset.get_terrains_count(0)
			for i in range(terrains):
				terrain_names.append(tileset.get_terrain_name(0, i))
		report["tileset"] = {
			"sources": tileset.get_source_count(),
			"tiles": source.get_tiles_count() if source != null else -1,
			"tile_size": [tileset.tile_size.x, tileset.tile_size.y],
			"terrain_sets": tileset.get_terrain_sets_count(),
			"terrains": terrains,
			"terrain_names": terrain_names,
		}
	var terrain_tileset := load("res://terrain2-tileset.tres") as TileSet
	if terrain_tileset == null:
		report["terrain_tileset"] = "failed to load"
	else:
		var terrain_source := terrain_tileset.get_source(terrain_tileset.get_source_id(0)) as TileSetAtlasSource
		var terrain2_names: Array = []
		var terrain2_count := 0
		if terrain_tileset.get_terrain_sets_count() > 0:
			terrain2_count = terrain_tileset.get_terrains_count(0)
			for i in range(terrain2_count):
				terrain2_names.append(terrain_tileset.get_terrain_name(0, i))
		# Atlas coord (1, 0) is generic tile id 1 ("tile-01-se": SE=grass, the
		# rest water), which the exporter should have given peering bit 0 (the
		# first-listed terrain, "grass") on its bottom-right corner.
		report["terrain_tileset"] = {
			"sources": terrain_tileset.get_source_count(),
			"tiles": terrain_source.get_tiles_count() if terrain_source != null else -1,
			"terrain_sets": terrain_tileset.get_terrain_sets_count(),
			"terrains": terrain2_count,
			"terrain_names": terrain2_names,
			"peering_bit": terrain_source.get_tile_data(Vector2i(1, 0), 0).get_terrain_peering_bit(TileSet.CELL_NEIGHBOR_BOTTOM_RIGHT_CORNER) if terrain_source != null else -1,
		}
	var iso_tileset := load("res://terrain3-tileset.tres") as TileSet
	if iso_tileset == null:
		report["iso_tileset"] = "failed to load"
	else:
		var iso_source := iso_tileset.get_source(iso_tileset.get_source_id(0)) as TileSetAtlasSource
		var iso_tile_data := iso_source.get_tile_data(Vector2i(1, 0), 0)
		# Same tile (mask 1, SE=grass) as terrain_tileset above, but isometric:
		# the diamond-point name must round-trip, and the square name pixelkiln
		# used to always emit must come back invalid (Godot rejects it outright
		# for a non-square tile_shape), proving this isn't just emitting both.
		report["iso_tileset"] = {
			"tile_shape": iso_tileset.tile_shape,
			"bottom_corner": iso_tile_data.get_terrain_peering_bit(TileSet.CELL_NEIGHBOR_BOTTOM_CORNER),
			"square_bottom_right_corner_is_invalid": iso_tile_data.get_terrain_peering_bit(TileSet.CELL_NEIGHBOR_BOTTOM_RIGHT_CORNER) == -1,
		}
	print("PIXELKILN_REPORT " + JSON.stringify(report))
	quit(0)
`)

const failures: string[] = []
const check = (ok: unknown, what: string) => {
  if (!ok) failures.push(what)
  console.log(`  ${ok ? "ok  " : "FAIL"} ${what}`)
}
try {
  // The import pass writes the .import sidecars a texture load needs.
  await execFileAsync(godot, ["--headless", "--path", dir, "--import"], { timeout: 180_000 }).catch(() => {})
  const { stdout, stderr } = await execFileAsync(godot, ["--headless", "--path", dir, "--script", "res://verify.gd"], { timeout: 120_000 })
  const line = (stdout + stderr).split("\n").find((l) => l.startsWith("PIXELKILN_REPORT "))
  if (!line) throw new Error(`no report from Godot:\n${stdout}\n${stderr}`)
  const report = JSON.parse(line.slice("PIXELKILN_REPORT ".length))
  console.log(`\ngodot ${(await execFileAsync(godot, ["--version"])).stdout.trim()} loaded the resources:`)
  check(Array.isArray(report.animations), "SpriteFrames loads")
  check(JSON.stringify(report.animations) === JSON.stringify(["hero.walk", "hero/east", "hero/north", "hero/south", "hero/west"]), `animations are the four directions and the loop (${JSON.stringify(report.animations)})`)
  check(report.walk?.frames === 6, `the loop has 6 frames (${report.walk?.frames})`)
  check(report.walk?.speed === 12, `the loop plays at 12 fps (${report.walk?.speed})`)
  check(report.walk?.loop === true, "the loop loops")
  check(JSON.stringify(report.walk?.size) === "[16,16]", `each frame is the 16px cell (${JSON.stringify(report.walk?.size)})`)
  check(report.south?.frames === 1 && report.south?.loop === false, "a direction is a one-frame still")
  check(typeof report.tileset === "object", "TileSet loads")
  check(report.tileset?.sources === 1 && report.tileset?.tiles === 4, `one atlas source with 4 tiles (${report.tileset?.sources}, ${report.tileset?.tiles})`)
  check(JSON.stringify(report.tileset?.tile_size) === "[8,8]", `tile size is 8px (${JSON.stringify(report.tileset?.tile_size)})`)
  check(report.tileset?.terrain_sets === 1 && report.tileset?.terrains === 2, `one terrain set with two terrains (${report.tileset?.terrain_sets}, ${report.tileset?.terrains})`)
  check(JSON.stringify(report.tileset?.terrain_names) === JSON.stringify(["grass", "water"]), `terrains are named from the rules (${JSON.stringify(report.tileset?.terrain_names)})`)
  check(typeof report.terrain_tileset === "object", "terrain generator's TileSet loads")
  check(report.terrain_tileset?.sources === 1 && report.terrain_tileset?.tiles === 4, `terrain generator tileset has one atlas source with 4 tiles (${report.terrain_tileset?.sources}, ${report.terrain_tileset?.tiles})`)
  check(report.terrain_tileset?.terrain_sets === 1 && report.terrain_tileset?.terrains === 2, `terrain generator tileset has one terrain set with two terrains (${report.terrain_tileset?.terrain_sets}, ${report.terrain_tileset?.terrains})`)
  check(JSON.stringify(report.terrain_tileset?.terrain_names) === JSON.stringify(["grass", "water"]), `terrain generator terrains are named from corners/terrainTypes (${JSON.stringify(report.terrain_tileset?.terrain_names)})`)
  check(report.terrain_tileset?.peering_bit === 0, `terrain generator's corner metadata reaches the tile's terrain peering bit (${report.terrain_tileset?.peering_bit})`)
  check(report.iso_tileset?.tile_shape === 1, `isometric terrain TileSet has tile_shape 1 (${report.iso_tileset?.tile_shape})`)
  check(report.iso_tileset?.bottom_corner === 0, `isometric terrain's diamond-point peering bit round-trips through Godot (${report.iso_tileset?.bottom_corner})`)
  check(report.iso_tileset?.square_bottom_right_corner_is_invalid === true, "isometric terrain does not also carry the square corner name Godot would reject")
} finally {
  await rm(dir, { recursive: true, force: true })
}
if (failures.length) {
  console.error(`\ngodot check failed: ${failures.length} check(s)`)
  process.exit(1)
}
console.log("\ngodot check passed")
