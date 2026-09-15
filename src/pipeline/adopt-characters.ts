import { existsSync } from "node:fs"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import path from "node:path"
import { sha256 } from "../hash.ts"
import { loadCache, saveCache, pruneCache, cachePathFor, type HashCache } from "../cache.ts"
import { saveLock, upsert } from "../lock.ts"
import { expectedOutputPath, portableOutputPath } from "../outputs.ts"
import { decodePng } from "../png.ts"
import type { OutputSource, Provider, RemoteCharacter, RemoteCharacterDetail } from "../provider.ts"
import { shouldPersistSourceUrl } from "../source-url.ts"
import { lockKey, type Lock, type LockOutput, type ResolvedSpec } from "../types.ts"
import { characterAnimationName } from "../providers/pixellab.ts"

/**
 * Bring characters that already exist on the account under the manifest.
 *
 * A character made through the provider's own tools has no lock entry, so
 * PixelKiln cannot plan, budget, snap, or pack it. Adoption maps a
 * manifest's character assets onto those records without generating
 * anything. A base or state is matched by the `remoteId` the asset declares
 * or, failing that, by the exact bytes of its south-facing file; an
 * animation by `remoteId` (`<character>#<group>`) or by the bytes of its
 * first frame. Unlike object adoption, the files are written when they are
 * missing: every direction and frame had to be downloaded to compare, and a
 * child's identity hashes its parent's south file, so the parent's file has
 * to be on disk before the child can be matched at all. Existing files are
 * never replaced; one that differs from the account is reported.
 */
export interface AdoptCharactersResult {
  /** Characters listed on the account. */
  scanned: number
  matched: number
  /** Assets the manifest declares that no character on the account matched, with why. */
  unmatched: string[]
  /** Characters on the account no entry of this lockfile claims. */
  remaining: RemoteCharacter[]
  /** Files written because they were missing locally. */
  written: string[]
  /** Local files that differ from the account's bytes and were left alone. */
  differing: string[]
}

export interface AdoptCharactersOptions {
  onProgress?: (msg: string) => void
  /**
   * Re-resolve the manifest between waves. A state's identity hashes its
   * parent's south file, so once a base is adopted and written, the state
   * has to be resolved again before it can be matched.
   */
  resolve: () => Promise<ResolvedSpec[]>
  noCache?: boolean
}

