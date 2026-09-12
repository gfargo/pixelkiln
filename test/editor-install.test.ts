import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { createHash } from "node:crypto"
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { Script } from "node:vm"
import { EDITOR_PIN, EDITOR_RELEASE_BASE } from "../src/editor/pin.ts"
import {
  EditorInstallError,
  editorBaseUrl,
  editorContentType,
  editorDir,
  editorStatus,
  editorToolsRoot,
  installEditor,
} from "../src/editor/install.ts"
import { createGalleryEditorHandlers, editorRoute } from "../src/gallery/editor.ts"
import { renderGallery } from "../src/gallery/page.ts"
import { serveGallery } from "../src/gallery/server.ts"
import { buildGallerySnapshot } from "../src/gallery/snapshot.ts"
import { loadManifest, resolveSpecs } from "../src/manifest.ts"
import { parseArgs } from "../src/cli.ts"
import type { EditorPin } from "../src/editor/pin.ts"

let dir: string
beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "pixelkiln-editor-"))
})
afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

const sha = (bytes: Buffer | string) => createHash("sha256").update(bytes).digest("hex")

/** A tiny "build": the three kinds of file the real one has, with a fake origin serving them. */
function fakeBuild(overrides: Partial<Record<string, Buffer>> = {}) {
  const files: Record<string, Buffer> = {
    "index.html": Buffer.from("<!doctype html><script src=index.js></script>"),
    "index.js": Buffer.from("console.log('editor')"),
    "index.wasm": Buffer.from([0x00, 0x61, 0x73, 0x6d, 1, 0, 0, 0]),
    ...overrides,
  }
  const pin: EditorPin = {
    pixelorama: "v1.2.2", godot: "4.7.2", extensionsApi: 9, protocol: 1,
    release: "editor-pixelorama-v1.2.2-pk.test",
    files: Object.fromEntries(Object.entries(files).map(([name, bytes]) => [name, { sha256: sha(bytes), bytes: bytes.length }])),
  }
  const requests: string[] = []
  const served: Record<string, Buffer> = { ...files }
  const fetchImpl: typeof fetch = async (input) => {
    const url = String(input)
    requests.push(url)
    const name = decodeURIComponent(url.slice(url.lastIndexOf("/") + 1))
    const bytes = served[name]
    if (!bytes) return new Response("not here", { status: 404, statusText: "Not Found" })
    return new Response(bytes, { status: 200 })
  }
  return { files, pin, requests, served, fetch: fetchImpl }
}

describe("the pinned editor build", () => {
  it("names a published release and every file with a hash", () => {
    expect(EDITOR_PIN.release).toMatch(/^editor-pixelorama-v\d+\.\d+\.\d+-pk\.\d+$/)
    expect(EDITOR_PIN.protocol).toBe(2)
    const names = Object.keys(EDITOR_PIN.files)
    expect(names).toEqual(expect.arrayContaining(["index.html", "index.js", "index.wasm", "index.pck"]))
    for (const [name, file] of Object.entries(EDITOR_PIN.files)) {
      expect(file.sha256, name).toMatch(/^[0-9a-f]{64}$/)
      expect(file.bytes, name).toBeGreaterThan(0)
      // Every pinned file is one the gallery knows how to serve.
      expect(editorContentType(name), name).not.toBeNull()
    }
    expect(editorBaseUrl(EDITOR_PIN)).toBe(`${EDITOR_RELEASE_BASE}/${EDITOR_PIN.release}`)
  })

  it("lives in a per-release directory under a user cache that the env can move", () => {
    const saved = { tools: process.env.PIXELKILN_TOOLS_DIR, url: process.env.PIXELKILN_EDITOR_URL }
    try {
      process.env.PIXELKILN_TOOLS_DIR = dir
      expect(editorToolsRoot()).toBe(dir)
      expect(editorDir(EDITOR_PIN)).toBe(path.join(dir, "pixelorama", EDITOR_PIN.release!))
      process.env.PIXELKILN_EDITOR_URL = "http://mirror.local/editor/"
      expect(editorBaseUrl(EDITOR_PIN)).toBe("http://mirror.local/editor")
      delete process.env.PIXELKILN_TOOLS_DIR
      expect(editorToolsRoot()).toContain("pixelkiln")
      expect(editorToolsRoot()).not.toBe(dir)
    } finally {
      if (saved.tools === undefined) delete process.env.PIXELKILN_TOOLS_DIR
      else process.env.PIXELKILN_TOOLS_DIR = saved.tools
      if (saved.url === undefined) delete process.env.PIXELKILN_EDITOR_URL
      else process.env.PIXELKILN_EDITOR_URL = saved.url
    }
  })
})

