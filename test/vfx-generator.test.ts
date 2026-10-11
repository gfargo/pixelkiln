import path from "node:path"
import os from "node:os"
import { existsSync } from "node:fs"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { PixelLabClient } from "../src/client.ts"
import { loadManifest, resolveSpecs } from "../src/manifest.ts"
import { buildPlan } from "../src/pipeline/plan.ts"
import { fetchAssets } from "../src/pipeline/fetch.ts"
import { poll } from "../src/pipeline/poll.ts"
import { submit } from "../src/pipeline/submit.ts"
import { renderGodotSpriteFrames, type SheetAtlas } from "../src/pipeline/sheet-formats.ts"
import { decodePng, encodeRgbaPng } from "../src/png.ts"
import { PixelLabProvider, pixelLabObjectUrl } from "../src/providers/pixellab.ts"
import type { Lock } from "../src/types.ts"

const STEP_A = "4d3dbb83-719b-49fb-a26d-0a2b58824393"
const STEP_B = "ca4d21a6-b88f-43df-90d5-4b93557b589d"
const STEP_C = "dee59e69-6258-4803-968a-053f3437dad0"
const EFFECT = "807f8698-6a03-480a-bc3e-40f051cb7aae"
const IMAGE = "8996ee51-af3d-4aba-8838-51b550548af7"
const RECIPE = { name: "Impact burst", canvas: { w: 4, h: 4 }, frames: 3, fps: 10, loop: false, layers: [{ id: "flash", type: "glow" }] }

// Reply texts are trimmed copies of live October 2026 replies.
function startReply(step: string, recipe: unknown = RECIPE): string {
  return `effect step: ${step}\nfrom: the preset 'impact_burst'\nworking recipe:\n${JSON.stringify(recipe)}\nnext: …`
}
const EXPORT_REPLY = [
  `saved to My effects: 'x' (effect id ${EFFECT}); open it to tweak with sliders: https://pixellab.ai/create-vfx?effect=${EFFECT}`,
  "4x4, 3 frames @ 10 fps, plays once; anchor (origin) at 2,2",
  `download https://api.pixellab.ai/mcp/pixel-tools/${IMAGE}/: fx.gif, fx.json, fx.png`,
  `image id: ${IMAGE} (its frames, image 1)`,
].join("\n")

/** Three 4x4 frames side by side, each a different shade, so slices are checkable. */
function frame(shade: number): Buffer {
  return encodeRgbaPng(4, 4, Buffer.alloc(64, shade))
}
const SHEET = (() => {
  const pixels = Buffer.alloc(12 * 4 * 4)
  for (let y = 0; y < 4; y++) for (let x = 0; x < 12; x++) pixels.fill([40, 120, 200][Math.floor(x / 4)]!, (y * 12 + x) * 4, (y * 12 + x + 1) * 4)
  return encodeRgbaPng(12, 4, pixels)
})()

let dir: string
beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "pixelkiln-vfx-gen-"))
  vi.stubGlobal("fetch", vi.fn(async (input: string) => {
    const url = String(input)
    if (url.endsWith("/fx.png")) return new Response(SHEET, { status: 200 })
    if (url.endsWith("/fx.json")) return new Response(JSON.stringify({ frames: [], meta: {} }), { status: 200 })
    return new Response("not found", { status: 404 })
  }))
})
afterEach(async () => {
  vi.unstubAllGlobals()
  await rm(dir, { recursive: true, force: true })
})

async function project(assets: Record<string, unknown>, styles: Record<string, unknown> = { fx: { outDir: "art/fx", generator: "vfx" } }) {
  await writeFile(path.join(dir, "m.json"), JSON.stringify({ name: "fx-test", styles, assets }))
  return loadManifest(path.join(dir, "m.json"))
}

