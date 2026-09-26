import { randomBytes } from "node:crypto"
import { createServer, type IncomingMessage, type Server } from "node:http"
import { readFile } from "node:fs/promises"
import { openExternal } from "../open.ts"
import { galleryContentSecurityPolicy, renderGallery } from "./page.ts"
import type { GalleryBuild, GalleryMedia } from "./snapshot.ts"
import type { GalleryGenerateHandlers } from "./generate.ts"
import type { GalleryEditorHandlers } from "./editor.ts"
import type { GallerySkeletonHandlers } from "./skeleton.ts"

/**
 * The gallery's HTTP surface. Unlike the review server this is long-lived:
 * three GET routes, bound to loopback, running until the caller closes it
 * (the CLI does so on Ctrl+C). It has no write path unless the caller opts
 * in: `edit` adds one POST route for manifest edits, `generate` adds the
 * routes that start a generation job and host its review sheet, and `editor`
 * adds the routes that install and serve the in-browser pixel editor.
 *
 * Every POST is guarded twice, because a page on localhost is reachable by
 * every other page in the browser: the request's Origin must be this server,
 * and it must carry the session token minted at startup, which only the
 * served page knows. A cross-origin page can neither read the token nor send
 * the custom header without a preflight this server refuses.
 *
 * The snapshot is rebuilt on every page load and every `/api/gallery.json`
 * request, and the media allowlist is replaced with it, so the page's Refresh
 * button shows a `gen` that finished in another terminal, including files
 * that did not exist when the server started. Only paths the current
 * snapshot names are ever read; nothing else on disk is reachable.
 */
export interface GalleryServerOptions {
  /** Rebuilds the snapshot and the allowlist of servable files. */
  load: () => Promise<GalleryBuild>
  /** Called once listening, with the localhost URL. */
  onReady?: (url: string) => void
  onProgress?: (msg: string) => void
  port?: number
  /** Open the URL in the system browser once listening. Default true. */
  open?: boolean
  /**
   * Enable `POST /api/edit`. The handler receives the parsed JSON body and
   * returns the rebuilt gallery; it should throw an error carrying `status`
   * (400 for a rejected edit, 409 for a manifest that changed underneath) so
   * the page can explain what happened.
   */
  edit?: (body: unknown) => Promise<GalleryBuild>
  /**
   * Enable `POST /api/generate`, `GET /api/jobs`, and the `/review/<job>`
   * sheet. The handlers own budgets and provider access; see `generate.ts`.
   */
  generate?: GalleryGenerateHandlers
  /**
   * Enable `GET /api/editor`, `POST /api/editor/install`, and the static
   * `/editor/<release>/<file>` routes that serve the pinned editor build.
   */
  editor?: GalleryEditorHandlers
  /** Enable `POST /api/skeleton/estimate` (a direct PixelLab call the page confirms first) and `GET /api/skeleton`, its session count. */
  skeleton?: GallerySkeletonHandlers
}

export interface GalleryServer {
  url: string
  /** Session token the served page must present on writes; null when read-only. */
  session: string | null
  close(): Promise<void>
}

/**
 * Manifest edits are a few hundred bytes; an in-browser save carries the
 * edit PNG and the editor's project file as base64, so `/api/edit` allows
 * what two files at the pipeline's own limit encode to.
 */
const MAX_EDIT_BYTES = 48 * 1024 * 1024

/**
 * What the editor page may do: load its own files, compile wasm, and run the
 * boot script Godot inlines into its export. `unsafe-eval` is for the bridge,
 * which talks to the host through `JavaScriptBridge.eval`; nothing external
 * is reachable, and only this gallery may frame it.
 */
const EDITOR_CSP = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline' 'unsafe-eval' 'wasm-unsafe-eval'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "worker-src 'self' blob:",
  "connect-src 'self'",
  "frame-ancestors 'self'",
].join("; ")

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []
  let bytes = 0
  for await (const chunk of req) {
    bytes += (chunk as Buffer).length
    if (bytes > MAX_EDIT_BYTES) throw Object.assign(new Error("edit request is too large"), { status: 413 })
    chunks.push(chunk as Buffer)
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown
  } catch {
    throw Object.assign(new Error("edit request is not valid JSON"), { status: 400 })
  }
}

