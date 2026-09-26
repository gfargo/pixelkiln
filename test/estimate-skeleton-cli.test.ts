import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { existsSync } from "node:fs"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { parseArgs } from "../src/cli/args.ts"
import { runEstimateSkeleton, runSkeletonPreview } from "../src/cli/commands/skeleton.ts"
import { decodePng, encodeRgbaPng } from "../src/png.ts"
import { SKELETON_LABELS, parseSkeletonSet, scaffoldSkeletonSet } from "../src/skeleton.ts"

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

// A standing figure: head at the top, limbs spread, so bones cross the cell.
const keypoints = SKELETON_LABELS.map((label, i) => ({
  label,
  x: label.startsWith("RIGHT") ? 0.3 : label.startsWith("LEFT") ? 0.7 : 0.5,
  y: Math.min(0.95, 0.1 + i * 0.05),
  z_index: 1,
}))

async function sprite(size = 32): Promise<string> {
  const image = path.join(dir, "pose.png")
  await writeFile(image, encodeRgbaPng(size, size, Buffer.alloc(size * size * 4, 10)))
  await writeFile(path.join(dir, ".env.local"), "PIXELLAB_API_KEY=test-key\n")
  return image
}

function stubEstimate() {
  let requestBody: unknown = null
  vi.stubGlobal("fetch", vi.fn(async (input: string, init?: RequestInit) => {
    expect(new URL(String(input)).pathname).toBe("/v2/estimate-skeleton")
    requestBody = init?.body ? JSON.parse(String(init.body)) : null
    return new Response(JSON.stringify({ keypoints }), { status: 200 })
  }))
  return () => requestBody as { image: { type: string; format: string } }
}

const manifestFlag = () => ["--manifest", path.join(dir, "pixelkiln.manifest.json")]

describe("runEstimateSkeleton", () => {
  it("prints a whole keypoints file, without touching any manifest or lockfile", async () => {
    const body = stubEstimate()
    await runEstimateSkeleton(parseArgs(["estimate-skeleton", await sprite(), ...manifestFlag()]))

    expect(body().image).toMatchObject({ type: "base64", format: "png" })
    const printed = JSON.parse(quiet.mock.calls[0]![0] as string)
    // The output is the shape a revision's keypointsFile must parse as.
    expect(parseSkeletonSet(printed, "stdout")).toEqual(scaffoldSkeletonSet(keypoints))
    expect(printed.frames).toHaveLength(4)
    // The property that distinguishes this from every other command: it
    // never reads or writes a manifest or lockfile, even though --manifest
    // points at one that doesn't exist.
    expect(existsSync(path.join(dir, "pixelkiln.manifest.json"))).toBe(false)
    expect(existsSync(path.join(dir, "pixelkiln.lock.json"))).toBe(false)
  })

  it("writes --frames copies to --out, and will not replace hand edits without --force", async () => {
    stubEstimate()
    const image = await sprite()
    const out = path.join(dir, "keypoints.json")
    await runEstimateSkeleton(parseArgs(["estimate-skeleton", image, "--out", out, "--frames", "6", ...manifestFlag()]))
    const written = parseSkeletonSet(JSON.parse(await readFile(out, "utf8")), out)
    expect(written.firstFrameKeypoints).toEqual(keypoints)
    expect(written.frames).toHaveLength(6)

    await writeFile(out, "hand edited")
    await expect(runEstimateSkeleton(parseArgs(["estimate-skeleton", image, "--out", out, ...manifestFlag()])))
      .rejects.toThrow(/already exists; pass --force/)
    expect(await readFile(out, "utf8")).toBe("hand edited")
    await runEstimateSkeleton(parseArgs(["estimate-skeleton", image, "--out", out, "--force", ...manifestFlag()]))
    expect(JSON.parse(await readFile(out, "utf8")).frames).toHaveLength(4)
    expect(() => parseArgs(["estimate-skeleton", image, "--frames", "2"])).toThrow(/--frames/)
  })

  it("refuses a file that isn't a readable image, or a size the endpoint does not take, before any call", async () => {
    const fetch = vi.fn()
    vi.stubGlobal("fetch", fetch)
    const notImage = path.join(dir, "notes.txt")
    await writeFile(notImage, "hello")
    await expect(runEstimateSkeleton(parseArgs(["estimate-skeleton", notImage, ...manifestFlag()])))
      .rejects.toThrow(/is not a readable PNG or JPEG/)
    await expect(runEstimateSkeleton(parseArgs(["estimate-skeleton", await sprite(48), ...manifestFlag()])))
      .rejects.toThrow(/48x48; estimate-skeleton takes a square image of 16, 32, 64, 128, 256 pixels/)
    expect(fetch).not.toHaveBeenCalled()
  })
})

