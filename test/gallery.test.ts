import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { existsSync } from "node:fs"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { Script } from "node:vm"
import { FakeProvider, FAKE_PNG } from "../src/providers/fake.ts"
import { loadManifest, resolveSpecs } from "../src/manifest.ts"
import { buildPlan } from "../src/pipeline/plan.ts"
import { submit } from "../src/pipeline/submit.ts"
import { poll } from "../src/pipeline/poll.ts"
import { fetchAssets } from "../src/pipeline/fetch.ts"
import { loadLock, saveLock, upsert } from "../src/lock.ts"
import { sha256 } from "../src/hash.ts"
import { lockKey, type Lock } from "../src/types.ts"
import { buildGallerySnapshot, buildWorkspaceGallerySnapshot, galleryMediaId } from "../src/gallery/snapshot.ts"
import { renderGallery } from "../src/gallery/page.ts"
import { serveGallery } from "../src/gallery/server.ts"
import { announceGalleryReady, parseArgs } from "../src/cli.ts"
import {
  applyManifestEdit,
  createGalleryEditHandler,
  ManifestDriftError,
  ManifestEditError,
} from "../src/gallery/edit.ts"
import { sha256File } from "../src/hash.ts"
import { createGenerateHandlers, type GalleryGenerateHandlers, type GenerateJob } from "../src/gallery/generate.ts"
import { normalizeLockOutputPaths } from "../src/outputs.ts"
import type { Provider } from "../src/provider.ts"
import { refineQualityProfiles } from "../src/pipeline/quality-profile.ts"
import { approveQualityRecord } from "../src/pipeline/refine.ts"
import { encodeRgbaPng } from "../src/png.ts"

const fixer = path.resolve("test/fixtures/fake-pixelfixer.mjs")

let dir: string
let lockPath: string

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "pixelkiln-gallery-"))
  lockPath = path.join(dir, "pixelkiln.lock.json")
})
afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

/**
 * A project with one style and three assets in three different situations:
 * `anvil` and `hammer` downloaded through the real pipeline, `sketch` declared
 * but never generated, plus a hand-written `base/ghost` lock entry the
 * manifest no longer declares. That is the spread the gallery exists to show
 * side by side.
 */
async function project(manifestOverride?: Record<string, unknown>) {
  const manifest = manifestOverride ?? {
    name: "gallery-test",
    styles: { base: { generator: "map", outDir: "out", promptSuffix: "clean", palette: ["#101820", "#f2aa4c"] } },
    assets: {
      anvil: { prompt: "an anvil", width: 32, height: 32, category: "tools", tags: ["prop"] },
      hammer: { prompt: "a hammer", width: 32, height: 32 },
      sketch: { prompt: "a sketch", width: 64, height: 32 },
    },
  }
  const manifestPath = path.join(dir, "pixelkiln.manifest.json")
  await writeFile(manifestPath, JSON.stringify(manifest))
  const loaded = await loadManifest(manifestPath)
  const specs = await resolveSpecs(loaded)
  return { loaded, specs, manifestPath }
}

async function generated() {
  const { loaded, specs, manifestPath } = await project()
  const provider = new FakeProvider({ candidates: 1 })
  const lock: Lock = { version: 2, entries: {} }
  const generate = specs.filter((spec) => spec.assetId !== "sketch")
  await submit(provider, loaded, (await buildPlan(generate, lock)).actionable, lock, lockPath, { spacingMs: 0 })
  await poll(provider, lock, lockPath, { intervalMs: 0 })
  await fetchAssets(provider, generate, lock, lockPath, { cacheDir: false })
  upsert(lock, lockKey("base", "ghost"), {
    styleId: "base",
    assetId: "ghost",
    specHash: "f".repeat(64),
    generator: "map",
    prompt: "a ghost",
    width: 16,
    height: 16,
    status: "downloaded",
    outputs: [{ path: "out/ghost.png", sha256: sha256(FAKE_PNG) }],
    cost: 1,
    costUnit: "generations",
    provider: "fake",
    submittedAt: "2026-01-01T00:00:00.000Z",
    downloadedAt: "2026-01-01T00:01:00.000Z",
  })
  await saveLock(lockPath, lock)
  return { loaded, specs, lock, manifestPath }
}

