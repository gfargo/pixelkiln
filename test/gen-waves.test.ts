import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"
import { existsSync } from "node:fs"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { FakeProvider } from "../src/providers/fake.ts"
import { registerProvider } from "../src/providers/registry.ts"
import { parseArgs } from "../src/cli/args.ts"
import { runGenerate } from "../src/cli/commands/generate.ts"
import { openProject } from "../src/project.ts"
import type { Provider } from "../src/provider.ts"

const PROVIDER = "waves-fake"
let fake: FakeProvider
let dir: string
let quiet: ReturnType<typeof vi.spyOn>

beforeAll(() => {
  registerProvider({ id: PROVIDER, create: () => fake as Provider })
})
const namedFake = (opts: ConstructorParameters<typeof FakeProvider>[0] = {}) => {
  const provider = new FakeProvider({ candidates: 1, ...opts })
  Object.defineProperty(provider, "id", { value: PROVIDER })
  return provider
}

beforeEach(async () => {
  fake = namedFake()
  dir = await mkdtemp(path.join(tmpdir(), "pixelkiln-waves-"))
  quiet = vi.spyOn(console, "log").mockImplementation(() => {})
})
afterEach(async () => {
  quiet.mockRestore()
  process.exitCode = undefined
  await rm(dir, { recursive: true, force: true })
})

const lines = () => quiet.mock.calls.map((c) => String(c[0] ?? "")).join("\n")

/** A still, a revision of it, and a revision of that: three waves deep. */
async function chainedProject(extra: Record<string, unknown> = {}) {
  const manifestPath = path.join(dir, "pixelkiln.manifest.json")
  await writeFile(manifestPath, JSON.stringify({
    name: "waves",
    provider: PROVIDER,
    styles: { base: { generator: "map", outDir: "out" } },
    assets: {
      hero: { prompt: "a hero", width: 32, height: 32 },
      "hero.armored": { prompt: "in armor", width: 32, height: 32, revision: { mode: "image-to-image", from: "hero" } },
      "hero.armored.gold": { prompt: "gilded", width: 32, height: 32, revision: { mode: "image-to-image", from: "hero.armored" } },
    },
    ...extra,
  }))
  return manifestPath
}

const gen = (manifestPath: string, ...flags: string[]) =>
  runGenerate(parseArgs(["gen", "--manifest", manifestPath, "--yes", "--no-open", ...flags]))

describe("gen waves", () => {
  it("takes a dependency chain to the end in one invocation under one budget", async () => {
    const manifestPath = await chainedProject()
    await gen(manifestPath, "--budget", "10")
    const project = await openProject(manifestPath, { env: false })
    const plan = await project.plan()
    expect(plan.items.map((i) => `${i.key}=${i.state}`)).toEqual([
      "base/hero=ok", "base/hero.armored=ok", "base/hero.armored.gold=ok",
    ])
    for (const id of ["hero", "hero.armored", "hero.armored.gold"]) {
      expect(existsSync(path.join(dir, "out", `${id}.png`))).toBe(true)
    }
    expect(fake.submissions.map((s) => s.assetId)).toEqual(["hero", "hero.armored", "hero.armored.gold"])
    const out = lines()
    expect(out).toContain("wave 2: 1 asset(s) became actionable")
    expect(out).toContain("wave 3: 1 asset(s) became actionable")
    expect(out).toContain("wave 4: nothing else became actionable")
    expect(process.exitCode).toBeUndefined()
  })

  it("stops before a wave the remaining budget cannot cover, keeping earlier waves' work", async () => {
    const manifestPath = await chainedProject()
    await gen(manifestPath, "--budget", "2")
    const project = await openProject(manifestPath, { env: false })
    const plan = await project.plan()
    expect(plan.items.map((i) => `${i.key}=${i.state}`)).toEqual([
      "base/hero=ok", "base/hero.armored=ok", "base/hero.armored.gold=missing",
    ])
    expect(fake.submissions.map((s) => s.assetId)).toEqual(["hero", "hero.armored"])
    const out = lines()
    expect(out).toContain("stopping before wave 3")
    expect(out).toContain("run pixelkiln gen again with a budget for the remaining work")
    expect(process.exitCode).toBeUndefined()

    // The next invocation with a fresh budget finishes the chain.
    await gen(manifestPath, "--budget", "1")
    expect((await (await openProject(manifestPath, { env: false })).plan()).items.every((i) => i.state === "ok")).toBe(true)
  })

  it("runs one wave when nothing depends on anything", async () => {
    const manifestPath = path.join(dir, "pixelkiln.manifest.json")
    await writeFile(manifestPath, JSON.stringify({
      name: "flat",
      provider: PROVIDER,
      styles: { base: { generator: "map", outDir: "out" } },
      assets: { a: { prompt: "a", width: 32, height: 32 }, b: { prompt: "b", width: 32, height: 32 } },
    }))
    await gen(manifestPath, "--budget", "10")
    expect(fake.submissions).toHaveLength(2)
    expect(lines()).not.toContain("wave 2")
  })

  it("forces only the first wave, so a child regenerates once for its new parent", async () => {
    const manifestPath = await chainedProject()
    await gen(manifestPath, "--budget", "10")
    fake.submissions.length = 0
    await gen(manifestPath, "--budget", "10", "--force")
    // Wave 1 forces the root only; each child waits for its parent's new
    // bytes and then goes exactly once, in its own wave.
    expect(fake.submissions.map((s) => s.assetId)).toEqual(["hero", "hero.armored", "hero.armored.gold"])
    expect(lines()).toContain("wave 3: 1 asset(s) became actionable")
    expect((await (await openProject(manifestPath, { env: false })).plan()).items.every((i) => i.state === "ok")).toBe(true)
  })

  it("does not loop when a wave fails", async () => {
    const manifestPath = await chainedProject()
    fake = namedFake({ failAssets: new Set(["hero"]) })
    await gen(manifestPath, "--budget", "10")
    expect(fake.submissions.map((s) => s.assetId)).toEqual(["hero"])
    expect(lines()).not.toContain("wave 2")
    expect(process.exitCode).toBe(1)
  })
})
