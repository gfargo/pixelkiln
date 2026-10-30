import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { loadManifest, resolveSpecs } from "../src/manifest.ts"
import { PixelLabProvider } from "../src/providers/pixellab.ts"
import { buildPlan } from "../src/pipeline/plan.ts"
import { submit } from "../src/pipeline/submit.ts"
import { revertGeneration, historyAfterReplacing } from "../src/pipeline/history.ts"
import { openProject } from "../src/project.ts"
import { encodeRgbaPng } from "../src/png.ts"
import { sha256 } from "../src/hash.ts"
import { upsert } from "../src/lock.ts"
import type { Lock, LockEntry } from "../src/types.ts"

let dir: string
beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "pixelkiln-motion-"))
})
afterEach(async () => {
  vi.unstubAllGlobals()
  await rm(dir, { recursive: true, force: true })
})

const px = (shade: number) => encodeRgbaPng(8, 8, Buffer.alloc(8 * 8 * 4, shade))
const manifestPath = () => path.join(dir, "pixelkiln.manifest.json")

type Project = Awaited<ReturnType<typeof openProject>>

async function writeManifest(animation: Record<string, unknown>, extra: Record<string, unknown> = {}) {
  await writeFile(manifestPath(), JSON.stringify({
    name: "motion-test",
    styles: { cast: { generator: "character", mode: "v3", outDir: "art/characters", size: 64 } },
    assets: {
      hero: { prompt: "a knight" },
      "hero.cheer": { prompt: "cheering with both arms raised", animation: { of: "hero", mode: "skeleton-v3", frames: 6, ...animation } },
      ...extra,
    },
  }))
  return manifestPath()
}

/** Put an asset in the lock as downloaded, with real files whose hashes match. */
async function markDownloaded(p: Project, assetId: string, patch: Partial<LockEntry> = {}, shade = 10) {
  const spec = p.specs.find((s) => s.assetId === assetId)!
  const stem = spec.outFile.replace(/\.png$/, "")
  const isBase = spec.character?.kind === "base"
  const roles = isBase ? ["south", "west"] : ["frame-00", "frame-01"]
  const outputs = []
  for (const [index, role] of roles.entries()) {
    const file = `${stem}-${role}.png`
    await mkdir(path.dirname(file), { recursive: true })
    const bytes = px(shade + index)
    await writeFile(file, bytes)
    outputs.push({ path: path.relative(dir, file), sha256: sha256(bytes), role })
  }
  upsert(p.lock, `cast/${assetId}`, {
    styleId: "cast", assetId, specHash: spec.specHash, generator: "character", prompt: spec.prompt,
    width: spec.width, height: spec.height, status: "downloaded", objectId: isBase ? "char-1" : `char-1#${assetId}`,
    outputs, provider: "pixellab", downloadedAt: "now", ...patch,
  } as Partial<LockEntry>)
}

const characterMeta = (assetId: string, animationGroupId: string | null, direction: string, animationName = `pixelkiln:cast/${assetId}`) => ({
  pixellab: { character: { kind: "animation", characterId: "char-1", animationGroupId, animationName, direction } },
})

/** A project with the base downloaded (so loops are not blocked on it) and its plan states. */
async function open(animation: Record<string, unknown>, extra?: Record<string, unknown>) {
  await writeManifest(animation, extra)
  const first = await openProject(manifestPath(), { env: false })
  await markDownloaded(first, "hero")
  // The base's south file now exists; re-resolve so loops hash it.
  const p = await openProject(manifestPath(), { env: false })
  p.lock.entries = { ...first.lock.entries }
  const hero = p.specs.find((s) => s.assetId === "hero")!
  upsert(p.lock, "cast/hero", { specHash: hero.specHash })
  return p
}
const states = async (p: Project) => Object.fromEntries((await buildPlan(p.specs, p.lock)).items.map((i) => [i.spec.assetId, i.state]))

