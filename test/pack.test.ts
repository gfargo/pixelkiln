import { describe, expect, it } from "vitest"
import { mkdtemp, writeFile, rm, mkdir } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { packSprites, packStyle, resolvePackInputs } from "../src/pipeline/pack.ts"
import { decodePng, encodeRgbPng, encodeRgbaPng } from "../src/png.ts"
import type { Lock } from "../src/types.ts"

/** A solid square of one colour, fully opaque, with a transparent right half. */
function sprite(size: number, r: number, g: number, b: number): Buffer {
  const rgba = Buffer.alloc(size * size * 4)
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const o = (y * size + x) * 4
      rgba[o] = r
      rgba[o + 1] = g
      rgba[o + 2] = b
      rgba[o + 3] = x < size / 2 ? 255 : 0
    }
  }
  return encodeRgbaPng(size, size, rgba)
}

function lockWith(ids: string[], style = "s"): Lock {
  const entries: Record<string, any> = {}
  for (const id of ids) {
    entries[`${style}/${id}`] = {
      status: "downloaded",
      error: null,
      generator: "pixflux",
      outputs: [{ path: `${id}.png`, sha256: "x" }],
      provider: "fake",
    }
  }
  return { version: 2, entries } as Lock
}

describe("packStyle", () => {
  it("lays sprites out in a grid and records their frames", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "pk-pack-"))
    try {
      for (const id of ["c", "a", "b", "d"]) await writeFile(path.join(dir, `${id}.png`), sprite(8, 10, 20, 30))

      const { atlas } = packStyle(lockWith(["c", "a", "b", "d"]), "s", dir)

      // 4 sprites -> ceil(sqrt(4)) = 2 columns, 2 rows of 8px cells.
      expect(atlas.columns).toBe(2)
      expect(atlas.sheet).toEqual({ width: 16, height: 16 })
      expect(atlas.cell).toEqual({ width: 8, height: 8 })
      // Sorted by asset id so the sheet is reproducible run to run.
      expect(atlas.frames.map((f) => f.id)).toEqual(["a", "b", "c", "d"])
      expect(atlas.frames.map((f) => [f.x, f.y])).toEqual([
        [0, 0], [8, 0], [0, 8], [8, 8],
      ])
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it("preserves transparency — the whole point of an RGBA sheet", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "pk-pack-"))
    try {
      await writeFile(path.join(dir, "a.png"), sprite(8, 200, 100, 50))
      const { png } = packStyle(lockWith(["a"]), "s", dir)
      const decoded = decodePng(png)

      // Left half opaque and the original colour, right half fully clear.
      const at = (x: number, y: number) => {
        const o = (y * decoded.width + x) * 4
        return [decoded.pixels[o], decoded.pixels[o + 1], decoded.pixels[o + 2], decoded.pixels[o + 3]]
      }
      expect(at(0, 0)).toEqual([200, 100, 50, 255])
      expect(at(7, 0)![3]).toBe(0)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it("normalizes a valid RGB source into the RGBA sheet", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "pk-pack-"))
    try {
      await writeFile(
        path.join(dir, "rgb.png"),
        encodeRgbPng(2, 1, Buffer.from([10, 20, 30, 40, 50, 60])),
      )

      const { png, skipped } = packStyle(lockWith(["rgb"]), "s", dir)
      expect(skipped).toEqual([])
      expect([...decodePng(png).pixels]).toEqual([
        10, 20, 30, 255,
        40, 50, 60, 255,
      ])
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it("sizes the cell to the largest sprite so an odd one out is not clipped", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "pk-pack-"))
    try {
      await writeFile(path.join(dir, "small.png"), sprite(8, 1, 2, 3))
      await writeFile(path.join(dir, "big.png"), sprite(16, 4, 5, 6))

      const { atlas } = packStyle(lockWith(["small", "big"]), "s", dir)
      expect(atlas.cell).toEqual({ width: 16, height: 16 })
      // The frame records the sprite's real size, not the cell's.
      expect(atlas.frames.find((f) => f.id === "small")!.width).toBe(8)
      expect(atlas.frames.find((f) => f.id === "big")!.width).toBe(16)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it("reports a missing file instead of aborting the whole sheet", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "pk-pack-"))
    try {
      await writeFile(path.join(dir, "there.png"), sprite(8, 9, 9, 9))
      const { atlas, skipped } = packStyle(lockWith(["there", "gone"]), "s", dir)

      expect(atlas.frames.map((f) => f.id)).toEqual(["there"])
      expect(skipped).toHaveLength(1)
      expect(skipped[0]!.id).toBe("gone")
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it("fails loudly when the style has nothing locked", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "pk-pack-"))
    try {
      expect(() => packStyle(lockWith(["a"], "other"), "s", dir)).toThrow(/No locked assets/)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it("honours an explicit column count", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "pk-pack-"))
    try {
      for (const id of ["a", "b", "c"]) await writeFile(path.join(dir, `${id}.png`), sprite(8, 1, 1, 1))
      const { atlas } = packStyle(lockWith(["a", "b", "c"]), "s", dir, { columns: 1 })
      expect(atlas.sheet).toEqual({ width: 8, height: 24 })
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it("packs every output in a structural set with stable role-qualified ids", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "pk-pack-"))
    try {
      await writeFile(path.join(dir, "terrain-tile-00.png"), sprite(8, 1, 2, 3))
      await writeFile(path.join(dir, "terrain-tile-01.png"), sprite(8, 4, 5, 6))
      const lock = lockWith(["terrain"])
      lock.entries["s/terrain"]!.outputs = [
        { path: "terrain-tile-00.png", sha256: "a", role: "tile-00" },
        { path: "terrain-tile-01.png", sha256: "b", role: "tile-01" },
      ]

      const { atlas } = packStyle(lock, "s", dir)

      expect(atlas.frames.map((frame) => frame.id)).toEqual([
        "terrain/tile-00",
        "terrain/tile-01",
      ])
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it("can pack only explicitly selected output roles", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "pk-pack-"))
    try {
      await writeFile(path.join(dir, "terrain-tile-00.png"), sprite(8, 1, 2, 3))
      await writeFile(path.join(dir, "terrain-tile-01.png"), sprite(8, 4, 5, 6))
      const lock = lockWith(["terrain"])
      lock.entries["s/terrain"]!.outputs = [
        { path: "terrain-tile-00.png", sha256: "a", role: "tile-00" },
        { path: "terrain-tile-01.png", sha256: "b", role: "tile-01" },
      ]

      const { atlas } = packStyle(lock, "s", dir, { outputRoles: ["tile-01"] })
      expect(atlas.frames.map((frame) => frame.id)).toEqual(["terrain/tile-01"])
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it("primary-only mode skips an ambiguous structural set", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "pk-pack-"))
    try {
      await writeFile(path.join(dir, "single.png"), sprite(8, 1, 2, 3))
      await writeFile(path.join(dir, "tile-00.png"), sprite(8, 4, 5, 6))
      await writeFile(path.join(dir, "tile-01.png"), sprite(8, 7, 8, 9))
      const lock = lockWith(["single", "terrain"])
      lock.entries["s/terrain"]!.outputs = [
        { path: "tile-00.png", sha256: "a", role: "tile-00" },
        { path: "tile-01.png", sha256: "b", role: "tile-01" },
      ]

      const { atlas, skipped } = packStyle(lock, "s", dir, { primaryOnly: true })
      expect(atlas.frames.map((frame) => frame.id)).toEqual(["single"])
      expect(skipped).toContainEqual({
        id: "terrain",
        reason: "no unambiguous primary output; use --output-role",
      })
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})

