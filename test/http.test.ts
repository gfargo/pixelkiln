import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { backoffMs, fetchWithRetry, MAX_RETRIES, retryAfterMs, shouldRetry } from "../src/http.ts"
import { PixelLabClient } from "../src/client.ts"
import { createProvider } from "../src/providers/registry.ts"
import { FAKE_PNG } from "../src/providers/fake.ts"

const instant = async () => {}

function reply(status: number, body = "", headers: Record<string, string> = {}): Response {
  return new Response(body, { status, headers })
}

describe("retry policy", () => {
  it("retries throttling, timeouts, and passing server faults only", () => {
    for (const status of [408, 429, 500, 502, 503, 504]) expect(shouldRetry(status)).toBe(true)
    for (const status of [400, 401, 404, 422, 501, 505, 507]) expect(shouldRetry(status)).toBe(false)
  })

  it("backs off exponentially and caps", () => {
    expect(backoffMs(0)).toBeLessThan(backoffMs(3))
    expect(backoffMs(MAX_RETRIES + 5)).toBeLessThanOrEqual(16_400)
  })

  it("understands both Retry-After seconds and HTTP dates", () => {
    expect(retryAfterMs("2", 0)).toBe(2000)
    expect(retryAfterMs("Thu, 01 Jan 1970 00:00:03 GMT", 1000)).toBe(2000)
    expect(retryAfterMs("not a date", 0)).toBeNull()
  })
})

describe("fetchWithRetry", () => {
  it("returns the first successful response and resends the same request", async () => {
    const request = vi.fn(async () => reply(200, "ok"))
    const http = fetchWithRetry(request as unknown as typeof fetch, { sleep: instant })
    const res = await http("https://api.test/x", { method: "POST", body: "{}" })
    expect(await res.text()).toBe("ok")
    expect(request).toHaveBeenCalledTimes(1)
    const [, init] = request.mock.calls[0]! as unknown as [string, RequestInit]
    expect(init.method).toBe("POST")
    expect(init.body).toBe("{}")
    expect(init.signal).toBeInstanceOf(AbortSignal)
  })

  it("retries a transport failure and a 503, then succeeds", async () => {
    let calls = 0
    const request = vi.fn(async () => {
      calls++
      if (calls === 1) throw new TypeError("fetch failed")
      if (calls === 2) return reply(503)
      return reply(200, "third time")
    })
    const waits: number[] = []
    const http = fetchWithRetry(request as unknown as typeof fetch, {
      sleep: async (ms) => { waits.push(ms) },
    })
    expect(await (await http("https://api.test/x")).text()).toBe("third time")
    expect(calls).toBe(3)
    expect(waits).toHaveLength(2)
  })

  it("honours Retry-After over its own backoff", async () => {
    let calls = 0
    const request = vi.fn(async () => (++calls === 1 ? reply(429, "", { "retry-after": "7" }) : reply(200)))
    const waits: number[] = []
    const http = fetchWithRetry(request as unknown as typeof fetch, { sleep: async (ms) => { waits.push(ms) } })
    await http("https://api.test/x")
    expect(waits).toEqual([7000])
  })

  it("gives up after the configured attempts and hands back the last response", async () => {
    const request = vi.fn(async () => reply(502))
    const http = fetchWithRetry(request as unknown as typeof fetch, { retries: 2, sleep: instant })
    const res = await http("https://api.test/x")
    expect(res.status).toBe(502)
    expect(request).toHaveBeenCalledTimes(3)
  })

  it("rethrows a transport failure once attempts run out", async () => {
    const request = vi.fn(async () => { throw new TypeError("fetch failed") })
    const http = fetchWithRetry(request as unknown as typeof fetch, { retries: 1, sleep: instant })
    await expect(http("https://api.test/x")).rejects.toThrow("fetch failed")
    expect(request).toHaveBeenCalledTimes(2)
  })

  it("does not retry a 4xx", async () => {
    const request = vi.fn(async () => reply(404))
    const http = fetchWithRetry(request as unknown as typeof fetch, { sleep: instant })
    expect((await http("https://api.test/x")).status).toBe(404)
    expect(request).toHaveBeenCalledTimes(1)
  })

  it("lets one call opt out of retrying", async () => {
    const request = vi.fn(async () => reply(503))
    const http = fetchWithRetry(request as unknown as typeof fetch, { sleep: instant })
    expect((await http("https://api.test/x", { retries: 0 })).status).toBe(503)
    expect(request).toHaveBeenCalledTimes(1)
  })

  it("does not retry when the caller aborted", async () => {
    const controller = new AbortController()
    const request = vi.fn(async (_input: unknown, init?: RequestInit) => {
      controller.abort()
      throw init!.signal!.reason ?? new Error("aborted")
    })
    const http = fetchWithRetry(request as unknown as typeof fetch, { sleep: instant })
    await expect(http("https://api.test/x", { signal: controller.signal })).rejects.toBeTruthy()
    expect(request).toHaveBeenCalledTimes(1)
  })

  it("looks the global fetch up per call when none is injected", async () => {
    const http = fetchWithRetry(undefined, { sleep: instant })
    let calls = 0
    vi.stubGlobal("fetch", vi.fn(async () => (++calls === 1 ? reply(500) : reply(200, "later"))))
    try {
      expect(await (await http("https://api.test/x")).text()).toBe("later")
      expect(calls).toBe(2)
    } finally {
      vi.unstubAllGlobals()
    }
  })
})

