import type { Metadata } from "next";
import { feature } from "@/app/lib/features";
import { pageMetadata } from "@/app/lib/metadata";
import { ProvidersSection } from "@/app/sections/providers";
import { ScenarioSection } from "@/app/sections/scenario";
import { CostsSection } from "@/app/sections/costs";
import { FeaturePage } from "@/app/ui/feature-page";

const entry = feature("providers");

export const metadata: Metadata = pageMetadata({
  title: entry.name,
  description: entry.description,
  path: entry.href,
});

export default function Page() {
  return (
    <FeaturePage id="providers">
      <ProvidersSection />
      <ScenarioSection />
      <CostsSection />
    </FeaturePage>
  );
}
