"use client";

import { track } from "@vercel/analytics";

/**
 * Central event taxonomy for the marketing site. Keep names and props stable.
 * They become dimensions in the Vercel Analytics dashboard.
 */

export type CtaSection =
  | "header"
  | "hero"
  | "install"
  | "review"
  | "gallery"
  | "characters"
  | "effects"
  | "provider_updates"
  | "safety"
  | "generator"
  | "provider_showcase"
  | "scenario"
  | "docs_index"
  | "docs_sidebar"
  | "docs_search"
  | "footer";

export function trackCta(id: string, section: CtaSection, href: string) {
  track("CTA Click", { id, section, href });
}

export function trackOutboundClick(id: string, section: CtaSection, destination: string) {
  let destinationHost = destination;
  try {
    destinationHost = new URL(destination).hostname;
  } catch {
    // Keep the supplied value when it is not an absolute URL.
  }
  track("Outbound Click", { id, section, destination: destinationHost });
}

export function trackInstallCommandCopied() {
  track("Install Command Copied", { target: "agent_skill", source: "homepage" });
}

export function trackCodeCopied(id: string, section: CtaSection) {
  track("Code Copied", { id, section });
}

export function trackDocumentationLink(id: string, slug: string, source: CtaSection) {
  track("Documentation Link Clicked", { id, slug, source });
}
