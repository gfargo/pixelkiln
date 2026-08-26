import { describe, expect, it, beforeEach, afterEach } from "vitest"
import { mkdtemp, writeFile, mkdir, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { deflateSync } from "node:zlib"
import { decodePng, extractPalette, transparencyRatio, paletteSwatch, parseHex } from "../src/png.ts"
import {
  auditStyle,
  colorDistance,
  evaluateAudit,
  mergePalettes,
  outliers,
  paletteDistance,
  hex,
} from "../src/pipeline/audit.ts"
import { loadManifest, resolveSpecs } from "../src/manifest.ts"
import type { Lock } from "../src/types.ts"

/**
 * Builds a real 8-bit RGBA PNG from pixel data, so the decoder is exercised
 * against bytes it will actually see rather than a stub.
 */
function makePng(width: number, height: number, px: (x: number, y: number) => [number, number, number, number]): Buffer {
  const stride = width * 4
  const raw = Buffer.alloc((stride + 1) * height)
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0 // filter: none
    for (let x = 0; x < width; x++) {
      const [r, g, b, a] = px(x, y)
      const o = y * (stride + 1) + 1 + x * 4
      raw[o] = r; raw[o + 1] = g; raw[o + 2] = b; raw[o + 3] = a
    }
  }
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length)
    const body = Buffer.concat([Buffer.from(type, "ascii"), data])
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body) >>> 0)
    return Buffer.concat([len, body, crc])
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ])
}

function crc32(buf: Buffer): number {
  let c = ~0
  for (const byte of buf) {
    c ^= byte
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1))
  }
  return ~c
}

const solid = (r: number, g: number, b: number, a = 255) => () => [r, g, b, a] as [number, number, number, number]

let dir: string
beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "pixelkiln-audit-"))
})
afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

describe("decodePng", () => {
  it("round-trips dimensions and pixels", () => {
    const png = decodePng(makePng(4, 3, solid(10, 20, 30)))
    expect([png.width, png.height]).toEqual([4, 3])
    expect(png.pixels.length).toBe(4 * 3 * 4)
    expect([...png.pixels.subarray(0, 4)]).toEqual([10, 20, 30, 255])
  })

  it("decodes a gradient, exercising the filter path", () => {
    const png = decodePng(makePng(8, 8, (x, y) => [x * 30, y * 30, 0, 255]))
    const at = (x: number, y: number) => [...png.pixels.subarray((y * 8 + x) * 4, (y * 8 + x) * 4 + 3)]
    expect(at(0, 0)).toEqual([0, 0, 0])
    expect(at(3, 5)).toEqual([90, 150, 0])
  })

  it("rejects non-PNG data", () => {
    expect(() => decodePng(Buffer.from("not a png"))).toThrow(/not a PNG/)
  })

  // Better to refuse than to decode a format subtly wrong.
  it("rejects a colour type it does not handle", () => {
    const png = makePng(2, 2, solid(0, 0, 0))
    png[25] = 2 // IHDR colorType RGB
    expect(() => decodePng(png)).toThrow(/unsupported PNG/)
  })
})

describe("extractPalette", () => {
  it("ranks colours by coverage", () => {
    // Three-quarters red, one-quarter blue.
    const png = decodePng(makePng(4, 4, (x) => (x === 0 ? [0, 0, 255, 255] : [255, 0, 0, 255])))
    const palette = extractPalette(png)
    expect(palette[0]).toMatchObject({ r: 255, g: 0, b: 0 })
    expect(palette[0]!.weight).toBeCloseTo(0.75, 2)
    expect(palette[1]).toMatchObject({ r: 0, g: 0, b: 255 })
  })

  // Anti-aliased edges would otherwise dominate a small sprite's histogram.
  it("ignores transparent pixels", () => {
    const png = decodePng(makePng(4, 4, (x) => (x < 3 ? [9, 9, 9, 0] : [255, 0, 0, 255])))
    const palette = extractPalette(png)
    expect(palette).toHaveLength(1)
    expect(palette[0]!.weight).toBe(1)
  })

  it("returns nothing for a fully transparent image", () => {
    expect(extractPalette(decodePng(makePng(4, 4, solid(0, 0, 0, 0))))).toEqual([])
  })
})

describe("transparencyRatio", () => {
  it("measures the clear share of the canvas", () => {
    const png = decodePng(makePng(4, 4, (x) => (x < 2 ? [0, 0, 0, 0] : [1, 1, 1, 255])))
    expect(transparencyRatio(png)).toBeCloseTo(0.5, 5)
  })
})

