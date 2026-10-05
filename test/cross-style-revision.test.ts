import path from "node:path"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { loadManifest, resolveSpecs, type LoadedManifest } from "../src/manifest.ts"
import { FakeProvider } from "../src/providers/fake.ts"
import { buildPlan } from "../src/pipeline/plan.ts"
import { fetchAssets } from "../src/pipeline/fetch.ts"
import { poll } from "../src/pipeline/poll.ts"
import { submit } from "../src/pipeline/submit.ts"
import type { Lock } from "../src/types.ts"

describe("revisions across styles", () => {
  let dir: string
  let manifestPath: string
  let provider: FakeProvider

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "pixelkiln-cross-style-"))
    manifestPath = path.join(dir, "pixelkiln.manifest.json")
    provider = new FakeProvider({ candidates: 1 })
  })
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  async function project(revision: Record<string, unknown> = {}, extra: Record<string, unknown> = {}): Promise<LoadedManifest> {
    await writeFile(manifestPath, JSON.stringify({
      name: "cross-style",
      provider: "fake",
      styles: {
        gen: { generator: "map", size: 16, outDir: "art/gen" },
        final: { generator: "map", size: 16, outDir: "art/final" },
        ...extra,
      },
      assets: {
        knight: { prompt: "a knight", styles: ["gen"] },
        "knight-final": {
          prompt: "clean it up",
          styles: ["final"],
          revision: { mode: "image-to-image", from: "knight", fromStyle: "gen", ...revision },
        },
      },
    }))
    return loadManifest(manifestPath)
  }

  it("resolves the parent in its own style and records where it lives", async () => {
    const loaded = await project()
    const specs = await resolveSpecs(loaded, { provider })
    const child = specs.find((spec) => spec.styleId === "final")!
    const parent = specs.find((spec) => spec.styleId === "gen")!
    expect(child.revision).toMatchObject({ sourceAssetId: "knight", sourceStyleId: "gen" })
    expect(child.revision!.sourceSpec.styleId).toBe("gen")
    expect(child.revision!.sourceFile).toBe(parent.outFile)
  })

  it("resolves the parent's style when the run is filtered away from it, without returning it", async () => {
    const loaded = await project()
    const specs = await resolveSpecs(loaded, { styles: ["final"], provider })
    expect(specs.map((spec) => `${spec.styleId}/${spec.assetId}`)).toEqual(["final/knight-final"])
    expect(specs[0]!.revision!.sourceSpec.styleId).toBe("gen")
  })

  it("blocks the child until the parent in the other style is generated, then releases it", async () => {
    const loaded = await project()
    const lock: Lock = { version: 2, entries: {} }
    const lockPath = path.join(dir, "pixelkiln.lock.json")
    const child = (await resolveSpecs(loaded, { styles: ["final"], provider }))[0]!
    const blocked = await buildPlan([child], lock)
    expect(blocked.items[0]).toMatchObject({ state: "blocked" })
    expect(blocked.items[0]!.reason).toMatch(/revision source gen\/knight is not ready/)

    const parent = (await resolveSpecs(loaded, { styles: ["gen"], provider }))[0]!
    await submit(provider, loaded, (await buildPlan([parent], lock)).actionable, lock, lockPath, { spacingMs: 0 })
    await poll(provider, lock, lockPath, { intervalMs: 0, specs: [parent] })
    await fetchAssets(provider, [parent], lock, lockPath)

    const released = await resolveSpecs(await loadManifest(manifestPath), { styles: ["final"], provider })
    const plan = await buildPlan(released, lock)
    expect(plan.items[0]).toMatchObject({ state: "missing" })
    expect(plan.actionable).toHaveLength(1)
  })

  it("changes the child's identity with the parent's style", async () => {
    const cross = (await resolveSpecs(await project(), { styles: ["final"], provider }))[0]!
    await writeFile(manifestPath, JSON.stringify({
      name: "cross-style",
      provider: "fake",
      styles: { gen: { generator: "map", size: 16, outDir: "art/gen" }, other: { generator: "map", size: 16, outDir: "art/other" }, final: { generator: "map", size: 16, outDir: "art/final" } },
      assets: {
        knight: { prompt: "a knight", styles: ["gen", "other"] },
        "knight-final": { prompt: "clean it up", styles: ["final"], revision: { mode: "image-to-image", from: "knight", fromStyle: "other" } },
      },
    }))
    const other = (await resolveSpecs(await loadManifest(manifestPath), { styles: ["final"], provider }))[0]!
    expect(other.specHash).not.toBe(cross.specHash)
  })

  it("rejects an unknown style, a parent that is not in it, and styles that revise each other", async () => {
    await expect(project({ fromStyle: "nowhere" })).rejects.toThrow(/fromStyle: unknown style "nowhere"/)
    await expect(project({ fromStyle: "final" })).rejects.toThrow(/"knight" is not in style "final"/)

    await writeFile(manifestPath, JSON.stringify({
      name: "loop",
      provider: "fake",
      styles: { a: { generator: "map", size: 16, outDir: "a" }, b: { generator: "map", size: 16, outDir: "b" } },
      assets: {
        one: { prompt: "one", styles: ["a"], revision: { mode: "image-to-image", from: "two", fromStyle: "b" } },
        two: { prompt: "two", styles: ["b"], revision: { mode: "image-to-image", from: "three", fromStyle: "a" } },
        three: { prompt: "three", styles: ["a"] },
      },
    }))
    await expect(resolveSpecs(await loadManifest(manifestPath), { provider }))
      .rejects.toThrow(/Styles revise each other in a cycle: a -> b -> a/)
  })

  it("treats fromStyle naming the asset's own style as the ordinary same-style revision", async () => {
    await writeFile(manifestPath, JSON.stringify({
      name: "same",
      provider: "fake",
      styles: { gen: { generator: "map", size: 16, outDir: "art/gen" } },
      assets: {
        knight: { prompt: "a knight" },
        "knight-b": { prompt: "b", revision: { mode: "image-to-image", from: "knight", fromStyle: "gen" } },
      },
    }))
    const specs = await resolveSpecs(await loadManifest(manifestPath), { provider })
    const child = specs.find((spec) => spec.assetId === "knight-b")!
    expect(child.revision!.sourceStyleId).toBeUndefined()
  })
})
