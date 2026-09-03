import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const websiteRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outputRoot = path.join(websiteRoot, ".next/server/app");
const failures = [];

function readOutput(relative) {
  const output = path.join(outputRoot, relative);
  if (!existsSync(output)) {
    failures.push(`missing build output: ${relative}`);
    return "";
  }
  return readFileSync(output, "utf8");
}

function expect(source, value, label) {
  if (!source.includes(value)) failures.push(`${label}: missing ${value}`);
}

const home = readOutput("index.html");
const canonicalMatch = home.match(/<link rel="canonical" href="([^"]+)"/);
const siteUrl = canonicalMatch?.[1]?.replace(/\/$/, "");

if (!siteUrl) failures.push("homepage: missing canonical URL");
expect(home, 'data-scroll-behavior="smooth"', "homepage");
expect(home, '"@type":"WebSite"', "homepage structured data");
expect(home, '"@type":"SoftwareSourceCode"', "homepage structured data");

if (siteUrl) {
  expect(home, `<meta property="og:url" content="${siteUrl}"`, "homepage");

  const docsIndex = readOutput("docs.html");
  expect(docsIndex, `<link rel="canonical" href="${siteUrl}/docs"`, "docs index");
  expect(docsIndex, `<meta property="og:url" content="${siteUrl}/docs"`, "docs index");
  expect(docsIndex, `<meta property="og:image" content="${siteUrl}/opengraph-image"`, "docs index");
  expect(docsIndex, '"@type":"BreadcrumbList"', "docs index structured data");

  const registry = readFileSync(path.join(websiteRoot, "app/lib/docs.ts"), "utf8");
  const slugs = [...registry.matchAll(/slug:\s*"([^"]+)"/g)].map((match) => match[1]);
  for (const slug of slugs) {
    const page = readOutput(`docs/${slug}.html`);
    const url = `${siteUrl}/docs/${slug}`;
    expect(page, `<link rel="canonical" href="${url}"`, `/docs/${slug}`);
    expect(page, `<meta property="og:url" content="${url}"`, `/docs/${slug}`);
    expect(page, `<meta property="og:image" content="${siteUrl}/opengraph-image"`, `/docs/${slug}`);
    expect(page, '<meta property="og:type" content="article"', `/docs/${slug}`);
    expect(page, '"@type":"TechArticle"', `/docs/${slug} structured data`);
    expect(page, '"@type":"BreadcrumbList"', `/docs/${slug} structured data`);
  }

  const robots = readOutput("robots.txt.body");
  expect(robots, `Host: ${siteUrl}`, "robots.txt");
  expect(robots, `Sitemap: ${siteUrl}/sitemap.xml`, "robots.txt");

  const sitemap = readOutput("sitemap.xml.body");
  expect(sitemap, `<loc>${siteUrl}</loc>`, "sitemap.xml");
  for (const slug of slugs) {
    expect(sitemap, `<loc>${siteUrl}/docs/${slug}</loc>`, "sitemap.xml");
  }
  expect(sitemap, "<image:image>", "sitemap.xml");
}

const analytics = readFileSync(path.join(websiteRoot, "app/ui/site-analytics.tsx"), "utf8");
expect(analytics, "<Analytics", "analytics integration");
expect(analytics, "<SpeedInsights", "performance integration");
expect(analytics, "beforeSend={redactSensitiveQueryValues}", "analytics privacy filter");

const taxonomy = readFileSync(path.join(websiteRoot, "app/lib/analytics.ts"), "utf8");
for (const event of [
  "CTA Click",
  "Documentation Link Clicked",
  "Outbound Click",
  "Install Command Copied",
]) {
  expect(taxonomy, `track("${event}"`, "analytics taxonomy");
}

if (failures.length) {
  console.error("Website build checks failed:\n");
  for (const failure of failures) console.error(`- ${failure}`);
  process.exitCode = 1;
} else {
  console.log("website build check passed: analytics, metadata, structured data, and crawl files");
}
