import { createServer } from "node:http"
import { spawn } from "node:child_process"

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
}

export function serveReviewPage<TResult>(opts: ReviewServerOptions<TResult>): Promise<TResult> {
  const log = opts.onProgress ?? (() => {})

  return new Promise<TResult>((resolve, reject) => {
    const server = createServer(async (req, res) => {
      if (req.method === "GET" && (req.url === "/" || req.url?.startsWith("/?"))) {
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" })
        res.end(opts.html)
        return
      }

      if (req.method === "POST" && req.url === "/apply") {
        try {
          const chunks: Buffer[] = []
          for await (const c of req) chunks.push(c as Buffer)
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
