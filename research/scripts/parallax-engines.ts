/**
 * Checks a manifest's parallax set in real engines against `pixelkiln
 * parallax preview`'s own frames, pixel for pixel.
 *
 *   npx tsx research/scripts/parallax-engines.ts <manifest> <set> <x,y> [<x,y> ...] [--snap] [--time <name>]
 *
 * Godot: exports the set with `--format godot`, puts the scene in a small
 * Godot project with a Camera2D, renders each camera position with Movie
 * Maker (`--write-movie`, which opens a window) and compares the frames.
 * `--snap` turns on Rendering > 2D > Snap 2D Transforms to Pixel. `--time`
 * renders one of the set's times of day: Godot through the export's shader,
 * Tiled and LDtk from that time's own map, each against the preview recoloured.
 *
 * Tiled: exports with `--format tiled`, bakes Tiled's parallax offset for
 * each camera position into a copy of the map and renders it with Tiled's
 * tmxrasterizer (set TMXRASTERIZER, or the macOS app is used).
 *
 * LDtk: exports with `--format ldtk` and draws the level the way LDtk's
 * editor does (Camera.getParallaxOffsetX and LayerInstance.pxParallaxX in
 * LDtk's source), since the editor itself has no command line.
 *
 * Camera positions are how far right and how far up the camera has moved
 * from the start. Needs a Godot 4.3+ binary (GODOT, or the macOS app).
 * Phaser has no file format; research/scripts/parallax-phaser.html checks it
 * in a browser.
 */
