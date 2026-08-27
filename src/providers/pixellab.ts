import { mkdirSync, existsSync, readFileSync, writeFileSync } from "node:fs"
import { randomUUID } from "node:crypto"
import os from "node:os"
import path from "node:path"
import { PixelLabClient, PixelLabError, clientFromEnv } from "../client.ts"
import { paletteSwatch } from "../png.ts"
import {
  candidateCount,
  generationCost,
  type Generator,
  type ResolvedSpec,
  type ResolvedStyleImage,
} from "../types.ts"
import type { BalanceInfo, CostEstimate, JobState, PollContext, Provider, RateLimit, RemoteAsset } from "../provider.ts"

/**
 * PixelLab, the reference implementation.
 *
 * All PixelLab-specific knowledge lives here: the three generators and their
 * very different pricing, the review/candidate flow, the fact that a map
 * object's job record expires while its image does not, and that pixflux
 * returns bytes inline instead of a job id.
 */
export class PixelLabProvider implements Provider {
  readonly id = "pixellab"

  constructor(private readonly client: PixelLabClient) {}

  static fromEnv(): PixelLabProvider {
    return new PixelLabProvider(clientFromEnv())
  }

  /** Public storage URLs and the local content cache do not require API auth. */
  static forDownloads(): PixelLabProvider {
    return PixelLabProvider.forOffline()
  }

  /** Capability and cost estimation only; makes no network request itself. */
  static forOffline(): PixelLabProvider {
    return new PixelLabProvider(new PixelLabClient("download-only"))
  }

  supports(generator: Generator): boolean {
    return (
      generator === "1dir" ||
      generator === "map" ||
      generator === "pixflux" ||
      generator === "tiles"
    )
  }

  /** PixelLab's own constraints: submissions must be >2s apart, and
   *  background jobs in flight are capped by subscription tier (Tier 1=8,
   *  Tier 2=10, Tier 3=20) — 8 is the safe floor across every tier. */
  rateLimit(): RateLimit {
    return { spacingMs: 2500, maxInFlight: 8 }
  }

  /**
   * Where synchronous pixflux results are parked between `submit` and `fetch`.
   *
   * pixflux returns the PNG inline rather than a job id, but the pipeline is
   * built around submit → poll → fetch running as separate commands. Writing
   * the bytes to a known path keeps that model intact: the "job id" is the
   * filename, polling is an existence check, and downloading is a file read.
   */
  private static cacheDir(): string {
    const dir = path.join(os.tmpdir(), "pixelkiln-pixflux")
    mkdirSync(dir, { recursive: true })
    return dir
  }

  estimate(spec: ResolvedSpec): CostEstimate {
    // `tiles` prices and counts off the whole set, both of which the manifest
    // layer already worked out — see tilesCost / tileVariationCount.
    if (spec.generator === "tiles") {
      return { unit: "generations", amount: spec.cost, candidates: spec.candidates }
    }
    return {
      unit: "generations",
      amount: generationCost(spec.width, spec.height, spec.generator),
      candidates: spec.generator === "1dir" ? candidateCount(spec.size) : 1,
    }
  }