export async function serveGallery(opts: GalleryServerOptions): Promise<GalleryServer> {
  const log = opts.onProgress ?? (() => {})
  const session = opts.edit || opts.generate || opts.editor || opts.skeleton ? randomBytes(16).toString("hex") : null
  let media: ReadonlyMap<string, GalleryMedia> = new Map()
  let loading: Promise<GalleryBuild> | null = null
  /** Local files each open review sheet may load, keyed by job. */
  const reviewAssets = new Map<string, ReadonlyMap<string, { path: string; contentType: string }>>()

  // Coalesce concurrent loads: a page load fires the HTML request and, with
  // auto-refresh on, the JSON request close together. Hashing every output
  // twice for that is wasted work.
  const load = () => {
    if (!loading) {
      loading = opts.load().then((build) => {
        media = build.media
        return build
      }).finally(() => {
        loading = null
      })
    }
    return loading
  }

  const server: Server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1")
    const fail = (status: number, message: string) => {
      res.writeHead(status, { "Content-Type": "text/plain; charset=utf-8" })
      res.end(message)
    }
    const json = (status: number, value: unknown) => {
      res.writeHead(status, {
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
      })
      res.end(JSON.stringify(value))
    }
    /** Same-origin, session-bearing JSON, or nothing. */
    const guardedBody = async (what: string): Promise<unknown | undefined> => {
      const expectedOrigin = req.headers.host ? `http://${req.headers.host}` : null
      if (!req.headers.origin || req.headers.origin !== expectedOrigin) {
        fail(403, `cross-origin ${what} are not allowed`)
        return undefined
      }
      if (req.headers["x-pixelkiln-session"] !== session) {
        fail(403, "missing or stale gallery session")
        return undefined
      }
      if (!req.headers["content-type"]?.toLowerCase().startsWith("application/json")) {
        fail(415, "application/json is required")
        return undefined
      }
      return readJsonBody(req)
    }
    const reportError = (what: string, err: unknown) => {
      const status = typeof (err as { status?: unknown })?.status === "number"
        ? (err as { status: number }).status
        : 500
      const message = err instanceof Error ? err.message : String(err)
      if (status >= 500) log(`  gallery ${what} failed: ${message}`)
      fail(status, message)
    }

    if (req.method === "POST" && url.pathname === "/api/edit") {
      if (!opts.edit || !session) return fail(405, "the gallery is read-only; start it with --edit to change the manifest")
      try {
        const body = await guardedBody("edits")
        if (body === undefined) return
        const build = await opts.edit(body)
        media = build.media
        json(200, build.snapshot)
      } catch (err) {
        reportError("edit", err)
      }
      return
    }
    if (req.method === "POST" && url.pathname === "/api/generate") {
      if (!opts.generate || !session) return fail(405, "generation is off; start the gallery with --budget to enable it")
      try {
        const body = await guardedBody("generation requests")
        if (body === undefined) return
        json(202, await opts.generate.start(body))
      } catch (err) {
        reportError("generate", err)
      }
      return
    }
    if (req.method === "POST" && url.pathname === "/api/skeleton/estimate") {
      if (!opts.skeleton || !session) return fail(405, "skeleton estimates need the gallery started with --edit")
      try {
        const body = await guardedBody("skeleton estimates")
        if (body === undefined) return
        json(200, await opts.skeleton.estimate(body))
      } catch (err) {
        reportError("skeleton estimate", err)
      }
      return
    }
    if (req.method === "POST" && url.pathname === "/api/editor/install") {
      if (!opts.editor || !session) return fail(405, "the in-browser editor is off for this gallery")
      try {
        const body = await guardedBody("editor installs")
        if (body === undefined) return
        json(202, await opts.editor.install())
      } catch (err) {
        reportError("editor install", err)
      }
      return
    }
    const reviewMatch = /^\/review\/([0-9a-f]{16})(\/.*)?$/.exec(url.pathname)
    if (reviewMatch && opts.generate) {
      const [, jobId, rest = ""] = reviewMatch
      if (req.method === "POST" && rest === "/apply") {
        try {
          const body = await guardedBody("review submissions")
          if (body === undefined) return
          const result = await opts.generate.applyReview(jobId!, body)
          reviewAssets.delete(jobId!)
          json(200, result)
        } catch (err) {
          reportError("review", err)
        }
        return
      }
      if (req.method === "GET" && rest === "") {
        try {
          const routePrefix = `/review/${jobId}`
          const review = await opts.generate.review(jobId!, {
            routePrefix,
            applyUrl: `${routePrefix}/apply`,
            applyHeaders: { "X-Pixelkiln-Session": session! },
            embedded: true,
          })
          if (!review) return fail(404, "nothing is waiting for review on this job")
          reviewAssets.set(jobId!, review.assets)
          res.writeHead(200, {
            "Content-Type": "text/html; charset=utf-8",
            "Cache-Control": "no-store",
            "X-Content-Type-Options": "nosniff",
          })
          res.end(review.html({
            applyUrl: `${routePrefix}/apply`,
            applyHeaders: { "X-Pixelkiln-Session": session! },
            embedded: true,
          }))
        } catch (err) {
          reportError("review", err)
        }
        return
      }
      if (req.method === "GET") {
        const asset = reviewAssets.get(jobId!)?.get(url.pathname)
        if (!asset) return fail(404, "no such review asset")
        try {
          const bytes = await readFile(asset.path)
          res.writeHead(200, {
            "Content-Type": asset.contentType,
            "Cache-Control": "no-store",
            "X-Content-Type-Options": "nosniff",
          })
          res.end(bytes)
        } catch {
          fail(404, "review asset is unavailable")
        }
        return
      }
    }
    if (req.method !== "GET" && req.method !== "HEAD") return fail(405, "the gallery is read-only")
    if (url.pathname === "/api/skeleton") {
      if (!opts.skeleton) return fail(404, "skeleton estimates need the gallery started with --edit")
      return json(200, opts.skeleton.status())
    }
    if (url.pathname === "/api/jobs") {
      if (!opts.generate) return fail(404, "generation is off")
      return json(200, opts.generate.status())
    }
    if (url.pathname === "/api/editor") {
      if (!opts.editor) return fail(404, "the in-browser editor is off for this gallery")
      try {
        return json(200, await opts.editor.status())
      } catch (err) {
        return reportError("editor status", err)
      }
    }
    const editorMatch = /^\/editor\/([A-Za-z0-9._-]+)\/([A-Za-z0-9._-]+)$/.exec(url.pathname)
    if (editorMatch) {
      if (!opts.editor) return fail(404, "the in-browser editor is off for this gallery")
      const file = await opts.editor.file(editorMatch[1]!, editorMatch[2]!)
      if (!file) return fail(404, "that editor file is not installed; check /api/editor")
      res.writeHead(200, {
        "Content-Type": file.contentType,
        "Content-Length": file.bytes.length,
        // The release tag is in the path, so these bytes never change under
        // this URL; the 40 MB wasm should come from the browser cache.
        "Cache-Control": "public, max-age=31536000, immutable",
        "X-Content-Type-Options": "nosniff",
        "Cross-Origin-Resource-Policy": "same-origin",
        ...(editorMatch[2] === "index.html" ? { "Content-Security-Policy": EDITOR_CSP } : {}),
      })
      res.end(req.method === "HEAD" ? undefined : file.bytes)
      return
    }

    try {
      if (url.pathname === "/") {
        const { snapshot } = await load()
        const nonce = randomBytes(16).toString("base64")
        res.writeHead(200, {
          "Content-Type": "text/html; charset=utf-8",
          "Cache-Control": "no-store",
          "X-Content-Type-Options": "nosniff",
          "Content-Security-Policy": galleryContentSecurityPolicy(nonce),
        })
        res.end(renderGallery(snapshot, {
          nonce,
          ...(session ? { session } : {}),
          editable: Boolean(opts.edit),
          generation: Boolean(opts.generate),
          editor: Boolean(opts.editor),
        }))
        return
      }
      if (url.pathname === "/api/gallery.json") {
        const { snapshot } = await load()
        res.writeHead(200, {
          "Content-Type": "application/json; charset=utf-8",
          "Cache-Control": "no-store",
          "X-Content-Type-Options": "nosniff",
        })
        res.end(JSON.stringify(snapshot))
        return
      }
      const mediaMatch = /^\/media\/([0-9a-f]{24})$/.exec(url.pathname)
      if (mediaMatch) {
        const asset = media.get(mediaMatch[1]!)
        if (!asset) return fail(404, "no such gallery media")
        let bytes: Buffer
        try {
          bytes = await readFile(asset.path)
        } catch {
          return fail(404, "gallery media is no longer on disk; refresh the page")
        }
        res.writeHead(200, {
          "Content-Type": asset.contentType,
          "Content-Length": bytes.length,
          // The page cache-busts with the recorded hash, so a regenerated file
          // is never shown stale; `no-cache` keeps a hard reload honest too.
          "Cache-Control": "no-cache",
          "X-Content-Type-Options": "nosniff",
        })
        res.end(req.method === "HEAD" ? undefined : bytes)
        return
      }
      fail(404, "not found")
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      log(`  gallery request failed: ${message}`)
      fail(500, message)
    }
  })

  const url = await new Promise<string>((resolve, reject) => {
    server.once("error", reject)
    server.listen(opts.port ?? 0, "127.0.0.1", () => {
      const address = server.address()
      const port = typeof address === "object" && address ? address.port : opts.port
      resolve(`http://127.0.0.1:${port}/`)
    })
  })

  opts.onReady?.(url)
  if (opts.open !== false) openExternal(url)

  return {
    url,
    session,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.closeAllConnections?.()
        server.close((err) => (err ? reject(err) : resolve()))
      }),
  }
}
