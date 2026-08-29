"use client";

import Link from "next/link";
import type { ReactNode } from "react";
import { trackCta, trackOutboundClick } from "@/app/lib/analytics";

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
    if (external) trackOutboundClick(id, section, href);
    else trackCta(id, section, href);
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
