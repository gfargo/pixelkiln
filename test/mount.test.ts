import { describe, expect, it, beforeEach, afterEach } from "vitest"
import { mkdtemp, writeFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { mountSprites, type MountPlacement } from "../src/pipeline/pack.ts"
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
