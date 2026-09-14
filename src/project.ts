import path from "node:path"
import { loadEnvFiles } from "./env.ts"
import { loadLock, saveLock } from "./lock.ts"
import { loadManifest, resolveSpecs, type LoadedManifest } from "./manifest.ts"
import { normalizeLockOutputPaths } from "./outputs.ts"
import { buildPlan, type Plan } from "./pipeline/plan.ts"
import type { Provider } from "./provider.ts"
import { createProvider, type ProviderMode } from "./providers/registry.ts"
import type { Lock, ResolvedSpec } from "./types.ts"

/**
 * Opening a project used to be four calls in a fixed order, and the fourth
 * was the one people forgot: `loadManifest`, `resolveSpecs`, `loadLock`, then
 * `normalizeLockOutputPaths` so a lockfile written on another machine
 * resolves against this checkout. The CLI, the gallery, and every example in
 * LIBRARY.md repeated the sequence. `openProject` is that sequence, once,
 * with the env files beside the manifest read first the way the CLI reads
 * them, because the API key belongs with the project rather than the tool.
 */
export interface OpenProjectOptions {
  /** Lockfile to read. Defaults to `pixelkiln.lock.json` beside the manifest. */
  lockPath?: string
  /** Keep only these style ids. Empty or omitted keeps every style. */
  styles?: string[]
  /** Keep only these asset ids. Empty or omitted keeps every asset. */
  assets?: string[]
  /**
   * Read `.env.local` and `.env` from the manifest's directory, and from the
   * working directory when that differs, into `process.env` before anything
   * else. Never overrides a variable already set. On by default because a
   * provider constructed later needs the key; pass false when the caller
   * manages credentials itself.
   */
  env?: boolean
}

export interface Project {
  /** Absolute path of the manifest. */
  manifestPath: string
  /** Directory the manifest lives in. Every relative path resolves against it. */
  root: string
  /** Absolute path of the lockfile, whether or not it exists yet. */
  lockPath: string
  loaded: LoadedManifest
  /** Resolved specs after the style and asset filters. */
  specs: ResolvedSpec[]
  /** The lockfile with output paths canonicalised for this checkout. Mutated by pipeline calls; persist with `saveLock`. */
  lock: Lock
  /** Diff manifest, lockfile, and disk. Offline; spends nothing. */
  plan(opts?: { force?: boolean }): Promise<Plan>
  /** Write `lock` as it stands, atomically. */
  saveLock(): Promise<void>
  /** Read everything again from disk with the same options. */
  reload(): Promise<Project>
  /** Provider ids the selected specs route to, sorted. */
  providers(): string[]
  /**
   * One adapter per id and mode for the life of this object. `online` needs
   * credentials and can spend; `downloads` only fetches objects the lockfile
   * already records and needs no key.
   */
  provider(id: string, mode?: ProviderMode): Provider
}

export async function openProject(
  manifestPath = "pixelkiln.manifest.json",
  opts: OpenProjectOptions = {},
): Promise<Project> {
  const absolute = path.resolve(manifestPath)
  const root = path.dirname(absolute)
  if (opts.env !== false) {
    loadEnvFiles(root)
    if (path.resolve(process.cwd()) !== root) loadEnvFiles(process.cwd())
  }
  const lockPath = path.resolve(opts.lockPath ?? path.join(root, "pixelkiln.lock.json"))
  const loaded = await loadManifest(absolute)
  const specs = await resolveSpecs(loaded, { styles: opts.styles ?? [], assets: opts.assets ?? [] })
  const lock = await loadLock(lockPath)
  normalizeLockOutputPaths(lock, specs)

  const adapters = new Map<string, Provider>()
  return {
    manifestPath: absolute,
    root,
    lockPath,
    loaded,
    specs,
    lock,
    plan: (planOpts) => buildPlan(specs, lock, planOpts),
    saveLock: () => saveLock(lockPath, lock),
    reload: () => openProject(absolute, { ...opts, env: false }),
    providers: () => [...new Set(specs.map((spec) => spec.provider))].sort(),
    provider: (id, mode = "online") => {
      const key = `${mode}:${id}`
      let adapter = adapters.get(key)
      if (!adapter) {
        adapter = createProvider(id, mode)
        adapters.set(key, adapter)
      }
      return adapter
    },
  }
}
