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
import { runPicker } from "../src/pick/server.ts"
import { decodePng, encodeRgbaPng } from "../src/png.ts"
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

async function providerInputProject(poseFile = "pose.png") {
  const posePixels = Buffer.alloc(2 * 2 * 4, 127)
  for (let offset = 3; offset < posePixels.length; offset += 4) posePixels[offset] = 255
  const pose = encodeRgbaPng(2, 2, posePixels)
  await writeFile(path.join(dir, poseFile), pose)
  const workflowPath = path.join(dir, "workflow-api.json")
  const graph = workflow() as unknown as JsonObject
  graph["19"] = { class_type: "LoadImage", inputs: { image: "placeholder.png" } }
  graph["20"] = { class_type: "ControlNetApplyAdvanced", inputs: { strength: 0.5 } }
  await writeFile(workflowPath, JSON.stringify(graph))
  const manifestPath = path.join(dir, "pixelkiln.manifest.json")
  await writeFile(manifestPath, JSON.stringify({
    name: "comfy-provider-input-test",
    provider: "comfyui",
    styles: {
      local: {
        generator: "map",
        outDir: "out",
        providerOptions: {
          comfyui: {
            workflowFile: "workflow-api.json",
            outputNodeId: "9",
            bindings: {
              prompt: { nodeId: "6", input: "text" },
              width: { nodeId: "5", input: "width" },
              height: { nodeId: "5", input: "height" },
              pose: { nodeId: "19", input: "image" },
              poseStrength: { nodeId: "20", input: "strength" },
            },
          },
        },
      },
    },
    assets: {
      dancer: {
        prompt: "a dancer holding a pole",
        width: 832,
        height: 1216,
        providerInputs: { pose: poseFile, poseStrength: 0.75 },
      },
    },
  }))
  const loaded = await loadManifest(manifestPath)
  const spec = (await resolveSpecs(loaded))[0]!
  return { loaded, spec, pose, poseFile: path.join(dir, poseFile), manifestPath }
}

async function frameSetProject() {
  const makePose = (value: number) => {
    const pixels = Buffer.alloc(2 * 2 * 4, value)
    for (let offset = 3; offset < pixels.length; offset += 4) pixels[offset] = 255
    return encodeRgbaPng(2, 2, pixels)
  }
  const poses = [makePose(64), makePose(192)]
  await Promise.all(poses.map((pose, index) => writeFile(path.join(dir, `pose-${index}.png`), pose)))
  const graph = workflow() as unknown as JsonObject
  graph["19"] = { class_type: "LoadImage", inputs: { image: "placeholder.png" } }
  await writeFile(path.join(dir, "frames-api.json"), JSON.stringify(graph))
  const manifestPath = path.join(dir, "pixelkiln.manifest.json")
  await writeFile(manifestPath, JSON.stringify({
    name: "comfy-frame-test",
    provider: "comfyui",
    styles: {
      motion: {
        generator: "frames",
        outDir: "out",
        seed: 100,
        quality: {
          outDir: "final",
          palette: ["#111111", "#eeeeee"],
          fps: 8,
        },
        providerOptions: {
          comfyui: {
            workflowFile: "frames-api.json",
            outputNodeId: "9",
            frames: { vary: "pose", seedStep: 7 },
            bindings: {
              prompt: { nodeId: "6", input: "text" },
              width: { nodeId: "5", input: "width" },
              height: { nodeId: "5", input: "height" },
              seed: { nodeId: "3", input: "seed" },
              pose: { nodeId: "19", input: "image" },
            },
          },
        },
      },
    },
    assets: {
      dancer: {
        prompt: "a dancer turning in place",
        width: 64,
        height: 96,
        providerInputs: { pose: ["pose-0.png", "pose-1.png"] },
      },
    },
  }))
  const loaded = await loadManifest(manifestPath)
  const spec = (await resolveSpecs(loaded))[0]!
  return { loaded, spec, poses, manifestPath }
}

