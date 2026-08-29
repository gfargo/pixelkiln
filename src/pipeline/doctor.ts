import { constants, existsSync } from "node:fs"
import { access, stat } from "node:fs/promises"
import path from "node:path"
import type { LoadedManifest } from "../manifest.ts"
import type { Provider } from "../provider.ts"
import type { Lock, ResolvedSpec } from "../types.ts"
import { sha256File } from "../hash.ts"
import { currentEntryOutputPath, resolveOutputPath } from "../outputs.ts"
import { buildPlan, summarize } from "./plan.ts"

export type DoctorLevel = "ok" | "warning" | "error"

export interface DoctorCheck {
  id: string
  level: DoctorLevel
  message: string
}

export interface DoctorReport {
  ok: boolean
  checks: DoctorCheck[]
}

export interface DoctorOptions {
  provider?: Provider
  /** Skip provider connectivity while retaining every local check. */
  offline?: boolean
  apiKeyPresent?: boolean
}

/**
 * Checks the whole project without changing it. Loading/resolving the manifest
 * and loading the lock happen before this function, so schema, style-image,
 * filter, and output-collision validation have already passed if it runs.
 */
export async function doctor(
  loaded: LoadedManifest,
  specs: ResolvedSpec[],
  lock: Lock,
  lockPath: string,
  opts: DoctorOptions = {},
): Promise<DoctorReport> {
  const checks: DoctorCheck[] = []
  const add = (id: string, level: DoctorLevel, message: string) => checks.push({ id, level, message })

  add(
    "manifest",
    "ok",
    `${Object.keys(loaded.manifest.styles).length} style(s), ` +
      `${Object.keys(loaded.manifest.assets).length} asset(s), ${specs.length} resolved spec(s)`,
  )
  add("lock", "ok", `${Object.keys(lock.entries).length} valid v2 lock entr(ies)`)

  const dirs = [...new Set(specs.map((s) => path.dirname(s.outFile)))]
  const unwritable: string[] = []
  for (const dir of dirs) {
    const ancestor = await nearestExistingDirectory(dir)
    try {
      await access(ancestor, constants.W_OK)
    } catch {
      unwritable.push(dir)
    }
  }
  add(
    "outputs",
    unwritable.length ? "error" : "ok",
    unwritable.length
      ? `output path is not writable: ${unwritable.slice(0, 3).join(", ")}`
      : `${dirs.length} output director${dirs.length === 1 ? "y is" : "ies are"} writable`,
  )

  const outputOwners = new Map<string, string>()
  const duplicateOutputs: string[] = []
  const specByKey = new Map(specs.map((spec) => [`${spec.styleId}/${spec.assetId}`, spec]))
  for (const [key, entry] of Object.entries(lock.entries)) {
    for (let index = 0; index < entry.outputs.length; index++) {
      const output = entry.outputs[index]!
      const spec = specByKey.get(key)
      const absolute = spec
        ? currentEntryOutputPath(entry, spec, index)
        : resolveOutputPath(output.path, path.dirname(lockPath))
      const owner = outputOwners.get(absolute)
      if (owner && owner !== key) duplicateOutputs.push(`${output.path} (${owner}, ${key})`)
      outputOwners.set(absolute, key)
    }
  }
  if (duplicateOutputs.length) {
    // Name the remedy. This almost always means an asset was renamed or moved
    // between styles and the old entry stayed behind still claiming the path,
    // which `prune` clears — reporting the breakage without saying what fixes
    // it left the only route as hand-editing the lockfile.
    add(
      "lock-outputs",
      "error",
      `lock entries share output paths: ${duplicateOutputs.slice(0, 3).join(", ")}` +
        `${duplicateOutputs.length > 3 ? `, and ${duplicateOutputs.length - 3} more` : ""}` +
        ` — run \`pixelkiln prune\` if the manifest no longer declares them`,
    )
  } else {
    add("lock-outputs", "ok", `${outputOwners.size} recorded output path(s) are uniquely owned`)
  }

  const cacheDir = path.join(path.dirname(lockPath), ".pixelkiln", "cache")
  const stranded: string[] = []
  const invalidState: string[] = []
  const staleMapUrls: string[] = []
  const now = Date.now()
  for (const [key, entry] of Object.entries(lock.entries)) {
    if ((entry.status === "pending" || entry.status === "processing") && !entry.jobId) {
      invalidState.push(`${key} (${entry.status} without job id)`)
    }
    if (entry.status === "review" && !entry.reviewObjectId) {
      invalidState.push(`${key} (review without review object id)`)
    }
    if (entry.status !== "selected" && entry.status !== "download-failed") continue
    const hasSource = Boolean(entry.sourceUrl || entry.sourceUrls?.length)
    let hasCache = false
    for (const output of entry.outputs) {
      const cached = path.join(cacheDir, `${output.sha256}.png`)
      if (existsSync(cached) && (await sha256File(cached)) === output.sha256) {
        hasCache = true
        break
      }
    }
    if (!hasSource && !hasCache) stranded.push(key)
    if (
      entry.generator === "map" &&
      entry.submittedAt &&
      now - Date.parse(entry.submittedAt) > 8 * 60 * 60 * 1000
    ) {
      staleMapUrls.push(key)
    }
  }
  add(
    "recovery",
    stranded.length || invalidState.length ? "error" : staleMapUrls.length ? "warning" : "ok",
    invalidState.length
      ? `invalid resumable state: ${invalidState.slice(0, 5).join(", ")}`
      : stranded.length
      ? `${stranded.length} unfinished entr(ies) have neither source URLs nor cached bytes: ${stranded.slice(0, 5).join(", ")}`
      : staleMapUrls.length
        ? `${staleMapUrls.length} unfinished map entr(ies) are older than the provider's 8-hour job window`
        : "no unfinished downloads are stranded without a source or cached bytes",
  )

  const plan = await buildPlan(specs, lock)
  const counts = summarize(plan)
  const unsettled = plan.items.filter((i) => i.state !== "ok").length
  add(
    "plan",
    unsettled ? "warning" : "ok",
    unsettled
      ? `${unsettled} spec(s) are not current: ` +
        Object.entries(counts)
          .filter(([, n]) => n > 0)
          .map(([state, n]) => `${n} ${state}`)
          .join(", ")
      : "every resolved spec is current",
  )

  if (opts.offline) {
    add("provider", "warning", "provider connectivity skipped (--dry-run)")
  } else if (!opts.provider) {
    add(
      "provider",
      "error",
      opts.apiKeyPresent === false ? "PIXELLAB_API_KEY is not configured" : "provider is not configured",
    )
  } else {
    try {
      const balance = await opts.provider.balance()
      add("provider", "ok", `${opts.provider.id} reachable; ${balance.remaining} ${balance.unit} remaining`)
    } catch (err) {
      add("provider", "error", `provider connectivity failed: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  return { ok: !checks.some((c) => c.level === "error"), checks }
}

async function nearestExistingDirectory(start: string): Promise<string> {
  let current = start
  for (;;) {
    try {
      if ((await stat(current)).isDirectory()) return current
    } catch {
      // Walk upward until a parent exists; creating descendants needs write
      // permission on that nearest existing ancestor.
    }
    const parent = path.dirname(current)
    if (parent === current) return current
    current = parent
  }
}
