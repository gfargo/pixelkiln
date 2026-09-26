import { readFile } from "node:fs/promises"
import { existsSync } from "node:fs"
import path from "node:path"
import { requireList, type Provider, type RemoteAsset, type RemoteCharacter, type RemoteCharacterDetail } from "../provider.ts"
import { loadManifest } from "../manifest.ts"
import { parseLock, type Lock, type Manifest } from "../types.ts"

/**
 * Objects on the account that no known lockfile claims.
 *
 * The point of this is recovery, not cleanup. An account accumulates work that
 * was generated, paid for, and never landed in a repo: alternate takes,
 * abandoned experiments, whole categories that were explored and forgotten.
 * Measured on one account: 190 of 361 objects were unclaimed, and a visual
 * sample showed usable character portraits, tree variants, terrain tiles, and
 * UI icons rather than rejects.
 *
 * Correctness here depends entirely on being given EVERY lockfile. One account
 * is shared across projects, so an incomplete claim set makes another project's
 * shipped art look like an orphan.
 */
export interface LoadClaimsOptions {
  /** Include only entries owned by this provider. */
  provider?: string
  /** Prefix ids with their provider so unrelated accounts cannot collide. */
  qualify?: boolean
}

export function providerClaimId(provider: string, objectId: string): string {
  // Encode both halves so a provider/id pair such as ("a:b", "c") cannot
  // collide with ("a", "b:c"). Built-in ids stay human-readable.
  return `${encodeURIComponent(provider)}:${encodeURIComponent(objectId)}`
}

