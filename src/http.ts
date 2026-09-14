/**
 * One retry policy for every provider.
 *
 * The policy started life inside the PixelLab client, and its reasoning holds
 * for every backend PixelKiln talks to: retry only what is safe to retry
 * (transport failures, 408, 429, 5xx), honour Retry-After, back off with
 * jitter so parallel workers don't retry in lockstep, and give up after a
 * bounded number of attempts. POSTs that create work are included on purpose.
 * A dropped asset in a 65-item run is more common than a duplicate job, and a
 * duplicate is visible and free to delete whereas a silent gap is neither.
 *
 * Every attempt gets its own timeout unless the caller brings a signal. An
 * abort the caller asked for is never retried; a timeout of our own is.
 */

export const MAX_RETRIES = 4
export const DEFAULT_TIMEOUT_MS = 120_000

const sleepFor = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

/**
 * Throttling, a timed-out request, and the four 5xx codes that describe a
 * passing condition. 501, 505, 507 and friends describe the server itself
 * and will not clear in the next sixteen seconds.
 */
export function shouldRetry(status: number): boolean {
  return status === 408 || status === 429 || status === 500 || status === 502 || status === 503 || status === 504
}

/** Exponential backoff with jitter, so parallel workers don't retry in lockstep. */
export function backoffMs(attempt: number): number {
  const base = Math.min(1000 * 2 ** attempt, 16_000)
  return base + Math.floor(Math.random() * 400)
}

/** Supports both Retry-After forms: seconds and an HTTP date. */
export function retryAfterMs(value: string | null, now = Date.now()): number | null {
  if (!value) return null
  const seconds = Number(value)
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000
  const date = Date.parse(value)
  if (!Number.isFinite(date)) return null
  return Math.max(0, date - now)
}

export interface RetryOptions {
  /** Attempts after the first. 0 disables retrying. */
  retries?: number
  /** Per-attempt timeout used when the caller passes no signal. */
  timeoutMs?: number
  /** Replaced in tests so backoff costs no wall-clock time. */
  sleep?: (ms: number) => Promise<void>
  /** Called before each wait; lets a client log or count retries. */
  onRetry?: (info: { attempt: number; waitMs: number; status?: number; error?: unknown }) => void
}

/** `fetch` init plus a per-call override of how many times to retry. */
export type RetryInit = RequestInit & { retries?: number }

export type RetryingFetch = (input: string | URL, init?: RetryInit) => Promise<Response>

/**
 * Wrap a `fetch`-shaped function so it retries. When `request` is omitted the
 * global fetch is looked up per call, so tests that stub it after a client
 * was built still take effect.
 */
export function fetchWithRetry(request?: typeof fetch, opts: RetryOptions = {}): RetryingFetch {
  const sleep = opts.sleep ?? sleepFor
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const send: typeof fetch = request ?? ((input, init) => globalThis.fetch(input, init))

  return async (input, init) => {
    const { retries: perCall, ...rest } = init ?? {}
    const retries = Math.max(0, perCall ?? opts.retries ?? MAX_RETRIES)
    for (let attempt = 0; ; attempt++) {
      const signal = rest.signal ?? AbortSignal.timeout(timeoutMs)
      let res: Response
      try {
        res = await send(input, { ...rest, signal })
      } catch (error) {
        // The caller's own abort is a decision, not a fault.
        if (rest.signal?.aborted || attempt >= retries) throw error
        const waitMs = backoffMs(attempt)
        opts.onRetry?.({ attempt, waitMs, error })
        await sleep(waitMs)
        continue
      }
      if (res.ok || !shouldRetry(res.status) || attempt >= retries) return res
      // The server knows better than we do how long to wait.
      const waitMs = retryAfterMs(res.headers.get("retry-after")) ?? backoffMs(attempt)
      await res.body?.cancel().catch(() => {})
      opts.onRetry?.({ attempt, waitMs, status: res.status })
      await sleep(waitMs)
    }
  }
}
