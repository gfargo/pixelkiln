import type { Metadata } from "next";
import { docGroups, docs } from "@/app/lib/docs";
import { SiteFooter, SiteHeader } from "@/app/ui/site-chrome";
import { TrackedLink } from "@/app/ui/tracked-link";

export const metadata: Metadata = {
  title: "Documentation",
  description: "Guides and reference material for every part of the PixelKiln pipeline.",
};

export default function DocsIndex() {
  return (
    <>
      <SiteHeader compact />
      <main className="docs-index shell">
        <div className="docs-index-hero">
          <p className="eyebrow">The complete operating manual</p>
          <h1>Build with the kiln.</h1>
          <p>
            Start with the workflow, then go as deep as you need. These pages
            render directly from the Markdown that ships with PixelKiln,
            including separate PixelLab and Retro Diffusion setup guides and a
            practical provider comparison.
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
            <h2>Go from manifest to reviewed output.</h2>
            <p>Install from a checkout, plan without spending, and run a controlled generation.</p>
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
