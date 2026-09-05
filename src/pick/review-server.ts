import { createServer } from "node:http"
import { spawn } from "node:child_process"
import { readFile } from "node:fs/promises"

/**
 * The HTTP plumbing shared by every local review page (`pick`, `salvage`):
 * serve one static page at `/`, accept one POST of decisions, hand the parsed
 * body to the caller, and resolve once that caller's handler succeeds.
 *
 * This exists because `pick` and `salvage` each hand-rolled the identical
 * server — same GET/POST routing, same ephemeral-port dance, same `open`
 * spawn, same error handling — and a bug fixed in one silently stayed a bug
 * in the other (as happened here: `salvage`'s manifest-write bug had no
 * equivalent in `pick` only because `pick` never merges a whole manifest back
 * in). A third review page now gets this for free instead of a third copy to
 * keep in sync.
 *
 * Deliberately NOT a full framework: one page, one apply endpoint, one round
 * trip. Anything needing more should not reach for this.
 */
export interface ReviewServerOptions<TResult> {
  /** The full HTML document served at GET /. */
  html: string
  /** Parses the POSTed decisions and performs them. Only closes the server
   *  on success — a thrown error leaves the page free to retry. */
  handleApply: (body: unknown) => Promise<TResult>
  /** Logged once the server is listening, given its localhost URL. */
  onReady: (url: string) => void
  port?: number
  /** Open the URL in the system browser once listening. Default true. */
  open?: boolean
  onProgress?: (msg: string) => void
  /** Exact local media routes exposed only for the lifetime of this review. */
  assets?: ReadonlyMap<string, { path: string; contentType: string }>
}

export function serveReviewPage<TResult>(opts: ReviewServerOptions<TResult>): Promise<TResult> {
  const log = opts.onProgress ?? (() => {})

  return new Promise<TResult>((resolve, reject) => {
    const server = createServer(async (req, res) => {
      if (req.method === "GET" && req.url && opts.assets?.has(req.url)) {
        try {
          const asset = opts.assets.get(req.url)!
          const bytes = await readFile(asset.path)
          res.writeHead(200, {
            "Content-Type": asset.contentType,
            "Cache-Control": "no-store",
            "X-Content-Type-Options": "nosniff",
          })
          res.end(bytes)
        } catch {
          res.writeHead(404, { "Content-Type": "text/plain" })
          res.end("review asset is unavailable")
        }
        return
      }

      if (req.method === "GET" && (req.url === "/" || req.url?.startsWith("/?"))) {
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" })
        res.end(opts.html)
        return
      }

      if (req.method === "POST" && req.url === "/apply") {
        const expectedOrigin = req.headers.host ? `http://${req.headers.host}` : null
        if (req.headers.origin && req.headers.origin !== expectedOrigin) {
          res.writeHead(403, { "Content-Type": "text/plain" })
          res.end("cross-origin review submissions are not allowed")
          return
        }
        if (!req.headers["content-type"]?.toLowerCase().startsWith("application/json")) {
          res.writeHead(415, { "Content-Type": "text/plain" })
          res.end("application/json is required")
          return
        }
        try {
          const chunks: Buffer[] = []
          let bytes = 0
          for await (const c of req) {
            const chunk = c as Buffer
            bytes += chunk.length
            if (bytes > 64 * 1024) {
              res.writeHead(413, { "Content-Type": "text/plain" })
              res.end("review submission is too large")
              return
            }
            chunks.push(chunk)
          }
          const body: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"))
          const result = await opts.handleApply(body)
          res.writeHead(200, { "Content-Type": "application/json" })
          res.end(JSON.stringify(result))
          server.close(() => resolve(result))
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err)
          log(`  apply failed: ${message}`)
          res.writeHead(500, { "Content-Type": "text/plain" })
          res.end(message)
        }
        return
      }

      res.writeHead(404)
      res.end()
    })

    server.on("error", reject)
    server.listen(opts.port ?? 0, "127.0.0.1", () => {
      const address = server.address()
      const port = typeof address === "object" && address ? address.port : opts.port
      opts.onReady(`http://127.0.0.1:${port}/`)
      if (opts.open !== false && process.platform === "darwin") {
        spawn("open", [`http://127.0.0.1:${port}/`], { stdio: "ignore", detached: true }).unref()
      }
    })
  })
}
