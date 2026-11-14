import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { existsSync } from "node:fs"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { PixelLabClient } from "../src/client.ts"
import { parseArgs } from "../src/cli/args.ts"
import { runTalk } from "../src/cli/commands/talk.ts"
import { cutStrip, joinStrip, makeTalkingGif, makeVisemes, planLipSync, readTalkRecord, talkOutputPaths, visemeCost } from "../src/pixellab-talk.ts"
import { decodePng, encodeRgbaPng } from "../src/png.ts"

const ORDER = ["rest", "closed", "small_open", "medium_open", "wide_open", "round", "teeth"]
const cell = (fill: number) => encodeRgbaPng(4, 4, Buffer.alloc(64, fill))
const GIF = Buffer.concat([Buffer.from("GIF89a"), Buffer.alloc(20)])
let dir: string
let posts: Array<{ url: string; body: Record<string, unknown> }>
let polls: number
let jobReply: Record<string, unknown>

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "pixelkiln-talk-"))
  posts = []
  polls = 0
  jobReply = {
    status: "completed", mood: "happy", viseme_count: 7, character_id: null, completed_visemes: ORDER,
    // Keys deliberately out of column order, as PixelLab returns them.
    visemes: Object.fromEntries([...ORDER].reverse().map((id) => [id, { type: "base64", base64: cell(ORDER.indexOf(id) * 10).toString("base64"), format: "png" }])),
  }
  vi.stubGlobal("fetch", vi.fn(async (input: string, init?: RequestInit) => {
    const url = String(input).replace("https://api.pixellab.ai/v2", "")
    if (init?.method === "POST") posts.push({ url, body: JSON.parse(String(init.body)) })
    if (url === "/vocal-animation") return new Response(JSON.stringify({ background_job_id: "job1", status: "processing" }), { status: 202 })
    if (url === "/vocal-animation/job1") return new Response(JSON.stringify(++polls < 2 ? { status: "processing", completed_visemes: ["rest"] } : jobReply), { status: 200 })
    if (url === "/background-jobs/job1") return new Response(JSON.stringify({ id: "job1", status: "completed", usage: { type: "generations", generations: 3 } }), { status: 200 })
    if (url === "/talking-gif") return new Response(JSON.stringify({ gif_base64: GIF.toString("base64"), frames: 35, duration_ms: 3750, frame_ms: 90, hold_ms: 600, width: 4, height: 4, mood: null }), { status: 200 })
    if (url === "/lip-sync") {
      return new Response(JSON.stringify({
        text: "Hi", total_ms: 780, viseme_order: ORDER, mood: null, grid_url: null, row: null,
        frames: [{ viseme: "rest", column: 0, duration_ms: 90, text_offset: 0 }, { viseme: "teeth", column: 6, duration_ms: 690, text_offset: 2 }],
      }), { status: 200 })
    }
    if (url === "https://cdn.pixellab.ai/grid.png") return new Response(encodeRgbaPng(28, 8, Buffer.alloc(28 * 8 * 4, 5)), { status: 200 })
    return new Response("not found", { status: 404 })
  }))
})
afterEach(async () => {
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
  await rm(dir, { recursive: true, force: true })
})

describe("the price of mouth positions", () => {
  it("follows PixelLab's table for 7 and scales other counts", () => {
    expect([visemeCost("pixminimax", 64, 7), visemeCost("pixminimax", 256, 7)]).toEqual([3, 3])
    expect([visemeCost("v3", 64, 7), visemeCost("v3", 128, 7), visemeCost("v3", 129, 7), visemeCost("v3", "unknown", 7)]).toEqual([3, 6, 24, 24])
    expect([visemeCost("v3", 64, 3), visemeCost("v3", 64, 12), visemeCost("pixminimax", 64, 12)]).toEqual([2, 6, 6])
  })
})

