import type { Metadata } from "next";
import { feature } from "@/app/lib/features";
import { pageMetadata } from "@/app/lib/metadata";
import { WorkflowSection } from "@/app/sections/workflow";
import { SafetySection } from "@/app/sections/safety";
import { FeaturePage } from "@/app/ui/feature-page";

const entry = feature("pipeline");

export const metadata: Metadata = pageMetadata({
  title: entry.name,
  description: entry.description,
  path: entry.href,
});

export default function Page() {
  return (
    <FeaturePage id="pipeline">
      <WorkflowSection />
      <SafetySection />
    </FeaturePage>
  );
}
