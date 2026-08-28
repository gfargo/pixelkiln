import { afterEach, beforeEach, describe, expect, it } from "vitest"
import path from "node:path"
import { mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { execFile } from "node:child_process"
import { promisify } from "node:util"
import {
  createArtifactBundleManifest,
  verifyArtifactBundle,
  withArtifactManifest,
  writeArtifactBundle,
} from "../src/artifacts.ts"
import { sha256 } from "../src/hash.ts"
import { encodeRgbaPng } from "../src/png.ts"

const execFileAsync = promisify(execFile)

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

  it("builds canonical, portable provenance metadata", async () => {
    const source = path.join(dir, "source.png")
    const output = path.join(dir, "dist", "sheet.png")
    const manifestPath = path.join(dir, "dist", "sheet.pixelkiln.json")
    const sourceHash = "a".repeat(64)
    const provenance = {
      kind: "pack" as const,
      sources: [{ id: "sprite", path: source, sha256: sourceHash, included: true }],
      options: { z: 1, nested: { b: true, a: false }, a: 2 },
    }

    const first = createArtifactBundleManifest(
      manifestPath,
      [{ path: output, data: "png bytes" }],
      provenance,
    )
    const second = createArtifactBundleManifest(
      manifestPath,
      [{ path: output, data: "png bytes" }],
      { ...provenance, options: { a: 2, nested: { a: false, b: true }, z: 1 } },
    )

    expect(first.fingerprint).toBe(second.fingerprint)
    expect(first.sources[0]!.path).toBe("../source.png")
    expect(first.outputs[0]!.path).toBe("sheet.png")
    expect(first.options).toEqual({ a: 2, nested: { a: false, b: true }, z: 1 })
  })

  it("verifies source, output, and provenance changes without rebuilding", async () => {
    const source = path.join(dir, "source.png")
    const output = path.join(dir, "sheet.png")
    const manifestPath = path.join(dir, "sheet.pixelkiln.json")
    await writeFile(source, "source one")
    const files = [{ path: output, data: "derived output" }]
    const provenance = {
      kind: "pack" as const,
      sources: [{
        id: "sprite",
        path: source,
        sha256: sha256("source one"),
        included: true,
      }],
      options: { columns: 1 },
    }
    await writeArtifactBundle(withArtifactManifest(manifestPath, files, provenance))

    expect(await verifyArtifactBundle(manifestPath)).toEqual({
      current: true,
      fingerprintValid: true,
      changedSources: [],
      changedOutputs: [],
    })

    await writeFile(source, "source two")
    expect((await verifyArtifactBundle(manifestPath)).changedSources).toEqual(["sprite"])
    await writeFile(source, "source one")
    await writeFile(output, "manual edit")
    expect((await verifyArtifactBundle(manifestPath)).changedOutputs).toEqual(["sheet.png"])

    const manifest = JSON.parse(await readFile(manifestPath, "utf8"))
    manifest.options.columns = 2
    await writeFile(manifestPath, JSON.stringify(manifest))
    expect((await verifyArtifactBundle(manifestPath)).fingerprintValid).toBe(false)
  })

  it("writes a verifiable companion through the no-manifest CLI", async () => {
    const source = path.join(dir, "sprite.png")
    const inputs = path.join(dir, "inputs.json")
    const base = path.join(dir, "dist", "sheet")
    await writeFile(source, encodeRgbaPng(1, 1, Buffer.from([1, 2, 3, 255])))
    await writeFile(inputs, JSON.stringify([{ id: "sprite", path: "sprite.png" }]))

    await execFileAsync(path.resolve("node_modules/.bin/tsx"), [
      path.resolve("src/cli.ts"),
      "pack",
      "--inputs", inputs,
      "--out", base,
    ], { cwd: dir })

    expect(await verifyArtifactBundle(`${base}.pixelkiln.json`)).toMatchObject({ current: true })
    expect(JSON.parse(await readFile(`${base}.json`, "utf8")).frames[0].id).toBe("sprite")
  })
})