async function revisionProject(mode: "image-to-image" | "inpaint" = "image-to-image") {
  const source = encodeRgbaPng(16, 16, Buffer.alloc(16 * 16 * 4, 255))
  const mask = encodeRgbaPng(16, 16, Buffer.alloc(16 * 16 * 4, 127))
  await writeFile(path.join(dir, "source.png"), source)
  await writeFile(path.join(dir, "mask.png"), mask)
  const workflowPath = path.join(dir, "revision-api.json")
  await writeFile(workflowPath, JSON.stringify({
    "3": {
      class_type: "KSampler",
      inputs: { seed: 1, steps: 20, denoise: 0.25, latent_image: ["14", 0] },
    },
    "6": { class_type: "CLIPTextEncode", inputs: { text: "placeholder" } },
    "9": { class_type: "SaveImage", inputs: { filename_prefix: "PixelKiln", images: ["8", 0] } },
    "12": { class_type: "LoadImage", inputs: { image: "source-placeholder.png" } },
    "13": { class_type: "LoadImage", inputs: { image: "mask-placeholder.png" } },
    "14": { class_type: "VAEEncode", inputs: { pixels: ["12", 0] } },
    "15": { class_type: "RepeatLatentBatch", inputs: { samples: ["14", 0], amount: 1 } },
  }))
  const manifestPath = path.join(dir, "pixelkiln.manifest.json")
  await writeFile(manifestPath, JSON.stringify({
    name: "comfy-revision-test",
    provider: "comfyui",
    styles: {
      local: {
        generator: "map",
        size: 16,
        outDir: "out",
        providerOptions: {
          comfyui: {
            workflowFile: "revision-api.json",
            outputNodeId: "9",
            numImages: 1,
            bindings: {
              prompt: { nodeId: "6", input: "text" },
              batchSize: { nodeId: "15", input: "amount" },
              seed: { nodeId: "3", input: "seed" },
              sourceImage: { nodeId: "12", input: "image" },
              maskImage: { nodeId: "13", input: "image" },
              strength: { nodeId: "3", input: "denoise" },
            },
          },
        },
      },
    },
    assets: {
      source: { prompt: "source", source: "source.png" },
      revised: {
        prompt: "preserve the silhouette and add snow",
        width: 16,
        height: 16,
        revision: {
          mode,
          from: "source",
          ...(mode === "inpaint" ? { mask: "mask.png" } : {}),
          strength: 0.4,
        },
      },
    },
  }))
  const loaded = await loadManifest(manifestPath)
  const [spec] = await resolveSpecs(loaded, { assets: ["revised"] })
  return { loaded, spec: spec!, source, mask, manifestPath }
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

  it("keeps the committed image-to-image smoke and lineage current", async () => {
    const root = path.resolve("benchmarks/provider-revisions/comfyui")
    const specs = await resolveSpecs(await loadManifest(path.join(root, "pixelkiln.manifest.json")))
    const lock = await loadLock(path.join(root, "pixelkiln.lock.json"))
    const plan = await buildPlan(specs, lock)

    expect(plan.items).toHaveLength(4)
    expect(plan.items.every((item) => item.state === "ok")).toBe(true)
    expect(plan.actionable).toEqual([])
    const revisions = specs.filter((spec) => spec.revision)
    expect(revisions.map((spec) => spec.revision!.strength)).toEqual([0.25, 0.4, 0.6])
    expect(new Set(revisions.map((spec) => spec.revision!.sourceSha256))).toEqual(new Set([
      "35748d35ea4df5cb3ed2af60d7833c7cf8c7c769bf343d599fba57653eddd200",
    ]))
    for (const spec of revisions) {
      expect(lock.entries[lockKey(spec.styleId, spec.assetId)]).toMatchObject({
        status: "downloaded",
        specHash: spec.specHash,
        revision: {
          mode: "image-to-image",
          sourceAssetId: "fortress-source",
          sourceSha256: spec.revision!.sourceSha256,
          strength: spec.revision!.strength,
        },
        providerMetadata: {
          comfyui: {
            workflowSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
            revision: { sourceSha256: spec.revision!.sourceSha256 },
          },
        },
      })
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

  it("rejects inconsistent frame-set declarations before submission", async () => {
    const { manifestPath } = await frameSetProject()
    const original = JSON.parse(await readFile(manifestPath, "utf8"))

    const multiCandidate = structuredClone(original)
    multiCandidate.styles.motion.providerOptions.comfyui.numImages = 2
    multiCandidate.styles.motion.providerOptions.comfyui.bindings.batchSize = {
      nodeId: "5",
      input: "batch_size",
    }
    await writeFile(manifestPath, JSON.stringify(multiCandidate))
    await expect(resolveSpecs(await loadManifest(manifestPath))).rejects.toThrow(
      /frames generation requires numImages: 1/,
    )

    const noSequence = structuredClone(original)
    noSequence.assets.dancer.providerInputs.pose = "pose-0.png"
    await writeFile(manifestPath, JSON.stringify(noSequence))
    await expect(resolveSpecs(await loadManifest(manifestPath))).rejects.toThrow(
      /requires a providerInputs array of 2–64 values/,
    )

    const noSeed = structuredClone(original)
    delete noSeed.styles.motion.seed
    await writeFile(manifestPath, JSON.stringify(noSeed))
    await expect(resolveSpecs(await loadManifest(manifestPath))).rejects.toThrow(
      /frames\.seedStep requires a style seed/,
    )

    const mapFrames = structuredClone(original)
    mapFrames.styles.motion.generator = "map"
    await writeFile(manifestPath, JSON.stringify(mapFrames))
    await expect(resolveSpecs(await loadManifest(manifestPath))).rejects.toThrow(
      /providerOptions\.frames requires generator: frames/,
    )

    const extraSequence = structuredClone(original)
    extraSequence.assets.dancer.providerInputs.extra = [1, 2]
    extraSequence.styles.motion.providerOptions.comfyui.bindings.extra = {
      nodeId: "20",
      input: "strength",
    }
    const frameGraph = JSON.parse(await readFile(path.join(dir, "frames-api.json"), "utf8"))
    const graph = structuredClone(frameGraph)
    graph["20"] = { class_type: "ControlNetApply", inputs: { strength: 0.5 } }
    await writeFile(path.join(dir, "frames-api.json"), JSON.stringify(graph))
    await writeFile(manifestPath, JSON.stringify(extraSequence))
    await expect(resolveSpecs(await loadManifest(manifestPath))).rejects.toThrow(
      /providerInputs\.extra is an array but frames\.vary is "pose"/,
    )

    await writeFile(path.join(dir, "frames-api.json"), JSON.stringify(frameGraph))
    const committedSource = structuredClone(original)
    committedSource.assets.dancer.source = "pose-0.png"
    await writeFile(manifestPath, JSON.stringify(committedSource))
    await expect(resolveSpecs(await loadManifest(manifestPath))).rejects.toThrow(
      /frame sets require generated provider outputs/,
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

  it("hashes uploaded provider inputs by content and validates arbitrary scalar targets", async () => {
    const first = await providerInputProject()
    expect(first.spec.providerInputs).toEqual({
      pose: {
        kind: "image",
        path: first.poseFile,
        sha256: sha256(first.pose),
        format: "png",
      },
      poseStrength: 0.75,
    })

    const copy = path.join(dir, "pose-copy.png")
    await writeFile(copy, first.pose)
    const manifest = JSON.parse(await readFile(first.manifestPath, "utf8"))
    manifest.assets.dancer.providerInputs.pose = "pose-copy.png"
    await writeFile(first.manifestPath, JSON.stringify(manifest))
    const moved = (await resolveSpecs(await loadManifest(first.manifestPath)))[0]!
    expect(moved.specHash).toBe(first.spec.specHash)

    const changedPixels = Buffer.from(new Uint8Array(2 * 2 * 4).fill(255))
    const changedPose = encodeRgbaPng(2, 2, changedPixels)
    await writeFile(copy, changedPose)
    const changed = (await resolveSpecs(await loadManifest(first.manifestPath)))[0]!
    expect(changed.specHash).not.toBe(first.spec.specHash)

    manifest.assets.dancer.providerInputs.poseStrength = "strong"
    await writeFile(first.manifestPath, JSON.stringify(manifest))
    await expect(resolveSpecs(await loadManifest(first.manifestPath))).rejects.toThrow(
      /providerInputs\.poseStrength must be number/,
    )
  })

  it("rejects unbound, reserved, and duplicate custom input targets", async () => {
    const first = await providerInputProject()
    const manifest = JSON.parse(await readFile(first.manifestPath, "utf8"))

    manifest.assets.dancer.providerInputs.unknown = true
    await writeFile(first.manifestPath, JSON.stringify(manifest))
    await expect(resolveSpecs(await loadManifest(first.manifestPath))).rejects.toThrow(
      /providerInputs\.unknown has no matching bindings\.unknown/,
    )

    delete manifest.assets.dancer.providerInputs.unknown
    manifest.assets.dancer.providerInputs.seed = 42
    await writeFile(first.manifestPath, JSON.stringify(manifest))
    await expect(resolveSpecs(await loadManifest(first.manifestPath))).rejects.toThrow(
      /providerInputs\.seed is reserved/,
    )

    delete manifest.assets.dancer.providerInputs.seed
    manifest.styles.local.providerOptions.comfyui.bindings.poseStrength = {
      nodeId: "19",
      input: "image",
    }
    await writeFile(first.manifestPath, JSON.stringify(manifest))
    await expect(resolveSpecs(await loadManifest(first.manifestPath))).rejects.toThrow(
      /bindings\.poseStrength and bindings\.pose target the same input 19\.image/,
    )

    manifest.styles.local.providerOptions.comfyui.bindings.poseStrength = {
      nodeId: "20",
      input: "strength",
    }
    const workflowPath = path.join(dir, "workflow-api.json")
    const graph = JSON.parse(await readFile(workflowPath, "utf8"))
    graph["20"].inputs.strength = ["3", 0]
    await writeFile(workflowPath, JSON.stringify(graph))
    await writeFile(first.manifestPath, JSON.stringify(manifest))
    await expect(resolveSpecs(await loadManifest(first.manifestPath))).rejects.toThrow(
      /providerInputs\.poseStrength cannot replace non-scalar 20\.strength/,
    )
  })

  it("uploads bound image inputs and records path-free input provenance", async () => {
    const uploads: Array<{ name: string; bytes: Buffer }> = []
    let queued: JsonObject | null = null
    vi.stubGlobal("fetch", vi.fn(async (input, init) => {
      const url = String(input)
      if (url.endsWith("/upload/image")) {
        const image = (init!.body as FormData).get("image") as File
        uploads.push({ name: image.name, bytes: Buffer.from(await image.arrayBuffer()) })
        return json({ name: image.name, subfolder: "pixelkiln", type: "input" })
      }
      if (url.endsWith("/prompt")) {
        queued = JSON.parse(String(init!.body))
        return json({ prompt_id: "pose-1" })
      }
      return json({}, 404)
    }))
    const { loaded, spec, pose, poseFile } = await providerInputProject()
    const lock: Lock = { version: 2, entries: {} }
    const lockPath = path.join(dir, "pixelkiln.lock.json")
    const provider = createProvider("comfyui", "online")
    await submit(provider, loaded, (await buildPlan([spec], lock)).actionable, lock, lockPath, {
      budget: 0,
      spacingMs: 0,
    })

    expect(uploads).toEqual([{ name: `${sha256(pose)}.png`, bytes: pose }])
    expect(queued).toMatchObject({
      prompt: {
        "19": { inputs: { image: `pixelkiln/${sha256(pose)}.png` } },
        "20": { inputs: { strength: 0.75 } },
      },
    })
    expect(lock.entries["local/dancer"]!.providerMetadata).toEqual({
      comfyui: {
        inputs: {
          pose: { kind: "image", sha256: sha256(pose), format: "png" },
          poseStrength: { kind: "value", value: 0.75 },
        },
      },
    })
    expect(JSON.stringify(lock)).not.toContain(poseFile)
  })

  it("refuses a provider input image that changes between plan and submit", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => json({ prompt_id: "should-not-submit" })))
    const { spec, poseFile } = await providerInputProject()
    const changedPixels = Buffer.from(new Uint8Array(2 * 2 * 4).fill(255))
    await writeFile(poseFile, encodeRgbaPng(2, 2, changedPixels))
    await expect(createProvider("comfyui", "online").submit(spec, [])).rejects.toThrow(
      /provider input "pose" changed before upload/,
    )
  })

  it("runs an ordered frame set as one reviewed, atomic, multi-output asset", async () => {
    const nativeFetch = globalThis.fetch
    const queued: JsonObject[] = []
    const uploads: string[] = []
    let nextPrompt = 0
    let allReady = false
    vi.stubGlobal("fetch", vi.fn(async (input, init) => {
      const url = String(input)
      if (!url.startsWith("http://127.0.0.1:8188/")) return nativeFetch(input, init)
      if (url.endsWith("/upload/image")) {
        const image = (init!.body as FormData).get("image") as File
        uploads.push(image.name)
        return json({ name: image.name, subfolder: "pixelkiln", type: "input" })
      }
      if (url.endsWith("/prompt")) {
        queued.push(JSON.parse(String(init!.body)).prompt)
        return json({ prompt_id: `frame-prompt-${nextPrompt++}` })
      }
      if (url.includes("/history/")) {
        const promptId = decodeURIComponent(new URL(url).pathname.split("/").at(-1)!)
        if (!allReady && promptId === "frame-prompt-1") return json({})
        const index = Number(promptId.at(-1))
        return json(successHistory(promptId, [{
          filename: `frame-${index}.png`,
          subfolder: "sets/dancer",
          type: "output",
        }]))
      }
      if (url.includes("/view?")) {
        const index = Number(new URL(url).searchParams.get("filename")!.match(/\d+/)![0])
        return new Response(poses[index], { status: 200, headers: { "Content-Type": "image/png" } })
      }
      return json({}, 404)
    }))

    const { loaded, spec, poses } = await frameSetProject()
    const provider = createProvider("comfyui", "online")
    const lock: Lock = { version: 2, entries: {} }
    const lockPath = path.join(dir, "pixelkiln.lock.json")
    await submit(provider, loaded, (await buildPlan([spec], lock)).actionable, lock, lockPath, {
      budget: 0,
      spacingMs: 0,
    })
    let entry = lock.entries["motion/dancer"]!
    expect(entry.status).toBe("processing")
    expect(entry.reviewObjectId).toBe(entry.jobId)
    expect(uploads.sort()).toEqual(poses.map((pose) => `${sha256(pose)}.png`).sort())
    expect(queued).toHaveLength(2)
    expect(queued[0]).toMatchObject({
      "3": { inputs: { seed: 100 } },
      "19": { inputs: { image: `pixelkiln/${sha256(poses[0]!)}.png` } },
    })
    expect(queued[1]).toMatchObject({
      "3": { inputs: { seed: 107 } },
      "19": { inputs: { image: `pixelkiln/${sha256(poses[1]!)}.png` } },
    })

    await expect(provider.poll(entry.jobId!, "frames", { spec })).resolves.toEqual({
      status: "processing",
    })
    allReady = true
    await poll(provider, lock, lockPath, { intervalMs: 0, specs: [spec] })
    entry = lock.entries["motion/dancer"]!
    expect(entry.status).toBe("review")
    expect(entry.outputs).toEqual([])

    let reviewUrl = ""
    const picked = runPicker(provider, lock, lockPath, {
      open: false,
      specs: [spec],
      onProgress: (message) => {
        reviewUrl ||= message.match(/http:\/\/127\.0\.0\.1:\d+\//)?.[0] ?? ""
      },
    })
    await vi.waitFor(() => expect(reviewUrl).not.toBe(""))
    const page = await nativeFetch(reviewUrl)
    const html = await page.text()
    expect(html).toContain("Animated frame-set preview")
    expect(html).toContain("Accept ordered frame set")
    const accepted = await nativeFetch(`${reviewUrl}apply`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ selections: [{ key: "motion/dancer", index: 0 }] }),
    })
    expect(accepted.ok).toBe(true)
    await expect(picked).resolves.toEqual({ selected: 1, skipped: 0 })
    entry = lock.entries["motion/dancer"]!
    expect(entry.status).toBe("selected")
    expect(entry.sourceUrls.map((source) => source.role)).toEqual(["frame-00", "frame-01"])

    await fetchAssets(provider, [spec], lock, lockPath)
    entry = lock.entries["motion/dancer"]!
    expect(entry.status).toBe("downloaded")
    expect(entry.outputs.map((output) => output.role)).toEqual(["frame-00", "frame-01"])
    await expect(readFile(path.join(dir, "out/dancer-frame-00.png"))).resolves.toEqual(poses[0])
    await expect(readFile(path.join(dir, "out/dancer-frame-01.png"))).resolves.toEqual(poses[1])
    expect(JSON.stringify(lock)).not.toContain(dir)
  }, 15_000)

  it("checkpoints accepted frame prompts and resumes only the missing frame", async () => {
    const promptSeeds: number[] = []
    let promptAttempt = 0
    vi.stubGlobal("fetch", vi.fn(async (input, init) => {
      const url = String(input)
      if (url.endsWith("/upload/image")) {
        const image = (init!.body as FormData).get("image") as File
        return json({ name: image.name, subfolder: "pixelkiln", type: "input" })
      }
      if (url.endsWith("/prompt")) {
        const body = JSON.parse(String(init!.body))
        promptSeeds.push(body.prompt["3"].inputs.seed)
        promptAttempt++
        if (promptAttempt === 2) return json({ error: "queue unavailable" }, 503)
        return json({ prompt_id: promptAttempt === 1 ? "frame-zero" : "frame-one" })
      }
      if (url.includes("/history/")) {
        throw new Error("partial frame jobs must not poll ComfyUI history")
      }
      return json({}, 404)
    }))

    const { loaded, spec } = await frameSetProject()
    const provider = createProvider("comfyui", "online")
    const lock: Lock = { version: 2, entries: {} }
    const lockPath = path.join(dir, "pixelkiln.lock.json")
    const first = await submit(
      provider,
      loaded,
      (await buildPlan([spec], lock)).actionable,
      lock,
      lockPath,
      { budget: 0, spacingMs: 0 },
    )

    expect(first).toMatchObject({ submitted: 0, failed: 1 })
    const saved = await loadLock(lockPath)
    let entry = saved.entries["motion/dancer"]!
    expect(entry).toMatchObject({ status: "failed", submissionComplete: false })
    expect(entry.providerMetadata.comfyui?.frameSet).toMatchObject({
      count: 2,
      promptIds: ["frame-zero"],
    })
    expect(JSON.stringify(saved)).not.toContain(dir)
    await expect(provider.poll(entry.jobId!, "frames", { spec })).resolves.toEqual({
      status: "processing",
    })

    const resumedPlan = await buildPlan([spec], saved)
    expect(resumedPlan.items[0]).toMatchObject({ state: "failed" })
    expect(resumedPlan.items[0]!.reason).toMatch(/saved checkpoint/)
    const resumed = await submit(
      provider,
      loaded,
      resumedPlan.actionable,
      saved,
      lockPath,
      { budget: 0, spacingMs: 0 },
    )

    expect(resumed).toMatchObject({ submitted: 1, failed: 0 })
    entry = (await loadLock(lockPath)).entries["motion/dancer"]!
    expect(entry).toMatchObject({ status: "processing", submissionComplete: true })
    expect(entry.providerMetadata.comfyui?.frameSet).toMatchObject({
      count: 2,
      promptIds: ["frame-zero", "frame-one"],
    })
    expect(promptSeeds).toEqual([100, 107, 107])
  })

  it("keeps complete frame job ids from older lockfiles pollable", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input) => {
      const promptId = decodeURIComponent(new URL(String(input)).pathname.split("/").at(-1)!)
      const index = promptId === "legacy-zero" ? 0 : 1
      return json(successHistory(promptId, [{
        filename: `legacy-${index}.png`,
        subfolder: "sets/legacy",
        type: "output",
      }]))
    }))
    const { spec } = await frameSetProject()
    const legacyJob = `frames:${Buffer.from(JSON.stringify({
      outputNodeId: "9",
      promptIds: ["legacy-zero", "legacy-one"],
    })).toString("base64url")}`

    await expect(createProvider("comfyui", "online").poll(legacyJob, "frames", { spec }))
      .resolves.toMatchObject({
        status: "review-set",
        sources: [{ role: "frame-00" }, { role: "frame-01" }],
      })
  })

  it("starts a fresh frame set when the spec changes after a partial checkpoint", async () => {
    const promptSeeds: number[] = []
    let promptAttempt = 0
    vi.stubGlobal("fetch", vi.fn(async (input, init) => {
      const url = String(input)
      if (url.endsWith("/upload/image")) {
        const image = (init!.body as FormData).get("image") as File
        return json({ name: image.name, subfolder: "pixelkiln", type: "input" })
      }
      if (url.endsWith("/prompt")) {
        const body = JSON.parse(String(init!.body))
        promptSeeds.push(body.prompt["3"].inputs.seed)
        promptAttempt++
        if (promptAttempt === 2) return json({ error: "queue unavailable" }, 503)
        return json({ prompt_id: promptAttempt === 1 ? "old-zero" : `new-${promptAttempt - 3}` })
      }
      return json({}, 404)
    }))

    const first = await frameSetProject()
    const provider = createProvider("comfyui", "online")
    const lock: Lock = { version: 2, entries: {} }
    const lockPath = path.join(dir, "pixelkiln.lock.json")
    await submit(
      provider,
      first.loaded,
      (await buildPlan([first.spec], lock)).actionable,
      lock,
      lockPath,
      { budget: 0, spacingMs: 0 },
    )

    const manifest = JSON.parse(await readFile(first.manifestPath, "utf8"))
    manifest.assets.dancer.prompt = "a dancer taking one step forward"
    await writeFile(first.manifestPath, JSON.stringify(manifest))
    const changedLoaded = await loadManifest(first.manifestPath)
    const [changedSpec] = await resolveSpecs(changedLoaded)
    const saved = await loadLock(lockPath)
    const changedPlan = await buildPlan([changedSpec!], saved)
    expect(changedPlan.items[0]).toMatchObject({ state: "stale" })

    await submit(
      provider,
      changedLoaded,
      changedPlan.actionable,
      saved,
      lockPath,
      { budget: 0, spacingMs: 0 },
    )

    const entry = (await loadLock(lockPath)).entries["motion/dancer"]!
    expect(entry.providerMetadata.comfyui?.frameSet).toMatchObject({
      promptIds: ["new-0", "new-1"],
    })
    expect(JSON.stringify(entry)).not.toContain("old-zero")
    expect(promptSeeds).toEqual([100, 107, 100, 107])
  })

  it("uploads immutable revision inputs and binds an inpaint workflow", async () => {
    const uploads: Array<{
      name: string
      bytes: Buffer
      type: FormDataEntryValue | null
      subfolder: FormDataEntryValue | null
      overwrite: FormDataEntryValue | null
    }> = []
    let queued: JsonObject | null = null
    vi.stubGlobal("fetch", vi.fn(async (input, init) => {
      const url = String(input)
      if (url.endsWith("/upload/image")) {
        const form = init!.body as FormData
        const image = form.get("image") as File
        uploads.push({
          name: image.name,
          bytes: Buffer.from(await image.arrayBuffer()),
          type: form.get("type"),
          subfolder: form.get("subfolder"),
          overwrite: form.get("overwrite"),
        })
        return json({ name: image.name, subfolder: "pixelkiln", type: "input" })
      }
      if (url.endsWith("/prompt")) {
        queued = JSON.parse(String(init!.body))
        return json({ prompt_id: "revision-1" })
      }
      return json({}, 404)
    }))

    const { spec, source, mask } = await revisionProject("inpaint")
    await expect(createProvider("comfyui", "online").submit(spec, [])).resolves.toMatchObject({
      jobId: "revision-1#9",
      metadata: {
        revision: {
          mode: "inpaint",
          sourceAssetId: "source",
          sourceSha256: sha256(source),
          maskSha256: sha256(mask),
        },
      },
    })

    expect(uploads).toEqual([
      expect.objectContaining({
        name: `${sha256(source)}.png`,
        bytes: source,
        type: "input",
        subfolder: "pixelkiln",
        overwrite: "true",
      }),
      expect.objectContaining({
        name: `${sha256(mask)}.png`,
        bytes: mask,
        type: "input",
        subfolder: "pixelkiln",
        overwrite: "true",
      }),
    ])
    expect(queued).toMatchObject({
      prompt: {
        "3": { inputs: { denoise: 0.4 } },
        "6": { inputs: { text: "preserve the silhouette and add snow" } },
        "12": { inputs: { image: `pixelkiln/${sha256(source)}.png` } },
        "13": { inputs: { image: `pixelkiln/${sha256(mask)}.png` } },
        "15": { inputs: { amount: 1 } },
      },
    })
  })

  it("rejects incomplete revision workflows offline", async () => {
    const { manifestPath } = await revisionProject()
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"))
    delete manifest.styles.local.providerOptions.comfyui.bindings.sourceImage
    await writeFile(manifestPath, JSON.stringify(manifest))
    await expect(resolveSpecs(await loadManifest(manifestPath), { assets: ["revised"] }))
      .rejects.toThrow(/revisions require bindings.sourceImage/)

    manifest.styles.local.providerOptions.comfyui.bindings.sourceImage = {
      nodeId: "12",
      input: "image",
    }
    delete manifest.styles.local.providerOptions.comfyui.bindings.strength
    await writeFile(manifestPath, JSON.stringify(manifest))
    await expect(resolveSpecs(await loadManifest(manifestPath), { assets: ["revised"] }))
      .rejects.toThrow(/revision strength requires bindings.strength/)

    manifest.styles.local.providerOptions.comfyui.bindings.strength = {
      nodeId: "3",
      input: "denoise",
    }
    manifest.assets.revised.width = 32
    await writeFile(manifestPath, JSON.stringify(manifest))
    await expect(resolveSpecs(await loadManifest(manifestPath), { assets: ["revised"] }))
      .rejects.toThrow(/without width\/height bindings must keep the source dimensions/)
  })

  it("reports upload failures without exposing image bytes or workflow JSON", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => json({ error: "disk full" }, 507)))
    const { spec, source } = await revisionProject()
    const error = await createProvider("comfyui", "online").submit(spec, []).catch(String)
    expect(error).toContain("ComfyUI image upload failed (507): disk full")
    expect(error).not.toContain(source.toString("base64"))
    expect(error).not.toContain("preserve the silhouette")
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
