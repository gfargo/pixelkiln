import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { loadManifest, resolveSpecs } from "../src/manifest.ts"
import { buildPlan } from "../src/pipeline/plan.ts"
import { submit } from "../src/pipeline/submit.ts"
import { PixelLabClient } from "../src/client.ts"
import { PixelLabProvider } from "../src/providers/pixellab.ts"
import type { Lock } from "../src/types.ts"

let dir: string
beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "pixelkiln-tiles-options-"))
})
afterEach(async () => {
  vi.unstubAllGlobals()
  await rm(dir, { recursive: true, force: true })
})

async function load(style: Record<string, unknown>) {
  await writeFile(path.join(dir, "m.json"), JSON.stringify({
    name: "t",
    styles: { base: { generator: "tiles", tileSize: 32, tileType: "square_topdown", outDir: "out", ...style } },
    assets: { shore: { prompt: "1). grass meadow 2). shallow water" } },
  }))
  return loadManifest(path.join(dir, "m.json"))
}
const hashOf = async (style: Record<string, unknown>) => (await resolveSpecs(await load(style)))[0]!.specHash
const tileset = { tileFeature: "tileset" }

describe("tiles shape options added in November 2026", () => {
  it("changes a set's hash only for an option that is set", async () => {
    const plain = await hashOf(tileset)
    for (const style of [
      { tileElevation: 4 },
      { tileElevation: 4, tileStepSlope: 1 },
      { tileBoundaryAmplitude: 0.2 },
      { tileBoundaryAmplitude: 0.2, tileBoundarySeed: 3 },
    ]) {
      expect(await hashOf({ ...tileset, ...style }), JSON.stringify(style)).not.toBe(plain)
    }
    const kit = { tileFeature: "building", buildingLayout: "materials" }
    expect(await hashOf({ ...kit, buildingRoofProfile: "round" })).not.toBe(await hashOf(kit))
  })

  it.each([
    [{ tileElevation: 4 }, /tileElevation shape a connectable terrain set; set tileFeature: "tileset"/],
    [{ tileFeature: "roads", tileBoundaryAmplitude: 0.2 }, /tileBoundaryAmplitude shape a connectable terrain set/],
    [{ ...tileset, tileType: "hex", tileElevation: 2 }, /raises a plateau on square_topdown, isometric or oblique tiles, not "hex"/],
    [{ ...tileset, tileStepSlope: 1 }, /set tileElevation above 0/],
    [{ ...tileset, tileElevation: 0, tileStepSlope: 1 }, /set tileElevation above 0/],
    [{ ...tileset, tileBoundarySeed: 3 }, /set both or neither/],
    [{ ...tileset, buildingRoofProfile: "round" }, /set tileFeature: "building" with buildingLayout: "materials"/],
    [{ tileFeature: "building", buildingLayout: "grid", buildingRoofProfile: "gable" }, /buildingLayout: "materials"/],
    [{ ...tileset, tileElevation: 13 }, /is invalid/],
    [{ ...tileset, tileBoundaryAmplitude: 0.4 }, /is invalid/],
  ])("refuses an option where it does nothing: %o", async (style, error) => {
    await expect((async () => resolveSpecs(await load(style)))()).rejects.toThrow(error)
  })

  it("sends them as the API's field names, and nothing when unset", async () => {
    const bodies: Record<string, unknown>[] = []
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init?: RequestInit) => {
      if (init?.body) bodies.push(JSON.parse(String(init.body)))
      return new Response(JSON.stringify({ tile_id: "t-1", background_job_id: "bg", status: "processing" }), { status: 200 })
    }))
    for (const style of [
      { ...tileset, tileElevation: 4, tileStepSlope: 1, tileBoundaryAmplitude: 0.2, tileBoundarySeed: 3 },
      { tileFeature: "building", buildingLayout: "materials", buildingRoofProfile: "round" },
      tileset,
    ]) {
      const loaded = await load(style)
      const specs = await resolveSpecs(loaded)
      const lock: Lock = { version: 2, entries: {} }
      await submit(new PixelLabProvider(new PixelLabClient("key")), loaded, (await buildPlan(specs, lock)).actionable, lock, path.join(dir, "lock.json"), { spacingMs: 0 })
    }
    expect(bodies[0]).toMatchObject({ tile_feature: "tileset", elevation: 4, step_slope: 1, boundary_amplitude: 0.2, boundary_seed: 3 })
    expect(bodies[1]).toMatchObject({ tile_feature: "building", roof_profile: "round" })
    for (const field of ["elevation", "step_slope", "boundary_amplitude", "boundary_seed", "roof_profile"]) {
      expect(bodies[2], field).not.toHaveProperty(field)
    }
  })
})
