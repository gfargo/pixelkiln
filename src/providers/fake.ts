import { createHash } from "node:crypto"
import type { BalanceInfo, CostEstimate, JobState, OutputSource, Provider, RefreshContext, RemoteAsset, RemoteCharacter, RemoteCharacterDetail } from "../provider.ts"
import { CHARACTER_DIRECTIONS_4, CHARACTER_DIRECTIONS_8, type Generator, type ResolvedSpec, type RevisionMode } from "../types.ts"

/**
 * An in-memory Provider for tests.
 *
 * This exists because the stages that spend money (submit, poll, fetch) were
 * the only ones without coverage, and four of the five real bugs found so far
 * lived in them. A fake at this seam exercises the actual state machine,
 * including the review/candidate path, without a network or an API key.
 *
 * Deliberately configurable in the ways that broke things for real: how many
 * candidates come back, whether a job fails, and whether the queue is observed
 * as still processing before it settles.
 */
export interface FakeOptions {
  /** Candidates per call. >1 routes through review, as PixelLab's 1dir does. */
  candidates?: number
  /** Polls to report `processing` before settling. Exercises the poll loop. */
  processingPolls?: number
  /** Asset ids that should fail instead of completing. */
  failAssets?: Set<string>
  /** Simulate a provider with no listing capability (adopt/salvage unavailable). */
  supportsList?: boolean
  costUnit?: BalanceInfo["unit"]
  startingBalance?: number
}

interface FakeJob {
  jobId: string
  spec: ResolvedSpec
  pollsRemaining: number
  candidates: number
  failed: boolean
  selectedIndex: number | null
  objectId: string | null
}

/** A valid 1x1 PNG, so `fetch`'s signature check passes on fake output. */
export const FAKE_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
  "base64",
)

export class FakeProvider implements Provider {
  readonly id = "fake"

  readonly jobs = new Map<string, FakeJob>()
  readonly assets = new Map<string, RemoteAsset>()
  readonly tags = new Map<string, string[]>()
  readonly deleted: string[] = []
  /** Every submit, in order, so a test can assert on call count and spacing. */
  readonly submissions: { jobId: string; assetId: string; at: number }[] = []

  private counter = 0
  private balanceRemaining: number

  constructor(private readonly opts: FakeOptions = {}) {
    this.balanceRemaining = opts.startingBalance ?? 10_000
    if (opts.supportsList !== false) this.list = this.listImpl.bind(this)
  }

  /** Characters a test puts on the account for adoption; `fake://` URLs download like objects. */
  readonly characters = new Map<string, RemoteCharacterDetail>()

  supports(generator: Generator): boolean {
    return generator === "1dir" || generator === "map" || generator === "character"
  }

  supportsRevision(_mode: RevisionMode): boolean {
    return true
  }

  estimate(spec: ResolvedSpec): CostEstimate {
    return {
      unit: this.opts.costUnit ?? "generations",
      amount: spec.generator === "map" ? 1 : 40,
      candidates: this.opts.candidates ?? (spec.generator === "map" ? 1 : 4),
    }
  }

  async submit(spec: ResolvedSpec): Promise<{ jobId: string }> {
    const jobId = `job-${++this.counter}`
    const candidates = this.estimate(spec).candidates
    this.jobs.set(jobId, {
      jobId,
      spec,
      pollsRemaining: this.opts.processingPolls ?? 0,
      candidates,
      failed: this.opts.failAssets?.has(spec.assetId) ?? false,
      selectedIndex: null,
      objectId: null,
    })
    this.submissions.push({ jobId, assetId: spec.assetId, at: this.submissions.length })
    this.balanceRemaining -= this.estimate(spec).amount
    return { jobId }
  }

  async poll(jobId: string): Promise<JobState> {
    const job = this.jobs.get(jobId)
    if (!job) return { status: "failed", error: `unknown job ${jobId}` }
    if (job.pollsRemaining > 0) {
      job.pollsRemaining--
      return { status: "processing", progressPercent: 50 }
    }
    if (job.failed) return { status: "failed", error: "fake failure" }
    if (job.candidates > 1 && job.selectedIndex === null) {
      return {
        status: "review",
        candidateUrls: Array.from(
          { length: job.candidates },
          (_, i) => `fake://${jobId}/candidate/${i}`,
        ),
      }
    }
    const objectId = job.objectId ?? `obj-${jobId}`
    job.objectId = objectId
    this.register(objectId, job.spec)
    const character = job.spec.character
    if (character) {
      // A character lands as its direction set, a loop as its frames, the
      // way the real adapter delivers them once review is done.
      const roles = character.kind === "animation"
        ? Array.from({ length: character.animation!.frames }, (_, i) => `frame-${String(i).padStart(2, "0")}`)
        : character.directions === 4 ? CHARACTER_DIRECTIONS_4 : CHARACTER_DIRECTIONS_8
      const sources: OutputSource[] = roles.map((role) => ({ url: `fake://${objectId}/${role}.png`, role }))
      return {
        status: "ready",
        objectId,
        sourceUrl: sources[0]!.url,
        sources,
        ...(character.kind === "animation"
          ? { metadata: { frameSet: { fps: character.animation!.fps, count: roles.length } } }
          : {}),
      }
    }
    const sourceUrl = `fake://${objectId}.png`
    return { status: "ready", objectId, sourceUrl, sources: [{ url: sourceUrl }] }
  }

