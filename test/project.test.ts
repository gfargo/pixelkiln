import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { existsSync } from "node:fs"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { openProject } from "../src/project.ts"
import { upsert } from "../src/lock.ts"
import { lockKey } from "../src/types.ts"

let dir: string
let cwd: string
const ENV_KEY = "PIXELKILN_TEST_PROJECT_KEY"

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "pixelkiln-project-"))
  cwd = process.cwd()
  delete process.env[ENV_KEY]
})

afterEach(async () => {
  process.chdir(cwd)
  delete process.env[ENV_KEY]
  await rm(dir, { recursive: true, force: true })
})

async function manifest(extra: Record<string, unknown> = {}) {
  const file = path.join(dir, "pixelkiln.manifest.json")
  await writeFile(file, JSON.stringify({
    name: "front-door",
    styles: {
      base: { generator: "map", outDir: "out", promptSuffix: "clean" },
      neon: { generator: "map", outDir: "neon", promptSuffix: "glow" },
    },
    assets: {
      anvil: { prompt: "an anvil", width: 32, height: 32 },
      hammer: { prompt: "a hammer", width: 32, height: 32, styles: ["base"] },
    },
    ...extra,
  }))
  return file
}

describe("openProject", () => {
  it("loads manifest, specs, and lock in one call with the lock beside the manifest", async () => {
    const file = await manifest()
    const project = await openProject(file)
    expect(project.manifestPath).toBe(file)
    expect(project.root).toBe(dir)
    expect(project.lockPath).toBe(path.join(dir, "pixelkiln.lock.json"))
    expect(project.specs.map((s) => `${s.styleId}/${s.assetId}`).sort()).toEqual(["base/anvil", "base/hammer", "neon/anvil"])
    expect(project.lock).toEqual({ version: 2, entries: {} })
    expect(project.providers()).toEqual(["pixellab"])
  })

  it("applies style and asset filters", async () => {
    const project = await openProject(await manifest(), { styles: ["neon"] })
    expect(project.specs.map((s) => s.assetId)).toEqual(["anvil"])
    const narrowed = await openProject(await manifest(), { assets: ["hammer"] })
    expect(narrowed.specs.map((s) => `${s.styleId}/${s.assetId}`)).toEqual(["base/hammer"])
  })

  it("plans offline and saves the lock it hands out", async () => {
    const project = await openProject(await manifest())
    const plan = await project.plan()
    expect(plan.items.every((item) => item.state === "missing")).toBe(true)
    upsert(project.lock, lockKey("base", "anvil"), {
      styleId: "base",
      assetId: "anvil",
      specHash: project.specs.find((s) => s.styleId === "base" && s.assetId === "anvil")!.specHash,
      generator: "map",
      prompt: "an anvil clean",
      width: 32,
      height: 32,
      status: "processing",
      jobId: "job-1",
      outputs: [],
      cost: 1,
      costUnit: "generations",
      provider: "pixellab",
      submittedAt: "2026-01-01T00:00:00.000Z",
    })
    await project.saveLock()
    const written = JSON.parse(await readFile(project.lockPath, "utf8"))
    expect(written.entries["base/anvil"].jobId).toBe("job-1")
    const again = await project.reload()
    expect(again.lock.entries["base/anvil"]?.status).toBe("processing")
    expect((await again.plan()).items.find((i) => i.key === "base/anvil")?.state).toBe("in-flight")
  })

  it("canonicalises lock output paths recorded on another machine", async () => {
    const file = await manifest()
    await writeFile(path.join(dir, "pixelkiln.lock.json"), JSON.stringify({
      version: 2,
      entries: {
        "base/anvil": {
          styleId: "base", assetId: "anvil", specHash: "a".repeat(64), generator: "map",
          prompt: "an anvil clean", width: 32, height: 32, status: "downloaded",
          outputs: [{ path: "/Users/someone-else/game/out/anvil.png", sha256: "b".repeat(64) }],
          cost: 1, costUnit: "generations", provider: "pixellab",
          submittedAt: "2026-01-01T00:00:00.000Z", downloadedAt: "2026-01-01T00:01:00.000Z",
        },
      },
    }))
    const project = await openProject(file)
    expect(project.lock.entries["base/anvil"]!.outputs[0]!.path).toBe("out/anvil.png")
  })

  it("reads env files beside the manifest unless told not to", async () => {
    const file = await manifest()
    await writeFile(path.join(dir, ".env"), `${ENV_KEY}=from-project\n`)
    await openProject(file, { env: false })
    expect(process.env[ENV_KEY]).toBeUndefined()
    await openProject(file)
    expect(process.env[ENV_KEY]).toBe("from-project")
    // Never overrides what the process already holds.
    await writeFile(path.join(dir, ".env"), `${ENV_KEY}=changed\n`)
    await openProject(file)
    expect(process.env[ENV_KEY]).toBe("from-project")
  })

  it("honours an explicit lock path and a relative manifest path", async () => {
    await manifest()
    await mkdir(path.join(dir, "locks"))
    process.chdir(dir)
    const project = await openProject("pixelkiln.manifest.json", { lockPath: "locks/game.lock.json" })
    // macOS puts the temp dir behind a symlink, so compare the file's tail.
    expect(path.isAbsolute(project.lockPath)).toBe(true)
    expect(project.lockPath.endsWith(path.join("locks", "game.lock.json"))).toBe(true)
    await project.saveLock()
    expect(existsSync(path.join(dir, "locks", "game.lock.json"))).toBe(true)
  })

  it("hands out one adapter per provider and mode", async () => {
    const project = await openProject(await manifest())
    const a = project.provider("pixellab", "downloads")
    expect(project.provider("pixellab", "downloads")).toBe(a)
    expect(a.id).toBe("pixellab")
    expect(() => project.provider("nope")).toThrow(/nope/)
  })

  it("reports a missing manifest plainly", async () => {
    await expect(openProject(path.join(dir, "missing.json"))).rejects.toThrow(/No manifest at/)
  })
})