describe("installEditor", () => {
  it("fetches every pinned file, verifies it, and is a no-op the second time", async () => {
    const build = fakeBuild()
    const target = path.join(dir, "editor")
    expect(await editorStatus({ pin: build.pin, dir: target })).toMatchObject({ installed: false, missing: Object.keys(build.files), installedBytes: 0 })

    const progress: string[] = []
    const first = await installEditor({
      pin: build.pin, dir: target, baseUrl: "http://fake/release", fetch: build.fetch,
      onProgress: (p) => progress.push(`${p.phase} ${p.file} ${p.fetchedBytes}/${p.totalBytes}`),
    })
    expect(first).toMatchObject({ installed: true, missing: [], downloaded: Object.keys(build.files), skipped: [] })
    expect(build.requests).toEqual(Object.keys(build.files).map((name) => `http://fake/release/${name}`))
    expect(progress[0]).toBe("start index.html 0/" + first.totalBytes)
    expect(progress).toContain(`progress index.html ${build.files["index.html"]!.length}/${first.totalBytes}`)
    expect(progress.at(-1)).toBe(`done index.wasm ${first.totalBytes}/${first.totalBytes}`)
    for (const [name, bytes] of Object.entries(build.files)) {
      expect(await readFile(path.join(target, name))).toEqual(bytes)
    }
    // No temp files survive.
    expect((await readdir(target)).sort()).toEqual(Object.keys(build.files).sort())

    const second = await installEditor({ pin: build.pin, dir: target, baseUrl: "http://fake/release", fetch: build.fetch })
    expect(second).toMatchObject({ installed: true, downloaded: [], skipped: Object.keys(build.files) })
    expect(build.requests).toHaveLength(3)
  })

  it("refetches only files that are missing or whose bytes changed", async () => {
    const build = fakeBuild()
    const target = path.join(dir, "editor")
    await installEditor({ pin: build.pin, dir: target, baseUrl: "http://fake/release", fetch: build.fetch })
    build.requests.length = 0
    await rm(path.join(target, "index.js"))
    await writeFile(path.join(target, "index.wasm"), Buffer.from([0x00, 0x61, 0x73, 0x6d, 9, 9, 9, 9]))
    expect((await editorStatus({ pin: build.pin, dir: target })).missing).toEqual(["index.js", "index.wasm"])

    const result = await installEditor({ pin: build.pin, dir: target, baseUrl: "http://fake/release", fetch: build.fetch })
    expect(result).toMatchObject({ installed: true, downloaded: ["index.js", "index.wasm"], skipped: ["index.html"] })
    expect(build.requests).toEqual(["http://fake/release/index.js", "http://fake/release/index.wasm"])
    expect(await readFile(path.join(target, "index.wasm"))).toEqual(build.files["index.wasm"])
  })

  it("discards a file whose hash or size does not match and leaves nothing behind", async () => {
    const build = fakeBuild()
    const target = path.join(dir, "editor")
    build.served["index.js"] = Buffer.from("console.log('tampered')")
    await expect(installEditor({ pin: build.pin, dir: target, baseUrl: "http://fake/release", fetch: build.fetch }))
      .rejects.toThrow(/index\.js: expected \d+ bytes, got \d+/)
    build.served["index.js"] = Buffer.from("console.log('tamper')") // same length as the original
    expect(build.served["index.js"]!.length).toBe(build.files["index.js"]!.length)
    const err = await installEditor({ pin: build.pin, dir: target, baseUrl: "http://fake/release", fetch: build.fetch }).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(EditorInstallError)
    expect((err as EditorInstallError).file).toBe("index.js")
    expect((err as Error).message).toMatch(/does not match the pinned/)
    expect((await readdir(target)).sort()).toEqual(["index.html"])
    expect((await editorStatus({ pin: build.pin, dir: target })).installed).toBe(false)
  })

  it("reports a missing upstream file with its URL and refuses an unpinned version", async () => {
    const build = fakeBuild()
    delete build.served["index.wasm"]
    await expect(installEditor({ pin: build.pin, dir: path.join(dir, "editor"), baseUrl: "http://fake/release", fetch: build.fetch }))
      .rejects.toThrow(/index\.wasm: 404 Not Found from http:\/\/fake\/release\/index\.wasm/)
    const unpinned: EditorPin = { ...build.pin, release: null, files: {} }
    await expect(installEditor({ pin: unpinned, dir: path.join(dir, "none"), fetch: build.fetch }))
      .rejects.toThrow(/pins no published editor build/)
    expect(await editorStatus({ pin: unpinned, dir: path.join(dir, "none") })).toMatchObject({ installed: false, release: null })
  })
})

