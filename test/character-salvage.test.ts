import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"
import { existsSync } from "node:fs"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { parseArgs } from "../src/cli/args.ts"
import { runPurge } from "../src/cli/commands/account.ts"
import { loadManifest, resolveSpecs } from "../src/manifest.ts"
import { adoptCharacters } from "../src/pipeline/adopt-characters.ts"
import {
  applyTags,
  characterSalvageAssets,
  findOrphanCharacters,
  loadClaims,
  routeCharacterOrphans,
  withoutCharacterStyles,
  type Orphan,
} from "../src/pipeline/salvage.ts"
import { renderSalvageSheet } from "../src/pick/salvage-sheet.ts"
import { runSalvage } from "../src/pick/salvage-server.ts"
import type { RemoteCharacterDetail } from "../src/provider.ts"
import { FakeProvider } from "../src/providers/fake.ts"
import { registerProvider } from "../src/providers/registry.ts"
import type { Lock, Manifest, Style } from "../src/types.ts"

let dir: string
let provider: FakeProvider
beforeAll(() => {
  registerProvider({ id: "fake", create: () => provider })
})
beforeEach(async () => {
  provider = new FakeProvider({ candidates: 1 })
  dir = await mkdtemp(path.join(tmpdir(), "pixelkiln-character-salvage-"))
})
afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

const DIRS8 = ["south", "south-east", "east", "north-east", "north", "north-west", "west", "south-west"]

function character(id: string, extra: Partial<RemoteCharacterDetail> = {}): RemoteCharacterDetail {
  return {
    id,
    name: "brave knight",
    stateName: "Idle",
    prompt: "a brave knight",
    groupId: "grp-knight",
    directions: 8,
    width: 64,
    height: 64,
    createdAt: "2026-09-01T00:00:00.000Z",
    previewUrl: `fake://${id}/south.png`,
    tags: [],
    status: "completed",
    animationCount: 0,
    rotations: DIRS8.map((direction) => ({ url: `fake://${id}/${direction}.png`, role: direction })),
    animations: [],
    ...extra,
  }
}

const frames = (id: string, group: string, direction: string, n: number) =>
  Array.from({ length: n }, (_, i) => `fake://${id}/animations/${group}/${direction}/${i}.png`)

/** A knight base with a walk in two directions, and a crouching state with one idle loop. */
function seedKnight() {
  provider.characters.set("char-knight", character("char-knight", {
    animationCount: 2,
    animations: [
      { groupId: "grp-walk", name: null, type: "walk", direction: "south", frames: frames("char-knight", "grp-walk", "south", 6) },
      { groupId: "grp-walk", name: null, type: "walk", direction: "east", frames: frames("char-knight", "grp-walk", "east", 6) },
    ],
  }))
  provider.characters.set("char-crouch", character("char-crouch", {
    stateName: "crouching",
    prompt: "crouching low",
    createdAt: "2026-09-02T00:00:00.000Z",
    animationCount: 1,
    animations: [
      { groupId: "grp-breathe", name: "pixelkiln:old/knight.crouch.breathe", type: "custom", direction: "south", frames: frames("char-crouch", "grp-breathe", "south", 4) },
      { groupId: null, name: "legacy", type: "legacy", direction: "west", frames: frames("char-crouch", "legacy", "west", 4) },
    ],
  }))
}

function style(over: Partial<Style> = {}): Style {
  return { generator: "map", styleImages: [], promptPrefix: "", promptSuffix: "", outDir: "out", palette: [], tags: [], ...over }
}

