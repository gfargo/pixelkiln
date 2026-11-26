import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"
import { existsSync } from "node:fs"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { FakeProvider } from "../src/providers/fake.ts"
import { registerProvider } from "../src/providers/registry.ts"
import { parseArgs } from "../src/cli/args.ts"
import { runAdopt } from "../src/cli/commands/account.ts"
import type { RemoteCharacterDetail } from "../src/provider.ts"

// Online `adopt --dry-run` used to write character files and the lockfile (#407).

let dir: string
let provider: FakeProvider
beforeAll(() => {
  registerProvider({ id: "fake", create: () => provider })
})
beforeEach(async () => {
  provider = new FakeProvider({ candidates: 1 })
  dir = await mkdtemp(path.join(tmpdir(), "pixelkiln-adopt-dry-"))
})
afterEach(async () => {
  vi.restoreAllMocks()
  await rm(dir, { recursive: true, force: true })
})

const DIRS = ["south", "east", "north", "west"]

function character(id: string): RemoteCharacterDetail {
  return {
    id, name: "hero", stateName: "Idle", prompt: "a hero", groupId: "grp", directions: 4,
    width: 64, height: 64, createdAt: "2026-09-01T00:00:00.000Z", previewUrl: `fake://${id}/south.png`,
    tags: [], status: "completed", animationCount: 0,
    rotations: DIRS.map((d) => ({ url: `fake://${id}/${d}.png`, role: d })), animations: [],
  }
}

async function setup() {
  provider.characters.set("char-1", character("char-1"))
  const seeded = provider.seed({ id: "obj-1", prompt: "an anvil upstream" })
  const manifest = path.join(dir, "pixelkiln.manifest.json")
  await writeFile(manifest, JSON.stringify({
    name: "adopt-dry",
    provider: "fake",
    styles: {
      cast: { generator: "character", outDir: "art", size: 64, directions: 4 },
      props: { outDir: "props", size: 32 },
    },
    assets: {
      hero: { prompt: "a hero", styles: ["cast"], remoteId: "char-1" },
      anvil: { prompt: "an anvil", styles: ["props"] },
    },
  }))
  await mkdir(path.join(dir, "props"), { recursive: true })
  await writeFile(path.join(dir, "props", "anvil.png"), await provider.download(seeded.previewUrl!))
  return manifest
}

const lockPath = () => path.join(dir, "pixelkiln.lock.json")

describe("adopt --dry-run (online)", () => {
  it("matches objects and characters but writes nothing to outDir and leaves the lockfile alone", async () => {
    const manifest = await setup()
    const before = JSON.stringify({ version: 2, entries: {} }, null, 2) + "\n"
    await writeFile(lockPath(), before)
    const lines: string[] = []
    vi.spyOn(console, "log").mockImplementation((msg = "") => { lines.push(String(msg)) })
    await runAdopt(parseArgs(["adopt", "--manifest", manifest, "--dry-run"]))

    expect(await readFile(lockPath(), "utf8")).toBe(before)
    expect(existsSync(path.join(dir, "art"))).toBe(false)
    const out = lines.join("\n")
    expect(out).toContain("would adopt props/anvil")
    expect(out).toContain("would adopt cast/hero")
    expect(out).toContain("would write 4 file(s)")
    expect(out).toMatch(/hero-south\.png/)
    expect(out).not.toContain("lockfile written")
  })

  it("with --json prints the report on stdout and still writes nothing", async () => {
    const manifest = await setup()
    const stdout: string[] = []
    vi.spyOn(console, "log").mockImplementation((msg = "") => { stdout.push(String(msg)) })
    vi.spyOn(console, "error").mockImplementation(() => {})
    await runAdopt(parseArgs(["adopt", "--manifest", manifest, "--dry-run", "--json"]))

    expect(existsSync(lockPath())).toBe(false)
    expect(existsSync(path.join(dir, "art"))).toBe(false)
    expect(stdout).toHaveLength(1)
    const report = JSON.parse(stdout[0]!)
    expect(report).toMatchObject({ dryRun: true, objects: { matched: 1 }, characters: { matched: 1, remaining: [] } })
    expect(report.characters.wouldWrite).toHaveLength(4)
  })

  it("without --dry-run still writes the files and the lockfile", async () => {
    const manifest = await setup()
    vi.spyOn(console, "log").mockImplementation(() => {})
    await runAdopt(parseArgs(["adopt", "--manifest", manifest]))
    const lock = JSON.parse(await readFile(lockPath(), "utf8"))
    expect(Object.keys(lock.entries).sort()).toEqual(["cast/hero", "props/anvil"])
    expect(existsSync(path.join(dir, "art", "hero-south.png"))).toBe(true)
  })
})
