// Allowlisted labels only: never emit a document ID, health category or arbitrary URL.
const pages = new Set([
  "/", "/privacy", "/sign-in", "/sign-up", "/forgot-password", "/reset-password", "/check-email",
  "/app", "/app/chat", "/app/connections", "/app/onboarding", "/app/wildcards",
  "/app/wildcards/progress", "/app/wildcards/workbench", "/app/wildcards/benchmark",
]);

export const PAGE_TRAFFIC_ROUTE_HEADER = "x-wh-traffic-route";

export function trafficRoute(pathname: string): string {
  const path = pathname.replace(/\/+$/, "") || "/";
  if (pages.has(path)) return path;
  if (/^\/app\/wildcards\/[^/]+$/.test(path)) return "/app/wildcards/[id]";
  if (/^\/app\/records\/[^/]+$/.test(path)) return "/app/records/[category]";
  return "/other";
}

export function analyticsUrl(value: string): string {
  const url = new URL(value);
  url.pathname = trafficRoute(url.pathname);
  url.search = "";
  url.hash = "";
  return url.toString();
}
