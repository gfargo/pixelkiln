import { afterEach, beforeEach, describe, expect, it } from "vitest"
import path from "node:path"
import { mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { writeArtifactBundle } from "../src/artifacts.ts"

describe("transactional artifact bundles", () => {
  let dir: string

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "pixelkiln-artifacts-"))
  })

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it("writes every member and creates parent directories", async () => {
    const png = path.join(dir, "nested", "sheet.png")
    const json = path.join(dir, "nested", "sheet.json")

    const result = await writeArtifactBundle([
      { path: png, data: new Uint8Array([1, 2, 3]) },
      { path: json, data: "{\"ok\":true}\n" },
    ])

    expect(result).toEqual({ changed: [png, json], unchanged: [] })
    expect([...await readFile(png)]).toEqual([1, 2, 3])
    expect(await readFile(json, "utf8")).toBe("{\"ok\":true}\n")
  })

  it("does not rewrite byte-identical members", async () => {
    const png = path.join(dir, "sheet.png")
    const json = path.join(dir, "sheet.json")
    const files = [
      { path: png, data: new Uint8Array([1, 2, 3]) },
      { path: json, data: "{}\n" },
    ]
    await writeArtifactBundle(files)
    const before = [await stat(png), await stat(json)]

    const result = await writeArtifactBundle(files)
    const after = [await stat(png), await stat(json)]

    expect(result).toEqual({ changed: [], unchanged: [png, json] })
    expect(after.map((value) => value.mtimeMs)).toEqual(before.map((value) => value.mtimeMs))

    const mixed = await writeArtifactBundle([
      { path: png, data: new Uint8Array([4, 5, 6]) },
      files[1]!,
    ])
    expect(mixed).toEqual({ changed: [png], unchanged: [json] })
    expect((await stat(json)).mtimeMs).toBe(after[1]!.mtimeMs)
  })

  it("rejects duplicate normalized destinations before changing files", async () => {
    const destination = path.join(dir, "sheet.png")
    await writeFile(destination, "previous")

    await expect(writeArtifactBundle([
      { path: destination, data: "first" },
      { path: path.join(dir, ".", "sheet.png"), data: "second" },
    ])).rejects.toThrow("duplicate destination")
    expect(await readFile(destination, "utf8")).toBe("previous")
  })

  it("leaves prior files untouched when staging cannot finish", async () => {
    const first = path.join(dir, "sheet.png")
    const second = path.join(dir, "sheet.json")
    await writeFile(first, "previous png")
    await writeFile(second, "previous json")

    await expect(writeArtifactBundle([
      { path: first, data: "new png" },
      { path: second, data: "new json" },
    ], {
      beforeStage: (_destination, index) => {
        if (index === 1) throw new Error("injected failure")
      },
    })).rejects.toThrow("Could not stage artifact bundle")

    expect(await readFile(first, "utf8")).toBe("previous png")
    expect(await readFile(second, "utf8")).toBe("previous json")
    expect((await readdir(dir)).some((name) => name.includes(".pixelkiln-"))).toBe(false)
  })

  it("restores the complete prior bundle when promotion fails", async () => {
    const png = path.join(dir, "sheet.png")
    const json = path.join(dir, "sheet.json")
    await writeFile(png, "previous png")
    await writeFile(json, "previous json")

    await expect(writeArtifactBundle([
      { path: png, data: "new png" },
      { path: json, data: "new json" },
    ], {
      beforePromote: (_destination, index) => {
        if (index === 1) throw new Error("injected failure")
      },
    })).rejects.toThrow("Previous bundle restored")

    expect(await readFile(png, "utf8")).toBe("previous png")
    expect(await readFile(json, "utf8")).toBe("previous json")
    expect((await readdir(dir)).some((name) => name.includes(".pixelkiln-"))).toBe(false)
  })

  it("removes newly-created members when their first promotion fails", async () => {
    const nested = path.join(dir, "nested")
    const png = path.join(nested, "sheet.png")
    const json = path.join(nested, "sheet.json")
    await mkdir(nested)

    await expect(writeArtifactBundle([
      { path: png, data: "new png" },
      { path: json, data: "new json" },
    ], {
      beforePromote: () => {
        throw new Error("injected failure")
      },
    })).rejects.toThrow("Previous bundle restored")

    expect(await readdir(nested)).toEqual([])
  })
})
