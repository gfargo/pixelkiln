import type { Metadata } from "next";
import { feature } from "@/app/lib/features";
import { pageMetadata } from "@/app/lib/metadata";
import { ModelsSection } from "@/app/sections/models";
import { FeaturePage } from "@/app/ui/feature-page";

const entry = feature("models");

export const metadata: Metadata = pageMetadata({
  title: entry.name,
  description: entry.description,
  path: entry.href,
});

export default function Page() {
  return (
    <FeaturePage id="models">
      <ModelsSection />
    </FeaturePage>
  );
}