describe("the gallery's editor routes", () => {
  async function gallery(handlers: ReturnType<typeof createGalleryEditorHandlers>) {
    const manifestPath = path.join(dir, "pixelkiln.manifest.json")
    await writeFile(manifestPath, JSON.stringify({
      name: "editor-test",
      styles: { base: { generator: "map", outDir: "out" } },
      assets: { anvil: { prompt: "an anvil", width: 32, height: 32 } },
    }))
    const load = async () => {
      const loaded = await loadManifest(manifestPath)
      return buildGallerySnapshot({ loaded, specs: await resolveSpecs(loaded), lock: { version: 2, entries: {} }, lockPath: path.join(dir, "pixelkiln.lock.json") })
    }
    return serveGallery({ open: false, load, editor: handlers })
  }

  it("reports status, installs on a guarded request, then serves only pinned files with cache and CSP headers", async () => {
    const build = fakeBuild()
    const target = path.join(dir, "editor")
    const handlers = createGalleryEditorHandlers({ pin: build.pin, dir: target, baseUrl: "http://fake/release", fetch: build.fetch })
    const server = await gallery(handlers)
    try {
      expect(server.session).toMatch(/^[0-9a-f]{32}$/)
      const page = await (await fetch(server.url)).text()
      expect(page).toContain("const EDITOR = true;")

      const status = await (await fetch(new URL("/api/editor", server.url))).json()
      expect(status).toMatchObject({ release: build.pin.release, installed: false, url: null, installing: null, error: null, pixelorama: "v1.2.2", protocol: 1 })
      const notYet = await fetch(new URL(editorRoute(build.pin.release!), server.url))
      expect(notYet.status).toBe(404)

      const origin = server.url.replace(/\/$/, "")
      const install = (headers: Record<string, string>) => fetch(new URL("/api/editor/install", server.url), {
        method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: "{}",
      })
      expect((await install({ Origin: "http://evil.example", "X-Pixelkiln-Session": server.session! })).status).toBe(403)
      expect((await install({ Origin: origin })).status).toBe(403)
      expect(build.requests).toHaveLength(0)

      const started = await install({ Origin: origin, "X-Pixelkiln-Session": server.session! })
      expect(started.status).toBe(202)
      // Small build: it finishes before the poll comes back.
      for (let i = 0; i < 50; i++) {
        const now = await (await fetch(new URL("/api/editor", server.url))).json() as { installed: boolean; installing: unknown }
        if (now.installed) break
        await new Promise((r) => setTimeout(r, 20))
      }
      const done = await (await fetch(new URL("/api/editor", server.url))).json()
      expect(done).toMatchObject({ installed: true, installing: null, error: null, url: editorRoute(build.pin.release!) })
      expect(build.requests).toHaveLength(3)

      const html = await fetch(new URL(editorRoute(build.pin.release!), server.url))
      expect(html.status).toBe(200)
      expect(html.headers.get("content-type")).toBe("text/html; charset=utf-8")
      expect(html.headers.get("cache-control")).toBe("public, max-age=31536000, immutable")
      expect(html.headers.get("content-security-policy")).toMatch(/frame-ancestors 'self'/)
      expect(html.headers.get("content-security-policy")).toMatch(/'wasm-unsafe-eval'/)
      expect(Buffer.from(await html.arrayBuffer())).toEqual(build.files["index.html"])
      const wasm = await fetch(new URL(editorRoute(build.pin.release!, "index.wasm"), server.url))
      expect(wasm.headers.get("content-type")).toBe("application/wasm")
      expect(wasm.headers.get("content-security-policy")).toBeNull()
      expect(wasm.headers.get("cross-origin-resource-policy")).toBe("same-origin")

      // Only the pinned release and pinned names; nothing else in the directory.
      await writeFile(path.join(target, "secret.txt"), "no")
      expect((await fetch(new URL(editorRoute(build.pin.release!, "secret.txt"), server.url))).status).toBe(404)
      expect((await fetch(new URL(editorRoute("editor-pixelorama-v9.9.9-pk.1"), server.url))).status).toBe(404)
      expect((await fetch(new URL("/editor/../index.html", server.url))).status).toBe(404)
      expect((await fetch(new URL(`/editor/${build.pin.release}/index.html`, server.url), { method: "POST" })).status).toBe(405)

      // A file that changes on disk after verification is refused, not served.
      await writeFile(path.join(target, "index.js"), "console.log('editor'); alert(1)")
      expect((await fetch(new URL(editorRoute(build.pin.release!, "index.js"), server.url))).status).toBe(404)
      expect((await (await fetch(new URL("/api/editor", server.url))).json() as { installed: boolean }).installed).toBe(false)
    } finally {
      await server.close()
    }
  })

  it("surfaces a failed install as an error the page can retry, and stays off without the option", async () => {
    const build = fakeBuild()
    build.served["index.wasm"] = Buffer.from([1, 2, 3])
    const handlers = createGalleryEditorHandlers({ pin: build.pin, dir: path.join(dir, "editor"), baseUrl: "http://fake/release", fetch: build.fetch })
    const server = await gallery(handlers)
    try {
      const origin = server.url.replace(/\/$/, "")
      await fetch(new URL("/api/editor/install", server.url), {
        method: "POST", headers: { "Content-Type": "application/json", Origin: origin, "X-Pixelkiln-Session": server.session! }, body: "{}",
      })
      let status: { installed: boolean; installing: unknown; error: string | null } = { installed: false, installing: {}, error: null }
      for (let i = 0; i < 50 && (status.installing || !status.error); i++) {
        await new Promise((r) => setTimeout(r, 20))
        status = await (await fetch(new URL("/api/editor", server.url))).json() as typeof status
      }
      expect(status).toMatchObject({ installed: false, installing: null })
      expect(status.error).toMatch(/index\.wasm: expected 8 bytes, got 3/)
    } finally {
      await server.close()
    }

    const manifestPath = path.join(dir, "pixelkiln.manifest.json")
    const loaded = await loadManifest(manifestPath)
    const off = await serveGallery({
      open: false,
      load: async () => buildGallerySnapshot({ loaded, specs: await resolveSpecs(loaded), lock: { version: 2, entries: {} }, lockPath: path.join(dir, "pixelkiln.lock.json") }),
    })
    try {
      expect((await fetch(new URL("/api/editor", off.url))).status).toBe(404)
      expect((await fetch(new URL(editorRoute(build.pin.release!), off.url))).status).toBe(404)
      expect(await (await fetch(off.url)).text()).toContain("const EDITOR = false;")
    } finally {
      await off.close()
    }
  })

  it("renders the editor strip only when the server holds a session, and the script still compiles", () => {
    const snapshot = { items: [], styles: [], totals: { entries: 0 }, project: { name: "x", manifest: "m", lock: "l" } } as never
    expect(renderGallery(snapshot, { editor: true })).toContain("const EDITOR = false;")
    const page = renderGallery(snapshot, { editor: true, session: "0".repeat(32) })
    expect(page).toContain("const EDITOR = true;")
    const script = /<script>([\s\S]*?)<\/script>/.exec(page)![1]!
    expect(() => new Script(script, { filename: "gallery.js" })).not.toThrow()
  })
})

describe("tools CLI surface", () => {
  it("parses tools status/install editor and --no-editor", () => {
    expect(parseArgs(["tools"])).toMatchObject({ command: "tools", subcommand: "status", target: undefined })
    expect(parseArgs(["tools", "status", "--json"])).toMatchObject({ command: "tools", subcommand: "status", json: true })
    expect(parseArgs(["tools", "status", "editor"])).toMatchObject({ command: "tools", subcommand: "status", target: "editor" })
    expect(parseArgs(["tools", "install", "editor"])).toMatchObject({ command: "tools", subcommand: "install", target: "editor" })
    expect(() => parseArgs(["tools", "install"])).toThrow(/needs a tool name/)
    expect(() => parseArgs(["tools", "install", "brush"])).toThrow(/Unknown tool "brush"/)
    expect(() => parseArgs(["tools", "remove", "editor"])).toThrow(/Unknown tools subcommand/)
    expect(parseArgs(["gallery", "--edit", "--no-editor"])).toMatchObject({ edit: true, noEditor: true })
    expect(parseArgs(["gallery", "--edit"]).noEditor).toBe(false)
  })
})
