import { afterEach, describe, expect, it, vi } from "vitest"
import { mkdtemp, writeFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { parseArgs } from "../src/cli.ts"
import { loadEnvFiles } from "../src/env.ts"
import { PixelLabClient, shouldRetry, backoffMs, retryAfterMs, MAX_RETRIES } from "../src/client.ts"
import { renderSheet } from "../src/pick/sheet.ts"

describe("parseArgs", () => {
  it("parses pack's --inputs/--out/--columns", () => {
    const args = parseArgs(["pack", "--inputs", "sprites.json", "--out", "dist/sheet", "--columns", "8"])
    expect(args.command).toBe("pack")
    expect(args.inputs).toBe("sprites.json")
    expect(args.out).toBe("dist/sheet")
    expect(args.columns).toBe(8)
  })

  it("accepts prune and rejects the filters that would make it overreach", () => {
    expect(parseArgs(["prune", "--dry-run"])).toMatchObject({ command: "prune", dryRun: true })
    expect(parseArgs(["prune", "--yes"])).toMatchObject({ command: "prune", yes: true })
    // parseArgs still accepts the flags; prune itself refuses them at run time,
    // because comparing a filtered manifest against the whole lockfile would
    // make every excluded entry look undeclared and delete it.
    expect(parseArgs(["prune", "--style", "base"]).styles).toEqual(["base"])
  })

  it("parses and validates engine export formats", () => {
    expect(parseArgs(["export", "--format", "tiled", "--out", "dist/terrain"]))
      .toMatchObject({ command: "export", format: "tiled", out: "dist/terrain" })
    expect(() => parseArgs(["export", "--format", "unity"])).toThrow(/generic, tiled, or godot/)
  })

  it("parses audit CI thresholds and pack output selectors", () => {
    expect(parseArgs([
      "audit", "--json", "--check", "--max-distance", "25.5",
      "--min-transparency", "0.2", "--max-colors", "64", "--sigma", "2",
    ])).toMatchObject({
      json: true,
      check: true,
      maxDistance: 25.5,
      minTransparency: 0.2,
      maxColors: 64,
      sigma: 2,
    })
    expect(parseArgs(["pack", "--output-role", "tile-00,tile-03"]).outputRoles)
      .toEqual(["tile-00", "tile-03"])
    expect(() => parseArgs(["audit", "--min-transparency", "2"])).toThrow(/0 to 1/)
    expect(() => parseArgs(["audit", "--max-colors", "2.5"])).toThrow(/whole number/)
  })

  it("parses refinement, approval, and fail-closed check commands", () => {
    expect(parseArgs([
      "refine", "--from", "source.png", "--out", "final.png",
      "--palette", "#101820,#f2aa4c", "--palette", "#ffffff",
      "--fixer-python", "/opt/pixelfixer/bin/python", "--fixer-revision", "abc123",
      "--min-grid-confidence", "medium", "--min-transparency", "0.2",
    ])).toMatchObject({
      command: "refine",
      subcommand: "run",
      from: "source.png",
      out: "final.png",
      palette: ["#101820", "#f2aa4c", "#ffffff"],
      fixerPython: "/opt/pixelfixer/bin/python",
      fixerRevision: "abc123",
      minGridConfidence: "medium",
      minTransparency: 0.2,
    })
    expect(parseArgs([
      "refine", "approve", "--from", "final.pixelkiln.json",
      "--reviewer", "Ada", "--note", "Looks clean", "--yes",
    ])).toMatchObject({
      subcommand: "approve",
      reviewer: "Ada",
      note: "Looks clean",
      yes: true,
    })
    expect(parseArgs(["refine", "check", "--from", "final.pixelkiln.json", "--json"]))
      .toMatchObject({ subcommand: "check", json: true })
    expect(() => parseArgs(["refine", "checkk"])).toThrow(/Unknown refine subcommand/)
    expect(() => parseArgs(["refine", "--min-grid-confidence", "certain"]))
      .toThrow(/low, medium, or high/)
  })

  it("parses cache integrity and pruning controls", () => {
    expect(parseArgs(["cache", "--check", "--prune", "--json"])).toMatchObject({
      command: "cache",
      check: true,
      prune: true,
      json: true,
    })
  })

  it("parses filters and flags", () => {
    const args = parseArgs(["gen", "--style", "neon", "--only", "a,b", "--budget", "500", "--yes"])
    expect(args.command).toBe("gen")
    expect(args.styles).toEqual(["neon"])
    expect(args.assets).toEqual(["a", "b"])
    expect(args.budget).toBe(500)
    expect(args.yes).toBe(true)
  })

  it("parses salvage's --all and --json", () => {
    const args = parseArgs(["salvage", "--dry-run", "--all", "--json"])
    expect(args.dryRun).toBe(true)
    expect(args.all).toBe(true)
    expect(args.json).toBe(true)
  })

  it("parses restore and plan check mode", () => {
    expect(parseArgs(["restore"]).command).toBe("restore")
    expect(parseArgs(["plan", "--check", "--json"])).toMatchObject({ check: true, json: true })
  })

  it("defaults --all and --json to false", () => {
    const args = parseArgs(["salvage", "--dry-run"])
    expect(args.all).toBe(false)
    expect(args.json).toBe(false)
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

  it("rejects an unexpected positional argument instead of silently ignoring it", () => {
    expect(() => parseArgs(["gen", "neon"])).toThrow(/Unexpected argument/)
  })

  it("parses and validates the local review-server port", () => {
    expect(parseArgs(["pick", "--port", "43123"]).port).toBe(43123)
    expect(() => parseArgs(["pick", "--port", "70000"])).toThrow(/65535/)
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

  it("parses workspace subcommands and their positionals", () => {
    expect(parseArgs(["workspace", "add", "../other/pixelkiln.manifest.json"])).toMatchObject({
      command: "workspace",
      subcommand: "add",
      target: "../other/pixelkiln.manifest.json",
    })
    expect(parseArgs(["workspace", "remove", "other-project"])).toMatchObject({
      command: "workspace",
      subcommand: "remove",
      target: "other-project",
    })
    expect(parseArgs(["workspace", "list", "--json"])).toMatchObject({
      command: "workspace", subcommand: "list", json: true,
    })
    expect(parseArgs(["workspace", "status", "--check"])).toMatchObject({
      command: "workspace", subcommand: "status", check: true,
    })
    expect(parseArgs(["workspace", "claims", "--workspace", "shared.workspace.json"])).toMatchObject({
      command: "workspace", subcommand: "claims", workspace: "shared.workspace.json",
    })
  })

  it("parses offline recipe operations and model verification", () => {
    expect(parseArgs(["recipe", "list", "--json"])).toMatchObject({
      command: "recipe", subcommand: "list", json: true,
    })
    expect(parseArgs([
      "recipe", "install", "comfyui/pixel-art-xl-environment@1.0.0",
      "--out", "recipes/environment",
    ])).toMatchObject({
      subcommand: "install",
      target: "comfyui/pixel-art-xl-environment@1.0.0",
      out: "recipes/environment",
    })
    expect(parseArgs([
      "recipe", "verify", "recipes/environment", "--model-root", "/opt/ComfyUI/models",
    ])).toMatchObject({
      subcommand: "verify",
      target: "recipes/environment",
      modelRoot: "/opt/ComfyUI/models",
    })
    expect(() => parseArgs(["recipe"])).toThrow(/needs a subcommand/)
    expect(() => parseArgs(["recipe", "remove", "x"])).toThrow(/Unknown recipe subcommand/)
    expect(() => parseArgs(["recipe", "verify"])).toThrow(/needs a recipe id/)
  })

  it("rejects an unknown workspace subcommand", () => {
    expect(() => parseArgs(["workspace", "delete", "x"])).toThrow(/Unknown workspace subcommand/)
  })

  it("rejects workspace with no subcommand", () => {
    expect(() => parseArgs(["workspace"])).toThrow(/needs a subcommand/)
  })

  it("rejects workspace add/remove with no target", () => {
    expect(() => parseArgs(["workspace", "add"])).toThrow(/manifest path/)
    expect(() => parseArgs(["workspace", "remove"])).toThrow(/project id or manifest path/)
  })

  it("still accepts flags after a workspace add/remove positional", () => {
    const args = parseArgs(["workspace", "add", "../other/pixelkiln.manifest.json", "--name", "other", "--lock", "../other/variant.lock.json"])
    expect(args.target).toBe("../other/pixelkiln.manifest.json")
    expect(args.name).toBe("other")
    expect(args.explicitLock).toBe("../other/variant.lock.json")
  })

  it("parses --provider/--account for workspace add", () => {
    const args = parseArgs([
      "workspace", "add", "../other/pixelkiln.manifest.json",
      "--provider", "fake", "--account", "sandbox",
    ])
    expect(args.provider).toBe("fake")
    expect(args.account).toBe("sandbox")
  })

  it("parses --workspace for salvage", () => {
    expect(parseArgs(["salvage", "--workspace", "pixelkiln.workspace.json", "--dry-run"])).toMatchObject({
      workspace: "pixelkiln.workspace.json",
      dryRun: true,
    })
  })

  // Same expensive-typo protection as every other command: --style neon after
  // a workspace add would otherwise fall through the strict loop.
  it("still rejects an unknown flag inside a workspace command", () => {
    expect(() => parseArgs(["workspace", "list", "--styles", "neon"])).toThrow(/Unknown flag/)
  })

  it("does not regress positional strictness for ordinary commands", () => {
    expect(() => parseArgs(["gen", "neon"])).toThrow(/Unexpected argument/)
  })
})

describe("retry policy", () => {
  afterEach(() => vi.unstubAllGlobals())
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

  it("understands both Retry-After seconds and HTTP dates", () => {
    expect(retryAfterMs("2", 0)).toBe(2000)
    expect(retryAfterMs("Thu, 01 Jan 1970 00:00:03 GMT", 1000)).toBe(2000)
    expect(retryAfterMs("not a date", 0)).toBeNull()
  })

  it("rejects a successful HTTP response whose API shape is invalid", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ subscription: { generations: "many" } }))),
    )
    await expect(new PixelLabClient("test").balance()).rejects.toThrow(/Invalid PixelLab response/)
  })

  it("applies response defaults declared by the official API schema", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(JSON.stringify({ background_job_id: "bg-1", object_id: "obj-1" })),
      ),
    )
    await expect(
      new PixelLabClient("test").createMapObject({ description: "anvil", width: 32, height: 32 }),
    ).resolves.toMatchObject({ object_id: "obj-1", status: "processing" })
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

  it("supports keyboard review beyond the first nine candidates", () => {
    const html = renderSheet([{ ...group, frameUrls: Array.from({ length: 16 }, (_, i) => `u${i}`) }])
    expect(html).toContain("e.key === 'ArrowRight'")
    expect(html).toContain("e.key === 'Enter'")
    expect(html).toContain("activate(active + 1, frames)")
    expect(html).toContain("Choose candidate ' + (i + 1)")
  })

  it("builds candidate image URLs through DOM properties instead of HTML interpolation", () => {
    const html = renderSheet([group])
    expect(html).toContain("preview.src = url")
    expect(html).not.toContain("'<img src=\"' + url")
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

  // A session commonly spans multiple styles at once (unlike salvage, which
  // now opens one tab per style) — nothing distinguished which style a row's
  // candidates belonged to beyond recognising the art itself.
  it("labels each row with its style, not just the asset id", () => {
    const html = renderSheet([
      { ...group, styleId: "heybud-neon" },
      { ...group, key: "s2/a", styleId: "heybud-1bit" },
    ])
    expect(html).toContain("heybud-neon")
    expect(html).toContain("heybud-1bit")
  })

  it("escapes a style id, same as it does for the prompt", () => {
    const html = renderSheet([{ ...group, styleId: '</script><script>alert(1)</script>' }])
    expect(html).not.toContain("<script>alert(1)</script>")
    expect((html.match(/<script>/g) ?? []).length).toBe(1)
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
