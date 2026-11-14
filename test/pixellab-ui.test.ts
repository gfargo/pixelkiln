import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { existsSync } from "node:fs"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import {
  checkUiInsets,
  createUiStates,
  parseUiBox,
  parseUiInsets,
  parseUiState,
  pullUiAsset,
  uiStateElements,
} from "../src/pixellab-ui.ts"
import { PixelLabClient } from "../src/client.ts"
import { parseArgs } from "../src/cli/args.ts"
import { encodeRgbaPng } from "../src/png.ts"

const PNG = encodeRgbaPng(4, 4, Buffer.alloc(64, 200))
const part = (id: string, extra: Record<string, unknown> = {}) => ({
  id, name: null, kind: "element", size: { width: 86, height: 38 }, image_url: `https://cdn/${id}.png`, nine_slice: null, states: [], ...extra,
})
const template = (extra: Record<string, unknown> = {}) => ({
  id: "tpl", name: null, prompt: "a dialog box", size: { width: 256, height: 192 }, image_url: "https://cdn/tpl.png",
  status: "completed", kind: "template", nine_slice: null, elements: [], states: [], split_preview: [], ...extra,
}) as never

let dir: string
beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "pixelkiln-ui-"))
})
afterEach(async () => {
  vi.unstubAllGlobals()
  await rm(dir, { recursive: true, force: true })
})

describe("ui argument forms", () => {
  it("parses a state, keeping commas and = in the description", () => {
    expect(parseUiState("pressed=pushed in: darker, face 1 px lower (y=+1)")).toEqual({ name: "pressed", description: "pushed in: darker, face 1 px lower (y=+1)" })
    expect(() => parseUiState("hover")).toThrow(/name=description/)
  })
  it("parses a box with and without a label", () => {
    expect(parseUiBox("Play:40,30,120,40")).toEqual({ label: "Play", x: 40, y: 30, width: 120, height: 40 })
    expect(parseUiBox("0,0,16,16")).toEqual({ x: 0, y: 0, width: 16, height: 16 })
    expect(() => parseUiBox("1,2,0,4")).toThrow(/label:x,y,width,height/)
  })
  it("parses insets and checks they leave a middle", () => {
    expect(parseUiInsets("6")).toEqual({ left: 6, right: 6, top: 6, bottom: 6 })
    expect(parseUiInsets("4, 5, 6, 7")).toEqual({ left: 4, right: 5, top: 6, bottom: 7 })
    expect(() => parseUiInsets("1,2")).toThrow(/insets/)
    expect(() => checkUiInsets({ left: 43, right: 43, top: 6, bottom: 6 }, { width: 86, height: 38 })).toThrow(/no middle/)
    expect(() => checkUiInsets({ left: 6, right: 6, top: 6, bottom: 6 }, { width: 86, height: 38 })).not.toThrow()
  })
  it("reads the ui command line", () => {
    const args = parseArgs(["ui", "states", "--id", "tpl", "--state", "hover=brighter, glow", "--state", "pressed=darker", "--element", "a,b"])
    expect(args).toMatchObject({ command: "ui", subcommand: "states", id: "tpl", uiStates: ["hover=brighter, glow", "pressed=darker"], elements: ["a", "b"] })
    expect(() => parseArgs(["ui"])).toThrow(/needs a subcommand/)
    expect(() => parseArgs(["ui", "slice"])).toThrow(/Unknown ui subcommand/)
  })
})

describe("uiStateElements", () => {
  it("uses every element of a split template, or the ones named, or the element itself", () => {
    const split = template({ elements: [part("a"), part("b")] })
    expect(uiStateElements(split)).toEqual(["a", "b"])
    expect(uiStateElements(split, ["b"])).toEqual(["b"])
    expect(() => uiStateElements(split, ["zzz"])).toThrow(/not elements of template tpl: zzz/)
    expect(uiStateElements(template({ id: "a", kind: "element" }))).toEqual(["a"])
  })
  it("refuses a template that is not split, and a state", () => {
    expect(() => uiStateElements(template())).toThrow(/has not been split.*ui split --id tpl/)
    expect(() => uiStateElements(template({ kind: "state" }))).toThrow(/is a state/)
  })
})

describe("createUiStates", () => {
  it("submits the template's elements, reports the quote, waits, and returns the bill", async () => {
    const sent: unknown[] = []
    let polls = 0
    const quotes: number[][] = []
    const res = await createUiStates({
      getUiAssetDetail: async () => template({ elements: [part("a"), part("b")] }),
      createUiStates: async (args: unknown) => { sent.push(args); return { background_job_id: "job", status: "processing", generations: 15, count: 4 } },
      getBackgroundJob: async () => (++polls < 2 ? { id: "job", status: "processing" } : { id: "job", status: "completed", usage: { type: "generations", generations: 15 } }),
    } as never, {
      uiAssetId: "tpl",
      states: [{ name: "hover", description: "brighter" }, { name: "pressed", description: "darker" }],
      targetPalette: { colors: ["#000000", "#ffffff"] },
      onQuote: (g, c) => quotes.push([g, c]),
      sleep: async () => {},
    })
    expect(sent[0]).toMatchObject({ elementIds: ["a", "b"], states: [{ name: "hover" }, { name: "pressed" }], targetPalette: { colors: ["#000000", "#ffffff"] } })
    expect(quotes).toEqual([[15, 4]])
    expect(res).toMatchObject({ jobId: "job", quotedGenerations: 15, count: 4, usage: { generations: 15 } })
  })
  it("sends nothing for a template that is not split, and surfaces a failed job", async () => {
    let submitted = false
    const unsplit = { getUiAssetDetail: async () => template(), createUiStates: async () => { submitted = true; return {} }, getBackgroundJob: async () => ({}) } as never
    await expect(createUiStates(unsplit, { uiAssetId: "tpl", states: [{ name: "h", description: "d" }] })).rejects.toThrow(/has not been split/)
    expect(submitted).toBe(false)
    const failing = {
      getUiAssetDetail: async () => template({ id: "a", kind: "element" }),
      createUiStates: async () => ({ background_job_id: "job", status: "processing", generations: 10, count: 1 }),
      getBackgroundJob: async () => ({ id: "job", status: "failed" }),
    } as never
    await expect(createUiStates(failing, { uiAssetId: "a", states: [{ name: "h", description: "d" }], sleep: async () => {} })).rejects.toThrow(/failed upstream/)
  })
})

