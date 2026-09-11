import { spawn } from "node:child_process"
import { createServer, type Server } from "node:http"
import { readFile } from "node:fs/promises"
import { renderGallery } from "./page.ts"
import type { GalleryBuild, GalleryMedia } from "./snapshot.ts"

/**
 * The gallery's HTTP surface. Unlike the review server this is long-lived and
 * has no write path: three GET routes, bound to loopback, and it runs until
 * the caller closes it (the CLI does so on Ctrl+C).
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
}

export interface GalleryServer {
  url: string
  close(): Promise<void>
}

export async function serveGallery(opts: GalleryServerOptions): Promise<GalleryServer> {
  const log = opts.onProgress ?? (() => {})
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
    if (req.method !== "GET" && req.method !== "HEAD") return fail(405, "the gallery is read-only")

    try {
      if (url.pathname === "/") {
        const { snapshot } = await load()
        res.writeHead(200, {
          "Content-Type": "text/html; charset=utf-8",
          "Cache-Control": "no-store",
          "X-Content-Type-Options": "nosniff",
        })
        res.end(renderGallery(snapshot))
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
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.closeAllConnections?.()
        server.close((err) => (err ? reject(err) : resolve()))
      }),
  }
}
