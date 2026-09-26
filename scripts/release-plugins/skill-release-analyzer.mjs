import { execFileSync } from "node:child_process"

/**
 * `skills/pixelkiln/` ships as executable agent guidance, not prose
 * commentary: it is the exact directory the public `gfargo/skills` tap
 * mirrors on every new release tag (see CONTRIBUTING.md, "Releases"). A
 * change there that lands in a `docs:`-typed commit — accurate, since it
 * reads as a documentation change to a human — would otherwise cut no
 * release at all under `@semantic-release/commit-analyzer`'s default rules,
 * which silently strands it: no tag, so the skills tap never sees it.
 *
 * `analyzeCommits` steps merge by taking the highest release type any
 * plugin returns, so this only ever raises a release that would not
 * otherwise happen (or agrees with a higher one `commit-analyzer` already
 * decided); it never downgrades or blocks one.
 */
export async function analyzeCommits(pluginConfig, context) {
  const { commits, cwd, env, logger } = context
  for (const commit of commits) {
    let files
    try {
      // --root: without it, diff-tree reports no files for a commit with no
      // parent (a repository's very first commit) since it has nothing to
      // diff against; harmless for every other commit.
      files = execFileSync("git", ["diff-tree", "--no-commit-id", "--name-only", "-r", "--root", commit.hash], {
        cwd,
        env,
        encoding: "utf8",
      })
        .split("\n")
        .filter(Boolean)
    } catch (error) {
      logger.error(`skill-release-analyzer: could not read files touched by ${commit.hash}: ${error.message}`)
      continue
    }
    if (files.some((file) => file.startsWith("skills/pixelkiln/"))) {
      logger.log(
        `skill-release-analyzer: ${commit.hash} touches skills/pixelkiln/, forcing at least a patch release`,
      )
      return "patch"
    }
  }
  return null
}
