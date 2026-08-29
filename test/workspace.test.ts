import { describe, expect, it, beforeEach, afterEach } from "vitest"
import { mkdtemp, writeFile, mkdir, cp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import {
  parseWorkspace,
  loadWorkspace,
  saveWorkspace,
  toPortablePath,
  resolveProject,
  validateWorkspace,
  type Workspace,
  type WorkspaceProject,
} from "../src/workspace.ts"
import { workspaceClaims, workspaceStatus } from "../src/pipeline/workspace.ts"
import { loadClaims, findOrphans } from "../src/pipeline/salvage.ts"
import { FakeProvider } from "../src/providers/fake.ts"
import { buildPlan, summarize } from "../src/pipeline/plan.ts"
import { loadManifest, resolveSpecs } from "../src/manifest.ts"
import { loadLock } from "../src/lock.ts"
import type { LockEntry } from "../src/types.ts"

let dir: string
beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "pixelkiln-workspace-"))
})
afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

function entry(overrides: Partial<LockEntry> = {}): LockEntry {
  return {
    styleId: "base", assetId: "anvil", specHash: "h", generator: "map",
    tileFeature: null, prompt: "an anvil", width: 32, height: 32,
    jobId: null, reviewObjectId: null, objectId: "object", candidateIndex: null,
    status: "downloaded", error: null, sourceUrl: null, sourceUrls: [],
    outputs: [], submittedAt: null, downloadedAt: null,
    cost: 1, costUnit: "generations", provider: "pixellab",
    providerMetadata: {},
    ...overrides,
  }
}

/** Writes a minimal valid project (manifest + optional lock) under `root`. */
async function writeProject(
  root: string,
  name: string,
  opts: { entries?: Record<string, unknown>; skipLock?: boolean } = {},
): Promise<{ manifestPath: string; lockPath: string }> {
  await mkdir(root, { recursive: true })
  const manifestPath = path.join(root, "pixelkiln.manifest.json")
  await writeFile(
    manifestPath,
    JSON.stringify({
      name,
      styles: { base: { generator: "map", outDir: "out" } },
      assets: { anvil: { prompt: "an anvil" } },
    }),
  )
  const lockPath = path.join(root, "pixelkiln.lock.json")
  if (!opts.skipLock) {
    await writeFile(lockPath, JSON.stringify({ version: 2, entries: opts.entries ?? {} }))
  }
  return { manifestPath, lockPath }
}

describe("parseWorkspace / load / save", () => {
  it("round-trips a catalog with portable, forward-slash relative paths", async () => {
    const { manifestPath, lockPath } = await writeProject(path.join(dir, "alpha"), "alpha", {
      entries: { "base/anvil": entry() },
    })
    const project: WorkspaceProject = {
      id: "alpha",
      manifest: toPortablePath(dir, manifestPath),
      lock: toPortablePath(dir, lockPath),
      provider: "pixellab",
    }
    expect(project.manifest).toBe("alpha/pixelkiln.manifest.json")
    expect(project.manifest).not.toContain(path.sep === "/" ? "\\" : "/does-not-apply")

    const catalogPath = path.join(dir, "pixelkiln.workspace.json")
    await saveWorkspace(catalogPath, { version: 1, projects: [project] })
    const reloaded = await loadWorkspace(catalogPath)
    expect(reloaded).toEqual({ version: 1, projects: [project] })

    const resolved = resolveProject(path.dirname(catalogPath), project)
    expect(resolved.manifestPath).toBe(manifestPath)
    expect(resolved.lockPath).toBe(lockPath)
  })

  it("still resolves after the whole tree is moved to a new parent directory", async () => {
    const { manifestPath, lockPath } = await writeProject(path.join(dir, "proj"), "proj")
    const project: WorkspaceProject = {
      id: "proj",
      manifest: toPortablePath(dir, manifestPath),
      lock: toPortablePath(dir, lockPath),
      provider: "pixellab",
    }
    const catalogPath = path.join(dir, "pixelkiln.workspace.json")
    await saveWorkspace(catalogPath, { version: 1, projects: [project] })

    const movedRoot = await mkdtemp(path.join(tmpdir(), "pixelkiln-workspace-moved-"))
    await cp(dir, path.join(movedRoot, "tree"), { recursive: true })
    const movedCatalog = path.join(movedRoot, "tree", "pixelkiln.workspace.json")
    const movedWs = await loadWorkspace(movedCatalog)
    const resolved = resolveProject(path.dirname(movedCatalog), movedWs.projects[0]!)
    expect(resolved.manifestPath).toBe(path.join(movedRoot, "tree", "proj", "pixelkiln.manifest.json"))

    const { existsSync } = await import("node:fs")
    expect(existsSync(resolved.manifestPath)).toBe(true)
    expect(existsSync(resolved.lockPath)).toBe(true)
    await rm(movedRoot, { recursive: true, force: true })
  })

  it("rejects a catalog that is not v1", () => {
    expect(() => parseWorkspace({ version: 2, projects: [] })).toThrow(/not valid v1/)
  })

  it("rejects an unknown key", () => {
    expect(() =>
      parseWorkspace({ version: 1, projects: [], extra: true }),
    ).toThrow(/not valid v1/)
  })

  it("loadWorkspace returns an empty catalog when no file exists yet", async () => {
    expect(await loadWorkspace(path.join(dir, "nope.workspace.json"))).toEqual({
      version: 1,
      projects: [],
    })
  })
})

