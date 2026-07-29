import { PixelLabClient, PixelLabError, clientFromEnv } from "../client.ts"
import { candidateCount, generationCost, type Generator, type ResolvedSpec } from "../types.ts"
import type { BalanceInfo, CostEstimate, JobState, Provider, RemoteAsset } from "../provider.ts"

/**
 * PixelLab, the reference implementation.
 *
 * All PixelLab-specific knowledge lives here: the two generators and their
 * different pricing, the review/candidate flow, and the fact that a map
 * object's job record expires while its image does not.
 */
export class PixelLabProvider implements Provider {
  readonly id = "pixellab"

  constructor(private readonly client: PixelLabClient) {}

  static fromEnv(): PixelLabProvider {
    return new PixelLabProvider(clientFromEnv())
  }

  supports(generator: Generator): boolean {
    return generator === "1dir" || generator === "map"
  }

  estimate(spec: ResolvedSpec): CostEstimate {
    return {
      unit: "generations",
      amount: generationCost(spec.width, spec.height, spec.generator),
      candidates: spec.generator === "1dir" ? candidateCount(spec.size) : 1,
    }
  }

  async submit(spec: ResolvedSpec, styleImagesBase64: string[]): Promise<{ jobId: string }> {
    if (spec.generator === "1dir") {
      const res = await this.client.create1Direction({
        description: spec.prompt,
        size: spec.size,
        view: spec.view === "sidescroller" ? "sidescroller" : "top-down",
        styleImagesBase64,
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

  async poll(jobId: string, generator: Generator): Promise<JobState> {
    if (generator === "map") return this.pollMap(jobId)

    const obj = await this.client.getObject(jobId)
    if (obj.status === "review") {
      return { status: "review", candidateUrls: obj.frame_urls ?? [] }
    }
    if (obj.status === "completed") {
      return { status: "ready", objectId: obj.id, sourceUrl: firstUrl(obj.rotation_urls) ?? obj.preview_url ?? null }
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
        return { status: "ready", objectId: jobId, sourceUrl: obj.download_url }
      }
      if (obj.status === "failed") return { status: "failed", error: "generation failed upstream" }
      return { status: "processing" }
    } catch (err) {
      if (!(err instanceof PixelLabError) || err.status !== 404) throw err
      const survivor = await this.client.getObject(jobId).catch(() => null)
      const url = firstUrl(survivor?.rotation_urls) ?? survivor?.preview_url ?? null
      if (survivor?.status === "completed" && url) {
        return { status: "ready", objectId: survivor.id, sourceUrl: url }
      }
      return {
        status: "failed",
        error: "map object record deleted upstream and no surviving image found",
      }
    }
  }

  async selectCandidate(
    jobId: string,
    index: number,
    commonTag?: string,
  ): Promise<{ objectId: string; sourceUrl: string | null }> {
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

  download(url: string): Promise<Buffer> {
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

function firstUrl(urls: Record<string, string | null> | null | undefined): string | null {
  if (!urls) return null
  return Object.values(urls).find((u): u is string => typeof u === "string") ?? null
}
