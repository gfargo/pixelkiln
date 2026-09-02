"use client";

import { track } from "@vercel/analytics";

/**
 * Central event taxonomy for the marketing site. Keep names and props stable.
 * they become dimensions in the Vercel Analytics dashboard.
 */

type CtaSection =
  | "header"
  | "hero"
  | "install"
  | "review"
  | "safety"
  | "generator"
  | "docs_index"
  | "docs_sidebar"
  | "footer";

export function trackCta(id: string, section: CtaSection, href: string) {
  track("CTA Click", { id, section, href });
}

export function trackOutboundClick(id: string, section: CtaSection, destination: string) {
  track("Outbound Click", { id, section, destination });
}

export function trackInstallCommandCopied(command: string) {
  track("Install Command Copied", { command });
}

export function trackDocViewed(slug: string, source: CtaSection) {
  track("Doc Link Click", { slug, source });
}
