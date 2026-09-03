"use client";

import { Analytics, type BeforeSendEvent } from "@vercel/analytics/next";
import { SpeedInsights } from "@vercel/speed-insights/next";

const sensitiveQueryKey = /(?:api[_-]?key|auth|code|credential|password|secret|token)/i;

function redactSensitiveQueryValues(event: BeforeSendEvent): BeforeSendEvent {
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
