/**
 * Writes the data behind the website's effects catalog (/effects/catalog):
 *
 * - PixelLab's VFX presets, read live from the workbench (`vfx presets`).
 *   Free, but it needs PIXELLAB_API_KEY; pass --keep-presets to leave the
 *   presets already in the file alone.
 * - Every pixelfx effect, read from the installed library, and one still
 *   frame of each standalone effect, rendered here.
 *
 *   npx tsx scripts/gen-effects-catalog.ts [--keep-presets] [--env-dir <dir with .env.local>]
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { loadEnvFiles } from "../src/env.ts"
import { listPixelfxEffects, loadPixelfx, renderPixelfx } from "../src/pixelfx-vfx.ts"
import { mcpClientFromEnv } from "../src/pixellab-mcp.ts"
import { describeVfx } from "../src/pixellab-vfx.ts"
import { encodeRgbaPng } from "../src/png.ts"

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

const previous = existsSync(dataFile) ? (JSON.parse(readFileSync(dataFile, "utf8")) as { presets?: unknown }) : {}
let presets = previous.presets
if (!process.argv.includes("--keep-presets")) {
  const envDir = process.argv.indexOf("--env-dir")
  loadEnvFiles(envDir >= 0 ? path.resolve(process.argv[envDir + 1] ?? ".") : process.cwd())
  const items = parsePresets(await describeVfx(mcpClientFromEnv(), "presets"))
  if (!items.length) throw new Error("PixelLab's preset listing was not understood: no preset lines found")
  presets = { readOn: today, items }
}
if (!presets) throw new Error("no presets in the catalog yet: run without --keep-presets")

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
console.log(`${(presets as { items: unknown[] }).items.length} presets, ${effects.length} pixelfx effects, ${effects.filter((e) => "still" in e).length} stills`)
