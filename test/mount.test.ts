import { describe, expect, it, beforeEach, afterEach } from "vitest"
import { mkdtemp, writeFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { mountSprites, mountStyle, type MountPlacement } from "../src/pipeline/pack.ts"
import type { Lock } from "../src/types.ts"
import { decodePng, encodeRgbaPng } from "../src/png.ts"

let dir: string

/** A solid w x h block of one colour, written to disk and returned by path. */
async function solid(name: string, w: number, h: number, rgba: [number, number, number, number]) {
  const buf = Buffer.alloc(w * h * 4)
  for (let i = 0; i < w * h; i++) buf.set(rgba, i * 4)
  const p = path.join(dir, `${name}.png`)
  await writeFile(p, encodeRgbaPng(w, h, buf))
  return p
}

function pixelAt(png: Buffer, x: number, y: number): [number, number, number, number] {
  const d = decodePng(png)
  const o = (y * d.width + x) * 4
  return [d.pixels[o]!, d.pixels[o + 1]!, d.pixels[o + 2]!, d.pixels[o + 3]!]
}

const RED: [number, number, number, number] = [255, 0, 0, 255]
const BLUE: [number, number, number, number] = [0, 0, 255, 255]
const GREEN: [number, number, number, number] = [0, 255, 0, 255]

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "pixelkiln-mount-"))
})
afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

