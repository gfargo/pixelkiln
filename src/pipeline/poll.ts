import type { PixelLabClient } from "../client.ts"
import { saveLock, upsert } from "../lock.ts"
import type { Lock } from "../types.ts"

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** Map objects are deleted upstream 8 hours after creation. */
export const MAP_OBJECT_TTL_MS = 8 * 60 * 60 * 1000

export interface PollOptions {
  intervalMs?: number
  timeoutMs?: number
  onProgress?: (msg: string) => void
}

export interface PollResult {
  review: number
  completed: number
  failed: number
  stillRunning: number
  expired: number
}

/**
 * Advances every unfinished lock entry to its settled state.
 *
 * Safe to run repeatedly and safe to interrupt — all state lives in the
 * lockfile, so a re-run picks up exactly where the last one stopped.
 */
export async function poll(
  client: PixelLabClient,
  lock: Lock,
  lockPath: string,
  opts: PollOptions = {},
): Promise<PollResult> {
  const interval = opts.intervalMs ?? 5000
  const timeout = opts.timeoutMs ?? 15 * 60 * 1000
  const log = opts.onProgress ?? (() => {})
  const started = Date.now()

  const result: PollResult = { review: 0, completed: 0, failed: 0, stillRunning: 0, expired: 0 }

  const pending = () =>
    Object.entries(lock.entries).filter(
      ([, e]) => e.jobId && (e.status === "pending" || e.status === "processing"),
    )

  while (pending().length > 0) {
    if (Date.now() - started > timeout) {
      result.stillRunning = pending().length
      log(`  timed out with ${result.stillRunning} job(s) still running — re-run \`poll\` to resume`)
      break
    }

    for (const [key, entry] of pending()) {
      try {
        if (entry.generator === "map") {
          const age = entry.submittedAt ? Date.now() - Date.parse(entry.submittedAt) : 0
          const obj = await client.getMapObject(entry.jobId!)
          if (obj.status === "completed" && obj.download_url) {
            upsert(lock, key, {
              status: "selected",
              objectId: entry.jobId,
              sourceUrl: obj.download_url,
            })
            result.completed++
            log(`  ready   ${key}`)
          } else if (obj.status === "failed") {
            upsert(lock, key, { status: "failed", error: "generation failed upstream" })
            result.failed++
            log(`  FAILED  ${key}`)
          } else if (age > MAP_OBJECT_TTL_MS) {
            // Past the upstream retention window the object is gone for good;
            // marking it failed makes the next `plan` show it as re-runnable.
            upsert(lock, key, {
              status: "failed",
              error: "map object expired (8h upstream retention) before download",
            })
            result.expired++
            log(`  EXPIRED ${key} — map objects must be fetched within 8h of submit`)
          }
          continue
        }

        const obj = await client.getObject(entry.jobId!)
        if (obj.status === "review") {
          upsert(lock, key, { status: "review", reviewObjectId: entry.jobId })
          result.review++
          log(`  review  ${key} (${obj.frame_urls?.length ?? 0} candidates)`)
        } else if (obj.status === "completed") {
          // A single-candidate generation skips review and is kept automatically.
          const url = obj.rotation_urls
            ? Object.values(obj.rotation_urls).find((u): u is string => typeof u === "string")
            : (obj.preview_url ?? null)
          upsert(lock, key, {
            status: "selected",
            objectId: obj.id,
            sourceUrl: url ?? null,
          })
          result.completed++
          log(`  ready   ${key}`)
        } else if (obj.status === "failed") {
          upsert(lock, key, { status: "failed", error: "generation failed upstream" })
          result.failed++
          log(`  FAILED  ${key}`)
        }
      } catch (err) {
        log(`  error polling ${key}: ${err instanceof Error ? err.message : String(err)}`)
      }
    }

    await saveLock(lockPath, lock)
    if (pending().length > 0) await sleep(interval)
  }

  await saveLock(lockPath, lock)
  return result
}
