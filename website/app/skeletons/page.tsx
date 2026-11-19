import type { Metadata } from "next";
import { feature } from "@/app/lib/features";
import { pageMetadata } from "@/app/lib/metadata";
import { SkeletonsSection } from "@/app/sections/skeletons";
import { FeaturePage } from "@/app/ui/feature-page";

const entry = feature("skeletons");

export const metadata: Metadata = pageMetadata({
  title: entry.name,
  description: entry.description,
  path: entry.href,
});

export default function Page() {
  return (
    <FeaturePage id="skeletons">
      <SkeletonsSection />
    </FeaturePage>
  );
}
