import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { execFile } from "node:child_process"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { promisify } from "node:util"
import {
  BudgetError,
  EXIT_CODES,
  errorCode,
  exitCodeFor,
  OverwriteRefusedError,
  PixelKilnError,
  ProjectError,
  ProviderError,
  UsageError,
} from "../src/errors.ts"
import { PixelLabError } from "../src/client.ts"
import { UnsupportedCapabilityError } from "../src/provider.ts"
import { parseArgs } from "../src/cli/args.ts"
import { loadManifest } from "../src/manifest.ts"
import { loadLock } from "../src/lock.ts"

const execFileAsync = promisify(execFile)
const tsx = path.resolve("node_modules/.bin/tsx")
const cli = path.resolve("src/cli.ts")

describe("error taxonomy", () => {
  it("gives every kind a distinct exit code and leaves 1 for untyped errors", () => {
    expect(new Set(Object.values(EXIT_CODES)).size).toBe(Object.keys(EXIT_CODES).length)
    expect(Object.values(EXIT_CODES)).not.toContain(1)
    expect(exitCodeFor(new Error("plain"))).toBe(1)
    expect(exitCodeFor("a string")).toBe(1)
    expect(errorCode(new Error("plain"))).toBeUndefined()
  })

  it("classes carry their code, name, and extras", () => {
    const usage = new UsageError("bad flag")
    expect(usage).toBeInstanceOf(PixelKilnError)
    expect(usage.code).toBe("usage")
    expect(usage.name).toBe("UsageError")
    expect(exitCodeFor(usage)).toBe(2)

    expect(exitCodeFor(new ProjectError("no manifest"))).toBe(3)

    const provider = new ProviderError("scenario", "429", { status: 429 })
    expect(provider.provider).toBe("scenario")
    expect(provider.status).toBe(429)
    expect(exitCodeFor(provider)).toBe(4)

    const refused = new OverwriteRefusedError("changed", ["/a.png"])
    expect(refused.files).toEqual(["/a.png"])
    expect(exitCodeFor(refused)).toBe(5)

    expect(exitCodeFor(new BudgetError("over"))).toBe(6)
    expect(exitCodeFor(new UnsupportedCapabilityError("fake", "listing"))).toBe(7)

    const cause = new Error("inner")
    expect(new ProjectError("outer", { cause }).cause).toBe(cause)
    expect(new ProjectError("outer", { hint: "do this" }).hint).toBe("do this")
  })

  it("keeps the PixelLab client error a provider error with its status", () => {
    const err = new PixelLabError("POST /x → 503", 503, "body")
    expect(err).toBeInstanceOf(ProviderError)
    expect(err.provider).toBe("pixellab")
    expect(err.status).toBe(503)
    expect(err.body).toBe("body")
    expect(err.name).toBe("PixelLabError")
    expect(err.code).toBe("provider")
  })
})

describe("where the kinds are thrown", () => {
  let dir: string
  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "pixelkiln-errors-"))
  })
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it("parse failures are usage errors", () => {
    expect(() => parseArgs(["nope"])).toThrow(UsageError)
    expect(() => parseArgs(["plan", "--styles", "neon"])).toThrow(UsageError)
    expect(() => parseArgs(["gen", "--budget", "-5"])).toThrow(UsageError)
    expect(() => parseArgs(["quality"])).toThrow(UsageError)
  })

  it("a missing or invalid manifest and a malformed lockfile are project errors", async () => {
    await expect(loadManifest(path.join(dir, "missing.json"))).rejects.toBeInstanceOf(ProjectError)
    const bad = path.join(dir, "pixelkiln.manifest.json")
    await writeFile(bad, JSON.stringify({ name: "x", styles: {}, assets: {}, extra: 1 }))
    await expect(loadManifest(bad)).rejects.toBeInstanceOf(ProjectError)
    const lock = path.join(dir, "pixelkiln.lock.json")
    await writeFile(lock, "{ not json")
    await expect(loadLock(lock)).rejects.toBeInstanceOf(ProjectError)
  })

  it("the CLI exits with the kind's code and prints the message", async () => {
    const usage = await execFileAsync(tsx, [cli, "plan", "--styles", "neon"], { cwd: dir }).catch((e) => e)
    expect(usage.code).toBe(EXIT_CODES.usage)
    expect(usage.stderr).toContain('error: Unknown flag "--styles"')

    const project = await execFileAsync(tsx, [cli, "plan"], { cwd: dir }).catch((e) => e)
    expect(project.code).toBe(EXIT_CODES.project)
    expect(project.stderr).toContain("error: No manifest at")
  }, 30_000)
})
