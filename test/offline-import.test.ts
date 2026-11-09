import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { mkdtemp, mkdir, rm, writeFile, readFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { loadManifest, resolveSpecs } from "../src/manifest.ts"
import { loadLock } from "../src/lock.ts"
import { buildPlan } from "../src/pipeline/plan.ts"
import { importLocal, reportSpecHashes } from "../src/pipeline/import.ts"
import { encodeRgbaPng } from "../src/png.ts"

let dir: string
const png = (shade: number) => encodeRgbaPng(8, 8, Buffer.alloc(8 * 8 * 4, shade))

async function project(assets: Record<string, unknown>, files: Record<string, Buffer> = {}) {
  await mkdir(path.join(dir, "out"), { recursive: true })
  await writeFile(
    path.join(dir, "m.json"),
    JSON.stringify({ name: "t", styles: { s: { generator: "imageProFlash", outDir: "out" } }, assets }),
  )
  for (const [name, bytes] of Object.entries(files)) await writeFile(path.join(dir, "out", name), bytes)
  const loaded = await loadManifest(path.join(dir, "m.json"))
  return { loaded, specs: await resolveSpecs(loaded), lockPath: path.join(dir, "lock.json") }
}

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "pixelkiln-import-"))
})
afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

describe("importLocal", () => {
  it("records a file already on disk without a provider, and the plan then calls it ok", async () => {
    const { specs, lockPath } = await project(
      { rock: { prompt: "rock", width: 32, height: 32 } },
      { "rock.png": png(10) },
    )
    const lock = await loadLock(lockPath)
    const result = await importLocal(specs, lock, lockPath, { source: "mcp", note: "from the MCP", objectId: "obj-1" })
    expect(result.imported.map((i) => i.key)).toEqual(["s/rock"])

    const saved = await loadLock(lockPath)
    const entry = saved.entries["s/rock"]!
    expect(entry.specHash).toBe(specs[0]!.specHash)
    expect(entry.objectId).toBe("obj-1")
    expect(entry.cost).toBe(0)
    expect(entry.imported).toMatchObject({ source: "mcp", note: "from the MCP" })
    const plan = await buildPlan(specs, saved)
    expect(plan.items.map((i) => i.state)).toEqual(["ok"])
  })

  it("writes nothing on a dry run", async () => {
    const { specs, lockPath } = await project({ rock: { prompt: "rock" } }, { "rock.png": png(10) })
    const result = await importLocal(specs, await loadLock(lockPath), lockPath, { dryRun: true })
    expect(result.imported).toHaveLength(1)
    expect((await loadLock(lockPath)).entries).toEqual({})
  })

  it("skips a missing file and an existing entry unless forced, and refuses --object-id for several assets", async () => {
    const { specs, lockPath } = await project(
      { rock: { prompt: "rock" }, gone: { prompt: "gone" } },
      { "rock.png": png(10) },
    )
    const lock = await loadLock(lockPath)
    await expect(importLocal(specs, lock, lockPath, { objectId: "x" })).rejects.toThrow(/names one object/)

    const first = await importLocal(specs, lock, lockPath, {})
    expect(first.skipped.map((s) => s.key)).toEqual(["s/gone"])
    const again = await importLocal(specs, lock, lockPath, {})
    expect(again.skipped.find((s) => s.key === "s/rock")?.reason).toMatch(/already in the lockfile/)
    const forced = await importLocal(specs, lock, lockPath, { force: true })
    expect(forced.imported.map((i) => i.key)).toEqual(["s/rock"])
  })
})

describe("reportSpecHashes", () => {
  it("prints the same entry adopt --local would write, without touching the lockfile", async () => {
    const { specs, lockPath } = await project({ rock: { prompt: "rock" } }, { "rock.png": png(10) })
    const lock = await loadLock(lockPath)
    const [report] = await reportSpecHashes(specs, lock)
    expect(report!.specHash).toBe(specs[0]!.specHash)
    expect(report!.lock).toBeNull()
    expect(report!.wouldImport?.outputs?.[0]?.sha256).toBe(report!.fileSha256)
    await expect(readFile(lockPath)).rejects.toThrow()
  })
})

describe("manifest diagnostics", () => {
  it("names the asset, style and size when a provider rejects a size", async () => {
    await expect(project({ rockfall_pile_iso: { prompt: "rocks", width: 38, height: 24 } })).rejects.toThrow(
      /assets\.rockfall_pile_iso \(style "s", 38x24\).*multiples of 4/,
    )
  })

  it("lists each schema error once, names the entries, and points at a newer release for unknown fields", async () => {
    await mkdir(dir, { recursive: true })
    await writeFile(
      path.join(dir, "bad.json"),
      JSON.stringify({
        name: "t",
        styles: { s: { generator: "future-generator", outDir: "out" } },
        assets: { a: { prompt: "x", futureKey: {} } },
      }),
    )
    const error = await loadManifest(path.join(dir, "bad.json")).catch((e: Error) => e)
    const lines = (error as Error).message.split("\n")
    expect(lines.length).toBe(new Set(lines).size)
    expect((error as Error).message).toMatch(/does not know/)
    expect((error as Error).message).toMatch(/invalid entries: styles\.s, assets\.a/)
  })
})
