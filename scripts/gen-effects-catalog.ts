/**
 * Writes the data behind the website's effects catalog (/effects/catalog):
 *
 * - PixelLab's VFX presets, read live from the workbench (`vfx presets`).
 *   Free, but it needs PIXELLAB_API_KEY; pass --keep-presets to leave the
 *   presets already in the file alone.
 * - Every pixelfx effect, read from the installed library, and one still
 *   frame of each standalone effect, rendered here.
 *
 * With --render-presets, each preset that has no picture yet is also rendered
 * by the workbench (free, but every render is saved to the account's My
 * effects as "pixelkiln catalog: <preset>") and its GIF and one still are
 * kept. --skip a,b leaves those presets without one.
 *
 *   npx tsx scripts/gen-effects-catalog.ts [--keep-presets] [--render-presets] [--skip a,b] [--env-dir <dir with .env.local>]
 */
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { loadEnvFiles } from "../src/env.ts"
import { listPixelfxEffects, loadPixelfx, renderPixelfx } from "../src/pixelfx-vfx.ts"
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
  if (effect.needsCharacter) return entry
  // A still for the grid: the fullest frame of a low-rate render.
  const render = renderPixelfx(lib, { effect: effect.id, fps: 8 })
  let best = render.frames[0]!
  let most = -1
  for (const frame of render.frames) {
    let filled = 0
    for (let i = 3; i < frame.length; i += 4) if (frame[i]! > 0) filled++
    if (filled > most) {
      most = filled
      best = frame
    }
  }
  const file = `${effect.id.replace("/", "-")}.png`
  writeFileSync(path.join(thumbs, file), encodeRgbaPng(render.width, render.height, best))
  return { ...entry, still: `/effects/pixelfx/${file}` }
})

writeFileSync(
  dataFile,
  `${JSON.stringify({ presets, pixelfx: { version: lib.version, categories: lib.categories, effects } }, null, 2)}\n`,
)
console.log(`${presets.items.length} presets (${presets.items.filter((preset) => preset.gif).length} with a picture), ${effects.length} pixelfx effects, ${effects.filter((e) => "still" in e).length} stills`)
