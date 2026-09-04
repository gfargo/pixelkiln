import path from "node:path"
import { existsSync } from "node:fs"
import { readFile } from "node:fs/promises"
import { z } from "zod"
import {
  readArtifactBundleManifest,
  verifyArtifactBundle,
  writeArtifactBundle,
} from "../artifacts.ts"
import { sha256, sha256File } from "../hash.ts"
import { decodePng, type DecodedPng } from "../png.ts"
import { colorDistance } from "./audit.ts"

const SHA256_RE = /^[0-9a-f]{64}$/
const HEX_RE = /^#[0-9a-f]{6}$/
const MAX_REDMEAN_DISTANCE = 765

const QualityPathSchema = z.string().min(1).refine(
  (value) => !path.posix.isAbsolute(value) && !value.includes("\\"),
  "expected a portable relative path",
)

export const DEFAULT_QUALITY_TOLERANCES = {
  requireExactHash: false,
  maxColorCountIncrease: 0,
  maxNewColors: 0,
  maxTransparencyDelta: 0.01,
  maxPartialAlphaIncrease: 0,
  maxEdgeDensityDelta: 0.03,
  maxEdgeContrastDrop: 0.03,
  maxIsolatedPixelIncrease: 0.005,
} as const

export const QualityToleranceSchema = z.object({
  requireExactHash: z.boolean(),
  maxColorCountIncrease: z.number().int().min(0),
  maxNewColors: z.number().int().min(0),
  maxTransparencyDelta: z.number().min(0).max(1),
  maxPartialAlphaIncrease: z.number().min(0).max(1),
  maxEdgeDensityDelta: z.number().min(0).max(1),
  maxEdgeContrastDrop: z.number().min(0).max(1),
  maxIsolatedPixelIncrease: z.number().min(0).max(1),
}).strict()

export type QualityTolerances = z.infer<typeof QualityToleranceSchema>

export const ImageQualityMetricsSchema = z.object({
  sha256: z.string().regex(SHA256_RE),
  width: z.number().int().min(1),
  height: z.number().int().min(1),
  colorCount: z.number().int().min(0),
  colors: z.array(z.string().regex(HEX_RE)),
  transparency: z.number().min(0).max(1),
  partialAlpha: z.number().min(0).max(1),
  edgeDensity: z.number().min(0).max(1),
  meanEdgeContrast: z.number().min(0).max(1),
  isolatedPixelRatio: z.number().min(0).max(1),
}).strict()

export type ImageQualityMetrics = z.infer<typeof ImageQualityMetricsSchema>

const QualityBaselineCaseSchema = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9/_-]*$/),
  file: QualityPathSchema,
  record: z.object({
    path: QualityPathSchema,
    sha256: z.string().regex(SHA256_RE),
  }).strict().optional(),
  expected: ImageQualityMetricsSchema,
  tolerances: QualityToleranceSchema,
}).strict()

export const QualityBaselineSchema = z.object({
  $schema: z.string().url().optional(),
  format: z.literal("pixelkiln-quality-baseline"),
  schemaVersion: z.literal(1),
  cases: z.array(QualityBaselineCaseSchema).min(1),
}).strict().superRefine((baseline, context) => {
  const ids = baseline.cases.map((entry) => entry.id)
  if (new Set(ids).size !== ids.length) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["cases"], message: "duplicate case id" })
  }
})

export type QualityBaseline = z.infer<typeof QualityBaselineSchema>

const QualityInputSchema = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9/_-]*$/),
  path: z.string().min(1),
  record: z.string().min(1).optional(),
  tolerances: QualityToleranceSchema.partial().optional(),
}).strict()

export interface ResolvedQualityInput {
  id: string
  file: string
  record?: string
  tolerances: QualityTolerances
}

export interface QualitySnapshotResult {
  baseline: QualityBaseline
  path: string
  changed: boolean
}

export interface QualityRegressionCaseResult {
  id: string
  file: string
  status: "pass" | "fail"
  hashChanged: boolean
  expected: ImageQualityMetrics
  actual: ImageQualityMetrics | null
  violations: string[]
  warnings: string[]
}