describe("buildGallerySnapshot", () => {
  it("is lock-first: shows downloaded, never-generated, and undeclared work together", async () => {
    const { loaded, specs, lock } = await generated()
    const { snapshot, media } = await buildGallerySnapshot({
      loaded, specs, lock, lockPath, now: () => new Date("2026-09-11T12:00:00Z"),
    })

    expect(snapshot.version).toBe(1)
    expect(snapshot.generatedAt).toBe("2026-09-11T12:00:00.000Z")
    expect(snapshot.project).toMatchObject({ name: "gallery-test", root: dir, lock: lockPath })
    expect(snapshot.items.map((item) => item.key)).toEqual([
      "base/anvil", "base/ghost", "base/hammer", "base/sketch",
    ])
    expect(snapshot.totals).toMatchObject({
      entries: 3,
      items: 4,
      byState: { ok: 2, missing: 1, undeclared: 1 },
      byStatus: { downloaded: 3 },
    })
    expect(snapshot.totals.spendByUnit.generations).toBe(3)

    const anvil = snapshot.items.find((item) => item.key === "base/anvil")!
    expect(anvil).toMatchObject({
      declared: true,
      state: "ok",
      status: "downloaded",
      provider: "fake",
      generator: "map",
      prompt: "an anvil, clean",
      currentPrompt: null,
      width: 32,
      height: 32,
      cost: 1,
      costUnit: "generations",
      candidates: 1,
      category: "tools",
      quality: null,
    })
    // Declared tags plus the routing tags pushed upstream, as `tag` would send them.
    expect(anvil.tags).toEqual(expect.arrayContaining(["prop", "style:base", "asset:anvil"]))
    expect(anvil.recordedSpecHash).toBe(anvil.currentSpecHash)
    expect(anvil.jobId).toBeTruthy()
    expect(anvil.submittedAt).toBeTruthy()
    expect(anvil.asset).toMatchObject({ prompt: "an anvil", category: "tools" })
    expect(anvil.outputs).toHaveLength(1)
    const output = anvil.outputs[0]!
    const bytes = await readFile(path.join(dir, "out", "tools", "anvil.png"))
    expect(output).toMatchObject({
      path: "out/tools/anvil.png",
      absolutePath: path.join(dir, "out", "tools", "anvil.png"),
      sha256: sha256(bytes),
      exists: true,
      bytes: bytes.length,
      mediaType: "image/png",
    })
    const id = galleryMediaId(output.absolutePath)
    expect(output.url).toBe(`/media/${id}?v=${output.sha256!.slice(0, 16)}`)
    expect(media.get(id)).toEqual({ path: output.absolutePath, contentType: "image/png" })

    const sketch = snapshot.items.find((item) => item.key === "base/sketch")!
    expect(sketch).toMatchObject({
      declared: true, state: "missing", status: null, outputs: [], cost: 0, estimatedCost: 1,
      recordedSpecHash: null,
    })
    expect(sketch.currentSpecHash).toMatch(/^[0-9a-f]{64}$/)

    const ghost = snapshot.items.find((item) => item.key === "base/ghost")!
    expect(ghost).toMatchObject({ declared: false, state: "undeclared", asset: null, estimatedCost: null, fps: null })
    expect(ghost.reason).toContain("prune")
    // Its recorded file was never written, so the gallery says so instead of
    // inventing a URL that would 404.
    expect(ghost.outputs[0]).toMatchObject({ exists: false, url: null, sha256: sha256(FAKE_PNG) })

    expect(snapshot.styles).toEqual([
      expect.objectContaining({
        id: "base", provider: "pixellab", generator: "map", outDir: "out",
        palette: ["#101820", "#f2aa4c"], quality: false, items: 4, spendByUnit: { generations: 3 },
      }),
    ])
  })

  it("reports stale work with both prompts and both spec hashes", async () => {
    const { lock, manifestPath } = await generated()
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"))
    manifest.assets.anvil.prompt = "a battered anvil"
    await writeFile(manifestPath, JSON.stringify(manifest))
    const loaded = await loadManifest(manifestPath)
    const specs = await resolveSpecs(loaded, { assets: ["anvil"] })

    const { snapshot } = await buildGallerySnapshot({
      loaded, specs, lock, lockPath, filter: { assets: ["anvil"] },
    })
    const anvil = snapshot.items.find((item) => item.key === "base/anvil")!
    expect(anvil.state).toBe("stale")
    expect(anvil.prompt).toBe("an anvil, clean")
    expect(anvil.currentPrompt).toBe("a battered anvil, clean")
    expect(anvil.currentSpecHash).not.toBe(anvil.recordedSpecHash)
    // The art on disk still belongs to the recorded generation; it stays visible.
    expect(anvil.outputs[0]!.exists).toBe(true)
  })

  it("keeps filters honest: filtered-out declared work is hidden, not called undeclared", async () => {
    const { lock, manifestPath } = await generated()
    const loaded = await loadManifest(manifestPath)
    const specs = await resolveSpecs(loaded, { assets: ["hammer"] })
    const { snapshot } = await buildGallerySnapshot({
      loaded, specs, lock, lockPath, filter: { assets: ["hammer"] },
    })
    expect(snapshot.items.map((item) => item.key)).toEqual(["base/hammer"])
    expect(snapshot.filter).toEqual({ styles: [], assets: ["hammer"] })
    // The lock still has three entries; the filter changes what is shown, not the record.
    expect(snapshot.totals.entries).toBe(3)

    const wide = await buildGallerySnapshot({
      loaded, specs: await resolveSpecs(loaded, { styles: ["base"] }), lock, lockPath,
      filter: { styles: ["base"] },
    })
    expect(wide.snapshot.items.map((item) => item.key)).toContain("base/ghost")
  })

  it("reads a frame set's playback rate from provider metadata", async () => {
    const { loaded, specs, lock } = await generated()
    upsert(lock, lockKey("base", "walk"), {
      styleId: "base", assetId: "walk", specHash: "e".repeat(64), generator: "frames",
      prompt: "walk cycle", width: 16, height: 16, status: "downloaded", provider: "comfyui",
      outputs: [0, 1].map((i) => ({ path: "out/walk-frame-0" + i + ".png", sha256: "0".repeat(64), role: "frame-0" + i })),
      providerMetadata: { comfyui: { frameSet: { count: 2, fps: 8, promptIds: [] } } },
      cost: 0, costUnit: "free",
    })
    const { snapshot } = await buildGallerySnapshot({ loaded, specs, lock, lockPath })
    expect(snapshot.items.find((item) => item.key === "base/walk")).toMatchObject({
      state: "undeclared", generator: "frames", fps: 8,
    })
    expect(snapshot.items.find((item) => item.key === "base/anvil")!.fps).toBeNull()
  })

  it("shows untracked art on disk with no hash and no provenance", async () => {
    const { loaded, specs } = await project()
    const outFile = specs.find((spec) => spec.assetId === "anvil")!.outFile
    await mkdir(path.dirname(outFile), { recursive: true })
    await writeFile(outFile, FAKE_PNG)
    const { snapshot } = await buildGallerySnapshot({
      loaded, specs, lock: { version: 2, entries: {} }, lockPath,
    })
    const anvil = snapshot.items.find((item) => item.key === "base/anvil")!
    expect(anvil.state).toBe("untracked")
    expect(anvil.outputs[0]).toMatchObject({ sha256: null, exists: true, path: "out/tools/anvil.png" })
    expect(anvil.outputs[0]!.url).toMatch(/^\/media\/[0-9a-f]{24}\?v=/)
    expect(snapshot.totals.entries).toBe(0)
  })
})

