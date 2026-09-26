import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { existsSync } from "node:fs"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { parseArgs } from "../src/cli/args.ts"
import { runEstimateSkeleton } from "../src/cli/commands/skeleton.ts"
import { encodeRgbaPng } from "../src/png.ts"

let dir: string
let quiet: ReturnType<typeof vi.spyOn>

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "pixelkiln-estimate-skeleton-cli-"))
  quiet = vi.spyOn(console, "log").mockImplementation(() => {})
})
afterEach(async () => {
  vi.unstubAllGlobals()
  quiet.mockRestore()
  await rm(dir, { recursive: true, force: true })
})

const joint = (label: string) => ({ label, x: 0.5, y: 0.5, z_index: 1 })
const keypoints = Array.from({ length: 18 }, (_, i) => joint(`JOINT_${i}`))

describe("runEstimateSkeleton", () => {
  it("prints the keypoints JSON, without touching any manifest or lockfile", async () => {
    const image = path.join(dir, "pose.png")
    await writeFile(image, encodeRgbaPng(4, 4, Buffer.alloc(4 * 4 * 4, 10)))
    await writeFile(path.join(dir, ".env.local"), "PIXELLAB_API_KEY=test-key\n")

    let requestBody: unknown = null
    vi.stubGlobal("fetch", vi.fn(async (input: string, init?: RequestInit) => {
      expect(new URL(String(input)).pathname).toBe("/v2/estimate-skeleton")
      requestBody = init?.body ? JSON.parse(String(init.body)) : null
      return new Response(JSON.stringify({ keypoints }), { status: 200 })
    }))

    const args = parseArgs(["estimate-skeleton", image, "--manifest", path.join(dir, "pixelkiln.manifest.json")])
    await runEstimateSkeleton(args)

    expect((requestBody as { image: { format: string } }).image.format).toBe("png")
    expect(JSON.parse(quiet.mock.calls[0]![0] as string)).toEqual(keypoints)
    // The property that distinguishes this from every other command: it
    // never reads or writes a manifest or lockfile, even though --manifest
    // points at one that doesn't exist.
    expect(existsSync(path.join(dir, "pixelkiln.manifest.json"))).toBe(false)
    expect(existsSync(path.join(dir, "pixelkiln.lock.json"))).toBe(false)
  })

  it("writes to --out instead of printing when given", async () => {
    const image = path.join(dir, "pose.png")
    await writeFile(image, encodeRgbaPng(4, 4, Buffer.alloc(4 * 4 * 4, 10)))
    await writeFile(path.join(dir, ".env.local"), "PIXELLAB_API_KEY=test-key\n")
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ keypoints }), { status: 200 })))

    const out = path.join(dir, "keypoints.json")
    const args = parseArgs(["estimate-skeleton", image, "--out", out, "--manifest", path.join(dir, "pixelkiln.manifest.json")])
    await runEstimateSkeleton(args)

    expect(JSON.parse(await readFile(out, "utf8"))).toEqual(keypoints)
  })

  it("rejects a file that isn't a readable image", async () => {
    const notImage = path.join(dir, "notes.txt")
    await writeFile(notImage, "hello")
    const args = parseArgs(["estimate-skeleton", notImage, "--manifest", path.join(dir, "pixelkiln.manifest.json")])
    await expect(runEstimateSkeleton(args)).rejects.toThrow(/is not a readable PNG or JPEG/)
  })
})
