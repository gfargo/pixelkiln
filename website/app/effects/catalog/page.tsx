import type { Metadata } from "next";
import { pixelfxCategories, pixelfxEffects, pixelfxVersion, presets, presetStills, presetsReadOn } from "@/app/lib/effects-catalog";
import { absoluteUrl, pageMetadata } from "@/app/lib/metadata";
import { InstallSection } from "@/app/sections/install";
import { EffectsCatalog } from "@/app/ui/effects-catalog";
import { JsonLd } from "@/app/ui/json-ld";
import { SiteFooter, SiteHeader } from "@/app/ui/site-chrome";
import { TrackedLink } from "@/app/ui/tracked-link";

const path = "/effects/catalog";
const title = "Effects catalog";
const description = `Every effect pixelkiln vfx can make: ${presets.length} PixelLab workbench presets and ${pixelfxEffects.length} effects from the pixelfx library, with frame sizes and the command for each.`;

export const metadata: Metadata = pageMetadata({ title, description, path });

export default function Page() {
  const jsonLd = {
    "@context": "https://schema.org",
    "@type": "BreadcrumbList",
    itemListElement: [
      { "@type": "ListItem", position: 1, name: "PixelKiln", item: absoluteUrl("/") },
      { "@type": "ListItem", position: 2, name: "Effects", item: absoluteUrl("/effects") },
      { "@type": "ListItem", position: 3, name: title, item: absoluteUrl(path) },
    ],
  };
  return (
    <>
      <JsonLd data={jsonLd} />
      <SiteHeader />
      <main className="feature-page catalog-page">
        <header className="catalog-hero shell">
          <p className="catalog-crumb">
            <TrackedLink id="catalog_back_effects" section="effects" href="/effects">Effects</TrackedLink> / Catalog
          </p>
          <h1>Every effect, in one place.</h1>
          <p>
            Two sources feed <code>pixelkiln vfx</code>. PixelLab&apos;s
            workbench has {presets.length} presets that can be built around
            your sprite. The pixelfx library has {pixelfxEffects.length}{" "}
            effects that render on your own machine. Find one here, copy its
            command, and read how to place it on the{" "}
            <TrackedLink id="catalog_effects_guide" section="effects" href="/effects#placement">effects page</TrackedLink>.
          </p>
          <div className="catalog-hero-links">
            <a className="button button-primary" href="#presets">PixelLab presets ({presets.length})</a>
            <a className="button catalog-button" href="#pixelfx">pixelfx effects ({pixelfxEffects.length})</a>
          </div>
        </header>
        <EffectsCatalog
          presets={presets}
          presetStills={presetStills}
          presetsReadOn={presetsReadOn}
          categories={pixelfxCategories}
          effects={pixelfxEffects}
          version={pixelfxVersion}
        />
        <InstallSection />
      </main>
      <SiteFooter />
    </>
  );
}