describe("buildGallerySnapshot quality records", () => {
  it("reads the refinement record behind a quality profile", async () => {
    const source = path.join(dir, "source.png")
    await writeFile(source, encodeRgbaPng(2, 2, Buffer.from([
      12, 18, 24, 255, 245, 240, 235, 255, 70, 70, 70, 0, 180, 180, 180, 96,
    ])))
    const { loaded, specs } = await project({
      name: "quality-gallery",
      styles: {
        base: {
          generator: "map", size: 16, outDir: "art/raw",
          quality: { outDir: "art/final", palette: ["#000000", "#ffffff"], minGridConfidence: "high" },
        },
      },
      assets: { keep: { prompt: "a mountain keep", source: "source.png" } },
    })
    const lock: Lock = { version: 2, entries: {} }

    const { snapshot: before } = await buildGallerySnapshot({ loaded, specs, lock, lockPath })
    expect(before.items[0]!.quality).toMatchObject({
      state: "needs-refinement", recordExists: false, review: null, palette: null,
      output: "art/final/keep.png", record: "art/final/keep.pixelkiln.json",
    })
    expect(before.items[0]!.quality!.outputs[0]).toMatchObject({ exists: false, url: null })
    // Committed `source` art is what the gallery shows for a placed asset.
    expect(before.items[0]).toMatchObject({ state: "ok", status: null, source: "source.png" })
    expect(before.items[0]!.outputs[0]).toMatchObject({ path: "source.png", exists: true, sha256: null })

    await refineQualityProfiles(specs, lock, { fixerCommand: process.execPath, fixerArgsPrefix: [fixer] })
    await approveQualityRecord(path.join(dir, "art/final/keep.pixelkiln.json"), {
      reviewer: "Ada", note: "crisp at 1×", approvedAt: new Date("2026-09-05T12:00:00.000Z"),
    })

    const { snapshot, media } = await buildGallerySnapshot({ loaded, specs, lock, lockPath })
    const quality = snapshot.items[0]!.quality!
    expect(quality).toMatchObject({
      state: "approved",
      recordExists: true,
      palette: ["#000000", "#ffffff"],
      review: { status: "approved", reviewer: "Ada", approvedAt: "2026-09-05T12:00:00.000Z", note: "crisp at 1×" },
      audit: { safe: true },
      frameSet: null,
      check: { safe: true, current: true, reasons: [] },
    })
    expect(quality.nativeGrid).toMatchObject({ confidence: "high", sourceWidth: 2, sourceHeight: 2 })
    const refined = quality.outputs[0]!
    expect(refined).toMatchObject({ path: "art/final/keep.png", exists: true })
    expect(refined.url).toMatch(/^\/media\/[0-9a-f]{24}\?v=/)
    expect(media.has(galleryMediaId(refined.absolutePath))).toBe(true)
  })
})

describe("buildWorkspaceGallerySnapshot", () => {
  it("namespaces every registered project and reports an unreadable one inline", async () => {
    // Two real projects with colliding lock keys, one catalog entry that does
    // not exist, and a catalog directory that is not either project's root.
    const first = await generated()
    const second = path.join(dir, "second")
    await mkdir(second, { recursive: true })
    const secondManifest = {
      name: "second-project",
      styles: { base: { generator: "map", outDir: "out", promptSuffix: "worn" } },
      assets: { anvil: { prompt: "an anvil", width: 16, height: 16 } },
    }
    await writeFile(path.join(second, "pixelkiln.manifest.json"), JSON.stringify(secondManifest))
    await writeFile(path.join(second, "pixelkiln.lock.json"), JSON.stringify({ version: 2, entries: {} }))
    const catalogDir = path.join(dir, "catalog")
    await mkdir(catalogDir, { recursive: true })
    const workspacePath = path.join(catalogDir, "pixelkiln.workspace.json")
    const workspace = {
      version: 1 as const,
      projects: [
        { id: "alpha", manifest: "../pixelkiln.manifest.json", lock: "../pixelkiln.lock.json", provider: "pixellab" },
        { id: "beta", manifest: "../second/pixelkiln.manifest.json", lock: "../second/pixelkiln.lock.json", provider: "pixellab", account: "sandbox" },
        { id: "ghost-project", manifest: "../nowhere/pixelkiln.manifest.json", lock: "../nowhere/pixelkiln.lock.json", provider: "pixellab" },
      ],
    }

    const { snapshot, media } = await buildWorkspaceGallerySnapshot({
      workspace, workspacePath, now: () => new Date("2026-09-11T12:00:00Z"),
    })
    expect(snapshot.project).toBeNull()
    expect(snapshot.workspace).toMatchObject({ path: workspacePath, dir: catalogDir })
    expect(snapshot.workspace!.projects.map((p) => [p.id, p.items, p.entries, p.error === null])).toEqual([
      ["alpha", 4, 3, true],
      ["beta", 1, 0, true],
      ["ghost-project", 0, 0, false],
    ])
    expect(snapshot.workspace!.projects[1]).toMatchObject({ name: "second-project", account: "sandbox" })
    expect(snapshot.workspace!.projects[2]!.error).toMatch(/No manifest at/)

    // Both projects own `base/anvil`; ids keep them apart, keys stay honest.
    const anvils = snapshot.items.filter((item) => item.key === "base/anvil")
    expect(anvils.map((item) => [item.id, item.project, item.state])).toEqual([
      ["alpha:base/anvil", "alpha", "ok"],
      ["beta:base/anvil", "beta", "missing"],
    ])
    expect(snapshot.styles.map((style) => `${style.project}/${style.id}`)).toEqual(["alpha/base", "beta/base"])
    expect(snapshot.totals).toMatchObject({ entries: 3, items: 5, byState: { ok: 2, missing: 2, undeclared: 1 } })
    expect(snapshot.totals.spendByUnit.generations).toBe(3)
    // Media from every readable project is served through one allowlist.
    const alphaAnvil = anvils[0]!.outputs[0]!
    expect(media.get(galleryMediaId(alphaAnvil.absolutePath))?.path).toBe(alphaAnvil.absolutePath)
    expect(renderGallery(snapshot)).toContain("<title>pixelkiln — workspace</title>")
    void first
  })

  it("applies --style/--only per project instead of failing a project that lacks the id", async () => {
    await generated()
    const other = path.join(dir, "other")
    await mkdir(other, { recursive: true })
    await writeFile(path.join(other, "pixelkiln.manifest.json"), JSON.stringify({
      name: "other", styles: { neon: { generator: "map", outDir: "out" } }, assets: { sign: { prompt: "a sign", width: 16, height: 16 } },
    }))
    const workspacePath = path.join(dir, "pixelkiln.workspace.json")
    const workspace = {
      version: 1 as const,
      projects: [
        { id: "alpha", manifest: "pixelkiln.manifest.json", lock: "pixelkiln.lock.json", provider: "pixellab" },
        { id: "other", manifest: "other/pixelkiln.manifest.json", lock: "other/pixelkiln.lock.json", provider: "pixellab" },
      ],
    }
    const { snapshot } = await buildWorkspaceGallerySnapshot({
      workspace, workspacePath, filter: { styles: ["base"], assets: ["hammer"] },
    })
    expect(snapshot.filter).toEqual({ styles: ["base"], assets: ["hammer"] })
    expect(snapshot.items.map((item) => item.id)).toEqual(["alpha:base/hammer"])
    expect(snapshot.workspace!.projects.map((p) => [p.id, p.items, p.error])).toEqual([
      ["alpha", 1, null],
      ["other", 0, null],
    ])
  })
})

