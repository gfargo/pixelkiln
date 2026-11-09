import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { loadManifest } from "../src/manifest.ts"
import { openProject } from "../src/project.ts"
import { doctor } from "../src/pipeline/doctor.ts"
import { checkInstall, readInstallFacts } from "../src/pipeline/install-check.ts"
import { selectInvalid } from "../src/cli/io.ts"

let dir: string

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "pixelkiln-lenient-"))
})
afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

async function write(manifest: unknown): Promise<string> {
  const file = path.join(dir, "pixelkiln.manifest.json")
  await writeFile(file, JSON.stringify(manifest))
  return file
}

const messy = {
  name: "t",
  styles: {
    s: { generator: "imageProFlash", outDir: "out" },
    future: { generator: "not-yet", outDir: "out" },
  },
  assets: {
    good: { prompt: "ok", width: 32, height: 32 },
    badkey: { prompt: "y", unknownThing: {} },
    badsize: { prompt: "x", width: 38, height: 24 },
    in_future: { prompt: "z", styles: ["future"] },
    child: { prompt: "c", revision: { from: "badkey", mode: "image-to-image" } },
  },
}

describe("lenient manifest loading", () => {
  it("sets aside invalid entries and what depends on them, and loads the rest", async () => {
    const loaded = await loadManifest(await write(messy), { lenient: true })
    expect(Object.keys(loaded.manifest.assets)).toEqual(["good", "badsize"])
    expect(loaded.invalid?.map((e) => `${e.kind}:${e.id}`).sort()).toEqual([
      "asset:badkey",
      "asset:child",
      "asset:in_future",
      "style:future",
    ])
    expect(loaded.invalid?.find((e) => e.id === "badkey")?.issues[0]).toMatch(/assets\.badkey.*Unrecognized/)
  })

  it("rejects the same manifest by default", async () => {
    await expect(loadManifest(await write(messy))).rejects.toThrow(/is invalid/)
  })

  it("still fails on a problem in the manifest's own fields", async () => {
    const { name: _name, ...noName } = messy
    await expect(loadManifest(await write(noName), { lenient: true })).rejects.toThrow(/name: Required/)
  })

  it("openProject skips an asset a provider rejects and reports it", async () => {
    const project = await openProject(await write(messy), { lenient: true, env: false })
    expect(project.specs.map((s) => s.assetId)).toEqual(["good"])
    const bad = project.loaded.invalid?.find((e) => e.id === "badsize")
    expect(bad?.issues[0]).toMatch(/assets\.badsize.*multiples of 4/)
    await expect(openProject(await write(messy), { env: false })).rejects.toThrow()
  })

  it("selectInvalid hides entries outside an --only/--style selection", () => {
    const invalid = [
      { kind: "asset" as const, id: "a", issues: ["x"] },
      { kind: "asset" as const, id: "b", issues: ["x"] },
      { kind: "style" as const, id: "s", issues: ["x"] },
    ]
    expect(selectInvalid(invalid, { assets: [], styles: [] })).toEqual({ shown: invalid, hidden: 0 })
    expect(selectInvalid(invalid, { assets: ["a"], styles: [] })).toEqual({ shown: [invalid[0]], hidden: 2 })
  })

  it("doctor reports each invalid entry as an error", async () => {
    const project = await openProject(await write(messy), { lenient: true, env: false })
    const report = await doctor(project.loaded, project.specs, project.lock, project.lockPath, { offline: true })
    const errors = report.checks.filter((c) => c.id === "invalid-entry")
    expect(errors).toHaveLength(5)
    expect(report.ok).toBe(false)
  })
})

describe("install check", () => {
  async function install(pin: string, installed?: string) {
    await writeFile(path.join(dir, "package.json"), JSON.stringify({ devDependencies: { pixelkiln: pin } }))
    if (installed) {
      await mkdir(path.join(dir, "node_modules", "pixelkiln"), { recursive: true })
      await writeFile(path.join(dir, "node_modules", "pixelkiln", "package.json"), JSON.stringify({ version: installed }))
    }
  }

  it("warns when node_modules differs from an exact pin, and when another install is running", async () => {
    await install("0.88.0", "0.86.3")
    const facts = readInstallFacts(dir, "0.48.0")!
    const messages = checkInstall(facts).map((f) => f.message)
    expect(messages[0]).toMatch(/asks for pixelkiln 0\.88\.0 but node_modules has 0\.86\.3/)
    expect(messages[1]).toMatch(/running pixelkiln 0\.48\.0, but this project's node_modules has 0\.86\.3/)
  })

  it("is quiet when pin, install and running version agree, and for a range the install satisfies", async () => {
    await install("0.88.0", "0.88.0")
    expect(checkInstall(readInstallFacts(dir, "0.88.0")!)).toEqual([expect.objectContaining({ level: "ok" })])
    await install("^0.88.0", "0.92.3")
    expect(checkInstall(readInstallFacts(dir, "0.92.3")!).every((f) => f.level === "ok")).toBe(true)
  })

  it("warns when the pinned package is not installed, and finds nothing without a pin", async () => {
    await install("0.88.0")
    expect(checkInstall(readInstallFacts(dir, "0.88.0")!)[0]!.message).toMatch(/not installed/)
    await rm(path.join(dir, "package.json"))
    expect(readInstallFacts(dir, "0.88.0")).toBeNull()
  })

  it("doctor includes the install check when the project pins pixelkiln", async () => {
    await install("0.88.0", "0.86.3")
    const project = await openProject(await write({ name: "t", styles: { s: { generator: "map", outDir: "out" } }, assets: { a: { prompt: "a" } } }), { env: false })
    const report = await doctor(project.loaded, project.specs, project.lock, project.lockPath, { offline: true, runningVersion: "0.86.3" })
    expect(report.checks.find((c) => c.id === "install")?.level).toBe("warning")
  })
})
