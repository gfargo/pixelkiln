/**
 * PixelLab utilities that work on loose files rather than manifest assets.
 *
 * `unzoom` exists for art that comes from outside the pipeline — a reference
 * pulled from the web, a sprite someone posted at 16x — before it is used as
 * a `styleImages` or `reference` path. `pixelate` is its counterpart for art
 * that was never pixel art at all: a photo, a painting, a 3-D render. A font is not art a manifest asset
 * tracks at all: it has no style suffix, no prompt-per-asset, no candidates,
 * and its main output is a `.ttf`, not a PNG. Both therefore write plain
 * files and leave the lockfile alone.
 */
import { existsSync } from "node:fs"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import path from "node:path"
import type { PixelLabClient } from "./client.ts"
import { imageMetadata } from "./media.ts"

/** PixelLab's own limits for `/unzoom`: grid detection needs at least 256x256, and the area is capped at 2048x2048. */
export const UNZOOM_MIN_SIDE = 256
export const UNZOOM_MAX_AREA = 2048 * 2048

export interface UnzoomFileResult {
  out: string
  original: { width: number; height: number }
  unzoomed: { width: number; height: number }
  zoomFactor: number
  usage: unknown
}

/** Where `unzoom` writes when no `--out` is given: beside the input, never over it. */
export function defaultUnzoomOut(input: string): string {
  const ext = path.extname(input)
  return `${ext ? input.slice(0, -ext.length) : input}.unzoomed.png`
}

/**
 * Recover the native pixel grid of an upscaled image and write it as a PNG.
 * Checks PixelLab's documented size limits locally so an image that cannot
 * work is refused before anything is sent.
 */
export async function unzoomFile(
  client: Pick<PixelLabClient, "unzoom">,
  input: string,
  opts: { out?: string; quantize?: number; force?: boolean } = {},
): Promise<UnzoomFileResult> {
  const out = path.resolve(opts.out ?? defaultUnzoomOut(input))
  if (path.resolve(input) === out) throw new Error("unzoom will not overwrite its own input; pass a different --out")
  if (existsSync(out) && !opts.force) throw new Error(`${out} already exists; pass --force to replace it`)
  const bytes = await readFile(input)
  const metadata = imageMetadata(bytes)
  if (!metadata) throw new Error(`${input} is not a readable PNG or JPEG`)
  const { width, height, format } = metadata
  if (width < UNZOOM_MIN_SIDE || height < UNZOOM_MIN_SIDE) {
    throw new Error(
      `${input} is ${width}x${height}; PixelLab's unzoom needs at least ${UNZOOM_MIN_SIDE}x${UNZOOM_MIN_SIDE} ` +
        "to find the pixel grid, so this is probably already at its native size",
    )
  }
  if (width * height > UNZOOM_MAX_AREA) {
    throw new Error(`${input} is ${width}x${height}; PixelLab's unzoom takes at most 2048x2048 worth of pixels`)
  }
  const res = await client.unzoom({ image: { base64: bytes.toString("base64"), format }, quantize: opts.quantize })
  await mkdir(path.dirname(out), { recursive: true })
  await writeFile(out, res.png)
  return { out, original: res.originalSize, unzoomed: res.unzoomedSize, zoomFactor: res.zoomFactor, usage: res.usage }
}

export const FONT_WEIGHTS = ["Bold", "Regular"] as const
export type FontWeight = (typeof FONT_WEIGHTS)[number]
export const FONT_GLYPH_SIZES = [8, 16, 32, 64] as const
export type FontGlyphSize = (typeof FONT_GLYPH_SIZES)[number]
/**
 * Documented price of one `/generate-font-pro` call, on a subscription: 15
 * since PixelLab's October 2026 Pro cut (25 before). Not yet confirmed
 * against a live bill.
 */
export const FONT_COST_GENERATIONS = 15

export interface GenerateFontOptions {
  description: string
  weight: FontWeight
  glyphPx?: FontGlyphSize
  seed?: number
  fontName?: string
  /** Output base: `<out>.ttf` and `<out>.png` are written. A `.ttf` or `.png` extension is dropped first. */
  out: string
  force?: boolean
  /** Poll interval and ceiling. PixelLab documents 30-80 s for a font. */
  intervalMs?: number
  timeoutMs?: number
  onProgress?: (status: string) => void
  sleep?: (ms: number) => Promise<void>
}

export interface GenerateFontResult {
  jobId: string
  ttf: string
  atlas: string
  glyphPx: number | null
  usage: unknown
}

/** `<out>.ttf` and `<out>.png`, with a trailing `.ttf`/`.png` on `out` treated as the base's own. */
export function fontOutputPaths(out: string): { ttf: string; atlas: string } {
  const base = path.resolve(out.replace(/\.(ttf|png)$/i, ""))
  return { ttf: `${base}.ttf`, atlas: `${base}.png` }
}

/**
 * Generate a pixel font, wait for it, and download both halves: the `.ttf`
 * and the glyph atlas PNG. Both download URLs are no-auth, like every other
 * PixelLab storage URL, so they go through the client's own size-limited
 * `download`.
 */