describe("renderGallery", () => {
  it("embeds the snapshot without letting a prompt close the script tag", async () => {
    const { loaded, specs, lock } = await generated()
    lock.entries["base/anvil"]!.prompt = "</script><img src=x onerror=alert(1)><!-- -->"
    const { snapshot } = await buildGallerySnapshot({ loaded, specs, lock, lockPath })
    const html = renderGallery(snapshot)
    expect(html).toContain("<title>pixelkiln — gallery-test</title>")
    expect(html).toContain("const INITIAL = {")
    expect(html).not.toContain("</script><img")
    expect(html).toContain("<\\/script><img")
    expect(html).toContain("<\\u0021-- -->")
    // The JSON is still valid after escaping.
    const start = html.indexOf("const INITIAL = ") + "const INITIAL = ".length
    const end = html.indexOf(";\nconst SESSION = ")
    expect(JSON.parse(html.slice(start, end))).toEqual(snapshot)
    expect(html).toContain("const SESSION = null;")
    expect(renderGallery(snapshot, { session: "abc123" })).toContain('const SESSION = "abc123";')
  })

  it("emits a page script that compiles", async () => {
    // The page is authored inside a template literal, so a stray escape turns
    // into a real newline in the emitted JS. Compiling (not running) the
    // script catches that before a browser shows an empty gallery.
    const { loaded, specs, lock } = await generated()
    const { snapshot } = await buildGallerySnapshot({ loaded, specs, lock, lockPath })
    const html = renderGallery(snapshot)
    const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]!)
    expect(scripts).toHaveLength(1)
    expect(() => new Script(scripts[0]!, { filename: "gallery.js" })).not.toThrow()
  })
})

describe("serveGallery", () => {
  it("serves the page, a fresh JSON snapshot, and only allowlisted media", async () => {
    const { loaded, specs, lock } = await generated()
    let loads = 0
    const ready: string[] = []
    const server = await serveGallery({
      open: false,
      load: async () => {
        loads++
        return buildGallerySnapshot({ loaded, specs, lock, lockPath })
      },
      onReady: (url) => ready.push(url),
    })
    try {
      expect(ready).toEqual([server.url])
      expect(server.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/$/)

      const page = await fetch(server.url)
      expect(page.status).toBe(200)
      expect(page.headers.get("content-type")).toContain("text/html")
      expect(await page.text()).toContain("gallery-test")
      expect(loads).toBe(1)

      const api = await fetch(new URL("/api/gallery.json", server.url))
      expect(api.status).toBe(200)
      const snapshot = await api.json()
      expect(snapshot.items.map((item: { key: string }) => item.key)).toContain("base/anvil")
      expect(loads).toBe(2)

      const anvil = snapshot.items.find((item: { key: string }) => item.key === "base/anvil")
      const mediaUrl = new URL(anvil.outputs[0].url, server.url)
      const png = await fetch(mediaUrl)
      expect(png.status).toBe(200)
      expect(png.headers.get("content-type")).toBe("image/png")
      expect(png.headers.get("x-content-type-options")).toBe("nosniff")
      const onDisk = await readFile(anvil.outputs[0].absolutePath)
      expect(Buffer.from(await png.arrayBuffer()).equals(onDisk)).toBe(true)

      // Routes are an allowlist of the snapshot's own files: an unknown id,
      // a path-shaped request, and the lockfile itself are all unreachable.
      expect((await fetch(new URL("/media/" + "0".repeat(24), server.url))).status).toBe(404)
      expect((await fetch(new URL("/media/../pixelkiln.lock.json", server.url))).status).toBe(404)
      expect((await fetch(new URL("/pixelkiln.lock.json", server.url))).status).toBe(404)
      expect((await fetch(new URL("/media/" + galleryMediaId(lockPath), server.url))).status).toBe(404)

      const post = await fetch(new URL("/api/gallery.json", server.url), { method: "POST" })
      expect(post.status).toBe(405)
    } finally {
      await server.close()
    }
    await expect(fetch(server.url)).rejects.toThrow()
  })

  it("reflects a refresh: work finished after startup appears without a restart", async () => {
    const { loaded, specs, manifestPath } = await project()
    const server = await serveGallery({
      open: false,
      load: async () => buildGallerySnapshot({
        loaded, specs, lock: await loadLock(lockPath), lockPath,
      }),
    })
    try {
      const before = await (await fetch(new URL("/api/gallery.json", server.url))).json()
      expect(before.totals.entries).toBe(0)
      expect(before.items.every((item: { state: string }) => item.state === "missing")).toBe(true)

      const provider = new FakeProvider({ candidates: 1 })
      const lock: Lock = { version: 2, entries: {} }
      const one = specs.filter((spec) => spec.assetId === "anvil")
      await submit(provider, await loadManifest(manifestPath), (await buildPlan(one, lock)).actionable, lock, lockPath, { spacingMs: 0 })
      await poll(provider, lock, lockPath, { intervalMs: 0 })
      await fetchAssets(provider, one, lock, lockPath, { cacheDir: false })
      await saveLock(lockPath, lock)

      const after = await (await fetch(new URL("/api/gallery.json", server.url))).json()
      expect(after.totals.entries).toBe(1)
      const anvil = after.items.find((item: { key: string }) => item.key === "base/anvil")
      expect(anvil.state).toBe("ok")
      const png = await fetch(new URL(anvil.outputs[0].url, server.url))
      expect(png.status).toBe(200)
    } finally {
      await server.close()
    }
  })
})

