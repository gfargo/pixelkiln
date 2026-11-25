/**
 * Parallax backgrounds: a manifest's `parallax` sets, composed, previewed and
 * exported to Tiled, Godot and LDtk.
 *
 * A set is a list of layers, far to near, on one canvas whose origin is the
 * view's top-left when the camera starts. Each layer moves `speed` of the
 * camera's sideways movement and `speedY` of its climb, the convention of
 * Tiled, Godot and Phaser. The research behind it is in
 * docs/RESEARCH_PARALLAX.md; the guide is docs/PARALLAX.md.
 *
 * Every engine puts a layer at its placed position for a different camera
 * position (Tiled at its parallax origin, Godot at a zero screen offset, LDtk
 * at the level's centre), so each exporter shifts the layer to agree with the
 * preview at the start of the level.
 */
import { createHash } from "node:crypto"
import { readFile } from "node:fs/promises"
import path from "node:path"
import { decodePng, encodeRgbaPng, parseHex, type DecodedPng } from "../png.ts"
import { lockKey, type Lock, type Manifest, type ParallaxLayer, type ParallaxRunSprite, type ParallaxSet } from "../types.ts"
import { LDTK_JSON_VERSION } from "./ldtk-export.ts"

export const PARALLAX_FORMATS = ["tiled", "godot", "ldtk"] as const
export type ParallaxFormat = (typeof PARALLAX_FORMATS)[number]

/** A seam rougher than this many times the picture's own column-to-column step shows as a line. */
export const SEAM_WARN_RATIO = 2

export interface ParallaxLayerImage {
  name: string
  png: DecodedPng
  speed: number
  speedY: number
  x: number
  /** Top row on the canvas. */
  y: number
  repeat: boolean
  repeatY: boolean
  /** Where the picture came from: a lock output, a file, drawn sky bands, or a run of sprites laid by seed. */
  source: PictureSource | { kind: "sky"; colors: string[] } | { kind: "run"; seed: number; sprites: PictureSource[] }
  /** Wrap seam over the median inner column step, for a layer that repeats sideways. */
  seamRatio?: number
  /** The same for the vertical join, for a layer that repeats vertically. */
  seamRatioY?: number
}

export type PictureSource = { kind: "asset"; style: string; asset: string; path: string } | { kind: "file"; path: string }

/** The files a layer's picture was made from. */
export function layerFiles(layer: Pick<ParallaxLayerImage, "source">): string[] {
  if (layer.source.kind === "sky") return []
  if (layer.source.kind === "run") return layer.source.sprites.map((sprite) => sprite.path)
  return [layer.source.path]
}

export interface ResolvedParallaxSet {
  id: string
  view: [number, number]
  travel: number
  climb: number
  layers: ParallaxLayerImage[]
  warnings: string[]
}

const BAYER4 = [
  [0, 8, 2, 10],
  [12, 4, 14, 6],
  [3, 11, 1, 9],
  [15, 7, 13, 5],
]

/** Flat colour bands, top to bottom, with an ordered-dither step of up to `blend` rows into the next band. */
export function skyBands(width: number, height: number, colors: string[], blend = 8): DecodedPng {
  const rgb = colors.map((color) => parseHex(color))
  const n = rgb.length
  const pixels = Buffer.alloc(width * height * 4)
  for (let y = 0; y < height; y++) {
    const band = Math.min(Math.floor((y / height) * n), n - 1)
    const rowsLeft = ((band + 1) * height) / n - y
    const share = band < n - 1 && rowsLeft <= blend ? 1 - rowsLeft / (blend + 1) : 0
    for (let x = 0; x < width; x++) {
      const next = share > 0 && BAYER4[y % 4]![x % 4]! < share * 16
      const color = rgb[next ? band + 1 : band]!
      const at = (y * width + x) * 4
      pixels[at] = color.r
      pixels[at + 1] = color.g
      pixels[at + 2] = color.b
      pixels[at + 3] = 255
    }
  }
  return { width, height, pixels }
}

/** The picture turned on its side, so rows can be measured as columns. */
export function transpose(png: DecodedPng): DecodedPng {
  const pixels = Buffer.alloc(png.pixels.length)
  for (let y = 0; y < png.height; y++) {
    for (let x = 0; x < png.width; x++) png.pixels.copy(pixels, (x * png.height + y) * 4, (y * png.width + x) * 4, (y * png.width + x) * 4 + 4)
  }
  return { width: png.height, height: png.width, pixels }
}

/** Mean absolute difference of two columns, RGB weighted by alpha plus alpha itself. */
function columnDiff(png: DecodedPng, a: number, b: number): number {
  let sum = 0
  for (let y = 0; y < png.height; y++) {
    const pa = (y * png.width + a) * 4
    const pb = (y * png.width + b) * 4
    const alphaA = png.pixels[pa + 3]!
    const alphaB = png.pixels[pb + 3]!
    for (let c = 0; c < 3; c++) {
      sum += Math.abs(Math.floor((png.pixels[pa + c]! * alphaA) / 255) - Math.floor((png.pixels[pb + c]! * alphaB) / 255))
    }
    sum += Math.abs(alphaA - alphaB)
  }
  return sum / (png.height * 4)
}

