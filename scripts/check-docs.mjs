import { existsSync, readFileSync, readdirSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const failures = []

function markdownFiles(directory) {
  if (!existsSync(directory)) return []
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const resolved = path.join(directory, entry.name)
    if (entry.isDirectory()) return markdownFiles(resolved)
    return entry.isFile() && entry.name.endsWith(".md") ? [resolved] : []
  })
}

const markdown = [
  ...["README.md", "CONTRIBUTING.md", "SECURITY.md", "PROVIDERS.md", "NAMING.md"]
    .map((file) => path.join(root, file))
    .filter(existsSync),
  ...markdownFiles(path.join(root, "docs")),
  ...markdownFiles(path.join(root, "examples")),
  ...markdownFiles(path.join(root, "skills")),
]

for (const file of markdown) {
  const source = readFileSync(file, "utf8")
  const links = source.matchAll(/!?\[[^\]]*\]\(([^)]+)\)/g)
  for (const match of links) {
    let target = match[1].trim()
    if (target.startsWith("<")) target = target.slice(1, target.indexOf(">"))
    else target = target.split(/\s+["']/)[0]

    if (/^(?:https?:|mailto:|#)/.test(target)) continue
    const withoutAnchor = target.split(/[?#]/, 1)[0]
    if (!withoutAnchor) continue

    const resolved = path.resolve(path.dirname(file), decodeURIComponent(withoutAnchor))
    if (!existsSync(resolved)) {
      failures.push(`${path.relative(root, file)} links to missing ${target}`)
    }
  }
}

const readme = readFileSync(path.join(root, "README.md"), "utf8")
const readmeLines = readme.split(/\r?\n/).length
if (readmeLines > 400) {
  failures.push(`README.md is ${readmeLines} lines; keep the landing page at or below 400 lines`)
}

const docsIndex = readFileSync(path.join(root, "docs", "README.md"), "utf8")
for (const file of markdownFiles(path.join(root, "docs"))) {
  if (path.basename(file) === "README.md") continue
  const relative = path.relative(path.join(root, "docs"), file).split(path.sep).join("/")
  if (!docsIndex.includes(`(${relative})`) && !docsIndex.includes(`(./${relative})`)) {
    failures.push(`docs/README.md does not link to docs/${relative}`)
  }
}

const skillRoot = path.join(root, "skills", "pixelkiln")
const skillEntry = readFileSync(path.join(skillRoot, "SKILL.md"), "utf8")
for (const reference of markdownFiles(path.join(skillRoot, "references"))) {
  const relative = path.relative(skillRoot, reference).split(path.sep).join("/")
  if (!skillEntry.includes(`(${relative})`)) {
    failures.push(`skills/pixelkiln/SKILL.md does not route to ${relative}`)
  }
}

const cli = readFileSync(path.join(root, "src", "cli.ts"), "utf8")
const cliDocs = readFileSync(path.join(root, "docs", "CLI.md"), "utf8")

function valuesFromArray(name) {
  const match = cli.match(new RegExp(`(?:export\\s+)?const\\s+${name}\\s*=\\s*\\[([\\s\\S]*?)\\]\\s+as const`))
  if (!match) throw new Error(`Could not find ${name} in src/cli.ts`)
  return [...match[1].matchAll(/"([^"]+)"/g)].map((entry) => entry[1])
}

const commands = valuesFromArray("COMMANDS")
const documentedCommands = commands.filter((command) => !command.startsWith("-"))
for (const command of documentedCommands) {
  if (!cliDocs.includes(`### \`${command}\``)) {
    failures.push(`docs/CLI.md is missing a section for the ${command} command`)
  }
}

const flags = [...new Set([...valuesFromArray("VALUE_FLAGS"), ...valuesFromArray("BOOL_FLAGS")])]
for (const flag of flags) {
  if (!cliDocs.includes(`\`${flag}`)) {
    failures.push(`docs/CLI.md does not mention ${flag}`)
  }
}

for (const alias of commands.filter((command) => command.startsWith("-"))) {
  if (!cliDocs.includes(`\`${alias}\``)) {
    failures.push(`docs/CLI.md does not mention the ${alias} alias`)
  }
}

if (failures.length > 0) {
  console.error("Documentation checks failed:\n")
  for (const failure of failures) console.error(`- ${failure}`)
  process.exitCode = 1
} else {
  console.log(
    `docs check passed: ${markdown.length} Markdown files, ${documentedCommands.length} commands, ${flags.length} flags`,
  )
}
