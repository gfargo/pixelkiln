import { describe, expect, it, beforeEach, afterEach, vi } from "vitest"
import { mkdtemp, writeFile, rm, readFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import {
  idFromPrompt,
  applyTags,
  loadClaims,
  matchOrphanStyle,
  groupOrphansByStyle,
  SALVAGED_SPEC_HASH,
  type Orphan,
} from "../src/pipeline/salvage.ts"
import { renderSalvageSheet } from "../src/pick/salvage-sheet.ts"
import { runSalvage } from "../src/pick/salvage-server.ts"
import { loadManifest } from "../src/manifest.ts"
import { FakeProvider } from "../src/providers/fake.ts"
import type { Lock, Manifest, Style } from "../src/types.ts"

let dir: string
beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "pixelkiln-salvage-"))
})
afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

function style(over: Partial<Style> = {}): Style {
  return {
    generator: "1dir",
    styleImages: [],
    promptPrefix: "",
    promptSuffix: "",
    outDir: "out",
    palette: [],
    tags: [],
    ...over,
  }
}

function orphan(over: Partial<Orphan> = {}): Orphan {
  return {
    id: "obj-1",
    prompt: "a wooden fence",
    width: 32,
    height: 96,
    createdAt: "2026-01-01T00:00:00Z",
    previewUrl: "fake://obj-1.png",
    tags: [],
    ...over,
  }
}

