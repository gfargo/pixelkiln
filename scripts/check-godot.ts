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
import { parseArgs } from "../src/cli/args.ts"
import { runExport } from "../src/cli/commands/pack.ts"
import { packStyle } from "../src/pipeline/pack.ts"
import { renderGodotSpriteFrames } from "../src/pipeline/sheet-formats.ts"
import { exportTileset } from "../src/pipeline/tileset-export.ts"
import { exportGodot, skyBands } from "../src/pipeline/parallax.ts"
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

// The same corner set again, but isometric — `tiles`' own real API default
// for `tileType`, not terrain's (`/create-tileset` always places tiles on a
// rectangular vertex grid; terrain's resolved spec always carries
// tileType: "square_topdown", never isometric — see manifest.ts). Godot's
// terrain peering-bit property names for a diamond tile are NOT the square
// names above — see godotTerrainBits() in tileset-export.ts — so this
// exercises that branch for a `tiles`-shaped isometric corner set and, below,
// actually round-trips a peering bit through Godot's own
// get_terrain_peering_bit() rather than only checking tile/terrain-set counts.
// Its tiles are drawn as PixelLab draws them: a 2:1 diamond 32 wide and 16 tall
// at the top of a 32x24 image, with the sides hanging 8px below it.
const diamond = (shade: number) => {
  const rgba = Buffer.alloc(32 * 24 * 4, 0)
  const bottom: number[] = []
  for (let y = 0; y < 16; y++) {
    const width = y < 8 ? 4 * (y + 1) : 4 * (16 - y)
    for (let x = 16 - width / 2; x < 16 + width / 2; x++) {
      rgba.set([shade, shade, shade, 255], (y * 32 + x) * 4)
      bottom[x] = Math.max(bottom[x] ?? 0, y)
    }
  }
  bottom.forEach((b, x) => {
    for (let y = b + 1; y <= b + 8 && y < 24; y++) rgba.set([shade / 2, shade / 2, shade / 2, 255], (y * 32 + x) * 4)
  })
  return encodeRgbaPng(32, 24, rgba)
}
const isoTiles: LockEntry["outputs"] = []
for (const [index, tile] of terrainCorners.entries()) {
  const file = path.join(dir, `terrain3-${tile.role}.png`)
  await writeFile(file, diamond(120 + index * 30))
  isoTiles.push({ path: file, sha256: String(index), role: tile.role })
}
const isoTileset = exportTileset(
  {
    outputs: isoTiles,
    provider: "pixellab",
    generator: "tiles",
    providerMetadata: { pixellab: { tileKind: "tileset", tileRules: rules } },
  } as LockEntry,
  { root: dir, styleId: "ground", assetId: "terrain3", generator: "tiles", outFile: path.join(dir, "terrain3.png"), tileType: "isometric" } as ResolvedSpec,
  { format: "godot", manifestDir: dir, imageName: "terrain3-tileset.png", columns: 2 },
)
await writeFile(path.join(dir, "terrain3-tileset.png"), isoTileset.png)
await writeFile(path.join(dir, "terrain3-tileset.tres"), isoTileset.document)

