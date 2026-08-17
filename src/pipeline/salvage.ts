import { readFile } from "node:fs/promises"
import { existsSync } from "node:fs"
import { requireList, type Provider, type RemoteAsset } from "../provider.ts"
import { parseLock, type Lock, type Manifest } from "../types.ts"

/**
 * Objects on the account that no known lockfile claims.
 *
 * The point of this is recovery, not cleanup. An account accumulates work that
 * was generated, paid for, and never landed in a repo — alternate takes,
 * abandoned experiments, whole categories that were explored and forgotten.
 * Measured on one account: 190 of 361 objects were unclaimed, and a visual
 * sample showed usable character portraits, tree variants, terrain tiles, and
 * UI icons rather than rejects.
 *
 * Correctness here depends entirely on being given EVERY lockfile. One account
 * is shared across projects, so an incomplete claim set makes another project's
 * shipped art look like an orphan.
 */
export async function loadClaims(lockPaths: string[]): Promise<Set<string>> {
  const claimed = new Set<string>()
  for (const p of lockPaths) {
    if (!existsSync(p)) throw new Error(`Claim lockfile not found: ${p}`)
    let parsed: Lock
    try {
      parsed = parseLock(JSON.parse(await readFile(p, "utf8")))
    } catch {
      throw new Error(`Claim lockfile is malformed: ${p}`)
    }
    for (const entry of Object.values(parsed.entries)) {
      if (entry.objectId) claimed.add(entry.objectId)
      if (entry.reviewObjectId) claimed.add(entry.reviewObjectId)
      if (entry.jobId) claimed.add(entry.jobId)
    }
  }
  return claimed
}

export interface Orphan {
  id: string
  prompt: string
  width: number
  height: number
  createdAt: string
  previewUrl: string
  tags: string[]
}

export async function findOrphans(
  provider: Provider,
  claimed: Set<string>,
  opts: { onProgress?: (msg: string) => void } = {},
): Promise<{ orphans: Orphan[]; total: number }> {
  const log = opts.onProgress ?? (() => {})
  const all: RemoteAsset[] = []
  for await (const obj of requireList(provider)()) all.push(obj)
  log(`  scanned ${all.length} object(s) on the account`)

  const orphans = all
    .filter((o) => !claimed.has(o.id) && o.status === "completed" && o.previewUrl)
    .map((o) => ({
      id: o.id,
      prompt: o.prompt || "(no prompt recorded)",
      width: o.width,
      height: o.height,
      createdAt: o.createdAt,
      previewUrl: o.previewUrl!,
      tags: o.tags ?? [],
    }))
    // Newest first: recent work is likeliest to be worth recovering.
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))

  return { orphans, total: all.length }
}

/**
 * Fragments shorter than this match too much by accident (an empty
 * `promptPrefix`/`promptSuffix`, or a short one like "clean", would otherwise
 * "match" nearly every prompt via `.includes`).
 */
const MIN_STYLE_FRAGMENT_LENGTH = 12

/**
 * Whether a style's `promptPrefix`/`promptSuffix` — boilerplate baked into
 * every generation of that style — appears in a prompt. Unlike
 * `matchOrphanStyle`, this never assumes a match just because a manifest
 * only has one style: it is the "is this genuinely recognisable" check, used
 * both by `matchOrphanStyle` and to test a prompt against a project that
 * isn't the current one.
 */
function matchStyleByPattern(prompt: string, manifest: Manifest): string | null {
  const p = prompt.toLowerCase()
  for (const styleId of Object.keys(manifest.styles)) {
    const style = manifest.styles[styleId]!
    for (const raw of [style.promptPrefix, style.promptSuffix]) {
      const frag = raw?.trim().toLowerCase()
      if (frag && frag.length >= MIN_STYLE_FRAGMENT_LENGTH && p.includes(frag)) return styleId
    }
  }
  return null
}

/**
 * Which manifest style, if any, an orphan's prompt was generated from.
 *
 * A manifest with only one style skips the pattern check entirely — there is
 * nothing to disambiguate, and a style with an empty prefix/suffix (common
 * for single-style projects that don't template their prompts, like a
 * `map`-generator asset pack) would otherwise match nothing at all. This is
 * a routing decision ("where would salvage import this"), not a claim that
 * the content is genuinely this project's — see `groupOrphansByStyle`'s
 * `siblings` param for that distinction, which single-style manifests need
 * and multi-style ones get from the plain pattern check already.
 */
export function matchOrphanStyle(prompt: string, manifest: Manifest): string | null {
  const styleIds = Object.keys(manifest.styles)
  if (styleIds.length <= 1) return styleIds[0] ?? null
  return matchStyleByPattern(prompt, manifest)
}

/** A sibling project's manifest, consulted only to recognise its own style
 *  patterns — never as an import target. */
export interface SiblingManifest {
  /** How to refer to this sibling in output — a project directory name, typically. */
  label: string
  manifest: Manifest
}

export interface OrphanGroups {
  /** styleId → its matched orphans, in manifest style order. */
  matched: Map<string, Orphan[]>
  /** Orphans that matched no style anywhere known — this manifest or any sibling. */
  unmatched: Orphan[]
  /** "<sibling label>: <styleId>" → orphans that confidently matched a
   *  SIBLING's own pattern instead of this manifest's — excluded from
   *  `matched` even where this manifest would otherwise have swallowed them
   *  by default (a single-style manifest with nothing of its own to check
   *  against). Empty unless `siblings` was passed to `groupOrphansByStyle`. */
  elsewhere: Map<string, Orphan[]>
}

