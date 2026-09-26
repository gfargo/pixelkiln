import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { existsSync, readFileSync, readdirSync } from "node:fs"
import { mkdtemp, readdir, readFile, rm, utimes, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { crc32 } from "node:zlib"
import { FakeProvider } from "../src/providers/fake.ts"
import { loadManifest, resolveSpecs } from "../src/manifest.ts"
import { buildPlan } from "../src/pipeline/plan.ts"
import { submit } from "../src/pipeline/submit.ts"
import { poll } from "../src/pipeline/poll.ts"
import { fetchAssets } from "../src/pipeline/fetch.ts"
import { loadLock, saveLock } from "../src/lock.ts"
import { sha256 } from "../src/hash.ts"
import { encodeRgbaPng } from "../src/png.ts"
import {
  handEditCompanionPath,
  handEditProjectPath,
  MAX_HAND_EDIT_BYTES,
  readHandEditCompanion,
  saveHandEdit,
  startHandEdit,
} from "../src/pipeline/hand-edit.ts"
import { ManifestEditError } from "../src/manifest-edit.ts"
import { buildGallerySnapshot } from "../src/gallery/snapshot.ts"
import { createGalleryEditHandler } from "../src/gallery/edit.ts"
import { serveGallery } from "../src/gallery/server.ts"
import { renderGallery } from "../src/gallery/page.ts"
import { lockKey, primaryOutput, type Lock } from "../src/types.ts"

/** The gallery client as written: its typed modules, read for what they say rather than as bundled. */
const clientSource = () => readdirSync(new URL("../src/gallery/client/src/", import.meta.url))
  .filter((f) => f.endsWith(".ts"))
  .map((f) => readFileSync(new URL(`../src/gallery/client/src/${f}`, import.meta.url), "utf8"))
  .join("\n")

let dir: string
let lockPath: string

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "pixelkiln-editor-save-"))
  lockPath = path.join(dir, "pixelkiln.lock.json")
})
afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

