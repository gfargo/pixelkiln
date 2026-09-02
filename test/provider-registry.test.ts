import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { loadManifest, resolveSpecs } from "../src/manifest.ts"
import { FakeProvider } from "../src/providers/fake.ts"
import {
  availableProviders,
  createProvider,
  providerFactory,
  registerProvider,
} from "../src/providers/registry.ts"

let dir: string

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "pixelkiln-provider-"))
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

describe("provider registry", () => {
  it("ships PixelLab as the backwards-compatible default", () => {
    expect(availableProviders()).toContain("pixellab")
    expect(providerFactory("pixellab").credentialEnv).toBe("PIXELLAB_API_KEY")
    expect(createProvider("pixellab", "offline").id).toBe("pixellab")
  })

  it("uses a manifest provider for validation, estimates, and spec identity", async () => {
    const id = `custom-${Date.now()}-${Math.random().toString(36).slice(2)}`
    registerProvider({
      id,
      credentialEnv: "CUSTOM_API_KEY",
      create() {
        const provider = new FakeProvider({ candidates: 3, costUnit: "creative-units" })
        Object.defineProperty(provider, "id", { value: id })
        provider.estimate = () => ({ unit: "creative-units", amount: 2.5, candidates: 3 })
        return provider
      },
    })

    const manifestPath = path.join(dir, "pixelkiln.manifest.json")
    await writeFile(manifestPath, JSON.stringify({
      name: "custom-provider",
      provider: id,
      styles: { base: { generator: "map", outDir: "out" } },
      assets: { anvil: { prompt: "an anvil" } },
    }))

    const specs = await resolveSpecs(await loadManifest(manifestPath))
    expect(specs[0]).toMatchObject({
      provider: id,
      cost: 2.5,
      costUnit: "creative-units",
      candidates: 3,
    })
  })

  it("fails clearly when a manifest names an unavailable provider", async () => {
    const manifestPath = path.join(dir, "pixelkiln.manifest.json")
    await writeFile(manifestPath, JSON.stringify({
      name: "missing-provider",
      provider: "not-installed",
      styles: { base: { generator: "map", outDir: "out" } },
      assets: { anvil: { prompt: "an anvil" } },
    }))

    await expect(resolveSpecs(await loadManifest(manifestPath))).rejects.toThrow(
      /Unknown provider "not-installed".*pixellab/,
    )
  })

  it("rejects unsupported PixelLab map options before submission", async () => {
    const manifestPath = path.join(dir, "pixelkiln.manifest.json")
    await writeFile(manifestPath, JSON.stringify({
      name: "invalid-map-view",
      styles: {
        base: { generator: "map", view: "isometric", outDir: "out" },
      },
      assets: { observatory: { prompt: "a mountain observatory" } },
    }))

    await expect(resolveSpecs(await loadManifest(manifestPath))).rejects.toThrow(
      /PixelLab map view must be one of: low top-down, high top-down, side/,
    )
  })

  it("does not let registration order silently replace an adapter", () => {
    const id = `duplicate-${Date.now()}-${Math.random().toString(36).slice(2)}`
    const factory = { id, create: () => new FakeProvider() }
    registerProvider(factory)
    expect(() => registerProvider(factory)).toThrow(/already registered/)
  })
})
