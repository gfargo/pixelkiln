import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { loadManifest, resolveSpecs, resolveStyleImages } from "../src/manifest.ts"
import { createProvider } from "../src/providers/registry.ts"
import { buildPlan } from "../src/pipeline/plan.ts"
import { submit } from "../src/pipeline/submit.ts"
import { poll } from "../src/pipeline/poll.ts"
import { fetchAssets } from "../src/pipeline/fetch.ts"
import { lockKey, type Lock } from "../src/types.ts"
import { existsSync } from "node:fs"
import { FAKE_PNG } from "../src/providers/fake.ts"

const MINIMAL_GIF = Buffer.from(
  "R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==",
  "base64",
)

let dir: string
let oldKey: string | undefined

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "pixelkiln-rd-"))
  oldKey = process.env.RD_API_KEY
})

afterEach(async () => {
  vi.unstubAllGlobals()
  if (oldKey == null) delete process.env.RD_API_KEY
  else process.env.RD_API_KEY = oldKey
  await rm(dir, { recursive: true, force: true })
})

async function project(options: Record<string, unknown> = {}) {
  const manifestPath = path.join(dir, "pixelkiln.manifest.json")
  await writeFile(manifestPath, JSON.stringify({
    name: "rd-test",
    provider: "retrodiffusion",
    styles: {
      base: {
        generator: "map",
        size: 64,
        outDir: "out",
        providerOptions: {
          retrodiffusion: {
            promptStyle: "rd_plus__topdown_asset",
            numImages: 3,
            ...options,
          },
        },
      },
    },
    assets: { anvil: { prompt: "an iron anvil" } },
  }))
  const loaded = await loadManifest(manifestPath)
  const specs = await resolveSpecs(loaded)
  return { loaded, spec: specs[0]! }
}

