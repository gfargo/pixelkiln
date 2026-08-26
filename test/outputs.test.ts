import { describe, expect, it } from "vitest"
import {
  outputId,
  resolveEntryOutputs,
  selectEntryOutput,
} from "../src/outputs.ts"
import type { LockEntry } from "../src/types.ts"

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