/**
 * The wrap seam (last column against the first) over the median step between
 * neighbouring columns. 1 means the join is as smooth as the inside of the
 * picture; the research found joins above 2 to 3 visible.
 */
export function seamRatio(png: DecodedPng): number {
  if (png.width < 3) return 0
  // Only steps that change count: art drawn at 2x, or flat art, repeats most
  // columns exactly, and a median of 0 would make any join look infinitely rough.
  const inner: number[] = []
  for (let x = 0; x < png.width - 1; x++) {
    const step = columnDiff(png, x, x + 1)
    if (step > 0) inner.push(step)
  }
  const seam = columnDiff(png, png.width - 1, 0)
  if (!inner.length) return seam > 0 ? Infinity : 0
  inner.sort((a, b) => a - b)
  return seam / inner[Math.floor(inner.length / 2)]!
}

function layerName(layer: ParallaxLayer, index: number): string {
  if (layer.name) return layer.name
  const base = layer.asset ?? (layer.file ? path.basename(layer.file, path.extname(layer.file)) : layer.run ? "run" : "sky")
  const slug = base.replace(/[^A-Za-z0-9_-]+/g, "_").replace(/^[^A-Za-z]+/, "")
  return slug || `layer${index + 1}`
}

/** Reads every layer's picture and places it on the set's canvas. */
export async function resolveParallaxSet(
  manifest: Manifest,
  manifestDir: string,
  lock: Lock,
  setId: string,
): Promise<ResolvedParallaxSet> {
  const set: ParallaxSet | undefined = manifest.parallax?.[setId]
  if (!set) {
    const known = Object.keys(manifest.parallax ?? {})
    throw new Error(`No parallax set "${setId}". ${known.length ? `Known: ${known.join(", ")}` : "The manifest has no parallax sets."}`)
  }
  const [viewW, viewH] = set.view
  const travel = set.travel ?? viewW * 2
  const climb = set.climb ?? 0
  const warnings: string[] = []
  const layers: ParallaxLayerImage[] = []
  const taken = new Set<string>()
  for (const [index, layer] of set.layers.entries()) {
    let name = layerName(layer, index)
    for (let n = 2; taken.has(name); n++) name = `${layerName(layer, index)}_${n}`
    taken.add(name)
    const speedY = layer.speedY ?? (climb > 0 ? layer.speed : 1)
    let png: DecodedPng
    let source: ParallaxLayerImage["source"]
    if (layer.sky) {
      // Tall enough to cover the climb at its speed; the bands scroll with it.
      png = skyBands(viewW, viewH + Math.ceil(climb * speedY), layer.sky)
      source = { kind: "sky", colors: layer.sky }
    } else if (layer.run) {
      const sprites = await Promise.all(layer.run.map((sprite) => readPicture(manifest, manifestDir, lock, setId, name, sprite, warnings)))
      const seed = layer.seed ?? seedFromName(name)
      const loop = layer.repeat ?? true
      // Unrepeated, the run reaches from the layer's left edge past everything the camera shows of it.
      const width = layer.width ?? Math.max(1, viewW + Math.ceil(travel * layer.speed) - (loop ? 0 : (layer.x ?? 0)))
      png = layRun(sprites.map((sprite) => sprite.png), width, { seed, step: layer.step, gap: layer.gap, jitter: layer.jitter, loop })
      source = { kind: "run", seed, sprites: sprites.map((sprite) => sprite.source) }
    } else {
      const picture = await readPicture(manifest, manifestDir, lock, setId, name, layer, warnings)
      png = picture.png
      source = picture.source
    }
    const repeat = layer.repeat ?? true
    // A run's picture leaves room for its feet to move by up to `jitter` either way.
    let bottom = (layer.bottom ?? viewH) + (layer.run ? (layer.jitter ?? 0) : 0)
    if (layer.extend) {
      const rows = layer.extend === true ? Math.max(0, viewH - bottom) : layer.extend
      png = extendDown(png, rows)
      bottom += rows
    }
    const image: ParallaxLayerImage = {
      name,
      png,
      speed: layer.speed,
      speedY,
      x: layer.x ?? 0,
      y: bottom - png.height,
      repeat,
      repeatY: layer.repeatY ?? false,
      source,
    }
    // A run is laid as a loop, so its join is as smooth as anywhere else in it.
    if (repeat && source.kind !== "sky" && source.kind !== "run") {
      image.seamRatio = seamRatio(png)
      if (travel * layer.speed > 0 && image.seamRatio > SEAM_WARN_RATIO) {
        warnings.push(
          `${name}: its sideways join is ${image.seamRatio.toFixed(1)} times rougher than the picture's own steps; ` +
            "loop it first (research/scripts/parallax.py loop) or set repeat: false",
        )
      }
    }
    if (image.repeatY && source.kind !== "sky") {
      image.seamRatioY = seamRatio(transpose(png))
      if (climb * speedY > 0 && image.seamRatioY > SEAM_WARN_RATIO) {
        warnings.push(`${name}: its vertical join is ${image.seamRatioY.toFixed(1)} times rougher than the picture's own steps`)
      }
    }
    if (climb > 0 && !image.repeatY && png.width >= viewW && image.y <= 0) {
      // A backdrop that fills the top of the view at the start must still fill it at the top of the climb.
      const shown = Math.round(climb * speedY)
      if (image.y + shown > 0) {
        warnings.push(`${name}: fills the top of the view at the start, but ${image.y + shown} empty row(s) show above it at the top of the climb; draw it taller or set repeatY`)
      }
    }
    if (!repeat && png.width >= viewW) {
      // A backdrop that does not loop must reach past both ends by the most it drifts.
      const needed = viewW + Math.ceil(travel * layer.speed)
      if (image.x > 0 || image.x + png.width < needed) {
        warnings.push(`${name}: does not repeat and covers columns ${image.x}..${image.x + png.width}; the camera shows 0..${needed} of it`)
      }
    }
    layers.push(image)
  }
  return { id: setId, view: [viewW, viewH], travel, climb, layers, warnings }
}