  async selectCandidate(
    jobId: string,
    index: number,
    commonTag?: string,
  ): Promise<{ objectId: string; sourceUrl: string | null }> {
    const job = this.jobs.get(jobId)
    if (!job) throw new Error(`unknown job ${jobId}`)
    if (index < 0 || index >= job.candidates) {
      throw new Error(`candidate ${index} out of range for ${jobId}`)
    }
    job.selectedIndex = index
    // Mirrors the real provider: the promoted candidate gets its OWN id,
    // distinct from the review parent's.
    const objectId = `obj-${jobId}-c${index}`
    job.objectId = objectId
    this.register(objectId, job.spec, commonTag ? [commonTag] : [])
    return { objectId, sourceUrl: `fake://${objectId}.png` }
  }

  async download(url: string): Promise<Buffer> {
    if (!url.startsWith("fake://")) throw new Error(`fake provider cannot download ${url}`)
    // Vary bytes per URL so hashes differ between assets, as real output would.
    const salt = createHash("sha256").update(url).digest()
    return Buffer.concat([FAKE_PNG, salt.subarray(0, 4)])
  }

  async balance(): Promise<BalanceInfo> {
    return {
      unit: this.opts.costUnit ?? "generations",
      remaining: this.balanceRemaining,
      total: this.opts.startingBalance ?? 10_000,
      plan: "fake",
    }
  }

  async setTags(objectId: string, tags: string[]): Promise<void> {
    this.tags.set(objectId, [...tags])
    const asset = this.assets.get(objectId)
    if (asset) asset.tags = [...tags]
    const character = this.characters.get(objectId.split("#")[0]!)
    if (character) character.tags = [...tags]
  }

  /**
   * Assigned in the constructor rather than declared as a method, so a test can
   * model a provider that genuinely lacks listing (making `adopt` and `salvage`
   * unavailable) instead of one that throws.
   */
  list?: () => AsyncGenerator<RemoteAsset>

  private async *listImpl(): AsyncGenerator<RemoteAsset> {
    for (const asset of this.assets.values()) yield asset
  }

  async *listCharacters(): AsyncGenerator<RemoteCharacter> {
    for (const { rotations: _r, animations: _a, ...character } of this.characters.values()) yield character
  }

  async getCharacter(id: string): Promise<RemoteCharacterDetail> {
    const character = this.characters.get(id)
    if (!character) throw new Error(`fake provider has no character ${id}`)
    return character
  }

  /** Characters answer with whatever the store holds now; other objects keep their URLs. */
  async refreshSources(objectId: string, context: RefreshContext): Promise<OutputSource[] | null | undefined> {
    if (context.generator !== "character") return undefined
    const [characterId, groupId] = objectId.split("#") as [string, string | undefined]
    const character = this.characters.get(characterId)
    if (!character) return null
    if (!groupId) return character.rotations
    const direction = (context.metadata?.character as { direction?: string } | undefined)?.direction ?? "south"
    const animation = character.animations.find((a) => a.groupId === groupId && a.direction === direction)
    if (!animation) return null
    return animation.frames.map((url, index) => ({ url, role: `frame-${String(index).padStart(2, "0")}` }))
  }

  async delete(assetId: string): Promise<void> {
    this.deleted.push(assetId)
    this.assets.delete(assetId)
  }

  async deleteCharacter(id: string): Promise<void> {
    this.deleted.push(id)
    this.characters.delete(id)
  }

  /** Seed a pre-existing remote asset, for adopt / salvage tests. */
  seed(asset: Partial<RemoteAsset> & { id: string }): RemoteAsset {
    const full: RemoteAsset = {
      prompt: "seeded",
      width: 64,
      height: 64,
      createdAt: "2026-01-01T00:00:00Z",
      previewUrl: `fake://${asset.id}.png`,
      tags: [],
      status: "completed",
      ...asset,
    }
    this.assets.set(full.id, full)
    return full
  }

  private register(objectId: string, spec: ResolvedSpec, tags: string[] = []): void {
    if (this.assets.has(objectId)) return
    this.assets.set(objectId, {
      id: objectId,
      prompt: spec.prompt,
      width: spec.width,
      height: spec.height,
      createdAt: new Date(0).toISOString(),
      previewUrl: `fake://${objectId}.png`,
      tags,
      status: "completed",
    })
  }
}