/** Two generated single-image assets through the real pipeline (FakeProvider art is 1x1). */
async function generated() {
  const manifestPath = path.join(dir, "pixelkiln.manifest.json")
  await writeFile(manifestPath, JSON.stringify({
    name: "browser-edit",
    styles: { base: { generator: "map", outDir: "art", palette: ["#101820", "#f2aa4c"] } },
    assets: {
      anvil: { prompt: "an anvil", width: 32, height: 32 },
      hammer: { prompt: "a hammer", width: 32, height: 32 },
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

const RED = encodeRgbaPng(1, 1, Buffer.from([255, 0, 0, 255]))
const BLUE = encodeRgbaPng(1, 1, Buffer.from([0, 0, 255, 255]))
const PXO = Buffer.from("PKfake-project", "latin1")
const EDITOR = { editor: "pixelorama@v1.2.2-stable", protocol: 1 }

describe("saveHandEdit", () => {
  it("writes the edit, the project file, and a companion naming the generation it was based on", async () => {
    const { manifestPath, loaded, specs, lock } = await generated()
    const spec = specs.find((s) => s.assetId === "anvil")!
    const now = new Date("2026-09-12T10:00:00Z")
    const saved = await saveHandEdit(loaded, lock, spec, { png: RED, project: PXO, ...EDITOR, now })

    expect(saved).toMatchObject({
      source: "art/edits/anvil.png", created: true, declared: true, sha256: sha256(RED),
      basedOn: primaryOutput(lock.entries[lockKey("base", "anvil")]!)!.sha256,
    })
    expect(await readFile(saved.editPath)).toEqual(RED)
    expect(saved.projectPath).toBe(handEditProjectPath(saved.editPath))
    expect(await readFile(saved.projectPath!)).toEqual(PXO)
    expect(saved.companionPath).toBe(handEditCompanionPath(saved.editPath))
    expect(saved.companionPath).toBe(path.join(dir, "art/edits/anvil.edit.json"))
    expect(JSON.parse(await readFile(saved.companionPath, "utf8"))).toEqual({
      version: 2, editor: EDITOR.editor, protocol: 1, savedAt: "2026-09-12T10:00:00.000Z", project: "anvil.pxo",
      outputs: [{ role: null, basedOn: saved.basedOn, sha256: sha256(RED) }],
    })
    expect(JSON.parse(await readFile(manifestPath, "utf8")).assets.anvil.source).toBe("art/edits/anvil.png")
    // No temp files beside it.
    expect((await readdir(path.dirname(saved.editPath))).sort()).toEqual(["anvil.edit.json", "anvil.png", "anvil.pxo"])

    // A second save replaces the bytes and keeps the declaration; without a project file the companion says so.
    const again = await loadManifest(manifestPath)
    const respec = (await resolveSpecs(again)).find((s) => s.assetId === "anvil")!
    const second = await saveHandEdit(again, lock, respec, { png: BLUE, ...EDITOR, expectedSha256: saved.manifestSha256 })
    expect(second).toMatchObject({ created: false, declared: false, sha256: sha256(BLUE), projectPath: null })
    expect(await readFile(second.editPath)).toEqual(BLUE)
    expect((await readHandEditCompanion(second.editPath))!).toMatchObject({ outputs: [{ sha256: sha256(BLUE) }], project: null })

    // A companion written by the first release (one image, flat fields) still reads.
    await writeFile(second.companionPath, JSON.stringify({
      version: 1, basedOn: saved.basedOn, sha256: sha256(BLUE), editor: "pixelorama@v1.2.2-stable", protocol: 1,
      savedAt: "2026-09-12T09:00:00.000Z", project: null,
    }))
    expect(await readHandEditCompanion(second.editPath)).toEqual({
      version: 2, editor: "pixelorama@v1.2.2-stable", protocol: 1, savedAt: "2026-09-12T09:00:00.000Z", project: null,
      outputs: [{ role: null, basedOn: saved.basedOn, sha256: sha256(BLUE) }],
    })
  })

  it("refuses bytes that are not a PNG, the wrong size, or too large, and writes nothing", async () => {
    const { manifestPath, loaded, specs, lock } = await generated()
    const spec = specs.find((s) => s.assetId === "anvil")!
    const before = await readFile(manifestPath, "utf8")
    await expect(saveHandEdit(loaded, lock, spec, { png: Buffer.from("not a png"), ...EDITOR })).rejects.toThrow(/not a valid PNG/)
    const wide = encodeRgbaPng(2, 1, Buffer.alloc(8, 255))
    await expect(saveHandEdit(loaded, lock, spec, { png: wide, ...EDITOR })).rejects.toThrow(/the edit is 2.1; base\/anvil is 1.1/)
    const huge = Buffer.alloc(MAX_HAND_EDIT_BYTES + 1)
    await expect(saveHandEdit(loaded, lock, spec, { png: huge, ...EDITOR })).rejects.toThrow(/limit is/)
    await expect(saveHandEdit(loaded, lock, spec, { png: RED, project: huge, ...EDITOR })).rejects.toThrow(/project file is/)
    const err = await saveHandEdit(loaded, lock, spec, { png: wide, ...EDITOR }).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(ManifestEditError)
    expect(existsSync(path.join(dir, "art/edits"))).toBe(false)
    expect(await readFile(manifestPath, "utf8")).toBe(before)
  })

  it("tells regenerated-since by hash once a companion exists, not by file times", async () => {
    const { manifestPath, loaded, specs, lock } = await generated()
    const spec = specs.find((s) => s.assetId === "anvil")!
    await saveHandEdit(loaded, lock, spec, { png: RED, ...EDITOR })
    const again = await loadManifest(manifestPath)
    const resolved = await resolveSpecs(again)
    let { snapshot } = await buildGallerySnapshot({ loaded: again, specs: resolved, lock, lockPath })
    let item = snapshot.items.find((i) => i.key === "base/anvil")!
    expect(item.editStatus).toBe("edited")
    expect(item.editMeta).toEqual({
      editor: EDITOR.editor, savedAt: expect.any(String), basedOn: item.outputs[0]!.sha256, changedSince: false, project: null, projectUrl: null,
    })

    // Touching the generated file's mtime is not a regeneration.
    const generatedFile = item.outputs[0]!.absolutePath
    const later = new Date(Date.now() + 60_000)
    await utimes(generatedFile, later, later)
    ;({ snapshot } = await buildGallerySnapshot({ loaded: again, specs: resolved, lock, lockPath }))
    expect(snapshot.items.find((i) => i.key === "base/anvil")!.editStatus).toBe("edited")

    // A new generation (different recorded hash) is, even with an older mtime.
    const entry = lock.entries[lockKey("base", "anvil")]!
    await writeFile(generatedFile, BLUE)
    entry.outputs[0]!.sha256 = sha256(BLUE)
    const earlier = new Date(Date.now() - 600_000)
    await utimes(generatedFile, earlier, earlier)
    ;({ snapshot } = await buildGallerySnapshot({ loaded: again, specs: resolved, lock, lockPath }))
    item = snapshot.items.find((i) => i.key === "base/anvil")!
    expect(item.editStatus).toBe("regenerated-since")
    expect(item.editMeta!.basedOn).not.toBe(item.outputs[0]!.sha256)

    // A save whose pixels equal the generated art is "same" however the PNG was encoded.
    const generatedBytes = await readFile(generatedFile)
    const reencoded = encodeRgbaPng(1, 1, Buffer.from([0, 0, 255, 255]))
    expect(sha256(reencoded)).toBe(sha256(BLUE))
    expect(reencoded.equals(generatedBytes)).toBe(true)
    const text = Buffer.from("tEXtpk\0x", "latin1")
    const chunk = Buffer.alloc(4 + text.length + 4)
    chunk.writeUInt32BE(text.length - 4, 0)
    text.copy(chunk, 4)
    chunk.writeUInt32BE(crc32(text) >>> 0, 4 + text.length)
    await writeFile(path.join(dir, "art/edits/anvil.png"), Buffer.concat([reencoded.subarray(0, reencoded.length - 12), chunk, reencoded.subarray(reencoded.length - 12)]))
    ;({ snapshot } = await buildGallerySnapshot({ loaded: again, specs: resolved, lock, lockPath }))
    // (a text chunk before IEND is still a decodable PNG with the same pixels; hashes differ, status is same)
    expect(snapshot.items.find((i) => i.key === "base/anvil")!.edit!.sha256).not.toBe(sha256(BLUE))
    expect(snapshot.items.find((i) => i.key === "base/anvil")!.editChanged).toEqual([false])

    // Another tool rewriting the edit shows as changed since the editor saved it.
    await writeFile(path.join(dir, "art/edits/anvil.png"), encodeRgbaPng(1, 1, Buffer.from([0, 255, 0, 255])))
    ;({ snapshot } = await buildGallerySnapshot({ loaded: again, specs: resolved, lock, lockPath }))
    expect(snapshot.items.find((i) => i.key === "base/anvil")!.editMeta!.changedSince).toBe(true)

    // A desktop edit started with `pixelkiln edit` has no companion and keeps the mtime rule.
    const hammer = resolved.find((s) => s.assetId === "hammer")!
    await startHandEdit(again, lock, hammer)
    const third = await loadManifest(manifestPath)
    ;({ snapshot } = await buildGallerySnapshot({ loaded: third, specs: await resolveSpecs(third), lock, lockPath }))
    expect(snapshot.items.find((i) => i.key === "base/hammer")).toMatchObject({ editStatus: "same", editMeta: null })
  })
})

describe("POST /api/edit save-edit", () => {
  it("is guarded like every write, validates, and answers with the rebuilt gallery", async () => {
    const { manifestPath } = await generated()
    const load = async () => {
      const loaded = await loadManifest(manifestPath)
      return buildGallerySnapshot({ loaded, specs: await resolveSpecs(loaded), lock: await loadLock(lockPath), lockPath })
    }
    const loadProject = async () => {
      const loaded = await loadManifest(manifestPath)
      return { loaded, specs: await resolveSpecs(loaded), lock: await loadLock(lockPath), lockPath }
    }
    const messages: string[] = []
    const server = await serveGallery({
      open: false,
      load,
      edit: createGalleryEditHandler({ manifestFor: () => manifestPath, reload: load, loadProject, onProgress: (m) => messages.push(m) }),
    })
    try {
      const origin = server.url.replace(/\/$/, "")
      const before = (await (await fetch(new URL("/api/gallery.json", server.url))).json()) as { project: { manifestSha256: string } }
      const post = (body: unknown, headers: Record<string, string> = { Origin: origin, "X-Pixelkiln-Session": server.session! }) =>
        fetch(new URL("/api/edit", server.url), {
          method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(body),
        })
      const save = {
        action: "save-edit", assetId: "anvil", styleId: "base", expectedSha256: before.project.manifestSha256,
        png: RED.toString("base64"), pxo: PXO.toString("base64"), ...EDITOR,
      }

      expect((await post(save, { Origin: origin })).status).toBe(403)
      expect((await post(save, { Origin: "http://evil.example", "X-Pixelkiln-Session": server.session! })).status).toBe(403)
      const badBase64 = await post({ ...save, png: "not base64!" })
      expect(badBase64.status).toBe(400)
      expect(await badBase64.text()).toMatch(/invalid edit/)
      const notPng = await post({ ...save, png: Buffer.from("hello").toString("base64") })
      expect(notPng.status).toBe(400)
      expect(await notPng.text()).toMatch(/not a valid PNG/)
      const wrongSize = await post({ ...save, png: encodeRgbaPng(3, 3, Buffer.alloc(36, 255)).toString("base64") })
      expect(wrongSize.status).toBe(400)
      expect(await wrongSize.text()).toMatch(/3.3; base\/anvil is 1.1/)
      const unknown = await post({ ...save, assetId: "nope" })
      expect(unknown.status).toBe(400)
      expect(existsSync(path.join(dir, "art/edits"))).toBe(false)

      const ok = await post(save)
      expect(ok.status).toBe(200)
      const after = (await ok.json()) as {
        items: Array<{ key: string; editStatus: string | null; editMeta: { project: string | null } | null; source: string | null }>
        project: { manifestSha256: string }
      }
      const item = after.items.find((i) => i.key === "base/anvil")!
      expect(item).toMatchObject({ editStatus: "edited", source: "art/edits/anvil.png" })
      expect(item.editMeta).toMatchObject({ editor: EDITOR.editor, project: "art/edits/anvil.pxo", changedSince: false })
      expect(after.project.manifestSha256).not.toBe(before.project.manifestSha256)
      // The project file is served back to the page so a re-edit restores the layers.
      expect(item.editMeta!.projectUrl).toMatch(/^\/media\/[0-9a-f]{24}\?v=/)
      const pxo = await fetch(new URL(item.editMeta!.projectUrl!, server.url))
      expect(pxo.status).toBe(200)
      expect(pxo.headers.get("content-type")).toBe("application/octet-stream")
      expect(Buffer.from(await pxo.arrayBuffer())).toEqual(PXO)
      expect(await readFile(path.join(dir, "art/edits/anvil.png"))).toEqual(RED)
      expect(await readFile(path.join(dir, "art/edits/anvil.pxo"))).toEqual(PXO)
      expect(messages.some((m) => /hand edit saved from pixelorama@v1.2.2-stable: art\/edits\/anvil.png \(declared in the manifest\) \+ project file/.test(m))).toBe(true)

      // A second save changes no manifest key, so the quoted hash is not in
      // play: the bytes are replaced and the declaration stands.
      const again = await post({ ...save, png: BLUE.toString("base64"), pxo: undefined })
      expect(again.status).toBe(200)
      expect(await readFile(path.join(dir, "art/edits/anvil.png"))).toEqual(BLUE)
      expect(await readFile(path.join(dir, "art/edits/anvil.pxo"))).toEqual(PXO)

      // Once the manifest must change again (the edit was detached meanwhile),
      // a stale hash is a conflict and nothing is written.
      const detached = await post({ action: "detach-edit", assetId: "anvil", styleId: "base", expectedSha256: after.project.manifestSha256 })
      expect(detached.status).toBe(200)
      const stale = await post({ ...save, png: RED.toString("base64"), expectedSha256: after.project.manifestSha256 })
      expect(stale.status).toBe(409)
      expect(await stale.text()).toMatch(/changed on disk/)
      expect(await readFile(path.join(dir, "art/edits/anvil.png"))).toEqual(BLUE)
      expect(JSON.parse(await readFile(manifestPath, "utf8")).assets.anvil.source).toBeUndefined()
    } finally {
      await server.close()
    }
  })

  it("renders the sheet's host side into the page", () => {
    const snapshot = { items: [], styles: [], totals: { entries: 0 }, project: { name: "x", manifest: "m", lock: "l" } } as never
    const rendered = renderGallery(snapshot, { editable: true, editor: true, session: "0".repeat(32) })
    expect(rendered).toContain("pixelkiln:open")
    const page = clientSource()
    for (const type of ["pixelkiln:open", "pixelkiln:request-save", "pixelkiln:ready", "pixelkiln:opened", "pixelkiln:dirty", "pixelkiln:save", "pixelkiln:error"]) {
      expect(page).toContain(`'${type}'`)
    }
    expect(page).toContain("'save-edit'")
    expect(page).toContain("message.pxo = pxo")
    // The generated art goes along as a reference layer when an edit is opened, with a toggle.
    expect(page).toContain("message.reference = reference")
    expect(page).toContain("'pixelkiln:reference'")
    expect(page).toContain("show generated")
    expect(page).toContain("' restored'")
    expect(page).toContain("Discard unsaved changes in the editor?")
    expect(page).toContain("beforeunload")
    expect(page).toContain("e.source === S.SHEET.frame.contentWindow")
  })
})
