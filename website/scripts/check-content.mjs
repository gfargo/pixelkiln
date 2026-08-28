import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const websiteRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = path.resolve(websiteRoot, "..");
const registry = readFileSync(path.join(websiteRoot, "app/lib/docs.ts"), "utf8");
const files = [...registry.matchAll(/file:\s*"([^"]+\.md)"/g)].map((match) => match[1]);
const slugs = [...registry.matchAll(/slug:\s*"([^"]+)"/g)].map((match) => match[1]);
const failures = [];

for (const file of files) {
  if (!existsSync(path.join(repoRoot, file))) failures.push(`missing source: ${file}`);
}

for (const [label, values] of [["file", files], ["slug", slugs]]) {
  for (const value of new Set(values)) {
    if (values.filter((candidate) => candidate === value).length > 1) {
      failures.push(`duplicate ${label}: ${value}`);
    }
  }
}

const canonical = readdirSync(path.join(repoRoot, "docs"))
  .filter((file) => file.endsWith(".md") && file !== "README.md")
  .map((file) => `docs/${file}`);

for (const file of canonical) {
  if (!files.includes(file)) failures.push(`unpublished canonical guide: ${file}`);
}

for (const file of ["CONTRIBUTING.md", "SECURITY.md", "PROVIDERS.md", "NAMING.md"]) {
  if (!files.includes(file)) failures.push(`unpublished project guide: ${file}`);
}

if (files.length !== slugs.length) {
  failures.push(`documentation registry has ${files.length} files but ${slugs.length} slugs`);
}

if (failures.length) {
  console.error("Website content checks failed:\n");
  for (const failure of failures) console.error(`- ${failure}`);
  process.exitCode = 1;
} else {
  console.log(`website content check passed: ${files.length} canonical routes`);
}
