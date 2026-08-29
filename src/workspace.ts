import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises"
import { existsSync } from "node:fs"
import path from "node:path"
import { z } from "zod"

/**
 * One sibling project registered in a workspace catalog. Only paths and
 * identity live here — never a credential. Each project keeps loading its own
 * key from its own `.env`, the same as it does standalone.
 */
export const WorkspaceProjectSchema = z
  .object({
    id: z.string().min(1),
    /** Manifest path, relative to the catalog file's own directory. */
    manifest: z.string().min(1),
    /** Lockfile path, relative to the catalog file's own directory. */
    lock: z.string().min(1),
    provider: z.string().min(1).default("pixellab"),
    /** Free-form label for a shared account, e.g. distinguishing sandboxes. */
    account: z.string().optional(),
  })
  .strict()

export const WorkspaceSchema = z
  .object({
    version: z.literal(1),
    projects: z.array(WorkspaceProjectSchema).default([]),
  })
  .strict()

export type WorkspaceProject = z.infer<typeof WorkspaceProjectSchema>
export type Workspace = z.infer<typeof WorkspaceSchema>

/**
 * Parses a workspace catalog, rejecting anything that is not v1.
 *
 * Mirrors `parseLock`'s stance: no migration path, fail loudly rather than
 * guess at a hand-edited or corrupted file's intent.
 */
export function parseWorkspace(raw: unknown): Workspace {
  const parsed = WorkspaceSchema.safeParse(raw)
  if (parsed.success) return parsed.data
  throw new Error(
    `Workspace catalog is not valid v1:\n${parsed.error.issues
      .slice(0, 5)
      .map((i) => `  ${i.path.join(".")}: ${i.message}`)
      .join("\n")}`,
  )
}

export async function loadWorkspace(workspacePath: string): Promise<Workspace> {
  if (!existsSync(workspacePath)) return { version: 1, projects: [] }
  let raw: unknown
  try {
    raw = JSON.parse(await readFile(workspacePath, "utf8"))
  } catch (err) {
    throw new Error(
      `Workspace catalog at ${workspacePath} is malformed:\n` +
        `${err instanceof Error ? err.message : String(err)}`,
    )
  }
  return parseWorkspace(raw)
}

/** Atomic write — a crash mid-save must not leave a truncated catalog. */
export async function saveWorkspace(workspacePath: string, ws: Workspace): Promise<void> {
  const sorted: Workspace = {
    version: 1,
    projects: [...ws.projects].sort((a, b) => a.id.localeCompare(b.id)),
  }
  await mkdir(path.dirname(path.resolve(workspacePath)), { recursive: true })
  const tmp = `${workspacePath}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`
  try {
    await writeFile(tmp, JSON.stringify(sorted, null, 2) + "\n")
    await rename(tmp, workspacePath)
  } finally {
    await rm(tmp, { force: true })
  }
}

/** Stored path convention: relative to the catalog's directory, forward-slash. */
export function toPortablePath(dir: string, absolute: string): string {
  return path.relative(dir, absolute).split(path.sep).join("/")
}

/** Resolve a registered project's stored paths against the catalog's directory. */
export function resolveProject(
  dir: string,
  project: WorkspaceProject,
): { manifestPath: string; lockPath: string } {
  return {
    manifestPath: path.resolve(dir, project.manifest.split("/").join(path.sep)),
    lockPath: path.resolve(dir, project.lock.split("/").join(path.sep)),
  }
}

export interface WorkspaceDiagnostic {
  id:
    | "duplicate-id"
    | "duplicate-lock"
    | "duplicate-manifest"
    | "missing-manifest"
    | "missing-lock"
    | "absolute-path"
    | "mixed-provider"
  level: "error" | "warning"
  message: string
}

/**
 * Checks the catalog without touching the network or any registered
 * project's files. Duplicate ids and duplicate lock paths are errors — either
 * would corrupt the union claim set. A duplicate manifest is only a warning,
 * because a manifest paired with a variant `--lock` is an already-supported
 * pattern (see `cachePathFor`). Missing files are errors: a claim set derived
 * from a workspace that silently skipped a project is the exact hazard this
 * catalog exists to prevent.
 */
export function validateWorkspace(ws: Workspace, dir: string): WorkspaceDiagnostic[] {
  const diagnostics: WorkspaceDiagnostic[] = []

  const idCounts = new Map<string, number>()
  const lockOwners = new Map<string, string[]>()
  const manifestOwners = new Map<string, string[]>()

  for (const project of ws.projects) {
    idCounts.set(project.id, (idCounts.get(project.id) ?? 0) + 1)

    const { manifestPath, lockPath } = resolveProject(dir, project)
    lockOwners.set(lockPath, [...(lockOwners.get(lockPath) ?? []), project.id])
    manifestOwners.set(manifestPath, [...(manifestOwners.get(manifestPath) ?? []), project.id])

    if (path.isAbsolute(project.manifest) || path.isAbsolute(project.lock)) {
      diagnostics.push({
        id: "absolute-path",
        level: "warning",
        message:
          `project "${project.id}" stores an absolute path — the catalog will not resolve ` +
          `correctly if this tree is cloned or moved elsewhere`,
      })
    }
    if (!existsSync(manifestPath)) {
      diagnostics.push({
        id: "missing-manifest",
        level: "error",
        message: `project "${project.id}" manifest not found: ${manifestPath}`,
      })
    }
    if (!existsSync(lockPath)) {
      diagnostics.push({
        id: "missing-lock",
        level: "error",
        message: `project "${project.id}" lockfile not found: ${lockPath}`,
      })
    }
  }

  for (const [id, count] of idCounts) {
    if (count > 1) {
      diagnostics.push({
        id: "duplicate-id",
        level: "error",
        message: `project id "${id}" is registered ${count} times`,
      })
    }
  }
  for (const [lockPath, ids] of lockOwners) {
    if (ids.length > 1) {
      diagnostics.push({
        id: "duplicate-lock",
        level: "error",
        message: `${ids.join(", ")} all register the same lockfile: ${lockPath}`,
      })
    }
  }
  for (const [manifestPath, ids] of manifestOwners) {
    if (ids.length > 1) {
      diagnostics.push({
        id: "duplicate-manifest",
        level: "warning",
        message:
          `${ids.join(", ")} share manifest ${manifestPath} — expected only when they are ` +
          `variant lockfiles beside one manifest`,
      })
    }
  }

  const providers = new Set(ws.projects.map((p) => p.provider))
  if (providers.size > 1) {
    diagnostics.push({
      id: "mixed-provider",
      level: "warning",
      message:
        `registered projects use different providers: ${[...providers].sort().join(", ")} — ` +
        `spend totals are kept separate per unit, but confirm this is intentional`,
    })
  }

  return diagnostics
}
