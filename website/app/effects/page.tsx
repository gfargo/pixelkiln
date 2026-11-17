import type { Metadata } from "next";
import { feature } from "@/app/lib/features";
import { pageMetadata } from "@/app/lib/metadata";
import { EffectsSection } from "@/app/sections/effects";
import { EffectsGuideSections } from "@/app/sections/effects-guide";
import { FeaturePage } from "@/app/ui/feature-page";

const entry = feature("effects");

export const metadata: Metadata = pageMetadata({
  title: entry.name,
  description: entry.description,
  path: entry.href,
});

export default function Page() {
  return (
    <FeaturePage id="effects">
      <EffectsSection />
      <EffectsGuideSections />
    </FeaturePage>
  );
}