describe("strips", () => {
  it("joins cells in order and cuts them back, one row at a time", () => {
    const joined = joinStrip([cell(10), cell(20), cell(30)])
    expect([joined.width, joined.height]).toEqual([4, 4])
    const sheet = decodePng(joined.png)
    expect([sheet.width, sheet.height, sheet.pixels[0], sheet.pixels[4 * 4], sheet.pixels[8 * 4]]).toEqual([12, 4, 10, 20, 30])
    expect(cutStrip(joined.png, 3, { width: 4, height: 4 }).map((png) => decodePng(png).pixels[0])).toEqual([10, 20, 30])
    expect(() => cutStrip(joined.png, 4, { width: 4, height: 4 })).toThrow(/changed after it was made/)
    expect(() => joinStrip([cell(1), encodeRgbaPng(8, 4, Buffer.alloc(128))])).toThrow(/different sizes/)
    expect(talkOutputPaths("fx/robot.talk.json").strip.endsWith(path.join("fx", "robot.visemes.png"))).toBe(true)
  })
})

describe("talk visemes", () => {
  it("draws a portrait's positions, writes the strip in column order, and records the bill", async () => {
    await writeFile(path.join(dir, "face.png"), encodeRgbaPng(64, 64, Buffer.alloc(64 * 64 * 4, 9)))
    const res = await makeVisemes(new PixelLabClient("key"), { portrait: path.join(dir, "face.png"), mood: "happy", engine: "pixminimax", out: path.join(dir, "robot"), sleep: async () => {} })
    expect(posts[0]!.body).toMatchObject({ mood: "happy", viseme_count: 7, engine: "pixminimax", portrait: { type: "base64", format: "png" } })
    expect(posts[0]!.body).not.toHaveProperty("character_id")
    expect(res).toMatchObject({ visemeOrder: ORDER, cell: { width: 4, height: 4 }, mood: "happy", usage: { generations: 3 }, source: { portrait: "face.png" } })
    const strip = decodePng(await readFile(path.join(dir, "robot.visemes.png")))
    expect([strip.width, strip.pixels[0], strip.pixels[6 * 4 * 4]]).toEqual([28, 0, 60])
    const { record, visemes } = await readTalkRecord(path.join(dir, "robot.talk.json"))
    expect(record.strip).toBe("robot.visemes.png")
    expect(Object.keys(visemes)).toEqual(ORDER)
    expect(decodePng(Buffer.from(visemes.teeth!.base64, "base64")).pixels[0]).toBe(60)
    await expect(makeVisemes(new PixelLabClient("key"), { portrait: path.join(dir, "face.png"), out: path.join(dir, "robot"), sleep: async () => {} })).rejects.toThrow(/already exists/)
  })

  it("downloads a character's stored grid and records its row order", async () => {
    jobReply = { status: "completed", mood: "sad", character_id: "c1", completed_visemes: ORDER, visemes: null, moods_on_character: ["neutral", "sad"], grid_url: "https://cdn.pixellab.ai/grid.png", viseme_order: ORDER }
    const res = await makeVisemes(new PixelLabClient("key"), { characterId: "c1", mood: "sad", out: path.join(dir, "hero"), sleep: async () => {} })
    expect(posts[0]!.body).toMatchObject({ character_id: "c1", mood: "sad" })
    expect(res).toMatchObject({ cell: { width: 4, height: 4 }, moodsOnCharacter: ["neutral", "sad"], source: { characterId: "c1" } })
    // The record's own mood is the second row of the grid.
    expect(Object.keys((await readTalkRecord(path.join(dir, "hero.talk.json"))).visemes)).toHaveLength(7)
  })

  it("refuses a portrait that is too large or not a PNG, and both or neither source", async () => {
    await writeFile(path.join(dir, "big.png"), encodeRgbaPng(300, 8, Buffer.alloc(300 * 8 * 4)))
    await expect(makeVisemes(new PixelLabClient("key"), { portrait: path.join(dir, "big.png"), out: path.join(dir, "a") })).rejects.toThrow(/at most 256x256/)
    await expect(makeVisemes(new PixelLabClient("key"), { out: path.join(dir, "a") })).rejects.toThrow(/portrait file or a character id/)
    expect(posts).toHaveLength(0)
  })

  it("prices before it sends and holds --budget to the price", async () => {
    await writeFile(path.join(dir, "face.png"), encodeRgbaPng(128, 128, Buffer.alloc(128 * 128 * 4, 9)))
    const lines: string[] = []
    vi.spyOn(console, "log").mockImplementation((line: string) => void lines.push(line))
    const base = ["talk", "visemes", "--from", path.join(dir, "face.png"), "--out", path.join(dir, "r"), "--dry-run"]
    await runTalk(parseArgs(base))
    expect(lines.join("\n")).toMatch(/7 mouth positions, neutral, by v3[\s\S]*about 6 generations \(PixelLab's published price\)/)
    await runTalk(parseArgs([...base, "--visemes", "12", "--engine", "pixminimax"]))
    expect(lines.join("\n")).toMatch(/about 6 generations \(scaled from PixelLab's price for 7 positions; an estimate\)/)
    await runTalk(parseArgs(["talk", "visemes", "--id", "c1", "--out", path.join(dir, "r"), "--dry-run"]))
    expect(lines.join("\n")).toMatch(/about 24 generations[\s\S]*priced as a 256px portrait/)
    await expect(runTalk(parseArgs([...base, "--budget", "5"]))).rejects.toThrow(/below the 6 generations/)
    await expect(runTalk(parseArgs([...base, "--visemes", "4"]))).rejects.toThrow(/--visemes must be 3, 5, 7, 12/)
    await expect(runTalk(parseArgs([...base, "--engine", "v9"]))).rejects.toThrow(/--engine must be/)
    await expect(runTalk(parseArgs([...base, "--mood", "bored"]))).rejects.toThrow(/--mood must be one of/)
    await expect(runTalk(parseArgs(["talk", "visemes", "--out", "r"]))).rejects.toThrow(/one of them/)
    expect(() => parseArgs(["talk"])).toThrow(/needs a subcommand/)
    expect(() => parseArgs(["talk", "sing"])).toThrow(/Unknown talk subcommand/)
    expect(posts).toHaveLength(0)
  })
})

describe("talk gif and talk plan", () => {
  async function record(): Promise<string> {
    await writeFile(path.join(dir, "face.png"), encodeRgbaPng(64, 64, Buffer.alloc(64 * 64 * 4, 9)))
    await makeVisemes(new PixelLabClient("key"), { portrait: path.join(dir, "face.png"), out: path.join(dir, "robot"), sleep: async () => {} })
    posts = []
    return path.join(dir, "robot.talk.json")
  }

  it("sends a record's positions with the line and writes the GIF", async () => {
    const file = await record()
    const res = await makeTalkingGif(new PixelLabClient("key"), "  Fire once.  ", { record: file }, { out: path.join(dir, "line"), frameMs: 80, holdMs: 0 })
    expect(posts[0]!.body).toMatchObject({ text: "Fire once.", frame_ms: 80, hold_ms: 0 })
    expect(Object.keys(posts[0]!.body.visemes as object).sort()).toEqual([...ORDER].sort())
    expect(res).toMatchObject({ frames: 35, durationMs: 3750 })
    expect((await readFile(path.join(dir, "line.gif"))).equals(GIF)).toBe(true)
    await expect(makeTalkingGif(new PixelLabClient("key"), "again", { record: file }, { out: path.join(dir, "line") })).rejects.toThrow(/already exists/)
  })

  it("uses a character's stored positions by id and mood", async () => {
    await makeTalkingGif(new PixelLabClient("key"), "Hello", { characterId: "c1", mood: "angry" }, { out: path.join(dir, "c.gif") })
    expect(posts[0]!.body).toEqual({ text: "Hello", character_id: "c1", mood: "angry" })
  })

  it("refuses an empty or over-long line, a mood on a record, and a strip that was changed", async () => {
    const file = await record()
    const client = new PixelLabClient("key")
    await expect(makeTalkingGif(client, "   ", { record: file }, { out: path.join(dir, "x") })).rejects.toThrow(/empty/)
    await expect(makeTalkingGif(client, "x".repeat(501), { record: file }, { out: path.join(dir, "x") })).rejects.toThrow(/at most 500/)
    await expect(makeTalkingGif(client, "hi", { record: file, mood: "sad" }, { out: path.join(dir, "x") })).rejects.toThrow(/one expression/)
    await writeFile(path.join(dir, "robot.visemes.png"), encodeRgbaPng(8, 4, Buffer.alloc(128)))
    await expect(makeTalkingGif(client, "hi", { record: file }, { out: path.join(dir, "x") })).rejects.toThrow(/changed after it was made/)
    await writeFile(path.join(dir, "other.json"), "{}")
    await expect(readTalkRecord(path.join(dir, "other.json"))).rejects.toThrow(/not a .talk.json record/)
    expect(posts).toHaveLength(0)
    expect(existsSync(path.join(dir, "x.gif"))).toBe(false)
  })

  it("plans a line against a record, a character, or a bare preset", async () => {
    const file = await record()
    const plan = await planLipSync(new PixelLabClient("key"), "Hi", { record: file })
    expect(posts[0]!.body).toEqual({ text: "Hi", viseme_count: 7 })
    expect(plan).toMatchObject({ totalMs: 780, strip: "robot.visemes.png", row: 0, cell: { width: 4, height: 4 }, visemeOrder: ORDER })
    expect(plan.frames).toEqual([{ viseme: "rest", column: 0, durationMs: 90, textOffset: 0 }, { viseme: "teeth", column: 6, durationMs: 690, textOffset: 2 }])
    await planLipSync(new PixelLabClient("key"), "Hi", { characterId: "c1", mood: "sad" }, { frameMs: 50 })
    expect(posts[1]!.body).toEqual({ text: "Hi", character_id: "c1", mood: "sad", frame_ms: 50 })
    await planLipSync(new PixelLabClient("key"), "Hi", { visemeCount: 3 })
    expect(posts[2]!.body).toEqual({ text: "Hi", viseme_count: 3 })
    await expect(planLipSync(new PixelLabClient("key"), "Hi", {})).rejects.toThrow(/give one of/)
  })

  it("writes a plan to --out and checks its flags at the command", async () => {
    const file = await record()
    vi.stubEnv("PIXELLAB_API_KEY", "key")
    vi.spyOn(console, "log").mockImplementation(() => {})
    await runTalk(parseArgs(["talk", "plan", "--from", file, "--text", "Hi", "--out", path.join(dir, "plan")]))
    expect(JSON.parse(await readFile(path.join(dir, "plan.json"), "utf8"))).toMatchObject({ version: 1, totalMs: 780 })
    await expect(runTalk(parseArgs(["talk", "plan", "--text", "Hi"]))).rejects.toThrow(/needs one of/)
    await expect(runTalk(parseArgs(["talk", "plan", "--visemes", "7"]))).rejects.toThrow(/needs --text/)
    await expect(runTalk(parseArgs(["talk", "plan", "--visemes", "7", "--text", "Hi", "--mood", "sad"]))).rejects.toThrow(/--mood picks among a character/)
    await expect(runTalk(parseArgs(["talk", "gif", "--text", "Hi", "--out", "x"]))).rejects.toThrow(/needs --from/)
    await expect(runTalk(parseArgs(["talk", "gif", "--from", file, "--id", "c1", "--text", "Hi", "--out", "x"]))).rejects.toThrow(/not both/)
    await expect(runTalk(parseArgs(["talk", "gif", "--from", file, "--text", "Hi"]))).rejects.toThrow(/needs --out/)
    await expect(runTalk(parseArgs(["talk", "gif", "--from", path.join(dir, "nope.json"), "--text", "Hi", "--out", "x"]))).rejects.toThrow(/does not exist/)
  })
})
