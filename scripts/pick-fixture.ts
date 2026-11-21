/**
 * Serve the pick page with fake candidates, for working on the page itself.
 *
 *   npx tsx scripts/pick-fixture.ts [--assets 56] [--port 4173] [--open]
 *
 * Builds a throwaway project in a temp directory and drives it through the
 * real submit → poll → runPicker path with an offline provider. About a
 * third of the assets are ordered frame sets (4 to 12 frames), the rest are
 * 2 to 4 alternative candidates; every few have current art to compare
 * against. Reroll works too: it resubmits with --force, exactly as `gen`
 * does, after a short pretend wait. Nothing leaves this machine.
 */
import { mkdtemp, mkdir, writeFile, readFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { FakeProvider } from "../src/providers/fake.ts"
import { loadManifest, resolveSpecs } from "../src/manifest.ts"
import { buildPlan } from "../src/pipeline/plan.ts"
import { submit } from "../src/pipeline/submit.ts"
import { poll } from "../src/pipeline/poll.ts"
import { runPicker } from "../src/pick/server.ts"
import { encodeRgbaPng } from "../src/png.ts"
import { lockKey, type Lock } from "../src/types.ts"
import type { JobState } from "../src/provider.ts"

const arg = (name: string, fallback: string) => {
  const at = process.argv.indexOf(`--${name}`)
  return at > 0 ? process.argv[at + 1] ?? fallback : fallback
}
const count = Number(arg("assets", "56"))
const port = Number(arg("port", "4173"))
const open = process.argv.includes("--open")

const NOUNS = ["anvil", "lantern", "slime", "knight", "chest", "torch", "mushroom", "crab", "wizard", "barrel", "bat", "potion",
  "golem", "sword", "shield", "skull", "cactus", "frog", "ghost", "key"]
const MOVES = ["idle", "walk", "attack", "hurt", "spin", "bob"]
const HUES = [[255, 107, 53], [120, 200, 255], [170, 230, 90], [240, 200, 70], [230, 110, 160], [150, 140, 255], [90, 220, 190]]

/** A small sprite: a rounded body that squashes and bobs over the loop, with an eye and a darker outline. */
function sprite(size: number, frame: number, frames: number, seed: number, take: number): Buffer {
  const px = Buffer.alloc(size * size * 4)
  const [r, g, b] = HUES[(seed + take * 3) % HUES.length]!
  const phase = (frame / Math.max(1, frames)) * Math.PI * 2
  const bob = Math.round(Math.sin(phase) * size * 0.08)
  const squash = 1 + Math.cos(phase) * 0.12 * (take % 2 ? -1 : 1)
  const cx = size / 2, cy = size * 0.58 + bob
  const rx = size * 0.32 * squash, ry = size * 0.3 / squash
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const d = ((x + 0.5 - cx) / rx) ** 2 + ((y + 0.5 - cy) / ry) ** 2
    const i = (y * size + x) * 4
    if (d <= 1) {
      const edge = d > 0.72
      const shade = y < cy - ry * 0.35 ? 1.15 : 1
      px[i] = Math.min(255, (edge ? r * 0.45 : r * shade) | 0)
      px[i + 1] = Math.min(255, (edge ? g * 0.45 : g * shade) | 0)
      px[i + 2] = Math.min(255, (edge ? b * 0.45 : b * shade) | 0)
      px[i + 3] = 255
    }
    // shadow
    const sd = ((x + 0.5 - cx) / (size * 0.3)) ** 2 + ((y + 0.5 - size * 0.9) / (size * 0.05)) ** 2
    if (sd <= 1 && px[i + 3] === 0) { px[i + 3] = 90 }
  }
  const ex = Math.round(cx + rx * 0.3), ey = Math.round(cy - ry * 0.2)
  const dot = Math.max(1, Math.round(size / 16))
  for (let y = ey; y < ey + dot; y++) for (let x = ex; x < ex + dot; x++) {
    const i = (y * size + x) * 4
    if (x >= 0 && y >= 0 && x < size && y < size) { px[i] = 20; px[i + 1] = 18; px[i + 2] = 16; px[i + 3] = 255 }
  }
  return encodeRgbaPng(size, size, px)
}

const dir = await mkdtemp(path.join(tmpdir(), "pixelkiln-pick-fixture-"))
const lockPath = path.join(dir, "pixelkiln.lock.json")
const frameDir = path.join(dir, "frames")
await mkdir(frameDir, { recursive: true })

