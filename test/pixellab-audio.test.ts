import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { existsSync } from "node:fs"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import {
  detectAudioFormat,
  generateMusic,
  generateSoundEffect,
  musicCost,
  musicOutputPaths,
  soundEffectCost,
} from "../src/pixellab-audio.ts"
import { parseArgs } from "../src/cli/args.ts"

const MP3 = Buffer.concat([Buffer.from("ID3"), Buffer.alloc(64, 1)])
const WAV = Buffer.concat([Buffer.from("RIFF"), Buffer.alloc(4), Buffer.from("WAVE"), Buffer.alloc(32, 2)])
let dir: string

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "pixelkiln-audio-"))
})
afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

const song = (id: string, take: number, extra: Record<string, unknown> = {}) => ({
  id, take, status: "completed", name: id, style: "a style", instrumental: true, lyrics: "",
  audio_url: `https://cdn/${id}.mp3`, duration_ms: 42_000, ...extra,
})

function musicClient(overrides: Record<string, unknown> = {}) {
  const calls: string[] = []
  const polls = new Map<string, number>()
  return {
    calls,
    client: {
      createMusic: async (args: Record<string, unknown>) => {
        calls.push(`create:${JSON.stringify(args)}`)
        return { background_job_id: "job-1", status: "processing", quoted_generations: 10, songs: [song("s2", 2, { status: "pending" }), song("s1", 1, { status: "pending" })] }
      },
      loopMusic: async (id: string) => {
        calls.push(`loop:${id}`)
        return { background_job_id: "job-2", status: "processing", quoted_generations: 4, songs: [song("l1", 1), song("l2", 2)] }
      },
      // First poll of each song is still running, to exercise the wait.
      getMusic: async (id: string) => {
        const n = (polls.get(id) ?? 0) + 1
        polls.set(id, n)
        if (n === 1) return song(id, id.endsWith("2") ? 2 : 1, { status: "running", audio_url: null })
        return song(id, id.endsWith("2") ? 2 : 1, id.startsWith("l") ? { loop_of: "s1", loop_start_s: 3.5, loop_end_s: 40.25 } : {})
      },
      download: async (_url: string) => MP3,
      getBackgroundJob: async (id: string) => ({ id, status: "completed", usage: { type: "generations", generations: id === "job-1" ? 10 : 4 } }),
      ...overrides,
    } as never,
  }
}
const fast = { sleep: async () => {}, intervalMs: 0 }

describe("audio helpers", () => {
  it("prices a sound effect by PixelLab's published table", () => {
    expect([0.5, 1.6, 1.7, 3.2, 6, 10, 30].map(soundEffectCost)).toEqual([1, 1, 2, 2, 4, 7, 19])
  })
  it("prices music runs", () => {
    expect([musicCost({}), musicCost({ loop: true }), musicCost({ loopOf: "x" })]).toEqual([10, 14, 4])
  })
  it("tells MP3 and WAV from anything else by their first bytes", () => {
    expect(detectAudioFormat(MP3)).toBe("mp3")
    expect(detectAudioFormat(Buffer.from([0xff, 0xfb, 0x90, 0x00]))).toBe("mp3")
    expect(detectAudioFormat(WAV)).toBe("wav")
    expect(detectAudioFormat(Buffer.from("<html>error</html>"))).toBeNull()
  })
})