async function readPicture(
  manifest: Manifest,
  manifestDir: string,
  lock: Lock,
  setId: string,
  name: string,
  ref: Pick<ParallaxRunSprite, "asset" | "style" | "file">,
  warnings: string[],
): Promise<{ png: DecodedPng; source: PictureSource }> {
  if (ref.file) {
    const file = path.resolve(manifestDir, ref.file)
    return { png: decodePng(await readFile(file)), source: { kind: "file", path: file } }
  }
  const assetId = ref.asset!
  const style = ref.style ?? manifest.assets[assetId]!.styles[0]!
  const entry = lock.entries[lockKey(style, assetId)]
  if (!entry) throw new Error(`parallax ${setId}: ${style}/${assetId} has not been generated; run gen first`)
  const output = entry.outputs.find((candidate) => /\.png$/i.test(candidate.path)) ?? entry.outputs[0]
  if (!output) throw new Error(`parallax ${setId}: ${style}/${assetId} has no output in the lockfile`)
  const file = path.resolve(manifestDir, output.path)
  if (entry.outputs.length > 1) warnings.push(`${name}: ${style}/${assetId} has ${entry.outputs.length} outputs; using ${output.path}`)
  return { png: decodePng(await readFile(file)), source: { kind: "asset", style, asset: assetId, path: file } }
}

/** A run's default seed, so two runs of the same sprites in one set are laid differently. */
export function seedFromName(name: string): number {
  return createHash("sha256").update(name).digest().readUInt32BE(0)
}