const assets: Record<string, { prompt: string; category: string }> = {}
const plan: Record<string, { size: number; frames: number; set: boolean; seed: number }> = {}
for (let n = 0; n < count; n++) {
  const id = `${NOUNS[n % NOUNS.length]}-${MOVES[Math.floor(n / NOUNS.length) % MOVES.length]}${n >= NOUNS.length * MOVES.length ? `-${n}` : ""}`
  const set = n % 3 === 0
  plan[id] = { size: [16, 24, 32, 48, 64][n % 5]!, frames: set ? 4 + (n % 9) : 2 + (n % 3), set, seed: n }
  assets[id] = {
    prompt: `${id.replace("-", " ")}, side view, chunky outline, 3-tone shading${set ? `, ${plan[id]!.frames}-frame loop` : ""}`,
    category: "props",
  }
}

/** Offline provider: every job waits in review with locally drawn frames. */
class FixtureProvider extends FakeProvider {
  takes = new Map<string, number>()
  override async poll(jobId: string): Promise<JobState> {
    const state = await super.poll(jobId)
    const job = this.jobs.get(jobId)
    if (!job || (state.status !== "review" && state.status !== "ready")) return state
    const id = job.spec.assetId
    const p = plan[id]!
    const take = this.takes.get(jobId) ?? this.takes.set(jobId, [...this.takes.keys()].filter((k) => this.jobs.get(k)?.spec.assetId === id).length).get(jobId)!
    const urls: string[] = []
    for (let f = 0; f < p.frames; f++) {
      const file = path.join(frameDir, `${id}-${jobId}-${f}.png`)
      await writeFile(file, sprite(p.size, f, p.frames, p.seed + (p.set ? 0 : f), take))
      urls.push(`file://${file}`)
    }
    if (p.set) {
      return {
        status: "review-set",
        objectId: `obj-${jobId}`,
        fps: 8 + (p.seed % 3) * 2,
        frameUrls: urls,
        sources: urls.map((url, i) => ({ url, role: `frame-${String(i).padStart(2, "0")}` })),
      } as JobState
    }
    return { status: "review", candidateUrls: urls } as JobState
  }
  override async download(url: string): Promise<Buffer> {
    return url.startsWith("file://") ? readFile(url.slice(7)) : super.download(url)
  }
}

const provider = new FixtureProvider({ candidates: 2 })
const manifestPath = path.join(dir, "pixelkiln.manifest.json")
await writeFile(manifestPath, JSON.stringify({
  name: "pick-fixture",
  styles: { props: { generator: "1dir", size: 32, outDir: "out", promptSuffix: "pixel art" } },
  assets,
}))
const loaded = await loadManifest(manifestPath)
const specs = await resolveSpecs(loaded)
const lock: Lock = { version: 2, entries: {} }
await submit(provider, loaded, (await buildPlan(specs, lock)).actionable, lock, lockPath, { spacingMs: 0 })
await poll(provider, lock, lockPath, { intervalMs: 0 })

// Current art for every fourth asset: the take a regeneration would replace.
for (const [n, spec] of specs.entries()) {
  if (n % 4 !== 1) continue
  const p = plan[spec.assetId]!
  const rel = path.join("out", `${spec.assetId}.png`)
  await mkdir(path.join(spec.root, "out"), { recursive: true })
  await writeFile(path.join(spec.root, rel), sprite(p.size, 0, p.frames, p.seed + 3, 5))
  lock.entries[lockKey(spec.styleId, spec.assetId)]!.supersededOutputs = [{ path: rel, sha256: "0".repeat(64), mediaType: "image/png" }]
}
console.log(`  ${Object.values(lock.entries).filter((e) => e.supersededOutputs?.length).length} assets have current art`)

const result = await runPicker(provider, lock, lockPath, {
  port,
  open,
  specs,
  onProgress: (msg) => console.log(msg),
  onReady: ({ url, keys }) => console.log(`\n  ${keys.length} assets in review: ${url}\n  project: ${dir}\n`),
  reroll: async (key) => {
    const spec = specs.find((s) => lockKey(s.styleId, s.assetId) === key)!
    await new Promise((r) => setTimeout(r, 2500))
    await submit(provider, loaded, (await buildPlan([spec], lock, { force: true })).actionable, lock, lockPath, { spacingMs: 0 })
    await poll(provider, lock, lockPath, { intervalMs: 0, specs: [spec] })
  },
})
console.log(`  applied: ${result.selected} selected, ${result.skipped} left in review`)
