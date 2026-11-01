"use client";

import { Analytics, type BeforeSendEvent } from "@vercel/analytics/next";
import { SpeedInsights } from "@vercel/speed-insights/next";

const sensitiveQueryKey = /(?:api[_-]?key|auth|code|credential|password|secret|token)/i;

/** Headless browsers run the analytics script like a person would; drop what announces itself as automation. */
function looksAutomated(): boolean {
  if (typeof navigator === "undefined") return false;
  return navigator.webdriver === true || /HeadlessChrome|PhantomJS|Lighthouse/i.test(navigator.userAgent);
}

function redactSensitiveQueryValues(event: BeforeSendEvent): BeforeSendEvent | null {
  if (looksAutomated()) return null;
  try {
    const url = new URL(event.url);
    for (const key of [...url.searchParams.keys()]) {
      if (sensitiveQueryKey.test(key)) url.searchParams.set(key, "redacted");
    }
    return { ...event, url: url.toString() };
  } catch {
    return event;
  }
}

export function SiteAnalytics() {
  return (
    <>
      <Analytics beforeSend={redactSensitiveQueryValues} />
      <SpeedInsights />
    </>
  );
}
