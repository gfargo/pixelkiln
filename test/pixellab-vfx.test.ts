import path from "node:path"
import { existsSync } from "node:fs"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { parseArgs } from "../src/cli/args.ts"
import { PixelLabMcpClient, parseMcpBody } from "../src/pixellab-mcp.ts"
import {
  makeVfx,
  parseVfxExport,
  parseVfxRecipe,
  parseVfxStep,
  readVfxRecipe,
  resolveVfxSprite,
  vfxOutputPaths,
} from "../src/pixellab-vfx.ts"
import { encodeRgbaPng } from "../src/png.ts"

const STEP_A = "4d3dbb83-719b-49fb-a26d-0a2b58824393"
const STEP_B = "ca4d21a6-b88f-43df-90d5-4b93557b589d"
const STEP_C = "dee59e69-6258-4803-968a-053f3437dad0"
const EFFECT = "807f8698-6a03-480a-bc3e-40f051cb7aae"
const IMAGE = "8996ee51-af3d-4aba-8838-51b550548af7"
const RECIPE = { name: "Impact burst", canvas: { w: 64, h: 64 }, frames: 7, fps: 16, loop: false, layers: [{ id: "flash", type: "glow" }] }

// Reply texts below are trimmed copies of live October 2026 replies.
function startReply(step: string, recipe: unknown = RECIPE, from = "the preset 'impact_burst' (its recipe is your working recipe)"): string {
  return `effect step: ${step}\nfrom: ${from}\nworking recipe:\n${JSON.stringify(recipe)}\nnext: vfx_workbench(argv=['${step}', 'add_part', '{"name": "<part>"}'])`
}
const PART_REPLY = `effect step: ${STEP_B} (from ${STEP_A})\nrender ok · 64x64, 10 frames @ 12 fps, one-shot\nadded Spark burst as 'spark_burst' on the effect's origin`
function exportReply(files: string): string {
  return [
    `saved to My effects: 'Impact' (effect id ${EFFECT}); open it to tweak with sliders: https://pixellab.ai/create-vfx?effect=${EFFECT}`,
    "64x64, 7 frames @ 16 fps, plays once; anchor (origin) at 32,32",
    `download https://api.pixellab.ai/mcp/pixel-tools/${IMAGE}/: ${files}`,
    `image id: ${IMAGE} (its frames, image 1; for pixelart_workbench inspect/edit or save_to_asset)`,
  ].join("\n")
}
const ATLAS = { frames: [], meta: { app: "PixelLab VFX Creator", image: "impact.png", anchor: { kind: "origin", x: 32, y: 32 } } }