describe("resolving a sentence loop's directions", () => {
  it("makes the first direction the leader and links every later direction to it", async () => {
    const p = await open({ directions: ["south", "west", "north"] })
    const byId = Object.fromEntries(p.specs.map((s) => [s.assetId, s]))
    expect(byId["hero.cheer.south"]!.character?.motionLeader).toBeUndefined()
    expect(byId["hero.cheer.west"]!.character?.motionLeader?.assetId).toBe("hero.cheer.south")
    expect(byId["hero.cheer.north"]!.character?.motionLeader?.assetId).toBe("hero.cheer.south")
    // The mirror flips its source's frames; it joins nothing.
    expect(byId["hero.cheer.east"]!.mirror?.sourceAssetId).toBe("hero.cheer.west")
    expect(byId["hero.cheer.east"]!.character?.motionLeader).toBeUndefined()
    expect(byId["hero.cheer.west"]!.cost).toBe(4)
  })

  it("leaves a single direction, a template loop, and other modes unlinked", async () => {
    const single = await open({ directions: ["west"] })
    expect(single.specs.map((s) => s.character?.motionLeader)).toEqual([undefined, undefined, undefined])
    const template = await open({ template: "walk", directions: ["south", "west"], frames: undefined })
    expect(template.specs.filter((s) => s.character?.motionLeader)).toEqual([])
    const v3 = await open({ mode: "v3", directions: ["south", "west"] })
    expect(v3.specs.filter((s) => s.character?.motionLeader)).toEqual([])
  })

  it("keeps the hash of every spec that shares nothing, and moves only a later direction's", async () => {
    const hash = async (animation: Record<string, unknown>, id: string) => {
      const specs = await resolveSpecs(await loadManifest(await writeManifest(animation)))
      return specs.find((s) => s.assetId === id)!.specHash
    }
    // A single-direction sentence loop is the same asset whether written out or listed.
    const explicit = await hash({ direction: "south" }, "hero.cheer")
    expect(await hash({ directions: ["south"] }, "hero.cheer.south")).toBe(explicit)
    // The leader of a longer list is that same loop; only a later direction gains the link.
    const leader = await hash({ directions: ["south", "west"] }, "hero.cheer.south")
    expect(leader).toBe(await hash({ directions: ["south"] }, "hero.cheer.south"))
    const west = await hash({ directions: ["south", "west"] }, "hero.cheer.west")
    expect(west).not.toBe(await hash({ directions: ["west"] }, "hero.cheer.west"))
    // Pinned from before shared motion existed.
    expect(await hash({ template: "walk", mode: "skeleton-v3", frames: undefined, direction: "east" }, "hero.cheer")).toBe(TEMPLATE_LOOP_HASH)
    expect(await hash({ direction: "south" }, "hero.cheer")).toBe(SENTENCE_LOOP_HASH)
    expect(await hash({ mode: "v3", direction: "south" }, "hero.cheer")).toBe(V3_LOOP_HASH)
  })

  it("refuses a link that cannot share a motion", async () => {
    const refuse = async (animation: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
      resolveSpecs(await loadManifest(await writeManifest(animation, extra)))
    const loop = (animation: Record<string, unknown>) => ({ prompt: "x", animation: { of: "hero", mode: "skeleton-v3", ...animation } })
    await expect(refuse({ direction: "south", motionFrom: "hero.cheer" })).rejects.toThrow(/cannot share its own motion/)
    await expect(refuse({ direction: "south", motionFrom: "hero.other" }, { "hero.other": loop({ direction: "south" }) })).rejects.toThrow(/same direction/)
    await expect(refuse({ direction: "south", motionFrom: "hero" })).rejects.toThrow(/is not a skeleton-v3 loop from a sentence/)
    await expect(refuse({ direction: "south", motionFrom: "hero.other" }, { "hero.other": { prompt: "", animation: { of: "hero", template: "walk", direction: "west" } } })).rejects.toThrow(/is not a skeleton-v3 loop from a sentence/)
    await expect(refuse({ template: "walk", direction: "south", motionFrom: "hero.other", frames: undefined })).rejects.toThrow(/motionFrom applies to a skeleton-v3 loop from a sentence/)
    await expect(
      refuse({ direction: "south", motionFrom: "hero.a" }, { "hero.a": loop({ direction: "west", motionFrom: "hero.b" }), "hero.b": loop({ direction: "north" }) }),
    ).rejects.toThrow(/itself shares hero.b's motion/)
  })
})

describe("planning a shared motion", () => {
  it("lets the leader go first and holds the others for the next wave", async () => {
    const p = await open({ directions: ["south", "west", "north"] })
    expect(await states(p)).toMatchObject({ "hero.cheer.south": "missing", "hero.cheer.west": "blocked", "hero.cheer.north": "blocked" })
    const plan = await buildPlan(p.specs, p.lock)
    expect(plan.items.find((i) => i.spec.assetId === "hero.cheer.west")!.reason).toMatch(/motion leader cast\/hero.cheer.south is not ready: parent is not in the lockfile/)
    expect(plan.actionable.map((i) => i.spec.assetId)).toEqual(["hero.cheer.south"])

    // Forcing everything before the leader exists is no different.
    const forced = await buildPlan(p.specs.filter((s) => s.assetId !== "hero"), p.lock, { force: true })
    expect(forced.actionable.map((i) => i.spec.assetId)).toEqual(["hero.cheer.south"])
  })

  it("holds a current member back when its leader is redrawn in the same run", async () => {
    const p = await open({ directions: ["south", "west"] })
    await markDownloaded(p, "hero.cheer.south", { providerMetadata: characterMeta("hero.cheer.south", "grp-1", "south") })
    const forced = await buildPlan(p.specs.filter((s) => s.assetId !== "hero"), p.lock, { force: true })
    expect(forced.items.find((i) => i.spec.assetId === "hero.cheer.west")).toMatchObject({
      state: "blocked", reason: "parent cast/hero.cheer.south is being generated in this run; this follows in the next wave",
    })
  })

  it("releases the others once the leader is downloaded, and keeps them current until it is regenerated", async () => {
    const p = await open({ directions: ["south", "west"] })
    await markDownloaded(p, "hero.cheer.south", { providerMetadata: characterMeta("hero.cheer.south", "grp-1", "south") })
    expect(await states(p)).toMatchObject({ "hero.cheer.south": "ok", "hero.cheer.west": "missing" })
    await markDownloaded(p, "hero.cheer.west", {
      providerMetadata: characterMeta("hero.cheer.south", "grp-1", "west"),
      motionShare: { sourceAssetId: "hero.cheer.south", animationGroupId: "grp-1" },
    }, 40)
    expect(await states(p)).toMatchObject({ "hero.cheer.south": "ok", "hero.cheer.west": "ok" })

    // The leader is drawn again: a new group, so the member no longer moves like it.
    upsert(p.lock, "cast/hero.cheer.south", { providerMetadata: characterMeta("hero.cheer.south", "grp-2", "south") })
    const plan = await buildPlan(p.specs, p.lock)
    expect(plan.items.find((i) => i.spec.assetId === "hero.cheer.west")).toMatchObject({
      state: "stale",
      reason: "shares motion with hero.cheer.south, which was regenerated; draw this direction into its new motion",
    })
    expect(plan.actionable.map((i) => i.spec.assetId)).toEqual(["hero.cheer.west"])
  })

  it("holds a current member while its leader is not downloaded", async () => {
    const p = await open({ directions: ["south", "west"] })
    await markDownloaded(p, "hero.cheer.south", { providerMetadata: characterMeta("hero.cheer.south", "grp-1", "south") })
    await markDownloaded(p, "hero.cheer.west", { motionShare: { sourceAssetId: "hero.cheer.south", animationGroupId: "grp-1" } }, 40)
    upsert(p.lock, "cast/hero.cheer.south", { status: "processing", outputs: [] })
    expect((await states(p))["hero.cheer.west"]).toBe("blocked")
  })

  it("draws a member on its own when the leader has no group recorded, and says so", async () => {
    const p = await open({ directions: ["south", "west"] })
    await markDownloaded(p, "hero.cheer.south")
    const plan = await buildPlan(p.specs, p.lock)
    const west = plan.items.find((i) => i.spec.assetId === "hero.cheer.west")!
    expect(west.state).toBe("missing")
    expect(west.reason).toMatch(/hero.cheer.south has no animation group recorded, so this is drawn on its own/)

    // Drawn alone, it records a null group and stays current while the leader still has none.
    await markDownloaded(p, "hero.cheer.west", { motionShare: { sourceAssetId: "hero.cheer.south", animationGroupId: null } }, 40)
    expect((await states(p))["hero.cheer.west"]).toBe("ok")
    // Once the leader is drawn again with a group, the member is behind it.
    upsert(p.lock, "cast/hero.cheer.south", { providerMetadata: characterMeta("hero.cheer.south", "grp-9", "south") })
    expect((await states(p))["hero.cheer.west"]).toBe("stale")
  })
})

/** Just enough of PixelLab's character endpoints to see what is sent. */
function stubPixelLab(groups: { id: string; name: string; directions: string[] }[]) {
  const sent: { method: string; path: string; query: string; body: Record<string, unknown> | null }[] = []
  vi.stubGlobal("fetch", vi.fn(async (input: string, init?: RequestInit) => {
    const url = new URL(String(input))
    const method = init?.method ?? "GET"
    sent.push({ method, path: url.pathname, query: url.search, body: init?.body ? JSON.parse(String(init.body)) : null })
    const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200 })
    if (url.pathname === "/v2/characters/char-1" && method === "GET") {
      return json({
        id: "char-1", name: "hero", size: { width: 64, height: 64 }, directions: 8, created_at: "now", status: "completed",
        animations: groups.map((g) => ({
          display_name: g.name, animation_type: "custom", animation_group_id: g.id,
          directions: g.directions.map((direction) => ({ direction, frames: [`https://cdn.test/animations/${g.id}-${direction}/frame_0.png`], frame_count: 1 })),
        })),
      })
    }
    if (url.pathname === "/v2/characters/char-1/animations" && method === "DELETE") return json({ success: true, deleted_count: 1 })
    if (url.pathname === "/v2/characters/animations" && method === "POST") {
      const body = JSON.parse(String(init!.body)) as { animation_group_id?: string }
      return json({
        background_job_ids: ["job-1"], directions: ["x"], animation_group_id: body.animation_group_id ?? "grp-new", status: "processing",
        enhanced_prompt: null, enhance_usage: null,
      })
    }
    throw new Error(`unexpected request: ${method} ${url.pathname}`)
  }))
  return sent
}

