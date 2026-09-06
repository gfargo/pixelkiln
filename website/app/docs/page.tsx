import type { Metadata } from "next";
import { docGroups, docs } from "@/app/lib/docs";
import { absoluteUrl, pageMetadata } from "@/app/lib/metadata";
import { JsonLd } from "@/app/ui/json-ld";
import { SiteFooter, SiteHeader } from "@/app/ui/site-chrome";
import { TrackedLink } from "@/app/ui/tracked-link";

export const metadata: Metadata = pageMetadata({
  title: "Documentation",
  description: "Set up PixelKiln, choose a provider, and operate each command safely.",
  path: "/docs",
});

export default function DocsIndex() {
  const jsonLd = {
    "@context": "https://schema.org",
    "@type": "BreadcrumbList",
    itemListElement: [
      { "@type": "ListItem", position: 1, name: "PixelKiln", item: absoluteUrl("/") },
      { "@type": "ListItem", position: 2, name: "Documentation", item: absoluteUrl("/docs") },
    ],
  };

  return (
    <>
      <JsonLd data={jsonLd} />
      <SiteHeader compact />
      <main className="docs-index shell">
        <div className="docs-index-hero">
          <p className="eyebrow">Documentation built from the repository</p>
          <h1>Start with a manifest.</h1>
          <p>
            These pages render from the Markdown shipped with PixelKiln. Start
            with the everyday workflow, or open the setup guide for PixelLab,
            Retro Diffusion, ComfyUI, or Scenario.
          </p>
        </div>

        <TrackedLink
          className="docs-featured"
          id="docs_index_featured"
          section="docs_index"
          href="/docs/getting-started"
        >
          <div>
            <span>Recommended first read</span>
            <h2>Go from a manifest to reviewed output.</h2>
            <p>Install PixelKiln, plan without spending, and cap the first generation.</p>
          </div>
          <strong aria-hidden="true">01 →</strong>
        </TrackedLink>

        <div className="docs-groups">
          {docGroups.map((group, groupIndex) => (
            <section className="docs-group" key={group}>
              <div className="docs-group-heading">
                <span>0{groupIndex + 2}</span>
                <h2>{group}</h2>
              </div>
              <div className="docs-card-grid">
                {docs
                  .filter((doc) => doc.group === group)
                  .map((doc) => (
                    <TrackedLink
                      className="docs-card"
                      id={`docs_card_${doc.slug}`}
                      section="docs_index"
                      href={`/docs/${doc.slug}`}
                      key={doc.slug}
                    >
                      <span className="docs-card-arrow" aria-hidden="true">↗</span>
                      <h3>{doc.title}</h3>
                      <p>{doc.description}</p>
                    </TrackedLink>
                  ))}
              </div>
            </section>
          ))}
        </div>
      </main>
      <SiteFooter />
    </>
  );
}
