import { afterEach, beforeAll, describe, expect, it } from "vitest"
import { execFile } from "node:child_process"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { promisify } from "node:util"
import { loadManifest, resolveSpecs } from "../src/manifest.ts"
import { buildPlan } from "../src/pipeline/plan.ts"
import { submit } from "../src/pipeline/submit.ts"
import { poll } from "../src/pipeline/poll.ts"
import { fetchAssets } from "../src/pipeline/fetch.ts"
import { writePromptsBack } from "../src/pipeline/adopt.ts"
import { loadLock } from "../src/lock.ts"
import type { CostUnit, Provider } from "../src/provider.ts"
import { FakeProvider } from "../src/providers/fake.ts"
import { createProvider, registerProvider } from "../src/providers/registry.ts"

const execFileAsync = promisify(execFile)
const PROVIDER_A = "mixed-test-a"
const PROVIDER_B = "mixed-test-b"
let dir: string

function namedFake(id: string, costUnit: CostUnit): Provider {
  const provider = new FakeProvider({ candidates: 1, cost: 1, costUnit })
  Object.defineProperty(provider, "id", { value: id })
  return provider
}

beforeAll(() => {
  registerProvider({
    id: PROVIDER_A,
    create: () => namedFake(PROVIDER_A, "generations"),
  })
  registerProvider({
    id: PROVIDER_B,
    create: () => namedFake(PROVIDER_B, "usd"),
  })
})

afterEach(async () => {
  if (dir) await rm(dir, { recursive: true, force: true })
})

async function mixedProject(providerA = PROVIDER_A, providerB = PROVIDER_B) {
  dir = await mkdtemp(path.join(tmpdir(), "pixelkiln-mixed-"))
  const manifestPath = path.join(dir, "pixelkiln.manifest.json")
  const lockPath = path.join(dir, "pixelkiln.lock.json")
  await writeFile(manifestPath, JSON.stringify({
    name: "mixed-test",
    provider: providerA,
    styles: {
      world: { generator: "map", outDir: "out/world" },
      portraits: { provider: providerB, generator: "map", outDir: "out/portraits" },
    },
    assets: {
      mountain: { prompt: "a mountain", styles: ["world"] },
      hero: { prompt: "a hero", styles: ["portraits"] },
    },
  }))
  const loaded = await loadManifest(manifestPath)
  return { loaded, lockPath, specs: await resolveSpecs(loaded) }
}