async function submitAsset(p: Project, assetId: string) {
  const provider = new PixelLabProvider(new (await import("../src/client.ts")).PixelLabClient("key"))
  const plan = await buildPlan(p.specs, p.lock)
  const item = plan.actionable.find((i) => i.spec.assetId === assetId)
  if (!item) throw new Error(`${assetId} is not actionable`)
  await submit(provider, p.loaded, [item], p.lock, p.lockPath, { spacingMs: 0 })
}
const posts = (sent: ReturnType<typeof stubPixelLab>) => sent.filter((call) => call.method === "POST")
const deletes = (sent: ReturnType<typeof stubPixelLab>) => sent.filter((call) => call.method === "DELETE")

describe("submitting a shared motion", () => {
  it("sends the leader as a new animation, then a later direction into the leader's group under its name", async () => {
    const p = await open({ directions: ["south", "west"] })
    const sent = stubPixelLab([])
    upsert(p.lock, "cast/hero", { objectId: "char-1" })
    await submitAsset(p, "hero.cheer.south")
    expect(posts(sent)[0]!.body).toMatchObject({ directions: ["south"], animation_name: "pixelkiln:cast/hero.cheer.south", mode: "skeleton-v3" })
    expect(posts(sent)[0]!.body).not.toHaveProperty("animation_group_id")
    // The submit's own answer names the group the leader is in.
    expect(p.lock.entries["cast/hero.cheer.south"]!.providerMetadata.pixellab).toMatchObject({ character: { animationGroupId: "grp-new" } })
    expect(p.lock.entries["cast/hero.cheer.south"]!.motionShare).toBeUndefined()

    // The leader finishes (a poll records its group and name), and the next wave takes the member.
    await markDownloaded(p, "hero.cheer.south", { providerMetadata: characterMeta("hero.cheer.south", "grp-7", "south", "name-as-recorded") })
    const again = stubPixelLab([{ id: "grp-7", name: "name-as-recorded", directions: ["south"] }])
    await submitAsset(p, "hero.cheer.west")
    expect(posts(again)).toHaveLength(1)
    expect(posts(again)[0]!.body).toMatchObject({
      character_id: "char-1", mode: "skeleton-v3", directions: ["west"], animation_group_id: "grp-7",
      animation_name: "name-as-recorded", action_description: "cheering with both arms raised", frame_count: 6,
    })
    expect(deletes(again)).toEqual([])
    expect(p.lock.entries["cast/hero.cheer.west"]!.motionShare).toEqual({ sourceAssetId: "hero.cheer.south", animationGroupId: "grp-7" })
    expect(p.lock.entries["cast/hero.cheer.west"]!.providerMetadata.pixellab).toMatchObject({ character: { animationGroupId: "grp-7", animationName: "name-as-recorded" } })
  })

  it("adds a direction to a loop that was generated earlier, straight away", async () => {
    const p = await open({ directions: ["south"] })
    await markDownloaded(p, "hero.cheer.south", { providerMetadata: characterMeta("hero.cheer.south", "grp-3", "south") })
    expect((await states(p))["hero.cheer.south"]).toBe("ok")
    const leaderHash = p.specs.find((s) => s.assetId === "hero.cheer.south")!.specHash

    // directions: ["south"] becomes ["south", "west"].
    await writeManifest({ directions: ["south", "west"] })
    const grown = await openProject(manifestPath(), { env: false })
    grown.lock.entries = p.lock.entries
    expect(grown.specs.find((s) => s.assetId === "hero.cheer.south")!.specHash).toBe(leaderHash)
    expect(await states(grown)).toMatchObject({ "hero.cheer.south": "ok", "hero.cheer.west": "missing" })
    const sent = stubPixelLab([{ id: "grp-3", name: "pixelkiln:cast/hero.cheer.south", directions: ["south"] }])
    await submitAsset(grown, "hero.cheer.west")
    expect(posts(sent)[0]!.body).toMatchObject({ directions: ["west"], animation_group_id: "grp-3", animation_name: "pixelkiln:cast/hero.cheer.south" })
  })

  it("draws a member on its own, under its own name, when the leader has no group", async () => {
    const p = await open({ directions: ["south", "west"] })
    await markDownloaded(p, "hero.cheer.south")
    const sent = stubPixelLab([])
    await submitAsset(p, "hero.cheer.west")
    expect(posts(sent)[0]!.body).toMatchObject({ directions: ["west"], animation_name: "pixelkiln:cast/hero.cheer.west" })
    expect(posts(sent)[0]!.body).not.toHaveProperty("animation_group_id")
    expect(p.lock.entries["cast/hero.cheer.west"]!.motionShare).toEqual({ sourceAssetId: "hero.cheer.south", animationGroupId: null })
  })

  it("replaces only its own direction: a member never deletes the leader's, nor the leader a member's", async () => {
    const p = await open({ directions: ["south", "west"] })
    const group = { id: "grp-5", name: "pixelkiln:cast/hero.cheer.south", directions: ["south", "west"] }
    await markDownloaded(p, "hero.cheer.south", { providerMetadata: characterMeta("hero.cheer.south", "grp-5", "south") })
    await markDownloaded(p, "hero.cheer.west", {
      providerMetadata: characterMeta("hero.cheer.south", "grp-5", "west"),
      motionShare: { sourceAssetId: "hero.cheer.south", animationGroupId: "grp-5" },
    }, 40)

    // Redrawing the member: only west leaves the group, then west joins it again.
    let sent = stubPixelLab([group])
    const provider = new PixelLabProvider(new (await import("../src/client.ts")).PixelLabClient("key"))
    const forced = (assetId: string) => [{ spec: p.specs.find((s) => s.assetId === assetId)!, key: `cast/${assetId}`, state: "missing" as const, reason: "--force" }]
    await submit(provider, p.loaded, forced("hero.cheer.west"), p.lock, p.lockPath, { spacingMs: 0 })
    expect(deletes(sent).map((call) => call.query)).toEqual(["?animation_group_id=grp-5&direction=west"])
    expect(posts(sent)[0]!.body).toMatchObject({ directions: ["west"], animation_group_id: "grp-5", animation_name: "pixelkiln:cast/hero.cheer.south" })

    // Redrawing the leader: only south leaves, and it starts a new animation with no group id.
    sent = stubPixelLab([group])
    await markDownloaded(p, "hero.cheer.west", { motionShare: { sourceAssetId: "hero.cheer.south", animationGroupId: "grp-5" } }, 40)
    await submit(provider, p.loaded, forced("hero.cheer.south"), p.lock, p.lockPath, { spacingMs: 0 })
    expect(deletes(sent).map((call) => call.query)).toEqual(["?animation_group_id=grp-5&direction=south"])
    expect(posts(sent)[0]!.body).not.toHaveProperty("animation_group_id")
    expect(posts(sent)[0]!.body).toMatchObject({ directions: ["south"], animation_name: "pixelkiln:cast/hero.cheer.south" })
  })

  it("refuses, before spending, a group that is no longer on the character", async () => {
    const p = await open({ directions: ["south", "west"] })
    await markDownloaded(p, "hero.cheer.south", { providerMetadata: characterMeta("hero.cheer.south", "grp-gone", "south") })
    const sent = stubPixelLab([{ id: "grp-other", name: "other", directions: ["south"] }])
    await submitAsset(p, "hero.cheer.west")
    expect(posts(sent)).toEqual([])
    expect(p.lock.entries["cast/hero.cheer.west"]).toMatchObject({ status: "failed", error: expect.stringMatching(/no longer on the character; regenerate the leading direction first/) })
  })
})