import { execFile } from "node:child_process"
import { existsSync } from "node:fs"
import { mkdir, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { promisify } from "node:util"
import { main } from "../../src/cli/main.ts"
import { loadLock } from "../../src/lock.ts"
import { loadManifest } from "../../src/manifest.ts"
import { composeParallaxFrame, resolveParallaxSet, setAtTime } from "../../src/pipeline/parallax.ts"
import { decodePng, type DecodedPng } from "../../src/png.ts"

const run = promisify(execFile)
const argv = process.argv.slice(2)
const snap = argv.includes("--snap")
const timeAt = argv.indexOf("--time")
const time = timeAt >= 0 ? argv[timeAt + 1] : undefined
const [manifestArg, setId, ...rest] = argv.filter((arg, i) => arg !== "--snap" && (timeAt < 0 || (i !== timeAt && i !== timeAt + 1)))
if (!manifestArg || !setId || !rest.length) {
  console.error("usage: parallax-engines.ts <manifest> <set> <x,y> [<x,y> ...] [--snap]")
  process.exit(2)
}
const positions = rest.map((pair) => pair.split(",").map(Number) as [number, number])
const manifestPath = path.resolve(manifestArg)
const lockPath = path.join(path.dirname(manifestPath), "pixelkiln.lock.json")
const loaded = await loadManifest(manifestPath)
const drawn = await resolveParallaxSet(loaded.manifest, path.dirname(manifestPath), await loadLock(lockPath), setId)
// The frames to match: the set as drawn, or recoloured to the time asked for.
const set = time ? setAtTime(drawn, time) : drawn
const timeIndex = time ? drawn.times!.findIndex((t) => t.name === time) + 1 : 0
const [vw, vh] = set.view
const work = await mkdtemp(path.join(tmpdir(), "pixelkiln-parallax-engines-"))
const cli = (format: string) =>
  main(["parallax", "export", setId, "--format", format, "--out", path.join(work, "export"), "--manifest", manifestPath, "--lock", lockPath, "--force"])

function differing(want: DecodedPng, got: DecodedPng): number {
  let n = 0
  for (let p = 0; p < want.width * want.height; p++) {
    let d = 0
    for (let c = 0; c < 3; c++) d = Math.max(d, Math.abs(want.pixels[p * 4 + c]! - got.pixels[p * 4 + c]!))
    if (d > 2) n++
  }
  return n
}

// Godot ------------------------------------------------------------------
const godot = [process.env.GODOT, "/Applications/Godot.app/Contents/MacOS/Godot", "/usr/local/bin/godot", "/usr/bin/godot"]
  .filter((candidate): candidate is string => Boolean(candidate))
  .find((candidate) => existsSync(candidate))
if (!godot) {
  console.log("godot: none found; set GODOT")
} else {
  await cli("godot")
  const project = path.join(work, "godot")
  await mkdir(path.join(project, "out"), { recursive: true })
  const exported = path.join(work, "export", "godot")
  for (const file of await readdir(exported)) {
    if (file.endsWith(".png") || file.endsWith(".tscn") || file.endsWith(".gdshader")) await writeFile(path.join(project, file), await readFile(path.join(exported, file)))
  }
  const hold = 4
  await writeFile(path.join(project, "project.godot"), [
    "config_version=5",
    "",
    "[application]",
    'run/main_scene="res://main.tscn"',
    "",
    "[display]",
    `window/size/viewport_width=${vw}`,
    `window/size/viewport_height=${vh}`,
    "",
    "[rendering]",
    "textures/canvas_textures/default_texture_filter=0",
    ...(snap ? ["2d/snap/snap_2d_transforms_to_pixel=true"] : []),
    "",
  ].join("\n"))
  // Each position is held for a few frames; Movie Maker writes a frame before the scene's own update.
  await writeFile(path.join(project, "main.gd"), [
    "extends Node2D",
    `var positions = ${JSON.stringify(positions)}`,
    `var climb := ${set.climb}`,
    `var hold := ${hold}`,
    "var frame := 0",
    "func _ready():",
    ...(timeIndex ? [`\t$background.get_child(0).get_node("Sprite2D").material.set_shader_parameter("time", ${timeIndex})`] : []),
    "\t_place()",
    "func _place():",
    "\tvar p = positions[min(frame / hold, positions.size() - 1)]",
    "\t$Camera2D.position = Vector2(p[0], climb - p[1])",
    "func _process(_d):",
    "\tframe += 1",
    "\tif frame / hold >= positions.size():",
    "\t\tget_tree().quit()",
    "\t\treturn",
    "\t_place()",
    "",
  ].join("\n"))
  await writeFile(path.join(project, "main.tscn"), [
    "[gd_scene load_steps=3 format=3]",
    "",
    '[ext_resource type="Script" path="res://main.gd" id="1"]',
    `[ext_resource type="PackedScene" path="res://${setId}.tscn" id="2"]`,
    "",
    '[node name="Main" type="Node2D"]',
    'script = ExtResource("1")',
    "",
    '[node name="background" parent="." instance=ExtResource("2")]',
    "",
    '[node name="Camera2D" type="Camera2D" parent="."]',
    "anchor_mode = 0",
    "",
  ].join("\n"))
  await run(godot, ["--headless", "--path", project, "--import"]).catch(() => undefined)
  await run(godot, ["--path", project, "--write-movie", "out/f.png", "--fixed-fps", "30"], { timeout: 180_000 })
  const { stdout } = await run(godot, ["--version"])
  console.log(`godot ${stdout.trim()}${snap ? ", snap 2D transforms to pixel" : ""}${time ? `, time ${time} through the shader` : ""}`)
  for (const [i, [x, y]] of positions.entries()) {
    const frame = (i + 1) * hold - 2
    const got = decodePng(await readFile(path.join(project, "out", `f${String(frame).padStart(8, "0")}.png`)))
    console.log(`  camera ${x},${y}: ${differing(composeParallaxFrame(set, x, y), got)} of ${vw * vh} pixels differ`)
  }
}

// Tiled ------------------------------------------------------------------
// Tiled's editor applies parallax only on screen, and its tmxrasterizer draws
// layers at their offsets. So for each camera position the offset Tiled's
// editor would add, (1 - factor) x the view's centre measured from the map's
// origin (MapScene::parallaxOffset; the export leaves the origin at 0, 0), is
// baked into a copy of the map, Tiled renders the copy, and the view is cut out.
const rasterizer = [process.env.TMXRASTERIZER, "/Applications/Tiled.app/Contents/MacOS/tmxrasterizer", "/usr/bin/tmxrasterizer"]
  .filter((candidate): candidate is string => Boolean(candidate))
  .find((candidate) => existsSync(candidate))
if (!rasterizer) {
  console.log("tiled: no tmxrasterizer found; set TMXRASTERIZER")
} else {
  await cli("tiled")
  const tmj = path.join(work, "export", "tiled", `${setId}${time ? `.${time}` : ""}.tmj`)
  const map = JSON.parse(await readFile(tmj, "utf8"))
  console.log(`tiled (rendered by tmxrasterizer)${time ? `, the ${time} map` : ""}`)
  for (const [camX, camY] of positions) {
    const cx = vw / 2 + camX
    const cy = set.climb + vh / 2 - camY
    const baked = structuredClone(map)
    for (const layer of baked.layers) {
      layer.offsetx = Math.round(layer.offsetx + (1 - layer.parallaxx) * cx)
      layer.offsety = Math.round(layer.offsety + (1 - layer.parallaxy) * cy)
      layer.parallaxx = 1
      layer.parallaxy = 1
    }
    const copy = path.join(work, "export", "tiled", "camera.tmj")
    const png = path.join(work, "export", "tiled", "camera.png")
    await writeFile(copy, JSON.stringify(baked))
    await run(rasterizer, ["--no-smoothing", copy, png])
    const image = decodePng(await readFile(png))
    // The render starts at the corner of the map and of every layer that does not repeat.
    const left = Math.min(0, ...baked.layers.filter((l: { repeatx: boolean }) => !l.repeatx).map((l: { offsetx: number }) => l.offsetx))
    const top = Math.min(0, ...baked.layers.filter((l: { repeaty: boolean }) => !l.repeaty).map((l: { offsety: number }) => l.offsety))
    const view: DecodedPng = { width: vw, height: vh, pixels: Buffer.alloc(vw * vh * 4) }
    for (let y = 0; y < vh; y++) {
      const from = ((set.climb - camY - top + y) * image.width + camX - left) * 4
      if (from >= 0 && from + vw * 4 <= image.pixels.length) image.pixels.copy(view.pixels, y * vw * 4, from, from + vw * 4)
    }
    console.log(`  camera ${camX},${camY}: ${differing(composeParallaxFrame(set, camX, camY), view)} of ${vw * vh} pixels differ`)
  }
}

// LDtk -------------------------------------------------------------------
await cli("ldtk")
const ldtkFile = path.join(work, "export", "ldtk", `${setId}${time ? `.${time}` : ""}.ldtk`)
const project = JSON.parse(await readFile(ldtkFile, "utf8"))
const level = project.levels[0]
console.log(`ldtk (drawn as LDtk ${project.jsonVersion}'s editor draws it)${time ? `, the ${time} level` : ""}`)
for (const [camX, camY] of positions) {
  const cx = vw / 2 + camX
  const cy = level.pxHei - vh / 2 - camY
  const out: DecodedPng = { width: vw, height: vh, pixels: Buffer.alloc(vw * vh * 4) }
  for (const li of [...level.layerInstances].reverse()) {
    const def = project.defs.layers.find((d: { uid: number }) => d.uid === li.layerDefUid)
    const tileset = project.defs.tilesets.find((t: { uid: number }) => t.uid === def.tilesetDefUid)
    const picture = decodePng(await readFile(path.join(path.dirname(ldtkFile), tileset.relPath)))
    const g = def.gridSize
    const width = level.pxWid - li.pxOffsetX
    const height = level.pxHei - li.pxOffsetY
    const cWid = Math.ceil(width / g)
    const ox = Math.round(li.pxOffsetX + def.pxOffsetX + cx * def.parallaxFactorX - width * 0.5 * def.parallaxFactorX)
    const oy = Math.round(li.pxOffsetY + def.pxOffsetY + cy * def.parallaxFactorY - height * 0.5 * def.parallaxFactorY)
    for (const tile of li.gridTiles) {
      const tx = (tile.d[0] % cWid) * g + ox - (cx - vw / 2)
      const ty = Math.floor(tile.d[0] / cWid) * g + oy - (cy - vh / 2)
      for (let y = 0; y < g; y++) {
        for (let x = 0; x < g; x++) {
          const sx = tx + x
          const sy = ty + y
          if (sx < 0 || sy < 0 || sx >= vw || sy >= vh) continue
          const src = ((tile.src[1] + y) * picture.width + tile.src[0] + x) * 4
          if (picture.pixels[src + 3] === 0) continue
          picture.pixels.copy(out.pixels, (sy * vw + sx) * 4, src, src + 4)
        }
      }
    }
  }
  console.log(`  camera ${camX},${camY}: ${differing(composeParallaxFrame(set, camX, camY), out)} of ${vw * vh} pixels differ`)
}
console.log(`work files: ${work}`)
