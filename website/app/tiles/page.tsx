import type { Metadata } from "next";
import { feature } from "@/app/lib/features";
import { pageMetadata } from "@/app/lib/metadata";
import { TilesSections } from "@/app/sections/tiles";
import { FeaturePage } from "@/app/ui/feature-page";

const entry = feature("tiles");

export const metadata: Metadata = pageMetadata({
  title: entry.name,
  description: entry.description,
  path: entry.href,
});

export default function Page() {
  return (
    <FeaturePage id="tiles">
      <TilesSections />
    </FeaturePage>
  );
}
