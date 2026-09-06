import path from "node:path"
import { copyFileSync } from "node:fs"

const [source, extractFlag, output] = process.argv.slice(2)
if (!source || extractFlag !== "--extract" || !output) {
  process.stderr.write("expected: source --extract output\n")
  process.exit(2)
}

copyFileSync(source, output)
const low = path.basename(source).includes("low-confidence")
const mismatch = path.basename(source).includes("wrong-size")
const differentGrid = path.basename(source).includes("different-grid")
const differentPhase = path.basename(source).includes("different-phase")
process.stdout.write(JSON.stringify({
  step_x: differentGrid ? 2 : 1,
  step_y: 1,
  phase_x: differentPhase ? 0.5 : 0,
  phase_y: 0,
  cols: mismatch ? 3 : 2,
  rows: 2,
  consensus: low ? "fastmode:lowconf" : "fast:ac+rl(S)",
}, null, 1) + `\nextract -> ${output}\n`)
