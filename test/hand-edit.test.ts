import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { existsSync } from "node:fs"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { FakeProvider, FAKE_PNG } from "../src/providers/fake.ts"
import { loadManifest, resolveSpecs } from "../src/manifest.ts"
import { buildPlan } from "../src/pipeline/plan.ts"
import { submit } from "../src/pipeline/submit.ts"
import { poll } from "../src/pipeline/poll.ts"
import { fetchAssets } from "../src/pipeline/fetch.ts"
import { packStyle } from "../src/pipeline/pack.ts"
import { loadLock, saveLock } from "../src/lock.ts"
import { sha256 } from "../src/hash.ts"
import { decodePng, encodeRgbaPng } from "../src/png.ts"
import { detachHandEdit, handEditPath, openInEditor, startHandEdit } from "../src/pipeline/hand-edit.ts"
import { buildGallerySnapshot } from "../src/gallery/snapshot.ts"
import { parseArgs } from "../src/cli/args.ts"
import type { Lock } from "../src/types.ts"

const execFileAsync = promisify(execFile)
let dir: string
let lockPath: string

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "pixelkiln-hand-edit-"))
  lockPath = path.join(dir, "pixelkiln.lock.json")
})
afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

/** One asset generated in two styles, one asset in one style, through the real pipeline. */
async function generated() {
  const manifestPath = path.join(dir, "pixelkiln.manifest.json")
  await writeFile(manifestPath, JSON.stringify({
    name: "hand",
    styles: {
      base: { generator: "map", outDir: "art/base", promptSuffix: "clean" },
      neon: { generator: "map", outDir: "art/neon", promptSuffix: "glowing" },
    },
    assets: {
      anvil: { prompt: "an anvil", width: 32, height: 32, category: "tools" },
      lone: { prompt: "a lone prop", width: 16, height: 16, styles: ["base"] },
    },
  }, null, 2) + "\n")
  const loaded = await loadManifest(manifestPath)
  const specs = await resolveSpecs(loaded)
  const provider = new FakeProvider({ candidates: 1 })
  const lock: Lock = { version: 2, entries: {} }
  await submit(provider, loaded, (await buildPlan(specs, lock)).actionable, lock, lockPath, { spacingMs: 0 })
  await poll(provider, lock, lockPath, { intervalMs: 0 })
  await fetchAssets(provider, specs, lock, lockPath, { cacheDir: false })
  await saveLock(lockPath, lock)
  return { manifestPath, loaded, specs, lock }
}