export async function adoptCharacters(
  provider: Provider,
  specs: ResolvedSpec[],
  lock: Lock,
  lockPath: string,
  opts: AdoptCharactersOptions,
): Promise<AdoptCharactersResult> {
  const log = opts.onProgress ?? (() => {})
  const result: AdoptCharactersResult = { scanned: 0, matched: 0, unmatched: [], remaining: [], written: [], differing: [] }
  if (!provider.listCharacters || !provider.getCharacter) return result
  const wanted = specs.filter((spec) => spec.character)
  if (!wanted.length) return result

  const remote: RemoteCharacter[] = []
  for await (const character of provider.listCharacters()) remote.push(character)
  result.scanned = remote.length
  log(`  found ${remote.length} character(s) on the account`)

  // Hashes of south rotations, keyed by character id, survive between runs
  // the same way object hashes do: a rotation never changes after it lands.
  const cachePath = cachePathFor(lockPath)
  const cache: HashCache = opts.noCache ? { version: 1, hashes: {} } : await loadCache(cachePath)
  const details = new Map<string, RemoteCharacterDetail>()
  const detail = async (id: string) => {
    let known = details.get(id)
    if (!known) {
      known = await provider.getCharacter!(id)
      details.set(id, known)
    }
    return known
  }
  const bytesOf = new Map<string, Buffer>()
  const download = async (url: string) => {
    let bytes = bytesOf.get(url)
    if (!bytes) {
      bytes = await provider.download(url)
      decodePng(bytes)
      bytesOf.set(url, bytes)
    }
    return bytes
  }
  const southHash = async (character: RemoteCharacter): Promise<string | null> => {
    const cached = cache.hashes[`character:${character.id}`]
    if (cached) return cached
    if (!character.previewUrl || character.status !== "completed") return null
    try {
      const hash = sha256(await download(character.previewUrl))
      cache.hashes[`character:${character.id}`] = hash
      return hash
    } catch {
      return null
    }
  }

  /** Write every member of a set that is not on disk; report the ones that differ. */
  const materialize = async (spec: ResolvedSpec, sources: OutputSource[]): Promise<LockOutput[]> => {
    const outputs: LockOutput[] = []
    for (const [index, source] of sources.entries()) {
      const bytes = await download(source.url)
      const hash = sha256(bytes)
      const file = expectedOutputPath(spec, source.role, index, sources.length)
      if (existsSync(file)) {
        if (sha256(await readFile(file)) !== hash) result.differing.push(path.relative(process.cwd(), file))
      } else {
        await mkdir(path.dirname(file), { recursive: true })
        await writeFile(file, bytes)
        result.written.push(path.relative(process.cwd(), file))
      }
      outputs.push({ path: portableOutputPath(file, spec.root), sha256: hash, ...(source.role ? { role: source.role } : {}) })
    }
    return outputs
  }

  const claimed = new Set<string>()
  for (const entry of Object.values(lock.entries)) {
    if (entry.provider === provider.id && entry.generator === "character" && entry.objectId) {
      claimed.add(entry.objectId.split("#")[0]!)
    }
  }

  // Bases first, then states, then animations, so each wave's files are on
  // disk before the next wave's identities are resolved.
  let current = specs
  for (const kind of ["base", "state", "animation"] as const) {
    const wave = current.filter((spec) => spec.character?.kind === kind)
    let adoptedThisWave = 0
    for (const spec of wave) {
      const key = lockKey(spec.styleId, spec.assetId)
      if (lock.entries[key]?.status === "downloaded" && lock.entries[key]?.objectId) continue
      try {
        const adopted = kind === "animation"
          ? await adoptAnimation(spec, key)
          : await adoptCharacter(spec, key)
        if (adopted) adoptedThisWave++
      } catch (err) {
        result.unmatched.push(`${key}: ${err instanceof Error ? err.message : String(err)}`)
      }
    }
    if (adoptedThisWave) {
      await saveLock(lockPath, lock)
      current = await opts.resolve()
    }
  }

  async function adoptCharacter(spec: ResolvedSpec, key: string): Promise<boolean> {
    let match: RemoteCharacter | undefined
    if (spec.remoteId) {
      match = remote.find((c) => c.id === spec.remoteId)
      if (!match) throw new Error(`remoteId ${spec.remoteId} is not a character on this account`)
    } else {
      const south = expectedOutputPath(spec, "south", 0, spec.character!.directions)
      if (!existsSync(south)) {
        result.unmatched.push(`${key}: no remoteId and no ${path.relative(process.cwd(), south)} to match by`)
        return false
      }
      const localHash = sha256(await readFile(south))
      for (const candidate of remote) {
        if (claimed.has(candidate.id)) continue
        if ((await southHash(candidate)) === localHash) {
          match = candidate
          break
        }
      }
      if (!match) {
        result.unmatched.push(`${key}: no character's south rotation has the bytes of ${path.relative(process.cwd(), south)}`)
        return false
      }
    }
    const full = await detail(match.id)
    if (!full.rotations.length) throw new Error(`character ${match.id} has no rotations yet (${full.status})`)
    const outputs = await materialize(spec, full.rotations)
    const durable = full.rotations.filter((source) => shouldPersistSourceUrl(source.url))
    upsert(lock, key, {
      styleId: spec.styleId,
      assetId: spec.assetId,
      specHash: spec.specHash,
      generator: spec.generator,
      prompt: full.prompt || spec.prompt,
      width: spec.width,
      height: spec.height,
      jobId: full.id,
      objectId: full.id,
      reviewObjectId: null,
      candidateIndex: null,
      status: "downloaded",
      error: null,
      sourceUrl: durable[0]?.url ?? null,
      sourceUrls: durable,
      outputs,
      providerMetadata: {
        [provider.id]: {
          character: {
            characterId: full.id,
            groupId: full.groupId,
            name: full.name,
            stateName: full.stateName,
            directions: full.directions,
            size: { width: full.width, height: full.height },
            adopted: true,
          },
        },
      },
      submittedAt: full.createdAt,
      downloadedAt: new Date().toISOString(),
      cost: 0,
      costUnit: "generations",
      provider: provider.id,
    })
    claimed.add(full.id)
    result.matched++
    log(`  adopted ${key} ← character ${full.id}${full.stateName && full.stateName !== "Idle" ? ` (${full.stateName})` : ""}`)
    return true
  }

  async function adoptAnimation(spec: ResolvedSpec, key: string): Promise<boolean> {
    const character = spec.character!
    const animation = character.animation!
    const parentKey = lockKey(spec.styleId, character.parentAssetId!)
    const parentId = spec.remoteId?.split("#")[0] ?? lock.entries[parentKey]?.objectId
    if (!parentId) {
      result.unmatched.push(`${key}: its parent ${parentKey} is not adopted yet`)
      return false
    }
    const full = await detail(parentId)
    const candidates = full.animations.filter((a) => a.direction === animation.direction && a.frames.length)
    let match: (typeof candidates)[number] | undefined
    if (spec.remoteId) {
      const groupId = spec.remoteId.split("#")[1]
      match = candidates.find((a) => a.groupId === groupId)
      if (!match) throw new Error(`remoteId ${spec.remoteId} names no ${animation.direction} animation of character ${parentId}`)
    } else {
      const first = expectedOutputPath(spec, "frame-00", 0, 2)
      if (!existsSync(first)) {
        const byName = candidates.find((a) => a.name === characterAnimationName(spec))
        if (!byName) {
          result.unmatched.push(`${key}: no remoteId and no ${path.relative(process.cwd(), first)} to match by`)
          return false
        }
        match = byName
      } else {
        const localHash = sha256(await readFile(first))
        for (const candidate of candidates) {
          if (sha256(await download(candidate.frames[0]!)) === localHash) {
            match = candidate
            break
          }
        }
        if (!match) {
          result.unmatched.push(`${key}: no ${animation.direction} animation of character ${parentId} starts with the bytes of ${path.relative(process.cwd(), first)}`)
          return false
        }
      }
    }
    const sources: OutputSource[] = match.frames.map((url, index) => ({ url, role: `frame-${String(index).padStart(2, "0")}` }))
    const outputs = await materialize(spec, sources)
    const durable = sources.filter((source) => shouldPersistSourceUrl(source.url))
    const animationId = /\/animations\/([^/]+)\//.exec(match.frames[0]!)?.[1] ?? null
    upsert(lock, key, {
      styleId: spec.styleId,
      assetId: spec.assetId,
      specHash: spec.specHash,
      generator: spec.generator,
      prompt: spec.prompt,
      width: spec.width,
      height: spec.height,
      jobId: `${parentId}#${match.groupId ?? animationId ?? match.type}`,
      objectId: `${parentId}#${match.groupId ?? animationId ?? match.type}`,
      reviewObjectId: null,
      candidateIndex: null,
      status: "downloaded",
      error: null,
      sourceUrl: durable[0]?.url ?? null,
      sourceUrls: durable,
      outputs,
      providerMetadata: {
        [provider.id]: {
          frameSet: { fps: animation.fps, count: sources.length },
          character: {
            kind: "animation",
            characterId: parentId,
            animationId,
            animationGroupId: match.groupId,
            animationName: match.name,
            direction: animation.direction,
            adopted: true,
          },
        },
      },
      submittedAt: full.createdAt,
      downloadedAt: new Date().toISOString(),
      cost: 0,
      costUnit: "generations",
      provider: provider.id,
    })
    result.matched++
    log(`  adopted ${key} ← ${animation.direction} animation ${match.groupId ?? animationId ?? match.type} of ${parentId}`)
    return true
  }

  await saveLock(lockPath, lock)
  if (!opts.noCache) {
    pruneCache(cache, new Set(remote.map((character) => character.id)), "character:")
    await saveCache(cachePath, cache)
  }
  result.remaining = remote.filter((character) => !claimed.has(character.id))
  return result
}