/** A fake MCP client answering the workbench in order, recording each argv. */
function workbench(replies: Array<string | Error>) {
  const calls: string[][] = []
  return {
    calls,
    client: {
      callTool: vi.fn(async (_name: string, args: Record<string, unknown>) => {
        calls.push(args.argv as string[])
        const reply = replies.shift()
        if (reply === undefined) throw new Error(`unexpected call ${JSON.stringify(args.argv)}`)
        if (reply instanceof Error) throw reply
        return { text: reply, images: [] }
      }),
    },
  }
}

describe("resolving a vfx spec", () => {
  it("carries the vfx block, prices it free, and keeps the prompt a bare label", async () => {
    const loaded = await project(
      { boom: { prompt: "a hit spark", vfx: { preset: "impact_burst", parts: [{ name: "spark_burst", size: 1.5 }], fps: 12 } } },
      { fx: { outDir: "art/fx", generator: "vfx", promptPrefix: "pixel art" } },
    )
    const [spec] = await resolveSpecs(loaded, { provider: PixelLabProvider.forOffline() })
    expect(spec).toMatchObject({
      generator: "vfx",
      prompt: "a hit spark",
      cost: 0,
      costUnit: "generations",
      candidates: 1,
      vfx: { preset: "impact_burst", parts: [{ name: "spark_burst", size: 1.5 }], fps: 12, name: "pixelkiln:fx/boom" },
    })
  })

  it("reads a recipe file for its canvas and content hash, and a .vfx.json record's sprite", async () => {
    await writeFile(path.join(dir, "hero.png"), frame(9))
    await writeFile(path.join(dir, "boom.vfx.json"), JSON.stringify({
      version: 1, tool: "vfx_workbench", effectId: EFFECT, source: { sprite: "hero.png" },
      recipe: { ...RECIPE, canvas: { w: 96, h: 80 } },
    }))
    const [spec] = await resolveSpecs(await project({ boom: { vfx: { recipe: "boom.vfx.json" } } }))
    expect(spec).toMatchObject({ width: 96, height: 80 })
    expect(spec!.vfx!.recipe!.sha256).toMatch(/^[0-9a-f]{64}$/)
    expect(spec!.vfx!.sprite).toMatchObject({ file: path.join(dir, "hero.png"), width: 4, height: 4, format: "png" })
  })

  it("goes stale on what renders, and not on a name, a label, a path, or a style knob", async () => {
    await writeFile(path.join(dir, "a.png"), frame(1))
    await writeFile(path.join(dir, "b.png"), frame(1))
    await writeFile(path.join(dir, "r.json"), JSON.stringify(RECIPE))
    const hash = async (vfx: Record<string, unknown>, extra: Record<string, unknown> = {}, style: Record<string, unknown> = {}) =>
      (await resolveSpecs(await project({ boom: { vfx, ...extra } }, { fx: { outDir: "art/fx", generator: "vfx", ...style } })))[0]!.specHash
    const base = await hash({ recipe: "r.json", sprite: "a.png" })
    expect(await hash({ recipe: "r.json", sprite: "a.png", name: "Renamed" })).toBe(base)
    expect(await hash({ recipe: "r.json", sprite: "a.png" }, { prompt: "a new label" })).toBe(base)
    expect(await hash({ recipe: "r.json", sprite: "b.png" })).toBe(base) // same bytes, another path
    expect(await hash({ recipe: "r.json", sprite: "a.png" }, {}, { promptPrefix: "moody", size: 128 })).toBe(base)
    await writeFile(path.join(dir, "r.json"), JSON.stringify({ ...RECIPE, name: "only the name changed" }))
    expect(await hash({ recipe: "r.json", sprite: "a.png" })).toBe(base)

    expect(await hash({ recipe: "r.json", sprite: "a.png", fps: 6 })).not.toBe(base)
    expect(await hash({ recipe: "r.json", sprite: "a.png", parts: [{ name: "smoke_puff" }] })).not.toBe(base)
    await writeFile(path.join(dir, "b.png"), frame(2))
    expect(await hash({ recipe: "r.json", sprite: "b.png" })).not.toBe(base)
    await writeFile(path.join(dir, "r.json"), JSON.stringify({ ...RECIPE, fps: 4 }))
    expect(await hash({ recipe: "r.json", sprite: "a.png" })).not.toBe(base)
  })

  it("puts an asset with no styles only in styles of its own kind", async () => {
    const loaded = await project(
      { coin: { prompt: "a gold coin" }, boom: { vfx: { preset: "explosion" } } },
      { icons: { outDir: "art/icons", generator: "map" }, fx: { outDir: "art/fx", generator: "vfx" } },
    )
    const specs = await resolveSpecs(loaded)
    expect(specs.map((spec) => `${spec.styleId}/${spec.assetId}`).sort()).toEqual(["fx/boom", "icons/coin"])
  })

  it("refuses a vfx block outside a vfx style and a vfx-style asset with nothing to render", async () => {
    await expect(resolveSpecs(await project(
      { boom: { styles: ["icons"], vfx: { preset: "explosion" } } },
      { icons: { outDir: "a", generator: "map" } },
    ))).rejects.toThrow(/vfx needs a vfx style/)
    await expect(resolveSpecs(await project({ coin: { styles: ["fx"], prompt: "a coin" } })))
      .rejects.toThrow(/renders effects; give the asset a vfx block/)
    await expect(resolveSpecs(await project({ boom: { vfx: { recipe: "missing.json" } } })))
      .rejects.toThrow(/VFX recipe not found/)
  })

  it("validates the vfx block itself", async () => {
    await expect(project({ boom: { vfx: { preset: "explosion", recipe: "r.json" } } })).rejects.toThrow(/preset or a recipe, not both/)
    await expect(project({ boom: { vfx: { fps: 12 } } })).rejects.toThrow(/needs a preset, a recipe, or at least one part/)
    await expect(project({ boom: { vfx: { preset: "explosion", sprite: "https://example.com/a.png" } } })).rejects.toThrow(/a URL has no content/)
    await expect(project({ boom: { vfx: { preset: "explosion" } } }, {
      fx: { outDir: "a", generator: "vfx", quality: { outDir: "q", palette: ["#000000", "#ffffff"] } },
    })).rejects.toThrow(/single-image generators only/)
  })

  it("is blocked until a sprite drawn by another asset exists", async () => {
    const assets = { boom: { vfx: { preset: "aura", sprite: "art/chars/hero.png" } } }
    const lock: Lock = { version: 2, entries: {} }
    const before = await buildPlan(await resolveSpecs(await project(assets)), lock)
    expect(before.items[0]).toMatchObject({ state: "blocked", reason: expect.stringContaining("vfx sprite does not exist yet") })
    await import("node:fs/promises").then((fs) => fs.mkdir(path.join(dir, "art/chars"), { recursive: true }))
    await writeFile(path.join(dir, "art/chars/hero.png"), frame(5))
    const after = await buildPlan(await resolveSpecs(await project(assets)), lock)
    expect(after.items[0]!.state).toBe("missing")
  })
})