describe("hand edits", () => {
  it("copies the generated art to edits/ and declares it per style when the asset is shared", async () => {
    const { manifestPath, loaded, specs, lock } = await generated()
    const anvilBase = specs.find((spec) => spec.styleId === "base" && spec.assetId === "anvil")!
    expect(handEditPath(loaded, anvilBase)).toBe(path.join(dir, "art/base/edits/tools/anvil.png"))

    const started = await startHandEdit(loaded, lock, anvilBase)
    expect(started).toMatchObject({ created: true, declared: true, source: "art/base/edits/tools/anvil.png" })
    expect(await readFile(started.editPath)).toEqual(await readFile(path.join(dir, "art/base/tools/anvil.png")))
    let written = JSON.parse(await readFile(manifestPath, "utf8"))
    expect(written.assets.anvil).toMatchObject({ sourceByStyle: { base: "art/base/edits/tools/anvil.png" } })
    expect(written.assets.anvil).not.toHaveProperty("source")
    // The generated file and the lock are untouched.
    expect((await loadLock(lockPath)).entries["base/anvil"]!.status).toBe("downloaded")

    // Resolution routes the edit to that style only, and plan stays ok.
    const again = await loadManifest(manifestPath)
    const resolved = await resolveSpecs(again)
    expect(resolved.find((s) => s.styleId === "base" && s.assetId === "anvil")!.source).toBe("art/base/edits/tools/anvil.png")
    expect(resolved.find((s) => s.styleId === "neon" && s.assetId === "anvil")!.source).toBeUndefined()
    const plan = await buildPlan(resolved, await loadLock(lockPath))
    expect(plan.items.map((item) => [item.key, item.state])).toEqual(expect.arrayContaining([["base/anvil", "ok"], ["neon/anvil", "ok"]]))

    // Idempotent: a second start finds the file and rewrites nothing.
    const second = await startHandEdit(again, lock, resolved.find((s) => s.styleId === "base" && s.assetId === "anvil")!)
    expect(second).toMatchObject({ created: false, declared: false, editPath: started.editPath })

    // A single-style asset uses the plain `source`.
    const lone = resolved.find((s) => s.assetId === "lone")!
    await startHandEdit(again, lock, lone)
    written = JSON.parse(await readFile(manifestPath, "utf8"))
    expect(written.assets.lone).toMatchObject({ source: "art/base/edits/lone.png" })
    expect(written.assets.lone).not.toHaveProperty("sourceByStyle")

    // Detaching keeps the file and clears only the manifest key.
    const latest = await loadManifest(manifestPath)
    const latestSpecs = await resolveSpecs(latest)
    const detached = await detachHandEdit(latest, latestSpecs.find((s) => s.styleId === "base" && s.assetId === "anvil")!)
    expect(detached.changed).toBe(true)
    written = JSON.parse(await readFile(manifestPath, "utf8"))
    expect(written.assets.anvil).not.toHaveProperty("sourceByStyle")
    expect(existsSync(started.editPath)).toBe(true)
  })

  it("refuses when there is nothing on disk to start from, or the asset is a structural set", async () => {
    const manifestPath = path.join(dir, "pixelkiln.manifest.json")
    await writeFile(manifestPath, JSON.stringify({
      name: "hand", styles: { base: { generator: "map", outDir: "art" } }, assets: { anvil: { prompt: "x", width: 16, height: 16 } },
    }))
    const loaded = await loadManifest(manifestPath)
    const specs = await resolveSpecs(loaded)
    await expect(startHandEdit(loaded, { version: 2, entries: {} }, specs[0]!)).rejects.toThrow(/no generated PNG on disk/)
    expect(existsSync(path.join(dir, "art/edits"))).toBe(false)
  })

  it("is what the gallery describes and what pack and mount place", async () => {
    const { manifestPath, loaded, specs, lock } = await generated()
    const spec = specs.find((s) => s.styleId === "base" && s.assetId === "anvil")!
    const started = await startHandEdit(loaded, lock, spec)

    // Not changed yet: the snapshot says so and the card still shows the generation.
    let again = await loadManifest(manifestPath)
    let resolved = await resolveSpecs(again)
    let { snapshot } = await buildGallerySnapshot({ loaded: again, specs: resolved, lock, lockPath })
    let item = snapshot.items.find((i) => i.key === "base/anvil")!
    expect(item.editStatus).toBe("same")
    expect(item.edit).toMatchObject({ path: "art/base/edits/tools/anvil.png", exists: true })
    expect(item.edit!.url).toMatch(/^\/media\//)

    // The author paints a red pixel; the edit differs and pack places it.
    const edited = encodeRgbaPng(1, 1, Buffer.from([255, 0, 0, 255]))
    await writeFile(started.editPath, edited)
    ;({ snapshot } = await buildGallerySnapshot({ loaded: again, specs: resolved, lock, lockPath }))
    item = snapshot.items.find((i) => i.key === "base/anvil")!
    expect(item.editStatus).toBe("edited")
    expect(item.edit!.sha256).toBe(sha256(edited))
    expect(item.outputs[0]!.sha256).not.toBe(sha256(edited))

    const sheet = packStyle(lock, "base", dir, { sources: { anvil: "art/base/edits/tools/anvil.png" } })
    expect(sheet.atlas.frames.map((frame) => frame.id).sort()).toEqual(["anvil", "lone"])
    const px = decodePng(sheet.png)
    const anvilFrame = sheet.atlas.frames.find((frame) => frame.id === "anvil")!
    const offset = (anvilFrame.y * px.width + anvilFrame.x) * 4
    expect([...px.pixels.subarray(offset, offset + 4)]).toEqual([255, 0, 0, 255])
    // Without the source the generated pixel (FakeProvider's transparent PNG) is packed.
    const plain = packStyle(lock, "base", dir)
    const plainPx = decodePng(plain.png)
    const plainFrame = plain.atlas.frames.find((frame) => frame.id === "anvil")!
    const plainOffset = (plainFrame.y * plainPx.width + plainFrame.x) * 4
    expect([...plainPx.pixels.subarray(plainOffset, plainOffset + 4)]).not.toEqual([255, 0, 0, 255])

    // A regeneration after the edit is reported as such.
    const { utimes } = await import("node:fs/promises")
    const later = new Date(Date.now() + 60_000)
    await utimes(path.join(dir, "art/base/tools/anvil.png"), later, later)
    ;({ snapshot } = await buildGallerySnapshot({ loaded: again, specs: resolved, lock, lockPath }))
    expect(snapshot.items.find((i) => i.key === "base/anvil")!.editStatus).toBe("regenerated-since")
  })

  it("launches the configured editor with the file appended", async () => {
    const script = path.join(dir, "editor.sh")
    const marker = path.join(dir, "opened.txt")
    await writeFile(script, `#!/bin/sh\necho "$@" > "${marker}"\n`)
    const { chmod } = await import("node:fs/promises")
    await chmod(script, 0o755)
    const command = openInEditor(path.join(dir, "some.png"), `${script} --flag`)
    expect(command).toBe(`${script} --flag`)
    // The shell creates the marker empty before echo writes into it, so wait
    // for content rather than existence.
    let content = ""
    for (let i = 0; i < 250 && !content; i++) {
      await new Promise((r) => setTimeout(r, 20))
      content = existsSync(marker) ? (await readFile(marker, "utf8")).trim() : ""
    }
    expect(content).toBe(`--flag ${path.join(dir, "some.png")}`)
  })

  it("is reachable from the CLI and parses its subcommands", async () => {
    expect(parseArgs(["edit", "--only", "anvil", "--style", "base"])).toMatchObject({ command: "edit", subcommand: "start", assets: ["anvil"], styles: ["base"] })
    expect(parseArgs(["edit", "detach", "--only", "anvil"])).toMatchObject({ command: "edit", subcommand: "detach" })
    expect(() => parseArgs(["edit", "open"])).toThrow(/Unknown edit subcommand/)

    const { manifestPath } = await generated()
    const cli = path.resolve("node_modules/.bin/tsx")
    const entry = path.resolve("src/cli.ts")
    await expect(execFileAsync(cli, [entry, "edit", "--only", "anvil", "--manifest", manifestPath, "--no-open"]))
      .rejects.toMatchObject({ stderr: expect.stringMatching(/resolves to 2/) })
    const { stdout } = await execFileAsync(cli, [entry, "edit", "--only", "anvil", "--style", "neon", "--manifest", manifestPath, "--no-open"])
    expect(stdout).toMatch(/created art\/neon\/edits\/tools\/anvil.png and declared it/)
    expect(JSON.parse(await readFile(manifestPath, "utf8")).assets.anvil.sourceByStyle).toEqual({ neon: "art/neon/edits/tools/anvil.png" })
    const detach = await execFileAsync(cli, [entry, "edit", "detach", "--only", "anvil", "--style", "neon", "--manifest", manifestPath])
    expect(detach.stdout).toMatch(/detached the hand edit/)
    expect(JSON.parse(await readFile(manifestPath, "utf8")).assets.anvil).not.toHaveProperty("sourceByStyle")
  })
})