/** mulberry32: a small seeded generator, so a seed lays the same run on every machine. */
function seededRandom(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

export interface RunOptions {
  seed: number
  /** How far across one sprite the next starts, as a fraction of its width. */
  step?: number
  /** Up to this many more pixels between sprites. */
  gap?: number
  /** Moves each foot up or down by up to this many pixels. */
  jitter?: number
  /** Lay the run as a seamless loop `width` wide instead of once. */
  loop?: boolean
}

/**
 * Lays sprites left to right in an overlapping run, the way
 * research/scripts/parallax.py skyline does: each starts `step` of the way
 * across the last plus up to `gap` px, is flipped at random, and is never the
 * sprite just used. Sprites stand on the picture's bottom row, moved up to
 * `jitter` px either way, and the picture is as tall as the tallest sprite
 * plus twice the jitter. Each sprite is drawn over the one to its left. As a
 * loop, sprites crossing the right edge carry on at the left, so the picture
 * repeats without a join.
 */
export function layRun(sprites: DecodedPng[], width: number, options: RunOptions): DecodedPng {
  const step = options.step ?? 0.72
  const gap = options.gap ?? 16
  const jitter = options.jitter ?? 0
  const random = seededRandom(options.seed)
  const tallest = Math.max(...sprites.map((sprite) => sprite.height))
  const height = tallest + 2 * jitter
  if (options.loop) {
    const widest = Math.max(...sprites.map((sprite) => sprite.width))
    if (width < widest) throw new Error(`a looping run must be at least as wide as its widest sprite (${widest} px); it is ${width}`)
  }
  const placed: { sprite: number; flip: boolean; x: number; y: number }[] = []
  let x = options.loop ? 0 : -Math.floor(random() * 32)
  let last = -1
  while (x < width) {
    let pick = Math.floor(random() * sprites.length)
    if (sprites.length > 1 && pick === last) pick = (pick + 1) % sprites.length
    last = pick
    const sprite = sprites[pick]!
    const flip = random() < 0.5
    const shift = jitter ? Math.floor(random() * (2 * jitter + 1)) - jitter : 0
    placed.push({ sprite: pick, flip, x, y: height - jitter - sprite.height + shift })
    x += Math.max(1, Math.floor(sprite.width * step + random() * gap))
  }
  // A loop draws each sprite again one width to either side, all in order from left to right.
  const copies = options.loop ? [-width, 0, width] : [0]
  const stamps = placed.flatMap((p) => copies.map((dx) => ({ ...p, x: p.x + dx }))).sort((a, b) => a.x - b.x)
  const pixels = Buffer.alloc(width * height * 4)
  for (const p of stamps) {
    const sprite = sprites[p.sprite]!
    for (let sy = 0; sy < sprite.height; sy++) {
      const y = p.y + sy
      if (y < 0 || y >= height) continue
      for (let sx = 0; sx < sprite.width; sx++) {
        const tx = p.x + sx
        if (tx < 0 || tx >= width) continue
        const from = (sy * sprite.width + (p.flip ? sprite.width - 1 - sx : sx)) * 4
        if (sprite.pixels[from + 3] === 0) continue
        sprite.pixels.copy(pixels, (y * width + tx) * 4, from, from + 4)
      }
    }
  }
  return { width, height, pixels }
}

/** The picture with its bottom row repeated `rows` more times, column by column. */
export function extendDown(png: DecodedPng, rows: number): DecodedPng {
  if (rows <= 0) return png
  const height = png.height + rows
  const pixels = Buffer.alloc(png.width * height * 4)
  png.pixels.copy(pixels, 0)
  const last = png.pixels.subarray((png.height - 1) * png.width * 4, png.height * png.width * 4)
  for (let y = png.height; y < height; y++) last.copy(pixels, y * png.width * 4)
  return { width: png.width, height, pixels }
}

/**
 * Where a layer sits on screen with the camera `camX` right of and `camY`
 * above its start. The camera is rounded to whole pixels first and each
 * layer's offset rounded from that; rounding the layers separately would
 * move them while the camera stands still. Godot and LDtk both checked
 * against this, including half-pixel offsets.
 */
export function layerScreenOffset(layer: Pick<ParallaxLayerImage, "speed" | "speedY">, camX: number, camY: number) {
  // Math.round sends a half pixel toward +x and +y on screen, as Godot and LDtk draw it.
  return { dx: Math.round(-Math.round(camX) * layer.speed), dy: Math.round(Math.round(camY) * layer.speedY) }
}

/** One frame of the set as the camera sees it. */
export function composeParallaxFrame(set: ResolvedParallaxSet, camX: number, camY: number): DecodedPng {
  const [w, h] = set.view
  const out: DecodedPng = { width: w, height: h, pixels: Buffer.alloc(w * h * 4) }
  for (const layer of set.layers) {
    const { dx, dy } = layerScreenOffset(layer, camX, camY)
    drawLayer(out, layer, layer.x + dx, layer.y + dy)
  }
  return out
}

/** Draws a layer over `out` with its picture's top-left at (left, top), repeating where it repeats. */
function drawLayer(out: DecodedPng, layer: Pick<ParallaxLayerImage, "png" | "repeat" | "repeatY">, left: number, top: number): void {
  const { width: w, height: h } = out
  const lw = layer.png.width
  const lh = layer.png.height
  for (let sy = 0; sy < h; sy++) {
    let ly = sy - top
    if (layer.repeatY) ly = ((ly % lh) + lh) % lh
    else if (ly < 0 || ly >= lh) continue
    for (let sx = 0; sx < w; sx++) {
      let lx = sx - left
      if (layer.repeat) lx = ((lx % lw) + lw) % lw
      else if (lx < 0 || lx >= lw) continue
      const src = (ly * lw + lx) * 4
      const alpha = layer.png.pixels[src + 3]! / 255
      if (alpha === 0) continue
      const dst = (sy * w + sx) * 4
      const below = out.pixels[dst + 3]! / 255
      const outAlpha = alpha + below * (1 - alpha)
      for (let c = 0; c < 3; c++) {
        out.pixels[dst + c] = Math.round((layer.png.pixels[src + c]! * alpha + out.pixels[dst + c]! * below * (1 - alpha)) / outAlpha)
      }
      out.pixels[dst + 3] = Math.round(outAlpha * 255)
    }
  }
}

/** Camera positions for `frames` steps from the start to the far end, eased at both ends. */
export function cameraPath(set: Pick<ResolvedParallaxSet, "travel" | "climb">, frames: number): Array<[number, number]> {
  return Array.from({ length: frames }, (_, i) => {
    const t = frames === 1 ? 0 : i / (frames - 1)
    const e = (1 - Math.cos(t * Math.PI)) / 2
    return [Math.round(e * set.travel), Math.round(e * set.climb)]
  })
}

function layerPngs(set: ResolvedParallaxSet, base: string): Array<{ layer: ParallaxLayerImage; file: string; png: Buffer }> {
  return set.layers.map((layer) => ({
    layer,
    file: `${path.basename(base)}-${layer.name}.png`,
    png: encodeRgbaPng(layer.png.width, layer.png.height, layer.png.pixels),
  }))
}

export interface ParallaxExport {
  /** Path of the main document, then every picture it references. */
  files: Array<{ path: string; data: Buffer | string }>
  options: Record<string, unknown>
}

/**
 * A Tiled map (JSON, .tmj) with one image layer per parallax layer. The map
 * is the level: `travel` wider and `climb` taller than the view, with the
 * start view in its bottom-left corner. Tiled moves a layer by (1 - factor)
 * x the view's centre measured from the map's parallax origin. The origin
 * is left at (0, 0), and each layer's offset takes back what the start
 * view's centre would move it, so loaders that ignore the origin agree, and
 * so does Tiled 1.11+, whose editor applies a non-zero origin with the
 * opposite sign to its manual (src/tiled/mapscene.cpp, parallaxOffset).
 */
export function exportTiled(set: ResolvedParallaxSet, base: string): ParallaxExport {
  const [vw, vh] = set.view
  const grid = 16
  const mapW = vw + set.travel
  const mapH = vh + set.climb
  const pictures = layerPngs(set, base)
  const layers = pictures.map(({ layer, file }, index) => ({
    id: index + 1,
    name: layer.name,
    type: "imagelayer",
    image: file,
    imagewidth: layer.png.width,
    imageheight: layer.png.height,
    offsetx: tiledNumber(layer.x - (1 - layer.speed) * (vw / 2)),
    offsety: tiledNumber(layer.y + set.climb - (1 - layer.speedY) * (set.climb + vh / 2)),
    parallaxx: layer.speed,
    parallaxy: layer.speedY,
    repeatx: layer.repeat,
    repeaty: layer.repeatY,
    opacity: 1,
    visible: true,
    x: 0,
    y: 0,
  }))
  const map = {
    type: "map",
    version: "1.10",
    tiledversion: "1.11.0",
    orientation: "orthogonal",
    renderorder: "right-down",
    infinite: false,
    width: Math.ceil(mapW / grid),
    height: Math.ceil(mapH / grid),
    tilewidth: grid,
    tileheight: grid,
    nextlayerid: layers.length + 1,
    nextobjectid: 1,
    compressionlevel: -1,
    tilesets: [],
    layers,
    properties: [
      { name: "pixelkiln_view", type: "string", value: `${vw}x${vh}` },
      { name: "pixelkiln_start", type: "string", value: `0,${set.climb}` },
    ],
  }
  return {
    files: [{ path: `${base}.tmj`, data: JSON.stringify(map, null, 2) + "\n" }, ...pictures.map((p) => ({ path: path.join(path.dirname(base), p.file), data: p.png }))],
    options: { format: "tiled", start: [0, set.climb] },
  }
}

function tiledNumber(value: number): number {
  return Number(value.toFixed(6))
}

function godotNumber(value: number): string {
  return Number.isInteger(value) ? String(value) : String(Number(value.toFixed(6)))
}

/**
 * A Godot 4 scene: one Parallax2D per layer, far to near, each holding a
 * Sprite2D. Godot puts a layer at its position when the camera's top-left is
 * at the world origin, and the start view here is at (0, climb), so each
 * layer's scroll_offset takes back what that start would move it. Pixel art
 * needs nearest filtering, set on the root and inherited.
 */
export function exportGodot(set: ResolvedParallaxSet, base: string): ParallaxExport {
  const [vw, vh] = set.view
  const pictures = layerPngs(set, base)
  const lines: string[] = [`[gd_scene load_steps=${pictures.length + 1} format=3]`, ""]
  pictures.forEach(({ file }, index) => {
    lines.push(`[ext_resource type="Texture2D" path=${JSON.stringify(`./${file}`)} id="${index + 1}_layer"]`)
  })
  lines.push("", `[node name=${JSON.stringify(path.basename(base))} type="Node2D"]`, "texture_filter = 1")
  pictures.forEach(({ layer }, index) => {
    lines.push("", `[node name=${JSON.stringify(layer.name)} type="Parallax2D" parent="."]`)
    lines.push(`scroll_scale = Vector2(${godotNumber(layer.speed)}, ${godotNumber(layer.speedY)})`)
    const offsetY = -set.climb * (1 - layer.speedY)
    if (offsetY !== 0) lines.push(`scroll_offset = Vector2(0, ${godotNumber(offsetY)})`)
    if (layer.repeat || layer.repeatY) {
      // Godot keeps a repeating layer within one repeat of the screen's edge
      // and draws repeat_times + 1 copies centred on it, so the sprite sits
      // inside the first repeat and there are copies on both sides.
      lines.push(`repeat_size = Vector2(${layer.repeat ? layer.png.width : 0}, ${layer.repeatY ? layer.png.height : 0})`)
      const reach = (view: number, size: number) => 2 * (Math.ceil(view / size) + 1) - 1
      const times = Math.max(layer.repeat ? reach(vw, layer.png.width) : 1, layer.repeatY ? reach(vh, layer.png.height) : 1)
      lines.push(`repeat_times = ${times}`)
    }
    lines.push("", `[node name="Sprite2D" type="Sprite2D" parent=${JSON.stringify(layer.name)}]`)
    lines.push(`texture = ExtResource("${index + 1}_layer")`, "centered = false")
    const mod = (value: number, size: number) => ((value % size) + size) % size
    const px = layer.repeat ? mod(layer.x, layer.png.width) : layer.x
    const py = layer.repeatY ? mod(layer.y + set.climb, layer.png.height) : layer.y + set.climb
    lines.push(`position = Vector2(${px}, ${py})`)
  })
  return {
    files: [{ path: `${base}.tscn`, data: lines.join("\n") + "\n" }, ...pictures.map((p) => ({ path: path.join(path.dirname(base), p.file), data: p.png }))],
    options: { format: "godot", start: [0, set.climb] },
  }
}

function uuid(...parts: Array<string | number>): string {
  const hex = createHash("sha256").update(parts.join("\u0000")).digest("hex")
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`
}

/** LDtk's tile size for parallax layers. */
const LDTK_GRID = 16

/**
 * An LDtk project with one level the size of the camera's travel.
 *
 * LDtk has no image layer and draws a tile only on its layer's grid, so each
 * parallax layer is a Tiles layer over a tileset made for it: the stretch of
 * the layer the camera can see across the level, repeats included, cut into
 * 16 px tiles. The factor is 1 - speed, with scaling off so the layer stays
 * on the pixel grid. LDtk draws a layer offset by (camera centre - level
 * centre) x factor (`Camera.getParallaxOffsetX` in LDtk's source), so each
 * layer is placed where that offset puts it on the preview's position at the
 * start of the level, with the part of a tile left over in the layer's pixel
 * offset.
 */
export function exportLdtk(set: ResolvedParallaxSet, base: string): ParallaxExport {
  const [vw, vh] = set.view
  const grid = LDTK_GRID
  const levelW = vw + set.travel
  const levelH = vh + set.climb
  const name = path.basename(base)
  const files: Array<{ path: string; data: Buffer | string }> = []
  const warnings: string[] = []
  const identifiers = new Set<string>()
  const layerDefs: unknown[] = []
  const tilesets: unknown[] = []
  const layerInstances: unknown[] = []
  const levelUid = 1000
  let uid = 1
  for (const [index, layer] of set.layers.entries()) {
    const factorX = 1 - layer.speed
    const factorY = 1 - layer.speedY
    // The canvas columns and rows this layer shows over the whole level.
    const x0 = 0
    const x1 = vw + Math.ceil(set.travel * layer.speed)
    const y0 = -Math.ceil(set.climb * layer.speedY)
    const y1 = vh
    // LDtk draws a tile at its cell plus round(offset + (camera centre - layer
    // centre) x factor), where the layer is the level less its own offset, so
    // the offset feeds back into the centre. Pick the offset within a tile
    // whose unrounded value is nearest a whole pixel, so camera positions
    // round as the preview does, and put what is left of a tile into
    // transparent padding at the start of the picture, so the start view
    // lands exactly on any speed.
    const place = (canvas: number, start: number, extent: number, factor: number) => {
      let best = { off: 0, rounded: 0, frac: Infinity }
      for (let off = 0; off < grid; off++) {
        const shift = off + (start - (extent - off) / 2) * factor
        const frac = Math.abs(shift - Math.round(shift))
        if (frac < best.frac - 1e-9) best = { off, rounded: Math.round(shift), frac }
      }
      const pad = (((canvas - best.rounded) % grid) + grid) % grid
      return { off: best.off, pad, cell: (canvas - best.rounded - pad) / grid, cells: Math.ceil((extent - best.off) / grid) }
    }
    const px = place(x0, vw / 2, levelW, factorX)
    const py = place(y0 + set.climb, levelH - vh / 2, levelH, factorY)
    const offX = px.off
    const offY = py.off
    const cols = Math.ceil((px.pad + x1 - x0) / grid)
    const rows = Math.ceil((py.pad + y1 - y0) / grid)
    const span: DecodedPng = { width: cols * grid, height: rows * grid, pixels: Buffer.alloc(cols * grid * rows * grid * 4) }
    drawLayer(span, layer, px.pad + layer.x - x0, py.pad + layer.y - y0)
    const file = `${name}-${layer.name}.png`
    files.push({ path: path.join(path.dirname(base), file), data: encodeRgbaPng(span.width, span.height, span.pixels) })

    const tilesetUid = uid++
    const layerUid = uid++
    let identifier = layer.name.replace(/[^A-Za-z0-9_]/g, "_")
    for (let n = 2; identifiers.has(identifier); n++) identifier = `${layer.name.replace(/[^A-Za-z0-9_]/g, "_")}_${n}`
    identifiers.add(identifier)
    tilesets.push({
      __cWid: cols,
      __cHei: rows,
      identifier: `${identifier}_tiles`,
      uid: tilesetUid,
      relPath: file,
      embedAtlas: null,
      pxWid: span.width,
      pxHei: span.height,
      tileGridSize: grid,
      spacing: 0,
      padding: 0,
      tags: [],
      tagsSourceEnumUid: null,
      enumTags: [],
      customData: [],
      savedSelections: [],
      cachedPixelData: null,
    })
    layerDefs.push({
      __type: "Tiles",
      identifier,
      type: "Tiles",
      uid: layerUid,
      doc: `Moves ${layer.speed} of the camera's speed sideways and ${layer.speedY} vertically.`,
      uiColor: null,
      gridSize: grid,
      guideGridWid: 0,
      guideGridHei: 0,
      displayOpacity: 1,
      inactiveOpacity: 1,
      hideInList: false,
      hideFieldsWhenInactive: true,
      canSelectWhenInactive: true,
      renderInWorldView: true,
      pxOffsetX: 0,
      pxOffsetY: 0,
      parallaxFactorX: Number(factorX.toFixed(6)),
      parallaxFactorY: Number(factorY.toFixed(6)),
      parallaxScaling: false,
      requiredTags: [],
      excludedTags: [],
      autoTilesKilledByOtherLayerUid: null,
      uiFilterTags: [],
      useAsyncRender: false,
      intGridValues: [],
      intGridValuesGroups: [],
      autoRuleGroups: [],
      autoSourceLayerDefUid: null,
      tilesetDefUid: tilesetUid,
      tilePivotX: 0,
      tilePivotY: 0,
      biomeFieldUid: null,
    })
    const cellsWide = px.cells
    const cellsHigh = py.cells
    const gridTiles: unknown[] = []
    let dropped = 0
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const cx = px.cell + c
        const cy = py.cell + r
        if (tileEmpty(span, c * grid, r * grid, grid)) continue
        if (cx < 0 || cy < 0 || cx >= cellsWide || cy >= cellsHigh) {
          dropped++
          continue
        }
        gridTiles.push({ px: [cx * grid, cy * grid], src: [c * grid, r * grid], f: 0, t: r * cols + c, d: [cy * cellsWide + cx], a: 1 })
      }
    }
    if (dropped) {
      warnings.push(
        `${layer.name}: ${dropped} tile(s) fall past the level's edge, which LDtk does not draw` +
          (layer.speed > 1 || layer.speedY > 1 ? "; a layer faster than the camera shows more than the level holds" : ""),
      )
    }
    layerInstances.unshift({
      __identifier: identifier,
      __type: "Tiles",
      __cWid: cellsWide,
      __cHei: cellsHigh,
      __gridSize: grid,
      __opacity: 1,
      __pxTotalOffsetX: offX,
      __pxTotalOffsetY: offY,
      __tilesetDefUid: tilesetUid,
      __tilesetRelPath: file,
      iid: uuid(name, "layer", index),
      levelId: levelUid,
      layerDefUid: layerUid,
      pxOffsetX: offX,
      pxOffsetY: offY,
      visible: true,
      optionalRules: [],
      intGridCsv: [],
      autoLayerTiles: [],
      seed: 1000 + index,
      overrideTilesetUid: null,
      gridTiles,
      entityInstances: [],
    })
  }
  // LDtk lists layers nearest first.
  layerDefs.reverse()
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
    iid: uuid(name, "project"),
    jsonVersion: LDTK_JSON_VERSION,
    appBuildId: 473702,
    nextUid: Math.max(uid, levelUid + 1),
    identifierStyle: "Capitalize",
    toc: [],
    worldLayout: "Free",
    worldGridWidth: 256,
    worldGridHeight: 256,
    defaultLevelWidth: levelW,
    defaultLevelHeight: levelH,
    defaultPivotX: 0,
    defaultPivotY: 0,
    defaultGridSize: grid,
    defaultEntityWidth: grid,
    defaultEntityHeight: grid,
    bgColor: "#40465B",
    defaultLevelBgColor: "#000000",
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
    levelNamePattern: "Level_%idx",
    tutorialDesc: null,
    customCommands: [],
    flags: ["ExportOldTableOfContentData", "UseMultilinesType"],
    defs: { layers: layerDefs, entities: [], tilesets, enums: [], externalEnums: [], levelFields: [] },
    levels: [{
      identifier: "Parallax",
      iid: uuid(name, "level"),
      uid: levelUid,
      worldX: 0,
      worldY: 0,
      worldDepth: 0,
      pxWid: levelW,
      pxHei: levelH,
      __bgColor: "#000000",
      bgColor: null,
      useAutoIdentifier: false,
      bgRelPath: null,
      bgPos: null,
      bgPivotX: 0.5,
      bgPivotY: 0.5,
      __smartColor: "#ADADB5",
      __bgPos: null,
      externalRelPath: null,
      fieldInstances: [],
      layerInstances,
      __neighbours: [],
    }],
    worlds: [],
    dummyWorldIid: uuid(name, "world"),
  }
  return {
    files: [{ path: `${base}.ldtk`, data: JSON.stringify(project, null, 2) + "\n" }, ...files],
    options: { format: "ldtk", grid, start: [0, set.climb], warnings },
  }
}

