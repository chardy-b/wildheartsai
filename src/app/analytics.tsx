"use client";

import { Analytics as VercelAnalytics, type BeforeSend } from "@vercel/analytics/next";

// Query strings can carry reset tokens and OAuth values, so only the path is sent.
const stripQuery: BeforeSend = (event) => {
  const url = new URL(event.url);
  url.search = "";
  url.hash = "";
  return { ...event, url: url.toString() };
};

export function Analytics() {
  return <VercelAnalytics beforeSend={stripQuery} />;
}