describe("pullUiAsset", () => {
  const split = template({
    elements: [
      part("a", { template_box: { label: "Button", x: 29, y: 29, width: 86, height: 38 }, nine_slice: { left: 6, right: 6, top: 6, bottom: 6 },
        states: [part("a-h", { kind: "state", name: "Hover" }), part("a-p", { kind: "state", name: "Pressed" })] }),
      part("b", { template_box: { label: "", x: 5, y: 5, width: 38, height: 38 } }),
      part("c", { template_box: { label: "Button", x: 100, y: 5, width: 38, height: 38 } }),
    ],
  })
  const client = (asset: unknown, bytes = PNG) => ({ getUiAssetDetail: async () => asset, download: async () => bytes }) as never

  it("writes the template, each element and each state, with boxes and insets in the record", async () => {
    const res = await pullUiAsset(client(split), "tpl", { out: dir })
    expect(res.files.map((f) => f.file)).toEqual([
      "template.png", "elements/button.png", "elements/button.hover.png", "elements/button.pressed.png", "elements/element-2.png", "elements/button-2.png",
    ])
    const record = JSON.parse(await readFile(path.join(dir, "ui.json"), "utf8"))
    expect(record).toMatchObject({ schema: "pixelkiln-ui", version: 1, uiAssetId: "tpl", kind: "template" })
    expect(record.files[1]).toMatchObject({ id: "a", kind: "element", box: { label: "Button", x: 29, y: 29 }, nineSlice: { left: 6, right: 6, top: 6, bottom: 6 } })
    expect(record.files[2]).toMatchObject({ id: "a-h", kind: "state", elementId: "a" })
    expect(existsSync(path.join(dir, "elements", "button.pressed.png"))).toBe(true)
  })
  it("refuses to overwrite, a body that is not a PNG, and an asset still generating", async () => {
    await pullUiAsset(client(split), "tpl", { out: dir })
    await expect(pullUiAsset(client(split), "tpl", { out: dir })).rejects.toThrow(/already exists/)
    await expect(pullUiAsset(client(split, Buffer.from("<html>")), "tpl", { out: path.join(dir, "x") })).rejects.toThrow(/PNG/)
    await expect(pullUiAsset(client(template({ status: "processing", image_url: null })), "tpl", { out: path.join(dir, "y") })).rejects.toThrow(/is processing/)
  })
})

describe("client requests", () => {
  function recording(reply: unknown) {
    const calls: Array<{ url: string; method: string; body: unknown }> = []
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url: String(url), method: init?.method ?? "GET", body: init?.body ? JSON.parse(String(init.body)) : undefined })
      return new Response(JSON.stringify(reply), { status: 200, headers: { "content-type": "application/json" } })
    }))
    return { client: new PixelLabClient("key"), calls }
  }
  it("posts split boxes only when given, states with a target palette, and a 9-slice patch", async () => {
    const split = recording({ elements: [part("a")] })
    await split.client.splitUiAsset("tpl")
    await split.client.splitUiAsset("tpl", [{ label: "Play", x: 1, y: 2, width: 3, height: 4 }])
    expect(split.calls.map((c) => [c.method, c.url.split("/v2")[1], c.body])).toEqual([
      ["POST", "/ui-assets/tpl/split", {}],
      ["POST", "/ui-assets/tpl/split", { boxes: [{ label: "Play", x: 1, y: 2, width: 3, height: 4 }] }],
    ])
    const states = recording({ background_job_id: "job", generations: 10, count: 2 })
    await states.client.createUiStates({ elementIds: ["a"], states: [{ name: "hover", description: "brighter" }], targetPalette: { colors: ["#000000", "#ffffff"], maxColors: 2 } })
    expect(states.calls[0]!.body).toMatchObject({ element_ids: ["a"], states: [{ name: "hover", description: "brighter" }], target_palette: { colors: ["#000000", "#ffffff"], max_colors: 2 } })
    const patch = recording(template({ id: "a", kind: "element", nine_slice: { left: 6, right: 6, top: 6, bottom: 6 } }))
    const updated = await patch.client.updateUiAsset("a", { nineSlice: { left: 6, right: 6, top: 6, bottom: 6 } })
    expect(patch.calls[0]).toMatchObject({ method: "PATCH", body: { nine_slice: { left: 6, right: 6, top: 6, bottom: 6 } } })
    expect(updated.nine_slice).toEqual({ left: 6, right: 6, top: 6, bottom: 6 })
    await patch.client.updateUiAsset("a", { clearNineSlice: true })
    expect(patch.calls[1]!.body).toEqual({ clear_nine_slice: true })
  })
})
