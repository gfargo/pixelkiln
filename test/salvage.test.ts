import { describe, expect, it, beforeEach, afterEach } from "vitest"
import { mkdtemp, writeFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { idFromPrompt, loadClaims } from "../src/pipeline/salvage.ts"
import { renderSalvageSheet } from "../src/pick/salvage-sheet.ts"

let dir: string
beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "pixelkiln-salvage-"))
})
afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

describe("idFromPrompt", () => {
  it("names the asset after the subject, not the shared style prefix", () => {
    const id = idFromPrompt(
      "Premium indie-game achievement icon for Heybud: one centered blacksmith anvil with a bright spark, bold dark outline, transparent background",
      new Set(),
    )
    expect(id).toContain("anvil")
    expect(id).not.toContain("premium")
    expect(id).not.toContain("achievement")
  })

  it("handles prompts with no colon", () => {
    expect(idFromPrompt("pixel art wooden split rail fence, isometric", new Set())).toContain("fence")
  })

  it("disambiguates collisions instead of overwriting", () => {
    const taken = new Set<string>()
    const a = idFromPrompt("a wooden fence post", taken)
    const b = idFromPrompt("a wooden fence post", taken)
    expect(a).not.toBe(b)
  })

  it("never produces an empty id", () => {
    expect(idFromPrompt("a the of on in", new Set())).toBe("salvaged")
  })
})

describe("loadClaims", () => {
  async function lockWith(name: string, entries: Record<string, unknown>) {
    const p = path.join(dir, name)
    await writeFile(p, JSON.stringify({ version: 1, entries }))
    return p
  }

  const entry = (over: Record<string, unknown>) => ({
    styleId: "s", assetId: "a", specHash: "h", generator: "1dir", prompt: "p",
    width: 64, height: 64, jobId: null, reviewObjectId: null, objectId: null,
    candidateIndex: null, status: "downloaded", error: null, sourceUrl: null,
    file: null, fileSha256: null, submittedAt: null, downloadedAt: null, cost: 0,
    ...over,
  })

  it("unions object, review, and job ids across every lockfile", async () => {
    const a = await lockWith("a.json", { "s/one": entry({ objectId: "obj-1", reviewObjectId: "rev-1" }) })
    const b = await lockWith("b.json", { "s/two": entry({ objectId: "obj-2", jobId: "job-2" }) })

    const claimed = await loadClaims([a, b])
    expect(claimed).toEqual(new Set(["obj-1", "rev-1", "obj-2", "job-2"]))
  })

  // An incomplete claim set makes another project's shipped art look orphaned.
  it("throws on a missing claim file rather than silently widening the orphan set", async () => {
    await expect(loadClaims([path.join(dir, "nope.json")])).rejects.toThrow(/not found/)
  })

  it("throws on a malformed claim file", async () => {
    const p = path.join(dir, "bad.json")
    await writeFile(p, JSON.stringify({ nope: true }))
    await expect(loadClaims([p])).rejects.toThrow(/malformed/)
  })
})

describe("salvage sheet", () => {
  const orphan = {
    id: "obj-1",
    prompt: "a wooden fence",
    width: 32,
    height: 96,
    createdAt: "2026-03-01T00:00:00Z",
    previewUrl: "https://example.test/a.png",
    tags: [],
  }

  it("renders one card per orphan with its real dimensions", () => {
    const html = renderSalvageSheet([orphan])
    expect(html).toContain("https://example.test/a.png")
    expect(html).toContain("obj-1")
  })

  it("escapes prompts in both the markup and the script payload", () => {
    const html = renderSalvageSheet([
      { ...orphan, prompt: '</script><img src=x onerror="alert(1)">' },
    ])
    expect(html).not.toContain("<img src=x")
    expect((html.match(/<script>/g) ?? []).length).toBe(1)
  })

  it("states that discard does not delete", () => {
    expect(renderSalvageSheet([orphan])).toMatch(/nothing is deleted/i)
  })
})
