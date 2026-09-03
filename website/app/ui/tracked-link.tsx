"use client";

import Link from "next/link";
import type { ReactNode } from "react";
import {
  trackCta,
  trackDocumentationLink,
  trackOutboundClick,
} from "@/app/lib/analytics";

type TrackedLinkProps = {
  href: string;
  id: string;
  section: Parameters<typeof trackCta>[1];
  className?: string;
  children: ReactNode;
  external?: boolean;
  "aria-label"?: string;
};

export function TrackedLink({
  href,
  id,
  section,
  className,
  children,
  external = false,
  ...rest
}: TrackedLinkProps) {
  const onClick = () => {
    if (external) {
      trackOutboundClick(id, section, href);
      return;
    }

    const docsRoute = href.match(/^\/docs(?:\/([^#?]+))?/);
    if (docsRoute) {
      trackDocumentationLink(id, docsRoute[1] ?? "index", section);
      return;
    }

    trackCta(id, section, href);
  };

  if (external) {
    return (
      <a href={href} className={className} onClick={onClick} {...rest}>
        {children}
      </a>
    );
  }

  return (
    <Link href={href} className={className} onClick={onClick} {...rest}>
      {children}
    </Link>
  );
}