describe("finding unclaimed characters", () => {
  it("claims the character behind a loop's `<character>#<group>` id", async () => {
    const lockPath = path.join(dir, "other.lock.json")
    await writeFile(lockPath, JSON.stringify({
      version: 2,
      entries: {
        "cast/hero.walk": {
          styleId: "cast", assetId: "hero.walk", specHash: "x", generator: "character", prompt: "", width: 64, height: 64,
          status: "downloaded", objectId: "char-knight#grp-walk", jobId: "char-knight#grp-walk", provider: "fake",
        },
      },
    }))
    const claimed = await loadClaims([lockPath], { provider: "fake" })
    expect(claimed.has("char-knight")).toBe(true)
  })

  it("groups a base with its states into one card, and leaves partly claimed groups alone", async () => {
    seedKnight()
    provider.characters.set("char-solo", character("char-solo", { groupId: "grp-solo", name: "slime", prompt: "a slime", createdAt: "2026-09-05T00:00:00.000Z" }))
    provider.characters.set("char-used", character("char-used", { groupId: "grp-used" }))
    provider.characters.set("char-used-state", character("char-used-state", { groupId: "grp-used", stateName: "angry" }))

    const scan = await findOrphanCharacters(provider, new Set(["char-used"]))
    expect(scan).toMatchObject({ total: 5, partlyClaimed: 1 })
    expect(scan.orphans.map((o) => o.id)).toEqual(["char-solo", "char-knight"])
    const knight = scan.orphans[1]!
    expect(knight).toMatchObject({
      kind: "character",
      prompt: "a brave knight",
      previewUrl: "fake://char-knight/south.png",
      note: "character · 8 directions · 1 state · 3 loops",
    })
    expect(knight.members!.map((m) => m.id)).toEqual(["char-knight", "char-crouch"])
  })

  it("routes groups to the only character style, by pattern among several, and objects never to one", () => {
    const orphan = (prompt: string): Orphan => ({ id: prompt, prompt, width: 64, height: 64, createdAt: "", previewUrl: "", tags: [], kind: "character" })
    const one = { name: "t", provider: "fake", styles: { cast: style({ generator: "character" }), props: style() }, assets: {} } as unknown as Manifest
    expect([...routeCharacterOrphans([orphan("x")], one).matched.keys()]).toEqual(["cast"])
    expect(Object.keys(withoutCharacterStyles(one).styles)).toEqual(["props"])

    const two = {
      name: "t", provider: "fake", assets: {},
      styles: {
        heroes: style({ generator: "character", promptSuffix: "heroic fantasy portrait" }),
        monsters: style({ generator: "character", promptSuffix: "grotesque monster design" }),
      },
    } as unknown as Manifest
    const routed = routeCharacterOrphans([orphan("an orc, grotesque monster design"), orphan("a cat")], two)
    expect([...routed.matched.keys()]).toEqual(["monsters"])
    expect(routed.unmatched.map((o) => o.id)).toEqual(["a cat"])

    const none = { name: "t", provider: "fake", styles: { props: style() }, assets: {} } as unknown as Manifest
    expect(routeCharacterOrphans([orphan("x")], none).unmatched).toHaveLength(1)
  })
})

describe("characterSalvageAssets", () => {
  it("writes a base, each state, and a loop per animation direction, each with the remoteId adoption maps", () => {
    seedKnight()
    const { assets, skipped } = characterSalvageAssets(
      [provider.characters.get("char-crouch")!, provider.characters.get("char-knight")!],
      { styleId: "cast", styleSize: 64, taken: new Set(["brave_knight"]) },
    )
    expect(assets).toEqual({
      brave_knight_2: { prompt: "a brave knight", remoteId: "char-knight", styles: ["cast"], tags: ["salvaged"] },
      brave_knight_2_crouching: { prompt: "crouching low", state: { of: "brave_knight_2" }, remoteId: "char-crouch", styles: ["cast"], tags: ["salvaged"] },
      "brave_knight_2.walk.south": { prompt: "walk", animation: { of: "brave_knight_2", direction: "south" }, remoteId: "char-knight#grp-walk", styles: ["cast"], tags: ["salvaged"] },
      "brave_knight_2.walk.east": { prompt: "walk", animation: { of: "brave_knight_2", direction: "east" }, remoteId: "char-knight#grp-walk", styles: ["cast"], tags: ["salvaged"] },
      "brave_knight_2_crouching.knight_crouch_breathe.south": {
        prompt: "pixelkiln:old/knight.crouch.breathe",
        animation: { of: "brave_knight_2_crouching", direction: "south" },
        remoteId: "char-crouch#grp-breathe",
        styles: ["cast"],
        tags: ["salvaged"],
      },
    })
    expect(skipped).toEqual([expect.stringContaining('"legacy" west loop has no animation group id')])
  })

  it("records a size only when it differs from the style's", () => {
    const { assets } = characterSalvageAssets([character("c", { width: 48, height: 48 })], { styleId: "cast", styleSize: 64, taken: new Set() })
    expect(assets.brave_knight).toMatchObject({ size: 48 })
  })
})