export interface QualityRegressionReport {
  version: 1
  safe: boolean
  baseline: string
  summary: {
    total: number
    passed: number
    failed: number
    changed: number
  }
  cases: QualityRegressionCaseResult[]
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function round(value: number): number {
  return Number(value.toFixed(6))
}

function pixelKey(pixels: Buffer, offset: number): number {
  const alpha = pixels[offset + 3]!
  if (alpha === 0) return 0
  return (
    ((pixels[offset]! << 24) >>> 0) |
    (pixels[offset + 1]! << 16) |
    (pixels[offset + 2]! << 8) |
    alpha
  ) >>> 0
}

function edgeContrast(pixels: Buffer, a: number, b: number): number {
  const alphaA = pixels[a + 3]!
  const alphaB = pixels[b + 3]!
  const alphaDistance = Math.abs(alphaA - alphaB) / 255
  if (alphaA === 0 || alphaB === 0) return alphaDistance
  const rgbDistance = colorDistance(
    { r: pixels[a]!, g: pixels[a + 1]!, b: pixels[a + 2]! },
    { r: pixels[b]!, g: pixels[b + 1]!, b: pixels[b + 2]! },
  ) / MAX_REDMEAN_DISTANCE
  return Math.min(1, Math.max(alphaDistance, rgbDistance))
}

export function measureDecodedImageQuality(
  png: DecodedPng,
  digest: string,
): ImageQualityMetrics {
  const colors = new Set<number>()
  let transparent = 0
  let partialAlpha = 0
  let visible = 0
  let isolated = 0

  for (let offset = 0; offset < png.pixels.length; offset += 4) {
    const alpha = png.pixels[offset + 3]!
    if (alpha === 0) {
      transparent++
      continue
    }
    visible++
    if (alpha < 255) partialAlpha++
    colors.add((png.pixels[offset]! << 16) | (png.pixels[offset + 1]! << 8) | png.pixels[offset + 2]!)

    const index = offset / 4
    const x = index % png.width
    const y = Math.floor(index / png.width)
    const key = pixelKey(png.pixels, offset)
    const hasSameNeighbor =
      (x > 0 && pixelKey(png.pixels, offset - 4) === key) ||
      (x + 1 < png.width && pixelKey(png.pixels, offset + 4) === key) ||
      (y > 0 && pixelKey(png.pixels, offset - png.width * 4) === key) ||
      (y + 1 < png.height && pixelKey(png.pixels, offset + png.width * 4) === key)
    if (!hasSameNeighbor) {
      isolated++
    }
  }

  let neighborPairs = 0
  let changedPairs = 0
  let contrastTotal = 0
  for (let y = 0; y < png.height; y++) {
    for (let x = 0; x < png.width; x++) {
      const offset = (y * png.width + x) * 4
      if (x + 1 < png.width) {
        const neighbor = offset + 4
        neighborPairs++
        if (pixelKey(png.pixels, offset) !== pixelKey(png.pixels, neighbor)) {
          changedPairs++
          contrastTotal += edgeContrast(png.pixels, offset, neighbor)
        }
      }
      if (y + 1 < png.height) {
        const neighbor = offset + png.width * 4
        neighborPairs++
        if (pixelKey(png.pixels, offset) !== pixelKey(png.pixels, neighbor)) {
          changedPairs++
          contrastTotal += edgeContrast(png.pixels, offset, neighbor)
        }
      }
    }
  }

  const total = png.width * png.height
  return {
    sha256: digest,
    width: png.width,
    height: png.height,
    colorCount: colors.size,
    colors: [...colors]
      .sort((a, b) => a - b)
      .map((color) => `#${color.toString(16).padStart(6, "0")}`),
    transparency: round(total ? transparent / total : 0),
    partialAlpha: round(total ? partialAlpha / total : 0),
    edgeDensity: round(neighborPairs ? changedPairs / neighborPairs : 0),
    meanEdgeContrast: round(changedPairs ? contrastTotal / changedPairs : 0),
    isolatedPixelRatio: round(visible ? isolated / visible : 0),
  }
}

export async function measureImageQuality(file: string): Promise<ImageQualityMetrics> {
  const absolute = path.resolve(file)
  let bytes: Buffer
  try {
    bytes = await readFile(absolute)
  } catch (error) {
    throw new Error(`Cannot read quality image ${absolute}: ${message(error)}`, { cause: error })
  }
  try {
    return measureDecodedImageQuality(decodePng(bytes), sha256(bytes))
  } catch (error) {
    throw new Error(`Cannot measure quality image ${absolute}: ${message(error)}`, { cause: error })
  }
}

export function resolveQualityInputs(raw: unknown, inputsFilePath: string): ResolvedQualityInput[] {
  const parsed = z.array(QualityInputSchema).min(1).safeParse(raw)
  if (!parsed.success) {
    throw new Error(
      "--inputs must be a non-empty JSON array of quality cases:\n" +
        parsed.error.issues.map((issue) => `  ${issue.path.join(".") || "$"}: ${issue.message}`).join("\n"),
    )
  }
  const ids = parsed.data.map((entry) => entry.id)
  if (new Set(ids).size !== ids.length) throw new Error("--inputs contains a duplicate quality case id.")
  const root = path.dirname(path.resolve(inputsFilePath))
  return parsed.data.map((entry) => ({
    id: entry.id,
    file: path.resolve(root, entry.path),
    ...(entry.record ? { record: path.resolve(root, entry.record) } : {}),
    tolerances: QualityToleranceSchema.parse({
      ...DEFAULT_QUALITY_TOLERANCES,
      ...entry.tolerances,
    }),
  }))
}

function portableRelative(from: string, to: string): string {
  return path.relative(from, path.resolve(to)).split(path.sep).join("/") || "."
}

async function verifyRecordForImage(recordPath: string, imagePath: string): Promise<void> {
  const verification = await verifyArtifactBundle(recordPath)
  if (!verification.current) {
    const changed = [...verification.changedSources, ...verification.changedOutputs]
    throw new Error(
      `Quality record is not current: ${recordPath}` +
        (changed.length ? ` (${changed.join(", ")})` : ""),
    )
  }
  const record = await readArtifactBundleManifest(recordPath)
  const options = record.options
  if (
    record.kind !== "refine" ||
    options === null ||
    typeof options !== "object" ||
    (options as { schema?: unknown }).schema !== "pixelkiln-quality"
  ) {
    throw new Error(`Quality record ${recordPath} is not a PixelKiln refinement record.`)
  }
  const outputs = record.outputs.map((output) => path.resolve(path.dirname(recordPath), output.path))
  if (!outputs.includes(path.resolve(imagePath))) {
    throw new Error(`Quality record ${recordPath} does not own ${imagePath}.`)
  }
}

export async function snapshotQualityBaseline(
  inputs: ResolvedQualityInput[],
  baselinePath: string,
  options: { force?: boolean } = {},
): Promise<QualitySnapshotResult> {
  if (!inputs.length) throw new Error("Cannot snapshot an empty quality baseline.")
  const absolute = path.resolve(baselinePath)
  for (const input of inputs) {
    if (
      path.resolve(input.file) === absolute ||
      (input.record && path.resolve(input.record) === absolute)
    ) {
      throw new Error(`Quality baseline output would overwrite an input: ${absolute}.`)
    }
  }
  const root = path.dirname(absolute)
  const cases = []
  for (const input of [...inputs].sort((a, b) => a.id.localeCompare(b.id))) {
    const expected = await measureImageQuality(input.file)
    let record: { path: string; sha256: string } | undefined
    if (input.record) {
      await verifyRecordForImage(input.record, input.file)
      record = {
        path: portableRelative(root, input.record),
        sha256: await sha256File(input.record),
      }
    }
    cases.push({
      id: input.id,
      file: portableRelative(root, input.file),
      ...(record ? { record } : {}),
      expected,
      tolerances: input.tolerances,
    })
  }
  const baseline = QualityBaselineSchema.parse({
    $schema: "https://unpkg.com/pixelkiln/schema/quality-baseline.schema.json",
    format: "pixelkiln-quality-baseline",
    schemaVersion: 1,
    cases,
  })
  const data = Buffer.from(JSON.stringify(baseline, null, 2) + "\n")
  if (existsSync(absolute) && !options.force) {
    const current = await readFile(absolute)
    if (!current.equals(data)) {
      throw new Error(`Quality baseline already exists with different content: ${absolute}. Pass --force to replace it.`)
    }
  }
  const result = await writeArtifactBundle([{ path: absolute, data }])
  return { baseline, path: absolute, changed: result.changed.length > 0 }
}

export async function readQualityBaseline(baselinePath: string): Promise<QualityBaseline> {
  const absolute = path.resolve(baselinePath)
  let raw: unknown
  try {
    raw = JSON.parse(await readFile(absolute, "utf8"))
  } catch (error) {
    throw new Error(`Could not read quality baseline ${absolute}: ${message(error)}`, { cause: error })
  }
  const parsed = QualityBaselineSchema.safeParse(raw)
  if (!parsed.success) {
    throw new Error(
      `Invalid quality baseline ${absolute}:\n` +
        parsed.error.issues.map((issue) => `  ${issue.path.join(".") || "$"}: ${issue.message}`).join("\n"),
    )
  }
  return parsed.data
}

function regressionViolations(
  expected: ImageQualityMetrics,
  actual: ImageQualityMetrics,
  tolerances: QualityTolerances,
): { violations: string[]; warnings: string[] } {
  const violations: string[] = []
  const warnings: string[] = []
  const changed = actual.sha256 !== expected.sha256
  if (expected.width !== actual.width || expected.height !== actual.height) {
    violations.push(
      `dimensions changed from ${expected.width}x${expected.height} to ${actual.width}x${actual.height}`,
    )
  }
  if (changed && tolerances.requireExactHash) violations.push("image hash changed")
  else if (changed) warnings.push("image hash changed; metric tolerances decide this case")

  const colorIncrease = actual.colorCount - expected.colorCount
  if (colorIncrease > tolerances.maxColorCountIncrease) {
    violations.push(
      `color count increased by ${colorIncrease} (allowed ${tolerances.maxColorCountIncrease})`,
    )
  }
  const expectedColors = new Set(expected.colors)
  const newColors = actual.colors.filter((color) => !expectedColors.has(color))
  if (newColors.length > tolerances.maxNewColors) {
    violations.push(
      `${newColors.length} new color(s) exceed ${tolerances.maxNewColors}: ${newColors.slice(0, 8).join(", ")}`,
    )
  }
  const transparencyDelta = Math.abs(actual.transparency - expected.transparency)
  if (transparencyDelta > tolerances.maxTransparencyDelta) {
    violations.push(
      `transparency changed by ${(transparencyDelta * 100).toFixed(2)} points ` +
        `(allowed ${(tolerances.maxTransparencyDelta * 100).toFixed(2)})`,
    )
  }
  const partialAlphaIncrease = actual.partialAlpha - expected.partialAlpha
  if (partialAlphaIncrease > tolerances.maxPartialAlphaIncrease) {
    violations.push(
      `partial-alpha pixels increased by ${(partialAlphaIncrease * 100).toFixed(2)} points ` +
        `(allowed ${(tolerances.maxPartialAlphaIncrease * 100).toFixed(2)})`,
    )
  }
  const edgeDensityDelta = Math.abs(actual.edgeDensity - expected.edgeDensity)
  if (edgeDensityDelta > tolerances.maxEdgeDensityDelta) {
    violations.push(
      `edge density changed by ${(edgeDensityDelta * 100).toFixed(2)} points ` +
        `(allowed ${(tolerances.maxEdgeDensityDelta * 100).toFixed(2)})`,
    )
  }
  const edgeContrastDrop = expected.meanEdgeContrast - actual.meanEdgeContrast
  if (edgeContrastDrop > tolerances.maxEdgeContrastDrop) {
    violations.push(
      `mean edge contrast dropped by ${(edgeContrastDrop * 100).toFixed(2)} points ` +
        `(allowed ${(tolerances.maxEdgeContrastDrop * 100).toFixed(2)})`,
    )
  }
  const isolatedIncrease = actual.isolatedPixelRatio - expected.isolatedPixelRatio
  if (isolatedIncrease > tolerances.maxIsolatedPixelIncrease) {
    violations.push(
      `isolated-pixel ratio increased by ${(isolatedIncrease * 100).toFixed(2)} points ` +
        `(allowed ${(tolerances.maxIsolatedPixelIncrease * 100).toFixed(2)})`,
    )
  }
  return { violations, warnings }
}

export async function checkQualityBaseline(baselinePath: string): Promise<QualityRegressionReport> {
  const absolute = path.resolve(baselinePath)
  const baseline = await readQualityBaseline(absolute)
  const root = path.dirname(absolute)
  const cases: QualityRegressionCaseResult[] = []

  for (const entry of baseline.cases) {
    const file = path.resolve(root, entry.file)
    let actual: ImageQualityMetrics | null = null
    const violations: string[] = []
    const warnings: string[] = []
    try {
      actual = await measureImageQuality(file)
      const regression = regressionViolations(entry.expected, actual, entry.tolerances)
      violations.push(...regression.violations)
      warnings.push(...regression.warnings)
    } catch (error) {
      violations.push(message(error))
    }

    if (entry.record) {
      const recordPath = path.resolve(root, entry.record.path)
      try {
        const recordHash = await sha256File(recordPath)
        if (recordHash !== entry.record.sha256) violations.push("quality record hash changed")
        await verifyRecordForImage(recordPath, file)
      } catch (error) {
        violations.push(message(error))
      }
    }

    cases.push({
      id: entry.id,
      file,
      status: violations.length ? "fail" : "pass",
      hashChanged: actual !== null && actual.sha256 !== entry.expected.sha256,
      expected: entry.expected,
      actual,
      violations,
      warnings,
    })
  }

  const failed = cases.filter((entry) => entry.status === "fail").length
  return {
    version: 1,
    safe: failed === 0,
    baseline: absolute,
    summary: {
      total: cases.length,
      passed: cases.length - failed,
      failed,
      changed: cases.filter((entry) => entry.hashChanged).length,
    },
    cases,
  }
}