// Painting. A tileset that loads can still paint nothing, so these are full
// 16-tile sets (every mask once) in the four shapes a game meets, painted
// by Godot's own terrain painting and audited for gaps and seams.
const fullRules = (ruleType: "corner" | "edge") => ({
  rule_type: ruleType,
  arity: 4,
  terrains: ["grass", "water"],
  tiles: Object.fromEntries(Array.from({ length: 16 }, (_, mask) => [`tile_${mask}`, mask])),
})
const paintable: Array<{ name: string; ruleType: "corner" | "edge"; tileType: string }> = [
  { name: "paint-square-corner", ruleType: "corner", tileType: "square_topdown" },
  { name: "paint-square-edge", ruleType: "edge", tileType: "square_topdown" },
  { name: "paint-iso-corner", ruleType: "corner", tileType: "isometric" },
  { name: "paint-iso-edge", ruleType: "edge", tileType: "isometric" },
]
for (const set of paintable) {
  const outputs: LockEntry["outputs"] = []
  for (let index = 0; index < 16; index++) {
    const file = path.join(dir, `${set.name}-tile-${index}.png`)
    await writeFile(file, set.tileType === "isometric" ? diamond(40 + index * 12) : px(8, 40 + index * 12))
    outputs.push({ path: file, sha256: String(index), role: `tile-${index}` })
  }
  const exported = exportTileset(
    { outputs, provider: "pixellab", generator: "tiles", providerMetadata: { pixellab: { tileKind: "tileset", tileRules: fullRules(set.ruleType) } } } as LockEntry,
    { root: dir, styleId: "ground", assetId: set.name, generator: "tiles", outFile: path.join(dir, `${set.name}.png`), tileType: set.tileType } as ResolvedSpec,
    { format: "godot", manifestDir: dir, imageName: `${set.name}.png`, columns: 4 },
  )
  await writeFile(path.join(dir, `${set.name}.png`), exported.png)
  await writeFile(path.join(dir, `${set.name}.tres`), exported.document)
}

// A merged group from the repo's real art: ocean, sand and grass in one tileset.
const coastDir = path.resolve("website/art/pixellab-0.4.130")
await runExport(parseArgs([
  "export", "--manifest", path.join(coastDir, "pixelkiln.manifest.json"), "--lock", path.join(coastDir, "pixelkiln.lock.json"),
  "--style", "coast", "--format", "godot", "--merge-connected", "--out", path.join(dir, "paint-coast"),
]))

// A parallax scene: a sky, a looping far layer and a vertical loop, as `parallax export` writes it.
{
  const solid = (w: number, h: number, shade: number) => {
    const pixels = Buffer.alloc(w * h * 4, shade)
    for (let i = 3; i < pixels.length; i += 4) pixels[i] = 255
    return { width: w, height: h, pixels }
  }
  const scene = exportGodot({
    id: "bg",
    view: [64, 48],
    travel: 96,
    climb: 40,
    warnings: [],
    layers: [
      { name: "sky", png: skyBands(64, 60, ["#102030", "#405060"]), speed: 0, speedY: 0.3, x: 0, y: -12, repeat: true, repeatY: false, source: { kind: "sky", colors: [] } },
      { name: "far", png: solid(40, 20, 90), speed: 0.25, speedY: 0.25, x: 0, y: 20, repeat: true, repeatY: false, source: { kind: "file", path: "far.png" } },
      { name: "clouds", png: solid(30, 24, 150), speed: 0.5, speedY: 0.5, x: 50, y: -70, repeat: false, repeatY: true, source: { kind: "file", path: "clouds.png" } },
    ],
  }, path.join(dir, "bg"))
  for (const file of scene.files) await writeFile(file.path, file.data)
}