describe("generateMusic", () => {
  it("writes both takes in take order and a record, and reports the bill", async () => {
    const { client, calls } = musicClient()
    const res = await generateMusic(client, { style: "calm town theme", bpm: 90, out: path.join(dir, "town"), ...fast })
    expect(res.takes.map((t) => [t.songId, path.basename(t.file)])).toEqual([["s1", "town.mp3"], ["s2", "town.take2.mp3"]])
    expect(res.loops).toEqual([])
    expect(JSON.parse(calls[0]!.slice(7))).toMatchObject({ style: "calm town theme", instrumental: true, bpm: 90 })
    const record = JSON.parse(await readFile(path.join(dir, "town.music.json"), "utf8"))
    expect(record).toMatchObject({ schema: "pixelkiln-music", version: 1, instrumental: true, quotedGenerations: 10 })
    expect(record.takes[0]).toMatchObject({ songId: "s1", file: "town.mp3", durationMs: 42_000 })
    expect(record.usage).toEqual([{ type: "generations", generations: 10 }])
  })

  it("loops take 1 when asked and records the loop points", async () => {
    const { client, calls } = musicClient()
    const res = await generateMusic(client, { style: "s", loop: true, out: path.join(dir, "a"), ...fast })
    expect(calls.at(-1)).toBe("loop:s1")
    expect(res.loops[0]).toMatchObject({ songId: "l1", loopStartS: 3.5, loopEndS: 40.25 })
    expect(res.quotedGenerations).toBe(14)
    expect(existsSync(path.join(dir, "a.loop.take2.mp3"))).toBe(true)
  })

  it("refuses a loop of a song too short to loop before spending, and keeps the takes when PixelLab refuses the loop", async () => {
    const short = musicClient()
    await expect(generateMusic(short.client, { style: "s", loop: true, lengthS: 30, out: path.join(dir, "s"), ...fast })).rejects.toThrow(/at least 36 s/)
    expect(short.calls).toEqual([])

    const refused = musicClient({
      loopMusic: async () => { throw Object.assign(new Error("POST /music/s1/loop → 422"), { body: JSON.stringify({ detail: "A loop needs at least 36 seconds of music" }) }) },
    })
    await expect(generateMusic(refused.client, { style: "s", loop: true, out: path.join(dir, "r"), ...fast }))
      .rejects.toThrow(/refused to loop s1: A loop needs at least 36 seconds.*takes are saved/)
    const record = JSON.parse(await readFile(path.join(dir, "r.music.json"), "utf8"))
    expect(record.takes).toHaveLength(2)
    expect(record.loops).toEqual([])
    expect(existsSync(path.join(dir, "r.mp3"))).toBe(true)
  })

  it("loops an existing song without creating one", async () => {
    const { client, calls } = musicClient()
    const res = await generateMusic(client, { loopOf: "old", out: path.join(dir, "b"), ...fast })
    expect(calls).toEqual(["loop:old"])
    expect(res.takes).toEqual([])
    expect(existsSync(path.join(dir, "b.mp3"))).toBe(false)
  })

  it("sends vocals as not instrumental and refuses to loop them", async () => {
    const { client, calls } = musicClient()
    await generateMusic(client, { style: "s", lyrics: "[Verse]\nla", voice: "warm voice", out: path.join(dir, "v"), ...fast })
    expect(JSON.parse(calls[0]!.slice(7))).toMatchObject({ instrumental: false, lyrics: "[Verse]\nla", voice: "warm voice" })
    await expect(generateMusic(client, { style: "s", autoLyrics: true, loop: true, out: path.join(dir, "w"), ...fast })).rejects.toThrow(/instrumental songs only/)
  })

  it("refuses to overwrite, a failed take, and a download that is not audio", async () => {
    await writeFile(musicOutputPaths(path.join(dir, "x")).takes[1], "old")
    const { client, calls } = musicClient()
    await expect(generateMusic(client, { style: "s", out: path.join(dir, "x"), ...fast })).rejects.toThrow(/already exists/)
    expect(calls).toEqual([])
    const failing = musicClient({ getMusic: async (id: string) => song(id, 1, { status: "failed", error: "refused" }) })
    await expect(generateMusic(failing.client, { style: "s", out: path.join(dir, "y"), ...fast })).rejects.toThrow(/failed upstream: refused/)
    const html = musicClient({ download: async () => Buffer.from("<html>") })
    await expect(generateMusic(html.client, { style: "s", out: path.join(dir, "z"), ...fast })).rejects.toThrow(/not audio/)
    expect(existsSync(path.join(dir, "z.mp3"))).toBe(false)
  })
})

describe("generateSoundEffect", () => {
  const client = (bytes: Buffer) => ({
    createSoundEffect: async (args: { prompt: string; seconds?: number }) => ({
      background_job_id: "job-9", status: "processing", quoted_generations: 1,
      sound_effect: { id: "fx1", status: "pending", name: "", prompt: args.prompt, seconds: args.seconds },
    }),
    getSoundEffect: async () => ({ id: "fx1", status: "completed", name: "", prompt: "p", audio_url: "https://cdn/fx1.wav", duration_ms: 1000 }),
    download: async () => bytes,
    getBackgroundJob: async () => { throw new Error("expired") },
  }) as never

  it("writes the WAV and a record, and survives an unreadable bill", async () => {
    const res = await generateSoundEffect(client(WAV), { prompt: "laser shot", seconds: 1, out: path.join(dir, "laser.wav"), ...fast })
    expect(path.basename(res.file)).toBe("laser.wav")
    expect(res.usage).toBeNull()
    const record = JSON.parse(await readFile(path.join(dir, "laser.sfx.json"), "utf8"))
    expect(record).toMatchObject({ schema: "pixelkiln-sfx", prompt: "laser shot", seconds: 1, soundEffectId: "fx1", file: "laser.wav", quotedGenerations: 1 })
  })
  it("refuses a body that is not a WAV", async () => {
    await expect(generateSoundEffect(client(MP3), { prompt: "p", out: path.join(dir, "n"), ...fast })).rejects.toThrow(/expected wav/)
  })
})

describe("argument parsing", () => {
  it("reads music and sfx flags with their own ranges", () => {
    expect(parseArgs(["music", "--description", "x", "--out", "o", "--bpm", "120", "--seconds", "90", "--loop"])).toMatchObject({ command: "music", subcommand: "make", bpm: 120, seconds: 90, loop: true })
    expect(parseArgs(["music", "lyrics", "--about", "a knight"])).toMatchObject({ subcommand: "lyrics", about: "a knight" })
    expect(parseArgs(["sfx", "--description", "x", "--out", "o", "--seconds", "0.5"])).toMatchObject({ command: "sfx", seconds: 0.5 })
    expect(() => parseArgs(["music", "--description", "x", "--out", "o", "--seconds", "5"])).toThrow(/--seconds/)
    expect(() => parseArgs(["sfx", "--description", "x", "--out", "o", "--seconds", "31"])).toThrow(/--seconds/)
    expect(() => parseArgs(["music", "remix"])).toThrow(/Unknown music subcommand/)
  })
})