describe("validateWorkspace", () => {
  it("flags a duplicate project id as an error", async () => {
    const a = await writeProject(path.join(dir, "a"), "a")
    const b = await writeProject(path.join(dir, "b"), "b")
    const ws: Workspace = {
      version: 1,
      projects: [
        { id: "dup", manifest: toPortablePath(dir, a.manifestPath), lock: toPortablePath(dir, a.lockPath), provider: "pixellab" },
        { id: "dup", manifest: toPortablePath(dir, b.manifestPath), lock: toPortablePath(dir, b.lockPath), provider: "pixellab" },
      ],
    }
    const diagnostics = validateWorkspace(ws, dir)
    expect(diagnostics).toContainEqual(expect.objectContaining({ id: "duplicate-id", level: "error" }))
  })

  it("flags a duplicate lock path as an error", async () => {
    const a = await writeProject(path.join(dir, "a"), "a")
    const ws: Workspace = {
      version: 1,
      projects: [
        { id: "one", manifest: toPortablePath(dir, a.manifestPath), lock: toPortablePath(dir, a.lockPath), provider: "pixellab" },
        { id: "two", manifest: toPortablePath(dir, a.manifestPath), lock: toPortablePath(dir, a.lockPath), provider: "pixellab" },
      ],
    }
    const diagnostics = validateWorkspace(ws, dir)
    expect(diagnostics).toContainEqual(expect.objectContaining({ id: "duplicate-lock", level: "error" }))
  })

  it("flags a duplicate manifest as a warning only (variant lockfiles are a supported pattern)", async () => {
    const a = await writeProject(path.join(dir, "a"), "a")
    const variantLock = path.join(dir, "a", "variant.lock.json")
    await writeFile(variantLock, JSON.stringify({ version: 2, entries: {} }))
    const ws: Workspace = {
      version: 1,
      projects: [
        { id: "one", manifest: toPortablePath(dir, a.manifestPath), lock: toPortablePath(dir, a.lockPath), provider: "pixellab" },
        { id: "two", manifest: toPortablePath(dir, a.manifestPath), lock: toPortablePath(dir, variantLock), provider: "pixellab" },
      ],
    }
    const diagnostics = validateWorkspace(ws, dir)
    expect(diagnostics).toContainEqual(expect.objectContaining({ id: "duplicate-manifest", level: "warning" }))
    expect(diagnostics.some((d) => d.id === "duplicate-lock")).toBe(false)
  })

  it("flags a missing manifest and a missing lock as errors", async () => {
    const ws: Workspace = {
      version: 1,
      projects: [{ id: "ghost", manifest: "ghost/pixelkiln.manifest.json", lock: "ghost/pixelkiln.lock.json", provider: "pixellab" }],
    }
    const diagnostics = validateWorkspace(ws, dir)
    expect(diagnostics).toContainEqual(expect.objectContaining({ id: "missing-manifest", level: "error" }))
    expect(diagnostics).toContainEqual(expect.objectContaining({ id: "missing-lock", level: "error" }))
  })

  it("flags an absolute stored path as a warning", async () => {
    const a = await writeProject(path.join(dir, "a"), "a")
    const ws: Workspace = {
      version: 1,
      projects: [{ id: "abs", manifest: a.manifestPath, lock: toPortablePath(dir, a.lockPath), provider: "pixellab" }],
    }
    const diagnostics = validateWorkspace(ws, dir)
    expect(diagnostics).toContainEqual(expect.objectContaining({ id: "absolute-path", level: "warning" }))
  })

  it("flags mixed providers across registered projects as a warning", async () => {
    const a = await writeProject(path.join(dir, "a"), "a")
    const b = await writeProject(path.join(dir, "b"), "b")
    const ws: Workspace = {
      version: 1,
      projects: [
        { id: "a", manifest: toPortablePath(dir, a.manifestPath), lock: toPortablePath(dir, a.lockPath), provider: "pixellab" },
        { id: "b", manifest: toPortablePath(dir, b.manifestPath), lock: toPortablePath(dir, b.lockPath), provider: "other-provider" },
      ],
    }
    const diagnostics = validateWorkspace(ws, dir)
    expect(diagnostics).toContainEqual(expect.objectContaining({ id: "mixed-provider", level: "warning" }))
  })

  it("reports nothing for a clean, fully-resolvable catalog", async () => {
    const a = await writeProject(path.join(dir, "a"), "a")
    const ws: Workspace = {
      version: 1,
      projects: [{ id: "a", manifest: toPortablePath(dir, a.manifestPath), lock: toPortablePath(dir, a.lockPath), provider: "pixellab" }],
    }
    expect(validateWorkspace(ws, dir)).toEqual([])
  })
})

