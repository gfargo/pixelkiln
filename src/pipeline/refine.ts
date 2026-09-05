import path from "node:path"
import { execFile } from "node:child_process"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { promisify } from "node:util"
import {
  readArtifactBundleManifest,
  verifyArtifactBundle,
  writeManagedArtifactBundle,
  type ArtifactBundleManifest,
  type ArtifactSource,
} from "../artifacts.ts"
import { sha256File } from "../hash.ts"
import {
  decodePng,
  encodeRgbaPng,
  parseHex,
  transparencyRatio,
  type DecodedPng,
} from "../png.ts"
import type { GridConfidence } from "../types.ts"
import { colorDistance } from "./audit.ts"

const execFileAsync = promisify(execFile)

export const PIXEL_ART_FIXER_URL = "https://github.com/Retro-Diffusion/pixel-art-fixer"
export const PIXEL_ART_FIXER_REVISION = "ef376e57e1c272633ca2dbf5f29ec3fcf6596465"

export interface PixelArtFixerDetection {
  stepX: number
  stepY: number
  columns: number
  rows: number
  consensus: string
  confidence: GridConfidence
}

export interface RefineAudit {
  width: number
  height: number
  colorCount: number
  paletteConformant: boolean
  transparency: number
  thresholds: {
    maxColors: number
    minTransparency: number | null
    minGridConfidence: GridConfidence
  }
  safe: boolean
  reasons: string[]
}

export interface PendingQualityReview {
  status: "pending"
}

export interface ApprovedQualityReview {
  status: "approved"
  reviewer: string
  approvedAt: string
  checklist: {
    nativeScale: true
    crispEdges: true
    subjectReadable: true
    paletteSeparation: true
    alphaAndSeams: true
  }
  note?: string
}

export interface RefineRecordOptions {
  schema: "pixelkiln-quality"
  version: 1
  nativeGrid: {
    tool: "pixel-art-fixer"
    url: typeof PIXEL_ART_FIXER_URL
    revision: string
    protocol: "python-api-v1" | "python-cli-v1"
    confidence: GridConfidence
    consensus: string
    stepX: number
    stepY: number
    sourceWidth: number
    sourceHeight: number
    nativeWidth: number
    nativeHeight: number
  }
  palette: {
    colors: string[]
    dither: "none"
    distance: "redmean"
  }
  audit: RefineAudit
  review: PendingQualityReview | ApprovedQualityReview
}

export interface RefineOptions {
  source: string
  output: string
  palette: string[]
  /** Python containing `pixelfixer`. Defaults to the environment override or `python3`. */
  fixerPython?: string
  /** @internal Alternate Pixel Art Fixer console command used by compatibility tests. */
  fixerCommand?: string
  /** @internal Prefix arguments for the alternate console command. */
  fixerArgsPrefix?: string[]
  fixerRevision?: string
  minGridConfidence?: GridConfidence
  minTransparency?: number
  force?: boolean
}

export interface RefineResult {
  source: string
  output: string
  record: string
  detection: PixelArtFixerDetection
  palette: string[]
  audit: RefineAudit
}

export interface QualityCheck {
  safe: boolean
  current: boolean
  approved: boolean
  auditSafe: boolean
  record: string
  source: string
  output: string
  options: RefineRecordOptions
  reasons: string[]
}

