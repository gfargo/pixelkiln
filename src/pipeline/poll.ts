import { PixelLabError, type PixelLabClient } from "../client.ts"
import { saveLock, upsert } from "../lock.ts"
import type { Lock } from "../types.ts"

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/**
 * Documented retention for the map-object *record*. Treated as advisory: the
 * resulting image has been observed to outlive it in the objects collection.
 */
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

          // The map-object record is documented to auto-delete after 8 hours,
          // but observation says the resulting IMAGE outlives it: a 32x36
          // sprite generated in March 2026 still resolves from /v2/objects
          // four months on, while /v2/map-objects/{id} 404s for the same id.
          // So a missing map-object record is not proof the work is lost —
          // check the objects collection before writing anything off.
          let obj: Awaited<ReturnType<typeof client.getMapObject>>
          try {
            obj = await client.getMapObject(entry.jobId!)
          } catch (err) {
            const gone = err instanceof PixelLabError && err.status === 404
            if (!gone) throw err
            const survivor = await client.getObject(entry.jobId!).catch(() => null)
            const url = survivor?.rotation_urls
              ? Object.values(survivor.rotation_urls).find((u): u is string => typeof u === "string")
              : (survivor?.preview_url ?? null)
            if (survivor?.status === "completed" && url) {
              upsert(lock, key, { status: "selected", objectId: survivor.id, sourceUrl: url })
              result.completed++
              log(`  ready   ${key} (map record gone; image recovered from /objects)`)
            } else {
              upsert(lock, key, {
                status: "failed",
                error: "map object record deleted upstream and no surviving image found",
              })
              result.expired++
              log(`  EXPIRED ${key}`)
            }
            continue
          }

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
            // Only warn. The record still exists and is not reporting failure,
            // so age alone is not evidence the work is lost — and marking it
            // failed here would offer to re-pay for a recoverable object.
            log(`  waiting ${key} — past the documented 8h window but still listed`)
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