describe("history keeps the link a generation was drawn with", () => {
  it("retires a generation with its link and brings it back on restore", async () => {
    const p = await open({ directions: ["south", "west"] })
    await markDownloaded(p, "hero.cheer.south", { providerMetadata: characterMeta("hero.cheer.south", "grp-1", "south") })
    await markDownloaded(p, "hero.cheer.west", { motionShare: { sourceAssetId: "hero.cheer.south", animationGroupId: "grp-1" } }, 40)
    const old = p.lock.entries["cast/hero.cheer.west"]!
    const west = p.specs.find((s) => s.assetId === "hero.cheer.west")!

    // A second generation, drawn into the leader's next group, with the same bytes so no download is needed.
    const history = historyAfterReplacing(old, 5, "later")
    expect(history![0]!.motionShare).toEqual({ sourceAssetId: "hero.cheer.south", animationGroupId: "grp-1" })
    upsert(p.lock, "cast/hero.cheer.west", { motionShare: { sourceAssetId: "hero.cheer.south", animationGroupId: "grp-2" }, history })
    upsert(p.lock, "cast/hero.cheer.south", { providerMetadata: characterMeta("hero.cheer.south", "grp-2", "south") })
    expect((await states(p))["hero.cheer.west"]).toBe("ok")

    // Back to the first generation: it was drawn into grp-1, which the leader no longer has.
    const offline = { id: "pixellab", download: async () => { throw new Error("offline") } }
    await revertGeneration(offline as never, west, p.lock, p.lockPath, { generation: 1 })
    expect(p.lock.entries["cast/hero.cheer.west"]!.motionShare).toEqual({ sourceAssetId: "hero.cheer.south", animationGroupId: "grp-1" })
    expect((await states(p))["hero.cheer.west"]).toBe("stale")
    // And the generation it replaced is itself restorable, link and all.
    expect(p.lock.entries["cast/hero.cheer.west"]!.history![0]!.motionShare?.animationGroupId).toBe("grp-2")
  })
})

// Computed on the commit before shared motion existed (origin/main at v0.90.0).
const TEMPLATE_LOOP_HASH = "fbbb07597eb44fd6ccd9acdfbf1033178bd399c04d70e22a1af6a32b7d263e43"
const SENTENCE_LOOP_HASH = "820f7e18ab1174d93dfb858237a262cf85699cc6ec134d98bfad83ec888ff768"
const V3_LOOP_HASH = "17bbd89daa2efc923e5d26abbe49740aea4a1ad303560d06b3963a49229750fa"
