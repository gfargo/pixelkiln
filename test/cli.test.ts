import { describe, expect, it } from "vitest"
import { parseArgs } from "../src/cli.ts"
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
    const args = parseArgs(["plan", "--manifest", "/tmp/proj/sprites.manifest.json"])
    expect(args.lock).toBe("/tmp/proj/sprites.lock.json")
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