describe("mixed provider projects", () => {
  it("routes each style through its provider for submit, poll, and fetch", async () => {
    const { loaded, lockPath, specs } = await mixedProject()
    const lock = await loadLock(lockPath)
    const plan = await buildPlan(specs, lock)
    const providers = new Map([
      [PROVIDER_A, createProvider(PROVIDER_A, "online")],
      [PROVIDER_B, createProvider(PROVIDER_B, "online")],
    ])

    for (const group of plan.groups) {
      await submit(providers.get(group.provider)!, loaded, group.actionable, lock, lockPath, {
        budget: group.cost,
        spacingMs: 0,
      })
    }
    expect(Object.values(lock.entries).map((entry) => entry.provider).sort())
      .toEqual([PROVIDER_A, PROVIDER_B])

    const aSpecs = specs.filter((spec) => spec.provider === PROVIDER_A)
    await poll(providers.get(PROVIDER_A)!, lock, lockPath, { intervalMs: 0, specs: aSpecs })
    expect(lock.entries["world/mountain"]?.status).toBe("selected")
    expect(lock.entries["portraits/hero"]?.status).toBe("processing")

    for (const [providerId, provider] of providers) {
      const selected = specs.filter((spec) => spec.provider === providerId)
      await poll(provider, lock, lockPath, { intervalMs: 0, specs: selected })
      await fetchAssets(provider, selected, lock, lockPath)
    }
    expect(lock.entries["world/mountain"]?.status).toBe("downloaded")
    expect(lock.entries["portraits/hero"]?.status).toBe("downloaded")
  })

  it("prints provider-scoped plan JSON and rejects an ambiguous budget", async () => {
    const { loaded, lockPath } = await mixedProject("pixellab", "retrodiffusion")
    const cli = path.resolve("node_modules/.bin/tsx")
    const entry = path.resolve("src/cli.ts")
    const { stdout } = await execFileAsync(cli, [
      entry,
      "plan",
      "--manifest", loaded.path,
      "--lock", lockPath,
      "--json",
    ])
    const report = JSON.parse(stdout)
    expect(report.cost).toBeNull()
    expect(report.costUnit).toBeNull()
    expect(report.groups.map((group: { provider: string }) => group.provider))
      .toEqual(["pixellab", "retrodiffusion"])

    await expect(execFileAsync(cli, [
      entry,
      "submit",
      "--manifest", loaded.path,
      "--lock", lockPath,
      "--budget", "40",
      "--yes",
    ])).rejects.toMatchObject({
      stderr: expect.stringMatching(/mixed-provider run needs provider-keyed budgets/i),
    })

    await expect(execFileAsync(cli, [
      entry,
      "submit",
      "--manifest", loaded.path,
      "--lock", lockPath,
      "--budget", "pixellab=40",
      "--yes",
    ])).rejects.toMatchObject({
      stderr: expect.stringMatching(/missing --budget retrodiffusion=/i),
    })

    await expect(execFileAsync(cli, [
      entry,
      "submit",
      "--manifest", loaded.path,
      "--lock", lockPath,
      "--budget", "pixellab=40",
      "--budget", "retrodiffusion=1",
      "--budget", "typo=1",
      "--yes",
    ])).rejects.toMatchObject({
      stderr: expect.stringMatching(/budget names provider "typo"/i),
    })
  })

  it("requires an explicit provider for account-scoped commands", async () => {
    const { loaded } = await mixedProject("pixellab", "retrodiffusion")
    const cli = path.resolve("node_modules/.bin/tsx")
    for (const command of ["balance", "adopt", "salvage", "purge"]) {
      await expect(execFileAsync(cli, [
        path.resolve("src/cli.ts"),
        command,
        "--manifest", loaded.path,
      ])).rejects.toMatchObject({
        stderr: expect.stringMatching(/account-scoped.*--provider/),
      })
    }
  })

  it("reports every selected provider during an offline doctor run", async () => {
    const { loaded, lockPath } = await mixedProject("pixellab", "retrodiffusion")
    const { stdout } = await execFileAsync(path.resolve("node_modules/.bin/tsx"), [
      path.resolve("src/cli.ts"),
      "doctor",
      "--manifest", loaded.path,
      "--lock", lockPath,
      "--dry-run",
      "--json",
    ])
    const report = JSON.parse(stdout)
    expect(report.checks).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "provider:pixellab", level: "warning" }),
      expect.objectContaining({ id: "provider:retrodiffusion", level: "warning" }),
    ]))
  })

  it("does not accept stale work produced by another provider", async () => {
    const { loaded, lockPath, specs } = await mixedProject("pixellab", "retrodiffusion")
    const lock = await loadLock(lockPath)
    const portrait = (await buildPlan(specs, lock)).actionable.find(
      (item) => item.spec.styleId === "portraits",
    )!
    const oldProvider = namedFake("pixellab", "generations")
    await submit(oldProvider, loaded, [portrait], lock, lockPath, { spacingMs: 0 })
    await poll(oldProvider, lock, lockPath, { intervalMs: 0, specs: [portrait.spec] })
    await fetchAssets(oldProvider, [portrait.spec], lock, lockPath)
    const oldHash = lock.entries[portrait.key]!.specHash

    const manifest = JSON.parse(await readFile(loaded.path, "utf8"))
    manifest.assets.hero.prompt = "a changed hero"
    await writeFile(loaded.path, JSON.stringify(manifest))

    const { stdout } = await execFileAsync(path.resolve("node_modules/.bin/tsx"), [
      path.resolve("src/cli.ts"),
      "accept",
      "--manifest", loaded.path,
      "--lock", lockPath,
    ])
    expect(stdout).toMatch(/accepted 0 existing file/)
    expect((await loadLock(lockPath)).entries[portrait.key]!.specHash).toBe(oldHash)
  })

  it("recovers prompts only from the selected provider", async () => {
    const { loaded, lockPath, specs } = await mixedProject()
    const lock = await loadLock(lockPath)
    const plan = await buildPlan(specs, lock)
    for (const group of plan.groups) {
      const provider = createProvider(group.provider, "online")
      await submit(provider, loaded, group.actionable, lock, lockPath, { spacingMs: 0 })
      await poll(provider, lock, lockPath, {
        intervalMs: 0,
        specs: group.actionable.map((item) => item.spec),
      })
      await fetchAssets(provider, group.actionable.map((item) => item.spec), lock, lockPath)
    }

    const manifest = JSON.parse(await readFile(loaded.path, "utf8"))
    manifest.assets.mountain.prompt = ""
    manifest.assets.hero.prompt = ""
    await writeFile(loaded.path, JSON.stringify(manifest))

    const result = await writePromptsBack(loaded.path, lock, {
      provider: PROVIDER_A,
      assetIds: ["mountain"],
    })
    expect(result).toEqual({ filled: 1, stillEmpty: [] })
    const updated = JSON.parse(await readFile(loaded.path, "utf8"))
    expect(updated.assets.mountain.prompt).toBe("a mountain")
    expect(updated.assets.hero.prompt).toBe("")
  })

  it("writes no provider credentials into mixed lock state", async () => {
    const { loaded, lockPath, specs } = await mixedProject()
    const lock = await loadLock(lockPath)
    const plan = await buildPlan(specs, lock)
    for (const group of plan.groups) {
      const provider = createProvider(group.provider, "online")
      await submit(provider, loaded, group.actionable, lock, lockPath, {
        budget: group.cost,
        spacingMs: 0,
      })
    }
    const serialized = await readFile(lockPath, "utf8")
    expect(serialized).not.toMatch(/token|credential|authorization/i)
  })
})
