import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { parseArgs } from "../src/cli/args.ts"
import { runExport } from "../src/cli/commands/pack.ts"
import { loadManifest, resolveSpecs } from "../src/manifest.ts"
import { memberPath } from "../src/outputs.ts"
import { encodeRgbaPng } from "../src/png.ts"
import type { Lock } from "../src/types.ts"

let dir: string
let quiet: ReturnType<typeof vi.spyOn>

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "pixelkiln-export-cli-"))
  quiet = vi.spyOn(console, "log").mockImplementation(() => {})
})
afterEach(async () => {
  quiet.mockRestore()
  await rm(dir, { recursive: true, force: true })
})

/**
 * A real `terrain`-generator asset, downloaded, with the corner metadata
 * `pollTerrain` records (see docs/TILES.md). Mirrors `setupTerrain()` in
 * test/tileset-export.test.ts but goes through the actual `export` CLI
 * command instead of calling `exportTileset()` directly, since the bug this
 * guards was in `runExport`'s own generator filter (src/cli/commands/pack.ts),
 * one layer above `exportTileset()`.
 */
async function terrainProject() {
  const manifestPath = path.join(dir, "pixelkiln.manifest.json")
  await writeFile(manifestPath, JSON.stringify({
    name: "test",
    styles: { ground: { outDir: "out", generator: "terrain" } },
    assets: { cliff: { prompt: "1). deep water 2). golden sand" } },
  }))
  const loaded = await loadManifest(manifestPath)
  const [spec] = await resolveSpecs(loaded)
  await mkdir(path.dirname(spec!.outFile), { recursive: true })

  const terrainTiles = [
    { role: "tile-00-water", corners: { NW: "water", NE: "water", SW: "water", SE: "water" } },
    { role: "tile-01-se", corners: { NW: "water", NE: "water", SW: "water", SE: "grass" } },
    { role: "tile-02-nw", corners: { NW: "grass", NE: "water", SW: "water", SE: "water" } },
    { role: "tile-03-grass", corners: { NW: "grass", NE: "grass", SW: "grass", SE: "grass" } },
  ]
  const outputs = []
  for (let index = 0; index < terrainTiles.length; index++) {
    const pixels = Buffer.alloc(4 * 4 * 4, index * 40)
    for (let i = 3; i < pixels.length; i += 4) pixels[i] = 255
    const role = terrainTiles[index]!.role
    const file = memberPath(spec!.outFile, role, index, terrainTiles.length)
    await writeFile(file, encodeRgbaPng(4, 4, pixels))
    outputs.push({ path: file, sha256: String(index), role })
  }

  const lock: Lock = {
    version: 2,
    entries: {
      "ground/cliff": {
        styleId: "ground",
        assetId: "cliff",
        specHash: spec!.specHash,
        generator: "terrain",
        prompt: spec!.prompt,
        width: spec!.width,
        height: spec!.height,
        status: "downloaded",
        outputs,
        provider: "pixellab",
        providerMetadata: { pixellab: { terrainTypes: ["grass", "water"], terrainTiles } },
      },
    },
  } as unknown as Lock
  const lockPath = path.join(dir, "pixelkiln.lock.json")
  await writeFile(lockPath, JSON.stringify(lock))
  return { manifestPath, lockPath }
}

describe("export CLI command", () => {
  it("exports a terrain-generator asset instead of rejecting it as not a tiles entry", async () => {
    const { manifestPath, lockPath } = await terrainProject()
    const out = path.join(dir, "cliff-tileset")
    await runExport(parseArgs([
      "export", "--manifest", manifestPath, "--lock", lockPath,
      "--style", "ground", "--only", "cliff", "--format", "godot", "--out", out,
    ]))
    const document = await readFile(`${out}.tres`, "utf8")
    expect(document).toMatch(/terrain_set_0\/mode = 1/)
    // Isometric (the default tile shape): diamond-point corner names, not square ones.
    expect(document).toMatch(/terrains_peering_bit\/bottom_corner = 0/)
  })
})
