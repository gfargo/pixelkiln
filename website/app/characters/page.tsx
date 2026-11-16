import type { Metadata } from "next";
import { feature } from "@/app/lib/features";
import { pageMetadata } from "@/app/lib/metadata";
import { CharactersSection } from "@/app/sections/characters";
import { FeaturePage } from "@/app/ui/feature-page";

const entry = feature("characters");

export const metadata: Metadata = pageMetadata({
  title: entry.name,
  description: entry.description,
  path: entry.href,
});

export default function Page() {
  return (
    <FeaturePage id="characters">
      <CharactersSection />
    </FeaturePage>
  );
}