describe("runSkeletonPreview", () => {
  it("draws every pose over the source beside the keypoints file, making no network call", async () => {
    const fetch = vi.fn()
    vi.stubGlobal("fetch", fetch)
    const image = await sprite(32)
    const file = path.join(dir, "swing.json")
    await writeFile(file, JSON.stringify(scaffoldSkeletonSet(keypoints, 3)))
    await runSkeletonPreview(parseArgs(["skeleton-preview", file, "--from", image]))

    const sheet = decodePng(await readFile(path.join(dir, "swing.preview.png")))
    // Four cells (the starting pose and three frames), each the 32px source
    // upscaled 6x to 192px, with a 4px gutter around and between them.
    expect(sheet.width).toBe(4 * 192 + 5 * 4)
    expect(sheet.height).toBe(192 + 2 * 4)
    // A right-side bone is drawn in orange somewhere on the sheet.
    let orange = 0
    for (let i = 0; i < sheet.pixels.length; i += 4) {
      if (sheet.pixels[i] === 255 && sheet.pixels[i + 1] === 140 && sheet.pixels[i + 2] === 40) orange++
    }
    expect(orange).toBeGreaterThan(0)
    expect(fetch).not.toHaveBeenCalled()
  })

  it("reads an animate-skeleton asset's keypoints file and source from the manifest", async () => {
    await mkdir(path.join(dir, "art"))
    await writeFile(path.join(dir, "art", "hero.png"), encodeRgbaPng(64, 64, Buffer.alloc(64 * 64 * 4, 30)))
    await writeFile(path.join(dir, "poses.json"), JSON.stringify(scaffoldSkeletonSet(keypoints, 3)))
    const manifest = path.join(dir, "pixelkiln.manifest.json")
    await writeFile(manifest, JSON.stringify({
      name: "t",
      provider: "pixellab",
      styles: { s: { outDir: "art" } },
      assets: {
        hero: { prompt: "a knight", width: 64, height: 64 },
        "hero-swing": { prompt: "swing", revision: { mode: "animate-skeleton", from: "hero", keypointsFile: "poses.json", direction: "south" } },
        other: { prompt: "a rock", width: 64, height: 64 },
      },
    }))
    const out = path.join(dir, "sheet.png")
    await runSkeletonPreview(parseArgs(["skeleton-preview", "hero-swing", "--manifest", manifest, "--out", out]))
    // A 64px source is upscaled 3x to 192px.
    expect(decodePng(await readFile(out)).height).toBe(192 + 2 * 4)

    await expect(runSkeletonPreview(parseArgs(["skeleton-preview", "other", "--manifest", manifest])))
      .rejects.toThrow(/other is not an animate-skeleton revision/)
    await writeFile(path.join(dir, "poses.json"), JSON.stringify({ firstFrameKeypoints: keypoints, frames: [keypoints] }))
    await expect(runSkeletonPreview(parseArgs(["skeleton-preview", path.join(dir, "poses.json")])))
      .rejects.toThrow(/does not match the expected shape: frames/)
  })
})
