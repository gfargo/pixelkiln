import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { existsSync } from "node:fs"
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { loadManifest, resolveSpecs } from "../src/manifest.ts"
import { loadLock } from "../src/lock.ts"
import { importLocal } from "../src/pipeline/import.ts"
import { saveHandEdit, startHandEdit } from "../src/pipeline/hand-edit.ts"
import { ManifestEditError } from "../src/manifest-edit.ts"
import { encodeRgbaPng } from "../src/png.ts"

let dir: string
const png = encodeRgbaPng(16, 16, Buffer.alloc(16 * 16 * 4, 128))

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "pixelkiln-uneditable-"))
  await mkdir(path.join(dir, "out"), { recursive: true })
  for (const name of ["rock", "rock_red", "rock_flip", "dock"]) await writeFile(path.join(dir, "out", `${name}.png`), png)
  await writeFile(
    path.join(dir, "m.json"),
    JSON.stringify({
      name: "t",
      styles: { s: { generator: "imageProFlash", outDir: "out" } },
      assets: {
        rock: { prompt: "a rock", width: 16, height: 16 },
        rock_red: { derive: { from: "rock", transform: "recolor", map: { "#808080": "#c02020" } } },
        rock_flip: { mirror: "rock" },
        dock: { external: { builder: "python build.py dock" } },
      },
    }),
  )
})
afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

async function open() {
  const loaded = await loadManifest(path.join(dir, "m.json"))
  const specs = await resolveSpecs(loaded)
  const lockPath = path.join(dir, "lock.json")
  const lock = await loadLock(lockPath)
  await importLocal(specs.filter((s) => s.assetId === "rock" || s.assetId === "dock"), lock, lockPath, {})
  const spec = (id: string) => specs.find((s) => s.assetId === id)!
  return { loaded, lock, spec }
}

describe("hand edit of an asset that cannot declare a source", () => {
  it.each([
    ["rock_red", /derived from rock \(recolor\).*edit its source/],
    ["dock", /built outside pixelkiln \(python build\.py dock\).*adopt --local --force/],
    ["rock_flip", /flip of rock.*edit rock and flip it again/],
  ])("refuses %s clearly and creates nothing", async (id, message) => {
    const { loaded, lock, spec } = await open()
    const before = await readFile(path.join(dir, "m.json"))
    await expect(startHandEdit(loaded, lock, spec(id))).rejects.toThrow(message)
    await expect(startHandEdit(loaded, lock, spec(id))).rejects.toBeInstanceOf(ManifestEditError)
    await expect(saveHandEdit(loaded, lock, spec(id), { png })).rejects.toThrow(message)
    expect(await readFile(path.join(dir, "m.json"))).toEqual(before)
    expect(existsSync(path.join(dir, "out", "edits"))).toBe(false)
  })

  it("still edits an imported asset", async () => {
    const { loaded, lock, spec } = await open()
    const started = await startHandEdit(loaded, lock, spec("rock"))
    expect(started.created).toBe(true)
    expect(existsSync(path.join(dir, "out", "edits", "rock.png"))).toBe(true)
  })
})
