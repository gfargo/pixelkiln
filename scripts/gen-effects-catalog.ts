/**
 * Writes the data behind the website's effects catalog (/effects/catalog):
 *
 * - PixelLab's VFX presets, read live from the workbench (`vfx presets`).
 *   Free, but it needs PIXELLAB_API_KEY; pass --keep-presets to leave the
 *   presets already in the file alone.
 * - Every pixelfx effect, read from the installed library, with a still and
 *   an animated WebP of each, rendered here (the animation needs img2webp).
 *   Effects that need a character are acted out with pixelfx's stand-in.
 *
 * With --render-presets, each preset that has no picture yet is also rendered
 * by the workbench (free, but every render is saved to the account's My
 * effects as "pixelkiln catalog: <preset>") and its GIF and one still are
 * kept. --skip a,b leaves those presets without one.
 *
 *   npx tsx scripts/gen-effects-catalog.ts [--keep-presets] [--render-presets] [--skip a,b] [--env-dir <dir with .env.local>]
 */
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs"
import { execFileSync, spawnSync } from "node:child_process"
import { tmpdir } from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { loadEnvFiles } from "../src/env.ts"
import { listPixelfxEffects, loadPixelfx, renderPixelfx, type PixelfxModule } from "../src/pixelfx-vfx.ts"
import { mcpClientFromEnv } from "../src/pixellab-mcp.ts"
import { describeVfx, makeVfx, sliceVfxSheet } from "../src/pixellab-vfx.ts"
import { decodePng, encodeRgbaPng } from "../src/png.ts"

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const dataFile = path.join(root, "website/app/lib/effects-catalog.json")
const thumbs = path.join(root, "website/public/effects/pixelfx")
const today = new Date().toISOString().slice(0, 10)

interface Preset {
  name: string
  summary: string
  width: number
  height: number
  frames: number
  loop: boolean
  /** A workbench render with no sprite: its GIF and its fullest frame. */
  gif?: string
  still?: string
}

/** `- name: description. (96x112, 8 frames, loop)` lines from the workbench's own listing. */
export function parsePresets(text: string): Preset[] {
  const presets: Preset[] = []
  for (const line of text.split(/\r?\n/)) {
    const match = /^- ([a-z0-9_]+): (.+) \((\d+)x(\d+), (\d+) frames, (loop|one-shot)\)\s*$/.exec(line)
    if (!match) continue
    // The first sentence says what the effect is; the rest compares it with other presets.
    const summary = /^(.*?[.!?])(\s|$)/.exec(match[2]!)?.[1] ?? match[2]!
    presets.push({
      name: match[1]!,
      summary,
      width: Number(match[3]),
      height: Number(match[4]),
      frames: Number(match[5]),
      loop: match[6] === "loop",
    })
  }
  return presets
}

/** Presets that only light the sprite they are given: with none, their export is empty. */
const LIGHTS_A_SPRITE = new Set(["firelight", "light_sweep", "rim_glow"])
const litSprite = path.join(root, "website/public/showcase/palette/chest.png")

const option = (flag: string) => {
  const at = process.argv.indexOf(flag)
  return at >= 0 ? process.argv[at + 1] : undefined
}
const presetArt = path.join(root, "website/public/effects/presets")
const previous = existsSync(dataFile)
  ? (JSON.parse(readFileSync(dataFile, "utf8")) as { presets?: { readOn: string; items: Preset[] } })
  : {}
let presets = previous.presets
const needsPixelLab = !process.argv.includes("--keep-presets") || process.argv.includes("--render-presets")
if (needsPixelLab) loadEnvFiles(path.resolve(option("--env-dir") ?? "."))
if (!process.argv.includes("--keep-presets")) {
  const items = parsePresets(await describeVfx(mcpClientFromEnv(), "presets"))
  if (!items.length) throw new Error("PixelLab's preset listing was not understood: no preset lines found")
  presets = { readOn: today, items }
}
if (!presets) throw new Error("no presets in the catalog yet: run without --keep-presets")

