import { existsSync } from "node:fs"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { sha256 } from "../src/hash.ts"
import { loadManifest, resolveSpecs } from "../src/manifest.ts"
import { loadLock } from "../src/lock.ts"
import { createProvider, providerFactory } from "../src/providers/registry.ts"
import { fetchAssets } from "../src/pipeline/fetch.ts"
import { buildPlan } from "../src/pipeline/plan.ts"
import { poll } from "../src/pipeline/poll.ts"
import { submit } from "../src/pipeline/submit.ts"
import { decodePng } from "../src/png.ts"
import { FAKE_PNG } from "../src/providers/fake.ts"
import { lockKey, type Lock } from "../src/types.ts"

let dir: string
let oldBaseUrl: string | undefined

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "pixelkiln-comfyui-"))
  oldBaseUrl = process.env.COMFYUI_BASE_URL
  process.env.COMFYUI_BASE_URL = "http://127.0.0.1:8188"
})

afterEach(async () => {
  vi.unstubAllGlobals()
  if (oldBaseUrl == null) delete process.env.COMFYUI_BASE_URL
  else process.env.COMFYUI_BASE_URL = oldBaseUrl
  await rm(dir, { recursive: true, force: true })
})

function workflow(steps = 20) {
  return {
    "3": {
      class_type: "KSampler",
      inputs: { seed: 1, steps, latent_image: ["5", 0] },
    },
    "5": {
      class_type: "EmptyLatentImage",
      inputs: { width: 64, height: 64, batch_size: 1 },
    },
    "6": {
      class_type: "CLIPTextEncode",
      inputs: { text: "placeholder" },
    },
    "9": {
      class_type: "SaveImage",
      inputs: { filename_prefix: "PixelKiln", images: ["8", 0] },
    },
  }
}

async function project(options: { numImages?: number; width?: number; seed?: number } = {}) {
  const workflowPath = path.join(dir, "workflow-api.json")
  if (!existsSync(workflowPath)) await writeFile(workflowPath, JSON.stringify(workflow()))
  const manifestPath = path.join(dir, "pixelkiln.manifest.json")
  await writeFile(manifestPath, JSON.stringify({
    name: "comfy-test",
    provider: "comfyui",
    styles: {
      local: {
        generator: "map",
        outDir: "out",
        ...(options.seed == null ? {} : { seed: options.seed }),
        providerOptions: {
          comfyui: {
            workflowFile: "workflow-api.json",
            outputNodeId: "9",
            numImages: options.numImages ?? 1,
            bindings: {
              prompt: { nodeId: "6", input: "text" },
              width: { nodeId: "5", input: "width" },
              height: { nodeId: "5", input: "height" },
              batchSize: { nodeId: "5", input: "batch_size" },
              seed: { nodeId: "3", input: "seed" },
            },
          },
        },
      },
    },
    assets: {
      anvil: {
        prompt: "an iron anvil",
        width: options.width ?? 512,
        height: 320,
      },
    },
  }))
  const loaded = await loadManifest(manifestPath)
  const specs = await resolveSpecs(loaded)
  return { loaded, spec: specs[0]!, workflowPath }
}

