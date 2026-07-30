import { describe, expect, it } from "vitest"
import { mkdtemp, writeFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { parseArgs } from "../src/cli.ts"
import { loadEnvFiles } from "../src/env.ts"
import { shouldRetry, backoffMs, MAX_RETRIES } from "../src/client.ts"
import { renderSheet } from "../src/pick/sheet.ts"

describe("parseArgs", () => {
  it("parses filters and flags", () => {
    const args = parseArgs(["gen", "--style", "neon", "--only", "a,b", "--budget", "500", "--yes"])
    expect(args.command).toBe("gen")
    expect(args.styles).toEqual(["neon"])
    expect(args.assets).toEqual(["a", "b"])
    expect(args.budget).toBe(500)
    expect(args.yes).toBe(true)
  })

  // The expensive typo: a silently-ignored filter generates the whole manifest.
  it("rejects an unknown flag rather than ignoring it", () => {
    expect(() => parseArgs(["gen", "--styles", "neon"])).toThrow(/Unknown flag/)
  })

  // The other half of that failure: a flag that IS known, repeated, with all
  // but one occurrence dropped. `gen --style a --style b` covered only `a`
  // while `plan` quoted the cost of both.
  it("accumulates a repeated list flag instead of keeping one", () => {
    const args = parseArgs(["gen", "--style", "a", "--style", "b", "--only", "x", "--only", "y,z"])
    expect(args.styles).toEqual(["a", "b"])
    expect(args.assets).toEqual(["x", "y", "z"])
  })

  it("dedupes a repeated list value", () => {
    expect(parseArgs(["gen", "--style", "a,b", "--style", "b"]).styles).toEqual(["a", "b"])
  })

  it("rejects an unknown command", () => {
    expect(() => parseArgs(["genn"])).toThrow(/Unknown command/)
  })

  it("rejects a value flag with no value", () => {
    expect(() => parseArgs(["gen", "--style"])).toThrow(/needs a value/)
    expect(() => parseArgs(["gen", "--style", "--force"])).toThrow(/needs a value/)
  })

  // NaN compares false against every cost, which would disable the cap silently.
  it("rejects a non-numeric budget", () => {
    expect(() => parseArgs(["gen", "--budget", "lots"])).toThrow(/non-negative number/)
    expect(() => parseArgs(["gen", "--budget", "-5"])).toThrow(/non-negative number/)
  })

  it("accepts a zero budget as a real cap", () => {
    expect(parseArgs(["gen", "--budget", "0"]).budget).toBe(0)
  })

  it("defaults the lockfile to sit beside the manifest", () => {
    const args = parseArgs(["plan", "--manifest", "/tmp/proj/pixelkiln.manifest.json"])
    expect(args.lock).toBe("/tmp/proj/pixelkiln.lock.json")
  })

  it("does not treat a command named like a flag value as a flag", () => {
    expect(parseArgs(["status"]).command).toBe("status")
  })
})

describe("retry policy", () => {
  it("retries throttling and server faults only", () => {
    expect(shouldRetry(429)).toBe(true)
    expect(shouldRetry(500)).toBe(true)
    expect(shouldRetry(503)).toBe(true)
    expect(shouldRetry(408)).toBe(true)
  })

  it("does not retry client errors that will never succeed", () => {
    expect(shouldRetry(400)).toBe(false)
    expect(shouldRetry(401)).toBe(false)
    expect(shouldRetry(404)).toBe(false)
    expect(shouldRetry(422)).toBe(false)
  })

  it("backs off exponentially and caps", () => {
    expect(backoffMs(0)).toBeLessThan(backoffMs(3))
    expect(backoffMs(MAX_RETRIES + 5)).toBeLessThanOrEqual(16_400)
  })
})

describe("contact sheet", () => {
  const group = {
    key: "s/a",
    assetId: "alpha",
    styleId: "s",
    prompt: "an anvil",
    reviewObjectId: "obj-1",
    frameUrls: ["https://example.test/0.png", "https://example.test/1.png"],
    size: 64,
  }

  it("renders one selectable candidate per frame", () => {
    const html = renderSheet([group])
    expect(html).toContain("alpha")
    expect(html.match(/class="cand"/g) ?? []).toHaveLength(0) // built client-side
    expect(html).toContain("https://example.test/0.png")
  })

  // The prompt is arbitrary author text and reaches both innerHTML and a <script>.
  it("escapes HTML in prompts", () => {
    const html = renderSheet([{ ...group, prompt: '<img src=x onerror="alert(1)">' }])
    expect(html).not.toContain("<img src=x")
    expect(html).toContain("&lt;img")
  })

  it("prevents a prompt from closing the script tag", () => {
    const html = renderSheet([{ ...group, prompt: "</script><script>alert(1)</script>" }])
    const scriptOpens = html.match(/<script>/g) ?? []
    // Only the page's own single script block survives.
    expect(scriptOpens).toHaveLength(1)
  })
})

describe("env file loading", () => {
  // Regression: the missing-key error told people to put PIXELLAB_API_KEY in a
  // .env file next to the manifest, but nothing ever read one — so following
  // the instruction correctly still failed.
  it("reads .env.local and .env from a directory", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "pixelkiln-env-"))
    await writeFile(path.join(dir, ".env"), "PK_TEST_A=from_env\nPK_TEST_B=b\n")
    await writeFile(path.join(dir, ".env.local"), "PK_TEST_A=from_env_local\n")
    delete process.env.PK_TEST_A
    delete process.env.PK_TEST_B

    const loaded = loadEnvFiles(dir)
    expect(loaded).toHaveLength(2)
    // .env.local is read first and .env cannot clobber it.
    expect(process.env.PK_TEST_A).toBe("from_env_local")
    expect(process.env.PK_TEST_B).toBe("b")
    await rm(dir, { recursive: true, force: true })
  })

  // A CI secret must never be overridden by a checked-out file.
  it("never overrides an existing environment variable", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "pixelkiln-env-"))
    await writeFile(path.join(dir, ".env"), "PK_TEST_C=from_file\n")
    process.env.PK_TEST_C = "from_shell"
    loadEnvFiles(dir)
    expect(process.env.PK_TEST_C).toBe("from_shell")
    delete process.env.PK_TEST_C
    await rm(dir, { recursive: true, force: true })
  })

  it("handles quotes, exports, comments and blank lines", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "pixelkiln-env-"))
    await writeFile(
      path.join(dir, ".env"),
      '# a comment\n\nexport PK_TEST_D="quoted value"\nPK_TEST_E=\'single\'\nnot a pair\n',
    )
    delete process.env.PK_TEST_D
    delete process.env.PK_TEST_E
    loadEnvFiles(dir)
    expect(process.env.PK_TEST_D).toBe("quoted value")
    expect(process.env.PK_TEST_E).toBe("single")
    delete process.env.PK_TEST_D
    delete process.env.PK_TEST_E
    await rm(dir, { recursive: true, force: true })
  })

  it("returns nothing when no env file exists", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "pixelkiln-env-"))
    expect(loadEnvFiles(dir)).toEqual([])
    await rm(dir, { recursive: true, force: true })
  })
})