describe("matchOrphanStyle / groupOrphansByStyle", () => {
  // Sharing an account across projects is the whole reason salvage's orphan
  // pool can span styles that were never meant to mix (heybud-neuromancer
  // badges next to an unrelated project's terrain tiles). Classification has
  // to separate them correctly, and has to resist two failure modes: a short
  // or empty promptPrefix/promptSuffix matching everything, and a single-style
  // manifest (which has no pattern to check against at all) matching nothing.
  const manifest: Manifest = {
    name: "m",
    styles: {
      premium: style({ promptSuffix: "restrained black, charcoal, pearl-white and silver palette" }),
      neon: style({ promptSuffix: "hot magenta and electric cyan rim lighting" }),
    },
    assets: {},
  }

  it("matches an orphan to the style whose suffix appears in its prompt", () => {
    expect(matchOrphanStyle("a badge, restrained black, charcoal, pearl-white and silver palette", manifest)).toBe(
      "premium",
    )
    expect(matchOrphanStyle("a badge, hot magenta and electric cyan rim lighting", manifest)).toBe("neon")
  })

  it("returns null when nothing matches, rather than guessing", () => {
    expect(matchOrphanStyle("isometric pine tree, GBA style", manifest)).toBeNull()
  })

  it("does not let a short or empty prefix/suffix match everything", () => {
    const loose: Manifest = {
      name: "m",
      styles: { base: style({ promptSuffix: "clean" }) },
      assets: {},
    }
    // Two styles, so classification runs — but "clean" is under the length
    // floor, so it must not swallow every prompt that happens to contain it.
    const twoStyle: Manifest = { ...loose, styles: { ...loose.styles, other: style() } }
    expect(matchOrphanStyle("a very clean sword", twoStyle)).toBeNull()
  })

  it("skips classification for a single-style manifest, matching everything to it", () => {
    const single: Manifest = {
      name: "m",
      styles: { base: style() }, // empty prefix/suffix — nothing to pattern-match against
      assets: {},
    }
    expect(matchOrphanStyle("literally anything", single)).toBe("base")
  })

  it("groups matched orphans by style and collects the rest as unmatched", () => {
    const orphans = [
      orphan({ id: "a", prompt: "restrained black, charcoal, pearl-white and silver palette" }),
      orphan({ id: "b", prompt: "hot magenta and electric cyan rim lighting" }),
      orphan({ id: "c", prompt: "hot magenta and electric cyan rim lighting" }),
      orphan({ id: "d", prompt: "isometric pine tree, GBA style" }),
    ]
    const { matched, unmatched } = groupOrphansByStyle(orphans, manifest)
    expect([...matched.keys()]).toEqual(["premium", "neon"])
    expect(matched.get("premium")!.map((o) => o.id)).toEqual(["a"])
    expect(matched.get("neon")!.map((o) => o.id)).toEqual(["b", "c"])
    expect(unmatched.map((o) => o.id)).toEqual(["d"])
  })

  it("omits styles with zero matches from the group map", () => {
    const { matched } = groupOrphansByStyle(
      [orphan({ prompt: "hot magenta and electric cyan rim lighting" })],
      manifest,
    )
    expect(matched.has("premium")).toBe(false)
    expect(matched.has("neon")).toBe(true)
  })

  // The real gap this closes: disc-golf-game's own manifest has one style
  // with an empty prompt template, so it has nothing to pattern-match
  // against and used to claim its whole shared account's orphan pool by
  // default — including heybud-admin's badge art.
  describe("with sibling manifests", () => {
    const single: Manifest = {
      name: "disc-golf-game",
      styles: { base: style() }, // empty prefix/suffix, same as the real project
      assets: {},
    }
    const sibling = { label: "heybud-admin", manifest }

    it("still claims everything by default with no siblings passed", () => {
      const { matched, elsewhere } = groupOrphansByStyle(
        [orphan({ prompt: "hot magenta and electric cyan rim lighting" })],
        single,
      )
      expect(matched.get("base")).toHaveLength(1)
      expect(elsewhere.size).toBe(0)
    })

    it("excludes an orphan that matches a sibling's own style pattern", () => {
      const badge = orphan({ id: "badge", prompt: "hot magenta and electric cyan rim lighting" })
      const { matched, elsewhere } = groupOrphansByStyle([badge], single, [sibling])
      expect(matched.has("base")).toBe(false)
      expect([...elsewhere.keys()]).toEqual(["heybud-admin: neon"])
      expect(elsewhere.get("heybud-admin: neon")!.map((o) => o.id)).toEqual(["badge"])
    })

    it("still falls back to the one style when a sibling doesn't recognise it either", () => {
      const tree = orphan({ id: "tree", prompt: "isometric pine tree, disc golf course" })
      const { matched, elsewhere } = groupOrphansByStyle([tree], single, [sibling])
      expect(matched.get("base")!.map((o) => o.id)).toEqual(["tree"])
      expect(elsewhere.size).toBe(0)
    })

    it("prefers this manifest's own match over a sibling's, when both would match", () => {
      const multi: Manifest = {
        name: "m",
        styles: { neon: style({ promptSuffix: "hot magenta and electric cyan rim lighting" }) },
        assets: {},
      }
      const badge = orphan({ prompt: "hot magenta and electric cyan rim lighting" })
      const { matched, elsewhere } = groupOrphansByStyle([badge], multi, [sibling])
      expect(matched.get("neon")).toHaveLength(1)
      expect(elsewhere.size).toBe(0)
    })
  })
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
    await writeFile(p, JSON.stringify({ version: 2, entries }))
    return p
  }

  const entry = (over: Record<string, unknown>) => ({
    styleId: "s", assetId: "a", specHash: "h", generator: "1dir", prompt: "p",
    width: 64, height: 64, jobId: null, reviewObjectId: null, objectId: null,
    candidateIndex: null, status: "downloaded", error: null, sourceUrl: null,
    outputs: [], submittedAt: null, downloadedAt: null, cost: 0,
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

  it("throws on a claim file that is not v2", async () => {
    const p = path.join(dir, "bad.json")
    await writeFile(p, JSON.stringify({ version: 1, entries: {} }))
    await expect(loadClaims([p])).rejects.toThrow(/malformed/)
  })
})

describe("salvage decision tags", () => {
  it("keeps the decision tag when the provider's 20-tag limit is already full", async () => {
    const provider = new FakeProvider()
    const existing = new Map([["obj-1", Array.from({ length: 20 }, (_, i) => `tag-${i}`)]])

    await applyTags(provider, [{ id: "obj-1", action: "keep" }], existing)

    expect(provider.tags.get("obj-1")).toHaveLength(20)
    expect(provider.tags.get("obj-1")).toContain("pixelkiln:keep")
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

  it("offers bulk actions for both keep and discard, not just keep", () => {
    const html = renderSalvageSheet([orphan])
    expect(html).toContain('id="allKeep"')
    expect(html).toContain('id="allDiscard"')
  })

  // With one tab open per matched style (grouping), every tab title used to
  // read the same generic "pixelkiln — salvage" — no way to tell them apart
  // without checking which images had loaded.
  it("names the style and import destination in the title and header when given a context", () => {
    const html = renderSalvageSheet([orphan], { styleId: "heybud-neon", importDir: "public/badges/variants/neon" })
    expect(html).toMatch(/<title>pixelkiln salvage — heybud-neon<\/title>/)
    expect(html).toContain("heybud-neon")
    expect(html).toContain("public/badges/variants/neon/_salvaged/")
  })

  it("falls back to a generic title when no context is given", () => {
    const html = renderSalvageSheet([orphan])
    expect(html).toMatch(/<title>pixelkiln salvage<\/title>/)
  })

  it("escapes a style id in the title/header context, not just prompts", () => {
    const html = renderSalvageSheet([orphan], { styleId: '</title><script>alert(1)</script>', importDir: "out" })
    expect(html).not.toContain("<script>alert(1)</script>")
  })
})

describe("runSalvage", () => {
  // Regression: applying an import used to re-merge the entire in-memory
  // manifest into the on-disk file, so every pre-existing asset got
  // overwritten with its loadManifest()-normalized copy (e.g. a defaulted
  // `promptByStyle: {}` appearing on assets that never had the field on
  // disk). One imported asset should touch only that one entry.
  it("writes only the newly imported asset, leaving existing entries byte-for-byte", async () => {
    const manifestPath = path.join(dir, "pixelkiln.manifest.json")
    const rawManifest = {
      name: "itest",
      styles: { base: { generator: "1dir", size: 64, outDir: "out", promptSuffix: "clean" } },
      assets: { anvil: { prompt: "an anvil", category: "tools" } },
    }
    await writeFile(manifestPath, JSON.stringify(rawManifest, null, 2) + "\n")
    const lockPath = path.join(dir, "pixelkiln.lock.json")
    const lock: Lock = { version: 2, entries: {} }

    const loaded = await loadManifest(manifestPath)
    const provider = new FakeProvider()
    provider.seed({ id: "obj-1", prompt: "a wooden fence", width: 32, height: 96 })
    const orphan = {
      id: "obj-1",
      prompt: "a wooden fence",
      width: 32,
      height: 96,
      createdAt: "2026-01-01T00:00:00Z",
      previewUrl: "fake://obj-1.png",
      tags: [],
    }

    let url = ""
    const salvaged = runSalvage(
      provider,
      [orphan],
      {
        manifestPath: loaded.path,
        manifest: loaded.manifest,
        styleId: "base",
        importDir: path.resolve(loaded.root, "out"),
        lock,
        lockPath,
      },
      { open: false, onProgress: (m) => (url ||= m.match(/http:\/\/127\.0\.0\.1:\d+\//)?.[0] ?? "") },
    )

    await vi.waitFor(() => expect(url).not.toBe(""))
    const res = await fetch(url + "apply", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ decisions: [{ id: "obj-1", action: "import" }] }),
    })
    expect(res.ok).toBe(true)
    expect((await salvaged).imported).toBe(1)

    const onDisk = JSON.parse(await readFile(manifestPath, "utf8"))
    expect(onDisk.assets.anvil).toEqual({ prompt: "an anvil", category: "tools" })
    expect(Object.keys(onDisk.assets)).toEqual(["anvil", "wooden_fence"])
    expect(lock.entries["base/wooden_fence"]!.outputs[0]!.path)
      .toBe("out/_salvaged/wooden_fence.png")
  })

  it("serves the page naming its own style, so open tabs are distinguishable", async () => {
    const manifestPath = path.join(dir, "pixelkiln.manifest.json")
    await writeFile(
      manifestPath,
      JSON.stringify({
        name: "itest",
        styles: { neon: { generator: "1dir", size: 64, outDir: "out/neon" } },
        assets: {},
      }),
    )
    const loaded = await loadManifest(manifestPath)
    const provider = new FakeProvider()

    let url = ""
    const salvaged = runSalvage(
      provider,
      [],
      {
        manifestPath: loaded.path,
        manifest: loaded.manifest,
        styleId: "neon",
        importDir: path.resolve(loaded.root, "out/neon"),
        lock: { version: 2, entries: {} },
        lockPath: path.join(dir, "pixelkiln.lock.json"),
      },
      { open: false, onProgress: (m) => (url ||= m.match(/http:\/\/127\.0\.0\.1:\d+\//)?.[0] ?? "") },
    )
    await vi.waitFor(() => expect(url).not.toBe(""))

    const page = await (await fetch(url)).text()
    expect(page).toContain("<title>pixelkiln salvage — neon</title>")

    await fetch(url + "apply", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ decisions: [] }),
    })
    await salvaged
  })
})

describe("salvaged spec hash", () => {
  // Regression: salvage writes a placeholder hash because the real one cannot
  // exist until the manifest has been rewritten. If the CLI fails to
  // re-baseline afterwards, every recovered asset reports `stale` and offers to
  // regenerate art that was just imported — re-paying for all of it.
  it("is a sentinel the re-baseliner can recognise", () => {
    expect(SALVAGED_SPEC_HASH).toBe("salvaged")
  })

  it("never collides with a real sha256", () => {
    expect(SALVAGED_SPEC_HASH).not.toMatch(/^[0-9a-f]{64}$/)
  })
})
