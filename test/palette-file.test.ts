import path from "node:path"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { loadManifest, resolveSpecs } from "../src/manifest.ts"
import { parsePaletteFile } from "../src/palette.ts"

const GB = ["#081820", "#346856", "#88c070", "#e0f8d0"]

let dir: string
beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "pixelkiln-palette-file-"))
})
afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

async function manifest(styles: Record<string, unknown>, assets: Record<string, unknown> = { rock: { prompt: "a rock" } }) {
  const file = path.join(dir, "pixelkiln.manifest.json")
  await writeFile(file, JSON.stringify({ name: "palette-file", provider: "pixellab", styles, assets }))
  return file
}

describe("parsePaletteFile", () => {
  it("reads a Lospec .hex file", () => {
    expect(parsePaletteFile("081820\r\n346856\n#88C070\n\ne0f8d0\n", "gb.hex")).toEqual(GB)
  })

  it("reads a GIMP .gpl file, skipping the header, comments, and names", () => {
    const gpl = "GIMP Palette\nName: Game Boy\nColumns: 4\n#\n  8  24  32\tdarkest\n 52 104  86\n136 192 112 light\n224 248 208\n"
    expect(parsePaletteFile(gpl, "gb.gpl")).toEqual(GB)
  })

  it("reads a Paint.NET .txt file and drops the alpha byte", () => {
    expect(parsePaletteFile(";paint.net Palette File\n;Colors: 4\nFF081820\nFF346856\nff88c070\nFFE0F8D0\n", "gb.txt")).toEqual(GB)
  })

  it("names the file and line it cannot read", () => {
    expect(() => parsePaletteFile("081820\nnope\n", "bad.hex")).toThrow('bad.hex:2: expected rrggbb, got "nope"')
    expect(() => parsePaletteFile("Name: x\n1 2 3\n", "bad.gpl")).toThrow(/bad\.gpl:1: .*GIMP Palette/)
    expect(() => parsePaletteFile("GIMP Palette\n1 2 300\n", "bad.gpl")).toThrow(/bad\.gpl:2: channel above 255/)
    expect(() => parsePaletteFile("\n\n", "empty.hex")).toThrow("empty.hex: no colours found")
    expect(() => parsePaletteFile("081820\n", "gb.ase")).toThrow(/\.hex, \.gpl, or \.txt/)
  })
})

describe("style paletteFile", () => {
  it("loads the file into palette, with the same hash as the inline colours", async () => {
    await mkdir(path.join(dir, "palettes"))
    await writeFile(path.join(dir, "palettes", "gb.hex"), GB.map((c) => c.slice(1)).join("\n"))
    const fromFile = (await resolveSpecs(await loadManifest(await manifest({
      base: { outDir: "art", generator: "imagePro", size: 64, paletteFile: "palettes/gb.hex" },
    }))))
    const inline = (await resolveSpecs(await loadManifest(await manifest({
      base: { outDir: "art", generator: "imagePro", size: 64, palette: GB },
    }))))
    expect(fromFile[0]!.palette).toEqual(GB)
    expect(fromFile[0]!.specHash).toBe(inline[0]!.specHash)
  })

  it("moves the hash when the file changes", async () => {
    const file = await manifest({ base: { outDir: "art", generator: "imagePro", size: 64, paletteFile: "gb.hex" } })
    await writeFile(path.join(dir, "gb.hex"), GB.join("\n"))
    const before = (await resolveSpecs(await loadManifest(file)))[0]!.specHash
    await writeFile(path.join(dir, "gb.hex"), [...GB.slice(0, 3), "#ffffff"].join("\n"))
    expect((await resolveSpecs(await loadManifest(file)))[0]!.specHash).not.toBe(before)
  })

  it("lets a child style replace its parent's file palette", async () => {
    await writeFile(path.join(dir, "gb.hex"), GB.join("\n"))
    const loaded = await loadManifest(await manifest({
      base: { outDir: "art", generator: "imagePro", size: 64, paletteFile: "gb.hex" },
      mono: { extends: "base", outDir: "art/mono", palette: ["#000000", "#ffffff"] },
    }))
    expect(loaded.manifest.styles.base!.palette).toEqual(GB)
    expect(loaded.manifest.styles.mono!.palette).toEqual(["#000000", "#ffffff"])
  })

  it("refuses a missing file, a bad file, and palette with paletteFile", async () => {
    await writeFile(path.join(dir, "bad.hex"), "zzz\n")
    await expect(loadManifest(await manifest({ base: { outDir: "art", paletteFile: "gone.hex" } })))
      .rejects.toThrow("styles.base.paletteFile: no file at gone.hex")
    await expect(loadManifest(await manifest({ base: { outDir: "art", paletteFile: "bad.hex" } })))
      .rejects.toThrow('styles.base.paletteFile: bad.hex:1: expected rrggbb, got "zzz"')
    await expect(loadManifest(await manifest({ base: { outDir: "art", paletteFile: "bad.hex", palette: GB } })))
      .rejects.toThrow("styles.base.paletteFile: set palette or paletteFile, not both")
  })

  it("sets a style with an unreadable file aside in a lenient load", async () => {
    const loaded = await loadManifest(await manifest(
      { good: { outDir: "art" }, broken: { outDir: "art/b", paletteFile: "gone.hex" } },
      { rock: { prompt: "a rock", styles: ["good"] }, gem: { prompt: "a gem", styles: ["broken"] } },
    ), { lenient: true })
    expect(Object.keys(loaded.manifest.styles)).toEqual(["good"])
    expect(loaded.invalid?.map((e) => `${e.kind}:${e.id}`)).toEqual(["style:broken", "asset:gem"])
    expect(loaded.invalid?.[0]!.issues[0]).toBe("styles.broken.paletteFile: no file at gone.hex")
  })
})