describe("colorDistance", () => {
  it("is zero for identical colours and grows with difference", () => {
    expect(colorDistance({ r: 10, g: 10, b: 10 }, { r: 10, g: 10, b: 10 })).toBe(0)
    const near = colorDistance({ r: 10, g: 10, b: 10 }, { r: 20, g: 20, b: 20 })
    const far = colorDistance({ r: 10, g: 10, b: 10 }, { r: 240, g: 240, b: 240 })
    expect(far).toBeGreaterThan(near)
  })
})

describe("paletteDistance", () => {
  it("scores an on-palette asset near zero", () => {
    const ref = [{ r: 255, g: 0, b: 0, weight: 1 }]
    expect(paletteDistance([{ r: 255, g: 0, b: 0, weight: 1 }], ref)).toBe(0)
  })

  // The metric must scale with how much of the image is off-style, not just
  // whether a foreign colour appears at all.
  it("weights divergence by coverage", () => {
    const ref = [{ r: 255, g: 0, b: 0, weight: 1 }]
    const mostlyOff = paletteDistance(
      [{ r: 0, g: 0, b: 255, weight: 0.9 }, { r: 255, g: 0, b: 0, weight: 0.1 }],
      ref,
    )
    const mostlyOn = paletteDistance(
      [{ r: 0, g: 0, b: 255, weight: 0.1 }, { r: 255, g: 0, b: 0, weight: 0.9 }],
      ref,
    )
    expect(mostlyOff).toBeGreaterThan(mostlyOn)
  })
})

describe("mergePalettes", () => {
  it("sums repeated colours and renormalises", () => {
    const merged = mergePalettes([
      [{ r: 1, g: 1, b: 1, weight: 0.5 }],
      [{ r: 1, g: 1, b: 1, weight: 0.5 }, { r: 9, g: 9, b: 9, weight: 0.5 }],
    ])
    expect(merged[0]).toMatchObject({ r: 1, g: 1, b: 1 })
    expect(merged.reduce((s, c) => s + c.weight, 0)).toBeCloseTo(1, 5)
  })
})