describe("PixelLabMcpClient", () => {
  afterEach(() => vi.unstubAllGlobals())

  it("posts one tools/call with the bearer key and reads an SSE reply", async () => {
    vi.stubGlobal("fetch", vi.fn(async () =>
      new Response(
        `event: message\ndata: ${JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          result: { content: [{ type: "text", text: "hello" }, { type: "image", mimeType: "image/png", data: "QQ==" }], isError: false },
        })}\n\n`,
        { status: 200, headers: { "content-type": "text/event-stream" } },
      )))
    const res = await new PixelLabMcpClient("key").callTool("vfx_workbench", { argv: ["describe", "presets"] })
    expect(res).toEqual({ text: "hello", images: [{ mimeType: "image/png", data: "QQ==" }] })
    const [url, init] = vi.mocked(fetch).mock.calls[0]!
    expect(String(url)).toBe("https://api.pixellab.ai/mcp")
    const headers = (init as RequestInit).headers as Record<string, string>
    expect(headers.Authorization).toBe("Bearer key")
    expect(headers.Accept).toContain("text/event-stream")
    expect(JSON.parse(String((init as RequestInit).body))).toMatchObject({
      jsonrpc: "2.0",
      method: "tools/call",
      params: { name: "vfx_workbench", arguments: { argv: ["describe", "presets"] } },
    })
  })

  it("throws on a tool error and on a JSON-RPC error", async () => {
    vi.stubGlobal("fetch", vi.fn(async () =>
      new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { content: [{ type: "text", text: "unknown preset" }], isError: true } }), { status: 200 })))
    await expect(new PixelLabMcpClient("key").callTool("vfx_workbench", {})).rejects.toThrow(/unknown preset/)
    vi.stubGlobal("fetch", vi.fn(async () =>
      new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, error: { code: -32602, message: "bad params" } }), { status: 200 })))
    await expect(new PixelLabMcpClient("key").callTool("vfx_workbench", {})).rejects.toThrow(/bad params/)
  })

  it("retries a busy reply with backoff, then gives up with the tool's message", async () => {
    const busy = { jsonrpc: "2.0", id: 1, result: { content: [{ type: "text", text: "error: the pixel tools are busy. retry in a few seconds." }], isError: true } }
    const ok = { jsonrpc: "2.0", id: 1, result: { content: [{ type: "text", text: "effect step: x" }] } }
    const replies = [busy, busy, ok]
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(replies.shift()), { status: 200 })))
    const waits: number[] = []
    const client = new PixelLabMcpClient("key", { sleep: async (ms) => { waits.push(ms) } })
    expect((await client.callTool("vfx_workbench", {})).text).toBe("effect step: x")
    expect(waits).toEqual([2000, 4000])

    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(busy), { status: 200 })))
    await expect(new PixelLabMcpClient("key", { busyRetries: 1, sleep: async () => {} }).callTool("vfx_workbench", {}))
      .rejects.toThrow(/pixel tools are busy/)
  })

  it("takes the response, not a notification, from a stream carrying both", () => {
    const body = [
      `data: ${JSON.stringify({ jsonrpc: "2.0", method: "notifications/progress", params: {} })}`,
      `data: ${JSON.stringify({ jsonrpc: "2.0", id: 7, result: { content: [] } })}`,
    ].join("\n")
    expect(parseMcpBody(body)).toMatchObject({ id: 7 })
  })
})

describe("vfx reply parsing", () => {
  it("reads the step id, the working recipe, and an export", () => {
    expect(parseVfxStep(PART_REPLY)).toBe(STEP_B)
    expect(() => parseVfxStep("no id here")).toThrow(/no step id/)
    expect(parseVfxRecipe(startReply(STEP_A))).toEqual(RECIPE)
    expect(parseVfxRecipe(PART_REPLY)).toBeNull()
    expect(parseVfxExport(exportReply("impact-game.zip, impact.gif, impact.json, impact.png"))).toEqual({
      effectId: EFFECT,
      editUrl: `https://pixellab.ai/create-vfx?effect=${EFFECT}`,
      width: 64,
      height: 64,
      frames: 7,
      fps: 16,
      loop: false,
      anchor: { x: 32, y: 32 },
      downloadBase: `https://api.pixellab.ai/mcp/pixel-tools/${IMAGE}/`,
      files: ["impact-game.zip", "impact.gif", "impact.json", "impact.png"],
      imageId: IMAGE,
    })
    expect(parseVfxExport(exportReply("a.gif").replace("plays once", "loops")).loop).toBe(true)
  })

  it("names every output from one base", () => {
    expect(vfxOutputPaths("fx/boom.png")).toEqual({
      sheet: path.resolve("fx/boom.png"),
      gif: path.resolve("fx/boom.gif"),
      atlas: path.resolve("fx/boom.json"),
      provenance: path.resolve("fx/boom.vfx.json"),
      gamePack: path.resolve("fx/boom-game.zip"),
      normals: path.resolve("fx/boom-normals.png"),
    })
  })
})

