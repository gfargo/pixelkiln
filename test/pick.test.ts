import { describe, expect, it, beforeEach, afterEach, vi } from "vitest"
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { FakeProvider, FAKE_PNG } from "../src/providers/fake.ts"
import { loadManifest, resolveSpecs } from "../src/manifest.ts"
import { buildPlan } from "../src/pipeline/plan.ts"
import { submit } from "../src/pipeline/submit.ts"
import { poll } from "../src/pipeline/poll.ts"
import { runPicker } from "../src/pick/server.ts"
import { lockKey, type Lock } from "../src/types.ts"

let dir: string
let lockPath: string
beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "pixelkiln-pick-"))
  lockPath = path.join(dir, "pixelkiln.lock.json")
})
afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

/** Drives the real submit → poll pipeline so the resulting lock entry is
 *  genuinely in review status, rather than hand-authoring one. */
async function projectInReview(candidates = 4) {
  const manifest = {
    name: "itest",
    styles: { base: { generator: "1dir", size: 64, outDir: "out", promptSuffix: "clean" } },
    assets: { anvil: { prompt: "an anvil", category: "tools" } },
  }
  const manifestPath = path.join(dir, "pixelkiln.manifest.json")
  await writeFile(manifestPath, JSON.stringify(manifest))
  const loaded = await loadManifest(manifestPath)
  const specs = await resolveSpecs(loaded)
  const provider = new FakeProvider({ candidates })
  const lock: Lock = { version: 2, entries: {} }
  await submit(provider, loaded, (await buildPlan(specs, lock)).actionable, lock, lockPath, { spacingMs: 0 })
  await poll(provider, lock, lockPath, { intervalMs: 0 })
  return { provider, lock, specs }
}

describe("runPicker", () => {
  it("returns immediately without starting a server when nothing is in review", async () => {
    const provider = new FakeProvider()
    const res = await runPicker(provider, { version: 2, entries: {} }, lockPath, { open: false })
    expect(res).toEqual({ selected: 0, skipped: 0 })
  })

  it("promotes the chosen candidate and persists it to the lockfile", async () => {
    const { provider, lock } = await projectInReview(4)
    const key = lockKey("base", "anvil")
    expect(lock.entries[key]!.status).toBe("review")

    let url = ""
    let readyKeys: string[] = []
    const picked = runPicker(provider, lock, lockPath, {
      open: false,
      onReady: (ready) => {
        url = ready.url
        readyKeys = ready.keys
      },
    })

    await vi.waitFor(() => expect(url).not.toBe(""))
    expect(readyKeys).toEqual([key])
    const res = await fetch(url + "apply", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ selections: [{ key, index: 2 }] }),
    })
    expect(res.ok).toBe(true)
    expect(await picked).toEqual({ selected: 1, skipped: 0 })

    const entry = lock.entries[key]!
    expect(entry.status).toBe("selected")
    expect(entry.candidateIndex).toBe(2)
    expect(entry.objectId).toBeTruthy()

    const onDisk = JSON.parse(await readFile(lockPath, "utf8"))
    expect(onDisk.entries[key].status).toBe("selected")
  })

  it("ignores an out-of-range index instead of throwing", async () => {
    const { provider, lock } = await projectInReview(4)
    const key = lockKey("base", "anvil")

    let url = ""
    const picked = runPicker(provider, lock, lockPath, {
      open: false,
      onProgress: (m) => (url ||= m.match(/http:\/\/127\.0\.0\.1:\d+\//)?.[0] ?? ""),
    })
    await vi.waitFor(() => expect(url).not.toBe(""))
    await fetch(url + "apply", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ selections: [{ key, index: 99 }] }),
    })

    expect(await picked).toEqual({ selected: 0, skipped: 1 })
    expect(lock.entries[key]!.status).toBe("review")
  })

  it("rejects cross-origin or non-JSON review submissions", async () => {
    const { provider, lock } = await projectInReview(4)
    const key = lockKey("base", "anvil")
    let url = ""
    const picked = runPicker(provider, lock, lockPath, {
      open: false,
      onProgress: (m) => (url ||= m.match(/http:\/\/127\.0\.0\.1:\d+\//)?.[0] ?? ""),
    })
    await vi.waitFor(() => expect(url).not.toBe(""))

    const nonJson = await fetch(url + "apply", { method: "POST", body: "{}" })
    expect(nonJson.status).toBe(415)
    const crossOrigin = await fetch(url + "apply", {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: "https://example.test" },
      body: "{}",
    })
    expect(crossOrigin.status).toBe(403)

    await fetch(url + "apply", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ selections: [{ key, index: 0 }] }),
    })
    await picked
  })

  it("serves only the registered revision source for side-by-side review", async () => {
    const { provider, lock, specs } = await projectInReview(4)
    const sourceFile = path.join(dir, "source.png")
    await writeFile(sourceFile, FAKE_PNG)
    const sourceSpec = { ...specs[0]!, assetId: "source", source: "source.png" }
    const revisionSpec = {
      ...specs[0]!,
      revision: {
        mode: "image-to-image" as const,
        sourceAssetId: "source",
        sourceFile,
        sourceSha256: "a".repeat(64),
        sourceWidth: 1,
        sourceHeight: 1,
        sourceFormat: "png" as const,
        sourceSpec,
        strength: 0.3,
      },
    }

    let url = ""
    const picked = runPicker(provider, lock, lockPath, {
      open: false,
      specs: [revisionSpec],
      onProgress: (message) => (url ||= message.match(/http:\/\/127\.0\.0\.1:\d+\//)?.[0] ?? ""),
    })
    await vi.waitFor(() => expect(url).not.toBe(""))

    const page = await (await fetch(url)).text()
    expect(page).toContain("/revision-source/0")
    const source = await fetch(url + "revision-source/0")
    expect(source.headers.get("content-type")).toBe("image/png")
    expect(Buffer.from(await source.arrayBuffer())).toEqual(FAKE_PNG)
    expect((await fetch(url + "revision-source/../pixelkiln.lock.json")).status).toBe(404)

    await fetch(url + "apply", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ selections: [{ key: lockKey("base", "anvil"), index: 0 }] }),
    })
    await picked
  })
})
