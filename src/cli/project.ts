/** Opening a project the way commands need it, plus the manifest and provider helpers they share. */
import path from "node:path"
import { existsSync } from "node:fs"
import { formatCost, type Provider } from "../provider.ts"
import { createProvider, type ProviderMode } from "../providers/registry.ts"
import type { LoadedManifest } from "../manifest.ts"
import { openProject as openLibraryProject } from "../project.ts"
import { sha256File } from "../hash.ts"
import { lockKey, type Lock, type Manifest, type ResolvedSpec } from "../types.ts"
import type { Plan } from "../pipeline/plan.ts"
import { loadWorkspace, validateWorkspace } from "../workspace.ts"
import { workspaceClaims } from "../pipeline/workspace.ts"
import type { ArtifactSource } from "../artifacts.ts"
import type { Args } from "./args.ts"

export async function provenanceFile(id: string, file: string): Promise<ArtifactSource> {
  const absolute = path.resolve(file)
  return {
    id,
    path: absolute,
    sha256: existsSync(absolute) ? await sha256File(absolute) : null,
    included: true,
  }
}

export function manifestSources(manifest: Manifest, styleId: string): Record<string, string> {
  const sources: Record<string, string> = {}
  for (const [assetId, asset] of Object.entries(manifest.assets)) {
    if (asset.styles.length && !asset.styles.includes(styleId)) continue
    const source = asset.sourceByStyle[styleId] ?? asset.source
    if (source) sources[assetId] = source
  }
  return sources
}

export function manifestProviderIds(manifest: Manifest): string[] {
  return [...new Set(
    Object.values(manifest.styles).map((style) => style.provider ?? manifest.provider),
  )].sort()
}

export function specsByRecordedProvider(specs: ResolvedSpec[], lock: Lock): Map<string, ResolvedSpec[]> {
  const grouped = new Map<string, ResolvedSpec[]>()
  for (const spec of specs) {
    const key = lockKey(spec.styleId, spec.assetId)
    const provider = lock.entries[key]?.provider ?? spec.provider
    grouped.set(provider, [...(grouped.get(provider) ?? []), spec])
  }
  return grouped
}

export function accountProviderId(manifest: Manifest, requested: string | undefined, command: string): string {
  const providers = manifestProviderIds(manifest)
  if (requested) {
    if (!providers.includes(requested)) {
      throw new Error(
        `Provider "${requested}" is not used by this manifest. Used: ${providers.join(", ")}.`,
      )
    }
    return requested
  }
  if (providers.length > 1) {
    throw new Error(
      `${command} is account-scoped and this manifest uses ${providers.join(", ")}. ` +
        `Pass --provider <id>.`,
    )
  }
  return providers[0] ?? manifest.provider
}

export function budgetsForPlan(plan: Plan, args: Args): Map<string, number | undefined> {
  const providerIds = new Set(plan.groups.map((group) => group.provider))
  const keyed = Object.entries(args.providerBudgets)
  for (const [provider] of keyed) {
    if (!providerIds.has(provider)) {
      throw new Error(
        `Budget names provider "${provider}", but this run has work only for ` +
          `${[...providerIds].join(", ") || "no providers"}.`,
      )
    }
  }
  if (plan.groups.length > 1 && args.budget !== undefined) {
    throw new Error(
      "A mixed-provider run needs provider-keyed budgets, for example " +
        "--budget pixellab=40 --budget retrodiffusion=1.25.",
    )
  }
  const out = new Map<string, number | undefined>()
  for (const group of plan.groups) {
    const ceiling = args.providerBudgets[group.provider]
    if (
      plan.groups.length > 1 &&
      group.costUnit !== "free" &&
      group.cost > 0 &&
      ceiling === undefined
    ) {
      throw new Error(
        `Mixed-provider run is missing --budget ${group.provider}=<amount> for ` +
          `${formatCost(group.costUnit, group.cost)} of planned work.`,
      )
    }
    out.set(group.provider, ceiling ?? (plan.groups.length === 1 ? args.budget : undefined))
  }
  return out
}

