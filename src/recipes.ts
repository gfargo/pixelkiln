import path from "node:path"
import { existsSync } from "node:fs"
import { readdir, readFile } from "node:fs/promises"
import { fileURLToPath } from "node:url"
import { z } from "zod"
import { writeArtifactBundle } from "./artifacts.ts"
import { sha256, sha256File } from "./hash.ts"
import { StyleSchema, type Style } from "./types.ts"

const SHA256_RE = /^[0-9a-f]{64}$/
const RECIPE_ID_RE = /^[a-z0-9][a-z0-9-]*\/[a-z0-9][a-z0-9-]*$/
const VERSION_RE = /^\d+\.\d+\.\d+$/
const RECIPE_FILE = "pixelkiln.recipe.json"
const RECIPE_DIR_TOKEN = "{{recipeDir}}"

const PortablePathSchema = z.string().min(1).refine((value) => {
  if (value.includes("\\") || path.posix.isAbsolute(value)) return false
  const parts = value.split("/")
  return !parts.includes("") && !parts.includes(".") && !parts.includes("..")
}, "expected a portable relative path without '.', '..', or backslashes")

const RecipeBindingSchema = z.object({
  nodeId: z.string().min(1),
  input: z.string().min(1),
}).strict()

export const RecipeSchema = z.object({
  $schema: z.string().url().optional(),
  format: z.literal("pixelkiln-recipe"),
  schemaVersion: z.literal(1),
  id: z.string().regex(RECIPE_ID_RE, "expected provider/name"),
  version: z.string().regex(VERSION_RE, "expected x.y.z"),
  provider: z.string().regex(/^[a-z0-9][a-z0-9-]*$/),
  summary: z.string().min(1).max(240),
  files: z.array(z.object({
    path: PortablePathSchema,
    role: z.enum(["workflow", "reference"]),
    sha256: z.string().regex(SHA256_RE),
  }).strict()).default([]),
  models: z.array(z.object({
    path: PortablePathSchema,
    sha256: z.string().regex(SHA256_RE),
    source: z.string().url(),
    license: z.string().min(1),
  }).strict()).default([]),
  styleId: z.string().regex(/^[a-z0-9][a-z0-9-]*$/),
  style: StyleSchema,
  workflow: z.object({
    path: PortablePathSchema,
    outputNodeId: z.string().min(1),
    numImages: z.number().int().min(1).max(16),
    bindings: z.object({
      prompt: RecipeBindingSchema,
      width: RecipeBindingSchema,
      height: RecipeBindingSchema,
      batchSize: RecipeBindingSchema,
      seed: RecipeBindingSchema.optional(),
    }).strict(),
  }).strict().optional(),
  quality: z.object({
    stage: z.enum(["composition-source", "production-candidate"]),
    workingCanvas: z.object({
      width: z.number().int().min(16),
      height: z.number().int().min(16),
    }).strict(),
    recommendedNativeSize: z.object({
      min: z.number().int().min(1),
      max: z.number().int().min(1),
    }).strict(),
    paletteColors: z.object({
      min: z.number().int().min(1),
      max: z.number().int().min(1),
    }).strict(),
    background: z.enum(["opaque", "transparent", "full-bleed"]),
    checks: z.array(z.enum([
      "prompt-coverage",
      "native-grid",
      "final-palette",
      "alpha-edge",
      "human-1x",
    ])).min(1),
    notes: z.array(z.string().min(1)).default([]),
  }).strict(),
  integrity: z.object({
    algorithm: z.literal("sha256"),
    digest: z.string().regex(SHA256_RE),
  }).strict(),
}).strict().superRefine((recipe, context) => {
  if (recipe.style.provider && recipe.style.provider !== recipe.provider) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["style", "provider"],
      message: "must match the recipe provider",
    })
  }
  const filePaths = recipe.files.map((file) => file.path)
  if (new Set(filePaths).size !== filePaths.length) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["files"], message: "duplicate file path" })
  }
  const modelPaths = recipe.models.map((model) => model.path)
  if (new Set(modelPaths).size !== modelPaths.length) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["models"], message: "duplicate model path" })
  }
  if (filePaths.includes(RECIPE_FILE)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["files"],
      message: `${RECIPE_FILE} cannot hash itself`,
    })
  }
  if (recipe.quality.recommendedNativeSize.min > recipe.quality.recommendedNativeSize.max) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["quality", "recommendedNativeSize"],
      message: "min cannot exceed max",
    })
  }
  if (recipe.quality.paletteColors.min > recipe.quality.paletteColors.max) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["quality", "paletteColors"],
      message: "min cannot exceed max",
    })
  }
  if (recipe.workflow && !recipe.files.some(
    (file) => file.path === recipe.workflow!.path && file.role === "workflow",
  )) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["workflow", "path"],
      message: "must name a file whose role is workflow",
    })
  }
  if (recipe.provider === "comfyui") {
    if (!recipe.workflow) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["workflow"],
        message: "ComfyUI recipes require workflow metadata",
      })
      return
    }
    const options = recipe.style.providerOptions.comfyui
    if (!options || typeof options !== "object" || Array.isArray(options)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["style", "providerOptions", "comfyui"],
        message: "ComfyUI recipes require ComfyUI provider options",
      })
      return
    }
    const expected = {
      workflowFile: `${RECIPE_DIR_TOKEN}/${recipe.workflow.path}`,
      outputNodeId: recipe.workflow.outputNodeId,
      numImages: recipe.workflow.numImages,
      bindings: recipe.workflow.bindings,
    }
    if (JSON.stringify(canonical(options)) !== JSON.stringify(canonical(expected))) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["style", "providerOptions", "comfyui"],
        message: "must match workflow metadata and use {{recipeDir}} for workflowFile",
      })
    }
  }
})

