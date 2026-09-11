import { spawn } from "node:child_process"
import { randomBytes } from "node:crypto"
import { createServer, type IncomingMessage, type Server } from "node:http"
import { readFile } from "node:fs/promises"
import { renderGallery } from "./page.ts"
import type { GalleryBuild, GalleryMedia } from "./snapshot.ts"

/**
 * The gallery's HTTP surface. Unlike the review server this is long-lived:
 * three GET routes, bound to loopback, running until the caller closes it
 * (the CLI does so on Ctrl+C). It has no write path unless the caller opts
 * in with `edit`, which adds exactly one POST route for manifest edits.
 *
 * That route is guarded twice, because a page on localhost is reachable by
 * every other page in the browser: the request's Origin must be this server,
 * and it must carry the session token minted at startup, which only the
 * served page knows. A cross-origin page can neither read the token nor send
 * the custom header without a preflight this server refuses.
 *
 * The snapshot is rebuilt on every page load and every `/api/gallery.json`
 * request, and the media allowlist is replaced with it, so the page's Refresh
 * button shows a `gen` that finished in another terminal — including files
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
}

export interface GalleryServer {
  url: string
  /** Session token the served page must present on writes; null when read-only. */
  session: string | null
  close(): Promise<void>
}

const MAX_EDIT_BYTES = 64 * 1024

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
  const session = opts.edit ? randomBytes(16).toString("hex") : null
  let media: ReadonlyMap<string, GalleryMedia> = new Map()
  let loading: Promise<GalleryBuild> | null = null

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
    if (req.method === "POST" && url.pathname === "/api/edit") {
      if (!opts.edit || !session) return fail(405, "the gallery is read-only; start it with --edit to change the manifest")
      const expectedOrigin = req.headers.host ? `http://${req.headers.host}` : null
      if (!req.headers.origin || req.headers.origin !== expectedOrigin) {
        return fail(403, "cross-origin edits are not allowed")
      }
      if (req.headers["x-pixelkiln-session"] !== session) return fail(403, "missing or stale gallery session")
      if (!req.headers["content-type"]?.toLowerCase().startsWith("application/json")) {
        return fail(415, "application/json is required")
      }
      try {
        const body = await readJsonBody(req)
        const build = await opts.edit(body)
        media = build.media
        res.writeHead(200, {
          "Content-Type": "application/json; charset=utf-8",
          "Cache-Control": "no-store",
          "X-Content-Type-Options": "nosniff",
        })
        res.end(JSON.stringify(build.snapshot))
      } catch (err) {
        const status = typeof (err as { status?: unknown })?.status === "number"
          ? (err as { status: number }).status
          : 500
        const message = err instanceof Error ? err.message : String(err)
        if (status >= 500) log(`  gallery edit failed: ${message}`)
        fail(status, message)
      }
      return
    }
    if (req.method !== "GET" && req.method !== "HEAD") return fail(405, "the gallery is read-only")

    try {
      if (url.pathname === "/") {
        const { snapshot } = await load()
        res.writeHead(200, {
          "Content-Type": "text/html; charset=utf-8",
          "Cache-Control": "no-store",
          "X-Content-Type-Options": "nosniff",
        })
        res.end(renderGallery(snapshot, session ? { session } : undefined))
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
  if (opts.open !== false && process.platform === "darwin") {
    spawn("open", [url], { stdio: "ignore", detached: true }).unref()
  }

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