describe("mountSprites", () => {
  it("places a sprite at its declared cell, not at an index-derived one", async () => {
    const placements: MountPlacement[] = [
      { id: "a", path: await solid("a", 4, 4, RED), cell: [2, 1] },
    ]
    const { png, atlas } = mountSprites(placements, { cellWidth: 4, cellHeight: 4 })

    expect(atlas.sheet).toEqual({ width: 12, height: 8 })
    expect(atlas.frames[0]).toEqual({ id: "a", x: 8, y: 4, width: 4, height: 4 })
    expect(pixelAt(png, 8, 4)).toEqual(RED)
    // cell [0,0] was never claimed, so it stays empty
    expect(pixelAt(png, 0, 0)).toEqual([0, 0, 0, 0])
  })

  it("keeps a declared cell stable when another asset is added", async () => {
    // The reason `mount` exists: `pack` sorts by id, so introducing "aaa"
    // would shift "zzz". A declared cell must not move.
    const zzz = await solid("zzz", 4, 4, RED)
    const one = mountSprites([{ id: "zzz", path: zzz, cell: [3, 0] }], {
      cellWidth: 4,
      cellHeight: 4,
    })
    const two = mountSprites(
      [
        { id: "zzz", path: zzz, cell: [3, 0] },
        { id: "aaa", path: await solid("aaa", 4, 4, BLUE), cell: [0, 0] },
      ],
      { cellWidth: 4, cellHeight: 4 },
    )
    const before = one.atlas.frames.find((f) => f.id === "zzz")
    const after = two.atlas.frames.find((f) => f.id === "zzz")
    expect(after).toEqual(before)
  })

  it("leaves every pixel outside a declared cell byte-for-byte intact", async () => {
    // A 2x1 grid of 4x4 cells, both green.
    const base = Buffer.alloc(8 * 4 * 4)
    for (let i = 0; i < 8 * 4; i++) base.set(GREEN, i * 4)
    const basePng = encodeRgbaPng(8, 4, base)

    const { png, overBase } = mountSprites(
      [{ id: "a", path: await solid("a", 4, 4, RED), cell: [0, 0] }],
      { cellWidth: 4, cellHeight: 4, basePng },
    )

    expect(overBase).toBe(true)
    expect(pixelAt(png, 0, 0)).toEqual(RED) // claimed cell replaced
    expect(pixelAt(png, 4, 0)).toEqual(GREEN) // unclaimed cell untouched
    expect(pixelAt(png, 7, 3)).toEqual(GREEN)
  })

  it("clears the whole cell so a smaller sprite does not leave the base showing", async () => {
    const base = Buffer.alloc(4 * 4 * 4)
    for (let i = 0; i < 16; i++) base.set(GREEN, i * 4)
    const basePng = encodeRgbaPng(4, 4, base)

    const { png } = mountSprites(
      [{ id: "small", path: await solid("small", 2, 2, RED), cell: [0, 0] }],
      { cellWidth: 4, cellHeight: 4, basePng },
    )

    expect(pixelAt(png, 0, 0)).toEqual(RED)
    // The 2x2 sprite does not cover the cell; the rest must be cleared, not
    // left as the green it replaced.
    expect(pixelAt(png, 3, 3)).toEqual([0, 0, 0, 0])
  })

  it("grows the sheet past the base rather than refusing a new row", async () => {
    const base = Buffer.alloc(4 * 4 * 4)
    const basePng = encodeRgbaPng(4, 4, base)
    const { atlas } = mountSprites(
      [{ id: "a", path: await solid("a", 4, 4, RED), cell: [0, 2] }],
      { cellWidth: 4, cellHeight: 4, basePng },
    )
    expect(atlas.sheet).toEqual({ width: 4, height: 12 })
  })

  it("refuses two assets claiming the same cell", async () => {
    const placements: MountPlacement[] = [
      { id: "a", path: await solid("a", 4, 4, RED), cell: [1, 1] },
      { id: "b", path: await solid("b", 4, 4, BLUE), cell: [1, 1] },
    ]
    expect(() => mountSprites(placements, { cellWidth: 4, cellHeight: 4 })).toThrow(
      /both claim cell 1,1/,
    )
  })

  it("skips a sprite too large for the cell instead of cropping it", async () => {
    const { skipped, atlas } = mountSprites(
      [
        { id: "big", path: await solid("big", 8, 8, RED), cell: [0, 0] },
        { id: "ok", path: await solid("ok", 4, 4, BLUE), cell: [1, 0] },
      ],
      { cellWidth: 4, cellHeight: 4 },
    )
    expect(atlas.frames.map((f) => f.id)).toEqual(["ok"])
    expect(skipped[0]!.id).toBe("big")
    expect(skipped[0]!.reason).toMatch(/larger than the 4x4 cell/)
  })

  it("reports an unreadable sprite rather than aborting the sheet", async () => {
    const { atlas, skipped } = mountSprites(
      [
        { id: "gone", path: path.join(dir, "nope.png"), cell: [0, 0] },
        { id: "ok", path: await solid("ok", 4, 4, BLUE), cell: [1, 0] },
      ],
      { cellWidth: 4, cellHeight: 4 },
    )
    expect(atlas.frames.map((f) => f.id)).toEqual(["ok"])
    expect(skipped.map((s) => s.id)).toEqual(["gone"])
  })

  it("rejects a non-positive cell", async () => {
    const p = [{ id: "a", path: await solid("a", 4, 4, RED), cell: [0, 0] }] as MountPlacement[]
    expect(() => mountSprites(p, { cellWidth: 0, cellHeight: 4 })).toThrow(/must be positive/)
  })
})


// ── mountStyle: where the pixels come from ──────────────────────────────────
// `mount` reads the lockfile, which records what the API returned. That is
// the wrong file whenever the art needs a step pixelkiln does not perform —
// the terrain atlas reduces every generated tile onto a closed palette before
// it goes on the sheet. `source` is how an asset says so.

/** A lockfile with one recorded output per id. */
function lockWith(styleId: string, outputs: Record<string, string>): Lock {
  const entries: Lock["entries"] = {}
  for (const [id, p] of Object.entries(outputs)) {
    entries[`${styleId}/${id}`] = { outputs: [{ path: p }] } as Lock["entries"][string]
  }
  return { version: 2, entries }
}

const MOUNT = { cellWidth: 4, cellHeight: 4, out: "sheet.png" }

