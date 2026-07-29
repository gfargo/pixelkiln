import { readFile } from "node:fs/promises"
import { existsSync } from "node:fs"
import type { PixelLabClient, PixelLabObject } from "../client.ts"
import { LockSchema, type Lock } from "../types.ts"

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
    const parsed = LockSchema.safeParse(JSON.parse(await readFile(p, "utf8")))
    if (!parsed.success) throw new Error(`Claim lockfile is malformed: ${p}`)
    for (const entry of Object.values(parsed.data.entries)) {
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
  client: PixelLabClient,
  claimed: Set<string>,
  opts: { onProgress?: (msg: string) => void } = {},
): Promise<{ orphans: Orphan[]; total: number }> {
  const log = opts.onProgress ?? (() => {})
  const all: PixelLabObject[] = []
  for await (const obj of client.iterateObjects(100)) all.push(obj)
  log(`  scanned ${all.length} object(s) on the account`)

  const orphans = all
    .filter((o) => !claimed.has(o.id) && o.status === "completed" && o.preview_url)
    .map((o) => ({
      id: o.id,
      prompt: o.prompt || "(no prompt recorded)",
      width: o.size.width,
      height: o.size.height,
      createdAt: o.created_at,
      previewUrl: o.preview_url!,
      tags: o.tags ?? [],
    }))
    // Newest first: recent work is likeliest to be worth recovering.
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))

  return { orphans, total: all.length }
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
  client: PixelLabClient,
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
    try {
      await client.setTags(id, next)
      tagged++
    } catch (err) {
      failed++
      log(`  tag failed ${id}: ${err instanceof Error ? err.message : String(err)}`)
    }
  }
  return { tagged, failed }
}