// Pictures already on disk stay attached whether or not this run renders any.
for (const preset of presets.items) {
  if (existsSync(path.join(presetArt, `${preset.name}.gif`)) && existsSync(path.join(presetArt, `${preset.name}-still.png`))) {
    preset.gif = `/effects/presets/${preset.name}.gif`
    preset.still = `/effects/presets/${preset.name}-still.png`
  }
}
if (process.argv.includes("--render-presets")) {
  const skip = new Set((option("--skip") ?? "").split(",").filter(Boolean))
  const client = mcpClientFromEnv()
  const scratch = mkdtempSync(path.join(tmpdir(), "pixelkiln-catalog-"))
  mkdirSync(presetArt, { recursive: true })
  const failed: string[] = []
  for (const preset of presets.items) {
    if (preset.gif || skip.has(preset.name)) continue
    const out = path.join(scratch, preset.name)
    // PixelLab stops a render after 120 s and saves nothing; the same call usually works the next time.
    for (let attempt = 1; attempt <= 3 && !preset.gif; attempt++) {
      try {
        const made = await makeVfx(client, {
          preset: preset.name,
          name: `pixelkiln catalog: ${preset.name}`,
          sprite: LIGHTS_A_SPRITE.has(preset.name) ? litSprite : undefined,
          out,
          force: true,
        })
        const frames = sliceVfxSheet(readFileSync(made.paths.sheet), made, JSON.parse(readFileSync(made.paths.atlas, "utf8")))
        let best = frames[0]!
        let most = -1
        for (const frame of frames) {
          const { pixels } = decodePng(frame)
          let filled = 0
          for (let i = 3; i < pixels.length; i += 4) if (pixels[i]! > 0) filled++
          if (filled > most) {
            most = filled
            best = frame
          }
        }
        copyFileSync(made.paths.gif, path.join(presetArt, `${preset.name}.gif`))
        writeFileSync(path.join(presetArt, `${preset.name}-still.png`), best)
        if (most === 0) throw new Error("the render is empty")
        Object.assign(preset, { frames: made.frames, loop: made.loop })
        preset.gif = `/effects/presets/${preset.name}.gif`
        preset.still = `/effects/presets/${preset.name}-still.png`
        console.log(`rendered ${preset.name}: ${made.width}x${made.height}, ${made.frames} frames`)
      } catch (error) {
        console.log(`${preset.name}, attempt ${attempt}: ${error instanceof Error ? error.message.split("\n")[0] : String(error)}`)
      }
    }
    if (!preset.gif) failed.push(preset.name)
    // Save progress after every preset, so a stopped run resumes where it was.
    if (existsSync(dataFile)) {
      const current = JSON.parse(readFileSync(dataFile, "utf8")) as Record<string, unknown>
      writeFileSync(dataFile, `${JSON.stringify({ ...current, presets }, null, 2)}\n`)
    }
  }
  rmSync(scratch, { recursive: true, force: true })
  if (failed.length) console.log(`no picture for: ${failed.join(", ")}`)
}

const lib = await loadPixelfx()
const MAX_FRAMES = 30
/** What one animation may weigh before it is thinned. */
const ANIM_BUDGET = 90_000
// Animations are written with libwebp's img2webp (brew install webp); without it only stills are made.
const animate = spawnSync("img2webp", ["-version"]).status === 0
if (!animate) console.log("img2webp not found: writing stills only")

/**
 * An effect that needs a character, acted out with pixelfx's own stand-in
 * figure and target the way its tools/act.mjs shows it: wind-up, the effect,
 * recovery. After renderAct in pixelfx's tools/lib/fxlib.mjs (MIT, Copyright
 * (c) 2026 Patch), without the backdrop or the screen shake.
 */
