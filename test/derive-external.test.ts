import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { mkdtemp, mkdir, rm, writeFile, readFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { AssetSchema } from "../src/types.ts"
import { loadManifest, resolveSpecs } from "../src/manifest.ts"
import { loadLock } from "../src/lock.ts"
import { buildPlan } from "../src/pipeline/plan.ts"
import { importLocal } from "../src/pipeline/import.ts"
import { paletteSnap, recolor, scale } from "../src/pipeline/derive.ts"
import { submit } from "../src/pipeline/submit.ts"
import { FakeProvider } from "../src/providers/fake.ts"
import { decodePng, encodeRgbaPng } from "../src/png.ts"

const rgba = (w: number, h: number, pixel: (x: number, y: number) => [number, number, number, number]) => {
  const buf = Buffer.alloc(w * h * 4)
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) Buffer.from(pixel(x, y)).copy(buf, (y * w + x) * 4)
  return encodeRgbaPng(w, h, buf)
}
const gray = (shade = 128) => rgba(16, 16, () => [shade, shade, shade, 255])

describe("transforms", () => {
  it("recolor replaces exact colors and keeps alpha and unmapped colors", () => {
    const png = rgba(2, 1, (x) => (x === 0 ? [128, 128, 128, 200] : [10, 20, 30, 255]))
    const out = decodePng(recolor(png, { "#808080": "#c06020" })).pixels
    expect([...out.subarray(0, 4)]).toEqual([192, 96, 32, 200])
    expect([...out.subarray(4, 8)]).toEqual([10, 20, 30, 255])
  })

  it("palette-snap moves every visible pixel onto the palette", () => {
    const out = decodePng(paletteSnap(rgba(2, 1, (x) => (x === 0 ? [10, 10, 10, 255] : [240, 240, 240, 255])), ["#000000", "#ffffff"]))
    expect([...out.pixels.subarray(0, 3)]).toEqual([0, 0, 0])
    expect([...out.pixels.subarray(4, 7)]).toEqual([255, 255, 255])
  })

  it("scale gives the exact size, deterministically; box averages and nearest keeps hard edges", () => {
    const stripes = rgba(4, 4, (x) => (x < 2 ? [0, 0, 0, 255] : [255, 255, 255, 255]))
    const nearest = decodePng(scale(stripes, 2, 2, "nearest"))
    expect([nearest.width, nearest.height]).toEqual([2, 2])
    expect([...nearest.pixels.subarray(0, 3)]).toEqual([0, 0, 0])
    const box = decodePng(scale(stripes, 1, 1, "box"))
    expect(box.pixels[0]).toBe(128)
    expect(scale(stripes, 3, 3, "box").equals(scale(stripes, 3, 3, "box"))).toBe(true)
  })
})

describe("schema", () => {
  const ok = { derive: { from: "a", transform: "recolor", map: { "#000000": "#ffffff" } } }
  it("accepts each transform and an external asset", () => {
    expect(AssetSchema.safeParse(ok).success).toBe(true)
    expect(AssetSchema.safeParse({ derive: { file: "x.png", transform: "scale", width: 8, height: 8 } }).success).toBe(true)
    expect(AssetSchema.safeParse({ external: { builder: "python build.py", inputs: ["a.py"] } }).success).toBe(true)
  })
  it.each([
    ["both sources", { derive: { from: "a", file: "x.png", transform: "recolor", map: { "#000000": "#ffffff" } } }],
    ["no source", { derive: { transform: "recolor", map: { "#000000": "#ffffff" } } }],
    ["a parameter of another transform", { derive: { from: "a", transform: "recolor", map: { "#000000": "#ffffff" }, width: 4 } }],
    ["scale without a size", { derive: { from: "a", transform: "scale" } }],
    ["a prompt-less asset that is neither", { styles: ["s"] }],
    ["derive and mirror together", { ...ok, mirror: "b" }],
    ["derive with a committed source", { ...ok, source: "x.png" }],
    ["external with a reference", { external: { builder: "b" }, reference: "x.png" }],
  ])("refuses %s", (_name, asset) => {
    expect(AssetSchema.safeParse(asset).success).toBe(false)
  })
})