function tileEmpty(png: DecodedPng, x0: number, y0: number, grid: number): boolean {
  for (let y = y0; y < y0 + grid; y++) {
    for (let x = x0; x < x0 + grid; x++) {
      if (png.pixels[(y * png.width + x) * 4 + 3]! !== 0) return false
    }
  }
  return true
}

export function exportParallax(set: ResolvedParallaxSet, format: ParallaxFormat, base: string): ParallaxExport {
  if (format === "tiled") return exportTiled(set, base)
  if (format === "godot") return exportGodot(set, base)
  return exportLdtk(set, base)
}

/**
 * A page that scrolls the set in a browser, the same way the frames above are
 * composed: pictures inline, nearest-neighbour scaling, a camera that runs
 * to the far end and back, and a slider to stop it anywhere.
 */
export function previewHtml(set: ResolvedParallaxSet, scale = 3): string {
  const [vw, vh] = set.view
  const layers = set.layers.map((layer) => ({
    name: layer.name,
    src: `data:image/png;base64,${encodeRgbaPng(layer.png.width, layer.png.height, layer.png.pixels).toString("base64")}`,
    w: layer.png.width,
    h: layer.png.height,
    x: layer.x,
    y: layer.y,
    speed: layer.speed,
    speedY: layer.speedY,
    repeat: layer.repeat,
    repeatY: layer.repeatY,
  }))
  const data = JSON.stringify({ view: [vw, vh], travel: set.travel, climb: set.climb, layers }).replace(/</g, "\\u003c")
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${set.id.replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`)} parallax</title>
<style>
  :root { color-scheme: dark; }
  body { margin: 0; background: #111318; color: #d8dae0; font: 14px/1.4 system-ui, sans-serif; display: grid; place-items: center; min-height: 100vh; }
  main { display: grid; gap: 12px; padding: 16px; max-width: 100%; }
  canvas { image-rendering: pixelated; width: ${vw * scale}px; max-width: 100%; height: auto; background: #000; }
  label { display: flex; gap: 8px; align-items: center; }
  input[type=range] { flex: 1; }
  table { border-collapse: collapse; font-variant-numeric: tabular-nums; }
  td, th { padding: 2px 10px 2px 0; text-align: left; }
</style>
</head>
<body>
<main>
  <canvas id="view" width="${vw}" height="${vh}"></canvas>
  <label><button id="play" type="button">Pause</button> camera <input id="cam" type="range" min="0" max="1000" value="0"> <output id="pos"></output></label>
  <table><thead><tr><th>Layer</th><th>speed</th><th>speedY</th><th>repeat</th></tr></thead><tbody id="rows"></tbody></table>
</main>
<script>
const set = ${data};
const ctx = document.getElementById("view").getContext("2d");
ctx.imageSmoothingEnabled = false;
const images = set.layers.map((layer) => Object.assign(new Image(), { src: layer.src }));
const rows = document.getElementById("rows");
for (const layer of set.layers) {
  const tr = rows.insertRow();
  for (const value of [layer.name, layer.speed, layer.speedY, [layer.repeat && "x", layer.repeatY && "y"].filter(Boolean).join(" ") || "no"]) tr.insertCell().textContent = value;
}
const slider = document.getElementById("cam");
const pos = document.getElementById("pos");
let playing = true;
let t0 = performance.now();
document.getElementById("play").onclick = (event) => {
  playing = !playing;
  event.target.textContent = playing ? "Pause" : "Play";
  t0 = performance.now() - (slider.value / 1000) * 6000;
};
slider.oninput = () => { playing = false; document.getElementById("play").textContent = "Play"; };
function draw(u) {
  const e = (1 - Math.cos(u * Math.PI)) / 2;
  const camX = Math.round(e * set.travel);
  const camY = Math.round(e * set.climb);
  pos.textContent = camX + ", " + camY;
  ctx.clearRect(0, 0, set.view[0], set.view[1]);
  set.layers.forEach((layer, i) => {
    const left = layer.x + Math.round(-camX * layer.speed);
    const top = layer.y + Math.round(camY * layer.speedY);
    const xs = layer.repeat ? [] : [left];
    if (layer.repeat) for (let x = ((left % layer.w) + layer.w) % layer.w - layer.w; x < set.view[0]; x += layer.w) xs.push(x);
    const ys = layer.repeatY ? [] : [top];
    if (layer.repeatY) for (let y = ((top % layer.h) + layer.h) % layer.h - layer.h; y < set.view[1]; y += layer.h) ys.push(y);
    for (const y of ys) for (const x of xs) ctx.drawImage(images[i], x, y);
  });
}
function frame(now) {
  if (playing) {
    const u = ((now - t0) % 12000) / 6000;
    const v = u <= 1 ? u : 2 - u;
    slider.value = Math.round(v * 1000);
  }
  draw(slider.value / 1000);
  requestAnimationFrame(frame);
}
Promise.all(images.map((image) => image.decode())).then(() => requestAnimationFrame(frame));
</script>
</body>
</html>
`
}