describe("Retro Diffusion provider", () => {
  it("estimates candidate batches in USD without network access", async () => {
    const { spec } = await project()
    expect(spec).toMatchObject({
      provider: "retrodiffusion",
      costUnit: "usd",
      candidates: 3,
      cost: 0.082,
    })
  })

  it("rounds variable USD estimates up to the live quote precision", async () => {
    process.env.RD_API_KEY = "rdpk-test"
    vi.stubGlobal("fetch", vi.fn(async (_input, init) => {
      const body = JSON.parse(String(init?.body))
      return body.check_cost
        ? json({ balance_cost: 0.058 })
        : json({ status: "accepted", task_id: "rounded-quote" })
    }))

    const { spec } = await project({ numImages: 1 })
    const large = { ...spec, width: 256, height: 256 }
    const provider = createProvider("retrodiffusion", "online")
    expect(provider.estimate(large)).toMatchObject({ unit: "usd", amount: 0.058 })
    await expect(provider.submit(large, [])).resolves.toEqual({ jobId: "rounded-quote" })
  })

  it("accepts the maximum still batch and rejects the first value above it", async () => {
    const { spec } = await project({ numImages: 16 })
    expect(spec).toMatchObject({ candidates: 16, costUnit: "usd" })

    await expect(project({ numImages: 17 })).rejects.toThrow(
      /numImages must be a whole number from 1 to 16/,
    )
  })

  it("enforces the current API dimension boundary", async () => {
    const { spec } = await project({ numImages: 1 })
    const provider = createProvider("retrodiffusion", "offline")

    expect(() => provider.validate?.({ ...spec, width: 15 }, [])).toThrow(
      /between 16 and 512 pixels/,
    )
    expect(() => provider.validate?.({ ...spec, height: 513 }, [])).toThrow(
      /between 16 and 512 pixels/,
    )
    expect(() => provider.validate?.({ ...spec, width: 16, height: 512 }, [])).not.toThrow()
  })

  it("rejects a provider style that does not match its structural generator", async () => {
    const manifestPath = path.join(dir, "pixelkiln.manifest.json")
    await writeFile(manifestPath, JSON.stringify({
      name: "rd-tiles",
      provider: "retrodiffusion",
      styles: {
        base: {
          generator: "tiles",
          outDir: "out",
          providerOptions: {
            retrodiffusion: { promptStyle: "rd_animation__any_animation" },
          },
        },
      },
      assets: { ground: { prompt: "mossy stones" } },
    }))
    await expect(resolveSpecs(await loadManifest(manifestPath))).rejects.toThrow(
      /does not match generator "tiles"/,
    )
  })

  it("submits async hosted-output jobs and exposes candidates to the picker", async () => {
    process.env.RD_API_KEY = "rdpk-test"
    const requests: Array<{ url: string; init?: RequestInit }> = []
    const mockFetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input)
      requests.push({ url, init })
      if (url.endsWith("/inferences")) {
        const body = JSON.parse(String(init?.body))
        if (body.check_cost) return json({ balance_cost: 0.081144 })
        return json({ status: "accepted", task_id: "task-1" })
      }
      return json({
        status: "succeeded",
        result: {
          balance_cost: 0.081144,
          remaining_balance: 9.9,
          output_urls: ["https://cdn.test/0.png", "https://cdn.test/1.png", "https://cdn.test/2.png"],
        },
      })
    })
    vi.stubGlobal("fetch", mockFetch)

    const { loaded, spec } = await project()
    const provider = createProvider("retrodiffusion", "online")
    const submitted = await provider.submit(spec, await resolveStyleImages(loaded, spec.styleId))
    expect(submitted).toEqual({ jobId: "task-1" })

    const quoteBody = JSON.parse(String(requests[0]!.init!.body))
    expect(quoteBody).toMatchObject({
      prompt_style: "rd_plus__topdown_asset",
      num_images: 3,
      check_cost: true,
    })
    expect(quoteBody).not.toHaveProperty("async")

    const body = JSON.parse(String(requests[1]!.init!.body))
    expect(body).toMatchObject({
      prompt_style: "rd_plus__topdown_asset",
      num_images: 3,
      async: true,
      upload_outputs: true,
      remove_bg: true,
    })
    expect(requests[1]!.init!.headers).toMatchObject({ "X-RD-Token": "rdpk-test" })

    await expect(provider.poll("task-1", "map")).resolves.toEqual({
      status: "review",
      candidateUrls: ["https://cdn.test/0.png", "https://cdn.test/1.png", "https://cdn.test/2.png"],
    })
    await expect(provider.selectCandidate?.("task-1", 1)).resolves.toMatchObject({
      objectId: "task-1#1",
      sourceUrl: expect.stringMatching(/^retrodiffusion:\/\/output\?/),
    })
  })

  it("refuses an increased live quote before sending a paid request", async () => {
    process.env.RD_API_KEY = "rdpk-test"
    const mockFetch = vi.fn(async () => json({ balance_cost: 0.5 }))
    vi.stubGlobal("fetch", mockFetch)

    const { spec } = await project()
    const provider = createProvider("retrodiffusion", "online")
    await expect(provider.submit(spec, [])).rejects.toThrow(/above the offline estimate.*no paid request/s)
    expect(mockFetch).toHaveBeenCalledTimes(1)
    const body = JSON.parse(String(mockFetch.mock.calls[0]?.[1]?.body))
    expect(body.check_cost).toBe(true)
  })

  it("refuses a malformed quote before sending a paid request", async () => {
    process.env.RD_API_KEY = "rdpk-test"
    const mockFetch = vi.fn(async () => json({ balance_cost: "0.082" }))
    vi.stubGlobal("fetch", mockFetch)

    const { spec } = await project()
    const provider = createProvider("retrodiffusion", "online")
    await expect(provider.submit(spec, [])).rejects.toThrow(/invalid cost quote/)
    expect(mockFetch).toHaveBeenCalledTimes(1)
  })

  it("passes references for RD Pro and rejects them for incompatible styles", async () => {
    process.env.RD_API_KEY = "rdpk-test"
    const requests: RequestInit[] = []
    vi.stubGlobal("fetch", vi.fn(async (_input, init) => {
      requests.push(init ?? {})
      const body = JSON.parse(String(init?.body))
      return body.check_cost
        ? json({ balance_cost: 0.18 })
        : json({ status: "accepted", task_id: "task-pro" })
    }))
    const reference = { base64: "aW1hZ2U=", width: 32, height: 32, format: "png" as const }

    const { spec: plusSpec } = await project()
    const provider = createProvider("retrodiffusion", "online")
    await expect(provider.submit(plusSpec, [reference])).rejects.toThrow(/does not accept reference_images/)

    const { spec: proSpec } = await project({ promptStyle: "rd_pro__default", numImages: 1 })
    await expect(provider.submit(proSpec, [reference])).resolves.toEqual({ jobId: "task-pro" })
    const paidBody = JSON.parse(String(requests.at(-1)?.body))
    expect(paidBody.reference_images).toEqual(["aW1hZ2U="])
  })

  it("reports the provider's prepaid USD balance", async () => {
    process.env.RD_API_KEY = "rdpk-test"
    vi.stubGlobal("fetch", vi.fn(async () => json({ credits: 0, balance: 12.34 })))
    const provider = createProvider("retrodiffusion", "online")
    await expect(provider.balance?.()).resolves.toEqual({ unit: "usd", remaining: 12.34 })
  })

  it("runs an animation through submit, poll, GIF validation, and recovery caching", async () => {
    process.env.RD_API_KEY = "rdpk-test"
    const manifestPath = path.join(dir, "pixelkiln.manifest.json")
    await writeFile(manifestPath, JSON.stringify({
      name: "rd-animation",
      provider: "retrodiffusion",
      styles: {
        animated: {
          generator: "animation",
          size: 64,
          outDir: "out",
          providerOptions: {
            retrodiffusion: {
              promptStyle: "rd_animation__any_animation",
              numImages: 1,
              framesDuration: 8,
            },
          },
        },
      },
      assets: { corgi: { prompt: "a corgi wagging its tail" } },
    }))
    vi.stubGlobal("fetch", vi.fn(async (input, init) => {
      const url = String(input)
      if (url.endsWith("/inferences")) {
        const body = JSON.parse(String(init?.body))
        return body.check_cost
          ? json({ balance_cost: 0.25 })
          : json({ status: "accepted", task_id: "animation-1" })
      }
      return json({
        status: "succeeded",
        result: { base64_images: [MINIMAL_GIF.toString("base64")], balance_cost: 0.25 },
      })
    }))

    const loaded = await loadManifest(manifestPath)
    const specs = await resolveSpecs(loaded)
    const provider = createProvider("retrodiffusion", "online")
    const lock: Lock = { version: 2, entries: {} }
    const lockPath = path.join(dir, "pixelkiln.lock.json")
    const plan = await buildPlan(specs, lock)
    await submit(provider, loaded, plan.actionable, lock, lockPath, { spacingMs: 0, budget: 0.25 })
    await poll(provider, lock, lockPath, { intervalMs: 0, specs })
    await expect(fetchAssets(provider, specs, lock, lockPath)).resolves.toMatchObject({
      downloaded: 1,
      failed: 0,
    })

    const entry = lock.entries[lockKey("animated", "corgi")]!
    expect(entry.outputs[0]).toMatchObject({ mediaType: "image/gif", path: "out/corgi.gif" })
    expect(existsSync(path.join(dir, "out/corgi.gif"))).toBe(true)
    expect(existsSync(path.join(dir, ".pixelkiln/cache", `${entry.outputs[0]!.sha256}.gif`))).toBe(true)
    expect(entry.providerMetadata.retrodiffusion).toMatchObject({
      kind: "animation",
      mediaType: "image/gif",
      promptStyle: "rd_animation__any_animation",
    })

    await rm(path.join(dir, "out/corgi.gif"))
    const downloads = createProvider("retrodiffusion", "downloads")
    await expect(fetchAssets(downloads, specs, lock, lockPath, { repair: true })).resolves.toMatchObject({
      downloaded: 1,
      failed: 0,
    })
    await expect(readFile(path.join(dir, "out/corgi.gif"))).resolves.toEqual(MINIMAL_GIF)
  })

  it("maps Retro Diffusion tilesets to structural PNG sheet metadata", async () => {
    process.env.RD_API_KEY = "rdpk-test"
    const manifestPath = path.join(dir, "pixelkiln.manifest.json")
    await writeFile(manifestPath, JSON.stringify({
      name: "rd-tiles",
      provider: "retrodiffusion",
      styles: {
        ground: {
          generator: "tiles",
          tileSize: 32,
          outDir: "out",
          providerOptions: {
            retrodiffusion: { promptStyle: "rd_tile__tileset", numImages: 1 },
          },
        },
      },
      assets: { moss: { prompt: "mossy stones and dark soil" } },
    }))
    vi.stubGlobal("fetch", vi.fn(async (input, init) => {
      const url = String(input)
      if (url.endsWith("/inferences")) {
        const body = JSON.parse(String(init?.body))
        return body.check_cost
          ? json({ balance_cost: 0.1 })
          : json({ status: "accepted", task_id: "tiles-1" })
      }
      return json({
        status: "succeeded",
        result: { base64_images: [FAKE_PNG.toString("base64")], balance_cost: 0.1 },
      })
    }))

    const loaded = await loadManifest(manifestPath)
    const specs = await resolveSpecs(loaded)
    expect(specs[0]).toMatchObject({ generator: "tiles", cost: 0.1, candidates: 1 })
    const provider = createProvider("retrodiffusion", "online")
    const { jobId } = await provider.submit(specs[0]!, [])
    await expect(provider.poll(jobId, "tiles", { spec: specs[0] })).resolves.toMatchObject({
      status: "ready",
      sources: [{ mediaType: "image/png" }],
      metadata: {
        kind: "tileset",
        promptStyle: "rd_tile__tileset",
        width: 32,
        height: 32,
      },
    })
  })

  it("falls back to inline output when hosted URLs are empty", async () => {
    process.env.RD_API_KEY = "rdpk-test"
    vi.stubGlobal("fetch", vi.fn(async () => json({
      status: "succeeded",
      result: {
        output_urls: [""],
        base64_images: [FAKE_PNG.toString("base64")],
      },
    })))

    const provider = createProvider("retrodiffusion", "online")
    await expect(provider.poll("task-inline", "map")).resolves.toMatchObject({
      status: "ready",
      objectId: "task-inline#0",
      sourceUrl: expect.stringMatching(/^retrodiffusion:\/\/output\?/),
      sources: [{ mediaType: "image/png" }],
    })
  })

  it("persists a durable reference and resolves a fresh signed download URL", async () => {
    process.env.RD_API_KEY = "rdpk-test"
    const signed = new URL("https://cdn.example.test/output.png")
    signed.searchParams.set("X-Amz-Credential", "temporary")
    signed.searchParams.set("X-Amz-Signature", "secret")
    vi.stubGlobal("fetch", vi.fn(async (input) => {
      const url = String(input)
      if (url.startsWith("https://api.retrodiffusion.ai/")) {
        return json({ status: "succeeded", result: { output_urls: [signed.href] } })
      }
      if (url === signed.href) return new Response(FAKE_PNG, { status: 200 })
      return new Response("not found", { status: 404 })
    }))

    const provider = createProvider("retrodiffusion", "online")
    const state = await provider.poll("task-durable", "map")
    expect(state).toMatchObject({
      status: "ready",
      objectId: "task-durable#0",
      sourceUrl: expect.stringMatching(/^retrodiffusion:\/\/output\?/),
    })
    if (state.status !== "ready" || !state.sourceUrl) throw new Error("expected ready source")
    expect(state.sourceUrl).not.toContain("X-Amz")
    await expect(provider.download(state.sourceUrl)).resolves.toEqual(FAKE_PNG)
  })
})

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json" },
  })
}
