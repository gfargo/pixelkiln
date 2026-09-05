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

const routeSources = [
  "app/page.tsx",
  "app/ui/site-chrome.tsx",
].map((file) => ({ file, source: readFileSync(path.join(websiteRoot, file), "utf8") }));
const registeredSlugs = new Set(slugs);
for (const { file, source } of routeSources) {
  for (const match of source.matchAll(/href="\/docs\/([^"#?]+)[^\"]*"/g)) {
    if (!registeredSlugs.has(match[1])) {
      failures.push(`${file} links to unregistered documentation route: /docs/${match[1]}`);
    }
  }
}

const home = routeSources.find(({ file }) => file === "app/page.tsx").source;
const refinedSample = "/benchmarks/provider-hires/comfyui/refined/alpine-valley-128x128.png";
if (!home.includes(refinedSample)) {
  failures.push("provider results are missing the final-palette ComfyUI sample");
}
if (!existsSync(path.join(websiteRoot, "public", refinedSample.slice(1)))) {
  failures.push("provider results final-palette ComfyUI sample does not exist");
}
const refinedRecord = path.join(
  websiteRoot,
  "public/benchmarks/provider-hires/comfyui/refined/alpine-valley-128x128.pixelkiln.json",
);
if (!existsSync(refinedRecord)) {
  failures.push("provider results final-palette ComfyUI quality record does not exist");
} else {
  const quality = JSON.parse(readFileSync(refinedRecord, "utf8"));
  if (quality.kind !== "refine" || quality.options?.review?.status !== "pending") {
    failures.push("provider results quality record must remain pending until human review");
  }
}
if (!home.includes("https://www.retrodiffusion.ai/tools/pixel-art-fixer/")) {
  failures.push("provider results are missing the Pixel Art Fixer link");
}
if (!home.includes("48–128px native per part")) {
  failures.push("provider results are missing the ComfyUI native range");
}
if (!home.includes("Refinement automated; art review required")) {
  failures.push("provider results are missing the ComfyUI refinement boundary");
}
if (!home.includes('href="/docs/mixed-providers"')) {
  failures.push("provider results are missing the mixed-provider guide");
}
if (!home.includes("still needs manual") || !home.includes("art review")) {
  failures.push("provider results are missing the ComfyUI manual-review warning");
}
if (!home.includes('/benchmarks/provider-scenario-smoke/mountain-keep.png')) {
  failures.push("provider results are missing the paid Scenario smoke image");
}
if (!existsSync(path.join(repoRoot, "website/public/benchmarks/provider-scenario-smoke/mountain-keep.png"))) {
  failures.push("the paid Scenario smoke image is missing from website/public");
}
for (const [provider, route, official] of [
  ["PixelLab", "/docs/pixellab", "https://www.pixellab.ai/"],
  ["Retro Diffusion", "/docs/retro-diffusion", "https://www.retrodiffusion.ai/"],
  ["ComfyUI", "/docs/comfyui", "https://www.comfy.org/"],
  ["Scenario", "/docs/scenario", "https://www.scenario.com/"],
]) {
  if (!home.includes(`href="${route}"`)) {
    failures.push(`provider results are missing the ${provider} setup link`);
  }
  if (!home.includes(`href="${official}"`)) {
    failures.push(`provider results are missing the official ${provider} link`);
  }
}

for (const [file, credential, official] of [
  ["docs/PIXELLAB.md", "PIXELLAB_API_KEY", "https://www.pixellab.ai/"],
  ["docs/RETRO_DIFFUSION.md", "RD_API_KEY", "https://www.retrodiffusion.ai/"],
  ["docs/COMFYUI.md", "COMFYUI_BASE_URL", "https://www.comfy.org/"],
  ["docs/SCENARIO.md", "SCENARIO_SDK_API_SECRET", "https://www.scenario.com/"],
]) {
  const guide = readFileSync(path.join(repoRoot, file), "utf8");
  if (!guide.includes(credential)) failures.push(`${file} is missing ${credential}`);
  if (!guide.includes(official)) failures.push(`${file} is missing its official provider link`);
}

if (failures.length) {
  console.error("Website content checks failed:\n");
  for (const failure of failures) console.error(`- ${failure}`);
  process.exitCode = 1;
} else {
  console.log(`website content check passed: ${files.length} canonical routes`);
}
