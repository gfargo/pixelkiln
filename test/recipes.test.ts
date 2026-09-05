import { afterEach, beforeEach, describe, expect, it } from "vitest"
import path from "node:path"
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import {
  RecipeSchema,
  installRecipe,
  listBundledRecipes,
  recipeDigest,
  verifyRecipe,
  type Recipe,
} from "../src/recipes.ts"
import { sha256 } from "../src/hash.ts"

describe("versioned recipes", () => {
  let dir: string

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "pixelkiln-recipes-"))
  })

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  async function writeTestRecipe(): Promise<{ recipePath: string; modelRoot: string }> {
    const bundle = path.join(dir, "source")
    const modelRoot = path.join(dir, "models")
    await mkdir(path.join(modelRoot, "checkpoints"), { recursive: true })
    await mkdir(bundle, { recursive: true })
    const workflow = "{\"workflow\":true}\n"
    const model = "model bytes"
    await writeFile(path.join(bundle, "workflow.json"), workflow)
    await writeFile(path.join(modelRoot, "checkpoints", "test.safetensors"), model)

    const raw = {
      format: "pixelkiln-recipe",
      schemaVersion: 1,
      id: "comfyui/test-environment",
      version: "1.2.3",
      provider: "comfyui",
      summary: "Test recipe.",
      files: [{ path: "workflow.json", role: "workflow", sha256: sha256(workflow) }],
      models: [{
        path: "checkpoints/test.safetensors",
        sha256: sha256(model),
        source: "https://example.com/test.safetensors",
        license: "Test license",
      }],
      styleId: "test-environment",
      style: {
        provider: "comfyui",
        generator: "map",
        outDir: "art/generated",
        providerOptions: {
          comfyui: {
            workflowFile: "{{recipeDir}}/workflow.json",
            outputNodeId: "9",
            numImages: 2,
            bindings: {
              prompt: { nodeId: "6", input: "text" },
              width: { nodeId: "11", input: "width" },
              height: { nodeId: "11", input: "height" },
              batchSize: { nodeId: "5", input: "batch_size" },
            },
          },
        },
      },
      workflow: {
        path: "workflow.json",
        outputNodeId: "9",
        numImages: 2,
        bindings: {
          prompt: { nodeId: "6", input: "text" },
          width: { nodeId: "11", input: "width" },
          height: { nodeId: "11", input: "height" },
          batchSize: { nodeId: "5", input: "batch_size" },
        },
      },
      quality: {
        stage: "composition-source",
        workingCanvas: { width: 1024, height: 1024 },
        recommendedNativeSize: { min: 48, max: 128 },
        paletteColors: { min: 16, max: 32 },
        background: "full-bleed",
        checks: ["prompt-coverage", "native-grid", "final-palette", "human-1x"],
        notes: [],
      },
      integrity: { algorithm: "sha256", digest: "0".repeat(64) },
    }
    const recipe = RecipeSchema.parse(raw) as Recipe
    recipe.integrity.digest = recipeDigest(recipe)
    const recipePath = path.join(bundle, "pixelkiln.recipe.json")
    await writeFile(recipePath, JSON.stringify(recipe, null, 2) + "\n")
    return { recipePath, modelRoot }
  }

  it("ships an intact, explicitly non-production ComfyUI recipe", async () => {
    const recipes = await listBundledRecipes()
    const loaded = recipes.find(({ recipe }) => recipe.id === "comfyui/pixel-art-xl-environment")
    expect(loaded?.recipe.version).toBe("1.0.0")
    expect(loaded?.recipe.quality.stage).toBe("composition-source")
    expect((await verifyRecipe("comfyui/pixel-art-xl-environment")).ok).toBe(true)
  })

  it("checks workflow and model bytes independently", async () => {
    const { recipePath, modelRoot } = await writeTestRecipe()
    const withoutModels = await verifyRecipe(recipePath)
    expect(withoutModels.ok).toBe(true)
    expect(withoutModels.models[0]?.status).toBe("unchecked")

    const complete = await verifyRecipe(recipePath, { modelRoot })
    expect(complete.ok).toBe(true)
    expect(complete.files[0]?.status).toBe("ok")
    expect(complete.models[0]?.status).toBe("ok")

    await writeFile(path.join(path.dirname(recipePath), "workflow.json"), "changed")
    const changed = await verifyRecipe(recipePath, { modelRoot })
    expect(changed.ok).toBe(false)
    expect(changed.files[0]?.status).toBe("mismatch")

    await writeFile(path.join(path.dirname(recipePath), "workflow.json"), "{\"workflow\":true}\n")
    await writeFile(path.join(modelRoot, "checkpoints", "test.safetensors"), "changed model")
    const changedModel = await verifyRecipe(recipePath, { modelRoot })
    expect(changedModel.ok).toBe(false)
    expect(changedModel.models[0]?.status).toBe("mismatch")
  })

  it("detects valid metadata that no longer matches its integrity digest", async () => {
    const { recipePath } = await writeTestRecipe()
    const raw = JSON.parse(await readFile(recipePath, "utf8"))
    raw.summary = "Tampered summary."
    await writeFile(recipePath, JSON.stringify(raw, null, 2) + "\n")

    const changed = await verifyRecipe(recipePath)
    expect(changed.ok).toBe(false)
    expect(changed.integrity.status).toBe("mismatch")
  })

  it("rejects a style provider that conflicts with its recipe", async () => {
    const { recipePath } = await writeTestRecipe()
    const raw = JSON.parse(await readFile(recipePath, "utf8"))
    raw.style.provider = "pixellab"
    const parsed = RecipeSchema.safeParse(raw)
    expect(parsed.success).toBe(false)
    if (!parsed.success) {
      expect(parsed.error.issues).toContainEqual(expect.objectContaining({
        path: ["style", "provider"],
        message: "must match the recipe provider",
      }))
    }
  })

  it("installs transactionally, renders the workflow path, and protects local changes", async () => {
    const { recipePath } = await writeTestRecipe()
    const destination = path.join(dir, "project", "recipes", "test")
    const first = await installRecipe(recipePath, { out: destination, cwd: dir })
    expect(first.style.provider).toBe("comfyui")
    expect(first.style.providerOptions.comfyui).toMatchObject({
      workflowFile: "project/recipes/test/workflow.json",
    })
    expect(await readFile(path.join(destination, "workflow.json"), "utf8"))
      .toBe("{\"workflow\":true}\n")

    await writeFile(path.join(destination, "workflow.json"), "local edit")
    await expect(installRecipe(recipePath, { out: destination, cwd: dir }))
      .rejects.toThrow(/local changes.*--force/)
    await installRecipe(recipePath, { out: destination, cwd: dir, force: true })
    expect(await readFile(path.join(destination, "workflow.json"), "utf8"))
      .toBe("{\"workflow\":true}\n")
  })

  it("rejects traversal before reading recipe members", () => {
    const result = RecipeSchema.safeParse({
      format: "pixelkiln-recipe",
      schemaVersion: 1,
      id: "comfyui/unsafe",
      version: "1.0.0",
      provider: "comfyui",
      summary: "Unsafe.",
      files: [{ path: "../secret", role: "workflow", sha256: "0".repeat(64) }],
      models: [],
      styleId: "unsafe",
      style: { outDir: "art", providerOptions: {} },
      quality: {
        stage: "composition-source",
        workingCanvas: { width: 1024, height: 1024 },
        recommendedNativeSize: { min: 48, max: 128 },
        paletteColors: { min: 16, max: 32 },
        background: "opaque",
        checks: ["human-1x"],
        notes: [],
      },
      integrity: { algorithm: "sha256", digest: "0".repeat(64) },
    })
    expect(result.success).toBe(false)
  })
})