describe("workspaceClaims", () => {
  it("unions object/review/job ids across every registered lock, matching loadClaims directly", async () => {
    const a = await writeProject(path.join(dir, "a"), "a", {
      entries: { "base/one": entry({ objectId: "obj-1", reviewObjectId: "rev-1" }) },
    })
    const b = await writeProject(path.join(dir, "b"), "b", {
      entries: { "base/two": entry({ objectId: "obj-2", jobId: "job-2" }) },
    })
    const ws: Workspace = {
      version: 1,
      projects: [
        { id: "a", manifest: toPortablePath(dir, a.manifestPath), lock: toPortablePath(dir, a.lockPath), provider: "pixellab" },
        { id: "b", manifest: toPortablePath(dir, b.manifestPath), lock: toPortablePath(dir, b.lockPath), provider: "pixellab" },
      ],
    }

    const result = await workspaceClaims(ws, dir)
    const direct = await loadClaims([a.lockPath, b.lockPath])
    expect(result.claimed).toEqual(direct)
    expect(result.claimed).toEqual(new Set(["obj-1", "rev-1", "obj-2", "job-2"]))
    expect(result.byProject).toEqual({ a: 2, b: 2 })
  })

  it("rejects with the project id when a registered lock is missing, never silently skipping it", async () => {
    const a = await writeProject(path.join(dir, "a"), "a", { entries: { "base/one": entry({ objectId: "obj-1" }) } })
    const b = await writeProject(path.join(dir, "b"), "b", { skipLock: true })
    const ws: Workspace = {
      version: 1,
      projects: [
        { id: "alpha", manifest: toPortablePath(dir, a.manifestPath), lock: toPortablePath(dir, a.lockPath), provider: "pixellab" },
        { id: "beta", manifest: toPortablePath(dir, b.manifestPath), lock: toPortablePath(dir, b.lockPath), provider: "pixellab" },
      ],
    }
    await expect(workspaceClaims(ws, dir)).rejects.toThrow(/"beta"/)
  })

  // Acceptance-critical: a missing registered lock must abort before ANY
  // account-wide orphan classification runs, not after a partial scan.
  it("a rejected claim set means findOrphans is never reached, and the provider's list is never called", async () => {
    const a = await writeProject(path.join(dir, "a"), "a", { entries: {} })
    const b = await writeProject(path.join(dir, "b"), "b", { skipLock: true })
    const ws: Workspace = {
      version: 1,
      projects: [
        { id: "alpha", manifest: toPortablePath(dir, a.manifestPath), lock: toPortablePath(dir, a.lockPath), provider: "pixellab" },
        { id: "beta", manifest: toPortablePath(dir, b.manifestPath), lock: toPortablePath(dir, b.lockPath), provider: "pixellab" },
      ],
    }

    const provider = new FakeProvider()
    let listCalled = false
    provider.list = async function* () {
      listCalled = true
    }

    let reachedFindOrphans = false
    try {
      const claims = await workspaceClaims(ws, dir)
      reachedFindOrphans = true
      await findOrphans(provider, claims.claimed)
    } catch {
      // expected: workspaceClaims itself throws
    }

    expect(reachedFindOrphans).toBe(false)
    expect(listCalled).toBe(false)
  })
})

