import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { doctor } from "../src/pipeline/doctor.ts"
import { loadManifest, resolveSpecs } from "../src/manifest.ts"
import { lockKey, type Lock, type LockEntry } from "../src/types.ts"
import { FakeProvider } from "../src/providers/fake.ts"
import type { Provider } from "../src/provider.ts"

let dir: string

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "pixelkiln-doctor-"))
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

async function project() {
  const manifestPath = path.join(dir, "pixelkiln.manifest.json")
  await writeFile(
    manifestPath,
    JSON.stringify({
      name: "doctor-test",
      styles: { base: { generator: "map", outDir: "out" } },
      assets: { anvil: { prompt: "an anvil" } },
    }),
  )
  const loaded = await loadManifest(manifestPath)
  return { loaded, specs: await resolveSpecs(loaded), lockPath: path.join(dir, "pixelkiln.lock.json") }
}

function entry(overrides: Partial<LockEntry> = {}): LockEntry {
  return {
    styleId: "base", assetId: "anvil", specHash: "h", generator: "map",
    tileFeature: null, prompt: "an anvil", width: 32, height: 32,
    jobId: "job", reviewObjectId: null, objectId: "object", candidateIndex: null,
    status: "download-failed", error: "download failed", sourceUrl: null, sourceUrls: [],
    outputs: [], submittedAt: new Date().toISOString(), downloadedAt: null,
    cost: 1, provider: "fake", ...overrides,
  }
}

describe("doctor", () => {
  it("runs every local check without provider access in dry-run mode", async () => {
    const { loaded, specs, lockPath } = await project()
    const report = await doctor(loaded, specs, { version: 2, entries: {} }, lockPath, {
      offline: true,
    })

    expect(report.ok).toBe(true)
    expect(report.checks.find((c) => c.id === "provider")?.level).toBe("warning")
    expect(report.checks.find((c) => c.id === "outputs")?.level).toBe("ok")
  })

  it("fails when unfinished paid work has no recovery source", async () => {
    const { loaded, specs, lockPath } = await project()
    const key = lockKey("base", "anvil")
    const lock: Lock = { version: 2, entries: { [key]: entry({ specHash: specs[0]!.specHash }) } }
    const report = await doctor(loaded, specs, lock, lockPath, { offline: true })

    expect(report.ok).toBe(false)
    expect(report.checks.find((c) => c.id === "recovery")).toMatchObject({ level: "error" })
  })

  it("reports missing provider credentials as an actionable error", async () => {
    const { loaded, specs, lockPath } = await project()
    const report = await doctor(loaded, specs, { version: 2, entries: {} }, lockPath, {
      apiKeyPresent: false,
    })

    expect(report.ok).toBe(false)
    expect(report.checks.find((c) => c.id === "provider")?.message).toMatch(/API_KEY/)
  })

  it("names every missing credential for a compound-auth provider", async () => {
    const { loaded, specs, lockPath } = await project()
    const report = await doctor(loaded, specs, { version: 2, entries: {} }, lockPath, {
      providers: [{
        id: "scenario",
        apiKeyPresent: false,
        missingCredentialEnvs: ["SCENARIO_SDK_API_KEY", "SCENARIO_SDK_API_SECRET"],
      }],
    })

    expect(report.ok).toBe(false)
    expect(report.checks.find((c) => c.id === "provider")?.message).toBe(
      "SCENARIO_SDK_API_KEY, SCENARIO_SDK_API_SECRET are not configured",
    )
  })

  it("uses a read-only connectivity probe when balance reporting is unavailable", async () => {
    const { loaded, specs, lockPath } = await project()
    const provider = new FakeProvider()
    const checkConnection = vi.fn(async () => {})
    Object.assign(provider, { balance: undefined, checkConnection })
    const report = await doctor(loaded, specs, { version: 2, entries: {} }, lockPath, {
      provider: provider as Provider,
    })

    expect(checkConnection).toHaveBeenCalledOnce()
    expect(report.checks.find((c) => c.id === "provider")).toMatchObject({
      level: "ok",
      message: "fake reachable; balance reporting unavailable",
    })
  })

  it("fails doctor when a provider connectivity probe fails", async () => {
    const { loaded, specs, lockPath } = await project()
    const provider = new FakeProvider()
    const checkConnection = vi.fn(async () => {
      throw new Error("server refused the connection")
    })
    Object.assign(provider, { balance: undefined, checkConnection })
    const report = await doctor(loaded, specs, { version: 2, entries: {} }, lockPath, {
      provider: provider as Provider,
    })

    expect(report.ok).toBe(false)
    expect(report.checks.find((c) => c.id === "provider")).toMatchObject({
      level: "error",
      message: "provider connectivity failed: server refused the connection",
    })
  })
})
