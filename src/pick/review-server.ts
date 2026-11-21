import { createServer } from "node:http"
import { readFile } from "node:fs/promises"
import { openExternal } from "../open.ts"

/**
 * The HTTP plumbing shared by every local review page (`pick`, `salvage`):
 * serve one static page at `/`, accept one POST of decisions, hand the parsed
 * body to the caller, and resolve once that caller's handler succeeds.
 *
 * This exists because `pick` and `salvage` each hand-rolled the identical
 * server (same GET/POST routing, same ephemeral-port dance, same `open`
 * spawn, same error handling), and a bug fixed in one silently stayed a bug
 * in the other (as happened here: `salvage`'s manifest-write bug had no
 * equivalent in `pick` only because `pick` never merges a whole manifest back
 * in). A third review page now gets this for free instead of a third copy to
 * keep in sync.
 *
 * Deliberately NOT a full framework: one page, one apply endpoint, one round
 * trip. Anything needing more should not reach for this.
 */
export interface ReviewServerOptions<TResult> {
  /** The full HTML document served at GET /, or a function that renders it per request. */
  html: string | (() => string)
  /** Parses the POSTed decisions and performs them. Only closes the server
   *  on success; a thrown error leaves the page free to retry. */
  handleApply: (body: unknown) => Promise<TResult>
  /** Logged once the server is listening, given its localhost URL. */
  onReady: (url: string) => void
  port?: number
  /** Open the URL in the system browser once listening. Default true. */
  open?: boolean
  onProgress?: (msg: string) => void
  /** Exact local media routes exposed only for the lifetime of this review. */
  assets?: ReadonlyMap<string, { path: string; contentType: string }>
  /**
   * Extra JSON routes (the pick page's state and reroll endpoints). Return
   * undefined to fall through to the built-in routes. A POST body is parsed
   * JSON, held to the same origin, type and size checks as `/apply`.
   */
  handleRequest?: (method: string, url: string, body: unknown) => Promise<{ status: number; body: unknown } | undefined>
}

async function readJsonBody(
  req: import("node:http").IncomingMessage,
  res: import("node:http").ServerResponse,
): Promise<{ ok: true; body: unknown } | { ok: false }> {
  const expectedOrigin = req.headers.host ? `http://${req.headers.host}` : null
  if (req.headers.origin && req.headers.origin !== expectedOrigin) {
    res.writeHead(403, { "Content-Type": "text/plain" })
    res.end("cross-origin review submissions are not allowed")
    return { ok: false }
  }
  if (!req.headers["content-type"]?.toLowerCase().startsWith("application/json")) {
    res.writeHead(415, { "Content-Type": "text/plain" })
    res.end("application/json is required")
    return { ok: false }
  }
  const chunks: Buffer[] = []
  let bytes = 0
  for await (const c of req) {
    const chunk = c as Buffer
    bytes += chunk.length
    if (bytes > 64 * 1024) {
      res.writeHead(413, { "Content-Type": "text/plain" })
      res.end("review submission is too large")
      return { ok: false }
    }
    chunks.push(chunk)
  }
  return { ok: true, body: JSON.parse(Buffer.concat(chunks).toString("utf8")) }
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
            // A frame route names one cached candidate for the life of this
            // server, so the browser may keep it; everything else is re-read.
            "Cache-Control": req.url.includes("/review-frame/") ? "private, max-age=86400, immutable" : "no-store",
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
        res.end(typeof opts.html === "function" ? opts.html() : opts.html)
        return
      }

      if (opts.handleRequest && req.url && req.url !== "/apply" && (req.method === "GET" || req.method === "POST")) {
        try {
          let body: unknown = undefined
          if (req.method === "POST") {
            const parsed = await readJsonBody(req, res)
            if (!parsed.ok) return
            body = parsed.body
          }
          const handled = await opts.handleRequest(req.method, req.url, body)
          if (handled) {
            res.writeHead(handled.status, { "Content-Type": "application/json", "Cache-Control": "no-store" })
            res.end(JSON.stringify(handled.body))
            return
          }
        } catch (err) {
          res.writeHead(400, { "Content-Type": "text/plain" })
          res.end(err instanceof Error ? err.message : String(err))
          return
        }
      }

      if (req.method === "POST" && req.url === "/apply") {
        try {
          const parsed = await readJsonBody(req, res)
          if (!parsed.ok) return
          const result = await opts.handleApply(parsed.body)
          res.writeHead(200, { "Content-Type": "application/json" })
          res.end(JSON.stringify(result))
          server.close(() => resolve(result))
          res.on("finish", () => server.closeIdleConnections?.())
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
      const url = `http://127.0.0.1:${port}/`
      opts.onReady(url)
      if (opts.open !== false) openExternal(url)
    })
  })
}