export type Recipe = z.infer<typeof RecipeSchema>

export interface LoadedRecipe {
  recipe: Recipe
  path: string
  dir: string
  bundled: boolean
}

export interface RecipeFileVerification {
  path: string
  expectedSha256: string
  actualSha256: string | null
  status: "ok" | "missing" | "mismatch"
}

export interface RecipeModelVerification {
  path: string
  expectedSha256: string
  actualSha256: string | null
  source: string
  license: string
  status: RecipeFileVerification["status"] | "unchecked"
}

export interface RecipeVerification {
  version: 1
  ok: boolean
  recipe: {
    id: string
    version: string
    path: string
    bundled: boolean
  }
  integrity: {
    expectedSha256: string
    actualSha256: string
    status: "ok" | "mismatch"
  }
  files: RecipeFileVerification[]
  models: RecipeModelVerification[]
  modelRoot: string | null
}

export interface InstallRecipeOptions {
  out?: string
  force?: boolean
  cwd?: string
  bundledRoot?: string
}

export interface InstallRecipeResult {
  recipe: Recipe
  destination: string
  changed: string[]
  unchanged: string[]
  styleId: string
  style: Style
}

function canonical(value: unknown): unknown {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("Recipe numbers must be finite.")
    return value
  }
  if (Array.isArray(value)) return value.map(canonical)
  if (typeof value === "object") {
    const sorted: Record<string, unknown> = {}
    for (const key of Object.keys(value).sort()) {
      const item = (value as Record<string, unknown>)[key]
      if (item !== undefined) sorted[key] = canonical(item)
    }
    return sorted
  }
  throw new Error(`Recipe metadata cannot contain ${typeof value} values.`)
}

export function recipeDigest(recipe: Recipe): string {
  const { integrity: _integrity, ...payload } = recipe
  return sha256(JSON.stringify(canonical(payload)))
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

async function readRecipeFile(recipePath: string, bundled: boolean): Promise<LoadedRecipe> {
  const absolute = path.resolve(recipePath)
  let raw: unknown
  try {
    raw = JSON.parse(await readFile(absolute, "utf8"))
  } catch (error) {
    throw new Error(`Could not read recipe ${absolute}: ${message(error)}`, { cause: error })
  }
  const parsed = RecipeSchema.safeParse(raw)
  if (!parsed.success) {
    throw new Error(
      `Invalid recipe ${absolute}:\n` +
        parsed.error.issues.map((issue) => `  ${issue.path.join(".") || "$"}: ${issue.message}`).join("\n"),
    )
  }
  return { recipe: parsed.data, path: absolute, dir: path.dirname(absolute), bundled }
}

async function walkRecipeFiles(root: string): Promise<string[]> {
  if (!existsSync(root)) return []
  const out: string[] = []
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const resolved = path.join(root, entry.name)
    if (entry.isDirectory()) out.push(...await walkRecipeFiles(resolved))
    else if (entry.isFile() && entry.name === RECIPE_FILE) out.push(resolved)
  }
  return out
}

export function bundledRecipeRoot(): string {
  return fileURLToPath(new URL("../recipes/", import.meta.url))
}

export async function listBundledRecipes(root = bundledRecipeRoot()): Promise<LoadedRecipe[]> {
  const recipes = await Promise.all(
    (await walkRecipeFiles(path.resolve(root))).map((file) => readRecipeFile(file, true)),
  )
  return recipes.sort((a, b) =>
    a.recipe.id.localeCompare(b.recipe.id) || compareVersions(b.recipe.version, a.recipe.version),
  )
}

function compareVersions(a: string, b: string): number {
  const av = a.split(".").map(Number)
  const bv = b.split(".").map(Number)
  for (let i = 0; i < 3; i++) {
    const difference = av[i]! - bv[i]!
    if (difference) return difference
  }
  return 0
}

function parseSelector(selector: string): { id: string; version?: string } {
  const match = selector.match(/^([^@]+?)(?:@(\d+\.\d+\.\d+))?$/)
  if (!match || !RECIPE_ID_RE.test(match[1]!)) {
    throw new Error(`Invalid recipe selector "${selector}". Expected provider/name or provider/name@x.y.z.`)
  }
  return { id: match[1]!, version: match[2] }
}