describe("tagging a character group", () => {
  it("tags every member of the group as a character", async () => {
    seedKnight()
    const setTags = vi.spyOn(provider, "setTags")
    const members = [{ id: "char-knight", tags: ["mine"] }, { id: "char-crouch", tags: [] }]
    const res = await applyTags(provider, [{ id: "char-knight", action: "discard" }], new Map(), {
      characters: new Map([["char-knight", members]]),
    })
    expect(res).toEqual({ tagged: 2, failed: 0 })
    expect(setTags.mock.calls).toEqual([
      ["char-knight", ["mine", "pixelkiln:discard"], "character"],
      ["char-crouch", ["pixelkiln:discard"], "character"],
    ])
  })

  it("shows the group's note on the triage sheet, escaped", () => {
    const html = renderSalvageSheet([{
      id: "c", prompt: "a knight", width: 64, height: 64, createdAt: "2026-09-01", previewUrl: "fake://c.png", tags: [],
      kind: "character", note: "character · 8 directions · <b>",
    }])
    expect(html).toContain("character · 8 directions · &lt;b&gt;")
  })
})

describe("salvaging a character end to end", () => {
  it("imports a group as manifest assets, then adoption writes every file and lock entry", async () => {
    seedKnight()
    const manifestPath = path.join(dir, "pixelkiln.manifest.json")
    await writeFile(manifestPath, JSON.stringify({
      name: "salvage",
      provider: "fake",
      styles: { cast: { generator: "character", outDir: "art", size: 64 } },
      assets: {},
    }, null, 2) + "\n")
    const lockPath = path.join(dir, "pixelkiln.lock.json")
    const lock: Lock = { version: 2, entries: {} }
    const loaded = await loadManifest(manifestPath)
    const { orphans } = await findOrphanCharacters(provider, new Set())

    let url = ""
    const salvaged = runSalvage(
      provider,
      orphans,
      { manifestPath, manifest: loaded.manifest, styleId: "cast", importDir: path.join(dir, "art"), lock, lockPath },
      { open: false, onProgress: (m) => (url ||= m.match(/http:\/\/127\.0\.0\.1:\d+\//)?.[0] ?? "") },
    )
    await vi.waitFor(() => expect(url).not.toBe(""))
    const res = await fetch(url + "apply", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ decisions: [{ id: "char-knight", action: "import" }] }),
    })
    expect(res.ok).toBe(true)
    const result = await salvaged
    expect(result).toMatchObject({ imported: 1, failed: 0 })
    expect(result.characterAssetIds).toHaveLength(5)
    // Both members carry the decision upstream.
    expect(provider.tags.get("char-knight")).toContain("pixelkiln:imported")
    expect(provider.tags.get("char-crouch")).toContain("pixelkiln:imported")

    const resolve = async () => resolveSpecs(await loadManifest(manifestPath), { assets: result.characterAssetIds })
    const adopted = await adoptCharacters(provider, await resolve(), lock, lockPath, { resolve })
    expect(adopted).toMatchObject({ matched: 5, unmatched: [] })
    expect(lock.entries["cast/brave_knight"]).toMatchObject({ status: "downloaded", objectId: "char-knight" })
    expect(lock.entries["cast/brave_knight.walk.east"]!.outputs).toHaveLength(6)
    expect(existsSync(path.join(dir, "art", "brave_knight-north-west.png"))).toBe(true)
    expect(existsSync(path.join(dir, "art", "brave_knight_crouching.knight_crouch_breathe.south-frame-03.png"))).toBe(true)
    const written = JSON.parse(await readFile(manifestPath, "utf8")) as { assets: Record<string, unknown> }
    expect(Object.keys(written.assets)).toEqual(result.characterAssetIds)
  })
})

describe("purge", () => {
  it("deletes characters tagged for discard beside objects, after confirmation", async () => {
    const manifestPath = path.join(dir, "pixelkiln.manifest.json")
    await writeFile(manifestPath, JSON.stringify({ name: "purge", provider: "fake", styles: { cast: { generator: "character", outDir: "art" } }, assets: {} }))
    provider.seed({ id: "obj-1", prompt: "a rock", tags: ["pixelkiln:discard"] })
    provider.characters.set("char-bad", character("char-bad", { tags: ["pixelkiln:discard"] }))
    provider.characters.set("char-good", character("char-good", { groupId: "grp-good", tags: ["pixelkiln:keep"] }))
    const logs: string[] = []
    const spy = vi.spyOn(console, "log").mockImplementation((m?: unknown) => { logs.push(String(m)) })
    try {
      await runPurge(parseArgs(["purge", "--manifest", manifestPath, "--dry-run"]))
      expect(logs.join("\n")).toMatch(/1 object\(s\) and 1 character\(s\) tagged for discard/)
      expect(provider.deleted).toEqual([])
      await runPurge(parseArgs(["purge", "--manifest", manifestPath, "--yes"]))
    } finally {
      spy.mockRestore()
    }
    expect(provider.deleted.sort()).toEqual(["char-bad", "obj-1"])
    expect(provider.characters.has("char-good")).toBe(true)
  })
})
