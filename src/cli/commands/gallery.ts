/** `gallery`: serve one project or a whole workspace until Ctrl+C. */
import path from "node:path"
import { existsSync } from "node:fs"
import { loadEnvFiles, readEnvFiles } from "../../env.ts"
import {
  availableProviders,
  createProvider,
  providerCredentialEnvs,
  providerFactory,
} from "../../providers/registry.ts"
import {
  buildGallerySnapshot,
  buildWorkspaceGallerySnapshot,
  type GalleryBuild,
} from "../../gallery/snapshot.ts"
import { serveGallery } from "../../gallery/server.ts"
import { createGalleryEditHandler } from "../../gallery/edit.ts"
import { createGallerySkeletonHandlers } from "../../gallery/skeleton.ts"
import { createGenerateHandlers, type GalleryProjectContext } from "../../gallery/generate.ts"
import { createGalleryEditorHandlers } from "../../gallery/editor.ts"
import { loadWorkspace, resolveProject } from "../../workspace.ts"
import type { Provider } from "../../provider.ts"
import { openProject } from "../project.ts"
import { openProject as openLibraryProject } from "../../project.ts"
import { log, announceGalleryReady } from "../io.ts"
import type { Args } from "../args.ts"

function sessionBudget(args: Pick<Args, "budget" | "providerBudgets">) {
  const keyed = Object.keys(args.providerBudgets).length
  if (args.budget === undefined && !keyed) return null
  return { amount: args.budget, byProvider: { ...args.providerBudgets } }
}

function describeBudget(budget: { amount?: number; byProvider: Record<string, number> }): string {
  const parts = Object.entries(budget.byProvider).map(([provider, amount]) => `${provider}=${amount}`)
  if (budget.amount !== undefined) parts.unshift(String(budget.amount))
  return parts.join(", ")
}

/**
 * Serve one gallery until Ctrl+C. The first page load reuses the snapshot
 * already built for the announcement; every later load and Refresh rebuilds
 * from disk so the page never shows a lockfile that has since moved on.
 */
interface GalleryProjectAccess {
  /** Maps a workspace project id (or undefined) to the manifest an edit may rewrite. */
  manifestFor: (project?: string) => string | Promise<string>
  /** Loads a project fresh from disk for a generation job. */
  loadProject: (project?: string) => Promise<GalleryProjectContext>
}

async function serveUntilStopped(
  initial: GalleryBuild,
  reload: () => Promise<GalleryBuild>,
  args: Pick<Args, "port" | "noOpen" | "edit" | "noEditor" | "budget" | "providerBudgets" | "estimateLimit">,
  access: GalleryProjectAccess,
): Promise<void> {
  let first = true
  const budget = sessionBudget(args)
  // Providers are created online, per project, with that project's own env
  // loaded first; a workspace may register accounts with different keys.
  const providers = new Map<string, Provider>()
  const providerFor = (project: string | undefined, providerId: string): Provider => {
    const cacheKey = `${project ?? ""}:${providerId}`
    let provider = providers.get(cacheKey)
    if (!provider) {
      provider = createProvider(providerId, "online")
      providers.set(cacheKey, provider)
    }
    return provider
  }
  const loadProject = async (project?: string) => {
    const ctx = await access.loadProject(project)
    const dir = path.dirname(ctx.loaded.path)
    // Env loading never overrides, so a second project whose files name a
    // credential this process already holds with another value would run on
    // the first project's account. Refuse that instead of guessing.
    const declared = readEnvFiles(dir)
    const credentialNames = new Set(availableProviders().flatMap((id) => providerCredentialEnvs(providerFactory(id))))
    for (const [name, value] of Object.entries(declared)) {
      if (credentialNames.has(name) && name in process.env && process.env[name] !== value) {
        throw new Error(
          `${path.relative(process.cwd(), dir) || "."} sets ${name} to a different value than the one this ` +
            "gallery already loaded; run a separate gallery for that project so its work uses its own account.",
        )
      }
    }
    loadEnvFiles(dir)
    return ctx
  }
  const server = await serveGallery({
    load: () => {
      if (first) {
        first = false
        return Promise.resolve(initial)
      }
      return reload()
    },
    port: args.port,
    open: !args.noOpen,
    onProgress: log,
    onReady: (url) => announceGalleryReady(
      url, initial.snapshot.totals.entries, undefined, undefined, args.edit, budget ? describeBudget(budget) : null,
    ),
    ...(args.edit
      ? { edit: createGalleryEditHandler({ manifestFor: access.manifestFor, loadProject: access.loadProject, reload, onProgress: log }) }
      : {}),
    ...(budget
      ? { generate: createGenerateHandlers({ loadProject, providerFor, budget, reload, onProgress: log }) }
      : {}),
    // Estimating acts on the author's behalf and feeds a manifest edit, so it follows the write gate.
    ...(args.edit ? { skeleton: createGallerySkeletonHandlers({ loadProject, limit: args.estimateLimit, onProgress: log }) } : {}),
    // The editor exists to write hand edits back, so it follows the write gate.
    ...(args.edit && !args.noEditor ? { editor: createGalleryEditorHandlers({ onProgress: log }) } : {}),
  })
  await new Promise<void>((resolve) => {
    const stop = () => {
      process.off("SIGINT", stop)
      process.off("SIGTERM", stop)
      resolve()
    }
    process.once("SIGINT", stop)
    process.once("SIGTERM", stop)
  })
  await server.close()
  log("\n  gallery closed")
}