function renderActed(mod: PixelfxModule, fps: number): { width: number; height: number; frames: Buffer[] } {
  // These calls are in pixelfx's core but outside what PixelKiln itself uses, so they are not in its types.
  const core = lib.core as unknown as {
    actBounds(mod: PixelfxModule): { x0: number; y0: number; x1: number; y1: number }
    createAct(mod: PixelfxModule, o: { x: number; y: number }): {
      t: number
      update(dt: number): void
      draw(frame: unknown, show: { body: boolean; target: boolean }): void
      done(): boolean
    }
  }
  const bounds = core.actBounds(mod)
  const pad = 6
  const width = bounds.x1 - bounds.x0 + pad * 2
  const height = bounds.y1 - bounds.y0 + pad * 2
  const frame = lib.core.createFrame(width, height)
  const act = core.createAct(mod, { x: pad - bounds.x0, y: pad - bounds.y0 })
  const loop = mod.meta?.loop ?? false
  const limit = Math.round((loop ? (mod.meta?.duration ?? 1) - act.t : 8) * fps)
  const frames: Buffer[] = []
  const show = () => {
    lib.core.clearFrame(frame)
    act.draw(frame, { body: true, target: true })
    const rgba = new Uint8ClampedArray(width * height * 4)
    lib.core.composite(frame, rgba, null)
    frames.push(Buffer.from(rgba.buffer, rgba.byteOffset, rgba.byteLength))
  }
  show()
  for (let i = 0; i < limit && !act.done(); i++) {
    act.update(1 / fps)
    show()
  }
  return { width, height, frames }
}
rmSync(thumbs, { recursive: true, force: true })
mkdirSync(thumbs, { recursive: true })
const effects = listPixelfxEffects(lib).map((effect) => {
  const entry = {
    id: effect.id,
    category: effect.category,
    name: effect.name,
    description: effect.description,
    width: effect.width,
    height: effect.height,
    duration: Number(effect.duration.toFixed(2)),
    loop: effect.loop,
    needsCharacter: effect.needsCharacter,
    options: Object.keys(effect.options),
  }
  // Ten frames a second is enough to read the motion; long effects are thinned to at most MAX_FRAMES.
  const render = effect.needsCharacter
    ? renderActed(lib.effects[effect.id]!, 10)
    : renderPixelfx(lib, { effect: effect.id, fps: 10 })
  const step = Math.max(1, Math.ceil(render.frames.length / MAX_FRAMES))
  const frames = render.frames.filter((_, index) => index % step === 0)
  // The still, for the grid under reduced motion: the fullest frame.
  let best = frames[0]!
  let most = -1
  for (const frame of frames) {
    let filled = 0
    for (let i = 3; i < frame.length; i += 4) if (frame[i]! > 0) filled++
    if (filled > most) {
      most = filled
      best = frame
    }
  }
  const base = effect.id.replace("/", "-")
  writeFileSync(path.join(thumbs, `${base}.png`), encodeRgbaPng(render.width, render.height, best))
  const pictures = { still: `/effects/pixelfx/${base}.png`, art: { width: render.width, height: render.height } }
  if (!animate) return { ...entry, ...pictures }
  const work = mkdtempSync(path.join(tmpdir(), "pixelkiln-anim-"))
  const files = frames.map((frame, index) => {
    const file = path.join(work, `${String(index).padStart(3, "0")}.png`)
    writeFileSync(file, encodeRgbaPng(render.width, render.height, frame))
    return file
  })
  const out = path.join(thumbs, `${base}.webp`)
  // Lossy WebP keeps pixel edges readable at a fraction of the lossless size. A file still over
  // the budget is tried again with every second, then every third, frame and a lower quality.
  for (const [thin, quality] of [[1, 74], [2, 64], [3, 54]] as const) {
    const kept = files.filter((_, index) => index % thin === 0)
    const args = ["-loop", "0", "-lossy", "-q", String(quality), "-m", "4"]
    // One-shots rest on their last frame for a moment before starting over.
    kept.forEach((file, index) => args.push("-d", String(index === kept.length - 1 && !effect.loop ? 900 : step * thin * 100), file))
    execFileSync("img2webp", [...args, "-o", out], { stdio: "ignore" })
    if (statSync(out).size <= ANIM_BUDGET) break
  }
  rmSync(work, { recursive: true, force: true })
  return { ...entry, ...pictures, anim: `/effects/pixelfx/${base}.webp` }
})

writeFileSync(
  dataFile,
  `${JSON.stringify({ presets, pixelfx: { version: lib.version, categories: lib.categories, effects } }, null, 2)}\n`,
)
console.log(`${presets.items.length} presets (${presets.items.filter((preset) => preset.gif).length} with a picture), ${effects.length} pixelfx effects, ${effects.filter((e) => "anim" in e).length} animated`)