/**
 * Loads a workspace catalog and derives its complete claim set, refusing when
 * the catalog itself is unsafe — missing entirely, or containing duplicate
 * ids/locks, or a registered manifest or lock that does not exist — rather
 * than silently deriving a partial (or empty) claim set. `loadWorkspace`
 * treats a missing file as an empty catalog because that's the right
 * behavior for `workspace add` (creating one for the first time); a claim
 * consumer needs the opposite default, the same way `--claims` treats a
 * missing lockfile path as a hard error (`loadClaims`,
 * `src/pipeline/salvage.ts`) rather than skipping it. `workspaceClaims`
 * separately guards against an unreadable lock that passed the existence
 * check.
 */
export async function requireCompleteWorkspaceClaims(workspacePath: string) {
  if (!existsSync(workspacePath)) {
    throw new Error(`Workspace catalog not found: ${workspacePath}`)
  }
  const dir = path.dirname(path.resolve(workspacePath))
  const ws = await loadWorkspace(workspacePath)
  const diagnostics = validateWorkspace(ws, dir)
  const errors = diagnostics.filter((d) => d.level === "error")
  if (errors.length) {
    throw new Error(
      `Workspace catalog at ${workspacePath} is not safe to derive a claim set from:\n` +
        errors.map((d) => `  ${d.id}: ${d.message}`).join("\n"),
    )
  }
  const claims = await workspaceClaims(ws, dir)
  return { ws, dir, diagnostics, claims }
}

/** What every manifest-backed command starts from. */
export interface CliProject {
  loaded: LoadedManifest
  /** Specs narrowed by --style/--only (and, for account commands, by provider). */
  specs: ResolvedSpec[]
  lock: Lock
}

/** Adopt, salvage, and purge speak to one account at a time. */
export interface CliAccountProject extends CliProject {
  accountProvider: string
  /** The manifest narrowed to that provider's styles. */
  accountManifest: Manifest
}

const ACCOUNT_COMMANDS = new Set(["adopt", "salvage", "purge"])

/**
 * Load env, manifest, specs, and lock the way every project command needs
 * them. Env is read from the manifest's directory and the cwd before any
 * provider is constructed; the key belongs with the project, not the tool.
 */
export async function openProject(args: Args): Promise<CliProject> {
  return open(args)
}

export async function openAccountProject(args: Args): Promise<CliAccountProject> {
  const project = await open(args)
  if (!project.accountProvider) throw new Error(`${args.command} is not an account-scoped command`)
  return project as CliAccountProject
}

async function open(args: Args): Promise<CliProject & Partial<CliAccountProject>> {
  if (!existsSync(path.resolve(args.manifest))) {
    throw new Error(
      `No manifest at ${path.resolve(args.manifest)}. Pass --manifest, or run \`pixelkiln init --from <dir>\`.`,
    )
  }
  const project = await openLibraryProject(args.manifest, { lockPath: args.lock, styles: args.styles, assets: args.assets })
  const { loaded, lock } = project
  let specs = project.specs
  const accountProvider = ACCOUNT_COMMANDS.has(args.command)
    ? accountProviderId(loaded.manifest, args.provider, args.command)
    : undefined
  if (args.provider && !accountProvider) {
    throw new Error("--provider is only used by balance, adopt, salvage, purge, or workspace add.")
  }
  if (accountProvider) specs = specs.filter((spec) => spec.provider === accountProvider)
  const accountManifest: Manifest = accountProvider
    ? {
        ...loaded.manifest,
        provider: accountProvider,
        styles: Object.fromEntries(
          Object.entries(loaded.manifest.styles).filter(
            ([, style]) => (style.provider ?? loaded.manifest.provider) === accountProvider,
          ),
        ),
      }
    : loaded.manifest
  if (accountProvider && args.styles.some((styleId) => !accountManifest.styles[styleId])) {
    throw new Error(`Selected style is not assigned to provider "${accountProvider}".`)
  }
  return { loaded, specs, lock, accountProvider, accountManifest }
}

/** Restore and a tag-less fetch only download, so they need no live credentials. */
export function providerModeFor(args: Pick<Args, "command" | "tag">): ProviderMode {
  return args.command === "restore" || (args.command === "fetch" && !args.tag) ? "downloads" : "online"
}

/** One provider instance per id for the life of a command. */
export function providerCache(mode: ProviderMode): (id: string) => Provider {
  const providers = new Map<string, Provider>()
  return (id) => {
    let resolved = providers.get(id)
    if (!resolved) {
      resolved = createProvider(id, mode)
      providers.set(id, resolved)
    }
    return resolved
  }
}
