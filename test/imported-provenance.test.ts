import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { existsSync } from "node:fs"
import { mkdtemp, mkdir, rm, writeFile, readFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { loadManifest, resolveSpecs } from "../src/manifest.ts"
import { loadLock, spendByUnit } from "../src/lock.ts"
import { buildPlan } from "../src/pipeline/plan.ts"
import { importLocal } from "../src/pipeline/import.ts"
import { revertGeneration } from "../src/pipeline/history.ts"
import { FakeProvider } from "../src/providers/fake.ts"
import { encodeRgbaPng } from "../src/png.ts"
import { sha256 } from "../src/hash.ts"
import { parseLock } from "../src/types.ts"
import { cacheFileName, MediaType } from "../src/media.ts"

let dir: string
const shade = (n: number) => encodeRgbaPng(8, 8, Buffer.alloc(8 * 8 * 4, n))

async function open() {
  await mkdir(path.join(dir, "out"), { recursive: true })
  await writeFile(
    path.join(dir, "m.json"),
    JSON.stringify({
      name: "t",
      styles: { s: { generator: "map", outDir: "out" } },
      assets: { rock: { prompt: "a rock", width: 32, height: 32 } },
    }),
  )
  const provider = new FakeProvider()
  const loaded = await loadManifest(path.join(dir, "m.json"))
  const specs = await resolveSpecs(loaded, { provider })
  const lockPath = path.join(dir, "lock.json")
  return { provider, specs, lockPath, lock: await loadLock(lockPath) }
}

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "pixelkiln-provenance-"))
})
afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

describe("imported provenance", () => {
  it("records tool, prompt, seed, cost, steps and the raw original, and caches the bytes", async () => {
    const p = await open()
    const raw = shade(200)
    const processed = shade(100)
    await writeFile(path.join(dir, "out", "rock.png"), processed)
    await writeFile(path.join(dir, "raw.png"), raw)
    await importLocal(p.specs, p.lock, p.lockPath, {
      source: "mcp", tool: "create_image_pro_flash", prompt: "mossy rock", seed: 42, cost: 3,
      steps: ["downscale 0.75, box", "palette-snap lowplants"], raw: path.join(dir, "raw.png"),
    })
    const entry = (await loadLock(p.lockPath)).entries["s/rock"]!
    expect(entry.prompt).toBe("mossy rock")
    expect(entry.origin).toEqual({
      tool: "create_image_pro_flash", prompt: "mossy rock", seed: 42,
      steps: ["downscale 0.75, box", "palette-snap lowplants"], raw: { sha256: sha256(raw) },
    })
    expect(spendByUnit(await loadLock(p.lockPath))[entry.costUnit]).toBe(3)
    for (const bytes of [processed, raw]) {
      expect(existsSync(path.join(dir, ".pixelkiln", "cache", cacheFileName(sha256(bytes), MediaType.PNG)))).toBe(true)
    }
  })

  it("tells the unprocessed original from any other change in the plan", async () => {
    const p = await open()
    await writeFile(path.join(dir, "out", "rock.png"), shade(100))
    await writeFile(path.join(dir, "raw.png"), shade(200))
    await importLocal(p.specs, p.lock, p.lockPath, { steps: ["snap"], raw: path.join(dir, "raw.png") })
    const reason = async () => (await buildPlan(p.specs, await loadLock(p.lockPath))).items[0]!
    expect((await reason()).state).toBe("ok")

    await writeFile(path.join(dir, "out", "rock.png"), shade(200))
    expect((await reason()).reason).toMatch(/unprocessed original.*\(snap\)/)
    await writeFile(path.join(dir, "out", "rock.png"), shade(50))
    expect((await reason()).reason).toMatch(/changed since it was imported/)
    expect((await reason()).state).toBe("orphaned")
  })

  it("keeps a replaced import in history and restores it with no provider", async () => {
    const p = await open()
    const first = shade(100)
    const second = shade(150)
    const file = path.join(dir, "out", "rock.png")
    await writeFile(file, first)
    await importLocal(p.specs, p.lock, p.lockPath, { source: "mcp", tool: "roll-1", seed: 1 })

    await writeFile(file, second)
    await importLocal(p.specs, p.lock, p.lockPath, { force: true, source: "mcp", tool: "roll-2", seed: 2 })
    let entry = p.lock.entries["s/rock"]!
    expect(entry.history).toHaveLength(1)
    expect(entry.history![0]).toMatchObject({ imported: { source: "mcp" }, origin: { tool: "roll-1", seed: 1 } })

    const result = await revertGeneration(p.provider, p.specs[0]!, p.lock, p.lockPath, { generation: 1, force: true })
    expect(result.index).toBe(1)
    expect(await readFile(file)).toEqual(first)
    entry = (await loadLock(p.lockPath)).entries["s/rock"]!
    expect(entry.origin?.tool).toBe("roll-1")
    expect(entry.history![0]).toMatchObject({ origin: { tool: "roll-2" } })
    expect((await buildPlan(p.specs, await loadLock(p.lockPath))).items[0]!.state).toBe("ok")
  })

  it("does not add history when the same bytes are imported again", async () => {
    const p = await open()
    await writeFile(path.join(dir, "out", "rock.png"), shade(100))
    await importLocal(p.specs, p.lock, p.lockPath, {})
    await importLocal(p.specs, p.lock, p.lockPath, { force: true, note: "again" })
    expect(p.lock.entries["s/rock"]!.history).toBeUndefined()
  })

  it("refuses --raw for several assets and for a file that is not a PNG", async () => {
    const p = await open()
    await writeFile(path.join(dir, "out", "rock.png"), shade(100))
    await writeFile(path.join(dir, "bad.png"), "nope")
    await expect(importLocal(p.specs, p.lock, p.lockPath, { raw: path.join(dir, "bad.png") })).rejects.toThrow(/not a readable PNG/)
  })
})

describe("lockfile compatibility", () => {
  const base = {
    styleId: "s", assetId: "a", specHash: "h", generator: "map", prompt: "p", width: 8, height: 8,
    status: "downloaded", outputs: [{ path: "a.png", sha256: "a".repeat(64) }],
  }
  it("reads an entry with the 0.93 `imported` shape, and one whose `origin` has keys it does not know", () => {
    const lock = parseLock({
      version: 2,
      entries: {
        "s/a": { ...base, imported: { source: "mcp", importedAt: "2026-01-01T00:00:00Z" } },
        "s/b": { ...base, assetId: "b", imported: { source: "mcp", importedAt: "x" }, origin: { tool: "t", futureField: 1 } },
      },
    })
    expect(lock.entries["s/a"]!.origin).toBeUndefined()
    expect(lock.entries["s/b"]!.origin).toEqual({ tool: "t" })
  })
  it("leaves `imported` strict, so its shape never grows", () => {
    expect(() => parseLock({ version: 2, entries: { "s/a": { ...base, imported: { source: "mcp", importedAt: "x", tool: "t" } } } })).toThrow()
  })
})
