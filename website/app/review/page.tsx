import type { Metadata } from "next";
import { feature } from "@/app/lib/features";
import { pageMetadata } from "@/app/lib/metadata";
import { ReviewSection } from "@/app/sections/review";
import { GallerySection } from "@/app/sections/gallery";
import { FeaturePage } from "@/app/ui/feature-page";

const entry = feature("review");

export const metadata: Metadata = pageMetadata({
  title: entry.name,
  description: entry.description,
  path: entry.href,
});

export default function Page() {
  return (
    <FeaturePage id="review">
      <ReviewSection />
      <GallerySection />
    </FeaturePage>
  );
}
