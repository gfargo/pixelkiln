import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { existsSync } from "node:fs"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { loadManifest, resolveSpecs } from "../src/manifest.ts"
import { loadLock } from "../src/lock.ts"
import { buildPlan } from "../src/pipeline/plan.ts"
import { submit } from "../src/pipeline/submit.ts"
import { poll } from "../src/pipeline/poll.ts"
import { fetchAssets } from "../src/pipeline/fetch.ts"
import {
  createProvider,
  providerCredentialEnvs,
  providerFactory,
} from "../src/providers/registry.ts"
import { FAKE_PNG } from "../src/providers/fake.ts"
import { lockKey, type Lock, type ResolvedSpec } from "../src/types.ts"

let dir: string
let oldKey: string | undefined
let oldSecret: string | undefined
let oldBase: string | undefined

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "pixelkiln-scenario-"))
  oldKey = process.env.SCENARIO_SDK_API_KEY
  oldSecret = process.env.SCENARIO_SDK_API_SECRET
  oldBase = process.env.SCENARIO_API_BASE_URL
  process.env.SCENARIO_SDK_API_KEY = "scenario-key"
  process.env.SCENARIO_SDK_API_SECRET = "scenario-secret"
  process.env.SCENARIO_API_BASE_URL = "https://scenario.test/v1"
})

afterEach(async () => {
  vi.unstubAllGlobals()
  restoreEnv("SCENARIO_SDK_API_KEY", oldKey)
  restoreEnv("SCENARIO_SDK_API_SECRET", oldSecret)
  restoreEnv("SCENARIO_API_BASE_URL", oldBase)
  await rm(dir, { recursive: true, force: true })
})

async function project(
  options: Record<string, unknown> = {},
  asset: Record<string, unknown> = {},
): Promise<{ manifestPath: string; lockPath: string; spec: ResolvedSpec }> {
  const manifestPath = path.join(dir, "pixelkiln.manifest.json")
  const lockPath = path.join(dir, "pixelkiln.lock.json")
  await writeFile(manifestPath, JSON.stringify({
    name: "scenario-test",
    provider: "scenario",
    styles: {
      base: {
        generator: "map",
        size: 512,
        outDir: "out",
        providerOptions: {
          scenario: {
            modelId: "model_bfl-flux-2-dev",
            maxComputeUnits: 20,
            numOutputs: 1,
            projectId: "project-test",
            parameters: { guidance: 4 },
            ...options,
          },
        },
      },
    },
    assets: { keep: { prompt: "a mountain keep", ...asset } },
  }))
  const loaded = await loadManifest(manifestPath)
  const [spec] = await resolveSpecs(loaded)
  return { manifestPath, lockPath, spec: spec! }
}

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  })
}

function requestPath(input: string | URL | Request): string {
  return new URL(String(input)).pathname
}