/**
 * Splits orphans by the style that most likely produced them.
 *
 * `salvage` used to hand a single `--style` to a whole session regardless of
 * how many the orphan pool actually spanned, so importing anything wrong
 * silently mislabeled it under the first style in the manifest. Grouping
 * first lets the caller run one correctly-scoped session per style instead.
 *
 * A single-style manifest has no pattern of its own to filter by, so by
 * default everything routes to that one style — correct for a genuinely
 * single-project account, wrong for a shared one where the orphan pool is
 * mostly a sibling's art. Passing that sibling's manifest via `siblings` (its
 * lockfile sits beside it, by the same convention `--lock` defaults from
 * `--manifest`) lets a confident match against ITS pattern win instead,
 * pulling those orphans out of `matched` and into `elsewhere` even though
 * this manifest would otherwise have claimed them.
 */
export function groupOrphansByStyle(
  orphans: Orphan[],
  manifest: Manifest,
  siblings: SiblingManifest[] = [],
): OrphanGroups {
  const matched = new Map<string, Orphan[]>()
  const elsewhere = new Map<string, Orphan[]>()
  const unmatched: Orphan[] = []
  const ownStyleIds = Object.keys(manifest.styles)
  for (const styleId of ownStyleIds) matched.set(styleId, [])

  for (const o of orphans) {
    const own = matchStyleByPattern(o.prompt, manifest)
    if (own) {
      matched.get(own)!.push(o)
      continue
    }

    const sibling = siblings.find((s) => matchStyleByPattern(o.prompt, s.manifest))
    if (sibling) {
      const key = `${sibling.label}: ${matchStyleByPattern(o.prompt, sibling.manifest)}`
      const list = elsewhere.get(key) ?? []
      list.push(o)
      elsewhere.set(key, list)
      continue
    }

    // Nothing recognised it anywhere. A single-style manifest still has no
    // better place to put it than its one style — the same pragmatic default
    // matchOrphanStyle uses — but a multi-style one genuinely doesn't know.
    if (ownStyleIds.length <= 1 && ownStyleIds[0]) matched.get(ownStyleIds[0])!.push(o)
    else unmatched.push(o)
  }
  for (const [styleId, list] of [...matched]) if (!list.length) matched.delete(styleId)
  return { matched, unmatched, elsewhere }
}

/**
 * A prompt makes a better id than a UUID. These are a starting point meant to
 * be renamed, so the goal is "recognisable at a glance", not perfection.
 */
const STYLE_WORDS = new Set([
  "a", "an", "the", "one", "two", "three", "single", "centered", "center", "with", "and",
  "of", "on", "in", "for", "its", "has", "pixel", "art", "style", "game", "icon",
  "transparent", "background", "no", "premium", "indie", "achievement", "sprite",
  "isometric", "topdown", "top", "down", "view", "high", "low", "detailed", "simple",
  "clean", "bold", "dark", "outline", "silhouette", "colour", "color", "palette",
])

export function idFromPrompt(prompt: string, taken: Set<string>): string {
  // Prompts commonly read "<style boilerplate>: <the actual subject>". When a
  // colon is present the subject is after it, and using the whole string would
  // name every asset after the shared prefix.
  const colon = prompt.indexOf(":")
  const subject = colon >= 0 && colon < prompt.length - 12 ? prompt.slice(colon + 1) : prompt

  const words = subject
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 2 && !STYLE_WORDS.has(w))
    .slice(0, 4)

  let base = words.join("_") || "salvaged"
  let id = base
  let n = 2
  while (taken.has(id)) id = `${base}_${n++}`
  taken.add(id)
  return id
}

/**
 * Placeholder spec hash written by a salvage import. The real hash cannot be
 * computed until the manifest has been rewritten with the new asset, so the CLI
 * re-baselines these immediately afterwards. Exported so the writer and the
 * re-baseliner reference one constant rather than two copies of a string.
 */
export const SALVAGED_SPEC_HASH = "salvaged"

export type SalvageAction = "import" | "keep" | "discard"

export interface SalvageDecision {
  id: string
  action: SalvageAction
}

/**
 * Tags are the durable record of a decision. They are free and synchronous, and
 * unlike a local file they survive on the account itself — so a later salvage
 * run from a different machine sees what was already triaged.
 *
 * `discard` deliberately only tags. Deleting is a separate, explicit command.
 */
export async function applyTags(
  provider: Provider,
  decisions: SalvageDecision[],
  existing: Map<string, string[]>,
  opts: { onProgress?: (msg: string) => void } = {},
): Promise<{ tagged: number; failed: number }> {
  const log = opts.onProgress ?? (() => {})
  let tagged = 0
  let failed = 0

  for (const { id, action } of decisions) {
    const current = (existing.get(id) ?? []).filter(
      (t) => t !== "pixelkiln:keep" && t !== "pixelkiln:discard" && t !== "pixelkiln:imported",
    )
    const next = [...current, `pixelkiln:${action === "import" ? "imported" : action}`].slice(0, 20)
    if (!provider.setTags) return { tagged, failed }
    try {
      await provider.setTags(id, next)
      tagged++
    } catch (err) {
      failed++
      log(`  tag failed ${id}: ${err instanceof Error ? err.message : String(err)}`)
    }
  }
  return { tagged, failed }
}