export async function generateFont(
  client: Pick<PixelLabClient, "generateFontPro" | "getFontJob" | "download">,
  opts: GenerateFontOptions,
): Promise<GenerateFontResult> {
  const { ttf, atlas } = fontOutputPaths(opts.out)
  if (!opts.force) {
    for (const file of [ttf, atlas]) {
      if (existsSync(file)) throw new Error(`${file} already exists; pass --force to replace it`)
    }
  }
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)))
  const interval = opts.intervalMs ?? 5000
  const timeout = opts.timeoutMs ?? 10 * 60_000
  const submitted = await client.generateFontPro({
    description: opts.description,
    weight: opts.weight,
    glyphPx: opts.glyphPx,
    seed: opts.seed,
    fontName: opts.fontName,
  })
  const jobId = submitted.background_job_id
  const started = Date.now()
  for (;;) {
    const job = await client.getFontJob(jobId)
    opts.onProgress?.(job.status)
    if (job.status === "failed") throw new Error(`PixelLab font job ${jobId} failed upstream`)
    if (job.status === "completed") {
      if (!job.download_ttf_url || !job.download_atlas_url) {
        throw new Error(`PixelLab font job ${jobId} completed without both download URLs`)
      }
      const [ttfBytes, atlasBytes] = await Promise.all([
        client.download(job.download_ttf_url),
        client.download(job.download_atlas_url),
      ])
      await mkdir(path.dirname(ttf), { recursive: true })
      await writeFile(ttf, ttfBytes)
      await writeFile(atlas, atlasBytes)
      return { jobId, ttf, atlas, glyphPx: job.glyph_px ?? null, usage: job.usage }
    }
    if (Date.now() - started > timeout) {
      throw new Error(
        `PixelLab font job ${jobId} is still ${job.status} after ${Math.round(timeout / 1000)} s; ` +
          "it keeps running upstream, but this command has stopped waiting",
      )
    }
    await sleep(interval)
  }
}

/** `/image-to-pixelart-pro-flash`'s flat price, billed exactly this live in October 2026. */
export const PIXELATE_COST_GENERATIONS = 6
/** Sources longer than this on either side are scaled down by PixelLab before conversion; they are not refused. */
export const PIXELATE_MAX_SIDE = 2048

export interface PixelateOptions {
  /** Defaults to `<input>.pixel.png` beside the input. */
  out?: string
  /** Optional style steer, e.g. "retro vibes with light dithering". */
  description?: string
  seed?: number
  force?: boolean
  /** Poll interval and ceiling. Conversions measured at about 30 s. */
  intervalMs?: number
  timeoutMs?: number
  onProgress?: (status: string) => void
  sleep?: (ms: number) => Promise<void>
}

export interface PixelateResult {
  jobId: string
  out: string
  original: { width: number; height: number }
  pixelated: { width: number; height: number }
  /** PixelLab's gallery id for the result, reusable as a Pro Flash `source_image_id`. */
  imageId: string
  usage: unknown
}

/** Where `pixelate` writes when no `--out` is given: beside the input, never over it. */
export function defaultPixelateOut(input: string): string {
  const ext = path.extname(input)
  return `${ext ? input.slice(0, -ext.length) : input}.pixel.png`
}

/**
 * Convert a photo, painting, or render into pixel art with PixelLab's Image
 * to Pixel Art Pro Flash, wait for it, and write the PNG. PixelLab picks the
 * output size itself from the source's detected pixel scale, so there is no
 * size option; the result keeps a transparent background where the model
 * finds one. For art that is already pixel art and merely upscaled, use
 * `unzoomFile` instead: it recovers the grid rather than redrawing.
 */
export async function pixelateFile(
  client: Pick<PixelLabClient, "imageToPixelartProFlash" | "getBackgroundJob">,
  input: string,
  opts: PixelateOptions = {},
): Promise<PixelateResult> {
  const out = path.resolve(opts.out ?? defaultPixelateOut(input))
  if (path.resolve(input) === out) throw new Error("pixelate will not overwrite its own input; pass a different --out")
  if (existsSync(out) && !opts.force) throw new Error(`${out} already exists; pass --force to replace it`)
  const bytes = await readFile(input)
  const metadata = imageMetadata(bytes)
  if (!metadata) throw new Error(`${input} is not a readable PNG or JPEG`)
  const { width, height, format } = metadata
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)))
  const interval = opts.intervalMs ?? 5000
  const timeout = opts.timeoutMs ?? 10 * 60_000
  const submitted = await client.imageToPixelartProFlash({
    image: { base64: bytes.toString("base64"), format },
    description: opts.description,
    seed: opts.seed,
  })
  const jobId = submitted.background_job_id
  const started = Date.now()
  for (;;) {
    const job = await client.getBackgroundJob(jobId)
    opts.onProgress?.(job.status)
    if (job.status === "failed") throw new Error(`PixelLab pixelate job ${jobId} failed upstream`)
    if (job.status === "completed") {
      const images = job.last_response?.images
      const first = Array.isArray(images) ? (images[0] as { base64?: unknown; width?: unknown; height?: unknown } | undefined) : undefined
      if (!first || typeof first.base64 !== "string" || !first.base64) {
        throw new Error(`PixelLab pixelate job ${jobId} completed without an image at last_response.images[0]`)
      }
      const png = Buffer.from(first.base64, "base64")
      const size = imageMetadata(png)
      await mkdir(path.dirname(out), { recursive: true })
      await writeFile(out, png)
      return {
        jobId,
        out,
        original: { width, height },
        pixelated: { width: size?.width ?? Number(first.width), height: size?.height ?? Number(first.height) },
        imageId: submitted.image_id,
        usage: job.usage ?? null,
      }
    }
    if (Date.now() - started > timeout) {
      throw new Error(
        `PixelLab pixelate job ${jobId} is still ${job.status} after ${Math.round(timeout / 1000)} s; ` +
          "it keeps running upstream, but this command has stopped waiting",
      )
    }
    await sleep(interval)
  }
}
