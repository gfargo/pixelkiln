import { createServer } from "node:http"
import { spawn } from "node:child_process"
import type { Provider } from "../provider.ts"
import { saveLock, upsert } from "../lock.ts"
import type { Lock } from "../types.ts"
import { renderSheet, type SheetGroup } from "./sheet.ts"

export interface PickResult {
  selected: number
  skipped: number
}

/**
 * Serves the contact sheet on localhost, waits for the selections to be
 * applied, then shuts down.
 *
 * Selections are committed to PixelLab (`select-frames` promotes the chosen
 * candidate to its own object and drops the rest) and written to the lockfile
 * before the browser gets its response, so a closed tab never loses a choice.
 */
export async function runPicker(
  provider: Provider,
  lock: Lock,
  lockPath: string,
  opts: { port?: number; open?: boolean; onProgress?: (msg: string) => void } = {},
): Promise<PickResult> {
  const log = opts.onProgress ?? (() => {})

  const groups: SheetGroup[] = []
  for (const [key, entry] of Object.entries(lock.entries)) {
    if (entry.status !== "review" || !entry.reviewObjectId) continue
    try {
      const state = await provider.poll(entry.reviewObjectId, entry.generator)
      if (state.status !== "review" || !state.candidateUrls.length) continue
      groups.push({
        key,
        assetId: entry.assetId,
        styleId: entry.styleId,
        prompt: entry.prompt,
        reviewObjectId: entry.reviewObjectId,
        frameUrls: state.candidateUrls,
        size: Math.max(entry.width, entry.height),
      })
    } catch (err) {
      log(`  could not load candidates for ${key}: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  if (groups.length === 0) return { selected: 0, skipped: 0 }

  const html = renderSheet(groups)
  const byKey = new Map(groups.map((g) => [g.key, g]))
  let result: PickResult = { selected: 0, skipped: groups.length }

  return new Promise<PickResult>((resolve, reject) => {
    const server = createServer(async (req, res) => {
      if (req.method === "GET" && (req.url === "/" || req.url?.startsWith("/?"))) {
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" })
        res.end(html)
        return
      }

      if (req.method === "POST" && req.url === "/apply") {
        try {
          const chunks: Buffer[] = []
          for await (const c of req) chunks.push(c as Buffer)
          const { selections } = JSON.parse(Buffer.concat(chunks).toString("utf8")) as {
            selections: { key: string; index: number }[]
          }

          let selected = 0
          for (const { key, index } of selections) {
            const group = byKey.get(key)
            const entry = lock.entries[key]
            if (!group || !entry?.reviewObjectId) continue
            if (!Number.isInteger(index) || index < 0 || index >= group.frameUrls.length) continue

            // Promote the chosen candidate; the review parent is removed upstream
            // once nothing is left in it.
            const { objectId, sourceUrl } = await provider.selectCandidate(
              entry.reviewObjectId,
              index,
              `asset:${entry.assetId}`,
            )

            upsert(lock, key, {
              status: "selected",
              objectId,
              candidateIndex: index,
              sourceUrl: sourceUrl ?? group.frameUrls[index] ?? null,
              provider: provider.id,
            })
            selected++
            log(`  picked  ${key} → candidate ${index + 1}`)
          }

          await saveLock(lockPath, lock)
          result = { selected, skipped: groups.length - selected }
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
      const url = `http://127.0.0.1:${port}/`
      log(`\n  ${groups.length} asset(s) awaiting selection: ${url}`)
      log(`  (leave this running; it exits once you apply)\n`)
      if (opts.open !== false && process.platform === "darwin") {
        spawn("open", [url], { stdio: "ignore", detached: true }).unref()
      }
    })
  })
}