describe("applyManifestEdit", () => {
  it("patches one asset in place, keeps the author's formatting, and makes the work stale", async () => {
    const { loaded, lock, manifestPath } = await generated()
    // Re-write the manifest with four-space indentation and a trailing newline
    // so the edit has something to preserve.
    const pretty = JSON.stringify(JSON.parse(await readFile(manifestPath, "utf8")), null, 4) + "\n"
    await writeFile(manifestPath, pretty)
    const expectedSha256 = await sha256File(manifestPath)

    const result = await applyManifestEdit(manifestPath, {
      action: "patch-asset",
      assetId: "anvil",
      expectedSha256,
      patch: { prompt: "a battered anvil", category: null, tags: ["prop", "iron"], width: 48 },
    })
    expect(result).toMatchObject({ manifestPath, changed: true })
    const text = await readFile(manifestPath, "utf8")
    expect(text.endsWith("\n")).toBe(true)
    expect(text).toContain("\n    \"assets\": {")
    expect(text).toContain("\n        \"anvil\": {")
    const written = JSON.parse(text)
    expect(written.assets.anvil).toEqual({ prompt: "a battered anvil", width: 48, height: 32, tags: ["prop", "iron"] })
    expect(written.assets.hammer).toEqual({ prompt: "a hammer", width: 32, height: 32 })
    expect(result.sha256).toBe(await sha256File(manifestPath))

    // The change is visible through the same offline path as `plan`.
    const specs = await resolveSpecs(await loadManifest(manifestPath))
    const { snapshot } = await buildGallerySnapshot({ loaded: await loadManifest(manifestPath), specs, lock, lockPath })
    const anvil = snapshot.items.find((item) => item.key === "base/anvil")!
    expect(anvil.state).toBe("stale")
    expect(anvil.currentPrompt).toBe("a battered anvil, clean")
    expect(anvil.width).toBe(32) // the recorded generation is still 32×32
    expect(anvil.asset).toMatchObject({ width: 48 })
    void loaded
  })

  it("sets and clears a per-style prompt", async () => {
    const { manifestPath } = await generated()
    const one = await applyManifestEdit(manifestPath, {
      action: "patch-asset", assetId: "anvil", expectedSha256: await sha256File(manifestPath),
      patch: { promptForStyle: { styleId: "base", prompt: "an anvil, for base" } },
    })
    expect(JSON.parse(await readFile(manifestPath, "utf8")).assets.anvil.promptByStyle).toEqual({ base: "an anvil, for base" })
    const two = await applyManifestEdit(manifestPath, {
      action: "patch-asset", assetId: "anvil", expectedSha256: one.sha256,
      patch: { promptForStyle: { styleId: "base", prompt: null } },
    })
    expect(two.changed).toBe(true)
    expect(JSON.parse(await readFile(manifestPath, "utf8")).assets.anvil).not.toHaveProperty("promptByStyle")
    await expect(applyManifestEdit(manifestPath, {
      action: "patch-asset", assetId: "anvil", expectedSha256: two.sha256,
      patch: { promptForStyle: { styleId: "nope", prompt: "x" } },
    })).rejects.toThrow(/unknown style "nope"/)
  })

  it("refuses to write over a manifest that changed since the page loaded", async () => {
    const { manifestPath } = await generated()
    const stale = await sha256File(manifestPath)
    await writeFile(manifestPath, (await readFile(manifestPath, "utf8")) + "\n")
    await expect(applyManifestEdit(manifestPath, {
      action: "patch-asset", assetId: "anvil", expectedSha256: stale, patch: { prompt: "changed" },
    })).rejects.toBeInstanceOf(ManifestDriftError)
    expect(JSON.parse(await readFile(manifestPath, "utf8")).assets.anvil.prompt).toBe("an anvil")
  })

  it("never lands a manifest the loader would reject", async () => {
    const { manifestPath } = await generated()
    const before = await readFile(manifestPath, "utf8")
    const expectedSha256 = await sha256File(manifestPath)
    // width 8 is below the schema minimum; a missing asset id is unknown.
    await expect(applyManifestEdit(manifestPath, {
      action: "patch-asset", assetId: "anvil", expectedSha256, patch: { width: 8 },
    })).rejects.toBeInstanceOf(ManifestEditError)
    await expect(applyManifestEdit(manifestPath, {
      action: "patch-asset", assetId: "nobody", expectedSha256, patch: { prompt: "x" },
    })).rejects.toThrow(/not declared/)
    expect(await readFile(manifestPath, "utf8")).toBe(before)
    // No temp file is left behind by the rejected validation.
    const { readdir } = await import("node:fs/promises")
    expect((await readdir(dir)).filter((name) => name.includes(".tmp"))).toEqual([])
  })

  it("adds a new asset, optionally restricted to one style, and refuses duplicates", async () => {
    const { manifestPath } = await generated()
    const result = await applyManifestEdit(manifestPath, {
      action: "add-asset", assetId: "tongs", expectedSha256: await sha256File(manifestPath),
      asset: { prompt: "blacksmith tongs", width: 32, height: 16, styles: ["base"], tags: [] },
    })
    expect(result.changed).toBe(true)
    const written = JSON.parse(await readFile(manifestPath, "utf8"))
    expect(written.assets.tongs).toEqual({ prompt: "blacksmith tongs", width: 32, height: 16, styles: ["base"] })
    await expect(applyManifestEdit(manifestPath, {
      action: "add-asset", assetId: "tongs", expectedSha256: result.sha256, asset: { prompt: "again" },
    })).rejects.toThrow(/already exists/)
    await expect(applyManifestEdit(manifestPath, {
      action: "add-asset", assetId: "bellows", expectedSha256: result.sha256,
      asset: { prompt: "bellows", styles: ["missing-style"] },
    })).rejects.toThrow(/unknown style/)
    const specs = await resolveSpecs(await loadManifest(manifestPath))
    expect(specs.map((spec) => spec.assetId)).toContain("tongs")
  })
})