describe("the PixelLab provider and vfx", () => {
  it("supports vfx, prices it free, links the effect, and needs MCP to submit", async () => {
    const offline = PixelLabProvider.forOffline()
    expect(offline.supports("vfx")).toBe(true)
    expect(pixelLabObjectUrl("vfx", EFFECT)).toBe(`https://pixellab.ai/create-vfx?effect=${EFFECT}`)
    const [spec] = await resolveSpecs(await project({ boom: { vfx: { preset: "explosion" } } }))
    expect(offline.estimate(spec!)).toEqual({ unit: "generations", amount: 0, candidates: 1 })
    await expect(offline.submit(spec!, [])).rejects.toThrow(/MCP server/)
  })

  it("renders, slices the sheet into frames, and downloads them as a one-shot frame set", async () => {
    await writeFile(path.join(dir, "hero.png"), frame(7))
    const loaded = await project({ boom: { vfx: { preset: "impact_burst", sprite: "hero.png", fps: 10 } } })
    const specs = await resolveSpecs(loaded)
    const lock: Lock = { version: 2, entries: {} }
    const lockPath = path.join(dir, "pixelkiln.lock.json")
    const { client, calls } = workbench([startReply(STEP_A), startReply(STEP_B), EXPORT_REPLY, startReply(STEP_C)])
    const provider = new PixelLabProvider(new PixelLabClient("key"), client)

    await submit(provider, loaded, (await buildPlan(specs, lock)).actionable, lock, lockPath, { spacingMs: 0 })
    expect(calls[0]!.slice(0, 2)).toEqual(["start", "--sprite"])
    expect(calls[0]![2]).toMatch(/^data:image\/png;base64,/)
    expect(calls[0]!.slice(3)).toEqual(["--preset", "impact_burst"])
    expect(calls[1]).toEqual([STEP_A, "render", JSON.stringify({ patch: [{ op: "set", path: "fps", value: 10 }] })])
    expect(calls[2]).toEqual([STEP_B, "export", "--name", "pixelkiln:fx/boom"])
    expect(calls[3]).toEqual(["start", "--effect", EFFECT])

    expect((await poll(provider, lock, lockPath, { intervalMs: 0, specs })).failed).toBe(0)
    await fetchAssets(provider, specs, lock, lockPath)
    const entry = lock.entries["fx/boom"]!
    expect(entry).toMatchObject({ status: "downloaded", objectId: EFFECT, cost: 0 })
    expect(entry.outputs!.map((output) => [output.role, path.basename(output.path)])).toEqual([
      ["frame-00", "boom-frame-00.png"],
      ["frame-01", "boom-frame-01.png"],
      ["frame-02", "boom-frame-02.png"],
    ])
    const second = decodePng(await readFile(path.join(dir, "art/fx/boom-frame-01.png")))
    expect([second.width, second.height, second.pixels[0]]).toEqual([4, 4, 120])
    expect(entry.providerMetadata?.pixellab).toMatchObject({
      frameSet: { fps: 10, count: 3, loop: false },
      vfx: { effectId: EFFECT, editUrl: `https://pixellab.ai/create-vfx?effect=${EFFECT}`, replaced: null, recipe: RECIPE },
    })
    expect(JSON.stringify(entry)).not.toContain("file://")
  })

  it("exports a regeneration over the same effect, but saves a new one when the old was edited upstream or is gone", async () => {
    const loaded = await project({ boom: { vfx: { preset: "impact_burst" } } })
    const lockPath = path.join(dir, "pixelkiln.lock.json")
    const run = async (lock: Lock, replies: Array<string | Error>) => {
      const specs = await resolveSpecs(loaded)
      const bench = workbench(replies)
      const provider = new PixelLabProvider(new PixelLabClient("key"), bench.client)
      await submit(provider, loaded, (await buildPlan(specs, lock, { force: true })).actionable, lock, lockPath, { spacingMs: 0 })
      await poll(provider, lock, lockPath, { intervalMs: 0, specs })
      await fetchAssets(provider, specs, lock, lockPath)
      return bench.calls
    }
    const lock: Lock = { version: 2, entries: {} }
    await run(lock, [startReply(STEP_A), EXPORT_REPLY, startReply(STEP_C)])

    // Unchanged upstream: the check reads the same recipe, so the export replaces it.
    const same = await run(lock, [startReply(STEP_C), startReply(STEP_A), EXPORT_REPLY, startReply(STEP_C)])
    expect(same[0]).toEqual(["start", "--effect", EFFECT])
    expect(same[2]).toEqual([STEP_A, "export", "--name", "pixelkiln:fx/boom", "--replace", EFFECT])
    expect(lock.entries["fx/boom"]!.providerMetadata?.pixellab).toMatchObject({ vfx: { replaced: EFFECT } })

    // Someone moved a slider on pixellab.ai: their effect is kept, a new one saved.
    const edited = await run(lock, [startReply(STEP_C, { ...RECIPE, fps: 24 }), startReply(STEP_A), EXPORT_REPLY, startReply(STEP_C)])
    expect(edited[2]).toEqual([STEP_A, "export", "--name", "pixelkiln:fx/boom"])
    expect(lock.entries["fx/boom"]!.providerMetadata?.pixellab).toMatchObject({ vfx: { newEffect: expect.stringContaining("changed on pixellab.ai") } })

    // Deleted from My effects: export fresh.
    const gone = await run(lock, [new Error(`PixelLab vfx_workbench: error: No saved effect ${EFFECT} in your library.`), startReply(STEP_A), EXPORT_REPLY, startReply(STEP_C)])
    expect(gone[2]).toEqual([STEP_A, "export", "--name", "pixelkiln:fx/boom"])
    expect(lock.entries["fx/boom"]!.history?.length).toBeGreaterThan(0)
  })

  it("still exports over the last rendered effect after a failed attempt in between", async () => {
    const loaded = await project({ boom: { vfx: { preset: "impact_burst" } } })
    const lockPath = path.join(dir, "pixelkiln.lock.json")
    const lock: Lock = { version: 2, entries: {} }
    const run = async (replies: Array<string | Error>) => {
      const specs = await resolveSpecs(loaded)
      const bench = workbench(replies)
      const provider = new PixelLabProvider(new PixelLabClient("key"), bench.client)
      await submit(provider, loaded, (await buildPlan(specs, lock, { force: true })).actionable, lock, lockPath, { spacingMs: 0 })
      await poll(provider, lock, lockPath, { intervalMs: 0, specs })
      await fetchAssets(provider, specs, lock, lockPath)
      return bench.calls
    }
    await run([startReply(STEP_A), EXPORT_REPLY, startReply(STEP_C)])
    await run([new Error("PixelLab vfx_workbench: the network fell over")])
    expect(lock.entries["fx/boom"]!.status).toBe("failed")
    const retry = await run([startReply(STEP_C), startReply(STEP_A), EXPORT_REPLY, startReply(STEP_C)])
    expect(retry[2]).toEqual([STEP_A, "export", "--name", "pixelkiln:fx/boom", "--replace", EFFECT])
  })

  it("cuts the frames again from the export when the local cache was cleared", async () => {
    const loaded = await project({ boom: { vfx: { preset: "impact_burst" } } })
    const specs = await resolveSpecs(loaded)
    const lock: Lock = { version: 2, entries: {} }
    const lockPath = path.join(dir, "pixelkiln.lock.json")
    const { client } = workbench([startReply(STEP_A), EXPORT_REPLY, startReply(STEP_C)])
    const provider = new PixelLabProvider(new PixelLabClient("key"), client)
    await submit(provider, loaded, (await buildPlan(specs, lock)).actionable, lock, lockPath, { spacingMs: 0 })
    const jobId = lock.entries["fx/boom"]!.jobId!
    const cache = path.join(os.tmpdir(), "pixelkiln-vfx")
    for (const file of [`${jobId}.json`, `${jobId}-0.png`, `${jobId}-1.png`, `${jobId}-2.png`]) await rm(path.join(cache, file), { force: true })
    expect((await poll(provider, lock, lockPath, { intervalMs: 0, specs })).failed).toBe(0)
    expect(existsSync(path.join(cache, `${jobId}-2.png`))).toBe(true)
    await fetchAssets(provider, specs, lock, lockPath)
    expect(lock.entries["fx/boom"]!.outputs).toHaveLength(3)
  })
})

describe("a one-shot frame set in Godot", () => {
  it("writes loop false for a set that plays once", () => {
    const atlas: SheetAtlas = {
      style: "fx",
      sheet: { width: 8, height: 4 },
      cell: { width: 4, height: 4 },
      frames: [
        { id: "boom/frame-00", x: 0, y: 0, width: 4, height: 4 },
        { id: "boom/frame-01", x: 4, y: 0, width: 4, height: 4 },
      ],
      sets: [{ id: "boom", kind: "frames", fps: 10, loop: false, frames: ["boom/frame-00", "boom/frame-01"] }],
    }
    expect(renderGodotSpriteFrames(atlas, { imageName: "fx.png" })).toMatch(/"loop": false,\n"name": &"boom"/)
  })
})