describe("makeVfx", () => {
  let dir: string
  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "pixelkiln-vfx-"))
  })
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  function fake(replies: string[]) {
    const calls: string[][] = []
    const client = {
      callTool: vi.fn(async (_name: string, args: Record<string, unknown>) => {
        calls.push(args.argv as string[])
        const text = replies.shift()
        if (text === undefined) throw new Error("unexpected call")
        return { text, images: [] }
      }),
    }
    const download = vi.fn(async (url: string) =>
      url.endsWith(".json") ? Buffer.from(JSON.stringify(ATLAS)) : Buffer.from(path.basename(url)))
    return { client, calls, download }
  }

  it("starts from a preset, adds parts, exports, downloads, and records the saved recipe", async () => {
    const saved = { ...RECIPE, name: "Impact", layers: [...RECIPE.layers, { id: "spark_burst_sparks", type: "particles" }] }
    const { client, calls, download } = fake([
      startReply(STEP_A),
      PART_REPLY,
      exportReply("impact-game.zip, impact.gif, impact.json, impact.png"),
      startReply(STEP_C, saved, `your saved effect 'Impact' (${EFFECT})`),
    ])
    const res = await makeVfx(client, {
      preset: "impact_burst",
      parts: [{ name: "spark_burst", start: 0, end: 0.6 }],
      name: "Impact",
      out: path.join(dir, "fx", "impact"),
      gamePack: true,
      download,
    })
    expect(calls).toEqual([
      ["start", "--preset", "impact_burst"],
      [STEP_A, "add_part", JSON.stringify({ parts: [{ name: "spark_burst", start: 0, end: 0.6 }] })],
      [STEP_B, "export", "--name", "Impact", "--game-pack"],
      ["start", "--effect", EFFECT],
    ])
    expect(download).toHaveBeenCalledWith(`https://api.pixellab.ai/mcp/pixel-tools/${IMAGE}/impact.png`)
    expect(await readFile(path.join(dir, "fx", "impact.png"), "utf8")).toBe("impact.png")
    expect(await readFile(path.join(dir, "fx", "impact.gif"), "utf8")).toBe("impact.gif")
    expect(await readFile(path.join(dir, "fx", "impact-game.zip"), "utf8")).toBe("impact-game.zip")
    // The atlas is pointed at our sheet's name, not PixelLab's.
    expect(JSON.parse(await readFile(path.join(dir, "fx", "impact.json"), "utf8")).meta.image).toBe("impact.png")
    const record = JSON.parse(await readFile(path.join(dir, "fx", "impact.vfx.json"), "utf8"))
    expect(record).toMatchObject({
      version: 1,
      tool: "vfx_workbench",
      name: "Impact",
      effectId: EFFECT,
      source: { preset: "impact_burst", parts: [{ name: "spark_burst" }] },
      width: 64,
      frames: 7,
      loop: false,
      files: { sheet: "impact.png", gif: "impact.gif", atlas: "impact.json", gamePack: "impact-game.zip" },
      recipe: saved,
    })
    expect(res.paths.gamePack).toBe(path.join(dir, "fx", "impact-game.zip"))
  })

  it("renders a recipe as given, and exports a saved effect over itself under its own name", async () => {
    const recipeRun = fake([startReply(STEP_A, {}, "a new effect"), PART_REPLY, exportReply("i.gif, i.json, i.png"), startReply(STEP_C)])
    await makeVfx(recipeRun.client, { recipe: RECIPE, name: "Again", out: path.join(dir, "again"), download: recipeRun.download })
    expect(recipeRun.calls[1]).toEqual([STEP_A, "render", JSON.stringify({ recipe: RECIPE })])

    const savedRun = fake([
      startReply(STEP_A, { ...RECIPE, name: "My boom" }, `your saved effect 'My boom' (${EFFECT})`),
      exportReply("i.gif, i.json, i.png"),
      startReply(STEP_C),
    ])
    await makeVfx(savedRun.client, { effect: EFFECT, out: path.join(dir, "saved"), download: savedRun.download })
    expect(savedRun.calls[0]).toEqual(["start", "--effect", EFFECT])
    expect(savedRun.calls[1]).toEqual([STEP_A, "export", "--name", "My boom", "--replace", EFFECT])
  })

  it("sets fps with a recipe patch after the effect exists, since start --fps loses to a preset's own", async () => {
    const { client, calls, download } = fake([startReply(STEP_A), PART_REPLY, exportReply("i.gif, i.json, i.png"), startReply(STEP_C)])
    await makeVfx(client, { preset: "impact_burst", fps: 8, name: "Slow", out: path.join(dir, "slow"), download })
    expect(calls[0]).toEqual(["start", "--preset", "impact_burst"])
    expect(calls[1]).toEqual([STEP_A, "render", JSON.stringify({ patch: [{ op: "set", path: "fps", value: 8 }] })])
    expect(calls[2]![1]).toBe("export")
  })

  it("sends a local sprite inline and records it relative to the record, so a re-render finds it", async () => {
    await writeFile(path.join(dir, "hero.png"), encodeRgbaPng(2, 2, Buffer.alloc(16, 200)))
    const { client, calls, download } = fake([startReply(STEP_A), exportReply("i.gif, i.json, i.png"), startReply(STEP_C)])
    await makeVfx(client, { preset: "heal_pillar", sprite: path.join(dir, "hero.png"), name: "Heal", out: path.join(dir, "fx", "heal"), download })
    expect(calls[0]![0]).toBe("start")
    expect(calls[0]![1]).toBe("--sprite")
    expect(calls[0]![2]).toMatch(/^data:image\/png;base64,/)
    expect(JSON.parse(await readFile(path.join(dir, "fx", "heal.vfx.json"), "utf8")).source.sprite).toBe("../hero.png")
    expect(await readVfxRecipe(path.join(dir, "fx", "heal.vfx.json"))).toEqual({ recipe: RECIPE, sprite: path.join(dir, "hero.png") })
    expect(await resolveVfxSprite("character:abc:south")).toBe("character:abc:south")
  })

  it("refuses ambiguous or empty starts and existing files before calling anything", async () => {
    const { client, download } = fake([])
    await expect(makeVfx(client, { preset: "flame", effect: EFFECT, out: path.join(dir, "x"), download })).rejects.toThrow(/not several/)
    await expect(makeVfx(client, { out: path.join(dir, "x"), download })).rejects.toThrow(/something to start from/)
    await writeFile(path.join(dir, "x.gif"), "old")
    await expect(makeVfx(client, { preset: "flame", out: path.join(dir, "x"), download })).rejects.toThrow(/already exists/)
    expect(client.callTool).not.toHaveBeenCalled()
    expect(existsSync(path.join(dir, "x.vfx.json"))).toBe(false)
  })

  it("reads a bare recipe file and rejects a file that is not one", async () => {
    await writeFile(path.join(dir, "bare.json"), JSON.stringify(RECIPE))
    expect(await readVfxRecipe(path.join(dir, "bare.json"))).toEqual({ recipe: RECIPE })
    await writeFile(path.join(dir, "atlas.json"), JSON.stringify(ATLAS))
    await expect(readVfxRecipe(path.join(dir, "atlas.json"))).rejects.toThrow(/not a VFX recipe/)
  })
})

describe("parseArgs: vfx", () => {
  it("defaults to make, takes the listing subcommands, and reads the new flags", () => {
    expect(parseArgs(["vfx", "--preset", "explosion", "--part", "scorch_mark", "--part", "smoke_puff", "--out", "fx/boom", "--game-pack", "--fps", "12"]))
      .toMatchObject({ command: "vfx", subcommand: "make", preset: "explosion", parts: ["scorch_mark", "smoke_puff"], out: "fx/boom", gamePack: true, fps: 12 })
    expect(parseArgs(["vfx", "presets"]).subcommand).toBe("presets")
    expect(parseArgs(["vfx", "--recipe", "fx/boom.vfx.json", "--sprite", "character:abc:south", "--out", "o"]))
      .toMatchObject({ recipe: "fx/boom.vfx.json", sprite: "character:abc:south" })
    expect(() => parseArgs(["vfx", "sparkle"])).toThrow(/Unknown vfx subcommand/)
    expect(() => parseArgs(["vfx", "--fps", "0"])).toThrow(/--fps/)
  })
})