describe("packSprites", () => {
  it("rejects duplicate ids before touching any file", () => {
    // Nonexistent paths on purpose: a duplicate-id error must fire before any
    // decode is attempted, so this never reaches the filesystem at all.
    const inputs = [
      { id: "a", path: "/nonexistent/one.png" },
      { id: "a", path: "/nonexistent/two.png" },
    ]
    expect(() => packSprites(inputs)).toThrow(/duplicate sprite id.*a/i)
  })

  it("names every duplicated id, not just the first", () => {
    const inputs = [
      { id: "a", path: "/x/1.png" },
      { id: "a", path: "/x/2.png" },
      { id: "b", path: "/x/3.png" },
      { id: "b", path: "/x/4.png" },
      { id: "c", path: "/x/5.png" },
    ]
    expect(() => packSprites(inputs)).toThrow(/a, b|b, a/)
  })
})

describe("resolvePackInputs", () => {
  const inputsFile = "/project/tmp/inputs.json"

  it("resolves a relative path against the inputs file's directory, not cwd", () => {
    const result = resolvePackInputs([{ id: "a", path: "sprites/a.png" }], inputsFile)
    expect(result).toEqual([{ id: "a", path: "/project/tmp/sprites/a.png" }])
  })

  it("passes an already-absolute path through unchanged", () => {
    const result = resolvePackInputs([{ id: "a", path: "/elsewhere/a.png" }], inputsFile)
    expect(result).toEqual([{ id: "a", path: "/elsewhere/a.png" }])
  })

  it("rejects a non-array payload", () => {
    expect(() => resolvePackInputs({ id: "a", path: "a.png" }, inputsFile)).toThrow(/non-empty JSON array/)
  })

  it("rejects an empty array", () => {
    expect(() => resolvePackInputs([], inputsFile)).toThrow(/non-empty JSON array/)
  })

  it("reports which entry is malformed, by index", () => {
    const bad = [{ id: "a", path: "a.png" }, { id: "b" }]
    expect(() => resolvePackInputs(bad, inputsFile)).toThrow(/--inputs\[1\]/)
  })
})
