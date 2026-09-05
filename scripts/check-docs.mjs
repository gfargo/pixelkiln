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

// Provider facts are repeated in the registry, setup guides, bundled skill,
// and marketing site. Keep a small explicit catalog here so adding or renaming
// an adapter cannot leave one of those surfaces behind.
const providerCatalog = [
  {
    id: "pixellab",
    name: "PixelLab",
    guide: "PIXELLAB.md",
    skillReference: "references/pixellab.md",
    credentials: ["PIXELLAB_API_KEY"],
    officialUrl: "https://www.pixellab.ai/",
  },
  {
    id: "retrodiffusion",
    name: "Retro Diffusion",
    guide: "RETRO_DIFFUSION.md",
    skillReference: "references/retro-diffusion.md",
    credentials: ["RD_API_KEY"],
    officialUrl: "https://www.retrodiffusion.ai/",
  },
  {
    id: "comfyui",
    name: "ComfyUI",
    guide: "COMFYUI.md",
    skillReference: "references/comfyui.md",
    credentials: [],
    officialUrl: "https://www.comfy.org/",
  },
  {
    id: "scenario",
    name: "Scenario",
    guide: "SCENARIO.md",
    skillReference: "references/scenario.md",
    credentials: ["SCENARIO_SDK_API_KEY", "SCENARIO_SDK_API_SECRET"],
    officialUrl: "https://www.scenario.com/",
  },
]

const registry = readFileSync(path.join(root, "src", "providers", "registry.ts"), "utf8")
const providerBlocks = new Map()
for (const match of registry.matchAll(/registerProvider\(\{([\s\S]*?)\n\}\)/g)) {
  const id = match[1].match(/\bid:\s*"([^"]+)"/)?.[1]
  if (id) providerBlocks.set(id, match[1])
}
const expectedProviderIds = providerCatalog.map((provider) => provider.id).sort()
const registeredProviderIds = [...providerBlocks.keys()].sort()
if (JSON.stringify(expectedProviderIds) !== JSON.stringify(registeredProviderIds)) {
  failures.push(
    `provider documentation catalog (${expectedProviderIds.join(", ")}) does not match registry ` +
      `(${registeredProviderIds.join(", ")})`,
  )
}

const website = readFileSync(path.join(root, "website", "app", "page.tsx"), "utf8")
for (const provider of providerCatalog) {
  const guidePath = path.join(root, "docs", provider.guide)
  if (!existsSync(guidePath)) {
    failures.push(`provider ${provider.id} is missing docs/${provider.guide}`)
    continue
  }
  const guide = readFileSync(guidePath, "utf8")
  if (!docsIndex.includes(`(./${provider.guide})`)) {
    failures.push(`docs/README.md does not list the ${provider.name} setup guide`)
  }
  if (!skillEntry.includes(`(${provider.skillReference})`)) {
    failures.push(`skills/pixelkiln/SKILL.md does not route to ${provider.skillReference}`)
  }
  if (!website.includes(`<h3>${provider.name}</h3>`)) {
    failures.push(`website provider section does not include ${provider.name}`)
  }
  if (!website.includes(`href="${provider.officialUrl}"`)) {
    failures.push(`website provider section does not link to ${provider.officialUrl}`)
  }
  const block = providerBlocks.get(provider.id) ?? ""
  for (const credential of provider.credentials) {
    if (!block.includes(`"${credential}"`)) {
      failures.push(`provider registry does not declare ${credential} for ${provider.id}`)
    }
    if (!guide.includes(credential)) {
      failures.push(`docs/${provider.guide} does not mention ${credential}`)
    }
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
    `docs check passed: ${markdown.length} Markdown files, ${documentedCommands.length} commands, ` +
      `${flags.length} flags, ${providerCatalog.length} providers`,
  )
}