export async function runGallery(args: Args): Promise<void> {
  // A workspace gallery needs no manifest in cwd: every project comes from
  // the catalog, the same way `workspace status` reads them.
  if (args.workspace) {
    const workspacePath = path.resolve(args.workspace)
    if (!existsSync(workspacePath)) {
      throw new Error(`Workspace catalog not found: ${workspacePath}`)
    }
    const filter = { styles: args.styles, assets: args.assets }
    const build = async () =>
      buildWorkspaceGallerySnapshot({
        workspace: await loadWorkspace(workspacePath),
        workspacePath,
        filter,
      })
    const initial = await build()
    if (args.json) {
      log(JSON.stringify(initial.snapshot, null, 2))
      return
    }
    for (const project of initial.snapshot.workspace?.projects ?? []) {
      if (project.error) log(`  ${project.id}: unreadable: ${project.error}`)
    }
    // Re-read the catalog on every write so an edit or job targets the
    // project as registered now, never a path captured when the server started.
    const registered = async (projectId?: string) => {
      const project = (await loadWorkspace(workspacePath)).projects.find((candidate) => candidate.id === projectId)
      if (!projectId || !project) throw new Error(`unknown workspace project "${projectId ?? ""}"`)
      return resolveProject(path.dirname(workspacePath), project)
    }
    await serveUntilStopped(initial, build, args, {
      manifestFor: async (projectId) => (await registered(projectId)).manifestPath,
      // Env is handled by serveUntilStopped, which refuses a project whose
      // files would put this gallery on a different account.
      loadProject: async (projectId) => {
        const { manifestPath, lockPath } = await registered(projectId)
        return openLibraryProject(manifestPath, { lockPath, env: false })
      },
    })
    return
  }

  const { loaded, specs, lock } = await openProject(args)
  const filter = { styles: args.styles, assets: args.assets }
  const build = () => buildGallerySnapshot({ loaded, specs, lock, lockPath: args.lock, filter })
  if (args.json) {
    log(JSON.stringify((await build()).snapshot, null, 2))
    return
  }
  // Re-read state on every refresh: the lockfile may have moved on since
  // the server started, and a stale in-memory copy would show old art.
  const reload = async () => {
    const fresh = await openLibraryProject(args.manifest, { lockPath: args.lock, ...filter, env: false })
    return buildGallerySnapshot({ ...fresh, filter })
  }
  await serveUntilStopped(await build(), reload, args, {
    manifestFor: () => path.resolve(args.manifest),
    loadProject: () => openLibraryProject(args.manifest, { lockPath: args.lock, env: false }),
  })
}
