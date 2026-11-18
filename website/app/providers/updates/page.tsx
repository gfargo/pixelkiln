import type { Metadata } from "next";
import { feature } from "@/app/lib/features";
import { pageMetadata } from "@/app/lib/metadata";
import { FeaturePage } from "@/app/ui/feature-page";
import { ProviderUpdates } from "@/app/ui/provider-updates";

const entry = feature("updates");

export const metadata: Metadata = pageMetadata({
  title: entry.name,
  description: entry.description,
  path: entry.href,
});

export default function Page() {
  return (
    <FeaturePage id="updates">
      <ProviderUpdates />
    </FeaturePage>
  );
}