describe("auditStyle", () => {
  async function styleProject(withStyleImages: boolean) {
    const outDir = path.join(dir, "out")
    await mkdir(outDir, { recursive: true })
    // Five on-style greys, one saturated green outlier.
    const files: Record<string, Buffer> = {
      a: makePng(32, 32, solid(30, 30, 34)),
      b: makePng(32, 32, solid(34, 34, 38)),
      c: makePng(32, 32, solid(28, 28, 32)),
      d: makePng(32, 32, solid(36, 36, 40)),
      e: makePng(32, 32, solid(32, 32, 36)),
      green: makePng(32, 32, solid(40, 200, 60)),
    }
    for (const [id, buf] of Object.entries(files)) await writeFile(path.join(outDir, `${id}.png`), buf)
    if (withStyleImages) {
      await mkdir(path.join(dir, "refs"), { recursive: true })
      await writeFile(path.join(dir, "refs", "r.png"), makePng(32, 32, solid(31, 31, 35)))
    }
    const manifest = {
      name: "t",
      styles: {
        base: {
          generator: "1dir",
          size: 32,
          outDir: "out",
          ...(withStyleImages ? { styleImages: [{ path: "refs/r.png" }] } : {}),
        },
      },
      assets: Object.fromEntries(Object.keys(files).map((id) => [id, { prompt: id }])),
    }
    const p = path.join(dir, "m.json")
    await writeFile(p, JSON.stringify(manifest))
    const loaded = await loadManifest(p)
    return { loaded, specs: await resolveSpecs(loaded) }
  }

  it("ranks the off-palette asset first", async () => {
    const { loaded, specs } = await styleProject(true)
    const audit = await auditStyle(loaded, specs, "base")
    expect(audit.assets[0]!.assetId).toBe("green")
    expect(audit.referenceFromStyleImages).toBe(true)
    expect(outliers(audit).map((a) => a.assetId)).toContain("green")
  })

  // Without declared references the set is compared to its own average, which
  // still surfaces outliers — it just cannot tell you the whole set drifted.
  it("falls back to the set's own palette when no styleImages are set", async () => {
    const { loaded, specs } = await styleProject(false)
    const audit = await auditStyle(loaded, specs, "base")
    expect(audit.referenceFromStyleImages).toBe(false)
    expect(audit.assets[0]!.assetId).toBe("green")
  })

  it("reports assets that are not on disk rather than skipping them", async () => {
    const { loaded, specs } = await styleProject(true)
    await rm(path.join(dir, "out", "c.png"))
    const audit = await auditStyle(loaded, specs, "base")
    expect(audit.missing).toContain("c")
    expect(audit.assets.map((a) => a.assetId)).not.toContain("c")
  })

  it("rejects an unknown style", async () => {
    const { loaded, specs } = await styleProject(true)
    await expect(auditStyle(loaded, specs, "nope")).rejects.toThrow(/Unknown style/)
  })

  it("audits every recorded output in a structural set", async () => {
    const { loaded, specs } = await styleProject(true)
    const lock = {
      version: 2,
      entries: {
        "base/a": {
          outputs: [
            { path: path.join(dir, "out", "a.png"), sha256: "a", role: "tile-00" },
            { path: path.join(dir, "out", "b.png"), sha256: "b", role: "tile-01" },
          ],
        },
      },
    } as Lock

    const audit = await auditStyle(loaded, specs, "base", lock)

    expect(new Set(audit.assets.filter((asset) => asset.assetId === "a").map((asset) => asset.id)))
      .toEqual(new Set(["a/tile-00", "a/tile-01"]))
  })

  it("turns relative and absolute quality limits into a stable CI decision", async () => {
    const { loaded, specs } = await styleProject(true)
    const audit = await auditStyle(loaded, specs, "base")
    const evaluation = evaluateAudit(audit, {
      sigma: 999,
      maxDistance: 20,
      minTransparency: 0.1,
      maxColors: 1,
    })

    expect(evaluation.safe).toBe(false)
    expect(evaluation.violations.find((item) => item.id === "green")?.reasons)
      .toEqual(expect.arrayContaining([expect.stringMatching(/palette distance/), expect.stringMatching(/transparency/)]))
  })

  it("treats missing outputs as an unsafe check even when measured assets pass", async () => {
    const { loaded, specs } = await styleProject(true)
    await rm(path.join(dir, "out", "a.png"))
    const evaluation = evaluateAudit(await auditStyle(loaded, specs, "base"), { sigma: 999 })
    expect(evaluation.safe).toBe(false)
    expect(evaluation.missing).toContain("a")
  })
})

describe("hex", () => {
  it("pads single-digit channels", () => {
    expect(hex({ r: 1, g: 2, b: 3 })).toBe("#010203")
  })
})

describe("palette swatch", () => {
  // The decoder here only reads RGBA; the swatch is RGB (which is the form the
  // API accepted), so this asserts on the header rather than round-tripping.
  function readIhdr(png: Buffer) {
    expect(png.subarray(0, 8)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
    expect(png.toString("ascii", 12, 16)).toBe("IHDR")
    return {
      width: png.readUInt32BE(16),
      height: png.readUInt32BE(20),
      bitDepth: png[24],
      colorType: png[25],
    }
  }

  it("encodes a valid 8-bit RGB PNG at the requested size", () => {
    const ihdr = readIhdr(paletteSwatch(["#0f380f", "#306230", "#8bac0f", "#9bbc0f"]))
    expect(ihdr).toEqual({ width: 64, height: 64, bitDepth: 8, colorType: 2 })
  })

  // A 4x1 swatch was rejected by the API with "cannot identify image file";
  // a chunky block swatch was accepted. Encode what actually works.
  it("produces a chunky swatch rather than one pixel per colour", () => {
    const ihdr = readIhdr(paletteSwatch(["#000000", "#ffffff"]))
    expect(ihdr.width).toBeGreaterThan(8)
    expect(ihdr.height).toBeGreaterThan(8)
  })

  it("rejects a malformed hex value rather than emitting a wrong colour", () => {
    expect(() => paletteSwatch(["#0f380f", "nope"])).toThrow(/invalid hex/)
  })

  it("rejects an empty palette", () => {
    expect(() => paletteSwatch([])).toThrow(/empty/)
  })

  it("parses hex with and without the leading hash", () => {
    expect(parseHex("#0f380f")).toEqual({ r: 15, g: 56, b: 15 })
    expect(parseHex("0f380f")).toEqual({ r: 15, g: 56, b: 15 })
  })
})