describe("workspaceStatus", () => {
  it("reports stable per-project state totals matching buildPlan/summarize directly", async () => {
    const a = await writeProject(path.join(dir, "a"), "a", {
      entries: { "base/anvil": entry({ specHash: "h" }) },
    })
    const ws: Workspace = {
      version: 1,
      projects: [{ id: "a", manifest: toPortablePath(dir, a.manifestPath), lock: toPortablePath(dir, a.lockPath), provider: "pixellab" }],
    }

    const report = await workspaceStatus(ws, dir)
    expect(report.version).toBe(1)
    expect(report.projects).toHaveLength(1)
    const project = report.projects[0]!
    expect(project.error).toBeNull()

    const loaded = await loadManifest(a.manifestPath)
    const specs = await resolveSpecs(loaded)
    const lock = await loadLock(a.lockPath)
    const plan = await buildPlan(specs, lock)
    expect(project.byState).toEqual(summarize(plan))
  })

  it("keeps spend separate by cost unit, in aggregate and per project, never summing across units", async () => {
    const a = await writeProject(path.join(dir, "a"), "a", {
      entries: { "base/anvil": entry({ cost: 5, costUnit: "generations" }) },
    })
    const b = await writeProject(path.join(dir, "b"), "b", {
      entries: { "base/anvil": entry({ cost: 2.5, costUnit: "usd" }) },
    })
    const ws: Workspace = {
      version: 1,
      projects: [
        { id: "a", manifest: toPortablePath(dir, a.manifestPath), lock: toPortablePath(dir, a.lockPath), provider: "pixellab" },
        { id: "b", manifest: toPortablePath(dir, b.manifestPath), lock: toPortablePath(dir, b.lockPath), provider: "pixellab" },
      ],
    }

    const report = await workspaceStatus(ws, dir)
    const projectA = report.projects.find((p) => p.id === "a")!
    const projectB = report.projects.find((p) => p.id === "b")!
    expect(projectA.spendByUnit).toEqual({ generations: 5, usd: 0, free: 0 })
    expect(projectB.spendByUnit).toEqual({ generations: 0, usd: 2.5, free: 0 })
    expect(report.totals.spendByUnit).toEqual({ generations: 5, usd: 2.5, free: 0 })
  })

  it("surfaces a project whose manifest fails to load as that project's own error, not a thrown report", async () => {
    const good = await writeProject(path.join(dir, "good"), "good")
    const badDir = path.join(dir, "bad")
    await mkdir(badDir, { recursive: true })
    const badManifestPath = path.join(badDir, "pixelkiln.manifest.json")
    await writeFile(badManifestPath, "{ not valid json")
    const badLockPath = path.join(badDir, "pixelkiln.lock.json")
    await writeFile(badLockPath, JSON.stringify({ version: 2, entries: {} }))

    const ws: Workspace = {
      version: 1,
      projects: [
        { id: "good", manifest: toPortablePath(dir, good.manifestPath), lock: toPortablePath(dir, good.lockPath), provider: "pixellab" },
        { id: "bad", manifest: toPortablePath(dir, badManifestPath), lock: toPortablePath(dir, badLockPath), provider: "pixellab" },
      ],
    }

    const report = await workspaceStatus(ws, dir)
    expect(report.safe).toBe(false)
    const goodProject = report.projects.find((p) => p.id === "good")!
    const badProject = report.projects.find((p) => p.id === "bad")!
    expect(goodProject.error).toBeNull()
    expect(badProject.error).not.toBeNull()
  })
})