  async submit(spec: ResolvedSpec, styleImages: ResolvedStyleImage[]): Promise<{ jobId: string }> {
    if (spec.generator === "pixflux") {
      const swatch = spec.palette.length
        ? paletteSwatch(spec.palette).toString("base64")
        : undefined
      const { png } = await this.client.createImagePixflux({
        description: spec.prompt,
        width: spec.width,
        height: spec.height,
        noBackground: spec.noBackground,
        paletteSwatchBase64: swatch,
        seed: spec.seed,
      })
      const jobId = randomUUID()
      writeFileSync(path.join(PixelLabProvider.cacheDir(), `${jobId}.png`), png)
      return { jobId }
    }

    if (spec.generator === "tiles") {
      const res = await this.client.createTilesPro({
        description: spec.prompt,
        tileSize: spec.tileSize,
        tileType: spec.tileType,
        tileView: spec.tileView,
        tileFeature: spec.tileFeature,
        outlineMode: spec.outlineMode,
        seed: spec.seed,
        // TilesProStyleImage is flat and wants the reference's real dimensions,
        // unlike 1dir's {type, base64, format} payload.
        styleImages: styleImages.map(({ base64, width, height }) => ({ base64, width, height })),
      })
      return { jobId: res.tile_id }
    }

    if (spec.generator === "1dir") {
      const res = await this.client.create1Direction({
        description: spec.prompt,
        size: spec.size,
        view: spec.view === "sidescroller" ? "sidescroller" : "top-down",
        styleImages,
      })
      return { jobId: res.object_id }
    }
    const res = await this.client.createMapObject({
      description: spec.prompt,
      width: spec.width,
      height: spec.height,
      view: spec.view,
      outline: spec.outline,
      shading: spec.shading,
      detail: spec.detail,
      seed: spec.seed,
    })
    return { jobId: res.object_id }
  }

  async poll(jobId: string, generator: Generator, context?: PollContext): Promise<JobState> {
    if (generator === "pixflux") {
      const file = path.join(PixelLabProvider.cacheDir(), `${jobId}.png`)
      if (existsSync(file)) {
        const sourceUrl = `file://${file}`
        return { status: "ready", objectId: jobId, sourceUrl, sources: [{ url: sourceUrl }] }
      }
      // The bytes only ever lived here, so a missing file means the temp dir
      // was cleared. Nothing to recover from upstream — say so plainly.
      return {
        status: "failed",
        error: "pixflux result is no longer cached locally; re-run submit for this asset",
      }
    }
    if (generator === "map") return this.pollMap(jobId)
    if (generator === "tiles") return this.pollTiles(jobId, Boolean(context?.tileFeature))

    const obj = await this.client.getObject(jobId)
    if (obj.status === "review") {
      return { status: "review", candidateUrls: obj.frame_urls ?? [] }
    }
    if (obj.status === "completed") {
      const url = firstUrl(obj.rotation_urls) ?? obj.preview_url ?? null
      return { status: "ready", objectId: obj.id, sourceUrl: url, sources: url ? [{ url }] : [] }
    }
    if (obj.status === "failed") return { status: "failed", error: "generation failed upstream" }
    return {
      status: "processing",
      progressPercent: obj.progress_percent ?? null,
      etaSeconds: obj.eta_seconds ?? null,
    }
  }

  /**
   * Map objects need their own path because the `/map-objects/{id}` record is
   * deleted upstream roughly 8 hours after creation while the image survives in
   * the objects collection. Verified: a March 2026 sprite still resolves from
   * `/objects` four months on, with `/map-objects` returning 404 for the same
   * id. So a 404 here is not evidence the work is lost.
   */
  private async pollMap(jobId: string): Promise<JobState> {
    try {
      const obj = await this.client.getMapObject(jobId)
      if (obj.status === "completed" && obj.download_url) {
        return {
          status: "ready",
          objectId: jobId,
          sourceUrl: obj.download_url,
          sources: [{ url: obj.download_url }],
        }
      }
      if (obj.status === "failed") return { status: "failed", error: "generation failed upstream" }
      return { status: "processing" }
    } catch (err) {
      if (!(err instanceof PixelLabError) || err.status !== 404) throw err
      const survivor = await this.client.getObject(jobId).catch(() => null)
      const url = firstUrl(survivor?.rotation_urls) ?? survivor?.preview_url ?? null
      if (survivor?.status === "completed" && url) {
        return { status: "ready", objectId: survivor.id, sourceUrl: url, sources: [{ url }] }
      }
      return {
        status: "failed",
        error: "map object record deleted upstream and no surviving image found",
      }
    }
  }

