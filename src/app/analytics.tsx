"use client";

import { Analytics as VercelAnalytics, type BeforeSend } from "@vercel/analytics/next";
import { analyticsUrl } from "@/lib/traffic-route";

// Strip token-bearing queries and resource identifiers before sending analytics.
const redactUrl: BeforeSend = (event) => ({ ...event, url: analyticsUrl(event.url) });

export function Analytics() {
  return <VercelAnalytics beforeSend={redactUrl} />;
}
