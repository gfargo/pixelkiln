import { saveLock, upsert } from "../lock.ts"
import type { Provider } from "../provider.ts"
import type { Lock } from "../types.ts"

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

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
}

/**
 * Advances every unfinished lock entry to its settled state.
 *
 * Safe to run repeatedly and safe to interrupt — all state lives in the
 * lockfile, so a re-run picks up exactly where the last one stopped. Provider
 * quirks (a job record that expires before its image does, review-status
 * candidate lists) are the provider's problem, not this loop's.
 */
export async function poll(
  provider: Provider,
  lock: Lock,
  lockPath: string,
  opts: PollOptions = {},
): Promise<PollResult> {
  const interval = opts.intervalMs ?? 5000
  const timeout = opts.timeoutMs ?? 15 * 60 * 1000
  const log = opts.onProgress ?? (() => {})
  const started = Date.now()

  const result: PollResult = { review: 0, completed: 0, failed: 0, stillRunning: 0 }

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
        const state = await provider.poll(entry.jobId!, entry.generator)
        if (state.status === "review") {
          upsert(lock, key, { status: "review", reviewObjectId: entry.jobId })
          result.review++
          log(`  review  ${key} (${state.candidateUrls.length} candidates)`)
        } else if (state.status === "ready") {
          upsert(lock, key, {
            status: "selected",
            objectId: state.objectId,
            sourceUrl: state.sourceUrl,
          })
          result.completed++
          log(`  ready   ${key}`)
        } else if (state.status === "failed") {
          upsert(lock, key, { status: "failed", error: state.error })
          result.failed++
          log(`  FAILED  ${key}: ${state.error}`)
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