describe("ComfyUI provider", () => {
  it("registers as a credential-free self-hosted provider", () => {
    expect(providerFactory("comfyui").credentialEnv).toBeUndefined()
    expect(createProvider("comfyui", "offline").id).toBe("comfyui")
  })

  it("keeps the committed refined benchmark reproducible and current", async () => {
    const root = path.resolve("benchmarks/provider-postprocessing/comfyui")
    const manifestPath = path.join(root, "pixelkiln.manifest.json")
    const specs = await resolveSpecs(await loadManifest(manifestPath))
    const lock = await loadLock(path.join(root, "pixelkiln.lock.json"))
    const plan = await buildPlan(specs, lock)

    expect(plan.items).toHaveLength(4)
    expect(plan.items.every((item) => item.state === "ok")).toBe(true)
    expect(plan.actionable).toEqual([])

    const isolated = JSON.parse(await readFile(path.join(root, "workflow-isolated-api.json"), "utf8"))
    const isolatedClasses = Object.values(isolated as JsonObject)
      .map((node) => (node as JsonObject).class_type)
    expect(isolatedClasses).toEqual(expect.arrayContaining([
      "LoadBackgroundRemovalModel",
      "RemoveBackground",
      "InvertMask",
      "ImageQuantize",
      "JoinImageWithAlpha",
      "ImageScale",
    ]))
    expect(isolated[12].inputs.bg_removal_name).toBe("birefnet.safetensors")
    expect(isolated[15].inputs).toMatchObject({ colors: 64, dither: "none" })
    expect(isolated[11].inputs).toMatchObject({ upscale_method: "nearest-exact" })
  })

  it("keeps the committed resolution benchmark reproducible and current", async () => {
    const root = path.resolve("benchmarks/provider-hires/comfyui")
    const specs = await resolveSpecs(await loadManifest(path.join(root, "pixelkiln.manifest.json")))
    const lock = await loadLock(path.join(root, "pixelkiln.lock.json"))
    const plan = await buildPlan(specs, lock)

    expect(plan.items).toHaveLength(2)
    expect(plan.items.every((item) => item.state === "ok")).toBe(true)
    expect(plan.actionable).toEqual([])

    const nativeWide = JSON.parse(
      await readFile(path.join(root, "workflow-native-wide-api.json"), "utf8"),
    )
    expect(nativeWide[5].inputs).toMatchObject({ width: 1344, height: 768 })
    expect(nativeWide[11].inputs).toMatchObject({ width: 1344, height: 768 })
    expect(Object.values(nativeWide as JsonObject).map((node) => (
      node as JsonObject
    ).class_type)).not.toContain("LatentUpscale")

    const report = JSON.parse(await readFile(
      path.join(root, "pixel-art-fixer-results.json"),
      "utf8",
    )) as {
      tool: { license: string; commit: string }
      qualityPolicy: {
        purpose: string
        gridRecoveryIsQualityApproval: boolean
        preferredNativeMin: number
        preferredNativeMax: number
        decision: string
      }
      runs: Array<{
        source: string
        sourceSha256: string
        sourceWidth: number
        sourceHeight: number
        output: string
        outputSha256: string
        nativeWidth: number
        nativeHeight: number
        stepX: number
        stepY: number
        colors: number
        confidence: string
      }>
    }
    expect(report.tool).toMatchObject({
      license: "MIT",
      commit: "ef376e57e1c272633ca2dbf5f29ec3fcf6596465",
    })
    expect(report.qualityPolicy).toEqual(expect.objectContaining({
      purpose: "native-grid recovery benchmark",
      gridRecoveryIsQualityApproval: false,
      preferredNativeMin: 48,
      preferredNativeMax: 128,
      decision: "human-review-required",
    }))
    expect(report.runs).toHaveLength(3)

    for (const run of report.runs) {
      const sourceBytes = await readFile(path.resolve(root, run.source))
      const outputBytes = await readFile(path.resolve(root, run.output))
      const sourceImage = decodePng(sourceBytes)
      const outputImage = decodePng(outputBytes)

      expect(sha256(sourceBytes)).toBe(run.sourceSha256)
      expect(sha256(outputBytes)).toBe(run.outputSha256)
      expect(sourceImage).toMatchObject({ width: run.sourceWidth, height: run.sourceHeight })
      expect(outputImage).toMatchObject({ width: run.nativeWidth, height: run.nativeHeight })
      expect(run.sourceWidth / run.nativeWidth).toBe(run.stepX)
      expect(run.sourceHeight / run.nativeHeight).toBe(run.stepY)
      const visibleColors = new Set<string>()
      for (let offset = 0; offset < outputImage.pixels.length; offset += 4) {
        if (outputImage.pixels[offset + 3] === 0) continue
        visibleColors.add([
          outputImage.pixels[offset],
          outputImage.pixels[offset + 1],
          outputImage.pixels[offset + 2],
        ].join(","))
      }
      expect(visibleColors.size).toBe(run.colors)
      expect(run.confidence).toBe("high")
    }
  })

  it("hashes parsed workflow content and plans without a network request", async () => {
    const fetch = vi.fn()
    vi.stubGlobal("fetch", fetch)
    const first = await project({ numImages: 2 })
    expect(first.spec).toMatchObject({
      provider: "comfyui",
      width: 512,
      height: 320,
      cost: 0,
      costUnit: "free",
      candidates: 2,
    })
    expect(first.spec.providerOptions).toMatchObject({
      workflowFile: "workflow-api.json",
      workflowSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      workflow: { "3": { class_type: "KSampler" } },
    })
    expect(fetch).not.toHaveBeenCalled()

    await writeFile(first.workflowPath, JSON.stringify(workflow(30)))
    const changed = (await resolveSpecs(await loadManifest(first.loaded.path)))[0]!
    expect(changed.specHash).not.toBe(first.spec.specHash)
    expect(fetch).not.toHaveBeenCalled()
  })

  it("keeps workflow identity stable across formatting and file moves", async () => {
    const first = await project({ numImages: 2 })
    const originalHash = first.spec.specHash
    await writeFile(first.workflowPath, JSON.stringify(workflow(), null, 2))
    const formatted = (await resolveSpecs(await loadManifest(first.loaded.path)))[0]!
    expect(formatted.specHash).toBe(originalHash)

    await writeFile(first.workflowPath, JSON.stringify(reverseKeys(workflow())))
    const reordered = (await resolveSpecs(await loadManifest(first.loaded.path)))[0]!
    expect(reordered.specHash).toBe(originalHash)

    const movedPath = path.join(dir, "workflows", "renamed.json")
    await mkdir(path.dirname(movedPath), { recursive: true })
    await writeFile(movedPath, JSON.stringify(workflow()))
    const manifest = JSON.parse(await readFile(first.loaded.path, "utf8"))
    manifest.styles.local.providerOptions.comfyui.workflowFile = "workflows/renamed.json"
    await writeFile(first.loaded.path, JSON.stringify(manifest))
    const moved = (await resolveSpecs(await loadManifest(first.loaded.path)))[0]!
    expect(moved.specHash).toBe(originalHash)
  })

  it("keeps offline planning independent from the configured server URL", async () => {
    process.env.COMFYUI_BASE_URL = "ftp://renderbox.local"
    await expect(project()).resolves.toMatchObject({ spec: { provider: "comfyui" } })
    expect(() => createProvider("comfyui", "online")).toThrow(/must use HTTP or HTTPS/)
  })

  it("rejects missing workflow bindings and provider-specific dimension overflow offline", async () => {
    const { loaded, workflowPath } = await project()
    const broken = workflow()
    delete broken["5"].inputs.width
    await writeFile(workflowPath, JSON.stringify(broken))
    await expect(resolveSpecs(await loadManifest(loaded.path))).rejects.toThrow(
      /width binding refers to missing input "width"/,
    )

    await writeFile(workflowPath, JSON.stringify(workflow()))
    const manifest = JSON.parse(await readFile(loaded.path, "utf8"))
    manifest.assets.anvil.width = 4097
    await writeFile(loaded.path, JSON.stringify(manifest))
    await expect(resolveSpecs(await loadManifest(loaded.path))).rejects.toThrow(
      /between 16 and 4096 pixels/,
    )
  })

  it("requires a seed binding only when PixelKiln owns the seed", async () => {
    const first = await project({ seed: 27 })
    const manifest = JSON.parse(await readFile(first.loaded.path, "utf8"))
    delete manifest.styles.local.providerOptions.comfyui.bindings.seed
    await writeFile(first.loaded.path, JSON.stringify(manifest))
    await expect(resolveSpecs(await loadManifest(first.loaded.path))).rejects.toThrow(
      /requires bindings.seed/,
    )
  })

  it("keeps PixelLab's 400px boundary after moving the shared schema ceiling", async () => {
    const manifestPath = path.join(dir, "pixellab.manifest.json")
    await writeFile(manifestPath, JSON.stringify({
      name: "pixel-limit",
      styles: { base: { generator: "map", outDir: "out" } },
      assets: { large: { prompt: "large", width: 401, height: 400 } },
    }))
    await expect(resolveSpecs(await loadManifest(manifestPath))).rejects.toThrow(
      /PixelLab map dimensions must be between 16 and 400 pixels/,
    )
  })

  it("binds resolved intent into a cloned workflow and queues one local prompt", async () => {
    const requests: Array<{ url: string; body: JsonObject | null }> = []
    vi.stubGlobal("fetch", vi.fn(async (input, init) => {
      requests.push({
        url: String(input),
        body: init?.body ? JSON.parse(String(init.body)) : null,
      })
      return json({ prompt_id: "prompt-1", number: 7, node_errors: {} })
    }))
    const { spec } = await project({ numImages: 3, seed: 31415 })
    const provider = createProvider("comfyui", "online")
    await expect(provider.submit(spec, [])).resolves.toEqual({ jobId: "prompt-1#9" })
    expect(requests).toHaveLength(1)
    expect(requests[0]!.url).toBe("http://127.0.0.1:8188/prompt")
    expect(requests[0]!.body).toMatchObject({
      prompt: {
        "3": { inputs: { seed: 31415 } },
        "5": { inputs: { width: 512, height: 320, batch_size: 3 } },
        "6": { inputs: { text: "an iron anvil" } },
      },
    })
    expect((spec.providerOptions.workflow as JsonObject)["6"]).toMatchObject({
      inputs: { text: "placeholder" },
    })
  })

  it("reports queue validation errors without echoing the workflow", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => json({
      error: { type: "prompt_outputs_failed_validation" },
      node_errors: { "9": { errors: [{ message: "bad output" }] } },
    }, 400)))
    const { spec } = await project()
    await expect(createProvider("comfyui", "online").submit(spec, [])).rejects.toThrow(
      /request failed \(400\).*invalid workflow node\(s\): 9/,
    )
  })

  it("maps unfinished, failed, single-output, and review histories", async () => {
    let history: unknown = {}
    vi.stubGlobal("fetch", vi.fn(async () => json(history)))
    const { spec } = await project({ numImages: 2 })
    const provider = createProvider("comfyui", "online")
    await expect(provider.poll("prompt-2#9", "map", { spec })).resolves.toEqual({ status: "processing" })

    history = {
      "prompt-2": {
        status: {
          status_str: "error",
          completed: false,
          messages: [["execution_error", { exception_message: "model file is missing" }]],
        },
        outputs: {},
      },
    }
    await expect(provider.poll("prompt-2#9", "map", { spec })).resolves.toEqual({
      status: "failed",
      error: "ComfyUI execution failed: model file is missing",
    })

    history = successHistory("prompt-2", [
      { filename: "Pixel Kiln_00002.png", subfolder: "sets/a", type: "output" },
      { filename: "Pixel Kiln_00001.png", subfolder: "sets/a", type: "output" },
    ])
    const state = await provider.poll("prompt-2#9", "map", { spec })
    expect(state).toMatchObject({
      status: "review",
      candidateUrls: [
        "http://127.0.0.1:8188/view?filename=Pixel+Kiln_00002.png&subfolder=sets%2Fa&type=output",
        "http://127.0.0.1:8188/view?filename=Pixel+Kiln_00001.png&subfolder=sets%2Fa&type=output",
      ],
      metadata: { outputCount: 2, workflowSha256: expect.stringMatching(/^[a-f0-9]{64}$/) },
    })
    await expect(provider.selectCandidate?.("prompt-2#9", 1)).resolves.toEqual({
      objectId: "prompt-2#9#1",
      sourceUrl: "comfyui://output?filename=Pixel+Kiln_00001.png&subfolder=sets%2Fa&type=output",
    })

    const single = await project({ numImages: 1 })
    history = successHistory("prompt-3", [
      { filename: "one.png", subfolder: "", type: "output" },
    ])
    await expect(provider.poll("prompt-3#9", "map", { spec: single.spec })).resolves.toMatchObject({
      status: "ready",
      objectId: "prompt-3#9#0",
      sourceUrl: "comfyui://output?filename=one.png&subfolder=&type=output",
      sources: [{ mediaType: "image/png" }],
    })
  })

  it("rejects an unexpected output count instead of corrupting review state", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => json(successHistory("prompt-4", [
      { filename: "only.png", subfolder: "", type: "output" },
    ]))))
    const { spec } = await project({ numImages: 2 })
    await expect(createProvider("comfyui", "online").poll("prompt-4#9", "map", { spec }))
      .resolves.toEqual({
        status: "failed",
        error: "ComfyUI output node \"9\" returned 1 image(s), expected 2",
      })
  })

  it("persists workflow provenance before a candidate is selected", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input) => {
      const url = String(input)
      if (url.endsWith("/prompt")) return json({ prompt_id: "review-1" })
      return json(successHistory("review-1", [
        { filename: "a.png", subfolder: "", type: "output" },
        { filename: "b.png", subfolder: "", type: "output" },
      ]))
    }))
    const { loaded, spec } = await project({ numImages: 2 })
    const lock: Lock = { version: 2, entries: {} }
    const lockPath = path.join(dir, "pixelkiln.lock.json")
    const provider = createProvider("comfyui", "online")
    const plan = await buildPlan([spec], lock)
    await submit(provider, loaded, plan.actionable, lock, lockPath, { budget: 0, spacingMs: 0 })
    await poll(provider, lock, lockPath, { intervalMs: 0, specs: [spec] })

    expect(lock.entries[lockKey("local", "anvil")]).toMatchObject({
      status: "review",
      providerMetadata: {
        comfyui: {
          promptId: "review-1",
          outputCount: 2,
          workflowSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
        },
      },
    })
  })

  it("resolves portable output references against the current server", async () => {
    const requests: string[] = []
    process.env.COMFYUI_BASE_URL = "http://renderbox.local:8188/api"
    vi.stubGlobal("fetch", vi.fn(async (input) => {
      requests.push(String(input))
      return new Response(FAKE_PNG, { status: 200, headers: { "Content-Type": "image/png" } })
    }))
    const provider = createProvider("comfyui", "downloads")
    await expect(provider.download(
      "comfyui://output?filename=forge+icon.png&subfolder=pixel%2Fkit&type=output",
    )).resolves.toEqual(FAKE_PNG)
    expect(requests).toEqual([
      "http://renderbox.local:8188/api/view?filename=forge+icon.png&subfolder=pixel%2Fkit&type=output",
    ])
  })

  it("checks a self-hosted server with the read-only system stats route", async () => {
    const fetch = vi.fn(async () => json({ system: { comfyui_version: "0.3.0" }, devices: [] }))
    vi.stubGlobal("fetch", fetch)
    await expect(createProvider("comfyui", "online").checkConnection?.()).resolves.toBeUndefined()
    expect(String(fetch.mock.calls[0]![0])).toBe("http://127.0.0.1:8188/system_stats")
  })

  it("completes submit, poll, download, hash, and cache recovery", async () => {
    let generated = true
    vi.stubGlobal("fetch", vi.fn(async (input, init) => {
      const url = String(input)
      if (url.endsWith("/prompt") && init?.method === "POST") return json({ prompt_id: "pipeline-1" })
      if (url.endsWith("/history/pipeline-1")) {
        return json(successHistory("pipeline-1", [
          { filename: "anvil.png", subfolder: "pixelkiln", type: "output" },
        ]))
      }
      if (url.includes("/view?")) {
        if (!generated) return new Response("gone", { status: 404 })
        return new Response(FAKE_PNG, { status: 200 })
      }
      return json({}, 404)
    }))

    const { loaded, spec } = await project({ seed: 7 })
    const lock: Lock = { version: 2, entries: {} }
    const lockPath = path.join(dir, "pixelkiln.lock.json")
    const provider = createProvider("comfyui", "online")
    const plan = await buildPlan([spec], lock)
    await expect(submit(provider, loaded, plan.actionable, lock, lockPath, {
      budget: 0,
      spacingMs: 0,
    })).resolves.toMatchObject({ submitted: 1, failed: 0, spent: 0, unit: "free" })
    await expect(poll(provider, lock, lockPath, { intervalMs: 0, specs: [spec] }))
      .resolves.toMatchObject({ completed: 1, failed: 0 })
    await expect(fetchAssets(provider, [spec], lock, lockPath)).resolves.toMatchObject({
      downloaded: 1,
      failed: 0,
    })

    const entry = lock.entries[lockKey("local", "anvil")]!
    expect(entry).toMatchObject({
      provider: "comfyui",
      status: "downloaded",
      cost: 0,
      costUnit: "free",
      objectId: "pipeline-1#9#0",
      sourceUrl: "comfyui://output?filename=anvil.png&subfolder=pixelkiln&type=output",
      providerMetadata: {
        comfyui: {
          promptId: "pipeline-1",
          outputNodeId: "9",
          workflowSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
        },
      },
    })
    expect(existsSync(path.join(dir, "out", "anvil.png"))).toBe(true)

    await rm(path.join(dir, "out", "anvil.png"))
    generated = false
    await expect(fetchAssets(createProvider("comfyui", "downloads"), [spec], lock, lockPath, {
      repair: true,
    })).resolves.toMatchObject({ downloaded: 1, failed: 0 })
    await expect(readFile(path.join(dir, "out", "anvil.png"))).resolves.toEqual(FAKE_PNG)
  })
})

type JsonObject = Record<string, unknown>

function successHistory(promptId: string, images: JsonObject[]): JsonObject {
  return {
    [promptId]: {
      status: { status_str: "success", completed: true, messages: [] },
      outputs: { "9": { images } },
    },
  }
}

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json" },
  })
}

function reverseKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(reverseKeys)
  if (!value || typeof value !== "object") return value
  return Object.fromEntries(
    Object.entries(value as JsonObject)
      .reverse()
      .map(([key, item]) => [key, reverseKeys(item)]),
  )
}
