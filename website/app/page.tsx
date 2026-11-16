import { absoluteUrl } from "@/app/lib/metadata";
import { JsonLd } from "@/app/ui/json-ld";
import { SiteFooter, SiteHeader } from "@/app/ui/site-chrome";
import { HeroSection } from "@/app/sections/hero";
import { HubSection } from "@/app/sections/hub";
import { InstallSection } from "@/app/sections/install";
import { ProofSection } from "@/app/sections/proof";
import { WorkflowSection } from "@/app/sections/workflow";

export default function Home() {
  const jsonLd = {
    "@context": "https://schema.org",
    "@graph": [
      {
        "@type": "WebSite",
        "@id": `${absoluteUrl("/")}#website`,
        name: "PixelKiln",
        url: absoluteUrl("/"),
        description:
          "Plan costs, review candidates and frame sets, edit sprites in the browser, gate derived art, recover paid work, and package pixel art with recorded hashes.",
      },
      {
        "@type": "SoftwareSourceCode",
        "@id": `${absoluteUrl("/")}#software`,
        name: "PixelKiln",
        url: absoluteUrl("/"),
        codeRepository: "https://github.com/gfargo/pixelkiln",
        license: "https://opensource.org/license/mit",
        programmingLanguage: "TypeScript",
        runtimePlatform: "Node.js",
        description:
          "A build pipeline that plans provider costs, records human choices and hand edits, verifies derived art and frame sets, restores paid work, and packages pixel art.",
      },
    ],
  };

  return (
    <>
      <JsonLd data={jsonLd} />
      <SiteHeader />
      <main>
        <HeroSection />
        <ProofSection />
        <HubSection
          heading="Six parts. Open the one you need."
          deck="Each has its own page with real output, what it costs, and where the documentation starts."
        />
        <WorkflowSection />
        <InstallSection />
      </main>
      <SiteFooter />
    </>
  );
}
