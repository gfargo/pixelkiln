import { readFileSync } from "node:fs"

const workflow = readFileSync(".github/workflows/release.yml", "utf8")
const ciWorkflow = readFileSync(".github/workflows/ci.yml", "utf8")
const config = JSON.parse(readFileSync(".releaserc.json", "utf8"))
const pkg = JSON.parse(readFileSync("package.json", "utf8"))
const websitePkg = JSON.parse(readFileSync("website/package.json", "utf8"))
const defaultNode = readFileSync(".nvmrc", "utf8").trim()
const failures = []

function requireText(source, value, label) {
  if (!source.includes(value)) failures.push(`${label} is missing ${JSON.stringify(value)}`)
}

requireText(workflow, "id-token: write", "release workflow")
requireText(workflow, "runs-on: ubuntu-latest", "release workflow")
requireText(workflow, "fetch-depth: 0", "release workflow")
requireText(workflow, "registry-url: https://registry.npmjs.org", "release workflow")
requireText(workflow, "package-manager-cache: false", "release workflow")
requireText(workflow, "npm install --global npm@11", "release workflow")
requireText(workflow, "npm run test:release", "release workflow")
requireText(workflow, "npm run test:docs", "release workflow")
requireText(workflow, "npm run test:security", "release workflow")
requireText(workflow, "npm run test:package", "release workflow")
requireText(ciWorkflow, "npm run test:security", "CI workflow")
requireText(workflow, "cancel-in-progress: false", "release workflow")
requireText(ciWorkflow, "node: [22, 24]", "CI workflow")
requireText(ciWorkflow, "node-version: 24", "website CI workflow")

if (/\bNPM_TOKEN\b/.test(workflow)) failures.push("release workflow must not use NPM_TOKEN")
if (!config.branches?.includes("main")) failures.push("Semantic Release must publish from main")

const pluginNames = config.plugins.map((plugin) => Array.isArray(plugin) ? plugin[0] : plugin)
for (const plugin of [
  "@semantic-release/commit-analyzer",
  "@semantic-release/release-notes-generator",
  "@semantic-release/changelog",
  "@semantic-release/npm",
  "@semantic-release/github",
  "@semantic-release/git",
]) {
  if (!pluginNames.includes(plugin)) failures.push(`Semantic Release is missing ${plugin}`)
}

if (pkg.repository?.url !== "git+https://github.com/gfargo/pixelkiln.git") {
  failures.push("package repository URL must exactly match the trusted GitHub repository")
}
if (pkg.publishConfig?.access !== "public") failures.push("npm publish access must be public")
if (pkg.engines?.node !== ">=22") failures.push("package Node.js support must start at Node 22")
if (websitePkg.engines?.node !== ">=22") failures.push("website Node.js support must start at Node 22")
if (defaultNode !== "24") failures.push(".nvmrc must track the Node 24 LTS release line")

if (failures.length) {
  console.error("Release configuration checks failed:\n")
  for (const failure of failures) console.error(`- ${failure}`)
  process.exitCode = 1
} else {
  console.log("release configuration check passed: OIDC, provenance prerequisites, and plugins")
}