export async function loadClaims(
  lockPaths: string[],
  opts: LoadClaimsOptions = {},
): Promise<Set<string>> {
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
      if (opts.provider && entry.provider !== opts.provider) continue
      const add = (id: string | null) => {
        if (id) claimed.add(opts.qualify ? providerClaimId(entry.provider, id) : id)
      }
      add(entry.objectId)
      add(entry.reviewObjectId)
      add(entry.jobId)
      // A character loop records `<character>#<group>`, a chosen tile
      // variation `<set>#<index>`; the part before `#` is an account object
      // in its own right, and the entry claims it too.
      for (const id of [entry.objectId, entry.jobId]) {
        if (id?.includes("#")) add(id.split("#")[0]!)
      }
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
  /**
   * `character` for a character group (a base and its states), triaged as
   * one card; absent for an ordinary account object.
   */
  kind?: "character"
  /** One line the triage sheet shows under the size, e.g. a character's direction/state/loop counts. */
  note?: string
  /** A character group's every character id, base first, with its current tags; a decision applies to all of them. */
  members?: { id: string; tags: string[] }[]
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
    .filter((o) =>
      !claimed.has(o.id) &&
      !claimed.has(providerClaimId(provider.id, o.id)) &&
      o.status === "completed" &&
      o.previewUrl,
    )
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

export interface CharacterOrphanScan {
  /** One per unclaimed group: the base's id, prompt, and south rotation, plus every member. */
  orphans: Orphan[]
  /** Characters listed on the account. */
  total: number
  /** Groups with some members claimed and some not; left to `adopt`, never offered for discard. */
  partlyClaimed: number
}

/**
 * Characters the account holds that no known lockfile claims, grouped the
 * way PixelLab groups them: a base and the states made from it share a
 * `groupId`, and one decision covers the whole group. A group with any member
 * claimed is left out entirely, since discarding the rest would delete
 * states of a character a project still uses; `adopt` is the way to bring
 * those unclaimed states in.
 */
export async function findOrphanCharacters(
  provider: Provider,
  claimed: Set<string>,
  opts: { onProgress?: (msg: string) => void } = {},
): Promise<CharacterOrphanScan> {
  const log = opts.onProgress ?? (() => {})
  if (!provider.listCharacters) return { orphans: [], total: 0, partlyClaimed: 0 }
  const all: RemoteCharacter[] = []
  for await (const character of provider.listCharacters()) all.push(character)
  log(`  scanned ${all.length} character(s) on the account`)

  const isClaimed = (id: string) => claimed.has(id) || claimed.has(providerClaimId(provider.id, id))
  const groups = new Map<string, RemoteCharacter[]>()
  for (const character of all) {
    const key = character.groupId ?? character.id
    groups.set(key, [...(groups.get(key) ?? []), character])
  }
  let partlyClaimed = 0
  const orphans: Orphan[] = []
  for (const members of groups.values()) {
    const unclaimed = members.filter((character) => !isClaimed(character.id))
    if (!unclaimed.length) continue
    if (unclaimed.length < members.length) {
      partlyClaimed++
      continue
    }
    const ordered = [...members].sort((a, b) =>
      Number(isState(a)) - Number(isState(b)) || a.createdAt.localeCompare(b.createdAt))
    const base = ordered[0]!
    if (base.status !== "completed" || !base.previewUrl) continue
    const states = ordered.length - 1
    const loops = ordered.reduce((sum, character) => sum + character.animationCount, 0)
    orphans.push({
      id: base.id,
      prompt: base.prompt || base.name || "(no prompt recorded)",
      width: base.width,
      height: base.height,
      createdAt: base.createdAt,
      previewUrl: base.previewUrl,
      tags: base.tags ?? [],
      kind: "character",
      note:
        `character · ${base.directions} directions · ${states} state${states === 1 ? "" : "s"} · ` +
        `${loops} loop${loops === 1 ? "" : "s"}`,
      members: ordered.map((character) => ({ id: character.id, tags: character.tags ?? [] })),
    })
  }
  orphans.sort((a, b) => b.createdAt.localeCompare(a.createdAt))
  return { orphans, total: all.length, partlyClaimed }
}

/** A state carries its own name; a base is unnamed or PixelLab's `Idle`. */
function isState(character: Pick<RemoteCharacter, "stateName">): boolean {
  return Boolean(character.stateName && character.stateName !== "Idle")
}

/** Styles that draw PixelLab characters, the only place a character group can be imported. */
export function characterStyleIds(manifest: Manifest): string[] {
  return Object.keys(manifest.styles).filter((id) => manifest.styles[id]!.generator === "character")
}

/**
 * The manifest as object salvage should see it: without character styles.
 * An account object imported into a character style would become a
 * character base with a committed file and nothing upstream to adopt.
 */
export function withoutCharacterStyles(manifest: Manifest): Manifest {
  const characters = new Set(characterStyleIds(manifest))
  return {
    ...manifest,
    styles: Object.fromEntries(Object.entries(manifest.styles).filter(([id]) => !characters.has(id))),
  }
}

/**
 * Which character style each unclaimed character group goes to: the only
 * one when there is one, otherwise the style whose prompt prefix or suffix
 * the base's prompt carries. A manifest with no character style routes
 * nothing; the caller says so rather than guessing.
 */
export function routeCharacterOrphans(
  orphans: Orphan[],
  manifest: Manifest,
): { matched: Map<string, Orphan[]>; unmatched: Orphan[] } {
  const styleIds = characterStyleIds(manifest)
  const matched = new Map<string, Orphan[]>()
  const unmatched: Orphan[] = []
  const only: Manifest = { ...manifest, styles: Object.fromEntries(styleIds.map((id) => [id, manifest.styles[id]!])) }
  for (const orphan of orphans) {
    const styleId = styleIds.length === 1 ? styleIds[0]! : styleIds.length ? matchStyleByPattern(orphan.prompt, only) : null
    if (!styleId) {
      unmatched.push(orphan)
      continue
    }
    matched.set(styleId, [...(matched.get(styleId) ?? []), orphan])
  }
  return { matched, unmatched }
}

/** A raw manifest asset, as written back to the file. */
export type SalvagedAsset = Record<string, unknown>

/**
 * The manifest assets a salvaged character group becomes: a base, one asset
 * per state, and one loop per animation direction, each carrying the
 * `remoteId` that `adoptCharacters` maps it by. Nothing is written to the
 * lockfile here; adoption does that, downloading every rotation and frame
 * the same way it does for a hand-declared character.
 *
 * A loop PixelLab recorded with no animation group id is left out: adoption
 * matches a loop by `<character>#<group>`, and without the group there is
 * nothing to match. `skipped` names them so the caller can say so.
 */
export function characterSalvageAssets(
  characters: RemoteCharacterDetail[],
  ctx: { styleId: string; styleSize?: number; taken: Set<string> },
): { assets: Record<string, SalvagedAsset>; skipped: string[] } {
  const ordered = [...characters].sort((a, b) =>
    Number(isState(a)) - Number(isState(b)) || a.createdAt.localeCompare(b.createdAt))
  const base = ordered[0]!
  const common = { styles: [ctx.styleId], tags: ["salvaged"] }
  const assets: Record<string, SalvagedAsset> = {}
  const skipped: string[] = []
  const baseId = idFromPrompt(base.name || base.prompt, ctx.taken)
  const size = base.width === base.height && base.width >= 32 && base.width <= 256 && base.width !== ctx.styleSize
    ? { size: base.width }
    : {}
  assets[baseId] = { prompt: base.prompt || base.name || baseId, remoteId: base.id, ...size, ...common }

  const assetIdOf = new Map<string, string>([[base.id, baseId]])
  for (const state of ordered.slice(1)) {
    const stateId = uniqueId(`${baseId}_${slug(state.stateName ?? "state")}`, ctx.taken)
    assetIdOf.set(state.id, stateId)
    assets[stateId] = { prompt: state.prompt || state.stateName || stateId, state: { of: baseId }, remoteId: state.id, ...common }
  }

  for (const character of ordered) {
    const parentId = assetIdOf.get(character.id)!
    for (const animation of character.animations) {
      if (!animation.frames.length) continue
      const label = animation.name || animation.type
      if (!animation.groupId) {
        skipped.push(`${parentId}: "${label}" ${animation.direction} loop has no animation group id to adopt it by`)
        continue
      }
      const loopId = uniqueId(`${parentId}.${slug(label)}.${animation.direction}`, ctx.taken)
      assets[loopId] = {
        prompt: label,
        animation: { of: parentId, direction: animation.direction },
        remoteId: `${character.id}#${animation.groupId}`,
        ...common,
      }
    }
  }
  return { assets, skipped }
}

function slug(text: string): string {
  return text.toLowerCase().replace(/^pixelkiln:.*\//, "").replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "") || "loop"
}

function uniqueId(base: string, taken: Set<string>): string {
  let id = base
  let n = 2
  while (taken.has(id)) id = `${base}_${n++}`
  taken.add(id)
  return id
}

/**
 * Fragments shorter than this match too much by accident (an empty
 * `promptPrefix`/`promptSuffix`, or a short one like "clean", would otherwise
 * "match" nearly every prompt via `.includes`).
 */
const MIN_STYLE_FRAGMENT_LENGTH = 12

/**
 * Whether a style's `promptPrefix`/`promptSuffix`, the boilerplate baked into
 * every generation of that style, appears in a prompt. Unlike
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
 * A manifest with only one style skips the pattern check entirely. There is
 * nothing to disambiguate, and a style with an empty prefix/suffix (common
 * for single-style projects that don't template their prompts, like a
 * `map`-generator asset pack) would otherwise match nothing at all. This is
 * a routing decision ("where would salvage import this"), not a claim that
 * the content is genuinely this project's; see `groupOrphansByStyle`'s
 * `siblings` param for that distinction, which single-style manifests need
 * and multi-style ones get from the plain pattern check already.
 */
export function matchOrphanStyle(prompt: string, manifest: Manifest): string | null {
  const styleIds = Object.keys(manifest.styles)
  if (styleIds.length <= 1) return styleIds[0] ?? null
  return matchStyleByPattern(prompt, manifest)
}

/** A sibling project's manifest, consulted only to recognise its own style
 *  patterns, never as an import target. */
export interface SiblingManifest {
  /** How to refer to this sibling in output, typically a project directory name. */
  label: string
  manifest: Manifest
}

/**
 * Loads every sibling project's manifest for `groupOrphansByStyle`'s
 * sibling-exclusion signal, from the union of a workspace catalog's
 * registered manifests and the conventional sibling beside each `--claims`
 * lockfile (same directory, by the convention `--lock` defaults from
 * `--manifest`). The two sources are meant to combine, not choose between
 * (docs/RECOVERY.md: "`--claims` still works and unions with a workspace's
 * claim set"). A `--claims` path passed alongside `--workspace` must still
 * contribute its own style signal. Best-effort: a missing or malformed
 * sibling just means no extra signal for that orphan, not an error.
 */
export async function loadSiblingManifests(
  ownManifestPath: string,
  workspaceManifestPaths: string[],
  claimPaths: string[],
): Promise<SiblingManifest[]> {
  const own = path.resolve(ownManifestPath)
  const siblingManifestPaths = [
    ...new Set([
      ...workspaceManifestPaths,
      ...claimPaths.map((c) => path.join(path.dirname(path.resolve(c)), "pixelkiln.manifest.json")),
    ]),
  ]
  const siblings: SiblingManifest[] = []
  for (const siblingManifestPath of siblingManifestPaths) {
    if (path.resolve(siblingManifestPath) === own) continue
    if (!existsSync(siblingManifestPath)) continue
    try {
      const { manifest } = await loadManifest(siblingManifestPath)
      siblings.push({ label: path.basename(path.dirname(siblingManifestPath)), manifest })
    } catch {
      // Not this run's problem to solve; the orphan just gets no extra signal.
    }
  }
  return siblings
}

export interface OrphanGroups {
  /** styleId → its matched orphans, in manifest style order. */
  matched: Map<string, Orphan[]>
  /** Orphans that matched no style anywhere known, this manifest or any sibling. */
  unmatched: Orphan[]
  /** "<sibling label>: <styleId>" → orphans that confidently matched a
   *  SIBLING's own pattern instead of this manifest's; excluded from
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
 * default everything routes to that one style, correct for a genuinely
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
    // better place to put it than its one style, the same pragmatic default
    // matchOrphanStyle uses, but a multi-style one genuinely doesn't know.
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
 * unlike a local file they survive on the account itself, so a later salvage
 * run from a different machine sees what was already triaged.
 *
 * `discard` deliberately only tags. Deleting is a separate, explicit command.
 */
export async function applyTags(
  provider: Provider,
  decisions: SalvageDecision[],
  existing: Map<string, string[]>,
  opts: {
    onProgress?: (msg: string) => void
    /** Character groups by their card id: the member ids and current tags a decision applies to. */
    characters?: Map<string, { id: string; tags: string[] }[]>
  } = {},
): Promise<{ tagged: number; failed: number }> {
  const log = opts.onProgress ?? (() => {})
  let tagged = 0
  let failed = 0

  for (const { id, action } of decisions) {
    // A character group's decision is every member's: each state is its own
    // record upstream, and `purge` deletes by tag, one record at a time.
    const group = opts.characters?.get(id)
    const targets = group ?? [{ id, tags: existing.get(id) ?? [] }]
    for (const target of targets) {
      const current = target.tags.filter(
        (t) => t !== "pixelkiln:keep" && t !== "pixelkiln:discard" && t !== "pixelkiln:imported",
      )
      const decisionTag = `pixelkiln:${action === "import" ? "imported" : action}`
      // PixelLab caps tags at 20. Preserve the decision tag even when the object
      // already has 20 unrelated tags; it is the durable record of this action.
      const next = [...current.slice(0, 19), decisionTag]
      if (!provider.setTags) return { tagged, failed }
      try {
        await provider.setTags(target.id, next, group ? "character" : undefined)
        tagged++
      } catch (err) {
        failed++
        log(`  tag failed ${target.id}: ${err instanceof Error ? err.message : String(err)}`)
      }
    }
  }
  return { tagged, failed }
}
