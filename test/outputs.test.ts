import { describe, expect, it } from "vitest"
import path from "node:path"
import {
  normalizeLockOutputPaths,
  outputId,
  portableOutputPath,
  resolveEntryOutputs,
  resolveOutputPath,
  selectEntryOutput,
} from "../src/outputs.ts"
import type { Lock, LockEntry, ResolvedSpec } from "../src/types.ts"

function entry(outputs: LockEntry["outputs"]): LockEntry {
  return { outputs } as LockEntry
}

describe("output identity", () => {
  it("preserves the asset id for a conventional single output", () => {
    expect(outputId("grass", {}, 0, 1)).toBe("grass")
  })

  it("qualifies structural outputs by role and preserves provider order", () => {
    const outputs = resolveEntryOutputs(
      entry([
        { path: "b.png", sha256: "b", role: "tile-01" },
        { path: "a.png", sha256: "a", role: "tile-00" },
      ]),
      "terrain",
      "/project",
    )
    expect(outputs.map((output) => output.id)).toEqual([
      "terrain/tile-01",
      "terrain/tile-00",
    ])
  })
})

describe("portable output paths", () => {
  it("round-trips a manifest-relative path without using the process cwd", () => {
    const root = path.resolve("project")
    const file = path.join(root, "art", "anvil.png")
    const recorded = portableOutputPath(file, root)
    expect(recorded).toBe("art/anvil.png")
    expect(resolveOutputPath(recorded, root)).toBe(file)
  })

  it("rebases a legacy absolute path onto the current checkout", () => {
    const root = path.resolve("new-checkout")
    const spec = {
      root,
      styleId: "base",
      assetId: "terrain",
      outFile: path.join(root, "out", "terrain.png"),
    } as ResolvedSpec
    const lock = {
      version: 2,
      entries: {
        "base/terrain": {
          outputs: [
            { path: "/old-checkout/out/terrain-tile-00.png", sha256: "a", role: "tile-00" },
            { path: "C:\\old-checkout\\out\\terrain-tile-01.png", sha256: "b", role: "tile-01" },
          ],
        } as LockEntry,
      },
    } as Lock

    expect(normalizeLockOutputPaths(lock, [spec])).toBe(2)
    expect(lock.entries["base/terrain"]!.outputs.map((output) => output.path)).toEqual([
      "out/terrain-tile-00.png",
      "out/terrain-tile-01.png",
    ])
  })

  it("keeps a partial structural download qualified by its complete source set", () => {
    const root = path.resolve("new-checkout")
    const spec = {
      root,
      styleId: "base",
      assetId: "terrain",
      outFile: path.join(root, "out", "terrain.png"),
    } as ResolvedSpec
    const lock = {
      version: 2,
      entries: {
        "base/terrain": {
          sourceUrls: [
            { url: "https://example.test/0.png", role: "tile-00" },
            { url: "https://example.test/1.png", role: "tile-01" },
            { url: "https://example.test/2.png", role: "tile-02" },
          ],
          outputs: [
            { path: "/old-checkout/out/terrain-tile-00.png", sha256: "a", role: "tile-00" },
          ],
        } as LockEntry,
      },
    } as Lock

    normalizeLockOutputPaths(lock, [spec])
    expect(lock.entries["base/terrain"]!.outputs[0]!.path).toBe("out/terrain-tile-00.png")
  })
})

describe("single-output selection", () => {
  it("requires a role when every member of a set is structural", () => {
    const result = selectEntryOutput(entry([
      { path: "0.png", sha256: "a", role: "tile-00" },
      { path: "1.png", sha256: "b", role: "tile-01" },
    ]))
    expect(result).toEqual({
      ok: false,
      reason: "2 outputs are recorded; set `outputRole` to choose one",
    })
  })

  it("selects an explicitly named role", () => {
    const result = selectEntryOutput(entry([
      { path: "0.png", sha256: "a", role: "tile-00" },
      { path: "1.png", sha256: "b", role: "tile-01" },
    ]), "tile-01")
    expect(result.ok && result.output.path).toBe("1.png")
  })
})