/**
 * Each client goes through the shared policy. A 429 carrying Retry-After: 0
 * proves it without waiting on a timer: the second attempt runs at once.
 */
describe("every provider client retries", () => {
  const env: Record<string, string | undefined> = {}
  const keys = ["RD_API_KEY", "SCENARIO_SDK_API_KEY", "SCENARIO_SDK_API_SECRET", "PIXELLAB_API_KEY"]
  beforeEach(() => {
    for (const key of keys) env[key] = process.env[key]
  })
  afterEach(() => {
    vi.unstubAllGlobals()
    for (const key of keys) {
      if (env[key] === undefined) delete process.env[key]
      else process.env[key] = env[key]
    }
  })

  function throttleOnce(body: string) {
    let calls = 0
    const request = vi.fn(async () => (++calls === 1
      ? reply(429, "", { "retry-after": "0" })
      : new Response(body, { status: 200, headers: { "Content-Type": "application/json" } })))
    vi.stubGlobal("fetch", request)
    return request
  }

  it("PixelLab", async () => {
    const request = throttleOnce(JSON.stringify({ credits: { usd: 1 }, subscription: { generations: 2, total: 3, plan: "p" } }))
    await expect(new PixelLabClient("key").balance()).resolves.toMatchObject({ usd: 1 })
    expect(request).toHaveBeenCalledTimes(2)
  })

  it("Retro Diffusion", async () => {
    process.env.RD_API_KEY = "rdpk-test"
    const request = throttleOnce(JSON.stringify({ balance: 4.5 }))
    await expect(createProvider("retrodiffusion", "online").balance?.()).resolves.toMatchObject({ remaining: 4.5 })
    expect(request).toHaveBeenCalledTimes(2)
  })

  it("Scenario", async () => {
    process.env.SCENARIO_SDK_API_KEY = "k"
    process.env.SCENARIO_SDK_API_SECRET = "s"
    let calls = 0
    // Throttle the check and the first download attempt; the second attempt gets bytes.
    const request = vi.fn(async () => (++calls <= 2
      ? reply(429, "", { "retry-after": "0" })
      : new Response(FAKE_PNG, { status: 200 })))
    vi.stubGlobal("fetch", request)
    const provider = createProvider("scenario", "online")
    // The connectivity check opts out of retrying so doctor answers fast.
    await expect(provider.checkConnection?.()).rejects.toThrow(/429/)
    expect(request).toHaveBeenCalledTimes(1)
    // A download goes through the retrying path.
    await expect(provider.download("https://cdn.test/out.png")).resolves.toBeInstanceOf(Buffer)
    expect(request).toHaveBeenCalledTimes(3)
  })

  it("ComfyUI", async () => {
    let calls = 0
    vi.stubGlobal("fetch", vi.fn(async (input: unknown) => {
      calls++
      if (String(input).endsWith("/system_stats")) return reply(429, "", { "retry-after": "0" })
      return calls === 2
        ? reply(429, "", { "retry-after": "0" })
        : new Response(JSON.stringify({}), { status: 200 })
    }))
    const provider = createProvider("comfyui", "online")
    await expect(provider.checkConnection?.()).rejects.toThrow(/429/)
    expect(calls).toBe(1)
    // history polls go through the retrying path
    await expect(provider.poll("missing-prompt#9", "map")).resolves.toMatchObject({ status: "processing" })
    expect(calls).toBeGreaterThanOrEqual(3)
  })
})