describe("serveGallery with --edit", () => {
  it("accepts a same-origin edit with the session token and refuses everything else", async () => {
    const { loaded, specs, lock, manifestPath } = await generated()
    const reload = async () => buildGallerySnapshot({
      loaded: await loadManifest(manifestPath),
      specs: await resolveSpecs(await loadManifest(manifestPath)),
      lock, lockPath,
    })
    const readOnly = await serveGallery({ open: false, load: reload })
    try {
      const res = await fetch(new URL("/api/edit", readOnly.url), {
        method: "POST", headers: { "Content-Type": "application/json", Origin: readOnly.url.replace(/\/$/, "") }, body: "{}",
      })
      expect(res.status).toBe(405)
      expect(readOnly.session).toBeNull()
    } finally {
      await readOnly.close()
    }

    const server = await serveGallery({
      open: false,
      load: reload,
      edit: createGalleryEditHandler({ manifestFor: () => manifestPath, reload }),
    })
    try {
      expect(server.session).toMatch(/^[0-9a-f]{32}$/)
      const page = await (await fetch(server.url)).text()
      expect(page).toContain(`const SESSION = "${server.session}";`)
      const origin = server.url.replace(/\/$/, "")
      const before = (await (await fetch(new URL("/api/gallery.json", server.url))).json()) as { project: { manifestSha256: string } }
      const post = (headers: Record<string, string>, body: unknown) => fetch(new URL("/api/edit", server.url), {
        method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(body),
      })
      const edit = {
        action: "patch-asset", assetId: "anvil", expectedSha256: before.project.manifestSha256, patch: { prompt: "a gilded anvil" },
      }

      expect((await post({ Origin: "http://evil.example", "X-Pixelkiln-Session": server.session! }, edit)).status).toBe(403)
      expect((await post({ Origin: origin }, edit)).status).toBe(403)
      expect((await post({ Origin: origin, "X-Pixelkiln-Session": "0".repeat(32) }, edit)).status).toBe(403)
      const invalid = await post({ Origin: origin, "X-Pixelkiln-Session": server.session! }, { action: "patch-asset" })
      expect(invalid.status).toBe(400)
      expect(await invalid.text()).toMatch(/invalid edit/)
      expect(JSON.parse(await readFile(manifestPath, "utf8")).assets.anvil.prompt).toBe("an anvil")

      const ok = await post({ Origin: origin, "X-Pixelkiln-Session": server.session! }, edit)
      expect(ok.status).toBe(200)
      const after = (await ok.json()) as { items: Array<{ key: string; state: string; currentPrompt: string | null }>; project: { manifestSha256: string } }
      expect(after.items.find((item) => item.key === "base/anvil")).toMatchObject({ state: "stale", currentPrompt: "a gilded anvil, clean" })
      expect(after.project.manifestSha256).not.toBe(before.project.manifestSha256)
      expect(JSON.parse(await readFile(manifestPath, "utf8")).assets.anvil.prompt).toBe("a gilded anvil")

      // Replaying the old hash is a conflict, and nothing is written.
      const replay = await post({ Origin: origin, "X-Pixelkiln-Session": server.session! }, edit)
      expect(replay.status).toBe(409)
      expect(await replay.text()).toMatch(/changed on disk/)
    } finally {
      await server.close()
    }
  })
})