await writeFile(path.join(dir, "project.godot"), `; Engine configuration file.
config_version=5

[application]
config/name="pixelkiln-check"
config/features=PackedStringArray("4.4")
`)
await writeFile(path.join(dir, "verify.gd"), `extends SceneTree

func paint_rect(x0: int, y0: int, x1: int, y1: int) -> Array:
	var cells := []
	for y in range(y0, y1):
		for x in range(x0, x1):
			cells.append(Vector2i(x, y))
	return cells

# The terrain a corner or side should carry after the strokes so far: the one
# the latest stroke gave when it covered every cell that shares that corner or
# side (a stroke does not move one it only touches, whatever sits beside it).
func expected_terrain(strokes: Array, shared: Array) -> int:
	for i in range(strokes.size() - 1, -1, -1):
		var covers := true
		for cell in shared:
			if not strokes[i][0].has_point(cell):
				covers = false
				break
		if covers:
			return strokes[i][1]
	return -2

# Paint the way the editor's terrain tool does (ignore_empty_terrains is false
# there; the script default of true leaves a filled map's edge cells empty):
# the whole area in terrain 0, then each higher terrain in a rectangle inside the
# last, then a pocket of the one before the highest inside that. Then count cells
# with no tile and corners or sides that are not what the strokes say.
func paint_audit(name: String) -> Dictionary:
	var tileset := load("res://" + name + ".tres") as TileSet
	if tileset == null:
		return {"error": "failed to load"}
	var layer := TileMapLayer.new()
	layer.tile_set = tileset
	root.add_child(layer)
	var terrains := tileset.get_terrains_count(0)
	var area := Rect2i(0, 0, 16, 12)
	var strokes := []
	strokes.append([area, 0])
	for t in range(1, terrains):
		strokes.append([Rect2i(2 * t, 2 * t, 16 - 4 * t, 12 - 4 * t), t])
	strokes.append([Rect2i(7, 5, 2, 2), terrains - 2])
	for stroke in strokes:
		var r: Rect2i = stroke[0]
		layer.set_cells_terrain_connect(paint_rect(r.position.x, r.position.y, r.end.x, r.end.y), 0, stroke[1], false)
	# Peering bits by TileSet.CellNeighbor value: corners in mode 1, sides in mode 2,
	# for a square or a diamond cell. A corner is shared with the cells beside it
	# (its two neighbouring sides) and the one past it; a side with the cell across.
	var corners := tileset.get_terrain_set_mode(0) == TileSet.TERRAIN_MODE_MATCH_CORNERS
	var diamond := tileset.tile_shape == TileSet.TILE_SHAPE_ISOMETRIC
	var bits: Array = ([1, 5, 9, 13] if diamond else [3, 7, 11, 15]) if corners else ([2, 6, 10, 14] if diamond else [0, 4, 8, 12])
	var missing := 0
	var wrong := 0
	var where := []
	for y in range(area.size.y):
		for x in range(area.size.x):
			var cell := Vector2i(x, y)
			var data := layer.get_cell_tile_data(cell)
			if data == null:
				missing += 1
				continue
			for b in bits:
				var shared := [cell, layer.get_neighbor_cell(cell, b)]
				if corners:
					shared.append(layer.get_neighbor_cell(cell, (b + 13) % 16))
					shared.append(layer.get_neighbor_cell(cell, (b + 1) % 16))
				var inside := true
				for c in shared:
					if not area.has_point(c):
						inside = false
				if not inside:
					continue
				var want := expected_terrain(strokes, shared)
				var got := data.get_terrain_peering_bit(b)
				if got != want:
					wrong += 1
					if where.size() < 6:
						where.append([x, y, b, got, want])
	layer.queue_free()
	return {"terrains": terrains, "cells": area.size.x * area.size.y, "missing": missing, "wrong": wrong, "bits": bits.size(), "where": where}

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
			"tile_shape": terrain_tileset.tile_shape,
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
			"tile_layout": iso_tileset.tile_layout,
			"tile_size": [iso_tileset.tile_size.x, iso_tileset.tile_size.y],
			"region_size": [iso_source.texture_region_size.x, iso_source.texture_region_size.y],
			"texture_origin": [iso_tile_data.texture_origin.x, iso_tile_data.texture_origin.y],
			"bottom_corner": iso_tile_data.get_terrain_peering_bit(TileSet.CELL_NEIGHBOR_BOTTOM_CORNER),
			"square_bottom_right_corner_is_invalid": iso_tile_data.get_terrain_peering_bit(TileSet.CELL_NEIGHBOR_BOTTOM_RIGHT_CORNER) == -1,
		}
	report["painting"] = {}
	for name in ["paint-square-corner", "paint-square-edge", "paint-iso-corner", "paint-iso-edge", "paint-coast"]:
		report["painting"][name] = paint_audit(name)
	var bg = (load("res://bg.tscn") as PackedScene).instantiate()
	report["parallax"] = {}
	report["parallax_order"] = []
	for child in bg.get_children():
		report["parallax_order"].append(child.name)
		var sprite = child.get_child(0) as Sprite2D
		report["parallax"][child.name] = {
			"type": child.get_class(),
			"scroll_scale": [child.scroll_scale.x, child.scroll_scale.y],
			"scroll_offset": [child.scroll_offset.x, child.scroll_offset.y],
			"repeat_size": [child.repeat_size.x, child.repeat_size.y],
			"repeat_times": child.repeat_times,
			"position": [sprite.position.x, sprite.position.y],
			"texture": [sprite.texture.get_width(), sprite.texture.get_height()],
		}
	report["parallax_filter"] = bg.texture_filter
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
  check(report.terrain_tileset?.tile_shape === 0, `terrain generator's TileSet stays square, not isometric (${report.terrain_tileset?.tile_shape})`)
  check(report.iso_tileset?.tile_shape === 1, `an isometric tiles-generator TileSet has tile_shape 1 (${report.iso_tileset?.tile_shape})`)
  check(report.iso_tileset?.tile_layout === 5, `an isometric TileSet is laid out as a diamond, not staggered (${report.iso_tileset?.tile_layout})`)
  check(JSON.stringify(report.iso_tileset?.tile_size) === "[32,16]", `its cell is the 32x16 diamond, not the 32x24 image (${JSON.stringify(report.iso_tileset?.tile_size)})`)
  check(JSON.stringify(report.iso_tileset?.region_size) === "[32,24]", `its atlas still cuts the whole 32x24 image (${JSON.stringify(report.iso_tileset?.region_size)})`)
  check(JSON.stringify(report.iso_tileset?.texture_origin) === "[0,-4]", `each image is moved so its diamond sits on the cell (${JSON.stringify(report.iso_tileset?.texture_origin)})`)
  check(report.iso_tileset?.bottom_corner === 0, `isometric tileset's diamond-point peering bit round-trips through Godot (${report.iso_tileset?.bottom_corner})`)
  check(report.iso_tileset?.square_bottom_right_corner_is_invalid === true, "isometric tileset does not also carry the square corner name Godot would reject")
  const layers = report.parallax ?? {}
  check(JSON.stringify(report.parallax_order) === JSON.stringify(["sky", "far", "clouds"]), `the parallax scene loads with its three Parallax2D layers, far first (${JSON.stringify(report.parallax_order)})`)
  check(Object.values(layers).every((layer: any) => layer.type === "Parallax2D"), "every parallax layer is a Parallax2D")
  check(JSON.stringify(layers.far?.scroll_scale) === "[0.25,0.25]", `the far layer scrolls at a quarter of the camera (${JSON.stringify(layers.far?.scroll_scale)})`)
  check(JSON.stringify(layers.far?.repeat_size) === "[40,0]" && JSON.stringify(layers.far?.texture) === "[40,20]", `the far layer repeats sideways at its width (${JSON.stringify(layers.far?.repeat_size)})`)
  check(JSON.stringify(layers.clouds?.repeat_size) === "[0,24]" && JSON.stringify(layers.clouds?.position) === "[50,18]", `the cloud loop repeats upward from inside its first repeat (${JSON.stringify(layers.clouds?.repeat_size)}, ${JSON.stringify(layers.clouds?.position)})`)
  check(JSON.stringify(layers.clouds?.scroll_offset) === "[0,-20]", `a climbing layer keeps what the start view would move it (${JSON.stringify(layers.clouds?.scroll_offset)})`)
  check(report.parallax_filter === 1, `the parallax scene draws with nearest filtering (${report.parallax_filter})`)
  for (const [name, terrains] of [["paint-square-corner", 2], ["paint-square-edge", 2], ["paint-iso-corner", 2], ["paint-iso-edge", 2], ["paint-coast", 3]] as Array<[string, number]>) {
    const result = report.painting?.[name]
    check(
      result && result.missing === 0 && result.wrong === 0 && result.terrains === terrains,
      `${name} paints ${terrains} terrains with a clean border (${JSON.stringify(result)})`,
    )
  }
} finally {
  if (process.env.KEEP_GODOT_DIR) console.log(`kept ${dir}`)
  else await rm(dir, { recursive: true, force: true })
}
if (failures.length) {
  console.error(`\ngodot check failed: ${failures.length} check(s)`)
  process.exit(1)
}
console.log("\ngodot check passed")
