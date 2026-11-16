import type { ReactNode } from "react";
import { feature, type Feature } from "@/app/lib/features";
import { absoluteUrl } from "@/app/lib/metadata";
import { HubSection } from "@/app/sections/hub";
import { InstallSection } from "@/app/sections/install";
import { JsonLd } from "@/app/ui/json-ld";
import { SiteFooter, SiteHeader } from "@/app/ui/site-chrome";
import { TrackedLink } from "@/app/ui/tracked-link";

/** The frame every feature page shares: its title, a jump list, its sections, and the way on. */
export function FeaturePage({ id, children }: { id: Feature["id"]; children: ReactNode }) {
  const entry = feature(id);
  const jsonLd = {
    "@context": "https://schema.org",
    "@type": "BreadcrumbList",
    itemListElement: [
      { "@type": "ListItem", position: 1, name: "PixelKiln", item: absoluteUrl("/") },
      { "@type": "ListItem", position: 2, name: entry.name, item: absoluteUrl(entry.href) },
    ],
  };
  return (
    <>
      <JsonLd data={jsonLd} />
      <SiteHeader />
      <main className="feature-page">
        <header className="feature-hero shell">
          <div className="feature-hero-copy">
            <h1>{entry.title}</h1>
            <p>{entry.deck}</p>
          </div>
          <nav className="feature-jump" aria-label="On this page">
            <div>
              <h2>On this page</h2>
              {entry.sections.map((link) => (
                <a key={link.href} href={link.href}>{link.label}</a>
              ))}
            </div>
            <div>
              <h2>In the docs</h2>
              {entry.docs.map((link) => (
                <TrackedLink key={link.href} id={`feature_${id}_docs`} section="feature_page" href={link.href}>{link.label}</TrackedLink>
              ))}
            </div>
          </nav>
        </header>
        {children}
        <HubSection except={id} heading="More of PixelKiln." />
        <InstallSection />
      </main>
      <SiteFooter />
    </>
  );
}