export interface ApproveQualityOptions {
  reviewer: string
  note?: string
  /** Deterministic clock hook for callers that need reproducible tests. */
  approvedAt?: Date
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export function qualityRecordPath(output: string): string {
  if (!/\.png$/i.test(output)) throw new Error("Refined output must be a .png file.")
  return output.replace(/\.png$/i, ".pixelkiln.json")
}

function confidenceFor(consensus: string): GridConfidence {
  if (consensus.startsWith("fast:")) return "high"
  if (
    consensus === "arbitrated" ||
    consensus === "forced" ||
    (consensus.startsWith("fastmode:") && consensus.includes("+"))
  ) return "medium"
  return "low"
}

const confidenceRank: Record<GridConfidence, number> = { low: 0, medium: 1, high: 2 }

function requireConfidence(value: string): GridConfidence {
  if (value === "low" || value === "medium" || value === "high") return value
  throw new Error(`Unknown grid confidence "${value}"; expected low, medium, or high.`)
}

function firstJsonObject(text: string): unknown {
  const start = text.indexOf("{")
  if (start < 0) throw new Error("Pixel Art Fixer did not print detection JSON.")
  let depth = 0
  let string = false
  let escaped = false
  for (let i = start; i < text.length; i++) {
    const char = text[i]!
    if (string) {
      if (escaped) escaped = false
      else if (char === "\\") escaped = true
      else if (char === '"') string = false
      continue
    }
    if (char === '"') string = true
    else if (char === "{") depth++
    else if (char === "}" && --depth === 0) {
      try {
        return JSON.parse(text.slice(start, i + 1))
      } catch (error) {
        throw new Error(`Pixel Art Fixer printed invalid detection JSON: ${message(error)}`)
      }
    }
  }
  throw new Error("Pixel Art Fixer printed incomplete detection JSON.")
}

const PYTHON_FIXER_BRIDGE = [
  "import json, sys",
  "from pixelfixer.api import process",
  "result = process(open(sys.argv[1], 'rb').read(), mode='full')",
  "open(sys.argv[2], 'wb').write(result.pop('png'))",
  "print(json.dumps(result))",
].join("; ")

function parseDetection(raw: unknown): PixelArtFixerDetection {
  if (!raw || typeof raw !== "object") throw new Error("Pixel Art Fixer returned no detection result.")
  const value = raw as Record<string, unknown>
  const stepX = Number(value.step_x)
  const stepY = Number(value.step_y)
  const columns = Number(value.cols)
  const rows = Number(value.rows)
  const consensus = value.consensus
  if (
    !Number.isFinite(stepX) || stepX <= 0 ||
    !Number.isFinite(stepY) || stepY <= 0 ||
    !Number.isInteger(columns) || columns < 1 ||
    !Number.isInteger(rows) || rows < 1 ||
    typeof consensus !== "string" || !consensus
  ) {
    throw new Error("Pixel Art Fixer returned an invalid grid detection result.")
  }
  return {
    stepX,
    stepY,
    columns,
    rows,
    consensus,
    confidence: confidenceFor(consensus),
  }
}

function normalizePalette(values: string[]): Array<{ hex: string; r: number; g: number; b: number }> {
  const colors = new Map<string, { hex: string; r: number; g: number; b: number }>()
  for (const value of values) {
    const rgb = parseHex(value)
    const hex = `#${rgb.r.toString(16).padStart(2, "0")}${rgb.g.toString(16).padStart(2, "0")}${rgb.b.toString(16).padStart(2, "0")}`
    colors.set(hex, { hex, ...rgb })
  }
  if (colors.size < 2 || colors.size > 256) {
    throw new Error(`A refinement palette must contain 2–256 unique colors; got ${colors.size}.`)
  }
  return [...colors.values()]
}

/** Canonical lowercase palette identity shared by manifest quality profiles. */
export function normalizeRefinementPalette(values: string[]): string[] {
  return normalizePalette(values).map((color) => color.hex)
}

/** Map every visible pixel to the nearest explicit color, without dithering. */
export function quantizeToPalette(png: DecodedPng, palette: string[]): DecodedPng {
  const colors = normalizePalette(palette)
  const pixels = Buffer.from(png.pixels)
  for (let i = 0; i < pixels.length; i += 4) {
    const alpha = pixels[i + 3]!
    if (alpha === 0) {
      pixels[i] = 0
      pixels[i + 1] = 0
      pixels[i + 2] = 0
      continue
    }
    const pixel = { r: pixels[i]!, g: pixels[i + 1]!, b: pixels[i + 2]! }
    let nearest = colors[0]!
    let distance = colorDistance(pixel, nearest)
    for (let j = 1; j < colors.length; j++) {
      const candidate = colors[j]!
      const candidateDistance = colorDistance(pixel, candidate)
      if (candidateDistance < distance) {
        nearest = candidate
        distance = candidateDistance
      }
    }
    pixels[i] = nearest.r
    pixels[i + 1] = nearest.g
    pixels[i + 2] = nearest.b
  }
  return { width: png.width, height: png.height, pixels }
}

function colorCount(png: DecodedPng): number {
  const colors = new Set<number>()
  for (let i = 0; i < png.pixels.length; i += 4) {
    if (png.pixels[i + 3]! < 128) continue
    colors.add((png.pixels[i]! << 16) | (png.pixels[i + 1]! << 8) | png.pixels[i + 2]!)
  }
  return colors.size
}

function unexpectedPaletteColors(png: DecodedPng, palette: string[]): number {
  const allowed = new Set(palette.map((hex) => {
    const color = parseHex(hex)
    return (color.r << 16) | (color.g << 8) | color.b
  }))
  const unexpected = new Set<number>()
  for (let i = 0; i < png.pixels.length; i += 4) {
    if (png.pixels[i + 3] === 0) continue
    const color = (png.pixels[i]! << 16) | (png.pixels[i + 1]! << 8) | png.pixels[i + 2]!
    if (!allowed.has(color)) unexpected.add(color)
  }
  return unexpected.size
}

function auditRefinement(
  png: DecodedPng,
  detection: PixelArtFixerDetection,
  palette: string[],
  minTransparency: number | undefined,
  minGridConfidence: GridConfidence,
): RefineAudit {
  const colors = colorCount(png)
  const unexpectedColors = unexpectedPaletteColors(png, palette)
  const transparency = transparencyRatio(png)
  const reasons: string[] = []
  if (png.width !== detection.columns || png.height !== detection.rows) {
    reasons.push(
      `native output is ${png.width}x${png.height}, expected detected grid ` +
        `${detection.columns}x${detection.rows}`,
    )
  }
  if (colors > palette.length) reasons.push(`opaque color count ${colors} exceeds ${palette.length}`)
  if (unexpectedColors) reasons.push(`${unexpectedColors} visible color(s) are outside the final palette`)
  if (minTransparency !== undefined && transparency < minTransparency) {
    reasons.push(
      `transparency ${(transparency * 100).toFixed(1)}% is below ` +
        `${(minTransparency * 100).toFixed(1)}%`,
    )
  }
  if (confidenceRank[detection.confidence] < confidenceRank[minGridConfidence]) {
    reasons.push(
      `grid confidence ${detection.confidence} is below required ${minGridConfidence} ` +
        `(${detection.consensus})`,
    )
  }
  return {
    width: png.width,
    height: png.height,
    colorCount: colors,
    paletteConformant: unexpectedColors === 0,
    transparency,
    thresholds: {
      maxColors: palette.length,
      minTransparency: minTransparency ?? null,
      minGridConfidence,
    },
    safe: reasons.length === 0,
    reasons,
  }
}

function isGridConfidence(value: unknown): value is GridConfidence {
  return value === "low" || value === "medium" || value === "high"
}

function parseRecordOptions(manifest: ArtifactBundleManifest, record: string): RefineRecordOptions {
  if (manifest.kind !== "refine") throw new Error(`${record} is not a PixelKiln refinement record.`)
  const raw = manifest.options
  if (!raw || typeof raw !== "object") throw new Error(`${record} has invalid quality metadata.`)
  const options = raw as Partial<RefineRecordOptions>
  const grid = options.nativeGrid
  const palette = options.palette
  const audit = options.audit
  const review = options.review
  if (
    options.schema !== "pixelkiln-quality" || options.version !== 1 ||
    !grid || grid.tool !== "pixel-art-fixer" || grid.url !== PIXEL_ART_FIXER_URL ||
    typeof grid.revision !== "string" || !grid.revision ||
    (grid.protocol !== "python-api-v1" && grid.protocol !== "python-cli-v1") ||
    !isGridConfidence(grid.confidence) || typeof grid.consensus !== "string" ||
    !Number.isFinite(grid.stepX) || !Number.isFinite(grid.stepY) ||
    !Number.isInteger(grid.sourceWidth) || !Number.isInteger(grid.sourceHeight) ||
    !Number.isInteger(grid.nativeWidth) || !Number.isInteger(grid.nativeHeight) ||
    !palette || !Array.isArray(palette.colors) || palette.colors.length < 2 ||
    !palette.colors.every((color) => typeof color === "string") ||
    palette.dither !== "none" || palette.distance !== "redmean" ||
    !audit || typeof audit.safe !== "boolean" ||
    typeof audit.paletteConformant !== "boolean" || !Array.isArray(audit.reasons) ||
    !review || (review.status !== "pending" && review.status !== "approved")
  ) {
    throw new Error(`${record} has invalid quality metadata.`)
  }
  return options as RefineRecordOptions
}

/** Recover an image's native grid, enforce its final palette, and write an auditable bundle. */
export async function refineAsset(options: RefineOptions): Promise<RefineResult> {
  const source = path.resolve(options.source)
  const output = path.resolve(options.output)
  if (source === output) throw new Error("Refinement source and output must be different files.")
  const record = path.resolve(qualityRecordPath(output))
  const palette = normalizePalette(options.palette).map((color) => color.hex)
  const minGridConfidence = requireConfidence(options.minGridConfidence ?? "high")
  if (
    options.minTransparency !== undefined &&
    (!Number.isFinite(options.minTransparency) || options.minTransparency < 0 || options.minTransparency > 1)
  ) throw new Error("minTransparency must be between 0 and 1.")

  let sourcePng: DecodedPng
  try {
    sourcePng = decodePng(await readFile(source))
  } catch (error) {
    throw new Error(`Cannot read refinement source ${source}: ${message(error)}`, { cause: error })
  }

  const temp = await mkdtemp(path.join(tmpdir(), "pixelkiln-refine-"))
  const recovered = path.join(temp, "native.png")
  const compatibilityCommand = options.fixerCommand
  const fixerCommand = compatibilityCommand ?? options.fixerPython ??
    process.env.PIXELKILN_PIXEL_FIXER_PYTHON ?? "python3"
  const args = compatibilityCommand
    ? [...(options.fixerArgsPrefix ?? []), source, "--extract", recovered]
    : ["-c", PYTHON_FIXER_BRIDGE, source, recovered]
  try {
    let stdout: string
    try {
      const result = await execFileAsync(fixerCommand, args, {
        encoding: "utf8",
        maxBuffer: 4 * 1024 * 1024,
        timeout: 10 * 60 * 1000,
      })
      stdout = result.stdout
    } catch (error) {
      const code = typeof error === "object" && error !== null && "code" in error
        ? String(error.code)
        : ""
      const install =
        `Install the pinned Python package from ${PIXEL_ART_FIXER_URL} at ` +
        `${options.fixerRevision ?? PIXEL_ART_FIXER_REVISION}, or pass --fixer-python.`
      throw new Error(
        code === "ENOENT"
          ? `Pixel Art Fixer command not found: ${fixerCommand}. ${install}`
          : `Pixel Art Fixer failed: ${message(error)}. ${install}`,
        { cause: error },
      )
    }
    const detection = parseDetection(firstJsonObject(stdout))
    const native = decodePng(await readFile(recovered))
    const quantized = quantizeToPalette(native, palette)
    const png = encodeRgbaPng(quantized.width, quantized.height, quantized.pixels)
    const audit = auditRefinement(
      quantized,
      detection,
      palette,
      options.minTransparency,
      minGridConfidence,
    )
    if (!audit.safe) {
      throw new Error(`Refinement failed its quality audit: ${audit.reasons.join("; ")}`)
    }

    const provenanceSource: ArtifactSource = {
      id: "source",
      path: source,
      sha256: await sha256File(source),
      included: true,
    }
    const recordOptions: RefineRecordOptions = {
      schema: "pixelkiln-quality",
      version: 1,
      nativeGrid: {
        tool: "pixel-art-fixer",
        url: PIXEL_ART_FIXER_URL,
        revision: options.fixerRevision ?? PIXEL_ART_FIXER_REVISION,
        protocol: compatibilityCommand ? "python-cli-v1" : "python-api-v1",
        confidence: detection.confidence,
        consensus: detection.consensus,
        stepX: detection.stepX,
        stepY: detection.stepY,
        sourceWidth: sourcePng.width,
        sourceHeight: sourcePng.height,
        nativeWidth: quantized.width,
        nativeHeight: quantized.height,
      },
      palette: { colors: palette, dither: "none", distance: "redmean" },
      audit,
      review: { status: "pending" },
    }
    await writeManagedArtifactBundle(
      record,
      [{ path: output, data: png }],
      { kind: "refine", sources: [provenanceSource], options: recordOptions },
      { force: options.force },
    )
    return { source, output, record, detection, palette, audit }
  } finally {
    await rm(temp, { recursive: true, force: true })
  }
}

/** Verify bytes, policy, audit, and human approval without rebuilding the image. */
export async function checkQualityRecord(recordPath: string): Promise<QualityCheck> {
  const record = path.resolve(recordPath)
  const manifest = await readArtifactBundleManifest(record)
  const options = parseRecordOptions(manifest, record)
  const verification = await verifyArtifactBundle(record)
  const source = manifest.sources.length === 1
    ? path.resolve(path.dirname(record), manifest.sources[0]!.path)
    : ""
  const output = manifest.outputs.length === 1
    ? path.resolve(path.dirname(record), manifest.outputs[0]!.path)
    : ""
  const reasons: string[] = []
  if (!verification.fingerprintValid) reasons.push("quality record fingerprint changed")
  for (const source of verification.changedSources) reasons.push(`source changed: ${source}`)
  for (const changed of verification.changedOutputs) reasons.push(`output changed: ${changed}`)
  if (manifest.sources.length !== 1) reasons.push("quality record must contain exactly one source")
  if (manifest.outputs.length !== 1) reasons.push("quality record must contain exactly one output")
  if (!options.audit.safe) reasons.push(...options.audit.reasons.map((reason) => `audit: ${reason}`))
  if (options.review.status !== "approved") reasons.push("human 1× review is pending")
  return {
    safe: reasons.length === 0,
    current: verification.current,
    approved: options.review.status === "approved",
    auditSafe: options.audit.safe,
    record,
    source,
    output,
    options,
    reasons,
  }
}

/** Attach a human 1× review to an unchanged, audit-safe refinement bundle. */
export async function approveQualityRecord(
  recordPath: string,
  approval: ApproveQualityOptions,
): Promise<QualityCheck> {
  const reviewer = approval.reviewer.trim()
  if (!reviewer) throw new Error("A human reviewer name is required.")
  const record = path.resolve(recordPath)
  const manifest = await readArtifactBundleManifest(record)
  const options = parseRecordOptions(manifest, record)
  const verification = await verifyArtifactBundle(record)
  if (!verification.current) {
    const changes = [
      ...verification.changedSources.map((source) => `source ${source}`),
      ...verification.changedOutputs.map((output) => `output ${output}`),
      ...(!verification.fingerprintValid ? ["quality metadata"] : []),
    ]
    throw new Error(`Cannot approve a stale refinement; changed: ${changes.join(", ")}. Run refine again.`)
  }
  if (!options.audit.safe) {
    throw new Error(`Cannot approve a failed quality audit: ${options.audit.reasons.join("; ")}`)
  }
  if (manifest.sources.length !== 1 || manifest.outputs.length !== 1) {
    throw new Error("A refinement record must contain exactly one source and one output.")
  }

  const root = path.dirname(record)
  const outputPath = path.resolve(root, manifest.outputs[0]!.path)
  const output = await readFile(outputPath)
  const sources: ArtifactSource[] = manifest.sources.map((source) => ({
    ...source,
    path: path.resolve(root, source.path),
  }))
  const approved: RefineRecordOptions = {
    ...options,
    review: {
      status: "approved",
      reviewer,
      approvedAt: (approval.approvedAt ?? new Date()).toISOString(),
      checklist: {
        nativeScale: true,
        crispEdges: true,
        subjectReadable: true,
        paletteSeparation: true,
        alphaAndSeams: true,
      },
      ...(approval.note?.trim() ? { note: approval.note.trim() } : {}),
    },
  }
  await writeManagedArtifactBundle(
    record,
    [{ path: outputPath, data: output }],
    { kind: "refine", sources, options: approved },
  )
  return checkQualityRecord(record)
}