export async function resolveRecipe(
  target: string,
  bundledRoot = bundledRecipeRoot(),
): Promise<LoadedRecipe> {
  const local = path.resolve(target)
  if (existsSync(local)) {
    const recipePath = path.basename(local) === RECIPE_FILE ? local : path.join(local, RECIPE_FILE)
    return readRecipeFile(recipePath, false)
  }
  if (target.startsWith(".") || target.startsWith("/") || target.includes("\\")) {
    throw new Error(`Recipe path not found: ${local}`)
  }
  const selector = parseSelector(target)
  const matches = (await listBundledRecipes(bundledRoot)).filter((entry) =>
    entry.recipe.id === selector.id &&
    (selector.version === undefined || entry.recipe.version === selector.version),
  )
  if (!matches.length) throw new Error(`Bundled recipe not found: ${target}`)
  return matches[0]!
}

async function verifyFile(root: string, file: { path: string; sha256: string }): Promise<RecipeFileVerification> {
  const absolute = path.resolve(root, ...file.path.split("/"))
  if (!existsSync(absolute)) {
    return { path: file.path, expectedSha256: file.sha256, actualSha256: null, status: "missing" }
  }
  const actualSha256 = await sha256File(absolute)
  return {
    path: file.path,
    expectedSha256: file.sha256,
    actualSha256,
    status: actualSha256 === file.sha256 ? "ok" : "mismatch",
  }
}

export async function verifyRecipe(
  target: string,
  options: { modelRoot?: string; bundledRoot?: string } = {},
): Promise<RecipeVerification> {
  const loaded = await resolveRecipe(target, options.bundledRoot)
  const actualIntegrity = recipeDigest(loaded.recipe)
  const files = await Promise.all(loaded.recipe.files.map((file) => verifyFile(loaded.dir, file)))
  const modelRoot = options.modelRoot ? path.resolve(options.modelRoot) : null
  const models: RecipeModelVerification[] = modelRoot
    ? await Promise.all(loaded.recipe.models.map(async (model) => ({
        ...await verifyFile(modelRoot, model),
        source: model.source,
        license: model.license,
      })))
    : loaded.recipe.models.map((model) => ({
        path: model.path,
        expectedSha256: model.sha256,
        actualSha256: null,
        source: model.source,
        license: model.license,
        status: "unchecked",
      }))
  const integrityStatus = actualIntegrity === loaded.recipe.integrity.digest ? "ok" : "mismatch"
  return {
    version: 1,
    ok:
      integrityStatus === "ok" &&
      files.every((file) => file.status === "ok") &&
      (!modelRoot || models.every((model) => model.status === "ok")),
    recipe: {
      id: loaded.recipe.id,
      version: loaded.recipe.version,
      path: loaded.path,
      bundled: loaded.bundled,
    },
    integrity: {
      expectedSha256: loaded.recipe.integrity.digest,
      actualSha256: actualIntegrity,
      status: integrityStatus,
    },
    files,
    models,
    modelRoot,
  }
}

function renderStyle(style: Style, destination: string, cwd: string): Style {
  const portableDir = path.relative(cwd, destination).split(path.sep).join("/") || "."
  const replace = (value: unknown): unknown => {
    if (typeof value === "string") return value.replaceAll(RECIPE_DIR_TOKEN, portableDir)
    if (Array.isArray(value)) return value.map(replace)
    if (value && typeof value === "object") {
      return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, replace(item)]))
    }
    return value
  }
  return replace(style) as Style
}

export async function installRecipe(
  target: string,
  options: InstallRecipeOptions = {},
): Promise<InstallRecipeResult> {
  const cwd = path.resolve(options.cwd ?? process.cwd())
  const loaded = await resolveRecipe(target, options.bundledRoot)
  const verification = await verifyRecipe(loaded.path)
  if (!verification.ok) {
    throw new Error(`Recipe ${loaded.recipe.id}@${loaded.recipe.version} failed integrity verification.`)
  }
  const destination = options.out
    ? path.resolve(cwd, options.out)
    : path.join(cwd, "pixelkiln-recipes", ...loaded.recipe.id.split("/"), loaded.recipe.version)
  const sources = [
    { path: RECIPE_FILE, source: loaded.path },
    ...loaded.recipe.files.map((file) => ({ path: file.path, source: path.join(loaded.dir, ...file.path.split("/")) })),
  ]
  const files = await Promise.all(sources.map(async (file) => ({
    path: path.join(destination, ...file.path.split("/")),
    data: await readFile(file.source),
  })))

  if (!options.force) {
    for (const file of files) {
      if (!existsSync(file.path)) continue
      const current = await readFile(file.path)
      if (!current.equals(file.data)) {
        throw new Error(
          `Recipe destination has local changes: ${file.path}. Choose another --out or pass --force to replace declared recipe files.`,
        )
      }
    }
  }

  const written = await writeArtifactBundle(files)
  const renderedStyle = renderStyle(loaded.recipe.style, destination, cwd)
  return {
    recipe: loaded.recipe,
    destination,
    changed: written.changed,
    unchanged: written.unchanged,
    styleId: loaded.recipe.styleId,
    // A recipe snippet should remain correct when pasted into a manifest whose
    // top-level default is another provider.
    style: { ...renderedStyle, provider: renderedStyle.provider ?? loaded.recipe.provider },
  }
}