  /**
   * Tiles report progress through the HTTP status: 423 while drawing, 200 with
   * `storage_urls` once finished. There is no `status` field to read and no
   * progress percentage on offer, so "processing" here carries no ETA.
   */
  private async pollTiles(tileId: string, connectable: boolean): Promise<JobState> {
    try {
      const set = await this.client.getTilesPro(tileId)
      const tiles = tilesInIndexOrder(set.storage_urls)
      if (!tiles.length) return { status: "failed", error: "tiles job returned no storage urls" }
      if (!connectable) return { status: "review", candidateUrls: tiles.map((tile) => tile.url) }
      return {
        status: "ready",
        objectId: tileId,
        sourceUrl: tiles[0]?.url ?? null,
        sources: tiles.map((tile) => ({
          url: tile.url,
          role: `tile-${String(tile.index).padStart(2, "0")}`,
        })),
        metadata: {
          tileKind: set.kind,
          ...(set.tile_rules ? { tileRules: set.tile_rules } : {}),
        },
      }
    } catch (err) {
      if (err instanceof PixelLabError && err.status === 423) return { status: "processing" }
      throw err
    }
  }

  async selectCandidate(
    jobId: string,
    index: number,
    commonTag?: string,
    generator?: Generator,
  ): Promise<{ objectId: string; sourceUrl: string | null }> {
    // A tiles variation is already a finished image at a stable URL — there is
    // no frame to promote and no new account object to create. The identity we
    // record is the job plus the index, which is what actually reproduces it.
    if (generator === "tiles") {
      const set = await this.client.getTilesPro(jobId)
      const url = tilesInIndexOrder(set.storage_urls)[index]?.url
      if (!url) throw new Error(`tiles job ${jobId} has no variation at index ${index}`)
      return { objectId: `${jobId}#${index}`, sourceUrl: url }
    }
    const promoted = await this.client.selectFrames(jobId, [index], commonTag)
    const objectId = promoted.created_object_ids?.[0]
    if (!objectId) {
      // The review parent is transient; recording its id would leave a mapping
      // that breaks once the parent is emptied. Fail loudly instead.
      throw new Error(`select-frames returned no created_object_ids for job ${jobId}`)
    }
    const obj = await this.client.getObject(objectId).catch(() => null)
    return { objectId, sourceUrl: firstUrl(obj?.rotation_urls) ?? obj?.preview_url ?? null }
  }

  async download(url: string): Promise<Buffer> {
    if (url.startsWith("file://")) return readFileSync(url.slice("file://".length))
    return this.client.download(url)
  }

  async balance(): Promise<BalanceInfo> {
    const b = await this.client.balance()
    return { unit: "generations", remaining: b.generations, total: b.total, plan: b.plan }
  }

  async setTags(objectId: string, tags: string[]): Promise<void> {
    await this.client.setTags(objectId, tags.slice(0, 20))
  }

  async *list(): AsyncGenerator<RemoteAsset> {
    for await (const obj of this.client.iterateObjects(100)) {
      yield {
        id: obj.id,
        prompt: obj.prompt ?? "",
        width: obj.size.width,
        height: obj.size.height,
        createdAt: obj.created_at,
        previewUrl: obj.preview_url ?? null,
        tags: obj.tags ?? [],
        status: obj.status ?? "unknown",
      }
    }
  }

  async delete(assetId: string): Promise<void> {
    await this.client.deleteObject(assetId)
  }
}

/**
 * `storage_urls` is an object keyed `tile_0`, `tile_1`, ... — JSON object order
 * is not something to rely on, and a connectable set is sliced by index, so
 * sort numerically rather than taking Object.values() as it comes.
 */
function tilesInIndexOrder(urls: Record<string, string>): Array<{ index: number; url: string }> {
  return Object.entries(urls)
    .map(([key, url]) => ({ index: Number(key.replace(/^tile_/, "")), url }))
    .filter((tile) => Number.isFinite(tile.index))
    .sort((a, b) => a.index - b.index)
}

function firstUrl(urls: Record<string, string | null> | null | undefined): string | null {
  if (!urls) return null
  return Object.values(urls).find((u): u is string => typeof u === "string") ?? null
}