/** Poll a job until it leaves the active phases the test is not waiting on. */
async function untilPhase(handlers: GalleryGenerateHandlers, id: string, phases: string[]): Promise<GenerateJob> {
  for (let i = 0; i < 500; i++) {
    const job = handlers.status().jobs.find((candidate) => candidate.id === id)!
    if (phases.includes(job.phase)) return job
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error(`job ${id} did not reach ${phases.join("/")}`)
}

function generateHandlers(
  manifestPath: string,
  provider: Provider,
  budget: { amount?: number; byProvider: Record<string, number> },
) {
  const loadProject = async () => {
    const loaded = await loadManifest(manifestPath)
    const specs = await resolveSpecs(loaded)
    const lock = await loadLock(lockPath)
    normalizeLockOutputPaths(lock, specs)
    return { loaded, specs, lock, lockPath }
  }
  const reload = async () => {
    const ctx = await loadProject()
    return buildGallerySnapshot({ loaded: ctx.loaded, specs: ctx.specs, lock: ctx.lock, lockPath })
  }
  return createGenerateHandlers({
    loadProject,
    providerFor: () => provider,
    budget,
    reload,
    pollIntervalMs: 0,
    submitSpacingMs: 0,
  })
}

describe("createGenerateHandlers", () => {
  it("runs submit, poll, and fetch as a job and charges the session budget", async () => {
    const { manifestPath } = await project()
    const provider = new FakeProvider({ candidates: 1 })
    const handlers = generateHandlers(manifestPath, provider, { amount: 3, byProvider: {} })

    const job = await handlers.start({ keys: ["base/anvil", "base/hammer"] })
    expect(job).toMatchObject({ mode: "generate", keys: ["base/anvil", "base/hammer"], project: null })
    const done = await untilPhase(handlers, job.id, ["done", "failed"])
    expect(done.error).toBeNull()
    expect(done).toMatchObject({ phase: "done", counts: { submitted: 2, failed: 0, downloaded: 2 }, review: [] })
    // Spend is keyed by the provider the plan grouped on — the manifest's id,
    // which a real adapter also reports as its own.
    expect(done.spent).toEqual({ pixellab: 2 })
    expect(done.messages.join("\n")).toMatch(/pixellab: submitted 2, failed 0, estimated 2 generations/)

    const status = handlers.status()
    expect(status.spent).toEqual({ pixellab: 2 })
    expect(status.units).toEqual({ pixellab: "generations" })
    const lock = await loadLock(lockPath)
    expect(lock.entries["base/anvil"]).toMatchObject({ status: "downloaded", cost: 1 })
    expect(existsSync(path.join(dir, "out", "tools", "anvil.png"))).toBe(true)

    // The remaining budget is 1; a third asset would fit, a regenerate of both would not.
    await expect(handlers.start({ keys: ["base/anvil", "base/hammer"], force: true }))
      .rejects.toThrow(/would spend 2 generations but only 1 generation of this session's budget remain/)
    // Up-to-date work is not actionable without force.
    await expect(handlers.start({ keys: ["base/anvil"] })).rejects.toThrow(/nothing to generate; base\/anvil: ok/)
    const third = await handlers.start({ keys: ["base/sketch"] })
    expect((await untilPhase(handlers, third.id, ["done", "failed"])).phase).toBe("done")
    expect(handlers.status().spent).toEqual({ pixellab: 3 })
    await expect(handlers.start({ keys: ["base/anvil"], force: true })).rejects.toThrow(/only 0 generations/)
  })

  it("refuses unknown keys, keys another job holds, and providers with no budget", async () => {
    const { manifestPath } = await project()
    const provider = new FakeProvider({ candidates: 1, processingPolls: 50 })
    const handlers = generateHandlers(manifestPath, provider, { amount: undefined, byProvider: { pixellab: 10 } })
    await expect(handlers.start({ keys: ["base/nobody"] })).rejects.toThrow(/not declared/)
    await expect(handlers.start({ keys: [] })).rejects.toThrow(/invalid request/)
    const job = await handlers.start({ keys: ["base/anvil"] })
    await expect(handlers.start({ keys: ["base/anvil"], force: true })).rejects.toMatchObject({ status: 409 })
    await untilPhase(handlers, job.id, ["done", "failed"])

    const unbudgeted = generateHandlers(manifestPath, provider, { amount: undefined, byProvider: { retrodiffusion: 10 } })
    await expect(unbudgeted.start({ keys: ["base/hammer"] })).rejects.toThrow(/No session budget for pixellab/)
  })

  it("parks candidate sets in review and finishes after the sheet applies", async () => {
    const { manifestPath } = await project({
      name: "review-test",
      styles: { base: { generator: "1dir", size: 64, outDir: "out", promptSuffix: "clean" } },
      assets: { anvil: { prompt: "an anvil" } },
    })
    const provider = new FakeProvider({ candidates: 4 })
    const handlers = generateHandlers(manifestPath, provider, { amount: 100, byProvider: {} })
    const job = await handlers.start({ keys: ["base/anvil"] })
    const parked = await untilPhase(handlers, job.id, ["review", "done", "failed"])
    expect(parked.phase).toBe("review")
    expect(parked.review).toEqual(["base/anvil"])
    expect(parked.finishedAt).toBeNull()
    expect((await loadLock(lockPath)).entries["base/anvil"]!.status).toBe("review")

    const session = await handlers.review(job.id, { routePrefix: "/review/" + job.id })
    expect(session).not.toBeNull()
    expect(session!.groups.map((group) => [group.key, group.frameUrls.length])).toEqual([["base/anvil", 4]])
    const html = session!.html({ applyUrl: `/review/${job.id}/apply`, embedded: true })
    expect(html).toContain(`"url":"/review/${job.id}/apply"`)
    expect(html).toContain('"embedded":true')

    const result = await handlers.applyReview(job.id, { selections: [{ key: "base/anvil", index: 2 }] })
    expect(result).toEqual({ selected: 1, skipped: 0 })
    const finished = await untilPhase(handlers, job.id, ["done", "failed"])
    expect(finished).toMatchObject({ phase: "done", review: [], counts: { downloaded: 1 } })
    expect((await loadLock(lockPath)).entries["base/anvil"]).toMatchObject({ status: "downloaded", candidateIndex: 2 })
    // The sheet is gone once applied; a second apply has nothing to act on.
    await expect(handlers.applyReview(job.id, { selections: [] })).rejects.toMatchObject({ status: 404 })
  })

  it("resumes existing provider work without charging anything", async () => {
    const { loaded, specs, manifestPath } = await project()
    const provider = new FakeProvider({ candidates: 1 })
    const lock: Lock = { version: 2, entries: {} }
    const one = specs.filter((spec) => spec.assetId === "hammer")
    await submit(provider, loaded, (await buildPlan(one, lock)).actionable, lock, lockPath, { spacingMs: 0 })
    await saveLock(lockPath, lock)
    expect(["pending", "processing"]).toContain(lock.entries["base/hammer"]!.status)

    const handlers = generateHandlers(manifestPath, provider, { amount: 0, byProvider: {} })
    const job = await handlers.start({ keys: ["base/hammer"], resume: true })
    expect(job.mode).toBe("resume")
    const done = await untilPhase(handlers, job.id, ["done", "failed"])
    expect(done).toMatchObject({ phase: "done", spent: {}, counts: { submitted: 0, downloaded: 1 } })
    expect(handlers.status().spent).toEqual({})
    expect((await loadLock(lockPath)).entries["base/hammer"]!.status).toBe("downloaded")
  })
})

describe("serveGallery with a session budget", () => {
  it("starts jobs, reports them, and hosts the review sheet behind the same guards", async () => {
    const { manifestPath } = await project({
      name: "review-test",
      styles: { base: { generator: "1dir", size: 64, outDir: "out", promptSuffix: "clean" } },
      assets: { anvil: { prompt: "an anvil" } },
    })
    const provider = new FakeProvider({ candidates: 4 })
    const handlers = generateHandlers(manifestPath, provider, { amount: 100, byProvider: {} })
    const reload = async () => {
      const loaded = await loadManifest(manifestPath)
      const specs = await resolveSpecs(loaded)
      return buildGallerySnapshot({ loaded, specs, lock: await loadLock(lockPath), lockPath })
    }
    const server = await serveGallery({ open: false, load: reload, generate: handlers })
    try {
      const origin = server.url.replace(/\/$/, "")
      const page = await (await fetch(server.url)).text()
      expect(page).toContain("const GENERATION = true;")
      expect(page).toContain("const EDITABLE = false;")
      const post = (url: string, headers: Record<string, string>, body: unknown) => fetch(new URL(url, server.url), {
        method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(body),
      })
      expect((await post("/api/generate", { Origin: origin }, { keys: ["base/anvil"] })).status).toBe(403)
      expect((await post("/api/generate", { Origin: "http://evil.example", "X-Pixelkiln-Session": server.session! }, { keys: ["base/anvil"] })).status).toBe(403)
      expect((await post("/api/edit", { Origin: origin, "X-Pixelkiln-Session": server.session! }, {})).status).toBe(405)

      const started = await post("/api/generate", { Origin: origin, "X-Pixelkiln-Session": server.session! }, { keys: ["base/anvil"] })
      expect(started.status).toBe(202)
      const job = (await started.json()) as GenerateJob
      const parked = await untilPhase(handlers, job.id, ["review", "done", "failed"])
      expect(parked.phase).toBe("review")

      const status = await (await fetch(new URL("/api/jobs", server.url))).json() as { jobs: GenerateJob[]; budget: unknown; spent: Record<string, number> }
      expect(status.jobs.map((candidate) => [candidate.id, candidate.phase])).toEqual([[job.id, "review"]])
      expect(status.spent).toEqual({ pixellab: 40 })

      const sheet = await fetch(new URL(`/review/${job.id}`, server.url))
      expect(sheet.status).toBe(200)
      const sheetHtml = await sheet.text()
      expect(sheetHtml).toContain("pick candidates")
      expect(sheetHtml).toContain(`"url":"/review/${job.id}/apply"`)
      expect(sheetHtml).toContain(`"X-Pixelkiln-Session":"${server.session}"`)
      expect((await fetch(new URL(`/review/${"0".repeat(16)}`, server.url))).status).toBe(404)

      expect((await post(`/review/${job.id}/apply`, { Origin: origin }, { selections: [] })).status).toBe(403)
      const applied = await post(`/review/${job.id}/apply`, { Origin: origin, "X-Pixelkiln-Session": server.session! }, { selections: [{ key: "base/anvil", index: 0 }] })
      expect(applied.status).toBe(200)
      expect(await applied.json()).toEqual({ selected: 1, skipped: 0 })
      const finished = await untilPhase(handlers, job.id, ["done", "failed"])
      expect(finished.phase).toBe("done")
      const after = await (await fetch(new URL("/api/gallery.json", server.url))).json() as { items: Array<{ key: string; state: string }> }
      expect(after.items.find((item) => item.key === "base/anvil")?.state).toBe("ok")
    } finally {
      await server.close()
    }
  })
})

describe("gallery CLI surface", () => {
  it("parses gallery with its server and filter flags", () => {
    expect(parseArgs(["gallery"])).toMatchObject({ command: "gallery", json: false, noOpen: false, workspace: undefined })
    expect(parseArgs(["gallery", "--workspace", "pixelkiln.workspace.json", "--json"]))
      .toMatchObject({ command: "gallery", workspace: "pixelkiln.workspace.json", json: true })
    expect(parseArgs(["gallery", "--edit"])).toMatchObject({ command: "gallery", edit: true })
    expect(parseArgs(["gallery", "--budget", "80"])).toMatchObject({ command: "gallery", budget: 80 })
    expect(parseArgs(["gallery", "--budget", "pixellab=40", "--budget", "retrodiffusion=1.5"]).providerBudgets)
      .toEqual({ pixellab: 40, retrodiffusion: 1.5 })
    expect(parseArgs(["plan"]).edit).toBe(false)
    expect(parseArgs(["gallery", "--port", "4321", "--no-open", "--json", "--style", "base", "--only", "anvil"]))
      .toMatchObject({ command: "gallery", port: 4321, noOpen: true, json: true, styles: ["base"], assets: ["anvil"] })
    expect(() => parseArgs(["gallery", "base"])).toThrow(/Unexpected argument/)
  })

  it("announces the URL on stderr when stdout is piped", () => {
    const out: string[] = []
    const err: string[] = []
    announceGalleryReady("http://127.0.0.1:1234/", 3,
      { isTTY: false, write: (chunk: string) => out.push(chunk) },
      { isTTY: true, write: (chunk: string) => err.push(chunk) })
    expect(out).toEqual([])
    expect(err.join("")).toContain("gallery of 3 generations: http://127.0.0.1:1234/")

    announceGalleryReady("http://127.0.0.1:1234/", 1,
      { isTTY: true, write: (chunk: string) => out.push(chunk) },
      { isTTY: false, write: (chunk: string) => err.push(chunk) })
    expect(out.join("")).toContain("gallery of 1 generation:")
  })
})
