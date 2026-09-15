import { mkdir, readFile, rename, writeFile } from "node:fs/promises"
import path from "node:path"
import { sha256 } from "../hash.ts"
import { saveLock, upsert } from "../lock.ts"
import { MediaType } from "../media.ts"
import { currentEntryOutputPath, expectedOutputPath, portableOutputPath } from "../outputs.ts"
import { decodePng, encodeRgbaPng } from "../png.ts"
import {
  CHARACTER_DIRECTIONS_8,
  MIRRORED_DIRECTION,
  lockKey,
  type CharacterDirection,
  type Lock,
  type LockEntry,
  type LockOutput,
  type ResolvedSpec,
} from "../types.ts"
import { postprocessFor } from "./postprocess.ts"

/**
 * A mirror asset is another asset's downloaded files flipped left to right.
 *
 * Nothing here talks to a provider. The work is a pixel flip and a lock
 * entry, done in the submit phase so `gen` picks a mirror up in the wave
 * after its source lands. The entry records a hash over the source's output
 * hashes; the plan compares that with the source's current record, so a
 * regenerated or restored source makes its mirrors stale, and re-deriving
 * them costs nothing.
 */

/** What a mirror's record hashes: the source's output hashes, in order. */
export function mirrorSourceHash(source: Pick<LockEntry, "outputs">): string {
  return sha256(JSON.stringify(source.outputs.map((output) => output.sha256)))
}

/** True while the mirror was made from the source's current outputs. */
export function mirrorCurrent(entry: LockEntry, source: LockEntry | undefined): boolean {
  return Boolean(entry.mirror && source && entry.mirror.sourceSha256 === mirrorSourceHash(source))
}

/** A direction role swaps sides; a frame or output index keeps its name. */
export function mirroredRole(role: string | undefined): string | undefined {
  if (role && role in MIRRORED_DIRECTION) return MIRRORED_DIRECTION[role as CharacterDirection]
  return role
}

export function flipHorizontal(png: Buffer): Buffer {
  const { width, height, pixels } = decodePng(png)
  const flipped = Buffer.alloc(pixels.length)
  const stride = width * 4
  for (let y = 0; y < height; y++) {
    const row = y * stride
    for (let x = 0; x < width; x++) {
      pixels.copy(flipped, row + (width - 1 - x) * 4, row + x * 4, row + x * 4 + 4)
    }
  }
  return encodeRgbaPng(width, height, flipped)
}

export interface DeriveMirrorOptions {
  onProgress?: (msg: string) => void
}

/**
 * Write a mirror's files from its source's recorded outputs and record it
 * as downloaded. The caller has checked readiness; this reads the source
 * entry as the authority on which files make up the set.
 */
export async function deriveMirror(
  spec: ResolvedSpec,
  lock: Lock,
  lockPath: string,
  opts: DeriveMirrorOptions = {},
): Promise<LockEntry> {
  const log = opts.onProgress ?? (() => {})
  const mirror = spec.mirror!
  const key = lockKey(spec.styleId, spec.assetId)
  const sourceKey = lockKey(spec.styleId, mirror.sourceAssetId)
  const source = lock.entries[sourceKey]
  if (!source || source.status !== "downloaded" || !source.outputs.length) {
    throw new Error(`mirror source ${sourceKey} has no downloaded outputs`)
  }

  // Flipped members keep the source's set order, except a direction set,
  // which is listed clockwise from south the way a generated one is.
  const members = source.outputs.map((output, index) => ({
    file: currentEntryOutputPath(source, mirror.sourceSpec, index),
    role: mirroredRole(output.role),
  }))
  if (members.every((member) => member.role && CHARACTER_DIRECTIONS_8.includes(member.role as CharacterDirection))) {
    members.sort((a, b) =>
      CHARACTER_DIRECTIONS_8.indexOf(a.role as CharacterDirection) - CHARACTER_DIRECTIONS_8.indexOf(b.role as CharacterDirection))
  }

  const outputs: LockOutput[] = []
  const written: string[] = []
  for (const [index, member] of members.entries()) {
    const bytes = flipHorizontal(await readFile(member.file))
    const target = expectedOutputPath(spec, member.role, index, members.length, MediaType.PNG)
    await mkdir(path.dirname(target), { recursive: true })
    const tmp = `${target}.pixelkiln.tmp`
    await writeFile(tmp, bytes)
    await rename(tmp, target)
    written.push(target)
    outputs.push({
      path: portableOutputPath(target, spec.root),
      sha256: sha256(bytes),
      ...(member.role ? { role: member.role } : {}),
      mediaType: MediaType.PNG,
    })
  }

  // Playback rate and the character shape travel with the frames so pack
  // and the gallery treat the mirror as the loop it is.
  const sourceMetadata = source.providerMetadata?.[source.provider] ?? {}
  const character = spec.character
  const entry = upsert(lock, key, {
    styleId: spec.styleId,
    assetId: spec.assetId,
    specHash: spec.specHash,
    generator: spec.generator,
    tileFeature: null,
    prompt: "",
    width: spec.width,
    height: spec.height,
    revision: null,
    mirror: { sourceAssetId: mirror.sourceAssetId, sourceSha256: mirrorSourceHash(source) },
    supersededOutputs: [],
    jobId: null,
    submissionComplete: undefined,
    reviewObjectId: null,
    objectId: null,
    candidateIndex: null,
    status: "downloaded",
    error: null,
    outputs,
    providerMetadata: {
      [source.provider]: {
        ...(sourceMetadata.frameSet ? { frameSet: sourceMetadata.frameSet } : {}),
        ...(character
          ? {
              character: {
                kind: character.kind,
                mirrorOf: mirror.sourceAssetId,
                ...(character.animation ? { direction: character.animation.direction } : {}),
              },
            }
          : {}),
      },
    },
    sourceUrl: null,
    sourceUrls: [],
    submittedAt: new Date().toISOString(),
    downloadedAt: new Date().toISOString(),
    history: [],
    cost: 0,
    costUnit: spec.costUnit,
    provider: source.provider,
    postprocess: postprocessFor(spec),
  })
  await saveLock(lockPath, lock)
  log(`  mirror  ${key} ← ${sourceKey} (${written.length} file${written.length === 1 ? "" : "s"} flipped, no generation cost)`)
  return entry
}