describe("derive and external in a project", () => {
  let dir: string
  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "pixelkiln-derive-"))
    await mkdir(path.join(dir, "out"), { recursive: true })
    await mkdir(path.join(dir, "art"), { recursive: true })
    await writeFile(path.join(dir, "out", "base.png"), gray())
    await writeFile(path.join(dir, "art", "seed.png"), gray())
  })
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  async function open(assets: Record<string, unknown>) {
    await writeFile(
      path.join(dir, "m.json"),
      JSON.stringify({
        name: "t",
        styles: { s: { generator: "imageProFlash", outDir: "out" } },
        assets: { base: { prompt: "a hedge", width: 16, height: 16 }, ...assets },
      }),
    )
    const loaded = await loadManifest(path.join(dir, "m.json"))
    const lockPath = path.join(dir, "lock.json")
    return { loaded, specs: await resolveSpecs(loaded), lockPath, lock: await loadLock(lockPath) }
  }
  const states = async (p: Awaited<ReturnType<typeof open>>, opts?: { force?: boolean }) =>
    Object.fromEntries((await buildPlan(p.specs, p.lock, opts)).items.map((i) => [i.spec.assetId, i.state]))

  const derived = {
    autumn: { derive: { from: "base", transform: "recolor", map: { "#808080": "#c06020" } } },
    big: { derive: { from: "base", transform: "scale", width: 32, height: 32 } },
    snapped: { derive: { file: "art/seed.png", transform: "palette-snap", palette: ["#000000", "#ffffff"] } },
  }

  it("derives for free once the source is recorded, then reports ok", async () => {
    let p = await open(derived)
    expect(await states(p)).toMatchObject({ base: "untracked", autumn: "blocked", snapped: "missing" })
    await importLocal(p.specs, p.lock, p.lockPath, { source: "mcp" })
    p = await open(derived)
    expect(await states(p)).toMatchObject({ base: "ok", autumn: "missing", big: "missing" })
    const plan = await buildPlan(p.specs, p.lock)
    expect(plan.cost).toBe(0)

    const provider = new FakeProvider()
    await submit(provider, p.loaded, plan.actionable, p.lock, p.lockPath, { spacingMs: 0 })
    expect(provider.submissions).toEqual([])
    p = await open(derived)
    expect(await states(p)).toMatchObject({ base: "ok", autumn: "ok", big: "ok", snapped: "ok" })
    const autumn = decodePng(await readFile(path.join(dir, "out", "autumn.png")))
    expect([...autumn.pixels.subarray(0, 3)]).toEqual([192, 96, 32])
    const big = decodePng(await readFile(path.join(dir, "out", "big.png")))
    expect([big.width, big.height]).toEqual([32, 32])
  })

  it("goes stale, for free, when the source or the parameters change, and orphaned when hand-edited", async () => {
    let p = await open(derived)
    await importLocal(p.specs, p.lock, p.lockPath, {})
    p = await open(derived)
    const plan = await buildPlan(p.specs, p.lock)
    await submit(new FakeProvider(), p.loaded, plan.actionable, p.lock, p.lockPath, { spacingMs: 0 })

    // the source asset is re-recorded with different bytes
    await writeFile(path.join(dir, "out", "base.png"), gray(100))
    p = await open(derived)
    await importLocal(p.specs.filter((s) => s.assetId === "base"), p.lock, p.lockPath, { force: true })
    p = await open(derived)
    expect(await states(p)).toMatchObject({ base: "ok", autumn: "stale", big: "stale", snapped: "ok" })

    // a parameter change
    p = await open({ ...derived, autumn: { derive: { from: "base", transform: "recolor", map: { "#808080": "#00ff00" } } } })
    expect((await states(p)).autumn).toBe("stale")

    // the committed file source changes
    await writeFile(path.join(dir, "art", "seed.png"), gray(50))
    p = await open(derived)
    expect((await states(p)).snapped).toBe("stale")
  })

  it("tracks an external asset by hand and never makes it actionable", async () => {
    const external = { dock: { external: { builder: "python iso_kit.py dock", inputs: ["art/seed.png"] } } }
    let p = await open(external)
    expect((await states(p)).dock).toBe("orphaned")
    await writeFile(path.join(dir, "out", "dock.png"), gray(77))
    expect((await states(p)).dock).toBe("untracked")

    await importLocal(p.specs.filter((s) => s.assetId === "dock"), p.lock, p.lockPath, { source: "script" })
    p = await open(external)
    expect(p.lock.entries["s/dock"]?.external?.builder).toBe("python iso_kit.py dock")
    expect((await states(p)).dock).toBe("ok")
    expect((await states(p, { force: true })).dock).toBe("ok")

    await writeFile(path.join(dir, "art", "seed.png"), gray(10))
    p = await open(external)
    expect((await states(p)).dock).toBe("orphaned")
    const plan = await buildPlan(p.specs, p.lock, { force: true })
    expect(plan.actionable.find((i) => i.spec.assetId === "dock")).toBeUndefined()

    p = await open({ dock: { external: { builder: "python other.py", inputs: [] } } })
    expect((await states(p)).dock).toBe("orphaned")
  })
})
