import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { execFileSync } from "node:child_process"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { analyzeCommits } from "../scripts/release-plugins/skill-release-analyzer.mjs"

let dir: string

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "skill-release-analyzer-"))
  const git = (...args: string[]) => execFileSync("git", args, { cwd: dir })
  git("init", "--quiet", "--initial-branch=main")
  git("config", "user.email", "test@example.com")
  git("config", "user.name", "Test")
})
afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

async function commit(files: Record<string, string>, message: string): Promise<string> {
  for (const [file, contents] of Object.entries(files)) {
    const full = path.join(dir, file)
    await mkdir(path.dirname(full), { recursive: true })
    await writeFile(full, contents)
  }
  execFileSync("git", ["add", "-A"], { cwd: dir })
  execFileSync("git", ["commit", "--quiet", "-m", message], { cwd: dir })
  return execFileSync("git", ["rev-parse", "HEAD"], { cwd: dir }).toString().trim()
}

function fakeLogger() {
  return { log: () => {}, error: () => {} }
}

describe("skill-release-analyzer", () => {
  it("forces a patch release when a commit touches skills/pixelkiln/", async () => {
    const hash = await commit({ "skills/pixelkiln/references/pixellab.md": "content" }, "docs(pixellab): tweak")
    const release = await analyzeCommits(
      {},
      { commits: [{ hash }], cwd: dir, env: process.env, logger: fakeLogger() },
    )
    expect(release).toBe("patch")
  })

  it("returns null for a commit that never touches skills/pixelkiln/", async () => {
    const hash = await commit({ "docs/PIXELLAB.md": "content" }, "docs(pixellab): tweak")
    const release = await analyzeCommits(
      {},
      { commits: [{ hash }], cwd: dir, env: process.env, logger: fakeLogger() },
    )
    expect(release).toBeNull()
  })

  it("does not trigger on a path that merely starts similarly (skills/pixelkiln-extra/)", async () => {
    const hash = await commit({ "skills/pixelkiln-extra/note.md": "content" }, "docs: unrelated")
    const release = await analyzeCommits(
      {},
      { commits: [{ hash }], cwd: dir, env: process.env, logger: fakeLogger() },
    )
    expect(release).toBeNull()
  })

  it("finds a skills/pixelkiln/ touch anywhere in a multi-commit range", async () => {
    const first = await commit({ "docs/PIXELLAB.md": "a" }, "docs(pixellab): a")
    const second = await commit({ "skills/pixelkiln/SKILL.md": "b" }, "docs(pixellab): b")
    const release = await analyzeCommits(
      {},
      { commits: [{ hash: first }, { hash: second }], cwd: dir, env: process.env, logger: fakeLogger() },
    )
    expect(release).toBe("patch")
  })

  it("returns null for an empty commit range", async () => {
    const release = await analyzeCommits(
      {},
      { commits: [], cwd: dir, env: process.env, logger: fakeLogger() },
    )
    expect(release).toBeNull()
  })
})