describe("Scenario provider", () => {
  it("registers both credentials and plans offline without network access", async () => {
    const factory = providerFactory("scenario")
    expect(providerCredentialEnvs(factory)).toEqual([
      "SCENARIO_SDK_API_KEY",
      "SCENARIO_SDK_API_SECRET",
    ])
    const network = vi.fn()
    vi.stubGlobal("fetch", network)

    const { spec } = await project()
    expect(spec).toMatchObject({
      provider: "scenario",
      cost: 20,
      costUnit: "compute-units",
      candidates: 1,
    })
    expect(network).not.toHaveBeenCalled()
  })

  it("changes spec identity when the Scenario model contract changes", async () => {
    const first = await project({ parameters: { guidance: 4 } })
    const firstHash = first.spec.specHash
    const second = await project({ parameters: { guidance: 5 } })
    expect(second.spec.specHash).not.toBe(firstHash)
  })

  it.each([
    [{ modelId: "" }, /modelId is required/],
    [{ maxComputeUnits: 0 }, /maxComputeUnits must be a positive number/],
    [{ numOutputs: 0 }, /numOutputs must be a whole number from 1 to 4/],
    [{ numOutputs: 5 }, /numOutputs must be a whole number from 1 to 4/],
    [{ projectId: "" }, /projectId must be a non-empty string/],
    [{ parameters: { prompt: "override" } }, /parameters.prompt.*cannot be overridden/],
  ])("rejects invalid provider options %#", async (options, expected) => {
    await expect(project(options)).rejects.toThrow(expected)
  })

  it("rejects unsupported dimensions and style images before submission", async () => {
    await expect(project({}, { width: 130, height: 512 })).rejects.toThrow(/multiples of 16/)

    const reference = path.join(dir, "reference.png")
    await writeFile(reference, FAKE_PNG)
    const manifestPath = path.join(dir, "with-reference.json")
    await writeFile(manifestPath, JSON.stringify({
      name: "scenario-reference",
      provider: "scenario",
      styles: {
        base: {
          generator: "map",
          size: 512,
          outDir: "out",
          styleImages: [{ path: "reference.png" }],
          providerOptions: {
            scenario: { modelId: "model_bfl-flux-2-dev", maxComputeUnits: 20 },
          },
        },
      },
      assets: { keep: { prompt: "a keep" } },
    }))
    await expect(resolveSpecs(await loadManifest(manifestPath))).rejects.toThrow(
      /styleImages are not supported yet/,
    )
  })

  it("sends an identical body through free preflight before the paid request", async () => {
    const requests: Array<{ url: URL; init: RequestInit }> = []
    vi.stubGlobal("fetch", vi.fn(async (input, init) => {
      const url = new URL(String(input))
      requests.push({ url, init: init ?? {} })
      return url.searchParams.get("dryRun") === "true"
        ? json({ creativeUnitsCost: 7.5, costDetails: { "custom-generation": 7.5 } }, 269)
        : json({ job: { jobId: "job-1", status: "queued" } })
    }))

    const { spec } = await project({ numOutputs: 2 })
    const result = await createProvider("scenario", "online").submit(spec, [])

    expect(requests).toHaveLength(2)
    expect(requests[0]!.url.searchParams.get("dryRun")).toBe("true")
    expect(requests[1]!.url.searchParams.has("dryRun")).toBe(false)
    expect(requests[0]!.url.searchParams.get("projectId")).toBe("project-test")
    expect(requests[0]!.init.body).toBe(requests[1]!.init.body)
    expect(JSON.parse(String(requests[0]!.init.body))).toEqual({
      guidance: 4,
      prompt: "a mountain keep",
      width: 512,
      height: 512,
      numOutputs: 2,
    })
    expect(requests[0]!.init.headers).toMatchObject({
      Authorization: `Basic ${Buffer.from("scenario-key:scenario-secret").toString("base64")}`,
    })
    expect(result).toMatchObject({
      jobId: expect.stringMatching(/^scenario:\/\/job\?/),
      metadata: {
        quotedComputeUnits: 7.5,
        maxComputeUnits: 20,
        costDetails: { "custom-generation": 7.5 },
      },
    })
  })

  it("does not double-count costDetails but includes separately billed detection", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input) => {
      const url = new URL(String(input))
      return url.searchParams.get("dryRun") === "true"
        ? json({
            creativeUnitsCost: 12,
            costDetails: { "custom-generation": 10, "quality-gate": 2 },
            ipDetection: { creativeUnitsCharged: 1 },
          }, 269)
        : json({ job: { jobId: "job-cost", status: "queued" } })
    }))
    const { spec } = await project({ maxComputeUnits: 13 })
    await expect(createProvider("scenario", "online").submit(spec, []))
      .resolves.toMatchObject({ metadata: { quotedComputeUnits: 13 } })
  })

  it.each([
    [{}, /invalid creativeUnitsCost/],
    [{ creativeUnitsCost: "7" }, /invalid creativeUnitsCost/],
    [{ creativeUnitsCost: Number.NaN }, /invalid creativeUnitsCost/],
    [{ creativeUnitsCost: -1 }, /invalid creativeUnitsCost/],
    [{ creativeUnitsCost: 1, costDetails: { extra: -1 } }, /invalid cost detail/],
  ])("fails closed on malformed dry-run quote %#", async (quote, expected) => {
    const network = vi.fn(async () => json(quote, 269))
    vi.stubGlobal("fetch", network)
    const { spec } = await project()
    await expect(createProvider("scenario", "online").submit(spec, [])).rejects.toThrow(expected)
    expect(network).toHaveBeenCalledOnce()
  })

  it("refuses an over-ceiling quote before sending paid work", async () => {
    const network = vi.fn(async () => json({ creativeUnitsCost: 20.01 }, 269))
    vi.stubGlobal("fetch", network)
    const { spec } = await project()
    await expect(createProvider("scenario", "online").submit(spec, [])).rejects.toThrow(
      /above maxComputeUnits 20; no paid request was sent/,
    )
    expect(network).toHaveBeenCalledOnce()
  })

  it.each(["pending", "queued", "warming-up", "in-progress", "finalizing", "processing"])(
    "maps %s jobs to processing with bounded progress",
    async (status) => {
      vi.stubGlobal("fetch", vi.fn(async () => json({
        job: { jobId: "job-state", status, progress: 0.42 },
      })))
      await expect(createProvider("scenario", "online").poll("job-state", "map"))
        .resolves.toEqual({ status: "processing", progressPercent: 42 })
    },
  )

  it.each(["failure", "failed", "canceled"])("maps %s jobs to failure", async (status) => {
    vi.stubGlobal("fetch", vi.fn(async () => json({
      job: { jobId: "job-state", status, metadata: { error: "generation stopped" } },
    })))
    await expect(createProvider("scenario", "online").poll("job-state", "map"))
      .resolves.toEqual({ status: "failed", error: `Scenario job ${status}: generation stopped` })
  })

  it("fails clearly for unknown states and successful jobs without assets", async () => {
    const responses = [
      { job: { jobId: "job-unknown", status: "paused" } },
      { job: { jobId: "job-empty", status: "success", metadata: { assetIds: [] } } },
    ]
    vi.stubGlobal("fetch", vi.fn(async () => json(responses.shift())))
    const provider = createProvider("scenario", "online")
    await expect(provider.poll("job-unknown", "map")).resolves.toEqual({
      status: "failed",
      error: 'Scenario returned unknown job status "paused"',
    })
    await expect(provider.poll("job-empty", "map")).resolves.toEqual({
      status: "failed",
      error: "Scenario job returned no asset IDs",
    })
  })

  it("sorts candidates by outputIndex and promotes a durable asset reference", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input) => {
      const path = requestPath(input)
      if (path.endsWith("/jobs/job-review")) {
        return json({
          job: {
            jobId: "job-review",
            status: "success",
            metadata: { assetIds: ["asset-b", "asset-a"] },
            billing: { cuCost: 6, cuCostDetails: { "quality-gate": 1 } },
          },
        })
      }
      const id = path.split("/").at(-1)!
      return json({
        asset: {
          id,
          url: `https://cdn.test/${id}.png?token=temporary`,
          mimeType: "image/png",
          metadata: { outputIndex: id === "asset-a" ? 0 : 1 },
        },
      })
    }))
    const provider = createProvider("scenario", "online")
    await expect(provider.poll("job-review", "map")).resolves.toMatchObject({
      status: "review",
      candidateUrls: [
        "https://cdn.test/asset-a.png?token=temporary",
        "https://cdn.test/asset-b.png?token=temporary",
      ],
      metadata: { assetIds: ["asset-a", "asset-b"], billedComputeUnits: 7 },
    })
    await expect(provider.selectCandidate?.("job-review", 1)).resolves.toMatchObject({
      objectId: "asset-b",
      sourceUrl: expect.stringMatching(/^scenario:\/\/asset\?/),
      metadata: { assetId: "asset-b", outputIndex: 1, billedComputeUnits: 7 },
    })
  })

  it("retains the quote, refreshes a signed URL, downloads, hashes, and caches", async () => {
    let assetReads = 0
    const urls: string[] = []
    vi.stubGlobal("fetch", vi.fn(async (input) => {
      const url = new URL(String(input))
      urls.push(url.href)
      if (url.pathname.endsWith("/generate/custom/model_bfl-flux-2-dev")) {
        return url.searchParams.get("dryRun") === "true"
          ? json({ creativeUnitsCost: 8 }, 269)
          : json({ job: { jobId: "job-download", status: "queued" } })
      }
      if (url.pathname.endsWith("/jobs/job-download")) {
        return json({
          job: {
            jobId: "job-download",
            status: "success",
            metadata: { assetIds: ["asset-download"] },
            billing: { cuCost: 8, cuCostDetails: {} },
          },
        })
      }
      if (url.pathname.endsWith("/assets/asset-download")) {
        assetReads++
        return json({
          asset: {
            id: "asset-download",
            url: `https://cdn.test/output.png?X-Amz-Signature=${assetReads}`,
            originalFileUrl: `https://cdn.test/original.png?X-Amz-Signature=${assetReads}`,
            originalMimeType: "image/png",
            outputIndex: 0,
          },
        })
      }
      if (url.hostname === "cdn.test") return new Response(FAKE_PNG)
      throw new Error(`unexpected request ${url}`)
    }))

    const { manifestPath, lockPath, spec } = await project()
    const loaded = await loadManifest(manifestPath)
    const lock: Lock = { version: 2, entries: {} }
    const plan = await buildPlan([spec], lock)
    const provider = createProvider("scenario", "online")
    await submit(provider, loaded, plan.actionable, lock, lockPath, { spacingMs: 0, budget: 20 })
    await poll(provider, lock, lockPath, { intervalMs: 0, specs: [spec] })
    await expect(fetchAssets(provider, [spec], lock, lockPath)).resolves.toMatchObject({
      downloaded: 1,
      failed: 0,
    })

    const entry = (await loadLock(lockPath)).entries[lockKey("base", "keep")]!
    expect(entry.status).toBe("downloaded")
    expect(entry.sourceUrl).toMatch(/^scenario:\/\/asset\?/)
    expect(entry.providerMetadata.scenario).toMatchObject({
      modelId: "model_bfl-flux-2-dev",
      quotedComputeUnits: 8,
      billedComputeUnits: 8,
      assetId: "asset-download",
    })
    expect(JSON.stringify(entry)).not.toContain("X-Amz-Signature")
    expect(assetReads).toBe(2)
    expect(urls.some((url) => url.includes("original.png?X-Amz-Signature=2"))).toBe(true)
    expect(existsSync(path.join(dir, "out/keep.png"))).toBe(true)
    await expect(readFile(path.join(dir, "out/keep.png"))).resolves.toEqual(FAKE_PNG)
    expect(existsSync(path.join(dir, ".pixelkiln/cache", `${entry.outputs[0]!.sha256}.png`)))
      .toBe(true)
  })

  it("rejects non-PNG Scenario assets before they reach the output pipeline", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input) => {
      const path = requestPath(input)
      if (path.includes("/jobs/")) {
        return json({ job: { jobId: "job-webp", status: "success", metadata: { assetIds: ["asset-webp"] } } })
      }
      return json({
        asset: { id: "asset-webp", url: "https://cdn.test/a.webp", originalMimeType: "image/webp", outputIndex: 0 },
      })
    }))
    await expect(createProvider("scenario", "online").poll("job-webp", "map"))
      .rejects.toThrow(/requires PNG output/)
  })

  it("names missing credentials and redacts credentials from provider errors", async () => {
    delete process.env.SCENARIO_SDK_API_SECRET
    const { spec } = await project()
    await expect(createProvider("scenario", "online").submit(spec, []))
      .rejects.toThrow("SCENARIO_SDK_API_SECRET is not set")

    process.env.SCENARIO_SDK_API_SECRET = "scenario-secret"
    vi.stubGlobal("fetch", vi.fn(async () => json({
      message: "bad scenario-key scenario-secret " +
        Buffer.from("scenario-key:scenario-secret").toString("base64"),
    }, 401)))
    const error = await createProvider("scenario", "online").submit(spec, []).catch((value) => value)
    expect(String(error)).toContain("[redacted]")
    expect(String(error)).not.toContain("scenario-key")
    expect(String(error)).not.toContain("scenario-secret")
  })

  it("checks connectivity with a read-only authenticated request", async () => {
    const network = vi.fn(async () => json({ models: [] }))
    vi.stubGlobal("fetch", network)
    await expect(createProvider("scenario", "online").checkConnection?.()).resolves.toBeUndefined()
    expect(requestPath(network.mock.calls[0]![0] as string)).toBe("/v1/models")
    expect(new URL(String(network.mock.calls[0]![0])).searchParams.get("pageSize")).toBe("1")
    expect(network.mock.calls[0]![1]?.method).toBeUndefined()
  })

  it("rejects unsafe API and download URL schemes", async () => {
    process.env.SCENARIO_API_BASE_URL = "ftp://scenario.test/v1"
    expect(() => createProvider("scenario", "online")).toThrow(/must use HTTP or HTTPS/)

    process.env.SCENARIO_API_BASE_URL = "https://scenario.test/v1"
    await expect(createProvider("scenario", "online").download("file:///tmp/output.png"))
      .rejects.toThrow(/downloads must use HTTP or HTTPS/)
  })
})

function restoreEnv(name: string, value: string | undefined): void {
  if (value == null) delete process.env[name]
  else process.env[name] = value
}