describe("mountStyle sources", () => {
  it("mounts art pixelkiln never generated", async () => {
    await solid("remapped", 4, 4, GREEN)
    const { png, skipped } = mountStyle(
      { version: 2, entries: {} },      // nothing generated at all
      "terrain",
      dir,
      MOUNT,
      { grass: [0, 0] },
      { grass: "remapped.png" },
    )
    expect(skipped).toEqual([])
    expect(pixelAt(png, 1, 1)).toEqual(GREEN)
  })

  it("prefers the source over the raw generated output", async () => {
    await solid("raw", 4, 4, RED)
    await solid("remapped", 4, 4, GREEN)
    const { png } = mountStyle(
      lockWith("terrain", { grass: "raw.png" }),
      "terrain",
      dir,
      MOUNT,
      { grass: [0, 0] },
      { grass: "remapped.png" },
    )
    // RED is the untouched download; mounting it is the bug this field exists
    // to prevent, and it would look plausible right up until it shipped.
    expect(pixelAt(png, 1, 1)).toEqual(GREEN)
  })

  it("still mounts a generated asset when no source is declared", async () => {
    await solid("raw", 4, 4, RED)
    const { png } = mountStyle(
      lockWith("terrain", { grass: "raw.png" }),
      "terrain",
      dir,
      MOUNT,
      { grass: [0, 0] },
      {},
    )
    expect(pixelAt(png, 1, 1)).toEqual(RED)
  })

  it("refuses to guess which member of a multi-output set owns one cell", async () => {
    await solid("tile-00", 4, 4, RED)
    await solid("tile-01", 4, 4, BLUE)
    const lock = lockWith("terrain", { grass: "tile-00.png" })
    lock.entries["terrain/grass"]!.outputs = [
      { path: "tile-00.png", sha256: "a", role: "tile-00" },
      { path: "tile-01.png", sha256: "b", role: "tile-01" },
    ]

    expect(() => mountStyle(lock, "terrain", dir, MOUNT, { grass: [0, 0] }, {}))
      .toThrow(/2 outputs are recorded; set `outputRole`/)
  })

  it("mounts a named output role from a structural set", async () => {
    await solid("tile-00", 4, 4, RED)
    await solid("tile-01", 4, 4, BLUE)
    const lock = lockWith("terrain", { grass: "tile-00.png" })
    lock.entries["terrain/grass"]!.outputs = [
      { path: "tile-00.png", sha256: "a", role: "tile-00" },
      { path: "tile-01.png", sha256: "b", role: "tile-01" },
    ]

    const { png } = mountStyle(
      lock,
      "terrain",
      dir,
      MOUNT,
      { grass: [0, 0] },
      {},
      { grass: "tile-01" },
    )
    expect(pixelAt(png, 1, 1)).toEqual(BLUE)
  })

  it("says which assets it could not place, and places the rest", async () => {
    await solid("remapped", 4, 4, GREEN)
    const { png, skipped } = mountStyle(
      { version: 2, entries: {} },
      "terrain",
      dir,
      MOUNT,
      { grass: [0, 0], dirt: [1, 0] },
      { grass: "remapped.png" },
    )
    expect(skipped).toEqual([
      { id: "dirt", reason: 'not generated in style "terrain", and no `source` declared' },
    ])
    expect(pixelAt(png, 1, 1)).toEqual(GREEN)
  })

  it("fails loudly when nothing is placeable rather than writing an empty sheet", () => {
    expect(() =>
      mountStyle({ version: 2, entries: {} }, "terrain", dir, MOUNT, { grass: [0, 0] }, {}),
    ).toThrow(/Nothing to mount/)
  })

  it("still asks for a cell when no asset declares one", () => {
    expect(() =>
      mountStyle(lockWith("terrain", { grass: "raw.png" }), "terrain", dir, MOUNT, {}, {}),
    ).toThrow(/declare a `cell`/)
  })
})
